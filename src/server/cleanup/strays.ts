import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseWorktreeList } from '../../core/worktrees.ts';
import {
  STRAY_LAST_CHECK_SETTING,
  STRAY_RESTORABLE_SETTING,
  STRAY_RESTORE_DAYS,
  STRAY_STATUS_CAP,
  STRAY_TEMP_AGE_MS,
  type StrayCleanOutcome,
  type StrayCleanRequest,
  type StrayCleanResult,
  type StrayItem,
  type StrayKind,
  type StrayRestorable,
  type StrayRestoreRequest,
  type StrayScan,
  strayCheckDue,
  strayFingerprint,
  straySafe,
} from '../../core/strays.ts';
import type { Store } from '../db/store.ts';
import { failureText, runCommand, succeeded } from '../exec.ts';
import { type FolderRef, folderRefOf } from '../folders/ref.ts';
import type { AdoptionRepo } from '../worktrees/manager.ts';

/** Where the idle notice goes (the Inbox's system items). */
export interface StrayNotice {
  raise(input: { readonly count: number; readonly bytes: number; readonly fingerprint: string }): Promise<unknown>;
  resolve(): Promise<unknown>;
}

/** Options of {@link StrayService}. */
export interface StrayServiceOptions {
  readonly store: Store;
  readonly dataDir: string;
  /** `true` while the open session's agent works (a turn, helpers, a background command it waits on). */
  readonly isWorking: (sessionId: string) => boolean;
  readonly notice?: StrayNotice;
  /** A workspace folder's repositories (the app passes D38's `scannedRepos`). */
  readonly repos?: (folder: FolderRef) => Promise<AdoptionRepo[]>;
  readonly gitCommand?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  /** How often the idle watch looks (default 60 s). */
  readonly tickMs?: number;
  /** No agent working this long → the check may run (default 30 min). */
  readonly idleMs?: number;
  /** Files and folders a size walk visits before it stops (default 50 000). */
  readonly sizeWalkLimit?: number;
  readonly onError?: (error: unknown) => void;
}

/** Why a clean or a restore was refused. */
export class StrayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'StrayError';
    this.status = status;
    this.code = code;
  }
}

/** Where Claude Code puts its helpers' worktrees (`/`-separated paths). */
const CLAUDE_WORKTREES = '/.claude/worktrees/';
const AGENT_BRANCH = /^worktree-agent-/;

