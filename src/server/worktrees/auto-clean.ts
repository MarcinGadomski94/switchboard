import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  AUTO_CLEAN_KEPT_MAX,
  AUTO_CLEAN_RECENT_MAX,
  AUTO_CLEAN_RECORD_SETTING,
  AUTO_CLEAN_REMOTE_SETTING,
  AUTO_CLEAN_SETTING,
  type AutoCleanAgentState,
  type AutoCleanDecision,
  type AutoCleanFacts,
  type CleanedWorktree,
  cleanedText,
  decideAutoClean,
  decideRemote,
  protectedBranchReason,
  readAutoCleanRecord,
} from '../../core/auto-clean.ts';
import type { LifecyclePayload } from '../../core/event-payload.ts';
import { parseWorktreeList } from '../../core/worktrees.ts';
import { createdBranches, forgetCreatedBranch } from '../cleanup/created-branches.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { WorktreeRecord } from '../db/repos/worktrees.ts';
import type { Store } from '../db/store.ts';
import { type RunResult, failureText, runCommand, succeeded } from '../exec.ts';
import type { ProcessCwd } from '../processes/cwd.ts';

/** What triggered a clean-up (the log says it). */
export type AutoCleanCause = 'turn-end' | 'merged' | 'closed' | 'plan-merge' | 'sweep';

/** What {@link AutoCleanService.clean} did with one worktree. */
export type AutoCleanOutcome =
  | { readonly removed: true; readonly text: string; readonly cleaned: CleanedWorktree }
  | { readonly removed: false; readonly reason: string };

/** Options of {@link AutoCleanService}. */
export interface AutoCleanServiceOptions {
  readonly store: Store;
  readonly gitCommand?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /** `true` while the session's agent works: a turn, or its helper agents (D143). */
  readonly isBusy: (sessionId: string) => boolean;
  /** `true` while the session has a live process. */
  readonly isLive: (sessionId: string) => boolean;
  /** The working folders of this user's processes (`null` = not readable here). */
  readonly processCwds: () => Promise<readonly ProcessCwd[] | null>;
  /** Where {@link processCwds} cannot tell (Windows): the session's tracked processes (D127), by name. */
  readonly trackedProcesses?: (sessionId: string) => Promise<readonly string[]>;
  /** Writes the chat divider into the session (`lifecycle` `worktree-cleaned`). */
  readonly record?: (sessionId: string, label: string, payload: LifecyclePayload) => Promise<unknown>;
  /** Publishes the session again (its worktrees changed). */
  readonly announce?: (sessionId: string) => Promise<unknown>;
  /** Closes what still offers to remove the worktree (the Inbox's "PR merged" item). */
  readonly worktreeGone?: (worktreeId: string) => Promise<unknown>;
  /** Adopts the worktrees agents made since the last look (`AgentWorktrees.scan`), before a session's or a sweep's clean-up. */
  readonly adoptAgentMade?: () => Promise<unknown>;
  /** One line per removal and per new kept reason (default `console.log`). */
  readonly log?: (line: string) => void;
  readonly onError?: (error: unknown) => void;
  /** ms before a local git call is killed (default 120 s); the remote's reads and pushes get `pushTimeoutMs` (default 60 s). */
  readonly gitTimeoutMs?: number;
  readonly pushTimeoutMs?: number;
  /** The periodic sweep (default 30 min) and its first run after start (default 2 min). */
  readonly sweepMs?: number;
  readonly firstSweepMs?: number;
  /** How long a session's request waits, so a turn that starts at once is seen (default 1.5 s). */
  readonly settleMs?: number;
}

/** The facts plus what the removal needs. */
interface Inspection {
  readonly facts: AutoCleanFacts;
  readonly decision: AutoCleanDecision;
  readonly head: string | null;
  /** The base ref that contains HEAD (local or its remote-tracking copy), for the remote's tip. */
  readonly bases: readonly string[];
}

