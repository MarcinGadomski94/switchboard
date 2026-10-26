/**
 * D107 · Project memory (`docs/memory.md`): durable, reusable facts and conventions about a
 * project (build commands, gotchas, decisions, where things live), kept per folder. Agents only
 * **propose** entries (`memory_propose`); the developer **approves** them (as they are, or edited)
 * or rejects them, and only approved entries ever reach a session: as a delimited block next to the
 * standing instruction (D64), built by {@link memoryBlock}. Always on since 2.0
 * (D132: it graduated from Settings → Experimental; `docs/memory-removal.md`).
 *
 * Shapes, limits, texts, the block, the duplicate check and the MCP tool definitions shared by the
 * server (`src/server/memory/`), the MCP helper (`src/hook/sb-memory-tools.ts`) and the page
 * (`src/web/memory/`).
 */
import type { TodoToolDefinition } from './todos.ts';

/** An entry's review state: only `approved` entries are ever injected or listed to agents. */
export type MemoryStatus = 'proposed' | 'approved' | 'rejected';

export const MEMORY_STATUSES: readonly MemoryStatus[] = ['proposed', 'approved', 'rejected'];

/**
 * D135 · what a proposal asks for: `add` a new entry (every entry before D135, and every approved
 * one), `edit` an approved entry's title and / or text ({@link MemoryEntry.targetId}), or `retract`
 * (remove) one. Only `add` rows are ever approved: an approved `edit` is written into its target and
 * an approved `retract` deletes it (`docs/memory.md` → *Changing approved entries*).
 */
export type MemoryChangeKind = 'add' | 'edit' | 'retract';

/** Who wrote an entry: an agent (it proposed it) or the developer (added by hand: approved at once). */
export type MemoryAuthorKind = 'agent' | 'developer';

/**
 * D107 follow-up 2026-10-15 · who an entry is for (`docs/memory.md` → *Scopes*):
 * - `workspace`: every session of its folder ({@link MemoryEntry.scope}; what every entry was before);
 * - `repo`: sessions that work in one repository ({@link MemoryEntry.scopeKey}: its normalized remote
 *   key, else its main checkout's path), wherever they run from: a linked worktree counts as its repo;
 * - `member`: one Team member (D100) only ({@link MemoryEntry.scopeKey}: the member id).
 */
export type MemoryScopeKind = 'member' | 'repo' | 'workspace';

/** In injection order: member first, then repo, then workspace. */
export const MEMORY_SCOPE_KINDS: readonly MemoryScopeKind[] = ['member', 'repo', 'workspace'];

/** One memory entry (`GET /api/memory/entries`). */
export interface MemoryEntry {
  readonly id: string;
  /** The folder it belongs to: a session's canonical root (a saved workspace or repo folder, D14 / D18). */
  readonly scope: string;
  /** Who it is for (D107 follow-up 2026-10-15); entries made before it are `workspace`. */
  readonly scopeKind: MemoryScopeKind;
  /** `repo`: the repository's key; `member`: the member id; `null` for `workspace`. */
  readonly scopeKey: string | null;
  /** `repo`: the repository's name; `member`: the member's role name (when scoped); `null` for `workspace`. */
  readonly scopeLabel: string | null;
  readonly title: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly authorKind: MemoryAuthorKind;
  /** The proposing session (agents only; it may have been deleted since). */
  readonly authorSessionId: string | null;
  /** The proposing session's title (or role) when it proposed; `null` for the developer. */
  readonly authorLabel: string | null;
  readonly status: MemoryStatus;
  /** Pinned entries come first in the block (and are kept when it is cut). */
  readonly pinned: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** When the developer approved or rejected it (`null` while proposed). */
  readonly decidedAt: string | null;
  /** `developer` once decided (the only one who can approve), else `null`. */
  readonly decidedBy: 'developer' | null;
  /** The agent's own title / text when the developer changed them (the record of what was proposed); `null` otherwise. */
  readonly proposedTitle: string | null;
  readonly proposedText: string | null;
  /**
   * D135: what the proposal asks for (absent, e.g. from an older paired machine, = `add`). For
   * `edit`, {@link title} / {@link text} are the proposed new ones; for `retract`, the entry's own.
   */
  readonly changeKind?: MemoryChangeKind;
  /** D135: the approved entry an `edit` / `retract` is about (`null` for `add`). */
  readonly targetId?: string | null;
  /** D135: why the agent proposes the change (required for `retract`), `null` otherwise. */
  readonly reason?: string | null;
  /** D135: the target's title and text when the change was proposed (what the agent saw), `null` for `add`. */
  readonly targetTitle?: string | null;
  readonly targetText?: string | null;
  /**
   * D135: `GET /api/memory/entries` only, on an `edit` / `retract`: the target as it is now (the
   * review's "old" side), `null` once it is gone.
   */
  readonly target?: MemoryEntry | null;
}

