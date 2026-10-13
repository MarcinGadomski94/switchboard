/**
 * D97 · search across everything (`docs/search.md`): the wire types of
 * `GET /api/search`, the query language (user text → a safe FTS5 MATCH
 * expression), what an event contributes to the index, and the snippets with
 * their highlighted matches. Pure: no I/O; the server and the page share it.
 */
import { withoutSessionStartBlock } from './first-turn.ts';
import type { SessionMachine } from './peers.ts';

// ── wire types ───────────────────────────────────────────────────────────

/** The result groups, in the order the page shows them. */
export const SEARCH_SCOPES = ['conversations', 'artifacts', 'todos', 'history'] as const;
/** One result group: a session's messages and titles, saved artifacts, todos, History rows. */
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** `true` for a {@link SearchScope}. */
export function isSearchScope(value: unknown): value is SearchScope {
  return typeof value === 'string' && (SEARCH_SCOPES as readonly string[]).includes(value);
}

/** A run of a snippet or title: `match` = the query matched it (drawn highlighted; plain text, never HTML). */
export interface SearchSegment {
  readonly text: string;
  readonly match?: true;
}

/** Where a result leads. Session ids of a paired machine's results are remote ids (`r~<machine>~<id>`). */
export type SearchTarget =
  /** A chat message or step: the session's chat, scrolled to that event (`agentId` = a subagent's: its chat). */
  | { readonly type: 'event'; readonly sessionId: string; readonly eventId: number; readonly agentId: string | null }
  /** A session's title, name or task: the session. */
  | { readonly type: 'session'; readonly sessionId: string }
  /** A saved artifact: the session's Artifacts tab on it (the Artifacts page when its session is gone). */
  | { readonly type: 'artifact'; readonly sessionId: string | null; readonly artifactId: string }
  /** A todo: its card in the session's todo strip. */
  | { readonly type: 'todo'; readonly sessionId: string; readonly todoId: string }
  /** A terminal conversation's History row. */
  | { readonly type: 'history'; readonly claudeSessionId: string };

/** What a result is (its row's label). */
export type SearchResultKind = 'message' | 'note' | 'prompt' | 'tool' | 'session' | 'artifact' | 'todo' | 'history';

/** One hit. */
export interface SearchResult {
  /** Unique in the answer: `e:<eventId>`, `session:<id>`, `artifact:<id>`, `todo:<id>`, `history:<claude session id>`; a paired machine's: `r~<machine>~…`. */
  readonly id: string;
  readonly scope: SearchScope;
  readonly kind: SearchResultKind;
  /** The row's heading (a session's or todo's title, an artifact's title, a conversation's name; for a message: its session's title). */
  readonly title: readonly SearchSegment[];
  /** The text around the first match (≈ {@link SNIPPET_CHARS} characters), matches marked. */
  readonly snippet: readonly SearchSegment[];
  /** The session it belongs to (display title), when it has one. */
  readonly sessionTitle: string | null;
  /** For a message: user / agent / tool line label (`Bash`, …); else `null`. */
  readonly detail: string | null;
  readonly ts: string;
  /** Ranking: lower is better (bm25 with a recency boost); comparable across machines only roughly. */
  readonly score: number;
  readonly target: SearchTarget;
  /** D48: a paired machine's result. */
  readonly machine?: SessionMachine;
}

/** One scope's results. */
export interface SearchGroup {
  readonly scope: SearchScope;
  /** Every match of the scope (this machine's + the paired machines' searched). */
  readonly count: number;
  readonly results: readonly SearchResult[];
  /** Pass as `cursor` (with `scope` = this one) for the next page; `null` = no more. */
  readonly nextCursor: string | null;
}

/** A paired machine that was not searched, and why (offline, too slow, an older Switchboard, …). */
export interface SearchNotSearched {
  readonly machine: SessionMachine;
  readonly reason: string;
}

/** The startup backfill of the index (`indexing` while it runs: results may miss older history). */
export interface SearchIndexing {
  readonly done: boolean;
  /** 0–100. */
  readonly percent: number;
}

