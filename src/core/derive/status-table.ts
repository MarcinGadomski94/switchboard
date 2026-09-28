/**
 * Printed status tables (D21; `docs/derivations.md` → *Agent overview*): the
 * status tables an agent prints in its chat messages, which the right panel's
 * agent overview repeats under its derived table ("As reported by the agent").
 * Pure: the server reads the messages (`src/server/sessions/reported-table.ts`),
 * this decides what is a status table and which one is the newest.
 *
 * A status table is
 * - a **box-drawing** table (┌ ─ ┬ ┐ │ ├ ┼ ┤ └ ┴ ┘), inside a code fence or not:
 *   from a line starting with `┌` through the next line starting with `└` (or the
 *   last line of the run of lines starting with `│` / `├` / `┼` / `└`), or
 * - a **GFM pipe table** outside code fences: a header row, its delimiter row
 *   (`|---|:--:|`, as many cells as the header) and the rows under it (until a
 *   blank line or a line without `|`),
 * whose header row has an `Agent` cell and a `Status` cell (case-insensitive,
 * trimmed). Anything else is not one. The table is kept as printed: its lines
 * verbatim, only their common indentation removed (a fenced box table without
 * its fence lines).
 *
 * D27: the overview draws the table as a readable table, so the kept text is also
 * parsed into its header and rows ({@link parseStatusTable}), and each Status cell
 * gets a status color ({@link reportedStatus}).
 */
import type { SessionStatus } from '../model.ts';


/** How a printed status table is drawn: box-drawing characters, or a GitHub-flavored pipe table. */
export type StatusTableFormat = 'box' | 'gfm';

/** A status table found in a message. */
export interface PrintedStatusTable {
  /** The table's lines as printed (common indentation removed), joined with `\n`. */
  readonly text: string;
  readonly format: StatusTableFormat;
}

/** A chat message that may hold status tables. */
export interface StatusTableMessage {
  /** The message's text as stored (Markdown source). */
  readonly text: string;
  /** When it arrived (ISO); the newest message is the one with the greatest `at`, then `id`. */
  readonly at: string;
  readonly id: number;
}

/** The newest printed status table of a set of messages: its table, format and the message's `at`. */
export interface NewestStatusTable extends PrintedStatusTable {
  readonly at: string;
}

/** The header cells a status table must have (lower case, compared trimmed and case-insensitively). */
export const STATUS_TABLE_COLUMNS: readonly string[] = ['agent', 'status'];

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const DELIMITER_CELL = /^:?-+:?$/;

/** The first non-blank character of a line. */
function lead(line: string): string {
  return line.trimStart().charAt(0);
}

/** `true` when the header cells name both status-table columns. */
function hasStatusColumns(cells: readonly string[]): boolean {
  const names = new Set(cells.map((cell) => cell.trim().toLowerCase()));
  return STATUS_TABLE_COLUMNS.every((column) => names.has(column));
}

/** The lines without their common leading whitespace. */
function dedent(lines: readonly string[]): string {
  const indents = lines.filter((line) => line.trim() !== '').map((line) => line.length - line.trimStart().length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(cut)).join('\n');
}

/** A box-drawing row's cells (`│ a │ b │` → `a`, `b`). */
function boxCells(row: string): string[] {
  const parts = row.trim().split('│');
  if (parts[0]?.trim() === '') parts.shift();
  if (parts.at(-1)?.trim() === '') parts.pop();
  return parts;
}

/** A pipe row's cells: outer pipes dropped, split on unescaped `|`. */
function pipeCells(row: string): string[] {
  let body = row.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/);
}

/** `true` for a GFM delimiter row with `cells` cells (`|---|:---:|`). */
function isDelimiterRow(row: string, cells: number): boolean {
  if (!row.includes('-')) return false;
  const parts = pipeCells(row).map((cell) => cell.trim());
  return parts.length === cells && parts.every((cell) => DELIMITER_CELL.test(cell));
}

/**
 * A box table starting at `lines[start]` (a `┌` line): its last line index and its
 * text, when its header row (the first `│` row) names the status columns.
 */
function boxTableAt(lines: readonly string[], start: number, end: number): { readonly last: number; readonly table: PrintedStatusTable | null } {
  let last = start;
  for (let i = start + 1; i < end; i += 1) {
    const first = lead(lines[i] ?? '');
    if (first !== '│' && first !== '├' && first !== '┼' && first !== '└') break;
    last = i;
    if (first === '└') break;
  }
  const rows = lines.slice(start, last + 1);
  const header = rows.find((row) => lead(row) === '│');
  const table = header !== undefined && hasStatusColumns(boxCells(header)) ? { text: dedent(rows), format: 'box' as const } : null;
  return { last, table };
}

