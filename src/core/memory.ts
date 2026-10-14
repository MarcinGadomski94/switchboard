/**
 * D107 · Project memory (`docs/memory.md`): durable, reusable facts and conventions about a
 * project (build commands, gotchas, decisions, where things live), kept per folder. Agents only
 * **propose** entries (`memory_propose`); the developer **approves** them (as they are, or edited)
 * or rejects them, and only approved entries ever reach a session: as a delimited block next to the
 * standing instruction (D64), built by {@link memoryBlock}. Experimental, off by default
 * (Settings → Experimental → Project memory), removable (`docs/memory-removal.md`).
 *
 * Shapes, limits, texts, the block, the duplicate check and the MCP tool definitions shared by the
 * server (`src/server/memory/`), the MCP helper (`src/hook/sb-memory-tools.ts`) and the page
 * (`src/web/memory/`).
 */
import type { TodoToolDefinition } from './todos.ts';

/** The switch (Settings → Experimental → Project memory). */
export const MEMORY_SETTING = 'experimental.memory';

/** An entry's review state: only `approved` entries are ever injected or listed to agents. */
export type MemoryStatus = 'proposed' | 'approved' | 'rejected';

export const MEMORY_STATUSES: readonly MemoryStatus[] = ['proposed', 'approved', 'rejected'];

/** Who wrote an entry: an agent (it proposed it) or the developer (added by hand: approved at once). */
export type MemoryAuthorKind = 'agent' | 'developer';

/** One memory entry (`GET /api/memory/entries`). */
export interface MemoryEntry {
  readonly id: string;
  /** The folder it belongs to: a session's canonical root (a saved workspace or repo folder, D14 / D18). */
  readonly scope: string;
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

/** `GET /api/memory/state`: the switch (answered while off too). */
export interface MemoryState {
  readonly enabled: boolean;
  /** On and `memory.db` open. */
  readonly available: boolean;
  /** Why `memory.db` could not be opened (while on), else `null`. */
  readonly problem: string | null;
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
export const MEMORY_CAP_MIN = 500;
export const MEMORY_CAP_MAX = 20_000;
export const MEMORY_TITLE_MAX = 80;
export const MEMORY_TEXT_MAX = 1_000;
export const MEMORY_TAGS_MAX = 8;
export const MEMORY_TAG_MAX = 32;
/** `memory_propose`: at most this many proposals per session per hour. */
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

/** One entry as the block shows it. */
export function memoryEntryText(entry: Pick<MemoryEntry, 'title' | 'text' | 'tags'>): string {
  const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
  const body = entry.text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  return `- ${entry.title}${tags}\n${body}`;
}

/** What {@link memoryBlock} put in and left out. */
export interface MemoryBlockParts {
  readonly text: string;
  readonly included: readonly string[];
  readonly overflow: readonly string[];
}

/**
 * The block a session of a folder gets next to its standing instruction (`null` without approved
 * entries). Only the entries given are used: the caller passes **approved** entries only (the
 * server reads them with `status = 'approved'`). Pinned first, then newest; entries are added while
 * their text fits in `cap` characters; the first that does not fit and every one after it are named
 * on one line (at most {@link MEMORY_OVERFLOW_TITLES} titles) with a pointer to `memory_list`.
 */
export function memoryBlockParts(entries: readonly MemoryEntry[], cap: number, label: string): MemoryBlockParts | null {
  const approved = entries.filter((entry) => entry.status === 'approved');
  if (approved.length === 0) return null;
  const ordered = memoryOrder(approved);
  const lines: string[] = [];
  const included: string[] = [];
  const overflow: string[] = [];
  let used = 0;
  for (const entry of ordered) {
    const text = memoryEntryText(entry);
    if (overflow.length === 0 && used + text.length + (lines.length > 0 ? 1 : 0) <= cap) {
      lines.push(text);
      used += text.length + (lines.length > 1 ? 1 : 0);
      included.push(entry.id);
    } else overflow.push(entry.id);
  }
  const head = [
    MEMORY_BLOCK_START,
    `Folder: ${label}. Durable facts and conventions about this project that the developer reviewed and approved. Treat them as project knowledge. To add one, propose it with the switchboard memory_propose tool (the developer reviews every proposal); do not write project memory anywhere else.`,
  ];
  const tail: string[] = [];
  if (overflow.length > 0) {
    const titles = ordered.filter((entry) => overflow.includes(entry.id)).map((entry) => `"${entry.title}"`);
    const named = titles.slice(0, MEMORY_OVERFLOW_TITLES).join(', ');
    const more = titles.length > MEMORY_OVERFLOW_TITLES ? ` and ${titles.length - MEMORY_OVERFLOW_TITLES} more` : '';
    tail.push(`${overflow.length === 1 ? '1 more approved entry' : `${overflow.length} more approved entries`}, not shown to save space: ${named}${more}. Read them with the switchboard memory_list tool when they matter.`);
  }
  return { text: [...head, ...lines, ...tail, MEMORY_BLOCK_END].join('\n'), included, overflow };
}

/** {@link memoryBlockParts}' text, or `null`. */
export function memoryBlock(entries: readonly MemoryEntry[], cap: number, label: string): string | null {
  return memoryBlockParts(entries, cap, label)?.text ?? null;
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

/** `memory_list`'s answer. */
export function memoryListText(entries: readonly Pick<MemoryEntry, 'title' | 'text' | 'tags'>[], label: string): string {
  if (entries.length === 0) return `No approved project memory for ${label} yet. Propose durable facts with memory_propose.`;
  return [`Project memory for ${label} (approved by the developer), ${entries.length === 1 ? '1 entry' : `${entries.length} entries`}:`, ...entries.map(memoryEntryText)].join('\n');
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
    description: `Propose a project memory entry for this session's folder: a durable, reusable fact or convention about this project that a future session would need, e.g. a build or test command, a gotcha, a decision and its reason, where something lives. Not for task notes, progress or anything only this task needs (use the todo tools for those). Keep it short: one fact per entry, a title of at most ${MEMORY_TITLE_MAX} characters and a text of at most ${MEMORY_TEXT_MAX}. The developer reviews every proposal; it is used only once approved. At most ${MEMORY_PROPOSE_PER_HOUR} proposals per hour; a title close to an existing entry is refused.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `One short line naming the fact (at most ${MEMORY_TITLE_MAX} characters), e.g. "Run the tests with the test ports".` },
        text: { type: 'string', description: `The fact itself, plain and brief (at most ${MEMORY_TEXT_MAX} characters): the command, the rule, the location, and why when it is not obvious.` },
        tags: { type: 'array', items: { type: 'string' }, description: `Optional, up to ${MEMORY_TAGS_MAX} short words, e.g. build, tests, gotcha.` },
      },
      required: ['title', 'text'],
      additionalProperties: false,
    },
    annotations: { title: 'Propose a project memory entry', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'memory_list',
    description: "List this session's folder's project memory: the entries the developer approved (title, text, tags). Proposals still under review are not listed.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List project memory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];