/** `GET /api/search` answer. */
export interface SearchAnswer {
  /** The query as understood (`""` = nothing to search). */
  readonly query: string;
  /** One group per scope asked (`scope` absent / `all`: every scope, in {@link SEARCH_SCOPES} order). */
  readonly groups: readonly SearchGroup[];
  readonly indexing: SearchIndexing;
  /** Paired machines that were not searched (empty when all answered or none is paired). */
  readonly notSearched: readonly SearchNotSearched[];
}

/** Results per group when every scope is asked (`limit` default). */
export const SEARCH_ALL_LIMIT = 5;
/** Results per page of one scope (`limit` default). */
export const SEARCH_PAGE_LIMIT = 20;
/** The largest `limit`. */
export const SEARCH_LIMIT_MAX = 50;
/** The longest query taken (characters). */
export const SEARCH_QUERY_MAX = 200;
/** At most this many terms / phrases. */
export const SEARCH_TERMS_MAX = 12;
/** A snippet's length (characters, about). */
export const SNIPPET_CHARS = 180;

// ── the query ────────────────────────────────────────────────────────────

/** One part of a query: a word, a word prefix (`word*`) or a quoted phrase. */
export interface QueryTerm {
  /** The words (one for a word or prefix), normalized ({@link normalizeWord}). */
  readonly words: readonly string[];
  readonly prefix: boolean;
  readonly phrase: boolean;
}

/** Lower case, diacritics removed (what the index's `unicode61 remove_diacritics 2` tokenizer does to a token). */
export function normalizeWord(word: string): string {
  return word.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** The tokens of a text as the index sees them: runs of letters and digits (anything else separates). */
export function tokenize(text: string): string[] {
  return (text.match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).map(normalizeWord).filter((word) => word !== '');
}

/**
 * The query language (`docs/search.md` → *Query*): words (all must match, in any
 * order), `"quoted phrases"` (the words next to each other, in order) and `prefix*`
 * (a word starting so). Every other character is text: FTS5 operators and syntax
 * (`AND`, `OR`, `NOT`, `NEAR`, `:`, `^`, `(`, `-`, `+`) are searched as words or
 * dropped, never interpreted. An unclosed quote runs to the end.
 */
export function parseSearchQuery(text: string): QueryTerm[] {
  const input = text.slice(0, SEARCH_QUERY_MAX);
  const terms: QueryTerm[] = [];
  const re = /"([^"]*)"?|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null && terms.length < SEARCH_TERMS_MAX) {
    if (match[1] !== undefined) {
      const words = tokenize(match[1]);
      if (words.length > 0) terms.push({ words, prefix: false, phrase: words.length > 1 });
      continue;
    }
    const raw = match[2] ?? '';
    const prefix = raw.endsWith('*');
    const words = tokenize(raw);
    if (words.length === 0) continue;
    // `foo.bar` / `snake_case` are one phrase of their tokens (as the index split them).
    terms.push({ words, prefix, phrase: words.length > 1 });
  }
  return terms;
}

/** The FTS5 MATCH expression of `terms` (`null` when there is nothing to search): each a quoted string, so nothing is syntax. */
export function matchExpression(terms: readonly QueryTerm[]): string | null {
  if (terms.length === 0) return null;
  // Tokens are letters and digits only, so they never hold a quote; quoting them makes every word a plain string.
  return terms.map((term) => `"${term.words.join(' ')}"${term.prefix ? ' *' : ''}`).join(' AND ');
}

/** The query as understood, for the answer (`"phrase" word prefix*`). */
export function queryText(terms: readonly QueryTerm[]): string {
  return terms.map((term) => (term.phrase ? `"${term.words.join(' ')}"` : `${term.words[0] ?? ''}${term.prefix ? '*' : ''}`)).join(' ');
}

// ── snippets ─────────────────────────────────────────────────────────────

/** Whitespace collapsed (a snippet is one line). */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * `text` as segments with the query's matches marked: the whole text when it is at
 * most `max` characters, else a window of about `max` around the first match (or
 * the start), with `…` where it was cut. Whitespace is collapsed.
 */