/**
 * A GFM table whose header row is `lines[start]`: its last line index and its
 * text when it is a status table; `null` when `lines[start]` does not start a table.
 */
function pipeTableAt(lines: readonly string[], start: number, end: number): { readonly last: number; readonly table: PrintedStatusTable | null } | null {
  const header = lines[start] ?? '';
  if (!header.includes('|') || /^ {4,}/.test(header) || start + 1 >= end) return null;
  const cells = pipeCells(header);
  if (cells.length < 2 || !isDelimiterRow(lines[start + 1] ?? '', cells.length)) return null;
  let last = start + 1;
  for (let i = start + 2; i < end; i += 1) {
    const row = lines[i] ?? '';
    if (row.trim() === '' || !row.includes('|')) break;
    last = i;
  }
  const table = hasStatusColumns(cells) ? { text: dedent(lines.slice(start, last + 1)), format: 'gfm' as const } : null;
  return { last, table };
}

/**
 * Every status table in a message, in the order printed: box-drawing tables in
 * and outside code fences, GFM pipe tables outside them (a pipe table inside a
 * fence is code, not a table). Tables without an Agent and a Status column are
 * left out.
 */
export function statusTablesIn(text: string): PrintedStatusTable[] {
  const lines = text.split(/\r?\n/);
  const out: PrintedStatusTable[] = [];
  let fence: { readonly char: string; readonly length: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (fence) {
      const close = FENCE_OPEN.exec(line);
      if (close?.[1] && close[1][0] === fence.char && close[1].length >= fence.length && line.trim() === close[1]) {
        fence = null;
        continue;
      }
    } else {
      const open = FENCE_OPEN.exec(line);
      if (open?.[1]) {
        fence = { char: open[1][0] ?? '`', length: open[1].length };
        continue;
      }
    }
    if (lead(line) === '┌') {
      const found = boxTableAt(lines, i, lines.length);
      if (found.table) out.push(found.table);
      i = found.last;
      continue;
    }
    if (!fence) {
      const found = pipeTableAt(lines, i, lines.length);
      if (found) {
        if (found.table) out.push(found.table);
        i = found.last;
      }
    }
  }
  return out;
}

/** The last status table printed in a message (the newest one), or `null`. */
export function lastStatusTable(text: string): PrintedStatusTable | null {
  return statusTablesIn(text).at(-1) ?? null;
}

/** Newest first: the greater `at`, then the greater `id`. */
function newestFirst(a: StatusTableMessage, b: StatusTableMessage): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return b.id - a.id;
}

/**
 * The newest status table among `messages` (any order): the last table of the
 * newest message that has one, with that message's `at`; `null` when none has one.
 */
export function newestStatusTable(messages: Iterable<StatusTableMessage>): NewestStatusTable | null {
  for (const message of [...messages].sort(newestFirst)) {
    const table = lastStatusTable(message.text);
    if (table) return { ...table, at: message.at };
  }
  return null;
}

// ---------------------------------------------------------------------------
// D27: the printed table parsed into its header and rows, and the Status colors.
// ---------------------------------------------------------------------------

/** A printed status table split into cells (D27): the header's cells and each row's, as plain text, trimmed. */
export interface ParsedStatusTable {
  readonly header: string[];
  /** Every row has as many cells as the header. */
  readonly rows: string[][];
}

/** The lines that split a box table into row blocks: its top and bottom borders and its `├…┤` separators. */
const BOX_RULES = new Set(['┌', '├', '┼', '└']);

/**
 * A box-drawing content line's cells (`│ a │ b │` → `a`, `b`, trimmed); `null`
 * when the line does not start and end with `│` (e.g. a line cut short).
 */
function boxLineCells(line: string): string[] | null {
  const body = line.trim();
  if (body.length < 2 || !body.startsWith('│') || !body.endsWith('│')) return null;
  return body
    .slice(1, -1)
    .split('│')
    .map((cell) => cell.trim());
}

/** One row from several text lines: each column's non-blank pieces joined with a single space. */
function joinLines(lines: readonly (readonly string[])[]): string[] {
  const width = lines[0]?.length ?? 0;
  const row: string[] = [];
  for (let column = 0; column < width; column += 1) {
    row.push(
      lines
        .map((line) => line[column] ?? '')
        .filter((piece) => piece !== '')
        .join(' '),
    );
  }
  return row;
}

/** The index of the header's `Status` cell (trimmed, case-insensitive), `-1` without one. */
export function statusColumnIndex(header: readonly string[]): number {
  return header.findIndex((cell) => cell.trim().toLowerCase() === 'status');
}