/** D135 · a proposal's change kind (`add` when absent). */
export function changeKindOf(entry: Pick<MemoryEntry, 'changeKind'>): MemoryChangeKind {
  return entry.changeKind ?? 'add';
}

/** D135 · whether `entry` asks to change an approved entry (`edit` / `retract`) rather than add one. */
export function isMemoryChange(entry: Pick<MemoryEntry, 'changeKind'>): boolean {
  return changeKindOf(entry) !== 'add';
}

/** A folder the Memory page offers (`GET /api/memory/scopes`): the saved folders and every folder that has entries. */
export interface MemoryScope {
  readonly scope: string;
  /** The saved folder's label, else the folder's name. */
  readonly label: string;
  /** `true` while it is a saved folder (D18). */
  readonly saved: boolean;
  readonly approved: number;
  readonly proposed: number;
}

/** One scope an entry can be given (`GET /api/memory/scope-options`): the review queue's and the edit form's selector. */
export interface MemoryScopeOption {
  readonly kind: MemoryScopeKind;
  /** `null` for `workspace`. */
  readonly key: string | null;
  readonly label: string;
}

/** A repository a session works in, as Project memory names it. */
export interface MemoryRepoRef {
  /** The normalized remote key (`src/core/takeover.ts` `normalizeRemoteUrl`), else the main checkout's path. */
  readonly key: string;
  /** The main checkout's folder name. */
  readonly label: string;
}

/** What a session can see besides its folder's workspace entries: its member (if any) and its repositories. */
export interface MemoryReach {
  readonly memberId: string | null;
  /** The member's role name. */
  readonly memberLabel: string | null;
  readonly repos: readonly MemoryRepoRef[];
}

/** A session that is no member and works in no repository: workspace entries only (D107 as first built). */
export const NO_REACH: MemoryReach = { memberId: null, memberLabel: null, repos: [] };

/** `GET /api/memory/sessions/{id}`: what a session receives (the session panel's line and its tooltip). */
export interface MemorySessionCount {
  /** Entries in its block. */
  readonly count: number;
  readonly member: number;
  readonly repo: number;
  readonly workspace: number;
  /** Visible to it but over the cap (named in the block; `memory_list` reads them). */
  readonly overflow: number;
  /** Proposals waiting for review in its folder. */
  readonly proposed: number;
  /** Its folder (the Memory page's link), `null` without one. */
  readonly folder: string | null;
}

/** `POST /api/memory/draft`'s answer: the session was asked, or why not. */
export interface MemoryDraftAnswer {
  readonly asked: boolean;
  /** `asked-recently` (one ask per session per {@link MEMORY_DRAFT_REPEAT_HOURS} hours), `no-folder`, `closed`, `not-sent`. */
  readonly reason: string | null;
  /** When it was asked (this ask or the earlier one). */
  readonly askedAt: string | null;
}

/** `POST /api/memory/draft-all`'s answer. */
export interface MemoryDraftAllAnswer {
  readonly asked: readonly { readonly memberId: string; readonly name: string }[];
  readonly skipped: readonly { readonly memberId: string; readonly name: string; readonly reason: string }[];
}

/** `GET /api/memory/state`: the switch (answered while off too). */
export interface MemoryState {
  readonly enabled: boolean;
  /** On and `memory.db` open. */
  readonly available: boolean;
  /** Why `memory.db` could not be opened (while on), else `null`. */
  readonly problem: string | null;
  /** D107 follow-up 2026-10-15: Team members (every team; 0 while Team is off): "Draft memory for all members" shows when there are some. */
  readonly members?: number;
}

/** `GET|PUT /api/memory/settings`. */
export interface MemorySettings {
  /** At most this many characters of entries go into a session's block (pinned first, then newest). */
  readonly cap: number;
}

/** `memoryChanged` on `/hub`: something of the memory of `scope` changed (`null`: the switch or the settings). */
export interface MemoryChanged {
  readonly scope: string | null;
}

export const MEMORY_CAP_DEFAULT = 4_000;
/**
 * D107 follow-up 2026-10-15: each scope's share of the cap (member, repo, workspace). Unused budget
 * passes on to the next scope and back to an earlier one that had more; a session that is no
 * member gives the member share to repo and workspace in the same 3 : 2 proportion.
 */