const DEFAULT_SWEEP_MS = 30 * 60_000;

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function canonical(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    return path.resolve(file);
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? text.trim();
}

/**
 * D145 (`docs/cleanup.md` → *Automatic clean-up of merged worktrees (D145)*): Switchboard's
 * agents clean up after themselves. A worktree Switchboard knows (a live `worktrees` row with a
 * session: one it made, or one its agent made and it adopted, D38 / {@link AgentWorktrees}) is
 * removed by itself once its work is merged and nothing would be lost ({@link decideAutoClean}),
 * with its local branch (`git branch -d`) and, when its agent pushed it, the branch on its remote
 * ({@link decideRemote}). Never `--force`, never `-D`, never a tag, never a protected, base or
 * default branch. Everything is read again right before the removal.
 *
 * Runs after a session's turn ends (its worktrees), when merge evidence appears (the PR poll, the
 * PR watcher, a plan's merge step), when a session is archived, and every 30 minutes; one
 * worktree at a time, requests for the same one coalesced; quiet (a chat divider in the owning
 * agent and a log line per removal). Off with Settings → *Clean up merged worktrees
 * automatically*. Each computer cleans its own worktrees.
 */
export class AutoCleanService {
  readonly #store: Store;
  readonly #git: readonly string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => Date;
  readonly #options: AutoCleanServiceOptions;
  readonly #log: (line: string) => void;
  readonly #onError: (error: unknown) => void;
  readonly #gitTimeout: number;
  readonly #pushTimeout: number;
  /** Worktree ids queued or being cleaned. */
  readonly #queued = new Set<string>();
  /** Sessions whose request waits for its settle time. */
  readonly #sessionTimers = new Map<string, NodeJS.Timeout>();
  /** The last kept reason per worktree (logged only when it changes). */
  readonly #kept = new Map<string, string>();
  #chain: Promise<unknown> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #first: NodeJS.Timeout | undefined;
  #cwds: { readonly at: number; readonly list: Promise<readonly ProcessCwd[] | null> } | null = null;
  #closed = false;

  constructor(options: AutoCleanServiceOptions) {
    this.#options = options;
    this.#store = options.store;
    this.#git = options.gitCommand ?? ['git'];
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? ((line) => console.log(line));
    this.#onError = options.onError ?? ((error) => console.error('switchboard auto clean-up:', error));
    this.#gitTimeout = options.gitTimeoutMs ?? 120_000;
    this.#pushTimeout = options.pushTimeoutMs ?? 60_000;
  }

