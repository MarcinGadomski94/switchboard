/**
 * D84 · Clean-up (`docs/cleanup.md`): the shapes and rules shared by the
 * service (`src/server/cleanup/`) and Settings → Clean-up
 * (`src/web/views/settings/CleanupSection.tsx`). A scan lists what Switchboard
 * created and no longer needs, grouped, with sizes, ages and exactly what each
 * item removes; nothing is removed by a scan. A run removes the items the
 * developer ticked, one at a time, and reports each.
 */

/** The groups, in the order the page shows them and a run works through them. */
export const CLEANUP_GROUPS = ['worktrees', 'localBranches', 'remoteBranches', 'sessions', 'data'] as const;

/** A group of the page. */
export type CleanupGroup = (typeof CLEANUP_GROUPS)[number];

/** Each group's heading. */
export const CLEANUP_GROUP_LABELS: Readonly<Record<CleanupGroup, string>> = {
  worktrees: 'Worktrees',
  localBranches: 'Local branches',
  remoteBranches: 'Remote branches',
  sessions: 'Closed sessions',
  data: 'Old attachments and data files',
};

/** Each group's one-line explanation. */
export const CLEANUP_GROUP_HINTS: Readonly<Record<CleanupGroup, string>> = {
  worktrees: 'Worktrees Switchboard made whose branch is merged, whose session is closed and that saw no change for 14 days, or whose folder is gone. Removing a worktree keeps its branch.',
  localBranches: 'Branches Switchboard made that are merged, or whose worktree or session is gone. Unmerged ones need an extra confirmation. Other branches a Switchboard worktree used are listed only when merged, never ticked for you.',
  remoteBranches: 'Branches Switchboard pushed. Never ticked for you: each one is deleted on its remote only when you tick it, after a separate confirmation.',
  sessions: 'Closed sessions older than the limit below: the session record with its events, todos and attachments.',
  data: 'Attachments past their 30 days, files nothing refers to any more, old chat exports, take-over staging folders, and (never ticked for you) saved artifacts whose session was deleted.',
};

/** D84: a worktree whose session is closed or gone counts as stale after this many days without a change. */
export const STALE_WORKTREE_DAYS = 14;

/** D84: closed sessions older than this many days are listed (configurable: {@link CLEANUP_SESSION_DAYS_SETTING}). */
export const CLOSED_SESSION_DAYS_DEFAULT = 30;
export const CLOSED_SESSION_DAYS_MIN = 1;
export const CLOSED_SESSION_DAYS_MAX = 3650;

/** The settings key of the closed-session limit (its own key, written by `PUT /api/cleanup/settings`). */
export const CLEANUP_SESSION_DAYS_SETTING = 'cleanup.closedSessionDays';

/** Take-over staging folders (`<dataDir>/takeover/<op>`) of no running operation are listed after this many days. */
export const TAKEOVER_STAGING_DAYS = 1;

/** Branch-name prefixes Switchboard gives the branches it makes (`session/{name}`, lane A's `todo/…`). */
export const SWITCHBOARD_BRANCH_PREFIXES: readonly string[] = ['session/', 'todo/'];

/** `true` when `branch` has a name Switchboard gives its own branches. */
export function hasSwitchboardBranchName(branch: string): boolean {
  return SWITCHBOARD_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix) && branch.length > prefix.length);
}

/** Why an item is listed. */
export type CleanupReason =
  | 'merged'
  | 'pr-merged'
  | 'stale'
  | 'folder-missing'
  | 'session-closed'
  | 'session-gone'
  | 'worktree-gone'
  | 'closed-long-ago'
  | 'past-retention'
  | 'orphaned'
  | 'takeover-leftover'
  /** D84 ruling: a branch only a `worktrees` row names (no Switchboard naming, no created record): listed when merged, never ticked. */
  | 'untracked-origin';

/** A reason's chip text. */
export const CLEANUP_REASON_LABELS: Readonly<Record<CleanupReason, string>> = {
  merged: 'merged',
  'pr-merged': 'PR merged',
  stale: 'no change for 14 days',
  'folder-missing': 'folder missing',
  'session-closed': 'session closed',
  'session-gone': 'session deleted',
  'worktree-gone': 'worktree gone',
  'closed-long-ago': 'closed long ago',
  'past-retention': 'past retention',
  orphaned: 'orphaned',
  'takeover-leftover': 'take-over leftover',
  'untracked-origin': 'not known to be made by Switchboard',
};

