import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { logger } from './Logger.js';

/**
 * Which commit is this encoder running, and is it behind upstream?
 * Read-only and notify-only: nothing here changes files on disk.
 */

export type VersionStatus =
  | 'unchecked'    // no upstream check yet (or checks disabled)
  | 'up-to-date'
  | 'behind'
  | 'ahead'
  | 'diverged'
  | 'not-found'    // upstream doesn't know this commit: fork or local build
  | 'unknown-commit' // couldn't determine the local commit
  | 'error';

export interface VersionInfo {
  /** package.json version, kept as `current` too for old dashboard pages */
  version: string;
  current: string;
  commit: string;        // full SHA or "unknown"
  shortCommit: string;
  commitSource: 'env' | 'git' | 'unknown';
  branch: string | null;
  dirty: boolean | null; // null = couldn't tell (no git binary)
  behindBy: number | null;
  aheadBy: number | null;
  latestCommit: string | null;
  checkedAt: string | null;
  status: VersionStatus;
  repo: string;
  upstreamBranch: string;
  compareUrl: string | null;
}

export interface LocalCommit {
  commit: string;
  source: 'env' | 'git' | 'unknown';
  branch: string | null;
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

const __dirname = dirname(fileURLToPath(import.meta.url));
/** src/services or dist/services -> repo root */
export const DEFAULT_REPO_ROOT = resolve(__dirname, '..', '..');

async function readTrimmed(path: string): Promise<string | null> {
  try {
    return (await fs.readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

/** Resolve the git dir and the common dir (they differ for worktrees). */
async function findGitDirs(repoRoot: string): Promise<{ gitDir: string; commonDir: string } | null> {
  const dotGit = join(repoRoot, '.git');
  let stat;
  try {
    stat = await fs.stat(dotGit);
  } catch {
    return null;
  }

  let gitDir = dotGit;
  if (stat.isFile()) {
    // Worktree / submodule: ".git" is a file containing "gitdir: <path>"
    const content = await readTrimmed(dotGit);
    const match = content?.match(/^gitdir:\s*(.+)$/m);
    if (!match) return null;
    gitDir = isAbsolute(match[1]!) ? match[1]! : resolve(repoRoot, match[1]!);
  }

  const common = await readTrimmed(join(gitDir, 'commondir'));
  const commonDir = common ? (isAbsolute(common) ? common : resolve(gitDir, common)) : gitDir;
  return { gitDir, commonDir };
}

async function lookupRef(ref: string, gitDir: string, commonDir: string): Promise<string | null> {
  for (const dir of gitDir === commonDir ? [gitDir] : [gitDir, commonDir]) {
    const sha = await readTrimmed(join(dir, ref));
    if (sha && FULL_SHA_RE.test(sha)) return sha.toLowerCase();
  }
  const packed = await readTrimmed(join(commonDir, 'packed-refs'));
  if (packed) {
    for (const line of packed.split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref && sha && FULL_SHA_RE.test(sha)) return sha.toLowerCase();
    }
  }
  return null;
}

/** Find the running commit without needing the git binary. */
export async function resolveLocalCommit(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot: string = DEFAULT_REPO_ROOT
): Promise<LocalCommit> {
  const fromEnv = env.ENCODER_COMMIT?.trim();
  if (fromEnv && SHA_RE.test(fromEnv)) {
    return { commit: fromEnv.toLowerCase(), source: 'env', branch: null };
  }

  const dirs = await findGitDirs(repoRoot);
  if (dirs) {
    const head = await readTrimmed(join(dirs.gitDir, 'HEAD'));
    if (head) {
      const refMatch = head.match(/^ref:\s*(.+)$/);
      if (refMatch) {
        const ref = refMatch[1]!.trim();
        const sha = await lookupRef(ref, dirs.gitDir, dirs.commonDir);
        if (sha) {
          return { commit: sha, source: 'git', branch: ref.replace(/^refs\/heads\//, '') };
        }
      } else if (FULL_SHA_RE.test(head)) {
        return { commit: head.toLowerCase(), source: 'git', branch: null }; // detached HEAD
      }
    }
  }

  return { commit: 'unknown', source: 'unknown', branch: null };
}

/** Best effort: true/false if git is available, null otherwise. Tracked files only. */
export function detectDirty(repoRoot: string = DEFAULT_REPO_ROOT): Promise<boolean | null> {
  return new Promise(resolvePromise => {
    // --no-optional-locks: don't refresh the index (which takes .git/index.lock and can make
    // an operator's concurrent `git pull` fail)
    execFile('git', ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot, timeout: 5000 }, (err, stdout) => {
      resolvePromise(err ? null : stdout.trim().length > 0);
    });
  });
}

export interface CompareResult {
  status: VersionStatus;
  behindBy: number | null;
  aheadBy: number | null;
  latestCommit: string | null;
}

/**
 * Map a GitHub compare response for `{local}...{branch}` to our terms.
 * GitHub counts from the head's (branch's) point of view: its `ahead_by` is how
 * many commits the branch has that local doesn't, i.e. how far local is BEHIND.
 */
export function mapCompareResponse(body: any, localCommit: string): CompareResult {
  const behindBy = typeof body?.ahead_by === 'number' ? body.ahead_by : null;
  const aheadBy = typeof body?.behind_by === 'number' ? body.behind_by : null;
  const statusMap: Record<string, VersionStatus> = {
    identical: 'up-to-date',
    ahead: 'behind',   // branch is ahead of local
    behind: 'ahead',   // branch is behind local
    diverged: 'diverged',
  };
  const commits: any[] = Array.isArray(body?.commits) ? body.commits : [];
  // commits lists base..head (max 250); the last one is the branch tip when complete
  const latestCommit =
    body?.status === 'identical' ? localCommit
    : behindBy !== null && commits.length === behindBy && commits.length > 0 ? String(commits[commits.length - 1].sha)
    : null;
  return { status: statusMap[body?.status] ?? 'error', behindBy, aheadBy, latestCommit };
}

export interface VersionServiceOptions {
  enabled?: boolean;
  repo?: string;
  branch?: string;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  fetchImpl?: typeof fetch;
  initialDelayMs?: number;
  intervalMs?: number;
  jitterMs?: number;
  timeoutMs?: number;
  onUpdate?: (info: VersionInfo) => void;
}

export class VersionService {
  private readonly enabled: boolean;
  private readonly repo: string;
  private readonly branch: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly repoRoot: string;
  private readonly fetchImpl: typeof fetch;
  private readonly initialDelayMs: number;
  private readonly intervalMs: number;
  private readonly jitterMs: number;
  private readonly timeoutMs: number;
  private readonly onUpdate: ((info: VersionInfo) => void) | undefined;
  private timer: NodeJS.Timeout | null = null;
  private etag: string | null = null;
  private info: VersionInfo;

  constructor(options: VersionServiceOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.repo = options.repo ?? 'Mantequilla-Soft/3speakencoder';
    this.branch = options.branch ?? 'main';
    this.env = options.env ?? process.env;
    this.repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.initialDelayMs = options.initialDelayMs ?? 2 * 60 * 1000;
    this.intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1000;
    this.jitterMs = options.jitterMs ?? 30 * 60 * 1000;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.onUpdate = options.onUpdate;

    let version = 'unknown';
    try {
      // createRequire, not a JSON import: native ESM needs `with { type: 'json' }`, which tsc
      // doesn't emit, so `import pkg from '../../package.json'` crashes under `node dist/index.js`.
      version = createRequire(join(this.repoRoot, 'package.json'))('./package.json').version;
    } catch {
      // keep "unknown"
    }
    this.info = {
      version, current: version,
      commit: 'unknown', shortCommit: 'unknown', commitSource: 'unknown', branch: null, dirty: null,
      behindBy: null, aheadBy: null, latestCommit: null, checkedAt: null,
      status: 'unchecked', repo: this.repo, upstreamBranch: this.branch, compareUrl: null,
    };
  }

  /** Resolve the local commit (fast, local only) and schedule upstream checks. */
  async start(): Promise<VersionInfo> {
    const local = await resolveLocalCommit(this.env, this.repoRoot);
    const dirty = local.source === 'git' ? await detectDirty(this.repoRoot) : null;
    this.info = {
      ...this.info,
      commit: local.commit,
      shortCommit: local.commit === 'unknown' ? 'unknown' : local.commit.slice(0, 7),
      commitSource: local.source,
      branch: local.branch,
      dirty,
      status: local.commit === 'unknown' ? 'unknown-commit' : 'unchecked',
    };

    const where = local.source === 'env' ? 'ENCODER_COMMIT' : local.source === 'git' ? `git${local.branch ? ` (${local.branch})` : ', detached'}` : 'not found';
    logger.info(`📦 Encoder ${this.info.version} @ ${this.info.shortCommit}${dirty ? ' (modified)' : ''} [${where}]`);

    if (this.enabled && local.commit !== 'unknown') {
      this.schedule(this.initialDelayMs);
    } else if (!this.enabled) {
      logger.info('📦 Upstream version check disabled (VERSION_CHECK_ENABLED=false)');
    }
    return this.getInfo();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  getInfo(): VersionInfo {
    return { ...this.info };
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(async () => {
      await this.check();
      const jitter = Math.round((Math.random() * 2 - 1) * this.jitterMs);
      this.schedule(this.intervalMs + jitter);
    }, delayMs);
    this.timer.unref();
  }

  /** One upstream check. Never throws; failures keep the previous result. */
  async check(): Promise<VersionInfo> {
    const local = this.info.commit;
    if (local === 'unknown') return this.getInfo();

    const url = `https://api.github.com/repos/${this.repo}/compare/${local}...${encodeURIComponent(this.branch)}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': `3speak-encoder/${this.info.version}`,
    };
    if (this.etag) headers['If-None-Match'] = this.etag;

    try {
      const res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      const checkedAt = new Date().toISOString();

      if (res.status === 304) {
        this.info = { ...this.info, checkedAt };
      } else if (res.status === 404) {
        this.etag = null;
        this.info = { ...this.info, status: 'not-found', behindBy: null, aheadBy: null, latestCommit: null, compareUrl: null, checkedAt };
        logger.info(`📦 ${this.repo} doesn't know commit ${this.info.shortCommit} - custom or fork build, skipping behind check`);
      } else if (res.ok) {
        this.etag = res.headers.get('etag');
        const result = mapCompareResponse(await res.json(), local);
        this.info = {
          ...this.info, ...result, checkedAt,
          compareUrl: `https://github.com/${this.repo}/compare/${local}...${this.branch}`,
        };
        if (result.status === 'behind' || result.status === 'diverged') {
          logger.warn(`📦 Encoder is ${result.behindBy} commit(s) behind ${this.repo}@${this.branch} (running ${this.info.shortCommit}). See ${this.info.compareUrl}`);
        }
      } else {
        // 403/429 rate limit, 5xx: keep the last good result
        logger.debug(`📦 Version check got HTTP ${res.status}; keeping previous result`);
        return this.getInfo();
      }
    } catch (error) {
      logger.debug(`📦 Version check failed (${error instanceof Error ? error.message : String(error)}); keeping previous result`);
      return this.getInfo();
    }

    this.onUpdate?.(this.getInfo());
    return this.getInfo();
  }
}