export const MEMORY_SHARES: Readonly<Record<MemoryScopeKind, number>> = { member: 0.5, repo: 0.3, workspace: 0.2 };
/** "Draft memory from this session": at most one ask per session in this many hours (duplicates are ignored). */
export const MEMORY_DRAFT_REPEAT_HOURS = 24;
export const MEMORY_CAP_MIN = 500;
export const MEMORY_CAP_MAX = 20_000;
export const MEMORY_TITLE_MAX = 80;
export const MEMORY_TEXT_MAX = 1_000;
export const MEMORY_TAGS_MAX = 8;
export const MEMORY_TAG_MAX = 32;
/** D135: a change proposal's reason is at most this long. */
export const MEMORY_REASON_MAX = 500;
/** `memory_propose` (and D135's `memory_propose_edit` / `memory_propose_retract`, counted together): at most this many proposals per session per hour. */
export const MEMORY_PROPOSE_PER_HOUR = 10;
/** The block's overflow line names at most this many titles. */
export const MEMORY_OVERFLOW_TITLES = 20;

/** The block's first and last lines (the delimiters an agent sees). */
export const MEMORY_BLOCK_START = '=== Project memory (approved by the developer) ===';
export const MEMORY_BLOCK_END = '=== End of project memory ===';

// ── input ──────────────────────────────────────────────────────────────

/** A checked entry input. */
export interface MemoryInput {
  readonly title?: string;
  readonly text?: string;
  readonly tags?: readonly string[];
  readonly pinned?: boolean;
}

/** A scope kind from a body value (`null` when it is not one). */
export function readScopeKind(value: unknown): MemoryScopeKind | null {
  return value === 'member' || value === 'repo' || value === 'workspace' ? value : null;
}

export type MemoryInputResult = { readonly ok: true; readonly value: MemoryInput } | { readonly ok: false; readonly field: string; readonly message: string };

/** Collapses runs of spaces / tabs on a line and trims the ends (line breaks in a text are kept). */
function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A tag as stored: trimmed, lower case, inner spaces as `-`. */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Reads an entry's fields from a request body. `required` names the fields that must be there
 * (`title` and `text` for a new entry); the others are checked when present.
 */
export function readMemoryInput(body: unknown, required: readonly ('title' | 'text')[] = []): MemoryInputResult {
  const value = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const out: { title?: string; text?: string; tags?: string[]; pinned?: boolean } = {};
  for (const key of ['title', 'text'] as const) {
    const raw = value[key];
    if (raw === undefined || raw === null) {
      if (required.includes(key)) return { ok: false, field: key, message: `${key} is required` };
      continue;
    }
    if (typeof raw !== 'string') return { ok: false, field: key, message: `${key} must be text` };
    const text = key === 'title' ? raw.replace(/\s+/g, ' ').trim() : cleanText(raw);
    const max = key === 'title' ? MEMORY_TITLE_MAX : MEMORY_TEXT_MAX;
    if (text === '') return { ok: false, field: key, message: `${key} must not be empty` };
    if (text.length > max) return { ok: false, field: key, message: `${key} must be at most ${max} characters (it is ${text.length}): keep entries short` };
    out[key] = text;
  }
  if (value['tags'] !== undefined && value['tags'] !== null) {
    if (!Array.isArray(value['tags']) || value['tags'].some((tag) => typeof tag !== 'string')) return { ok: false, field: 'tags', message: 'tags must be a list of words' };
    const tags = [...new Set((value['tags'] as string[]).map(normalizeTag).filter((tag) => tag !== ''))];
    if (tags.length > MEMORY_TAGS_MAX) return { ok: false, field: 'tags', message: `at most ${MEMORY_TAGS_MAX} tags` };
    const long = tags.find((tag) => tag.length > MEMORY_TAG_MAX);
    if (long) return { ok: false, field: 'tags', message: `a tag must be at most ${MEMORY_TAG_MAX} characters` };
    out.tags = tags;
  }
  if (value['pinned'] !== undefined) {
    if (typeof value['pinned'] !== 'boolean') return { ok: false, field: 'pinned', message: 'pinned must be true or false' };
    out.pinned = value['pinned'];
  }
  return { ok: true, value: out };
}

/** Reads `{ cap }` (`PUT /api/memory/settings`). */
export function readMemoryCap(body: unknown): number | null {
  const cap = body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['cap'] : undefined;
  return typeof cap === 'number' && Number.isInteger(cap) && cap >= MEMORY_CAP_MIN && cap <= MEMORY_CAP_MAX ? cap : null;
}