  /** Starts the periodic sweep. */
  start(): void {
    if (this.#timer || this.#closed) return;
    this.#first = setTimeout(() => void this.sweep().catch(this.#onError), this.#options.firstSweepMs ?? 120_000);
    this.#first.unref();
    this.#timer = setInterval(() => void this.sweep().catch(this.#onError), this.#options.sweepMs ?? DEFAULT_SWEEP_MS);
    this.#timer.unref();
  }

  /** Stops the timers and waits for the clean-up in progress. */
  async stop(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#first) clearTimeout(this.#first);
    for (const timer of this.#sessionTimers.values()) clearTimeout(timer);
    this.#sessionTimers.clear();
    await this.#chain.catch(() => undefined);
  }

  /** `true` while the setting is on (default on). */
  async enabled(): Promise<boolean> {
    return (await this.#store.settings.get(AUTO_CLEAN_SETTING)) !== false;
  }

  /** A session's worktrees, after its settle time (a turn's end, its archiving, a plan's merge). Requests coalesce. */
  requestSession(sessionId: string, cause: AutoCleanCause): void {
    if (this.#closed || this.#sessionTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.#sessionTimers.delete(sessionId);
      void this.cleanSession(sessionId, cause).catch(this.#onError);
    }, this.#options.settleMs ?? 1_500);
    timer.unref();
    this.#sessionTimers.set(sessionId, timer);
  }

  /** One worktree (merge evidence appeared). Coalesced with a request already queued for it. */
  requestWorktree(worktreeId: string, cause: AutoCleanCause): void {
    if (this.#closed) return;
    void this.#enqueue(worktreeId, cause).catch(this.#onError);
  }

  /** Cleans the session's worktrees now (after adopting what its agent made); the outcomes by worktree id. */
  async cleanSession(sessionId: string, cause: AutoCleanCause): Promise<Map<string, AutoCleanOutcome>> {
    const out = new Map<string, AutoCleanOutcome>();
    if (this.#closed || !(await this.enabled())) return out;
    if (this.#options.adoptAgentMade) await this.#options.adoptAgentMade().catch(this.#onError);
    for (const row of await this.#store.worktrees.list({ sessionId })) {
      const outcome = await this.#enqueue(row.id, cause);
      if (outcome) out.set(row.id, outcome);
    }
    return out;
  }

  /** The periodic sweep: every live worktree with a session. */
  async sweep(): Promise<Map<string, AutoCleanOutcome>> {
    const out = new Map<string, AutoCleanOutcome>();
    if (this.#closed || !(await this.enabled())) return out;
    if (this.#options.adoptAgentMade) await this.#options.adoptAgentMade().catch(this.#onError);
    for (const row of await this.#store.worktrees.list()) {
      if (row.sessionId === null) continue;
      const outcome = await this.#enqueue(row.id, 'sweep');
      if (outcome) out.set(row.id, outcome);
    }
    return out;
  }

  /** Runs {@link clean} in the one chain; `null` when the worktree was queued already (that run answers). */
  #enqueue(worktreeId: string, cause: AutoCleanCause): Promise<AutoCleanOutcome | null> {
    if (this.#queued.has(worktreeId)) return Promise.resolve(null);
    this.#queued.add(worktreeId);
    const run = this.#chain
      .catch(() => undefined)
      .then(async () => {
        try {
          if (this.#closed || !(await this.enabled())) return { removed: false as const, reason: 'automatic clean-up is off' };
          return await this.clean(worktreeId, cause);
        } finally {
          this.#queued.delete(worktreeId);
        }
      });
    this.#chain = run;
    return run;
  }

  /**
   * D145: removes one worktree when every condition holds (read twice: once to decide, once
   * right before removing), then its local branch and its remote copy; else answers why it stays.
   * Plans' merge step and the tests call it directly (the setting is checked by the requests).
   */
  async clean(worktreeId: string, cause: AutoCleanCause = 'sweep'): Promise<AutoCleanOutcome> {
    const row = await this.#store.worktrees.get(worktreeId);
    if (!row || row.removedAt !== null) return { removed: false, reason: 'already removed' };
    if (row.sessionId === null) return { removed: false, reason: 'it belongs to no session' };
    if (!(await isDirectory(row.path))) return this.#keep(row, 'its folder is gone (Clean-up lists it)');
    if ((await canonical(row.path)) === (await canonical(row.repoPath))) return this.#keep(row, 'it is the main checkout');
    const first = await this.#inspect(row);
    if (!first.decision.remove) return this.#keep(row, first.decision.reason);
    // Read again right before removing: a turn, a process or a change may have started meanwhile.
    this.#cwds = null;
    const again = await this.#inspect(row);
    if (!again.decision.remove) return this.#keep(row, again.decision.reason);
    if (again.head !== first.head) return this.#keep(row, 'its branch moved while it was checked');
    const session = await this.#store.sessions.get(row.sessionId);
    // What the branch and its remote copy are (read before `git branch -d` drops its config).
    const upstreamRemote = await this.#config(row.repoPath, `branch.${row.branch}.remote`);
    const upstreamMerge = await this.#config(row.repoPath, `branch.${row.branch}.merge`);
    const removed = await this.#runGit(row.repoPath, ['worktree', 'remove', row.path]);
    if (!succeeded(removed)) return this.#keep(row, `git worktree remove refused: ${firstLine(failureText(removed))}`);
    await this.#runGit(row.repoPath, ['worktree', 'prune']);
    await this.#store.worktrees.markRemoved(row.id);
    this.#kept.delete(row.id);
    const how = again.facts.merged === 'pr' ? (row.prNumber !== null ? `PR #${row.prNumber} merged` : 'its PR was merged') : `merged into ${row.baseRef ?? 'its base'}`;
    const local = await this.#deleteLocalBranch(row);
    const remote = await this.#deleteRemoteBranch(row, again, upstreamRemote, upstreamMerge);
    const cleaned: CleanedWorktree = { name: path.basename(row.path), how, localBranch: local.deleted, localKept: local.reason, remote: remote.deleted, remoteKept: remote.kept };
    const text = cleanedText(cleaned);
    this.#log(`[auto-clean] ${text} (${row.path}; ${session ? `agent ${session.name}` : 'its agent was deleted'}; ${cause})`);
    await this.#remember(row, text);
    if (session && this.#options.record) {
      const payload: LifecyclePayload = { type: 'lifecycle', action: 'worktree-cleaned', message: text };
      await this.#options.record(session.id, text, payload).catch(this.#onError);
    }
    if (session) await this.#options.announce?.(session.id)?.catch(this.#onError);
    await this.#options.worktreeGone?.(row.id)?.catch(this.#onError);
    return { removed: true, text, cleaned };
  }

  async #keep(row: WorktreeRecord, reason: string): Promise<AutoCleanOutcome> {
    if (this.#kept.get(row.id) !== reason) {
      this.#kept.set(row.id, reason);
      this.#log(`[auto-clean] kept ${row.path}: ${reason}`);
      await this.#rememberKept(row.path, reason).catch(this.#onError);
    }
    return { removed: false, reason };
  }

  // ── the facts ────────────────────────────────────────────────────────

  async #inspect(row: WorktreeRecord): Promise<Inspection> {
    const dir = await canonical(row.path);
    const owner = row.sessionId !== null ? await this.#store.sessions.get(row.sessionId) : null;
    const agent = this.#agentState(owner);
    const sessions = await this.#store.sessions.list();
    let cwdOf: string | null = null;
    const usedBy: string[] = [];
    for (const session of sessions) {
      if (!session.cwd || !(inside(session.cwd, dir) || inside(session.cwd, row.path))) continue;
      if (session.closedAt === null) cwdOf ??= session.name;
      else if (session.id !== row.sessionId) usedBy.push(session.name);
    }
    const processes = await this.#processesIn([dir, row.path], row.sessionId);
    const status = await this.#runGit(row.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const uncommitted = succeeded(status) ? status.stdout.split('\0').filter((entry) => entry.trim() !== '' && /^.. /.test(entry)).length : Number.POSITIVE_INFINITY;
    const head = await this.#resolve(row.path, 'HEAD');
    const bases: string[] = [];
    for (const ref of await this.#baseRefs(row)) {
      const oid = await this.#resolve(row.path, ref);
      if (oid !== null) bases.push(oid);
    }
    let merged: AutoCleanFacts['merged'] = null;
    if (head !== null) {
      for (const base of bases) if (await this.#isAncestor(row.path, head, base)) merged = 'ancestor';
      if (merged === null && row.prState === 'MERGED') merged = 'pr';
    }
    const ownWork = head !== null && merged === 'ancestor' ? await this.#ownWork(row, head) : merged === 'pr';
    let localOnly = 0;
    if (head !== null && merged !== null) {
      const count = await this.#count(row.path, [head, '--not', '--remotes', ...bases]);
      localOnly = count ?? Number.POSITIVE_INFINITY;
    }
    const facts: AutoCleanFacts = {
      agent,
      cwdOf,
      usedBy,
      processes,
      uncommitted: Number.isFinite(uncommitted) ? uncommitted : 1,
      merged: head === null ? null : merged,
      ownWork,
      localOnly: Number.isFinite(localOnly) ? localOnly : 1,
      base: row.baseRef,
    };
    let decision = decideAutoClean(facts);
    if (!succeeded(status) && decision.remove) decision = { remove: false, reason: `git status failed: ${firstLine(failureText(status))}` };
    if (head === null && decision.remove) decision = { remove: false, reason: 'its HEAD cannot be read' };
    return { facts, decision, head, bases };
  }

  #agentState(session: SessionRecord | null): AutoCleanAgentState {
    // A deleted session's worktrees have no agent left to wait for.
    if (!session) return 'archived';
    if (this.#options.isLive(session.id) && (session.closedAt !== null || this.#options.isBusy(session.id))) return 'running';
    // A terminal (hooked) session's turn is known only from its stored status.
    if (session.hooked && session.status === 'run' && session.closedAt === null) return 'running';
    return session.closedAt !== null ? 'archived' : 'idle';
  }

  /** The row's base and, for a local branch name, its remote-tracking copy (a local base may be behind, D121). */
  async #baseRefs(row: WorktreeRecord): Promise<string[]> {
    if (!row.baseRef) return [];
    const refs = [row.baseRef];
    if (!row.baseRef.includes('/') || !(await this.#isRemoteRef(row.path, row.baseRef))) {
      const upstream = await this.#runGit(row.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${row.baseRef}@{upstream}`]);
      const name = upstream.stdout.trim();
      if (succeeded(upstream) && name !== '') refs.push(name);
      else refs.push(`origin/${row.baseRef}`);
    }
    return refs;
  }

  async #isRemoteRef(cwd: string, ref: string): Promise<boolean> {
    return succeeded(await this.#runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/remotes/${ref}`]));
  }

  /**
   * D121's rule for "merged" by ancestry: the branch has commits of its own (its reflog's
   * creation commit is behind HEAD and a commit was made on it). Without a reflog, HEAD differs
   * from where the worktree's base pointed is not known: then only a merged PR proves it.
   */
  async #ownWork(row: WorktreeRecord, head: string): Promise<boolean> {
    const log = await this.#runGit(row.repoPath, ['reflog', 'show', '--format=%H %gs', `refs/heads/${row.branch}`, '--']);
    if (!succeeded(log)) return false;
    const entries = log.stdout
      .split('\n')
      .map((line) => /^([0-9a-f]{40,64}) (.*)$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ sha: match[1] as string, subject: match[2] as string }));
    const oldest = entries.at(-1);
    if (!oldest || !/^branch: Created from/.test(oldest.subject)) return false;
    const start = oldest.sha;
    if (start === head || !(await this.#isAncestor(row.repoPath, start, head))) return false;
    for (const entry of entries) {
      if (entry.sha === start || !isOwnEntry(entry.subject, entry.sha)) continue;
      if (!(await this.#isAncestor(row.repoPath, entry.sha, head)) || (await this.#isAncestor(row.repoPath, entry.sha, start))) continue;
      return true;
    }
    return false;
  }

  async #processesIn(dirs: readonly string[], sessionId: string | null): Promise<readonly string[] | null> {
    const now = this.#now().getTime();
    if (!this.#cwds || now - this.#cwds.at > 10_000) this.#cwds = { at: now, list: this.#options.processCwds().catch(() => null) };
    const listed = await this.#cwds.list;
    if (listed === null) {
      if (!this.#options.trackedProcesses || sessionId === null) return null;
      return this.#options.trackedProcesses(sessionId).catch(() => null);
    }
    const names: string[] = [];
    for (const proc of listed) {
      if (proc.pid === process.pid) continue;
      if (dirs.some((dir) => inside(proc.cwd, dir))) names.push(proc.command || String(proc.pid));
    }
    return names;
  }

  // ── branches ─────────────────────────────────────────────────────────

  async #deleteLocalBranch(row: WorktreeRecord): Promise<{ readonly deleted: boolean; readonly reason: string | null }> {
    if (!(await this.#refExists(row.repoPath, `refs/heads/${row.branch}`))) return { deleted: false, reason: null };
    const defaultBranch = await this.#defaultBranch(row.repoPath, 'origin');
    const guarded = protectedBranchReason(row.branch, { base: row.baseRef, defaultBranch });
    if (guarded) return { deleted: false, reason: guarded };
    const others = (await this.#store.worktrees.list()).filter((other) => other.id !== row.id && other.repoPath === row.repoPath && other.branch === row.branch);
    if (others.length > 0) return { deleted: false, reason: 'another worktree of Switchboard uses it' };
    const listed = await this.#runGit(row.repoPath, ['worktree', 'list', '--porcelain']);
    if (succeeded(listed) && parseWorktreeList(listed.stdout).some((entry) => entry.branch === row.branch)) return { deleted: false, reason: 'it is checked out in another folder' };
    const deleted = await this.#runGit(row.repoPath, ['branch', '-d', row.branch]);
    if (!succeeded(deleted)) return { deleted: false, reason: `git branch -d refused: ${firstLine(failureText(deleted))}` };
    await forgetCreatedBranch(this.#store.settings, row.repoPath, row.branch).catch(this.#onError);
    return { deleted: true, reason: null };
  }

  async #deleteRemoteBranch(row: WorktreeRecord, inspection: Inspection, upstreamRemote: string | null, upstreamMerge: string | null): Promise<{ readonly deleted: string | null; readonly kept: string | null }> {
    const enabled = (await this.#store.settings.get(AUTO_CLEAN_REMOTE_SETTING)) !== false;
    const remote = upstreamRemote && upstreamRemote !== '.' ? upstreamRemote : (await this.#hasRemote(row.repoPath, 'origin')) ? 'origin' : null;
    const branch = upstreamMerge?.startsWith('refs/heads/') ? upstreamMerge.slice('refs/heads/'.length) : row.branch;
    if (!enabled || remote === null) return { deleted: null, kept: null };
    const tip = await this.#remoteTip(row.repoPath, remote, branch);
    let tipMerged = false;
    if (typeof tip === 'string') {
      tipMerged = tip === inspection.head;
      if (!tipMerged && (await this.#refExists(row.repoPath, tip))) for (const base of inspection.bases) if (await this.#isAncestor(row.repoPath, tip, base)) tipMerged = true;
    }
    const created = (await createdBranches(this.#store.settings)).find((entry) => entry.repoPath === row.repoPath && entry.branch === row.branch);
    const remotes = (await this.#runGit(row.repoPath, ['remote'])).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    const decision = decideRemote({
      enabled,
      remote,
      branch,
      tip,
      tipMerged,
      protectedReason: protectedBranchReason(branch, { base: row.baseRef, defaultBranch: await this.#defaultBranch(row.repoPath, remote), remotes }),
      tracking: created?.kind === 'tracking',
    });
    const label = `${remote}/${branch}`;
    if (!decision.delete) return { deleted: null, kept: decision.reason ? `${label} (${decision.reason})` : null };
    // The lease makes the remote refuse when its branch moved since it was read.
    const pushed = await this.#runGit(row.repoPath, ['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:${tip as string}`, remote, '--delete', `refs/heads/${branch}`], this.#pushTimeout);
    if (!succeeded(pushed)) return { deleted: null, kept: `${label} (the remote refused: ${firstLine(failureText(pushed))})` };
    return { deleted: label, kept: null };
  }

  /** The branch's tip on the remote (`git ls-remote`, no fetch); `null` = not there; `undefined` = the remote could not be read. */
  async #remoteTip(repoPath: string, remote: string, branch: string): Promise<string | null | undefined> {
    const listed = await this.#runGit(repoPath, ['ls-remote', '--heads', remote, `refs/heads/${branch}`], this.#pushTimeout);
    if (!succeeded(listed)) return undefined;
    const line = listed.stdout.split('\n').find((entry) => entry.trim().endsWith(`refs/heads/${branch}`));
    return line ? (line.trim().split(/\s+/)[0] ?? null) : null;
  }

  async #defaultBranch(repoPath: string, remote: string): Promise<string | null> {
    const symbolic = await this.#runGit(repoPath, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
    const ref = symbolic.stdout.trim();
    return succeeded(symbolic) && ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : null;
  }

  async #hasRemote(repoPath: string, remote: string): Promise<boolean> {
    return succeeded(await this.#runGit(repoPath, ['remote', 'get-url', remote]));
  }

  async #config(repoPath: string, key: string): Promise<string | null> {
    const result = await this.#runGit(repoPath, ['config', '--get', key]);
    const value = result.stdout.trim();
    return succeeded(result) && value !== '' ? value : null;
  }

  // ── the record ───────────────────────────────────────────────────────

  async #remember(row: WorktreeRecord, text: string): Promise<void> {
    const record = readAutoCleanRecord(await this.#store.settings.get(AUTO_CLEAN_RECORD_SETTING));
    const at = this.#now().toISOString();
    await this.#store.settings.set(AUTO_CLEAN_RECORD_SETTING, {
      cleaned: record.cleaned + 1,
      lastCleanedAt: at,
      recent: [...record.recent, { at, path: row.path, text }].slice(-AUTO_CLEAN_RECENT_MAX),
      kept: record.kept.filter((item) => item.path !== row.path),
    });
  }

  async #rememberKept(file: string, reason: string): Promise<void> {
    const record = readAutoCleanRecord(await this.#store.settings.get(AUTO_CLEAN_RECORD_SETTING));
    const live = new Set((await this.#store.worktrees.list()).map((row) => row.path));
    const kept = [...record.kept.filter((item) => item.path !== file && live.has(item.path)), { path: file, reason }].slice(-AUTO_CLEAN_KEPT_MAX);
    await this.#store.settings.set(AUTO_CLEAN_RECORD_SETTING, { ...record, kept });
  }

  // ── git ──────────────────────────────────────────────────────────────

  async #resolve(cwd: string, ref: string): Promise<string | null> {
    const result = await this.#runGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const oid = result.stdout.trim();
    return succeeded(result) && oid !== '' ? oid : null;
  }

  async #refExists(cwd: string, ref: string): Promise<boolean> {
    return succeeded(await this.#runGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]));
  }

  async #isAncestor(cwd: string, commit: string, base: string): Promise<boolean> {
    return (await this.#runGit(cwd, ['merge-base', '--is-ancestor', commit, base])).code === 0;
  }

  async #count(cwd: string, revs: readonly string[]): Promise<number | null> {
    const result = await this.#runGit(cwd, ['rev-list', '--count', ...revs, '--']);
    const n = Number.parseInt(result.stdout.trim(), 10);
    return succeeded(result) && Number.isFinite(n) ? n : null;
  }

  #runGit(cwd: string, args: readonly string[], timeoutMs: number = this.#gitTimeout): Promise<RunResult> {
    return runCommand(this.#git, args, { cwd, env: { ...this.#env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, timeoutMs });
  }
}

/**
 * D121 (`src/server/plans/git.ts`, kept separate: Plans can be removed): a reflog entry that
 * made a commit of the branch's own (a commit, an amend, a cherry-pick, a revert, `am`, or a
 * rebase that ended on a commit other than the one it went onto).
 */
function isOwnEntry(subject: string, sha: string): boolean {
  if (/^commit( \(amend\))?: /.test(subject) || /^(cherry-pick|revert|am)\b/.test(subject)) return true;
  const rebase = /\(finish\): .* onto ([0-9a-f]{40,64})$/.exec(subject);
  return rebase !== null && rebase[1] !== sha;
}
