/**
 * D191 (`docs/worktrees.md` → *Stray worktrees*): worktrees and leftovers no open agent uses, found
 * in the repositories Switchboard knows on this computer, and offered for a clean-up once no agent
 * has run for a while. The shapes the server answers (`GET /api/cleanup/strays`) and the pure
 * rules the server and the web share: which items are safe (ticked by default), the notice's words,
 * when the idle notice is due.
 */

/** What a stray item is. */
export type StrayKind =
  /** A worktree Claude Code made for one of its own helpers (`<repo>/.claude/worktrees/…`). */
  | 'claude-subagent'
  /** A worktree Switchboard made (a `worktrees` row) whose agent is archived or gone. */
  | 'switchboard'
  /** Any other worktree (made by hand, `.worktrees/…`, another tool). */
  | 'other'
  /** A worktree git still lists whose folder is gone (`git worktree prune` removes it). */
  | 'stale-record'
  /** A branch of a worktree that is gone (Claude Code's `worktree-agent-…`, or one Switchboard made). */
  | 'branch'
  /** A temporary folder Switchboard left in its data folder (older than a day). */
  | 'temp';

/** One stray item. */
export interface StrayItem {
  /** Stable while the item is the same (its kind and where it is). */
  readonly id: string;
  readonly kind: StrayKind;
  /** The repository's main checkout (`null` for a temp folder). */
  readonly repo: string | null;
  /** The folder (a worktree, a temp folder); `null` for a branch. */
  readonly path: string | null;
  /** The branch (a worktree's, or the leftover branch); `null` when detached or none. */
  readonly branch: string | null;
  /** The branch's or worktree's tip commit, when known. */
  readonly head: string | null;
  /** Bytes on disk (`null` when not measured: a branch, a stale record). */
  readonly bytes: number | null;
  /** `true` when the size walk stopped at its limit (`bytes` is a lower bound). */
  readonly bytesCapped: boolean;
  /** Changed or new files in the worktree (`null` when not read); at most {@link STRAY_STATUS_CAP}. */
  readonly uncommitted: number | null;
  /** Commits on it that are on no other branch and no remote (`null` when not known). */
  readonly uniqueCommits: number | null;
  /** The folder's last change (ISO), when known. */
  readonly modifiedAt: string | null;
}

/** What `GET /api/cleanup/strays` answers. */
export interface StrayScan {
  readonly items: readonly StrayItem[];
  /** Repositories looked at. */
  readonly repos: number;
  /** Worktrees left alone because an open agent uses them (or an agent works in their repository). */
  readonly inUse: number;
  /** Repositories that could not be read (path → why). */
  readonly errors: readonly { readonly repo: string; readonly message: string }[];
  readonly scannedAt: string;
}

/** `POST /api/cleanup/strays/clean`: the ticked items; `force` = risky ones too (confirmed in the dialog). */
export interface StrayCleanRequest {
  readonly ids: readonly string[];
  readonly force: boolean;
}

/** One item's outcome. */
export interface StrayCleanOutcome {
  readonly id: string;
  readonly result: 'removed' | 'skipped' | 'failed';
  readonly message: string | null;
}

/** A deleted branch that can be put back (for {@link STRAY_RESTORE_DAYS} days). */
export interface StrayRestorable {
  readonly repo: string;
  readonly branch: string;
  readonly sha: string;
  readonly deletedAt: string;
}

/** What the clean answers. */
export interface StrayCleanResult {
  readonly outcomes: readonly StrayCleanOutcome[];
  /** Bytes freed (the measured sizes of what went). */
  readonly freedBytes: number;
  /** Every branch still restorable (this clean's and earlier ones'). */
  readonly restorable: readonly StrayRestorable[];
}

/** `POST /api/cleanup/strays/restore`. */
export interface StrayRestoreRequest {
  readonly repo: string;
  readonly branch: string;
  readonly sha: string;
}