// ── duplicates ─────────────────────────────────────────────────────────

/** A title compared for duplicates: lower case, accents and punctuation dropped, spaces collapsed. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost);
      current.push(next);
      best = Math.min(best, next);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length] as number;
}

/**
 * Near-identical titles: equal once normalized ({@link normalizeTitle}), or within a few edits
 * (one per ten characters, at most three: "Build command" / "Build commands" / "Build-command").
 */
export function nearDuplicateTitle(a: string, b: string): boolean {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (x === y) return true;
  const limit = Math.min(3, Math.floor(Math.min(x.length, y.length) / 10));
  return limit > 0 && editDistance(x, y, limit) <= limit;
}

// ── the block ──────────────────────────────────────────────────────────

/** Pinned first, then newest (approved / last edited) first; ties by title. */
export function memoryOrder<T extends Pick<MemoryEntry, 'pinned' | 'decidedAt' | 'updatedAt' | 'title'>>(entries: readonly T[]): T[] {
  const at = (entry: T): string => (entry.decidedAt !== null && entry.decidedAt > entry.updatedAt ? entry.decidedAt : entry.updatedAt);
  return [...entries].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ta = at(a);
    const tb = at(b);
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.title.localeCompare(b.title);
  });
}

/** An entry's scope kind (rows without one, e.g. from an older peer, are `workspace`). */
export function scopeKindOf(entry: Partial<Pick<MemoryEntry, 'scopeKind'>>): MemoryScopeKind {
  return entry.scopeKind ?? 'workspace';
}

/**
 * Whether a session of `folder` with `reach` sees `entry`: a workspace entry of its folder, a repo
 * entry of one of its repositories (any folder), a member entry of its member (any folder).
 */
export function memoryVisible(entry: Pick<MemoryEntry, 'scope'> & Partial<Pick<MemoryEntry, 'scopeKind' | 'scopeKey'>>, folder: string, reach: MemoryReach): boolean {
  const kind = scopeKindOf(entry);
  if (kind === 'member') return reach.memberId !== null && entry.scopeKey === reach.memberId;
  if (kind === 'repo') return reach.repos.some((repo) => repo.key === entry.scopeKey);
  return entry.scope === folder;
}

/** Each scope's budget of `cap` characters ({@link MEMORY_SHARES}); without a member the member share goes to repo and workspace. */
export function memoryBudgets(cap: number, member: boolean): Record<MemoryScopeKind, number> {
  if (member) {
    const m = Math.floor(cap * MEMORY_SHARES.member);
    const r = Math.floor(cap * MEMORY_SHARES.repo);
    return { member: m, repo: r, workspace: cap - m - r };
  }
  const r = Math.floor((cap * MEMORY_SHARES.repo) / (MEMORY_SHARES.repo + MEMORY_SHARES.workspace));
  return { member: 0, repo: r, workspace: cap - r };
}

/** The proposal's default scope for a session: `member` for a Team member, `repo` with exactly one repository, else `workspace`. */
export function defaultProposalScope(reach: MemoryReach): MemoryScopeKind {
  if (reach.memberId !== null) return 'member';
  return reach.repos.length === 1 ? 'repo' : 'workspace';
}

/** One entry as the block shows it. */
export function memoryEntryText(entry: Pick<MemoryEntry, 'title' | 'text' | 'tags'>): string {
  const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
  const body = entry.text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  return `- ${entry.title}${tags}\n${body}`;
}

/** What {@link memoryBlockParts} put in and left out. */
export interface MemoryBlockParts {
  readonly text: string;
  readonly included: readonly string[];
  readonly overflow: readonly string[];
  /** Entries in the block per scope. */
  readonly counts: Readonly<Record<MemoryScopeKind, number>>;
}

/**
 * The block a session of a folder gets next to its standing instruction (`null` without approved
 * entries it can see). Only the entries given are used: the caller passes **approved** entries only
 * (the server reads them with `status = 'approved'`); `reach` (D107 follow-up 2026-10-15) picks the
 * ones the session sees ({@link memoryVisible}; without it every entry counts as the folder's).
 *
 * **Order and budgets:** member entries first, then repo, then workspace; within each, pinned first,
 * then newest. Each scope has its share of `cap` ({@link memoryBudgets}); within a scope entries are
 * added while they fit (the first that does not fit stops that scope), and what a scope leaves unused
 * passes on to the next. Whatever is still unused at the end goes back, in the same order, to the
 * scopes that stopped early. The entries that did not fit are named on one line (at most
 * {@link MEMORY_OVERFLOW_TITLES} titles) with a pointer to `memory_list`. Only the entries' text
 * counts against `cap` (the head lines, the scope headings and the Team charter do not).
 *
 * A block with workspace entries only reads exactly as before scopes existed.
 */
