import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../src/services/Logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { resolveLocalCommit, mapCompareResponse, VersionService } = await import('../../src/services/VersionService.js');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'version-test-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function file(path: string, content: string) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

describe('resolveLocalCommit', () => {
  it('prefers ENCODER_COMMIT', async () => {
    await file(join(root, '.git/HEAD'), `${SHA_A}\n`);
    expect(await resolveLocalCommit({ ENCODER_COMMIT: SHA_B.toUpperCase() }, root)).toEqual({ commit: SHA_B, source: 'env', branch: null });
  });

  it('ignores an empty or malformed ENCODER_COMMIT (e.g. unset Docker build arg)', async () => {
    await file(join(root, '.git/HEAD'), `${SHA_A}\n`);
    expect((await resolveLocalCommit({ ENCODER_COMMIT: '' }, root)).commit).toBe(SHA_A);
    expect((await resolveLocalCommit({ ENCODER_COMMIT: 'not-a-sha' }, root)).commit).toBe(SHA_A);
  });

  it('follows a branch ref', async () => {
    await file(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
    await file(join(root, '.git/refs/heads/main'), `${SHA_A}\n`);
    expect(await resolveLocalCommit({}, root)).toEqual({ commit: SHA_A, source: 'git', branch: 'main' });
  });

  it('reads a detached HEAD', async () => {
    await file(join(root, '.git/HEAD'), `${SHA_B}\n`);
    expect(await resolveLocalCommit({}, root)).toEqual({ commit: SHA_B, source: 'git', branch: null });
  });

  it('falls back to packed-refs', async () => {
    await file(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
    await file(join(root, '.git/packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${SHA_C} refs/heads/feature\n${SHA_A} refs/heads/main\n^${SHA_B}\n`);
    expect(await resolveLocalCommit({}, root)).toEqual({ commit: SHA_A, source: 'git', branch: 'main' });
  });

  it('handles a worktree (.git file + commondir)', async () => {
    const main = join(root, 'main');
    const wt = join(root, 'wt');
    await file(join(main, '.git/refs/heads/feature'), `${SHA_C}\n`);
    await file(join(main, '.git/worktrees/wt/HEAD'), 'ref: refs/heads/feature\n');
    await file(join(main, '.git/worktrees/wt/commondir'), '../..\n');
    await file(join(wt, '.git'), `gitdir: ${join(main, '.git/worktrees/wt')}\n`);
    expect(await resolveLocalCommit({}, wt)).toEqual({ commit: SHA_C, source: 'git', branch: 'feature' });
  });

  it('returns unknown with no .git and no env', async () => {
    expect(await resolveLocalCommit({}, root)).toEqual({ commit: 'unknown', source: 'unknown', branch: null });
  });

  it('returns unknown when the ref is missing', async () => {
    await file(join(root, '.git/HEAD'), 'ref: refs/heads/gone\n');
    expect((await resolveLocalCommit({}, root)).commit).toBe('unknown');
  });
});

describe('mapCompareResponse (GitHub counts from the branch side)', () => {
  it('branch ahead of local => local is behind', () => {
    const commits = [{ sha: SHA_B }, { sha: SHA_C }];
    expect(mapCompareResponse({ status: 'ahead', ahead_by: 2, behind_by: 0, commits }, SHA_A))
      .toEqual({ status: 'behind', behindBy: 2, aheadBy: 0, latestCommit: SHA_C });
  });

  it('identical => up to date, latest is local', () => {
    expect(mapCompareResponse({ status: 'identical', ahead_by: 0, behind_by: 0, commits: [] }, SHA_A))
      .toEqual({ status: 'up-to-date', behindBy: 0, aheadBy: 0, latestCommit: SHA_A });
  });

  it('branch behind local => local is ahead', () => {
    expect(mapCompareResponse({ status: 'behind', ahead_by: 0, behind_by: 3, commits: [] }, SHA_A))
      .toMatchObject({ status: 'ahead', behindBy: 0, aheadBy: 3 });
  });

  it('diverged', () => {
    expect(mapCompareResponse({ status: 'diverged', ahead_by: 4, behind_by: 1, commits: [{ sha: SHA_B }] }, SHA_A))
      .toEqual({ status: 'diverged', behindBy: 4, aheadBy: 1, latestCommit: null }); // commit list incomplete
  });
});

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Response(status === 304 ? null : JSON.stringify(body), { status, headers });
}

async function serviceWith(fetchImpl: any) {
  await file(join(root, '.git/HEAD'), `${SHA_A}\n`);
  await file(join(root, 'package.json'), '{"version":"2.0.0"}');
  const onUpdate = vi.fn();
  const svc = new VersionService({ repoRoot: root, env: {}, fetchImpl, onUpdate, initialDelayMs: 1e9, timeoutMs: 50 });
  await svc.start();
  svc.stop();
  return { svc, onUpdate };
}

describe('VersionService.check', () => {
  it('reports behind with a compare link, and sends the ETag next time', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, { status: 'ahead', ahead_by: 12, behind_by: 0, commits: [] }, { etag: 'W/"abc"' }))
      .mockResolvedValueOnce(response(304));
    const { svc, onUpdate } = await serviceWith(fetchImpl);

    const info = await svc.check();
    expect(info).toMatchObject({ version: '2.0.0', current: '2.0.0', shortCommit: 'aaaaaaa', status: 'behind', behindBy: 12 });
    expect(info.compareUrl).toBe(`https://github.com/Mantequilla-Soft/3speakencoder/compare/${SHA_A}...main`);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`https://api.github.com/repos/Mantequilla-Soft/3speakencoder/compare/${SHA_A}...main`);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    const again = await svc.check();
    expect((fetchImpl.mock.calls[1]?.[1] as any).headers['If-None-Match']).toBe('W/"abc"');
    expect(again).toMatchObject({ status: 'behind', behindBy: 12 }); // 304 keeps the result
  });

  it('identical => up to date', async () => {
    const { svc } = await serviceWith(vi.fn().mockResolvedValue(response(200, { status: 'identical', ahead_by: 0, behind_by: 0, commits: [] })));
    expect(await svc.check()).toMatchObject({ status: 'up-to-date', behindBy: 0 });
  });

  it('404 => custom/fork build', async () => {
    const { svc } = await serviceWith(vi.fn().mockResolvedValue(response(404)));
    expect(await svc.check()).toMatchObject({ status: 'not-found', behindBy: null, compareUrl: null });
  });

  it('403 rate limit keeps the previous result and does not notify', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, { status: 'ahead', ahead_by: 3, behind_by: 0, commits: [] }))
      .mockResolvedValueOnce(response(403, { message: 'API rate limit exceeded' }));
    const { svc, onUpdate } = await serviceWith(fetchImpl);
    await svc.check();
    expect(await svc.check()).toMatchObject({ status: 'behind', behindBy: 3 });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('timeout / network error never throws', async () => {
    const hang = vi.fn((_url: string, init: any) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))));
    const { svc } = await serviceWith(hang);
    await expect(svc.check()).resolves.toMatchObject({ status: 'unchecked' });

    const { svc: svc2 } = await serviceWith(vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(svc2.check()).resolves.toMatchObject({ status: 'unchecked' });
  });

  it('does not call GitHub when the commit is unknown', async () => {
    const fetchImpl = vi.fn();
    const svc = new VersionService({ repoRoot: root, env: {}, fetchImpl, initialDelayMs: 0 });
    expect(await svc.start()).toMatchObject({ status: 'unknown-commit', commit: 'unknown' });
    await new Promise(r => setTimeout(r, 20));
    svc.stop();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('config', () => {
  it('a malformed VERSION_CHECK_REPO does not stop the encoder from loading its config', async () => {
    const { loadConfig } = await import('../../src/config/ConfigLoader.js');
    process.env.VERSION_CHECK_REPO = 'https://github.com/me/fork';
    try {
      await expect(loadConfig()).resolves.toMatchObject({ version_check: { repo: 'https://github.com/me/fork' } });
    } finally {
      delete process.env.VERSION_CHECK_REPO;
    }
  });
});

describe('significantChanges (legacy runtime file)', () => {
  it('keeps real changes and drops data/pending_pins.json', async () => {
    const { significantChanges } = await import('../../src/services/VersionService.js');
    expect(significantChanges(' M data/pending_pins.json\n M src/index.ts\nA  new.ts\n')).toEqual(['src/index.ts', 'new.ts']);
    expect(significantChanges(' M data/pending_pins.json\n')).toEqual([]);
    expect(significantChanges('')).toEqual([]);
  });
});

describe('VersionService.checkNow (dashboard "Check for updates")', () => {
  it('asks GitHub, then serves the cached result during the cooldown', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, { status: 'identical', ahead_by: 0, behind_by: 0, commits: [] }))
      .mockResolvedValueOnce(response(200, { status: 'ahead', ahead_by: 3, behind_by: 0, commits: [] }));
    const { svc } = await serviceWith(fetchImpl);

    expect(await svc.checkNow()).toMatchObject({ status: 'up-to-date' });
    expect(await svc.checkNow()).toMatchObject({ status: 'up-to-date' }); // within 60s: no request
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    try {
      expect(await svc.checkNow()).toMatchObject({ status: 'behind', behindBy: 3 });
    } finally {
      clock.mockRestore();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never calls GitHub when checks are disabled', async () => {
    await file(join(root, '.git/HEAD'), `${SHA_A}\n`);
    const fetchImpl = vi.fn();
    const svc = new VersionService({ repoRoot: root, env: {}, fetchImpl, enabled: false });
    await svc.start();
    expect(svc.isEnabled()).toBe(false);
    expect(await svc.checkNow()).toMatchObject({ status: 'unchecked' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