export function highlight(text: string, terms: readonly QueryTerm[], max: number = SNIPPET_CHARS): SearchSegment[] {
  const line = oneLine(text);
  const tokens: Array<{ readonly start: number; readonly end: number; readonly word: string }> = [];
  const re = /[\p{L}\p{N}\p{M}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) tokens.push({ start: m.index, end: m.index + m[0].length, word: normalizeWord(m[0]) });
  const same = (token: string, word: string, prefix: boolean): boolean => (prefix ? token.startsWith(word) : token === word);
  // Each term's occurrences: a word where it matches, a phrase where its words follow one another.
  const ranges: Array<readonly [start: number, end: number]> = [];
  let focusHit: readonly [number, number] | null = null;
  for (const term of terms) {
    const n = term.words.length;
    for (let i = 0; i + n <= tokens.length; i += 1) {
      let ok = true;
      for (let k = 0; k < n && ok; k += 1) ok = same(tokens[i + k]?.word ?? '', term.words[k] ?? '', term.prefix && k === n - 1);
      if (!ok) continue;
      // A phrase is marked as one run (its words and what separates them).
      const range = [tokens[i]?.start ?? 0, tokens[i + n - 1]?.end ?? 0] as const;
      ranges.push(range);
      // The window centres on the first occurrence of the first term that has one (the phrase, when it leads).
      focusHit ??= range;
    }
  }
  // In text order, overlapping runs joined.
  const hits: Array<[number, number]> = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = hits[hits.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else hits.push([start, end]);
  }
  let from = 0;
  let to = line.length;
  if (line.length > max) {
    const first = focusHit ?? hits[0];
    const centre = first ? first[0] : 0;
    from = Math.max(0, centre - Math.floor(max / 3));
    // Start at a word boundary when the cut is inside a word.
    if (from > 0) {
      const space = line.indexOf(' ', from);
      if (space !== -1 && space < centre) from = space + 1;
    }
    to = Math.min(line.length, from + max);
    if (to < line.length) {
      const space = line.lastIndexOf(' ', to);
      if (space > (first ? first[1] : from)) to = space;
    }
  }
  const segments: SearchSegment[] = [];
  const push = (part: string, match: boolean): void => {
    if (part === '') return;
    const last = segments[segments.length - 1];
    if (last && (last.match === true) === match) segments[segments.length - 1] = match ? { text: last.text + part, match: true } : { text: last.text + part };
    else segments.push(match ? { text: part, match: true } : { text: part });
  };
  if (from > 0) push('…', false);
  let at = from;
  for (const [start, end] of hits) {
    if (end <= from || start >= to) continue;
    const s = Math.max(start, from);
    const e = Math.min(end, to);
    push(line.slice(at, s), false);
    push(line.slice(s, e), true);
    at = e;
  }
  push(line.slice(at, to), false);
  if (to < line.length) push('…', false);
  return segments;
}

/** The plain text of segments. */
export function segmentsText(segments: readonly SearchSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}

// ── what an event contributes ────────────────────────────────────────────

/** A tool call's input text indexed at most (characters). */
export const INDEX_TOOL_INPUT_MAX = 2000;
/** A tool call's result text indexed at most (characters). */
export const INDEX_TOOL_RESULT_MAX = 2000;
/** A message's text indexed at most (characters; longer messages are rare: the recorder keeps up to 1 MB). */
export const INDEX_MESSAGE_MAX = 32_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `true` for text that is not worth indexing: binary (NUL / replacement characters) or a long run without spaces (base64, minified data). */
export function looksBinary(text: string): boolean {
  if (/[\u0000�]/.test(text)) return true;
  return /[A-Za-z0-9+/=_-]{400,}/.test(text);
}

/** The string values of a tool input, in order (nested ones too), each on its own line. */
function inputStrings(input: unknown, out: string[], depth = 0): void {
  if (depth > 4) return;
  if (typeof input === 'string') out.push(input);
  else if (Array.isArray(input)) for (const item of input) inputStrings(item, out, depth + 1);
  else if (isRecord(input)) for (const value of Object.values(input)) inputStrings(value, out, depth + 1);
}