export function memoryBlockParts(entries: readonly MemoryEntry[], cap: number, label: string, reach?: MemoryReach): MemoryBlockParts | null {
  const approved = entries.filter((entry) => entry.status === 'approved' && (reach === undefined || memoryVisible(entry, entry.scope, reach)));
  if (approved.length === 0) return null;
  const effective: MemoryReach = reach ?? NO_REACH;
  const groups: Record<MemoryScopeKind, MemoryEntry[]> = { member: [], repo: [], workspace: [] };
  for (const entry of approved) groups[reach === undefined ? 'workspace' : scopeKindOf(entry)].push(entry);
  for (const kind of MEMORY_SCOPE_KINDS) groups[kind] = memoryOrder(groups[kind]);
  const budgets = memoryBudgets(cap, effective.memberId !== null);
  const taken: Record<MemoryScopeKind, number> = { member: 0, repo: 0, workspace: 0 };
  let lines = 0;
  const fill = (kind: MemoryScopeKind, allowance: number): number => {
    let spent = 0;
    const group = groups[kind];
    while (taken[kind] < group.length) {
      const cost = memoryEntryText(group[taken[kind]] as MemoryEntry).length + (lines > 0 ? 1 : 0);
      if (spent + cost > allowance) break;
      spent += cost;
      taken[kind] += 1;
      lines += 1;
    }
    return spent;
  };
  // Pass 1: each scope its share plus what the earlier ones left.
  let carry = 0;
  for (const kind of MEMORY_SCOPE_KINDS) {
    const allowance = budgets[kind] + carry;
    carry = allowance - fill(kind, allowance);
  }
  // Pass 2: what is still unused goes back to the scopes that stopped early, in order.
  for (const kind of MEMORY_SCOPE_KINDS) carry -= fill(kind, carry);

  const included: string[] = [];
  const overflowEntries: MemoryEntry[] = [];
  for (const kind of MEMORY_SCOPE_KINDS) {
    groups[kind].forEach((entry, index) => (index < taken[kind] ? included.push(entry.id) : overflowEntries.push(entry)));
  }
  const workspaceOnly = groups.member.length === 0 && groups.repo.length === 0;
  const body: string[] = [];
  if (workspaceOnly) {
    for (const entry of groups.workspace.slice(0, taken.workspace)) body.push(memoryEntryText(entry));
  } else {
    if (taken.member > 0) {
      body.push(`-- For you, ${effective.memberLabel ?? 'this member'} (member memory) --`);
      for (const entry of groups.member.slice(0, taken.member)) body.push(memoryEntryText(entry));
    }
    if (taken.repo > 0) {
      const shown = groups.repo.slice(0, taken.repo);
      const keys = [...new Set(shown.map((entry) => entry.scopeKey))];
      for (const key of keys) {
        const repoLabel = effective.repos.find((repo) => repo.key === key)?.label ?? shown.find((entry) => entry.scopeKey === key)?.scopeLabel ?? key ?? 'a repository';
        body.push(`-- Repository ${repoLabel} (repo memory) --`);
        for (const entry of shown.filter((candidate) => candidate.scopeKey === key)) body.push(memoryEntryText(entry));
      }
    }
    if (taken.workspace > 0) {
      body.push(`-- Everyone in ${label} (workspace memory) --`);
      for (const entry of groups.workspace.slice(0, taken.workspace)) body.push(memoryEntryText(entry));
    }
  }
  const head = [
    MEMORY_BLOCK_START,
    workspaceOnly
      ? `Folder: ${label}. Durable facts and conventions about this project that the developer reviewed and approved. Treat them as project knowledge. To add one, propose it with the switchboard memory_propose tool (the developer reviews every proposal); do not write project memory anywhere else.`
      : `Folder: ${label}. Durable facts and conventions that the developer reviewed and approved, grouped by who they are for: your own as a team member first, then the repositories you work in, then everyone in this folder. Treat them as project knowledge. To add one, propose it with the switchboard memory_propose tool, scoped as narrowly as it holds (the developer reviews every proposal); do not write project memory anywhere else.`,
  ];
  const tail: string[] = [];
  if (overflowEntries.length > 0) {
    const titles = overflowEntries.map((entry) => `"${entry.title}"`);
    const named = titles.slice(0, MEMORY_OVERFLOW_TITLES).join(', ');
    const more = titles.length > MEMORY_OVERFLOW_TITLES ? ` and ${titles.length - MEMORY_OVERFLOW_TITLES} more` : '';
    tail.push(`${overflowEntries.length === 1 ? '1 more approved entry' : `${overflowEntries.length} more approved entries`}, not shown to save space: ${named}${more}. Read them with the switchboard memory_list tool when they matter.`);
  }
  return { text: [...head, ...body, ...tail, MEMORY_BLOCK_END].join('\n'), included, overflow: overflowEntries.map((entry) => entry.id), counts: taken };
}