/** The extra confirmation an item needs before a run may remove it. */
export type CleanupConfirm = 'uncommitted' | 'unmerged' | 'remote';

/** What the confirmation dialog says for each kind. */
export const CLEANUP_CONFIRM_LABELS: Readonly<Record<CleanupConfirm, string>> = {
  uncommitted: 'Discard the uncommitted changes listed above',
  unmerged: 'Delete these unmerged branches (their commits are not in their base)',
  remote: 'Delete these branches on their remotes',
};

/** A warning on an item (the files it would lose, the commits that are not merged, the remote it touches). */
export interface CleanupWarning {
  readonly kind: CleanupConfirm;
  readonly message: string;
  /** The uncommitted files (`git status` paths), at most {@link CLEANUP_FILES_MAX}; empty for other kinds. */
  readonly files: readonly string[];
}

/** How many uncommitted files a warning lists. */
export const CLEANUP_FILES_MAX = 200;

/** One thing a run can remove. */
export interface CleanupItem {
  /** Stable across scans while the thing is the same (`wt:<record id>`, `lb:<hash>`, …). */
  readonly id: string;
  readonly group: CleanupGroup;
  /** A path, a branch name, a session title. */
  readonly title: string;
  /** The repo / session / folder it belongs to. */
  readonly subtitle: string;
  readonly reasons: readonly CleanupReason[];
  /** Bytes freed (a worktree's folder, a session's events and attachments, files); `null` when not counted (branches). */
  readonly sizeBytes: number | null;
  /** The size is a lower bound (the walk stopped at its limit). */
  readonly sizeCapped: boolean;
  /** The last change seen (commit, activity, file time, closing), ISO; `null` when unknown. */
  readonly lastChangeAt: string | null;
  /** Exactly what goes: paths, `repo: branch name`, `remote: branch`, the session and what it holds. */
  readonly removes: readonly string[];
  /** Things kept on purpose, said once (e.g. "the branch session/x is kept"). */
  readonly keeps: readonly string[];
  readonly warnings: readonly CleanupWarning[];
  /** The extra confirmation a run needs for this item; `null` = none. */
  readonly confirm: CleanupConfirm | null;
  /** Ticked when the page opens (never for an item that needs a confirmation). */
  readonly selected: boolean;
  /** Changes when what the item would remove changes (not with sizes or ages): a run refuses an item whose fingerprint moved. */
  readonly fingerprint: string;
}

/** `GET /api/cleanup`: the dry run. */
export interface CleanupScan {
  readonly scannedAt: string;
  readonly closedSessionDays: number;
  readonly staleDays: number;
  readonly items: readonly CleanupItem[];
  /** Things the scan could not read (a repo that is gone, git failing), one line each. */
  readonly notes: readonly string[];
}

/** One ticked item of a run (`POST /api/cleanup/runs`). */
export interface CleanupRunSelection {
  readonly id: string;
  readonly fingerprint: string;
  /** Required, and must equal the item's `confirm`, when it has one. */
  readonly confirm?: CleanupConfirm;
}

/** `POST /api/cleanup/runs` body. */
export interface CleanupRunRequest {
  readonly items: readonly CleanupRunSelection[];
}

/** A run item's state. */
export type CleanupStepStatus = 'pending' | 'running' | 'done' | 'failed';

/** One item of a run, as the progress list shows it. */
export interface CleanupRunItem {
  readonly id: string;
  readonly group: CleanupGroup;
  readonly title: string;
  readonly status: CleanupStepStatus;
  /** Why it failed (nothing else is affected by a failure). */
  readonly error: string | null;
  readonly sizeBytes: number | null;
}

/** `GET /api/cleanup/runs/{id}`. */
export interface CleanupRun {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly items: readonly CleanupRunItem[];
  readonly summary: { readonly done: number; readonly failed: number; readonly freedBytes: number };
}

/** `PUT /api/cleanup/settings` body and answer. */
export interface CleanupSettings {
  readonly closedSessionDays: number;
}

const CONFIRMS: readonly string[] = ['uncommitted', 'unmerged', 'remote'];

/** The `closedSessionDays` of a body: a whole number in range, else `null`. */
export function parseClosedSessionDays(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= CLOSED_SESSION_DAYS_MIN && value <= CLOSED_SESSION_DAYS_MAX ? value : null;
}