/** The status lines read per worktree (a count, never the files' content). */
export const STRAY_STATUS_CAP = 1_000;
/** A deleted branch stays restorable this long. */
export const STRAY_RESTORE_DAYS = 7;
/** No agent working this long → the check may run (default). */
export const STRAY_IDLE_MS = 30 * 60_000;
/** The idle check runs at most this often. */
export const STRAY_CHECK_EVERY_MS = 24 * 3_600_000;
/** A dismissed notice is not raised again for this long. */
export const STRAY_SNOOZE_MS = 7 * 24 * 3_600_000;
/** A temp folder is a leftover once this old. */
export const STRAY_TEMP_AGE_MS = 24 * 3_600_000;
/** The settings keys (per install). */
export const STRAY_LAST_CHECK_SETTING = 'cleanup.strays.lastCheck';
export const STRAY_RESTORABLE_SETTING = 'cleanup.strays.restorable';

/**
 * Whether an item is safe to clean without a second thought (ticked by default): nothing in it that
 * exists nowhere else. A worktree with uncommitted changes, or commits only on its branch (or not
 * known), is risky; a stale record and a temp folder are always safe; a branch is safe without
 * unique commits.
 */
export function straySafe(item: Pick<StrayItem, 'kind' | 'uncommitted' | 'uniqueCommits'>): boolean {
  if (item.kind === 'stale-record' || item.kind === 'temp') return true;
  if (item.kind === 'branch') return item.uniqueCommits === 0;
  return item.uncommitted === 0 && item.uniqueCommits === 0;
}

/** The kind in plain words. */
export function strayKindLabel(kind: StrayKind): string {
  switch (kind) {
    case 'claude-subagent':
      return 'Claude Code helper worktree';
    case 'switchboard':
      return 'Switchboard worktree';
    case 'other':
      return 'Other worktree';
    case 'stale-record':
      return 'Stale worktree record';
    case 'branch':
      return 'Leftover branch';
    case 'temp':
      return 'Temporary folder';
  }
}

/** `1.2 GB`, `340 MB`, `12 KB` (1024-based). */
export function strayBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** The Needs-you notice's title: "3 stray worktrees and leftovers (1.2 GB)". */
export function strayNoticeTitle(count: number, bytes: number): string {
  const what = count === 1 ? '1 stray worktree or leftover' : `${count} stray worktrees and leftovers`;
  return bytes > 0 ? `${what} (${strayBytes(bytes)})` : what;
}

/** A fingerprint of a scan's items (sorted ids): the notice is raised again only when it changes. */
export function strayFingerprint(items: readonly Pick<StrayItem, 'id'>[]): string {
  return items
    .map((item) => item.id)
    .sort()
    .join(',');
}

/**
 * Whether the idle check may run now: no agent has worked for `idleMs`, and the last check is
 * older than {@link STRAY_CHECK_EVERY_MS} (or there was none).
 */
export function strayCheckDue(input: { readonly now: number; readonly idleSince: number | null; readonly lastCheck: number | null; readonly idleMs?: number }): boolean {
  if (input.idleSince === null) return false;
  if (input.now - input.idleSince < (input.idleMs ?? STRAY_IDLE_MS)) return false;
  return input.lastCheck === null || input.now - input.lastCheck >= STRAY_CHECK_EVERY_MS;
}

/** Reads a clean request (`null` when malformed). */
export function readStrayCleanRequest(body: unknown): StrayCleanRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b['ids']) || b['ids'].length === 0 || b['ids'].length > 1_000) return null;
  const ids = b['ids'].filter((id): id is string => typeof id === 'string' && /^[a-z-]+:[0-9a-f]{16}$/.test(id));
  if (ids.length !== b['ids'].length) return null;
  return { ids, force: b['force'] === true };
}

/** Reads a restore request (`null` when malformed). */
export function readStrayRestoreRequest(body: unknown): StrayRestoreRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const repo = b['repo'];
  const branch = b['branch'];
  const sha = b['sha'];
  if (typeof repo !== 'string' || repo === '' || typeof branch !== 'string' || branch === '' || typeof sha !== 'string' || !/^[0-9a-f]{7,64}$/.test(sha)) return null;
  return { repo, branch, sha };
}