/** A path compared as the file system does (resolved; case-insensitive on Windows and macOS defaults left alone). */
function keyOf(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function real(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    return path.resolve(file);
  }
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

function idOf(kind: StrayKind, ...parts: readonly string[]): string {
  return `${kind}:${createHash('sha256').update([kind, ...parts].join('\0')).digest('hex').slice(0, 16)}`;
}

/**
 * D191 (`docs/worktrees.md` → *Stray worktrees*): finds the worktrees no open agent uses in the
 * repositories Switchboard knows on this computer (the folders of kind repo, the workspaces'
 * repositories, the repositories of Switchboard's worktrees), the stale worktree records git still
 * lists, the leftover branches of worktrees that are gone (Claude Code's `worktree-agent-…` and the
 * ones Switchboard made) and its own temporary folders older than a day. Cleans what the developer
 * ticked (a risky one only with `force`), keeps the deleted branches' tips for
 * {@link STRAY_RESTORE_DAYS} days so they can be put back, and raises a Needs-you notice once no
 * agent has worked for a while (at most once a day, again only when the items change).
 *
 * Never touches a main checkout, a worktree an open session uses (its worktree rows, its working
 * folder or root inside it), a Claude Code helper worktree of a repository an agent works in now,
 * anything outside the known repositories and the data folder's `tmp`, or untracked files'
 * content (only counted). Git runs with an args array, never a shell.
 */
export class StrayService {
  readonly #store: Store;
  readonly #dataDir: string;
  readonly #isWorking: (sessionId: string) => boolean;
  readonly #notice: StrayNotice | null;
  readonly #repos: (folder: FolderRef) => Promise<AdoptionRepo[]>;
  readonly #git: readonly string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => number;
  readonly #tickMs: number;
  readonly #idleMs: number;
  readonly #sizeLimit: number;
  readonly #onError: (error: unknown) => void;
  #timer: NodeJS.Timeout | null = null;
  #idleSince: number | null = null;
  #ticking: Promise<void> | null = null;
  #cleaning = false;

  constructor(options: StrayServiceOptions) {
    this.#store = options.store;
    this.#dataDir = options.dataDir;
    this.#isWorking = options.isWorking;
    this.#notice = options.notice ?? null;
    this.#repos = options.repos ?? (async () => []);
    this.#git = options.gitCommand ?? ['git'];
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? Date.now;
    this.#tickMs = options.tickMs ?? 60_000;
    this.#idleMs = options.idleMs ?? 30 * 60_000;
    this.#sizeLimit = options.sizeWalkLimit ?? 50_000;
    this.#onError = options.onError ?? ((error) => console.error('switchboard strays:', error));
  }

  // ── the idle watch ──────────────────────────────────────────────────────

  /** Starts the idle watch (idempotent). The idle time counts from now. */
  start(): void {
    if (this.#timer) return;
    this.#idleSince = this.#now();
    this.#timer = setInterval(() => void this.tick(), this.#tickMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#ticking?.catch(() => undefined);
  }

  /** One look (the timer's; tests call it with a fake clock). */
  tick(): Promise<void> {
    this.#ticking ??= this.#tickNow()
      .catch((error: unknown) => this.#onError(error))
      .finally(() => {
        this.#ticking = null;
      });
    return this.#ticking;
  }

  async #tickNow(): Promise<void> {
    const now = this.#now();
    if (await this.#anyWorking()) {
      this.#idleSince = null;
      return;
    }
    this.#idleSince ??= now;
    const last = await this.#store.settings.get(STRAY_LAST_CHECK_SETTING);
    const lastCheck = typeof last === 'number' ? last : null;
    if (!strayCheckDue({ now, idleSince: this.#idleSince, lastCheck, idleMs: this.#idleMs })) return;
    await this.#store.settings.set(STRAY_LAST_CHECK_SETTING, now);
    const scan = await this.scan();
    if (!this.#notice) return;
    if (scan.items.length === 0) await this.#notice.resolve();
    else await this.#notice.raise({ count: scan.items.length, bytes: scan.items.reduce((sum, item) => sum + (item.bytes ?? 0), 0), fingerprint: strayFingerprint(scan.items) });
  }

  async #anyWorking(): Promise<boolean> {
    for (const session of await this.#store.sessions.list({ closed: false })) if (this.#isWorking(session.id)) return true;
    return false;
  }

  // ── finding ─────────────────────────────────────────────────────────────

  /** The repositories Switchboard knows on this computer (main checkouts, real paths, once each). */
  async #knownRepos(): Promise<string[]> {
    const found = new Map<string, string>();
    const add = async (candidate: string): Promise<void> => {
      const top = await this.#mainCheckout(candidate);
      if (top) found.set(keyOf(top), top);
    };
    for (const folder of await this.#store.folders.list()) {
      if (folder.kind === 'repo') await add(folder.path);
      else if (folder.kind === 'workspace') {
        let repos: AdoptionRepo[] = [];
        try {
          repos = await this.#repos(folderRefOf(folder));
        } catch {
          repos = [];
        }
        for (const repo of repos) await add(repo.repoPath);
      }
    }
    for (const row of await this.#store.worktrees.list({ includeRemoved: true })) await add(row.repoPath);
    return [...found.values()].sort();
  }

  /** The main checkout of the repository `dir` belongs to (`null` when it is no repository). */
  async #mainCheckout(dir: string): Promise<string | null> {
    try {
      await stat(dir);
    } catch {
      return null;
    }
    const common = await runCommand(this.#git, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, env: this.#env, timeoutMs: 20_000 });
    if (!succeeded(common)) return null;
    const gitDir = common.stdout.trim();
    if (!gitDir) return null;
    // `<main>/.git` → `<main>`; a bare repository has no main checkout (skipped).
    if (path.basename(gitDir) !== '.git') return null;
    return real(path.dirname(gitDir));
  }

  /** The whole scan (read-only: nothing changes). */
  async scan(): Promise<StrayScan> {
    const repos = await this.#knownRepos();
    const open = await this.#store.sessions.list({ closed: false });
    const openIds = new Set(open.map((session) => session.id));
    const usedPaths: string[] = [];
    for (const session of open) {
      for (const p of [session.cwd, session.root]) if (p) usedPaths.push(keyOf(await real(p)));
    }
    const rows = await this.#store.worktrees.list({ includeRemoved: true });
    const usedRows = new Set(rows.filter((row) => row.removedAt === null && row.sessionId !== null && openIds.has(row.sessionId)).map((row) => keyOf(row.path)));
    const rowPaths = new Set(rows.filter((row) => row.removedAt === null).map((row) => keyOf(row.path)));
    const working = open.filter((session) => this.#isWorking(session.id));
    const items: StrayItem[] = [];
    const errors: Array<{ repo: string; message: string }> = [];
    let inUse = 0;
    for (const repo of repos) {
      const listed = await runCommand(this.#git, ['worktree', 'list', '--porcelain'], { cwd: repo, env: this.#env, timeoutMs: 30_000 });
      if (!succeeded(listed)) {
        errors.push({ repo, message: failureText(listed) });
        continue;
      }
      const worktrees = parseWorktreeList(listed.stdout);
      const repoKey = keyOf(repo);
      // An agent working in this repository now: its Claude Code helper worktrees are in use.
      const busyRepo = working.some((session) => [session.cwd, session.root].some((p) => p !== null && inside(keyOf(p), repoKey)) || rows.some((row) => row.sessionId === session.id && keyOf(row.repoPath) === repoKey));
      const checkedOut = new Set<string>();
      for (const [index, worktree] of worktrees.entries()) {
        if (worktree.branch) checkedOut.add(worktree.branch);
        if (worktree.bare) continue;
        const wtKey = keyOf(worktree.path);
        // The main checkout (the first entry, or the repository itself) is never stray.
        if (index === 0 || wtKey === repoKey) continue;
        if (worktree.prunable) {
          items.push(this.#item('stale-record', repo, worktree.path, worktree.branch, worktree.head));
          continue;
        }
        const kind: StrayKind = worktree.path.replace(/\\/g, '/').includes(CLAUDE_WORKTREES) ? 'claude-subagent' : rowPaths.has(wtKey) ? 'switchboard' : 'other';
        const used = usedRows.has(wtKey) || usedPaths.some((p) => inside(p, wtKey)) || (kind === 'claude-subagent' && busyRepo);
        if (used) {
          inUse++;
          continue;
        }
        items.push(await this.#worktreeItem(kind, repo, worktree.path, worktree.branch, worktree.head));
      }
      items.push(...(await this.#leftoverBranches(repo, checkedOut, rows.filter((row) => keyOf(row.repoPath) === repoKey && row.removedAt !== null && !(row.sessionId !== null && openIds.has(row.sessionId))).map((row) => row.branch))));
    }
    items.push(...(await this.#tempLeftovers()));
    return { items, repos: repos.length, inUse, errors, scannedAt: new Date(this.#now()).toISOString() };
  }

  #item(kind: StrayKind, repo: string | null, file: string | null, branch: string | null, head: string | null, extra: Partial<StrayItem> = {}): StrayItem {
    return {
      id: idOf(kind, repo ? keyOf(repo) : '', file ? keyOf(file) : '', file ? '' : (branch ?? '')),
      kind,
      repo,
      path: file,
      branch,
      head,
      bytes: null,
      bytesCapped: false,
      uncommitted: null,
      uniqueCommits: null,
      modifiedAt: null,
      ...extra,
    };
  }

  async #worktreeItem(kind: StrayKind, repo: string, file: string, branch: string | null, head: string | null): Promise<StrayItem> {
    const status = await runCommand(this.#git, ['status', '--porcelain', '--untracked-files=normal'], { cwd: file, env: this.#env, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
    const uncommitted = succeeded(status) ? Math.min(STRAY_STATUS_CAP, status.stdout.split('\n').filter((line) => line.trim() !== '').length) : null;
    const uniqueCommits = await this.#uniqueCommits(repo, branch, head);
    const size = await this.#size(file);
    let modifiedAt: string | null = null;
    try {
      modifiedAt = new Date((await stat(file)).mtimeMs).toISOString();
    } catch {
      modifiedAt = null;
    }
    return this.#item(kind, repo, file, branch, head, { bytes: size.bytes, bytesCapped: size.capped, uncommitted, uniqueCommits, modifiedAt });
  }

  /** Commits on `branch` (or the detached `head`) that are on no other branch and no remote; `null` when unknown. */
  async #uniqueCommits(repo: string, branch: string | null, head: string | null): Promise<number | null> {
    const tip = branch ? `refs/heads/${branch}` : head;
    if (!tip) return null;
    const args = ['rev-list', '--count', tip, '--not', ...(branch ? [`--exclude=${branch}`] : []), '--branches', '--remotes'];
    const counted = await runCommand(this.#git, args, { cwd: repo, env: this.#env, timeoutMs: 30_000 });
    if (!succeeded(counted)) return null;
    const n = Number(counted.stdout.trim());
    return Number.isFinite(n) ? n : null;
  }

  /** Claude Code's `worktree-agent-…` branches and the removed Switchboard worktrees' branches no worktree has checked out. */
  async #leftoverBranches(repo: string, checkedOut: ReadonlySet<string>, removedRowBranches: readonly string[]): Promise<StrayItem[]> {
    const refs = await runCommand(this.#git, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads/'], { cwd: repo, env: this.#env, timeoutMs: 30_000 });
    if (!succeeded(refs)) return [];
    const wanted = new Set(removedRowBranches);
    const out: StrayItem[] = [];
    for (const line of refs.stdout.split('\n')) {
      const [name, sha] = line.trim().split('\t');
      if (!name || !sha || checkedOut.has(name)) continue;
      if (!AGENT_BRANCH.test(name) && !wanted.has(name)) continue;
      out.push(this.#item('branch', repo, null, name, sha, { uniqueCommits: await this.#uniqueCommits(repo, name, sha) }));
    }
    return out;
  }

  /** `<dataDir>/tmp/<kind>/<entry>` folders older than a day. */
  async #tempLeftovers(): Promise<StrayItem[]> {
    const root = path.join(this.#dataDir, 'tmp');
    const out: StrayItem[] = [];
    let kinds: string[] = [];
    try {
      kinds = await readdir(root);
    } catch {
      return [];
    }
    for (const kind of kinds) {
      let entries: string[] = [];
      try {
        entries = await readdir(path.join(root, kind));
      } catch {
        continue;
      }
      for (const entry of entries) {
        const file = path.join(root, kind, entry);
        try {
          const info = await lstat(file);
          if (this.#now() - info.mtimeMs < STRAY_TEMP_AGE_MS) continue;
          const size = await this.#size(file);
          out.push(this.#item('temp', null, file, null, null, { bytes: size.bytes, bytesCapped: size.capped, modifiedAt: new Date(info.mtimeMs).toISOString() }));
        } catch {
          // gone meanwhile
        }
      }
    }
    return out;
  }

  /** Bytes under `file` (no symlinks followed); `capped` when the walk stopped at its limit. */
  async #size(file: string): Promise<{ readonly bytes: number; readonly capped: boolean }> {
    let bytes = 0;
    let visited = 0;
    const stack = [file];
    while (stack.length > 0) {
      if (visited >= this.#sizeLimit) return { bytes, capped: true };
      const current = stack.pop() as string;
      visited++;
      try {
        const info = await lstat(current);
        if (info.isDirectory()) for (const entry of await readdir(current)) stack.push(path.join(current, entry));
        else bytes += info.size;
      } catch {
        // gone meanwhile
      }
    }
    return { bytes, capped: false };
  }

  // ── cleaning ────────────────────────────────────────────────────────────

  /**
   * Cleans the ticked items, judged against a fresh scan (an item no longer stray is skipped): a risky
   * one only with `force`; each on its own (a failure never stops the others). A Claude Code helper
   * worktree's own branch goes with it when it has no commits of its own (restorable); a risky
   * worktree's branch always stays (its commits are kept).
   */
  async clean(request: StrayCleanRequest): Promise<StrayCleanResult> {
    if (this.#cleaning) throw new StrayError(409, 'busy', 'a clean-up is already running');
    this.#cleaning = true;
    try {
      const scan = await this.scan();
      const byId = new Map(scan.items.map((item) => [item.id, item]));
      const outcomes: StrayCleanOutcome[] = [];
      const pruned = new Set<string>();
      let freed = 0;
      for (const id of request.ids) {
        const item = byId.get(id);
        if (!item) {
          outcomes.push({ id, result: 'skipped', message: 'no longer stray (in use now, or already gone)' });
          continue;
        }
        if (!straySafe(item) && !request.force) {
          outcomes.push({ id, result: 'skipped', message: 'it has work found nowhere else: confirm to clean it anyway' });
          continue;
        }
        try {
          const message = await this.#cleanOne(item, request.force, pruned);
          freed += item.bytes ?? 0;
          outcomes.push({ id, result: 'removed', message });
        } catch (error) {
          outcomes.push({ id, result: 'failed', message: error instanceof Error ? error.message : String(error) });
        }
      }
      if (this.#notice) {
        const after = await this.scan();
        if (after.items.length === 0) await this.#notice.resolve().catch((error: unknown) => this.#onError(error));
      }
      return { outcomes, freedBytes: freed, restorable: await this.restorable() };
    } finally {
      this.#cleaning = false;
    }
  }

  async #cleanOne(item: StrayItem, force: boolean, pruned: Set<string>): Promise<string | null> {
    switch (item.kind) {
      case 'stale-record': {
        const repo = item.repo as string;
        if (pruned.has(repo)) return null;
        await this.#gitOk(repo, ['worktree', 'prune']);
        pruned.add(repo);
        return null;
      }
      case 'branch':
        await this.#deleteBranch(item.repo as string, item.branch as string, item.head as string);
        return null;
      case 'temp': {
        const file = item.path as string;
        const root = path.join(this.#dataDir, 'tmp');
        if (!inside(keyOf(file), keyOf(root)) || keyOf(file) === keyOf(root)) throw new Error('not a temporary folder of Switchboard');
        await rm(file, { recursive: true, force: true });
        return null;
      }
      default: {
        const repo = item.repo as string;
        const file = item.path as string;
        await this.#gitOk(repo, ['worktree', 'remove', ...(force && !straySafe(item) ? ['--force'] : []), file]);
        const row = await this.#store.worktrees.getLiveByPath(file);
        if (row) await this.#store.worktrees.markRemoved(row.id);
        // Its own branch (Claude Code's helper branch) goes too when nothing on it is unique.
        if (item.kind === 'claude-subagent' && item.branch && AGENT_BRANCH.test(item.branch) && item.uniqueCommits === 0 && item.head) {
          await this.#deleteBranch(repo, item.branch, item.head);
          return `its branch ${item.branch} was deleted too (restorable for ${STRAY_RESTORE_DAYS} days)`;
        }
        return item.branch ? `its branch ${item.branch} is kept` : null;
      }
    }
  }

  async #gitOk(repo: string, args: readonly string[]): Promise<void> {
    const result = await runCommand(this.#git, args, { cwd: repo, env: this.#env, timeoutMs: 120_000 });
    if (!succeeded(result)) throw new Error(failureText(result));
  }

  async #deleteBranch(repo: string, branch: string, sha: string): Promise<void> {
    await this.#gitOk(repo, ['branch', '-D', branch]);
    const kept = await this.restorable();
    await this.#store.settings.set(STRAY_RESTORABLE_SETTING, [...kept.filter((entry) => !(entry.repo === repo && entry.branch === branch)), { repo, branch, sha, deletedAt: new Date(this.#now()).toISOString() }]);
  }

  /** The deleted branches still restorable (older than {@link STRAY_RESTORE_DAYS} days are forgotten). */
  async restorable(): Promise<StrayRestorable[]> {
    const stored = await this.#store.settings.get(STRAY_RESTORABLE_SETTING);
    if (!Array.isArray(stored)) return [];
    const since = this.#now() - STRAY_RESTORE_DAYS * 24 * 3_600_000;
    return stored.filter(
      (entry): entry is StrayRestorable =>
        typeof entry === 'object' && entry !== null && typeof entry.repo === 'string' && typeof entry.branch === 'string' && typeof entry.sha === 'string' && typeof entry.deletedAt === 'string' && Date.parse(entry.deletedAt) >= since,
    );
  }

  /** Puts a branch this clean-up deleted back at its tip (only one it recorded, within the restore days). */
  async restore(request: StrayRestoreRequest): Promise<StrayRestorable[]> {
    const kept = await this.restorable();
    const entry = kept.find((candidate) => candidate.repo === request.repo && candidate.branch === request.branch && candidate.sha === request.sha);
    if (!entry) throw new StrayError(404, 'not-found', 'that branch is not one this clean-up deleted (or its restore time is over)');
    const result = await runCommand(this.#git, ['branch', entry.branch, entry.sha], { cwd: entry.repo, env: this.#env, timeoutMs: 30_000 });
    if (!succeeded(result)) throw new StrayError(409, 'failed', failureText(result));
    const rest = kept.filter((candidate) => candidate !== entry);
    await this.#store.settings.set(STRAY_RESTORABLE_SETTING, rest);
    return rest;
  }
}