/** What kind of message an event is, for the result row (`null` = not indexed). */
export function eventResultKind(payload: unknown): Extract<SearchResultKind, 'message' | 'note' | 'prompt' | 'tool'> | null {
  if (!isRecord(payload)) return null;
  switch (payload['type']) {
    case 'user':
      return 'message';
    case 'assistant':
      return payload['note'] === true ? 'note' : 'message';
    case 'agent-prompt':
      return 'prompt';
    case 'tool':
      return 'tool';
    default:
      return null;
  }
}

/**
 * The text an event contributes to the index (`""` = not indexed), `docs/search.md`
 * → *What is indexed*: a user message (without the session-start block), the
 * agent's text and progress notes (D96), a subagent's prompt; a tool call's name,
 * its input's strings (the first {@link INDEX_TOOL_INPUT_MAX} characters) and its
 * result (the first {@link INDEX_TOOL_RESULT_MAX}); binary-looking parts are left
 * out. Lifecycle lines, results, permission requests and the like are not indexed.
 */
export function eventSearchText(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const text = typeof payload['text'] === 'string' ? payload['text'] : '';
  switch (payload['type']) {
    case 'user':
      if (payload['withdrawn'] === true) return '';
      return withoutSessionStartBlock(text).slice(0, INDEX_MESSAGE_MAX);
    case 'assistant':
    case 'agent-prompt':
      return text.slice(0, INDEX_MESSAGE_MAX);
    case 'tool': {
      const parts: string[] = [];
      if (typeof payload['name'] === 'string') parts.push(payload['name']);
      const strings: string[] = [];
      inputStrings(payload['input'], strings);
      const input = strings.filter((s) => !looksBinary(s)).join('\n').slice(0, INDEX_TOOL_INPUT_MAX);
      if (input !== '') parts.push(input);
      const result = typeof payload['result'] === 'string' ? payload['result'] : '';
      if (result !== '' && !looksBinary(result.slice(0, 8000))) parts.push(result.slice(0, INDEX_TOOL_RESULT_MAX));
      return parts.join('\n');
    }
    default:
      return '';
  }
}

/** The row's detail for an event: `You`, `Agent`, `Note`, `Prompt`, or the tool's name. */
export function eventDetail(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  switch (payload['type']) {
    case 'user':
      return 'You';
    case 'assistant':
      return payload['note'] === true ? 'Agent · note' : 'Agent';
    case 'agent-prompt':
      return 'Subagent prompt';
    case 'tool':
      return typeof payload['name'] === 'string' ? payload['name'] : 'Tool';
    default:
      return null;
  }
}

// ── cursors ──────────────────────────────────────────────────────────────

/** A page position: this machine's offset and each paired machine's (by machine id). */
export interface SearchCursor {
  readonly local: number;
  readonly peers: Readonly<Record<string, number>>;
}

/** Encodes a cursor (base64url JSON). */
export function encodeSearchCursor(cursor: SearchCursor): string {
  const json = JSON.stringify({ l: cursor.local, ...(Object.keys(cursor.peers).length > 0 ? { p: cursor.peers } : {}) });
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes a cursor; `null` for anything malformed. */
export function decodeSearchCursor(text: string): SearchCursor | null {
  if (!/^[A-Za-z0-9_-]{1,2000}$/.test(text)) return null;
  try {
    const value: unknown = JSON.parse(atob(text.replace(/-/g, '+').replace(/_/g, '/')));
    if (!isRecord(value)) return null;
    const local = value['l'];
    if (typeof local !== 'number' || !Number.isInteger(local) || local < 0 || local > 100_000) return null;
    const peers: Record<string, number> = {};
    if (value['p'] !== undefined) {
      if (!isRecord(value['p'])) return null;
      for (const [id, offset] of Object.entries(value['p'])) {
        if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 100_000) return null;
        peers[id] = offset;
      }
    }
    return { local, peers };
  } catch {
    return null;
  }
}
