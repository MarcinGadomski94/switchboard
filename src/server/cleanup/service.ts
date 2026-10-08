import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { ATTACHMENT_RETENTION_DAYS } from '../../core/attachments.ts';
import {
  CLEANUP_FILES_MAX,
  CLEANUP_SESSION_DAYS_SETTING,
  type CleanupConfirm,
  type CleanupGroup,
  type CleanupItem,
  type CleanupReason,
  type CleanupRun,
  type CleanupRunItem,
  type CleanupRunRequest,
  type CleanupScan,
  type CleanupWarning,
  STALE_WORKTREE_DAYS,
  TAKEOVER_STAGING_DAYS,
  closedSessionDaysOf,
  hasSwitchboardBranchName,
  inRunOrder,
  missingConfirmations,
} from '../../core/cleanup.ts';
import { type Leftover, redactUrl } from '../../core/takeover.ts';
import { parseWorktreeList } from '../../core/worktrees.ts';
import { ATTACHMENTS_DIR, STAGED_DIR } from '../attachments/service.ts';
import type { AttachmentRecord } from '../db/repos/attachments.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { WorktreeRecord } from '../db/repos/worktrees.ts';
import type { Store } from '../db/store.ts';
import { type RunResult, failureText, runCommand, succeeded } from '../exec.ts';
import { type CreatedBranch, createdBranches, forgetCreatedBranch } from './created-branches.ts';

/** What Clean-up needs of the take-over service (D65): its leftovers and whether an operation still runs. */
export interface CleanupTakeover {
  listLeftovers(): Promise<Leftover[]>;
  deleteLeftover(id: string): Promise<unknown>;
  hasTarget(opId: string): boolean;
}

/** Options of {@link CleanupService}. */
export interface CleanupServiceOptions {
  readonly store: Store;
  /** Switchboard's data folder (attachments, handovers, take-over staging). */
  readonly dataDir: string;
  /** git argv prefix (default `["git"]`; tests wrap it to log every call). */
  readonly gitCommand?: readonly string[];
  /** Base environment of git (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /** `true` while a session has a running process (its worktrees are in use; it is never deleted). */
  readonly isLive?: (sessionId: string) => boolean;
  readonly takeover?: CleanupTakeover;
  /** ms before a local git call is killed (default 120 s); a push to a remote gets `pushTimeoutMs` (default 60 s). */
  readonly gitTimeoutMs?: number;
  readonly pushTimeoutMs?: number;
  /** Files and folders a size walk visits before it stops and reports a lower bound (default 200 000). */
  readonly sizeWalkLimit?: number;
}

/** A refusal of a Clean-up call, sent as `{ error, message }` (422 `invalid` with `errors` for a field). */
export class CleanupError extends Error {
  override name = 'CleanupError';
  readonly status: number;
  readonly code: string;
  readonly items: readonly string[];
  constructor(status: number, code: string, message: string, items: readonly string[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.items = items;
  }
}

type Action =
  | { readonly kind: 'worktree'; readonly record: WorktreeRecord; readonly missing: boolean; readonly uncommitted: readonly string[] }
  | { readonly kind: 'local-branch'; readonly repoPath: string; readonly branch: string; readonly oid: string }
  | { readonly kind: 'remote-branch'; readonly repoPath: string; readonly remote: string; readonly branch: string; readonly oid: string }
  | { readonly kind: 'leftover'; readonly leftoverId: string }
  | { readonly kind: 'session'; readonly sessionId: string; readonly paths: readonly string[] }
  | { readonly kind: 'attachments'; readonly rows: readonly AttachmentRecord[]; readonly paths: readonly string[] }
  | { readonly kind: 'paths'; readonly paths: readonly string[] };

interface Planned {
  readonly item: CleanupItem;
  readonly action: Action;
}

interface ScanResult {
  readonly scan: CleanupScan;
  readonly planned: Map<string, Planned>;
}

type SessionState = 'open' | 'closed' | 'gone' | 'unassigned';

interface RepoView {
  readonly ok: boolean;
  readonly main: string | null;
  /** branch → the worktree paths it is checked out in (real paths when they resolve). */
  readonly checkedOut: Map<string, string[]>;
  readonly listed: Set<string>;
}

interface BranchCandidate {
  readonly repoPath: string;
  readonly branch: string;
  readonly records: WorktreeRecord[];
  created: CreatedBranch | null;
  /** Named only in a `worktrees` row, without Switchboard naming or a created record: listed only when merged, never ticked. */
  readonly legacy: boolean;
}

const DAY_MS = 86_400_000;
const RECENT_UNASSIGNED_MS = DAY_MS;
const MAX_RUNS_KEPT = 10;

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function shortSha(oid: string): string {
  return oid.slice(0, 7);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function latest(times: readonly (string | null | undefined)[]): string | null {
  let best: number | null = null;
  for (const time of times) {
    if (!time) continue;
    const ms = Date.parse(time);
    if (Number.isFinite(ms) && (best === null || ms > best)) best = ms;
  }
  return best === null ? null : new Date(best).toISOString();
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function canonical(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    return path.resolve(file);
  }
}

/** `git status --porcelain=v1 -z` → the paths (a rename's new path). */
export function statusPaths(stdout: string): string[] {
  const parts = stdout.split('\0');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] as string;
    if (entry.length < 4) continue;
    const x = entry[0];
    out.push(entry.slice(3));
    if (x === 'R' || x === 'C') i++;
  }
  return out;
}