/** {@link memoryBlockParts}' text, or `null`. */
export function memoryBlock(entries: readonly MemoryEntry[], cap: number, label: string, reach?: MemoryReach): string | null {
  return memoryBlockParts(entries, cap, label, reach)?.text ?? null;
}

/** The standing instruction `base` with the block appended (the block alone without one). */
export function withMemoryBlock(base: string | null, block: string | null): string | null {
  if (!block) return base;
  return base ? `${base}\n\n${block}` : block;
}

// ── texts ──────────────────────────────────────────────────────────────

/** The Inbox item's title: "3 memory proposals for Acme app". */
export function memoryProposalsTitle(count: number, label: string): string {
  return `${count === 1 ? '1 memory proposal' : `${count} memory proposals`} for ${label}`;
}

/** The session panel's line: "Memory: 3 entries". */
export function memoryCountText(count: number): string {
  return `Memory: ${count === 1 ? '1 entry' : `${count} entries`}`;
}

/** An entry's scope as a short label: "workspace", "repo app", "member Developer". */
export function memoryScopeText(entry: Partial<Pick<MemoryEntry, 'scopeKind' | 'scopeLabel'>>): string {
  const kind = scopeKindOf(entry);
  if (kind === 'workspace') return 'workspace';
  return entry.scopeLabel ? `${kind} ${entry.scopeLabel}` : kind;
}

/** The session panel's tooltip: what the session receives, per scope, and what is over the cap. */
export function memoryCountTooltip(count: Pick<MemorySessionCount, 'member' | 'repo' | 'workspace' | 'overflow'>): string {
  const parts = [`member ${count.member}`, `repo ${count.repo}`, `workspace ${count.workspace}`].join(' · ');
  const over = count.overflow > 0 ? `; ${count.overflow} more over the size cap (named in the block, read with memory_list)` : '';
  return `In this session's block: ${parts}${over}`;
}

/** An ISO time as `memory_list` shows it: "2026-10-15 10:00 UTC" (the raw text when it is not a time). */
export function memoryListTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * `memory_list`'s answer: each entry labelled with its scope and, since D135, followed by its id and
 * when it was last approved or edited, so an agent can name it in `memory_propose_edit` /
 * `memory_propose_retract`. The lines before D135 are unchanged (the id line is added under each).
 */
export function memoryListText(
  entries: readonly (Pick<MemoryEntry, 'title' | 'text' | 'tags'> & Partial<Pick<MemoryEntry, 'id' | 'scopeKind' | 'scopeLabel' | 'updatedAt' | 'decidedAt'>>)[],
  label: string,
): string {
  if (entries.length === 0) return `No approved project memory for ${label} yet. Propose durable facts with memory_propose.`;
  return [
    `Project memory for ${label} (approved by the developer) that this session sees, ${entries.length === 1 ? '1 entry' : `${entries.length} entries`}, member first, then repo, then workspace. To change or remove one, pass its id to memory_propose_edit or memory_propose_retract instead of proposing a contradicting entry:`,
    ...entries.map((entry) => {
      const line = `[${memoryScopeText(entry)}] ${memoryEntryText(entry)}`;
      if (entry.id === undefined) return line;
      const at = entry.decidedAt && entry.updatedAt && entry.decidedAt > entry.updatedAt ? entry.decidedAt : (entry.updatedAt ?? entry.decidedAt ?? null);
      return `${line}\n  (id: ${entry.id}${at ? ` · updated ${memoryListTime(at)}` : ''})`;
    }),
  ].join('\n');
}

// ── D135 · the review's comparison ─────────────────────────────────────

/** One run of a word diff: kept on both sides, only in the old text (`del`) or only in the new one (`add`). */
export interface MemoryDiffPart {
  readonly kind: 'same' | 'del' | 'add';
  readonly text: string;
}

