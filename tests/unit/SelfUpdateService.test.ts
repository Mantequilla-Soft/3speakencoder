import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/Logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { SelfUpdateService, RESTART_EXIT_CODE } = await import('../../src/services/SelfUpdateService.js');
type CommandResult = import('../../src/services/SelfUpdateService.js').CommandResult;

const PREV = '1'.repeat(40);
const NEXT = '2'.repeat(40);
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom'): CommandResult => ({ code: 1, stdout: '', stderr });

/** Scripted git/npm: responses keyed by "cmd arg1 arg2...", overridable per test. */
function fakeRunner(overrides: Record<string, CommandResult | CommandResult[]> = {}) {
  let head = PREV;
  const defaults: Record<string, CommandResult | (() => CommandResult)> = {
    'git --version': ok('git version 2.47.0'),
    'git status --porcelain --untracked-files=no': ok(''),
    'git rev-parse --abbrev-ref HEAD': ok('main\n'),
    'git rev-parse --abbrev-ref --symbolic-full-name @{u}': ok('origin/main\n'),
    'git fetch --quiet origin main': ok(),
    'git rev-parse HEAD': () => ok(`${head}\n`),
    'git rev-parse origin/main': ok(`${NEXT}\n`),
    [`git merge-base --is-ancestor ${PREV} ${NEXT}`]: ok(),
    [`git merge --ff-only ${NEXT}`]: () => { head = NEXT; return ok(); },
    [`git reset --hard ${PREV}`]: () => { head = PREV; return ok(); },
    'npm ci': ok(),
    'npm run build': ok(),
  };
  const queues: Record<string, CommandResult[]> = {};
  for (const [k, v] of Object.entries(overrides)) queues[k] = Array.isArray(v) ? [...v] : [v];

  const calls: string[] = [];
  const run = vi.fn(async (cmd: string, args: string[]) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    const q = queues[key];
    if (q && q.length) return q.length > 1 ? q.shift()! : q[0]!;
    const d = defaults[key];
    if (!d) throw new Error(`unexpected command: ${key}`);
    return typeof d === 'function' ? d() : d;
  });
  return { run, calls };
}

function host(idleAfterPolls = 0) {
  let polls = 0;
  return {
    pauseIntake: vi.fn(),
    resumeIntake: vi.fn(),
    isIdle: vi.fn(() => polls++ >= idleAfterPolls),
    shutdown: vi.fn(async () => {}),
  };
}

function make(opts: { overrides?: Record<string, CommandResult | CommandResult[]>; env?: Record<string, string>; files?: string[]; enabled?: boolean; password?: string | undefined; idleAfterPolls?: number } = {}) {
  const { run, calls } = fakeRunner(opts.overrides);
  const h = host(opts.idleAfterPolls ?? 0);
  const exit = vi.fn();
  const states: string[] = [];
  const files = new Set(opts.files ?? ['/repo/package-lock.json']);
  const svc = new SelfUpdateService({
    host: h,
    enabled: opts.enabled ?? true,
    password: 'password' in opts ? opts.password : 'pw',
    repoRoot: '/repo',
    env: opts.env ?? {},
    run,
    fileExists: (p) => files.has(p),
    exit,
    drainPollMs: 1,
    onChange: (s) => states.push(s.phase),
  });
  const settled = () => vi.waitFor(() => {
    if (svc.isBusy()) throw new Error(`still ${svc.getState().phase}`);
  }, { timeout: 2000 });
  return { svc, host: h, exit, calls, states, settled };
}

