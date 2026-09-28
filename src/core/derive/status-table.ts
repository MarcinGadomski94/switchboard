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
 */

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