/** Splits text into words and the spaces between them (the spaces are kept, so the parts join back to the text). */
function diffTokens(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/**
 * D135 · a word-level diff of `before` → `after` (the review's old vs new title and text): the
 * longest common run of words is `same`, the rest `del` (only before) or `add` (only after).
 * Adjacent parts of a kind are merged. Joining the `same` + `del` parts gives `before`, the
 * `same` + `add` parts `after`. Entries are short (≤ 1,000 characters), so the plain LCS table is cheap.
 */
export function memoryWordDiff(before: string, after: string): MemoryDiffPart[] {
  const a = diffTokens(before);
  const b = diffTokens(after);
  // Far beyond an entry's size (e.g. an older peer's long text): the whole of each side, no table.
  if (a.length * b.length > 1_000_000) return [...(before ? [{ kind: 'del' as const, text: before }] : []), ...(after ? [{ kind: 'add' as const, text: after }] : [])];
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = a[i] === b[j] ? (table[(i + 1) * cols + j + 1] as number) + 1 : Math.max(table[(i + 1) * cols + j] as number, table[i * cols + j + 1] as number);
    }
  }
  const parts: MemoryDiffPart[] = [];
  const push = (kind: MemoryDiffPart['kind'], text: string): void => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) parts[parts.length - 1] = { kind, text: last.text + text };
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i] as string);
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * cols + j] as number) >= (table[i * cols + j + 1] as number)) {
      push('del', a[i] as string);
      i += 1;
    } else {
      push('add', b[j] as string);
      j += 1;
    }
  }
  while (i < a.length) push('del', a[i++] as string);
  while (j < b.length) push('add', b[j++] as string);
  // A lone space kept between two changes splits one change in two: it joins both sides, and each
  // run of changes reads as one removed and one added stretch.
  const out: MemoryDiffPart[] = [];
  let del = '';
  let add = '';
  const flush = (): void => {
    if (del) out.push({ kind: 'del', text: del });
    if (add) out.push({ kind: 'add', text: add });
    del = '';
    add = '';
  };
  parts.forEach((part, index) => {
    const between = part.kind === 'same' && /^\s+$/.test(part.text) && index > 0 && index < parts.length - 1 && (del !== '' || add !== '') && parts[index + 1]?.kind !== 'same';
    if (part.kind === 'del') del += part.text;
    else if (part.kind === 'add') add += part.text;
    else if (between) {
      del += part.text;
      add += part.text;
    } else {
      flush();
      out.push(part);
    }
  });
  flush();
  return out;
}

/** D135 · the Inbox / review wording of a proposal: "Edit: Title", "Removal: Title", the title alone for an add. */
export function memoryProposalLabel(entry: Pick<MemoryEntry, 'title' | 'changeKind'> & { readonly target?: Pick<MemoryEntry, 'title'> | null }): string {
  const kind = changeKindOf(entry);
  if (kind === 'edit') return `Edit: ${entry.target?.title ?? entry.title}`;
  if (kind === 'retract') return `Removal: ${entry.target?.title ?? entry.title}`;
  return entry.title;
}

/**
 * The message "Draft memory from this session" sends (D107 follow-up 2026-10-15): the session's own
 * agent reviews its history and proposes its durable facts with `memory_propose`. Nothing is applied.
 */
export function memoryDraftAskText(role: string | null, reach: MemoryReach): string {
  const scopeHint =
    role !== null
      ? `Use scope "member" (the default for you, ${role}) for what only your own work on your feature needs; "repo" for facts about one repository that any session working in it needs; "workspace" only for facts true for everyone in this folder.`
      : `Use scope "repo" for facts about one repository${reach.repos.length > 1 ? ' (name it in repo: you work in several)' : ''}; "workspace" only for facts true for everyone in this folder.`;
  return [
    'Switchboard asks you to draft project memory from this session.',
    'Review your own history in this session and pick the durable, reusable facts a future session would need: build and test commands, gotchas, decisions and their reasons, where things live. Not task notes or progress.',
    `Read memory_list first and skip what is already there. Then call memory_propose once per fact, short, and give each the narrowest scope that holds. ${scopeHint}`,
    'Nothing is applied: the developer reviews every proposal and may change its scope. Do no other work for this message.',
  ].join('\n\n');
}

/** The folder's name for a label: its last path segment. */
export function folderName(scope: string): string {
  const parts = scope.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? scope;
}

// ── MCP tools ──────────────────────────────────────────────────────────