/**
 * The rows of a body without separator rows between its data rows: one row per
 * line, except that a line whose first cell or Status cell is blank continues the
 * row before it (a cell wrapped onto the next line).
 */
function rowsByLine(lines: readonly (readonly string[])[], status: number): string[][] {
  const groups: Array<Array<readonly string[]>> = [];
  for (const line of lines) {
    const last = groups.at(-1);
    const continues = last !== undefined && (line[0] === '' || (status >= 0 && line[status] === ''));
    if (continues) last.push(line);
    else groups.push([line]);
  }
  return groups.map(joinLines);
}

/**
 * A box-drawing table's header and rows. The columns are the header line's
 * `│`-separated cells (split on the `│` characters, so wide characters such as
 * emoji never shift a column); the `┌` / `├…┤` / `└` lines split the table into
 * blocks. The first block is the header; with separator rows between the data
 * rows every further block is one row, its lines (a cell wrapped over lines)
 * joined per column; without them ({@link rowsByLine}) every line is a row.
 */
function parseBoxTable(text: string): ParsedStatusTable | null {
  const blocks: string[][][] = [];
  let open = false;
  for (const line of text.split(/\r?\n/)) {
    const first = lead(line);
    if (first === '') continue;
    if (BOX_RULES.has(first)) {
      open = false;
      continue;
    }
    if (first !== '│') return null;
    const cells = boxLineCells(line);
    if (!cells) return null;
    if (open) blocks.at(-1)?.push(cells);
    else blocks.push([cells]);
    open = true;
  }
  const width = blocks[0]?.[0]?.length ?? 0;
  if (width === 0 || blocks.some((block) => block.some((cells) => cells.length !== width))) return null;
  // A table without a rule under its header: the header is its first line.
  const [head, ...body] = blocks.length === 1 ? [[blocks[0]?.[0] ?? []], blocks[0]?.slice(1) ?? []] : blocks;
  const header = joinLines(head ?? []);
  const nonEmpty = body.filter((block) => block.length > 0);
  if (nonEmpty.length === 0) return null;
  const rows = nonEmpty.length === 1 ? rowsByLine(nonEmpty[0] ?? [], statusColumnIndex(header)) : nonEmpty.map(joinLines);
  return { header, rows };
}