/**
 * D84 · Clean-up (`docs/cleanup.md`): scans what Switchboard created and no longer
 * needs (worktrees, local and remote branches, closed sessions, old attachments
 * and data files) and removes the items the developer ticked.
 *
 * Only Switchboard's own things are ever listed: worktrees in its `worktrees`
 * table; local branches recorded there (or in the created-branches record) with
 * Switchboard's naming (`session/…`, `todo/…`) or recorded as created by it;
 * remote branches it pushed (take-over leftovers, and the remote copies of its
 * own new branches); its own sessions and data folder. A scan changes nothing
 * and makes no network call (remote branches are read from the remote-tracking
 * refs of the last fetch).
 *
 * A run re-scans first and refuses an item whose preview no longer matches
 * (its fingerprint), so what runs is exactly what was shown. It never runs
 * `git gc`, never force-removes a worktree with uncommitted changes or deletes
 * an unmerged branch or a remote branch without the item's confirmation, and a
 * failed item affects nothing else. One run at a time.
 */
export class CleanupService {
  readonly #store: Store;
  readonly #dataDir: string;
  readonly #git: readonly string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => Date;
  readonly #isLive: (sessionId: string) => boolean;
  readonly #takeover: CleanupTakeover | null;
  readonly #gitTimeout: number;
  readonly #pushTimeout: number;
  readonly #sizeLimit: number;
  readonly #runs = new Map<string, CleanupRun>();
  #running: string | null = null;

  constructor(options: CleanupServiceOptions) {
    this.#store = options.store;
    this.#dataDir = path.resolve(options.dataDir);
    this.#git = options.gitCommand ?? ['git'];
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? (() => new Date());
    this.#isLive = options.isLive ?? (() => false);
    this.#takeover = options.takeover ?? null;
    this.#gitTimeout = options.gitTimeoutMs ?? 120_000;
    this.#pushTimeout = options.pushTimeoutMs ?? 60_000;
    this.#sizeLimit = options.sizeWalkLimit ?? 200_000;
  }

  // ── settings ────────────────────────────────────────────────────────

  /** The closed-session limit in days. */
  async closedSessionDays(): Promise<number> {
    return closedSessionDaysOf(await this.#store.settings.get(CLEANUP_SESSION_DAYS_SETTING));
  }

  /** Saves the closed-session limit (validated by the route). */
  async setClosedSessionDays(days: number): Promise<number> {
    await this.#store.settings.set(CLEANUP_SESSION_DAYS_SETTING, days);
    return days;
  }

  // ── scan ────────────────────────────────────────────────────────────

  /** The dry run: every item with what it would remove. Changes nothing. */
  async scan(): Promise<CleanupScan> {
    return (await this.#scan(true)).scan;
  }

  async #scan(sizes: boolean): Promise<ScanResult> {
    const now = this.#now();
    const notes: string[] = [];
    const planned = new Map<string, Planned>();
    const add = (entry: Planned): void => {
      planned.set(entry.item.id, entry);
    };
    const closedSessionDays = await this.closedSessionDays();
    const sessions = new Map<string, SessionRecord | null>();
    const sessionOf = async (id: string | null): Promise<SessionRecord | null> => {
      if (id === null) return null;
      if (!sessions.has(id)) sessions.set(id, await this.#store.sessions.get(id));
      return sessions.get(id) ?? null;
    };
    const stateOf = async (record: WorktreeRecord): Promise<SessionState> => {
      // A live row without a session for less than a day may be a start in progress (its session is assigned next).
      if (record.sessionId === null) return !record.removedAt && now.getTime() - Date.parse(record.createdAt) < RECENT_UNASSIGNED_MS ? 'unassigned' : 'gone';
      const session = await sessionOf(record.sessionId);
      if (!session) return 'gone';
      return session.closedAt !== null ? 'closed' : 'open';
    };

    const records = await this.#store.worktrees.list({ includeRemoved: true });
    const repos = new Map<string, RepoView>();
    const repoView = async (repoPath: string): Promise<RepoView> => {
      let view = repos.get(repoPath);
      if (!view) {
        view = await this.#repoView(repoPath);
        if (!view.ok) notes.push(`${repoPath}: not a git repository any more (its branches are not listed)`);
        repos.set(repoPath, view);
      }
      return view;
    };

    // 1. Worktrees.
    const listedWorktrees = new Set<string>();
    const worktreeState = new Map<string, { readonly missing: boolean }>();
    for (const record of records) {
      if (record.removedAt) continue;
      const missing = !(await isDirectory(record.path));
      worktreeState.set(record.id, { missing });
      const state = await stateOf(record);
      if (state === 'unassigned') continue;
      if (record.sessionId !== null && this.#isLive(record.sessionId)) continue;
      const session = await sessionOf(record.sessionId);
      const sessionReason: CleanupReason[] = state === 'closed' ? ['session-closed'] : state === 'gone' ? ['session-gone'] : [];
      const subtitle = `${record.repo} · ${record.branch}${session ? ` · ${session.title ?? session.name}` : ''}`;
      if (missing) {
        const view = await repoView(record.repoPath);
        const removes = [`the record of ${record.path} (the folder is already gone)`];
        if (view.ok && view.listed.has(record.path)) removes.push(`git's entry for ${record.path} in ${record.repoPath}`);
        const item = this.#item({
          id: `wt:${record.id}`,
          group: 'worktrees',
          title: record.path,
          subtitle,
          reasons: ['folder-missing', ...sessionReason],
          sizeBytes: 0,
          sizeCapped: false,
          lastChangeAt: latest([record.updatedAt, session?.lastActivityAt, session?.closedAt]),
          removes,
          keeps: [`the branch ${record.branch}`],
          warnings: [],
          confirm: null,
          selected: true,
        });
        add({ item, action: { kind: 'worktree', record, missing: true, uncommitted: [] } });
        listedWorktrees.add(record.id);
        continue;
      }
      const status = await this.#runGit(record.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      if (!succeeded(status)) {
        notes.push(`${record.path}: git status failed (${failureText(status)})`);
        continue;
      }
      const uncommitted = statusPaths(status.stdout);
      const prMerged = record.prState === 'MERGED';
      const base = record.baseRef ? await this.#resolve(record.path, record.baseRef) : null;
      const ancestor = base !== null && (await this.#isAncestor(record.path, 'HEAD', base));
      // An open session's worktree goes only once its PR is merged (a new worktree is trivially "merged" into its base).
      const merged = prMerged || (ancestor && state !== 'open');
      const commitAt = await this.#commitTime(record.path, 'HEAD');
      const fileTimes = await this.#mtimes(record.path, uncommitted.slice(0, CLEANUP_FILES_MAX));
      const lastChangeAt = latest([commitAt, record.createdAt, session?.lastActivityAt, session?.closedAt, ...fileTimes]);
      const stale = (state === 'closed' || state === 'gone') && lastChangeAt !== null && now.getTime() - Date.parse(lastChangeAt) >= STALE_WORKTREE_DAYS * DAY_MS;
      if (!merged && !stale) continue;
      const reasons: CleanupReason[] = [];
      if (prMerged) reasons.push('pr-merged');
      else if (merged) reasons.push('merged');
      if (stale) reasons.push('stale');
      reasons.push(...sessionReason);
      const warnings: CleanupWarning[] =
        uncommitted.length > 0
          ? [{ kind: 'uncommitted', message: `${plural(uncommitted.length, 'uncommitted change')} would be lost`, files: uncommitted.slice(0, CLEANUP_FILES_MAX) }]
          : [];
      const size = sizes ? await this.#size(record.path) : { bytes: 0, capped: false };
      const item = this.#item({
        id: `wt:${record.id}`,
        group: 'worktrees',
        title: record.path,
        subtitle,
        reasons,
        sizeBytes: sizes ? size.bytes : null,
        sizeCapped: size.capped,
        lastChangeAt,
        removes: [`the folder ${record.path} (git worktree remove${uncommitted.length > 0 ? ' --force, after your confirmation' : ''})`],
        keeps: [`the branch ${record.branch} and its commits`],
        warnings,
        confirm: uncommitted.length > 0 ? 'uncommitted' : null,
        selected: uncommitted.length === 0,
        extra: [base ?? '', String(ancestor), String(prMerged)],
      });
      add({ item, action: { kind: 'worktree', record, missing: false, uncommitted } });
      listedWorktrees.add(record.id);
    }