describe('eligibility', () => {
  it('passes on a clean main checkout tracking origin with a lockfile', async () => {
    const e = await make().svc.checkEligibility();
    expect(e.eligible).toBe(true);
    expect(e.checks.map(c => c.id)).toEqual(['enabled', 'not-docker', 'git', 'clean', 'branch', 'tracking', 'lockfile']);
  });

  it.each([
    ['disabled', { enabled: false }, 'enabled'],
    ['no password', { password: undefined }, 'enabled'],
    ['docker (/.dockerenv)', { files: ['/repo/package-lock.json', '/.dockerenv'] }, 'not-docker'],
    ['docker (ENCODER_COMMIT)', { env: { ENCODER_COMMIT: NEXT } }, 'not-docker'],
    ['no git', { overrides: { 'git --version': fail('not found') } }, 'git'],
    ['dirty tree', { overrides: { 'git status --porcelain --untracked-files=no': ok(' M src/index.ts\n') } }, 'clean'],
    ['wrong branch', { overrides: { 'git rev-parse --abbrev-ref HEAD': ok('feature\n') } }, 'branch'],
    ['no upstream', { overrides: { 'git rev-parse --abbrev-ref --symbolic-full-name @{u}': fail('no upstream') } }, 'tracking'],
    ['no lockfile', { files: [] }, 'lockfile'],
  ])('fails when %s', async (_name, opts, failingId) => {
    const e = await make(opts as any).svc.checkEligibility();
    expect(e.eligible).toBe(false);
    expect(e.checks.find(c => c.id === failingId)?.ok).toBe(false);
  });

  it('reports the dirty file names', async () => {
    const e = await make({ overrides: { 'git status --porcelain --untracked-files=no': ok(' M src/index.ts\n M package.json\n') } }).svc.checkEligibility();
    expect(e.checks.find(c => c.id === 'clean')?.detail).toBe('Modified: src/index.ts, package.json');
  });
});

describe('start() refusals (nothing paused, nothing changed)', () => {
  it.each([
    ['disabled', { enabled: false }, 403],
    ['not eligible', { overrides: { 'git rev-parse --abbrev-ref HEAD': ok('feature\n') } }, 409],
    ['fetch fails', { overrides: { 'git fetch --quiet origin main': fail('network down') } }, 502],
    ['already up to date', { overrides: { 'git rev-parse origin/main': ok(`${PREV}\n`) } }, 409],
    ['diverged', { overrides: { [`git merge-base --is-ancestor ${PREV} ${NEXT}`]: fail('') } }, 409],
  ])('%s -> %i', async (_name, opts, status) => {
    const t = make(opts as any);
    await expect(t.svc.start()).rejects.toMatchObject({ status });
    expect(t.host.pauseIntake).not.toHaveBeenCalled();
    expect(t.calls.some(c => c.startsWith('git merge --ff-only') || c === 'npm ci')).toBe(false);
  });

  it('refuses a second update while one is running', async () => {
    const t = make({ idleAfterPolls: 1000 });
    await t.svc.start();
    await expect(t.svc.start()).rejects.toMatchObject({ status: 409 });
    t.svc.cancel();
    await t.settled();
  });
});