/** Code spans: a run of backticks, the code, the same run again. */
const CODE_SPAN = /(?<!`)(`+)(.+?)(?<!`)\1(?!`)/g;
/** An ASCII punctuation character escaped with a backslash (CommonMark). */
const ESCAPED = /\\([!-/:-@[-`{-~])/g;
/** Escaped characters are parked in the Private Use Area while emphasis is removed, so `\*` stays a star. */
const PARKED_BASE = 0xe000;
const PARKED = /[-]/g;

/** Inline Markdown outside code spans reduced to its text (links, images, emphasis, strikethrough, escapes). */
function plainMarkdownText(text: string): string {
  return text
    .replace(ESCAPED, (_, char: string) => String.fromCharCode(PARKED_BASE + char.charCodeAt(0)))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, '$1')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, '$1$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/\*(?=[^\s*])([^*]*?)(?<=[^\s*])\*/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])_(?=[^\s_])([^_]*?)(?<=[^\s_])_(?![\p{L}\p{N}_])/gu, '$1$2')
    .replace(PARKED, (char) => String.fromCharCode(char.charCodeAt(0) - PARKED_BASE));
}

/**
 * A pipe-table cell as plain text: trimmed, `\|` unescaped, and inline Markdown
 * reduced to its text (`**x**`, `__x__`, `*x*`, `_x_`, `~~x~~`, `` `x` ``,
 * `[text](url)`, `![alt](url)` and `<url>` → their text; `\*` → `*`). A code
 * span's content is kept verbatim.
 */
export function plainCellText(cell: string): string {
  const text = cell.trim().replace(/\\\|/g, '|');
  let out = '';
  let from = 0;
  for (const match of text.matchAll(CODE_SPAN)) {
    out += plainMarkdownText(text.slice(from, match.index));
    const code = match[2] ?? '';
    out += code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '' ? code.slice(1, -1) : code;
    from = match.index + match[0].length;
  }
  return (out + plainMarkdownText(text.slice(from))).trim();
}

/** A GFM pipe table's header and rows (the delimiter row dropped), each cell through {@link plainCellText}. */
function parsePipeTable(text: string): ParsedStatusTable | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const [headLine, delimiter, ...body] = lines;
  if (headLine === undefined || delimiter === undefined || body.length === 0) return null;
  const header = pipeCells(headLine).map(plainCellText);
  if (!isDelimiterRow(delimiter, header.length)) return null;
  const rows = body.map((line) => pipeCells(line).map(plainCellText));
  if (rows.some((row) => row.length !== header.length)) return null;
  return { header, rows };
}

/**
 * A printed status table (D27) split into its header and rows, every cell as plain
 * text:
 * - **box-drawing**: columns from the `│` separators of the header line; rows
 *   split by the `├…┤` lines (and the `┌` / `└` borders); a row printed over
 *   several lines (its cells wrapped) has each column's lines joined with a single
 *   space, blank continuation pieces ignored; a table without separator rows
 *   between its data rows has one row per line (a line whose first or Status cell
 *   is blank continues the row before it);
 * - **GFM pipe table**: the header and the rows under the delimiter row, `\|`
 *   unescaped and inline Markdown reduced to text ({@link plainCellText}).
 *
 * `null` when the table has no header or no row, or when its lines do not all
 * have the header's number of cells (a line cut short, a stray `│`): the overview
 * then shows the table as printed.
 */
export function parseStatusTable(table: PrintedStatusTable): ParsedStatusTable | null {
  return table.format === 'box' ? parseBoxTable(table.text) : parsePipeTable(table.text);
}

/** The status colors a reported Status cell can have: the SPEC status keys but `paused`. */
export type ReportedStatus = Exclude<SessionStatus, 'paused'>;

/** A reported Status cell: its color key and the text shown (its leading status glyphs removed). */
export interface ReportedStatusCell {
  readonly status: ReportedStatus;
  readonly text: string;
}

/**
 * The status emoji and glyphs (D27), checked before the words: the first one
 * found in the cell decides. `️` (the emoji presentation selector) may follow.
 */
export const STATUS_GLYPHS: Readonly<Record<string, ReportedStatus>> = {
  '🟢': 'run',
  '🔵': 'run',
  '✅': 'done',
  '✓': 'done',
  '✔': 'done',
  '🟡': 'need',
  '🟠': 'need',
  '⏳': 'need',
  '⏸': 'need',
  '❌': 'fail',
  '✕': 'fail',
  '✖': 'fail',
  '✗': 'fail',
  '🔴': 'fail',
};

/** The status words (D27), whole words and case-insensitive, checked when no glyph decided: the first one in the cell decides. */
export const STATUS_WORDS: Readonly<Record<string, ReportedStatus>> = {
  running: 'run',
  testing: 'run',
  'in progress': 'run',
  done: 'done',
  merged: 'done',
  green: 'done',
  queued: 'need',
  waiting: 'need',
  blocked: 'need',
  needs: 'need',
  failed: 'fail',
};

/** What a Status cell that holds only a status glyph reads (the derived table's words: `● running`, `✓ done`, `⏸ waiting`, `✕ failed`). */
export const STATUS_GLYPH_WORDS: Readonly<Record<Exclude<ReportedStatus, 'idle'>, string>> = {
  run: 'running',
  done: 'done',
  need: 'waiting',
  fail: 'failed',
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GLYPH_ALTERNATIVES = Object.keys(STATUS_GLYPHS).map(escapeRegExp).join('|');
const GLYPH = new RegExp(`(${GLYPH_ALTERNATIVES})`, 'u');
const LEADING_GLYPHS = new RegExp(`^(?:(?:${GLYPH_ALTERNATIVES})\\uFE0F?\\s*)+`, 'u');
const WORD = new RegExp(
  `(?<![\\p{L}\\p{N}_])(${Object.keys(STATUS_WORDS)
    .map((word) => escapeRegExp(word).replace(/ /g, '[\\s-]+'))
    .join('|')})(?![\\p{L}\\p{N}_])`,
  'iu',
);

/**
 * A reported Status cell's color and text (D27). The color: the first status
 * glyph in the cell ({@link STATUS_GLYPHS}), else the first status word
 * ({@link STATUS_WORDS}, whole words, case-insensitive; `in progress` also with a
 * hyphen), else `idle`. The text: the cell without its leading status glyphs; a
 * cell that was only a glyph reads {@link STATUS_GLYPH_WORDS} (`🟢` → `running`).
 */
export function reportedStatus(cell: string): ReportedStatusCell {
  const text = cell.trim();
  const glyph = GLYPH.exec(text)?.[1];
  const word = glyph === undefined ? WORD.exec(text)?.[1] : undefined;
  const status: ReportedStatus =
    (glyph !== undefined ? STATUS_GLYPHS[glyph] : undefined) ??
    (word !== undefined ? STATUS_WORDS[word.toLowerCase().replace(/[\s-]+/g, ' ')] : undefined) ??
    'idle';
  const shown = text.replace(LEADING_GLYPHS, '').trim();
  if (shown === '' && text !== '' && status !== 'idle') return { status, text: STATUS_GLYPH_WORDS[status] };
  return { status, text: shown };
}