    // 2–3. Local and remote branches Switchboard made.
    const created = await createdBranches(this.#store.settings);
    const candidates = new Map<string, BranchCandidate>();
    const keyOf = (repoPath: string, branch: string): string => `${repoPath}\0${branch}`;
    const createdKeys = new Map(created.map((entry) => [keyOf(entry.repoPath, entry.branch), entry]));
    for (const record of records) {
      const key = keyOf(record.repoPath, record.branch);
      // D84 ruling (2026-10-08): a branch with neither Switchboard naming nor a created record (e.g. a ticket-named
      // task branch from before the record existed) is a legacy candidate: listed only when merged, never ticked.
      const legacy = !hasSwitchboardBranchName(record.branch) && !createdKeys.has(key);
      const candidate = candidates.get(key) ?? { repoPath: record.repoPath, branch: record.branch, records: [], created: createdKeys.get(key) ?? null, legacy };
      candidate.records.push(record);
      candidates.set(key, candidate);
    }
    for (const entry of created) {
      const key = keyOf(entry.repoPath, entry.branch);
      if (!candidates.has(key)) candidates.set(key, { repoPath: entry.repoPath, branch: entry.branch, records: [], created: entry, legacy: false });
    }
    const remoteRefs = new Map<string, Map<string, string>>();
    const remoteUrls = new Map<string, string>();
    for (const candidate of [...candidates.values()].sort((a, b) => a.repoPath.localeCompare(b.repoPath) || a.branch.localeCompare(b.branch))) {
      const view = await repoView(candidate.repoPath);
      if (!view.ok) continue;
      const repoPath = candidate.repoPath;
      const repoName = path.basename(repoPath);
      const ordered = [...candidate.records].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const newest = ordered.at(-1) ?? null;
      const baseRef = newest?.baseRef ?? null;
      const base = baseRef ? await this.#resolve(repoPath, baseRef) : null;
      const prMerged = candidate.records.some((record) => record.prState === 'MERGED');
      const states = await Promise.all(candidate.records.map((record) => stateOf(record)));
      if (states.includes('unassigned')) continue;
      if (candidate.records.some((record) => record.sessionId !== null && !record.removedAt && this.#isLive(record.sessionId))) continue;
      const liveRecords = candidate.records.filter((record) => !record.removedAt && !(worktreeState.get(record.id)?.missing ?? false));
      const worktreeGone = liveRecords.length === 0;
      const sessionsDone = states.length > 0 && states.every((state) => state === 'closed' || state === 'gone');
      const sessionReasons: CleanupReason[] = sessionsDone ? [states.includes('closed') ? 'session-closed' : 'session-gone'] : [];
      const sessionNames = (await Promise.all(candidate.records.map((record) => sessionOf(record.sessionId)))).flatMap((session) => (session ? [session.title ?? session.name] : []));
      const subtitle = [repoName, ...new Set(sessionNames)].join(' · ');

      // Local branch.
      const oid = await this.#resolve(repoPath, `refs/heads/${candidate.branch}`);
      if (oid !== null) {
        const where = view.checkedOut.get(candidate.branch) ?? [];
        const blockedBy = where.filter((dir) => !candidate.records.some((record) => listedWorktrees.has(record.id) && record.path === dir));
        const inMain = view.main !== null && where.includes(view.main);
        if (!inMain && blockedBy.length === 0) {
          const ancestor = base !== null && (await this.#isAncestor(repoPath, oid, base));
          const onRemotes = (await this.#count(repoPath, [oid, '--not', '--remotes'])) === 0;
          const merged = ancestor || (prMerged && onRemotes);
          if (candidate.legacy ? merged : merged || worktreeGone || sessionsDone) {
            const reasons: CleanupReason[] = [];
            if (ancestor) reasons.push('merged');
            else if (merged) reasons.push('pr-merged');
            if (worktreeGone) reasons.push('worktree-gone');
            reasons.push(...sessionReasons);
            if (candidate.legacy) reasons.push('untracked-origin');
            const warnings: CleanupWarning[] = [];
            if (!merged) {
              const ahead = base !== null ? await this.#count(repoPath, [`${base}..${oid}`]) : null;
              const unpushed = await this.#count(repoPath, [oid, '--not', '--remotes']);
              const parts = [ahead !== null ? `${plural(ahead, 'commit')} not in ${baseRef}` : 'its base is unknown'];
              if (unpushed !== null) parts.push(unpushed === 0 ? 'all on a remote' : `${plural(unpushed, 'commit')} on no remote`);
              warnings.push({ kind: 'unmerged', message: `Not merged: ${parts.join('; ')}`, files: [] });
            }
            const after = where.length > 0 ? ` (after its worktree ${where.join(', ')}: tick that too)` : '';
            const item = this.#item({
              id: `lb:${sha(keyOf(repoPath, candidate.branch)).slice(0, 24)}`,
              group: 'localBranches',
              title: candidate.branch,
              subtitle,
              reasons,
              sizeBytes: null,
              sizeCapped: false,
              lastChangeAt: latest([await this.#commitTime(repoPath, oid), ...candidate.records.map((record) => record.updatedAt)]),
              removes: [`${repoPath}: the branch ${candidate.branch} at ${shortSha(oid)}${after}`],
              keeps: [],
              warnings,
              confirm: merged ? null : 'unmerged',
              // Ticked when merged and every worktree holding it goes by default too (the run removes worktrees first).
              selected: !candidate.legacy && merged && where.every((dir) => candidate.records.some((record) => record.path === dir && planned.get(`wt:${record.id}`)?.item.selected === true)),
              extra: [oid, base ?? ''],
            });
            add({ item, action: { kind: 'local-branch', repoPath, branch: candidate.branch, oid } });
          }
        }
      }

      // Remote copies: only of branches that were new (a tracked origin branch was not pushed by Switchboard).
      // Legacy candidates have no remote copy Switchboard is known to have pushed.
      if (candidate.legacy || (!hasSwitchboardBranchName(candidate.branch) && candidate.created?.kind !== 'new')) continue;
      if (candidate.created?.kind === 'tracking') continue;
      let refs = remoteRefs.get(repoPath);
      if (!refs) {
        refs = await this.#remoteRefs(repoPath);
        remoteRefs.set(repoPath, refs);
      }
      for (const [ref, remoteOid] of refs) {
        const match = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref);
        if (!match || match[2] !== candidate.branch) continue;
        const remote = match[1] as string;
        const ancestor = base !== null && (await this.#isAncestor(repoPath, remoteOid, base));
        if (!(ancestor || prMerged || worktreeGone || sessionsDone)) continue;
        const urlKey = `${repoPath}\0${remote}`;
        if (!remoteUrls.has(urlKey)) {
          const url = await this.#runGit(repoPath, ['remote', 'get-url', remote]);
          remoteUrls.set(urlKey, succeeded(url) ? redactUrl(url.stdout.trim()) : remote);
        }
        const url = remoteUrls.get(urlKey) as string;
        const reasons: CleanupReason[] = [];
        if (ancestor) reasons.push('merged');
        else if (prMerged) reasons.push('pr-merged');
        if (worktreeGone) reasons.push('worktree-gone');
        reasons.push(...sessionReasons);
        const item = this.#item({
          id: `rb:${sha(`${repoPath}\0${remote}\0${candidate.branch}`).slice(0, 24)}`,
          group: 'remoteBranches',
          title: `${remote}/${candidate.branch}`,
          subtitle: `${subtitle} · ${url}`,
          reasons,
          sizeBytes: null,
          sizeCapped: false,
          lastChangeAt: await this.#commitTime(repoPath, remoteOid),
          removes: [`${url}: the branch ${candidate.branch} at ${shortSha(remoteOid)} (git push --delete; as of the last fetch)`],
          keeps: [],
          warnings: [{ kind: 'remote', message: `Deleted on ${remote} for everyone who uses it${ancestor || prMerged ? '' : ' (not merged)'}`, files: [] }],
          confirm: 'remote',
          selected: false,
          extra: [remoteOid],
        });
        add({ item, action: { kind: 'remote-branch', repoPath, remote, branch: candidate.branch, oid: remoteOid } });
      }
    }
    // Take-over leftovers (D65): temporary branches this machine pushed and could not delete.
    if (this.#takeover) {
      try {
        for (const leftover of await this.#takeover.listLeftovers()) {
          const item = this.#item({
            id: `rb-leftover:${leftover.id}`,
            group: 'remoteBranches',
            title: `${leftover.remoteName}/${leftover.branch}`,
            subtitle: `${path.basename(leftover.repoPath)} · ${leftover.remoteUrl}`,
            reasons: ['takeover-leftover'],
            sizeBytes: null,
            sizeCapped: false,
            lastChangeAt: leftover.at,
            removes: [`${leftover.remoteUrl}: the branch ${leftover.branch} (git push --delete)`],
            keeps: [],
            warnings: [{ kind: 'remote', message: `Deleted on ${leftover.remoteName}${leftover.reason ? ` (left because: ${leftover.reason})` : ''}`, files: [] }],
            confirm: 'remote',
            selected: false,
          });
          add({ item, action: { kind: 'leftover', leftoverId: leftover.id } });
        }
      } catch (error) {
        notes.push(`take-over leftovers could not be read (${errorText(error)})`);
      }
    }

    // 4. Closed sessions older than the limit.
    const cutoff = now.getTime() - closedSessionDays * DAY_MS;
    for (const session of await this.#store.sessions.list({ closed: true })) {
      if (session.closedAt === null || Date.parse(session.closedAt) > cutoff || this.#isLive(session.id)) continue;
      const counts = this.#sessionCounts(session.id);
      const folders = [path.join(this.#dataDir, ATTACHMENTS_DIR, session.id), path.join(this.#dataDir, 'handovers', session.id)];
      const present: string[] = [];
      let bytes = counts.eventBytes;
      let capped = false;
      for (const folder of folders) {
        if (!(await exists(folder))) continue;
        present.push(folder);
        if (sizes) {
          const size = await this.#size(folder);
          bytes += size.bytes;
          capped ||= size.capped;
        }
      }
      const holds = [plural(counts.events, 'event'), plural(counts.todos, 'todo'), plural(counts.attachments, 'attachment')];
      const item = this.#item({
        id: `ses:${session.id}`,
        group: 'sessions',
        title: session.title ?? session.name,
        subtitle: `${session.name} · closed ${session.closedAt.slice(0, 10)}`,
        reasons: ['closed-long-ago'],
        sizeBytes: sizes ? bytes : null,
        sizeCapped: capped,
        lastChangeAt: latest([session.closedAt, session.lastActivityAt]),
        removes: [`the session record ${session.name} with ${holds.join(', ')}`, ...present],
        keeps: ['its worktrees and branches (listed above when they can go)', "the CLI's own transcript"],
        warnings: [],
        confirm: null,
        selected: true,
        extra: [session.closedAt],
      });
      add({ item, action: { kind: 'session', sessionId: session.id, paths: present } });
    }

    // 5. Attachments past retention, orphaned files, old exports and staging folders.
    for (const entry of await this.#dataItems(now, sizes)) add(entry);

    const items = inRunOrder([...planned.values()].map((entry) => entry.item));
    return { scan: { scannedAt: now.toISOString(), closedSessionDays, staleDays: STALE_WORKTREE_DAYS, items, notes }, planned };
  }

  async #dataItems(now: Date, sizes: boolean): Promise<Planned[]> {
    const out: Planned[] = [];
    const root = path.join(this.#dataDir, ATTACHMENTS_DIR);
    const retentionMs = ATTACHMENT_RETENTION_DAYS * DAY_MS;
    const cutoff = new Date(now.getTime() - retentionMs).toISOString();
    const old = await this.#store.attachments.olderThan(cutoff);
    const byFolder = new Map<string, AttachmentRecord[]>();
    for (const record of old) {
      const folder = record.sessionId ?? STAGED_DIR;
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), record]);
    }
    for (const [folder, rows] of [...byFolder].sort(([a], [b]) => a.localeCompare(b))) {
      const paths = rows.map((record) => path.join(root, folder, record.file));
      const session = folder === STAGED_DIR ? null : await this.#store.sessions.get(folder);
      out.push({
        item: this.#item({
          id: `att:${folder}`,
          group: 'data',
          title: `${plural(rows.length, 'attachment')} older than ${ATTACHMENT_RETENTION_DAYS} days`,
          subtitle: folder === STAGED_DIR ? 'staged uploads (never sent)' : session ? (session.title ?? session.name) : folder,
          reasons: ['past-retention'],
          sizeBytes: rows.reduce((sum, record) => sum + record.size, 0),
          sizeCapped: false,
          lastChangeAt: latest(rows.map((record) => record.createdAt)),
          removes: paths,
          keeps: [],
          warnings: [],
          confirm: null,
          selected: true,
          extra: rows.map((record) => record.id),
        }),
        action: { kind: 'attachments', rows, paths },
      });
    }
    // Files no row owns and folders of sessions that no longer exist.
    const owned = new Map<string, Set<string>>();
    for (const record of await this.#store.attachments.list()) {
      const key = record.sessionId ?? STAGED_DIR;
      const files = owned.get(key) ?? new Set<string>();
      files.add(record.file);
      owned.set(key, files);
    }
    let folders: string[] = [];
    try {
      folders = (await readdir(root)).sort();
    } catch {
      folders = [];
    }
    for (const folder of folders) {
      const full = path.join(root, folder);
      const known = folder === STAGED_DIR || owned.has(folder) || (await this.#store.sessions.get(folder)) !== null;
      if (!known) {
        const size = sizes ? await this.#size(full) : { bytes: 0, capped: false };
        out.push(this.#pathsItem('orphan', full, `attachments/${folder}`, 'a folder of a session that no longer exists', ['orphaned'], [full], sizes ? size.bytes : null, size.capped, null));
        continue;
      }
      let entries: string[];
      try {
        entries = (await readdir(full)).sort();
      } catch {
        continue;
      }
      const files = owned.get(folder);
      // Files a row owns (past retention or not) are not stray: the rows above cover the old ones.
      const strayOld = entries.filter((entry) => !files?.has(entry)).map((entry) => path.join(full, entry));
      if (strayOld.length === 0) continue;
      let bytes = 0;
      let capped = false;
      if (sizes) {
        for (const file of strayOld) {
          const size = await this.#size(file);
          bytes += size.bytes;
          capped ||= size.capped;
        }
      }
      out.push(this.#pathsItem('orphan', full, `${plural(strayOld.length, 'file')} in attachments/${folder}`, 'no attachment refers to them', ['orphaned'], strayOld, sizes ? bytes : null, capped, null));
    }
    // Chat exports (`<dataDir>/handovers/<entry>`) past the same retention.
    const handovers = path.join(this.#dataDir, 'handovers');
    for (const entry of await this.#entries(handovers)) {
      const full = path.join(handovers, entry);
      const newest = await this.#newestTime(full);
      if (newest === null || now.getTime() - Date.parse(newest) < retentionMs) continue;
      const size = sizes ? await this.#size(full) : { bytes: 0, capped: false };
      out.push(this.#pathsItem('handover', full, `handovers/${entry}`, 'an exported chat handed to an agent', ['past-retention'], [full], sizes ? size.bytes : null, size.capped, newest));
    }
    // Take-over staging folders (`<dataDir>/takeover/<op>`) of no running operation.
    const staging = path.join(this.#dataDir, 'takeover');
    for (const entry of await this.#entries(staging)) {
      if (this.#takeover?.hasTarget(entry)) continue;
      const full = path.join(staging, entry);
      const newest = await this.#newestTime(full);
      if (newest === null || now.getTime() - Date.parse(newest) < TAKEOVER_STAGING_DAYS * DAY_MS) continue;
      const size = sizes ? await this.#size(full) : { bytes: 0, capped: false };
      out.push(this.#pathsItem('staging', full, `takeover/${entry}`, 'a take-over staging folder no operation uses', ['orphaned'], [full], sizes ? size.bytes : null, size.capped, newest));
    }
    return out;
  }

  #pathsItem(
    prefix: string,
    key: string,
    title: string,
    subtitle: string,
    reasons: CleanupReason[],
    paths: string[],
    sizeBytes: number | null,
    sizeCapped: boolean,
    lastChangeAt: string | null,
  ): Planned {
    return {
      item: this.#item({ id: `${prefix}:${sha(key).slice(0, 24)}`, group: 'data', title, subtitle, reasons, sizeBytes, sizeCapped, lastChangeAt, removes: paths, keeps: [], warnings: [], confirm: null, selected: true }),
      action: { kind: 'paths', paths },
    };
  }

  #item(input: Omit<CleanupItem, 'fingerprint'> & { readonly extra?: readonly string[] }): CleanupItem {
    const { extra = [], ...item } = input;
    const fingerprint = sha(JSON.stringify([item.id, item.removes, item.warnings.map((warning) => [warning.kind, warning.files]), item.confirm, extra])).slice(0, 16);
    return { ...item, fingerprint };
  }

  // ── run ─────────────────────────────────────────────────────────────

  /**
   * Starts removing the ticked items (in group order). Re-scans first: an item
   * no longer listed, or whose fingerprint moved, fails without being touched.
   * Refused as a whole (422 `confirmation-required`) when a ticked item needs a
   * confirmation the request does not carry, and 409 `busy` while a run is going.
   */
  async start(request: CleanupRunRequest): Promise<CleanupRun> {
    if (this.#running !== null) throw new CleanupError(409, 'busy', 'a clean-up is already running');
    this.#running = 'starting';
    let fresh: ScanResult;
    try {
      fresh = await this.#scan(false);
    } catch (error) {
      this.#running = null;
      throw error;
    }
    const missing = missingConfirmations(fresh.scan.items, request.items);
    if (missing.length > 0) {
      this.#running = null;
      throw new CleanupError(422, 'confirmation-required', `confirm before removing: ${missing.map((item) => item.title).join(', ')}`, missing.map((item) => item.id));
    }
    const sizeOf = new Map<string, number | null>();
    const id = randomUUID();
    const order = new Map<string, number>(fresh.scan.items.map((item, index) => [item.id, index]));
    const picked = [...request.items].sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    const items: CleanupRunItem[] = picked.map((selection) => {
      const entry = fresh.planned.get(selection.id);
      sizeOf.set(selection.id, null);
      return { id: selection.id, group: entry?.item.group ?? groupOfId(selection.id), title: entry?.item.title ?? selection.id, status: 'pending', error: null, sizeBytes: null };
    });
    const run: CleanupRun = { id, startedAt: this.#now().toISOString(), finishedAt: null, items, summary: { done: 0, failed: 0, freedBytes: 0 } };
    this.#runs.set(id, run);
    while (this.#runs.size > MAX_RUNS_KEPT) this.#runs.delete(this.#runs.keys().next().value as string);
    this.#running = id;
    void this.#execute(id, picked, fresh).finally(() => {
      this.#running = null;
    });
    return run;
  }

  /** A run as it stands (`null` when unknown). */
  get(runId: string): CleanupRun | null {
    return this.#runs.get(runId) ?? null;
  }

  /** Waits for the current run (tests). */
  async idle(): Promise<void> {
    while (this.#running !== null) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async #execute(runId: string, picked: readonly { readonly id: string; readonly fingerprint: string; readonly confirm?: CleanupConfirm }[], fresh: ScanResult): Promise<void> {
    const update = (index: number, patch: Partial<CleanupRunItem>): void => {
      const run = this.#runs.get(runId);
      if (!run) return;
      const items = run.items.map((item, i) => (i === index ? { ...item, ...patch } : item));
      const done = items.filter((item) => item.status === 'done');
      this.#runs.set(runId, {
        ...run,
        items,
        summary: { done: done.length, failed: items.filter((item) => item.status === 'failed').length, freedBytes: done.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0) },
      });
    };
    for (const [index, selection] of picked.entries()) {
      update(index, { status: 'running' });
      const entry = fresh.planned.get(selection.id);
      if (!entry) {
        update(index, { status: 'failed', error: 'no longer listed: scan again' });
        continue;
      }
      if (entry.item.fingerprint !== selection.fingerprint) {
        update(index, { status: 'failed', error: 'changed since the preview: scan again' });
        continue;
      }
      try {
        const sizeBytes = await this.#sizeBeforeRemoval(entry);
        await this.#perform(entry.action, selection.confirm ?? null);
        update(index, { status: 'done', sizeBytes });
      } catch (error) {
        update(index, { status: 'failed', error: errorText(error) });
      }
    }
    const run = this.#runs.get(runId);
    if (run) this.#runs.set(runId, { ...run, finishedAt: this.#now().toISOString() });
  }

  /** What an item frees, measured just before it goes (the run's scan skips the walk). */
  async #sizeBeforeRemoval(entry: Planned): Promise<number | null> {
    const action = entry.action;
    switch (action.kind) {
      case 'worktree':
        return action.missing ? 0 : (await this.#size(action.record.path)).bytes;
      case 'session': {
        let bytes = this.#sessionCounts(action.sessionId).eventBytes;
        for (const folder of action.paths) bytes += (await this.#size(folder)).bytes;
        return bytes;
      }
      case 'attachments':
        return action.rows.reduce((sum, record) => sum + record.size, 0);
      case 'paths': {
        let bytes = 0;
        for (const file of action.paths) bytes += (await this.#size(file)).bytes;
        return bytes;
      }
      default:
        return null;
    }
  }

  async #perform(action: Action, confirm: CleanupConfirm | null): Promise<void> {
    switch (action.kind) {
      case 'worktree':
        return this.#removeWorktree(action, confirm);
      case 'local-branch':
        return this.#deleteLocalBranch(action);
      case 'remote-branch':
        return this.#deleteRemoteBranch(action, confirm);
      case 'leftover':
        if (confirm !== 'remote') throw new Error('a remote branch is deleted only when you confirm it');
        if (!this.#takeover) throw new Error('take-over is not available');
        await this.#takeover.deleteLeftover(action.leftoverId);
        return;
      case 'session':
        return this.#deleteSession(action);
      case 'attachments':
        for (const file of action.paths) this.#assertInData(file);
        for (const [index, record] of action.rows.entries()) {
          await rm(action.paths[index] as string, { force: true });
          await this.#store.attachments.delete(record.id);
        }
        return;
      case 'paths':
        for (const file of action.paths) this.#assertInData(file);
        for (const file of action.paths) await rm(file, { recursive: true, force: true });
        return;
    }
  }

  async #removeWorktree(action: Extract<Action, { kind: 'worktree' }>, confirm: CleanupConfirm | null): Promise<void> {
    const { record } = action;
    const current = await this.#store.worktrees.get(record.id);
    if (!current || current.removedAt) throw new Error('already removed');
    if (record.sessionId !== null && this.#isLive(record.sessionId)) throw new Error('its session is running now');
    if (action.missing) {
      if (await isDirectory(record.path)) throw new Error('the folder is back: scan again');
      const view = await this.#repoView(record.repoPath);
      if (view.ok && view.listed.has(record.path)) {
        const removed = await this.#runGit(record.repoPath, ['worktree', 'remove', record.path]);
        if (!succeeded(removed)) throw new Error(`git worktree remove failed: ${failureText(removed)}`);
      }
      await this.#store.worktrees.markRemoved(record.id);
      return;
    }
    const status = await this.#runGit(record.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!succeeded(status)) throw new Error(`git status failed: ${failureText(status)}`);
    const now = statusPaths(status.stdout);
    let force = false;
    if (now.length > 0) {
      if (confirm !== 'uncommitted') throw new Error(`${plural(now.length, 'uncommitted change')}: not removed without your confirmation`);
      const confirmed = new Set(action.uncommitted);
      const extra = now.filter((file) => !confirmed.has(file));
      if (extra.length > 0) throw new Error(`changes you did not confirm appeared (${extra.slice(0, 3).join(', ')}): scan again`);
      force = true;
    }
    const removed = await this.#runGit(record.repoPath, force ? ['worktree', 'remove', '--force', record.path] : ['worktree', 'remove', record.path]);
    if (!succeeded(removed)) throw new Error(`git worktree remove failed: ${failureText(removed)}`);
    await this.#store.worktrees.markRemoved(record.id);
  }

  async #deleteLocalBranch(action: Extract<Action, { kind: 'local-branch' }>): Promise<void> {
    const view = await this.#repoView(action.repoPath);
    if (!view.ok) throw new Error(`${action.repoPath} cannot be read`);
    const where = view.checkedOut.get(action.branch) ?? [];
    if (where.length > 0) throw new Error(`checked out at ${where.join(', ')}`);
    const oid = await this.#resolve(action.repoPath, `refs/heads/${action.branch}`);
    if (oid === null) throw new Error('the branch is already gone');
    if (oid !== action.oid) throw new Error(`the branch moved since the preview (now ${shortSha(oid)}): scan again`);
    // The expected value makes git refuse if it moved in between.
    const deleted = await this.#runGit(action.repoPath, ['update-ref', '-d', `refs/heads/${action.branch}`, action.oid]);
    if (!succeeded(deleted)) throw new Error(`git update-ref failed: ${failureText(deleted)}`);
    await this.#runGit(action.repoPath, ['config', '--remove-section', `branch.${action.branch}`]);
    await forgetCreatedBranch(this.#store.settings, action.repoPath, action.branch);
  }

  async #deleteRemoteBranch(action: Extract<Action, { kind: 'remote-branch' }>, confirm: CleanupConfirm | null): Promise<void> {
    if (confirm !== 'remote') throw new Error('a remote branch is deleted only when you confirm it');
    // The lease makes the remote refuse when its branch is not where the preview saw it.
    const pushed = await this.#runGit(
      action.repoPath,
      ['push', '--porcelain', `--force-with-lease=refs/heads/${action.branch}:${action.oid}`, action.remote, `:refs/heads/${action.branch}`],
      this.#pushTimeout,
    );
    if (!succeeded(pushed)) throw new Error(`git push --delete failed: ${failureText(pushed)}`);
  }

  async #deleteSession(action: Extract<Action, { kind: 'session' }>): Promise<void> {
    const session = await this.#store.sessions.get(action.sessionId);
    if (!session) throw new Error('already deleted');
    if (session.closedAt === null) throw new Error('it was reopened');
    if (this.#isLive(session.id)) throw new Error('it is running');
    for (const folder of action.paths) this.#assertInData(folder);
    for (const folder of action.paths) await rm(folder, { recursive: true, force: true });
    await this.#store.sessions.delete(session.id);
  }

  #assertInData(file: string): void {
    const resolved = path.resolve(file);
    const inside = ['attachments', 'handovers', 'takeover'].some((dir) => resolved.startsWith(path.join(this.#dataDir, dir) + path.sep));
    if (!inside) throw new Error(`refusing to remove ${file}: not in Switchboard's data folder`);
  }

  // ── git and files ───────────────────────────────────────────────────

  async #repoView(repoPath: string): Promise<RepoView> {
    const empty: RepoView = { ok: false, main: null, checkedOut: new Map(), listed: new Set() };
    if (!(await isDirectory(repoPath))) return empty;
    const listed = await this.#runGit(repoPath, ['worktree', 'list', '--porcelain']);
    if (!succeeded(listed)) return empty;
    const entries = parseWorktreeList(listed.stdout);
    const checkedOut = new Map<string, string[]>();
    const paths = new Set<string>();
    let main: string | null = null;
    for (const [index, entry] of entries.entries()) {
      const dir = await canonical(entry.path);
      paths.add(dir);
      paths.add(entry.path);
      if (index === 0) main = dir;
      if (entry.branch) checkedOut.set(entry.branch, [...(checkedOut.get(entry.branch) ?? []), dir]);
    }
    return { ok: true, main, checkedOut, listed: paths };
  }

  async #remoteRefs(repoPath: string): Promise<Map<string, string>> {
    const listed = await this.#runGit(repoPath, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes']);
    const out = new Map<string, string>();
    if (!succeeded(listed)) return out;
    for (const line of listed.stdout.split('\n')) {
      const [ref, oid] = line.trim().split(' ');
      if (ref && oid && !ref.endsWith('/HEAD')) out.set(ref, oid);
    }
    return out;
  }

  async #resolve(cwd: string, ref: string): Promise<string | null> {
    const result = await this.#runGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const oid = result.stdout.trim();
    return succeeded(result) && oid !== '' ? oid : null;
  }

  async #isAncestor(cwd: string, commit: string, base: string): Promise<boolean> {
    return (await this.#runGit(cwd, ['merge-base', '--is-ancestor', commit, base])).code === 0;
  }

  async #count(cwd: string, revs: readonly string[]): Promise<number | null> {
    const result = await this.#runGit(cwd, ['rev-list', '--count', ...revs, '--']);
    const n = Number.parseInt(result.stdout.trim(), 10);
    return succeeded(result) && Number.isFinite(n) ? n : null;
  }

  async #commitTime(cwd: string, rev: string): Promise<string | null> {
    const result = await this.#runGit(cwd, ['log', '-1', '--format=%cI', rev, '--']);
    const text = result.stdout.trim();
    return succeeded(result) && text !== '' && Number.isFinite(Date.parse(text)) ? new Date(Date.parse(text)).toISOString() : null;
  }

  async #mtimes(dir: string, files: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const file of files) {
      try {
        out.push((await lstat(path.join(dir, file))).mtime.toISOString());
      } catch {
        // deleted files have no time
      }
    }
    return out;
  }

  async #entries(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir)).sort();
    } catch {
      return [];
    }
  }

  /** The newest modification time under `file` (itself included), bounded by the walk limit. */
  async #newestTime(file: string): Promise<string | null> {
    let newest: number | null = null;
    let visited = 0;
    const stack = [file];
    while (stack.length > 0 && visited < this.#sizeLimit) {
      const current = stack.pop() as string;
      visited++;
      try {
        const info = await lstat(current);
        newest = Math.max(newest ?? 0, info.mtimeMs);
        if (info.isDirectory()) for (const entry of await readdir(current)) stack.push(path.join(current, entry));
      } catch {
        // gone meanwhile
      }
    }
    return newest === null ? null : new Date(newest).toISOString();
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
        if (info.isDirectory()) {
          for (const entry of await readdir(current)) stack.push(path.join(current, entry));
        } else {
          bytes += info.size;
        }
      } catch {
        // gone meanwhile
      }
    }
    return { bytes, capped: false };
  }

  #sessionCounts(sessionId: string): { readonly events: number; readonly eventBytes: number; readonly todos: number; readonly attachments: number } {
    const db = this.#store.db;
    const events = db.prepare('SELECT count(*) AS n, coalesce(sum(length(payload)), 0) + coalesce(sum(length(label)), 0) AS b FROM events WHERE session_id = ?').get(sessionId) as { n: number; b: number } | undefined;
    const todos = db.prepare('SELECT count(*) AS n FROM session_todos WHERE session_id = ?').get(sessionId) as { n: number } | undefined;
    const attachments = db.prepare('SELECT count(*) AS n FROM attachments WHERE session_id = ?').get(sessionId) as { n: number } | undefined;
    return { events: Number(events?.n ?? 0), eventBytes: Number(events?.b ?? 0), todos: Number(todos?.n ?? 0), attachments: Number(attachments?.n ?? 0) };
  }

  #runGit(cwd: string, args: readonly string[], timeoutMs: number = this.#gitTimeout): Promise<RunResult> {
    return runCommand(this.#git, args, { cwd, env: { ...this.#env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, timeoutMs });
  }
}

function groupOfId(id: string): CleanupGroup {
  if (id.startsWith('wt:')) return 'worktrees';
  if (id.startsWith('lb:')) return 'localBranches';
  if (id.startsWith('rb')) return 'remoteBranches';
  if (id.startsWith('ses:')) return 'sessions';
  return 'data';
}