describe('update flow', () => {
  it('supervised: drains, fast-forwards, installs, builds, shuts down, exits 75', async () => {
    const t = make({ env: { ENCODER_SUPERVISED: '1' }, idleAfterPolls: 3 });
    const state = await t.svc.start();
    expect(state).toMatchObject({ phase: 'draining', previousCommit: PREV, targetCommit: NEXT });
    await vi.waitFor(() => expect(t.exit).toHaveBeenCalledWith(RESTART_EXIT_CODE));

    expect(t.host.pauseIntake).toHaveBeenCalledOnce();
    expect(t.host.isIdle.mock.calls.length).toBeGreaterThanOrEqual(4); // waited for jobs
    expect(t.host.shutdown).toHaveBeenCalledOnce();
    expect(t.host.resumeIntake).not.toHaveBeenCalled();
    const afterFetch = t.calls.slice(t.calls.indexOf(`git merge-base --is-ancestor ${PREV} ${NEXT}`) + 1);
    expect(afterFetch).toEqual([
      'git rev-parse HEAD', 'git status --porcelain --untracked-files=no',
      `git merge --ff-only ${NEXT}`, 'npm ci', 'npm run build',
    ]);
    expect(t.states).toEqual(['draining', 'updating', 'installing', 'verifying', 'restarting']);
  });

  it('not supervised: applies, resumes intake, asks for a restart, does not exit', async () => {
    const t = make();
    await t.svc.start();
    await t.settled();
    expect(t.svc.getState().phase).toBe('restart-required');
    expect(t.host.resumeIntake).toHaveBeenCalledOnce();
    expect(t.exit).not.toHaveBeenCalled();
    expect(t.host.shutdown).not.toHaveBeenCalled();
  });

  it.each([
    ['npm ci', { 'npm ci': [fail('ERESOLVE could not resolve'), ok()] }],
    ['npm run build', { 'npm run build': [fail('error TS2345'), ok()] }],
    ['git merge --ff-only', { [`git merge --ff-only ${NEXT}`]: fail('not possible to fast-forward') }],
  ])('rolls back when %s fails, and keeps taking jobs', async (step, overrides) => {
    const t = make({ overrides: overrides as any, env: { ENCODER_SUPERVISED: '1' } });
    await t.svc.start();
    await t.settled();

    const state = t.svc.getState();
    expect(state.phase).toBe('failed');
    expect(state.error).toContain(`${step} failed`);
    expect(state.message).toContain(`still on ${PREV.slice(0, 7)}`);
    expect(t.calls.slice(-3)).toEqual([`git reset --hard ${PREV}`, 'npm ci', 'npm run build']);
    expect(t.host.resumeIntake).toHaveBeenCalledOnce();
    expect(t.exit).not.toHaveBeenCalled();
  });

  it('reports an incomplete rollback with the manual fix', async () => {
    const t = make({ overrides: { 'npm ci': fail('disk full') } });
    await t.svc.start();
    await t.settled();
    const state = t.svc.getState();
    expect(state.phase).toBe('failed');
    expect(state.error).toContain('ROLLBACK INCOMPLETE');
    expect(state.error).toContain(`git reset --hard ${PREV} && npm ci && npm run build`);
    expect(t.host.resumeIntake).toHaveBeenCalledOnce();
  });

  it('cancel while draining resumes intake and changes nothing', async () => {
    const t = make({ idleAfterPolls: 1000 });
    await t.svc.start();
    t.svc.cancel();
    await t.settled();
    expect(t.svc.getState()).toMatchObject({ phase: 'idle', message: 'Update cancelled' });
    expect(t.host.resumeIntake).toHaveBeenCalledOnce();
    expect(t.calls.some(c => c.startsWith('git merge --ff-only') || c === 'npm ci' || c.startsWith('git reset'))).toBe(false);
  });

  it('cannot cancel once the update is past draining', async () => {
    const t = make();
    expect(() => t.svc.cancel()).toThrow(/Nothing to cancel/);
  });

  it('aborts without rollback if HEAD moved during the drain (never resets over the operator)', async () => {
    const other = '3'.repeat(40);
    const t = make({ overrides: { 'git rev-parse HEAD': [ok(`${PREV}\n`), ok(`${other}\n`)] } });
    await t.svc.start();
    await t.settled();
    expect(t.svc.getState()).toMatchObject({ phase: 'failed' });
    expect(t.svc.getState().error).toContain('HEAD moved');
    expect(t.calls.some(c => c.startsWith('git reset') || c.startsWith('git merge --ff-only'))).toBe(false);
    expect(t.host.resumeIntake).toHaveBeenCalledOnce();
  });

  it('resumes intake if something unexpected throws', async () => {
    const t = make();
    t.host.isIdle.mockImplementation(() => { throw new Error('kaboom'); });
    await t.svc.start();
    await t.settled();
    expect(t.svc.getState()).toMatchObject({ phase: 'failed', error: 'kaboom' });
    expect(t.host.resumeIntake).toHaveBeenCalledOnce();
  });
});

describe('legacy runtime file', () => {
  it('a modified data/pending_pins.json does not block the update', async () => {
    const e = await make({ overrides: { 'git status --porcelain --untracked-files=no': ok(' M data/pending_pins.json\n') } }).svc.checkEligibility();
    expect(e.checks.find(c => c.id === 'clean')).toMatchObject({ ok: true, detail: 'Working tree clean' });
  });
});

describe('summarizeOutput', async () => {
  const { summarizeOutput } = await import('../../src/services/SelfUpdateService.js');

  it('picks the real npm error over the trailing hints', () => {
    const npm = `npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/left-pad-does-not-exist-xyz - Not found
npm error 404
npm error 404  'left-pad-does-not-exist-xyz@9.9.9' is not in this registry.
npm error 404
npm error 404 Note that you can also install from a
npm error 404 tarball, folder, http url, or git url.
npm error A complete log of this run can be found in: /home/u/.npm/_logs/debug-0.log`;
    expect(summarizeOutput(npm)).toBe('npm error code E404 | npm error 404 Not Found - GET https://registry.npmjs.org/left-pad-does-not-exist-xyz - Not found | npm error 404');
  });

  it('handles tsc and git output, and empty output', () => {
    expect(summarizeOutput('src/a.ts(1,7): error TS2322: Type string is not assignable\nFound 1 error.')).toContain('error TS2322');
    expect(summarizeOutput('fatal: Not possible to fast-forward, aborting.')).toBe('fatal: Not possible to fast-forward, aborting.');
    expect(summarizeOutput('')).toBe('no output');
  });
});
