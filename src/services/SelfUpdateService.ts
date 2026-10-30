import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from './Logger.js';
import { DEFAULT_REPO_ROOT, significantChanges } from './VersionService.js';

/**
 * Opt-in self-update: drain, fast-forward to upstream, reinstall, rebuild, restart.
 *
 *   idle -> draining -> updating -> installing -> verifying -> restarting (exit 75)
 *                                                           -> restart-required (not supervised)
 *   any failure after draining -> rolling-back -> failed (previous commit, intake resumed)
 *
 * Off by default (SELF_UPDATE_ENABLED=true + UPDATE_PASSWORD). Never interrupts a job:
 * nothing touches the working tree until the encoder is idle.
 */

export const RESTART_EXIT_CODE = 75;

export type UpdatePhase =
  | 'idle' | 'draining' | 'updating' | 'installing' | 'verifying'
  | 'rolling-back' | 'restarting' | 'restart-required' | 'failed';

export interface UpdateState {
  phase: UpdatePhase;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  previousCommit: string | null;
  targetCommit: string | null;
  error: string | null;
}

export interface EligibilityCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface Eligibility {
  eligible: boolean;
  docker: boolean;
  supervised: boolean;
  checks: EligibilityCheck[];
  checkedAt: string;
}

/** What the update needs from the encoder. Implemented by ThreeSpeakEncoder. */
export interface UpdateHost {
  pauseIntake(): void;
  resumeIntake(): void;
  isIdle(): boolean;
  shutdown(): Promise<void>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (cmd: string, args: string[], options: { cwd: string; timeoutMs: number }) => Promise<CommandResult>;

/** Run a command without a shell (except for npm's .cmd shim on Windows). Never rejects. */
export const runCommand: CommandRunner = (cmd, args, { cwd, timeoutMs }) =>
  new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result: CommandResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const child = spawn(cmd, args, {
      cwd,
      // npm is npm.cmd on Windows, which can only be started through a shell
      shell: process.platform === 'win32' && cmd === 'npm',
      env: process.env,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      done({ code: -1, stdout, stderr: `${stderr}\nTimed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });
    child.on('error', err => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: err.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      done({ code: code ?? -1, stdout, stderr });
    });
  });

export interface SelfUpdateOptions {
  host: UpdateHost;
  enabled: boolean;
  password: string | undefined;
  branch?: string;
  remote?: string;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
  fileExists?: (path: string) => boolean;
  exit?: (code: number) => void;
  drainPollMs?: number;
  onChange?: (state: UpdateState) => void;
}

const MINUTE = 60 * 1000;

export class SelfUpdateService {
  private readonly host: UpdateHost;
  private readonly enabled: boolean;
  private readonly password: string | undefined;
  private readonly branch: string;
  private readonly remote: string;
  private readonly repoRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: CommandRunner;
  private readonly fileExists: (path: string) => boolean;
  private readonly exit: (code: number) => void;
  private readonly drainPollMs: number;
  private readonly onChange: ((state: UpdateState) => void) | undefined;
  private state: UpdateState = {
    phase: 'idle', message: '', startedAt: null, finishedAt: null,
    previousCommit: null, targetCommit: null, error: null,
  };
  private cancelRequested = false;

  constructor(options: SelfUpdateOptions) {
    this.host = options.host;
    this.enabled = options.enabled;
    this.password = options.password || undefined;
    this.branch = options.branch ?? 'main';
    this.remote = options.remote ?? 'origin';
    this.repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
    this.env = options.env ?? process.env;
    this.run = options.run ?? runCommand;
    this.fileExists = options.fileExists ?? existsSync;
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.drainPollMs = options.drainPollMs ?? 2000;
    this.onChange = options.onChange;
  }

  /** Configured and has a password: the update endpoints exist at all. */
  isEnabled(): boolean {
    return this.enabled && !!this.password;
  }

  getPassword(): string | undefined {
    return this.password;
  }

  isSupervised(): boolean {
    return this.env.ENCODER_SUPERVISED === '1';
  }

  isDocker(): boolean {
    return this.fileExists('/.dockerenv') || !!this.env.ENCODER_COMMIT?.trim();
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  isBusy(): boolean {
    return ['draining', 'updating', 'installing', 'verifying', 'rolling-back', 'restarting'].includes(this.state.phase);
  }

  private git(args: string[], timeoutMs = MINUTE) {
    return this.run('git', args, { cwd: this.repoRoot, timeoutMs });
  }

  private npm(args: string[], timeoutMs = 15 * MINUTE) {
    return this.run('npm', args, { cwd: this.repoRoot, timeoutMs });
  }

  async checkEligibility(): Promise<Eligibility> {
    const checks: EligibilityCheck[] = [];
    const add = (id: string, label: string, ok: boolean, detail: string) => checks.push({ id, label, ok, detail });

    add('enabled', 'Self-update enabled', this.isEnabled(),
      this.isEnabled() ? 'SELF_UPDATE_ENABLED=true and UPDATE_PASSWORD set'
        : !this.enabled ? 'Set SELF_UPDATE_ENABLED=true in .env' : 'Set UPDATE_PASSWORD in .env');

    const docker = this.isDocker();
    add('not-docker', 'Not running in Docker', !docker,
      docker ? 'Docker images are updated by pulling a new image, not in place' : 'Running from a git checkout');

    const gitVersion = await this.git(['--version'], 10000);
    const hasGit = gitVersion.code === 0;
    add('git', 'git installed', hasGit, hasGit ? gitVersion.stdout.trim() : 'git not found on PATH');

    if (hasGit && !docker) {
      const status = await this.git(['status', '--porcelain', '--untracked-files=no']);
      const dirtyFiles = significantChanges(status.stdout);
      add('clean', 'No local changes', status.code === 0 && dirtyFiles.length === 0,
        status.code !== 0 ? (status.stderr.trim() || 'not a git checkout')
          : dirtyFiles.length ? `Modified: ${dirtyFiles.slice(0, 5).join(', ')}${dirtyFiles.length > 5 ? '…' : ''}` : 'Working tree clean');

      const branch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
      add('branch', `On ${this.branch}`, branch === this.branch, branch === 'HEAD' ? 'Detached HEAD' : `On ${branch || 'unknown'}`);

      const upstream = await this.git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
      const expected = `${this.remote}/${this.branch}`;
      add('tracking', `Tracks ${expected}`, upstream.stdout.trim() === expected,
        upstream.code === 0 ? `Tracks ${upstream.stdout.trim()}` : 'No upstream branch configured');
    }

    const hasLock = this.fileExists(join(this.repoRoot, 'package-lock.json'));
    add('lockfile', 'package-lock.json present', hasLock, hasLock ? 'npm ci can reproduce dependencies' : 'Missing package-lock.json');

    return {
      eligible: checks.every(c => c.ok),
      docker,
      supervised: this.isSupervised(),
      checks,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Validate, then run the update in the background. Throws (with .status) for
   * refusals so the HTTP layer can map them; progress is reported via onChange.
   */
  async start(): Promise<UpdateState> {
    if (!this.isEnabled()) throw httpError(403, 'Self-update is not enabled on this encoder');
    if (this.isBusy()) throw httpError(409, `An update is already in progress (${this.state.phase})`);

    const eligibility = await this.checkEligibility();
    if (!eligibility.eligible) {
      const failed = eligibility.checks.filter(c => !c.ok).map(c => `${c.label}: ${c.detail}`);
      throw httpError(409, `Not eligible for self-update - ${failed.join('; ')}`);
    }

    const fetch = await this.git(['fetch', '--quiet', this.remote, this.branch], 2 * MINUTE);
    if (fetch.code !== 0) throw httpError(502, `git fetch failed: ${fetch.stderr.trim()}`);

    const previous = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
    const target = (await this.git(['rev-parse', `${this.remote}/${this.branch}`])).stdout.trim();
    if (!previous || !target) throw httpError(500, 'Could not resolve commits');
    if (previous === target) throw httpError(409, 'Already up to date');

    const ff = await this.git(['merge-base', '--is-ancestor', previous, target]);
    if (ff.code !== 0) throw httpError(409, `Local history has diverged from ${this.remote}/${this.branch}; not a fast-forward`);

    this.cancelRequested = false;
    this.set({
      phase: 'draining', message: 'Waiting for current jobs to finish (no new jobs are being taken)',
      startedAt: new Date().toISOString(), finishedAt: null,
      previousCommit: previous, targetCommit: target, error: null,
    });
    logger.info(`⬆️ Self-update requested: ${previous.slice(0, 7)} -> ${target.slice(0, 7)}`);

    void this.runUpdate(previous, target).catch(error => {
      // Never leave intake paused because of a bug in here
      this.host.resumeIntake();
      const reason = error instanceof Error ? error.message : String(error);
      this.set({ phase: 'failed', finishedAt: new Date().toISOString(), error: reason, message: 'Update failed unexpectedly; job intake resumed' });
      logger.error('❌ Self-update crashed:', error);
    });
    return this.getState();
  }

  /** Only possible while draining; nothing has changed on disk yet. */
  cancel(): UpdateState {
    if (this.state.phase !== 'draining') {
      throw httpError(409, `Nothing to cancel (${this.state.phase})`);
    }
    this.cancelRequested = true;
    return this.getState();
  }

  private async runUpdate(previous: string, target: string): Promise<void> {
    this.host.pauseIntake();

    while (!this.host.isIdle()) {
      if (this.cancelRequested) {
        this.host.resumeIntake();
        this.set({ phase: 'idle', message: 'Update cancelled', finishedAt: new Date().toISOString() });
        logger.info('⬆️ Self-update cancelled; job intake resumed');
        return;
      }
      await new Promise(r => setTimeout(r, this.drainPollMs));
    }

    this.set({ phase: 'updating', message: `Fast-forwarding to ${target.slice(0, 7)}` });

    // Re-check right before touching the tree: someone may have pulled or edited files while
    // we drained. Nothing is ours to undo yet, so abort without a rollback (which would
    // `git reset --hard` over their changes).
    const head = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
    const dirty = significantChanges((await this.git(['status', '--porcelain', '--untracked-files=no'])).stdout).length > 0;
    if (head !== previous || dirty) {
      this.host.resumeIntake();
      const reason = head !== previous
        ? `HEAD moved to ${head.slice(0, 7) || 'unknown'} while waiting for jobs`
        : 'Local changes appeared while waiting for jobs';
      this.set({ phase: 'failed', finishedAt: new Date().toISOString(), error: reason, message: 'Update aborted before changing anything; still taking jobs' });
      logger.warn(`⬆️ Self-update aborted: ${reason}`);
      return;
    }

    try {
      await this.must(this.git(['merge', '--ff-only', target]), 'git merge --ff-only');

      this.set({ phase: 'installing', message: 'Installing dependencies (npm ci)' });
      await this.must(this.npm(['ci']), 'npm ci');

      this.set({ phase: 'verifying', message: 'Building and type-checking (npm run build)' });
      await this.must(this.npm(['run', 'build'], 10 * MINUTE), 'npm run build');
    } catch (error) {
      await this.rollback(previous, error instanceof Error ? error.message : String(error));
      return;
    }

    logger.info(`✅ Self-update applied: now at ${target.slice(0, 7)}`);

    if (this.isSupervised()) {
      this.set({ phase: 'restarting', message: 'Update applied; restarting' });
      try {
        await this.host.shutdown();
      } catch (error) {
        logger.warn('⚠️ Error during shutdown before restart:', error);
      }
      this.exit(RESTART_EXIT_CODE);
    } else {
      // Keep working on the old code until the operator restarts
      this.host.resumeIntake();
      this.set({
        phase: 'restart-required', finishedAt: new Date().toISOString(),
        message: `Update applied (${target.slice(0, 7)}). Restart the encoder to run it. Start it with scripts/run-encoder to restart automatically next time.`,
      });
      logger.warn(`⬆️ Update applied but this encoder isn't supervised by scripts/run-encoder - restart it to run ${target.slice(0, 7)}`);
    }
  }

  private async rollback(previous: string, reason: string): Promise<void> {
    logger.error(`❌ Self-update failed: ${reason}. Rolling back to ${previous.slice(0, 7)}`);
    this.set({ phase: 'rolling-back', message: `Update failed (${reason}); restoring ${previous.slice(0, 7)}`, error: reason });

    const problems: string[] = [];
    const reset = await this.git(['reset', '--hard', previous]);
    if (reset.code !== 0) problems.push(`git reset: ${reset.stderr.trim()}`);
    const ci = await this.npm(['ci']);
    if (ci.code !== 0) problems.push(`npm ci: ${summarizeOutput(ci.stderr)}`);
    const build = await this.npm(['run', 'build'], 10 * MINUTE);
    if (build.code !== 0) problems.push(`npm run build: ${summarizeOutput(build.stderr || build.stdout)}`);

    this.host.resumeIntake();

    if (problems.length) {
      const manual = `cd ${this.repoRoot} && git reset --hard ${previous} && npm ci && npm run build`;
      this.set({
        phase: 'failed', finishedAt: new Date().toISOString(),
        error: `${reason}. ROLLBACK INCOMPLETE (${problems.join('; ')}). Run: ${manual}`,
        message: 'Update failed and rollback did not complete. The encoder keeps running on code already loaded in memory; fix before restarting.',
      });
      logger.error(`🚨 Rollback incomplete: ${problems.join('; ')}. Run: ${manual}`);
    } else {
      this.set({
        phase: 'failed', finishedAt: new Date().toISOString(),
        message: `Update failed; still on ${previous.slice(0, 7)} and taking jobs`,
      });
      logger.warn(`↩️ Rolled back to ${previous.slice(0, 7)}; job intake resumed`);
    }
  }

  private async must(result: Promise<CommandResult>, label: string): Promise<void> {
    const r = await result;
    if (r.code !== 0) throw new Error(`${label} failed: ${summarizeOutput(r.stderr || r.stdout)}`);
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange?.(this.getState());
  }
}

/** Short reason for a failed command: the first error lines (npm ends with hints and log paths). */
export function summarizeOutput(text: string): string {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const errors = lines.filter(l => /\berror\b|\bfatal\b|\bERR!/i.test(l));
  const picked = errors.length ? errors.slice(0, 3) : lines.slice(-3);
  return (picked.join(' | ') || 'no output').slice(0, 300);
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