/** The memory tools of the `switchboard` MCP server (registered only while Project memory is on). */
export const MEMORY_TOOLS: readonly TodoToolDefinition[] = [
  {
    name: 'memory_propose',
    description: `Propose a project memory entry: a durable, reusable fact or convention about this project that a future session would need, e.g. a build or test command, a gotcha, a decision and its reason, where something lives. Not for task notes, progress or anything only this task needs (use the todo tools for those). Keep it short: one fact per entry, a title of at most ${MEMORY_TITLE_MAX} characters and a text of at most ${MEMORY_TEXT_MAX}. Prefer the narrowest scope that holds: "member" (only you, when you are a team member: the default for members), "repo" (sessions working in one repository: the default when you work in exactly one), "workspace" (every session in this folder) only for facts true for everyone in the folder. The developer reviews every proposal and may change its scope; it is used only once approved. At most ${MEMORY_PROPOSE_PER_HOUR} proposals per hour; a title close to an existing entry is refused. To correct or retire an entry that is already approved, use memory_propose_edit or memory_propose_retract with its id (from memory_list) instead of proposing a new entry that contradicts it.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `One short line naming the fact (at most ${MEMORY_TITLE_MAX} characters), e.g. "Run the tests with the test ports".` },
        text: { type: 'string', description: `The fact itself, plain and brief (at most ${MEMORY_TEXT_MAX} characters): the command, the rule, the location, and why when it is not obvious.` },
        tags: { type: 'array', items: { type: 'string' }, description: `Optional, up to ${MEMORY_TAGS_MAX} short words, e.g. build, tests, gotcha.` },
        scope: {
          type: 'string',
          enum: ['member', 'repo', 'workspace'],
          description: 'Optional: who it is for. member = only you (team members), repo = sessions working in the repository, workspace = everyone in this folder (only for facts true for everyone). Default: member for a team member, repo when you work in exactly one repository, else workspace.',
        },
        repo: { type: 'string', description: 'Optional, with scope "repo" when you work in several repositories: the repository\'s name (its folder name) or remote.' },
      },
      required: ['title', 'text'],
      additionalProperties: false,
    },
    annotations: { title: 'Propose a project memory entry', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'memory_list',
    description:
      "List the project memory this session sees: the entries the developer approved for you as a team member, for the repositories you work in and for everyone in this folder (title, text, tags), each labelled with its scope and followed by its id and when it was last updated. Pass an id to memory_propose_edit or memory_propose_retract to change or remove that entry. Proposals still under review are not listed.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List project memory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'memory_propose_edit',
    description: `Propose a change to an approved project memory entry that is wrong, outdated or unclear: give its id (from memory_list) and the new title and / or text. Use this instead of proposing a new entry that contradicts or repeats an existing one. Nothing changes until the developer approves: they see the current and the proposed wording side by side, and approving replaces the entry (it keeps its id and scope). Always say why in reason. You can only change entries this session sees (memory_list). One pending edit per entry from a session; at most ${MEMORY_PROPOSE_PER_HOUR} proposals of any kind per hour.`,
    inputSchema: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'The id of the approved entry to change, as memory_list shows it ("id: …").' },
        title: { type: 'string', description: `Optional: the new title (at most ${MEMORY_TITLE_MAX} characters). Leave it out to keep the current one.` },
        text: { type: 'string', description: `Optional: the new text, complete, not a diff (at most ${MEMORY_TEXT_MAX} characters). Leave it out to keep the current one. Give title, text or both.` },
        reason: { type: 'string', description: `Why the entry should change (at most ${MEMORY_REASON_MAX} characters), e.g. "The test command moved to npm run test:unit in this repository." Always give one: the developer decides on it.` },
      },
      required: ['entry'],
      additionalProperties: false,
    },
    annotations: { title: 'Propose a change to a project memory entry', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'memory_propose_retract',
    description: `Propose removing an approved project memory entry that is no longer true or no longer useful: give its id (from memory_list) and the reason. Use this instead of proposing a new entry that says the opposite. Nothing is removed until the developer approves; rejecting keeps the entry. You can only retract entries this session sees (memory_list). One pending removal per entry from a session; at most ${MEMORY_PROPOSE_PER_HOUR} proposals of any kind per hour.`,
    inputSchema: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'The id of the approved entry to remove, as memory_list shows it ("id: …").' },
        reason: { type: 'string', description: `Why it should go (at most ${MEMORY_REASON_MAX} characters), e.g. "The staging server was retired; the deploy goes straight to production now."` },
      },
      required: ['entry', 'reason'],
      additionalProperties: false,
    },
    annotations: { title: 'Propose removing a project memory entry', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];