/** A stored limit, or the default. */
export function closedSessionDaysOf(stored: unknown): number {
  return parseClosedSessionDays(stored) ?? CLOSED_SESSION_DAYS_DEFAULT;
}

/** Parses a run body: `{ items: [{ id, fingerprint, confirm? }] }` with distinct ids, at least one. */
export function parseRunRequest(body: unknown): { readonly ok: true; readonly value: CleanupRunRequest } | { readonly ok: false; readonly field: string; readonly message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, field: 'body', message: 'the body must be an object' };
  const items = (body as Record<string, unknown>)['items'];
  if (!Array.isArray(items) || items.length === 0) return { ok: false, field: 'items', message: 'tick at least one item' };
  const seen = new Set<string>();
  const out: CleanupRunSelection[] = [];
  for (const [index, raw] of items.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, field: `items[${index}]`, message: 'each item is { id, fingerprint, confirm? }' };
    const record = raw as Record<string, unknown>;
    const id = record['id'];
    const fingerprint = record['fingerprint'];
    const confirm = record['confirm'];
    if (typeof id !== 'string' || id === '' || id.length > 200) return { ok: false, field: `items[${index}].id`, message: 'id is required' };
    if (typeof fingerprint !== 'string' || fingerprint === '') return { ok: false, field: `items[${index}].fingerprint`, message: 'fingerprint is required' };
    if (confirm !== undefined && confirm !== null && (typeof confirm !== 'string' || !CONFIRMS.includes(confirm))) {
      return { ok: false, field: `items[${index}].confirm`, message: 'confirm is uncommitted, unmerged or remote' };
    }
    if (seen.has(id)) return { ok: false, field: `items[${index}].id`, message: `${id} is listed twice` };
    seen.add(id);
    out.push({ id, fingerprint, ...(typeof confirm === 'string' ? { confirm: confirm as CleanupConfirm } : {}) });
  }
  return { ok: true, value: { items: out } };
}

/**
 * The ticked items that need a confirmation the selection does not carry
 * (`confirm` missing or of another kind). A run with any is refused as a whole.
 */
export function missingConfirmations(items: readonly CleanupItem[], selection: readonly CleanupRunSelection[]): CleanupItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return selection.flatMap((picked) => {
    const item = byId.get(picked.id);
    return item && item.confirm !== null && picked.confirm !== item.confirm ? [item] : [];
  });
}

/** Items in run order: by group ({@link CLEANUP_GROUPS}), then as listed. */
export function inRunOrder<T extends { readonly group: CleanupGroup }>(items: readonly T[]): T[] {
  return CLEANUP_GROUPS.flatMap((group) => items.filter((item) => item.group === group));
}

/** The items ticked by default. */
export function defaultSelection(items: readonly CleanupItem[]): Set<string> {
  return new Set(items.filter((item) => item.selected && item.confirm === null).map((item) => item.id));
}

/** The confirmations a selection needs, each with its items (in run order). */
export function neededConfirmations(items: readonly CleanupItem[], selected: ReadonlySet<string>): Map<CleanupConfirm, CleanupItem[]> {
  const out = new Map<CleanupConfirm, CleanupItem[]>();
  for (const item of inRunOrder(items)) {
    if (!selected.has(item.id) || item.confirm === null) continue;
    const list = out.get(item.confirm) ?? [];
    list.push(item);
    out.set(item.confirm, list);
  }
  return out;
}

/** A run's body for a selection (each item's own `confirm`; call only after the developer confirmed them). */
export function runRequestOf(items: readonly CleanupItem[], selected: ReadonlySet<string>): CleanupRunRequest {
  return {
    items: inRunOrder(items)
      .filter((item) => selected.has(item.id))
      .map((item) => ({ id: item.id, fingerprint: item.fingerprint, ...(item.confirm ? { confirm: item.confirm } : {}) })),
  };
}

/** Sum of the known sizes. */
export function totalSize(items: readonly Pick<CleanupItem, 'sizeBytes'>[]): number {
  return items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
}

/** `true` once every item of a run has finished. */
export function runFinished(run: Pick<CleanupRun, 'finishedAt'>): boolean {
  return run.finishedAt !== null;
}

/** `today`, `1 day ago`, `12 days ago` from an ISO time (`''` when unknown). */
export function ageText(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
