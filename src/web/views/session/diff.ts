/**
 * Pure model of the Diff tab (SPEC → Session → Diff; M4.5): the 300px file list
 * and the unified diff of the selected file, from the session's `FileDiff[]`
 * (`GET /api/sessions/{id}/diff`, gap #10). Copy and formats are the prototype's
 * (`docs/handoff/prototype/Switchboard App.dc.html`, `files` / `df`); the rules
 * are in `docs/derivations.md` → *Diff tab*.
 */
import type { FileDiff } from '../../../core/api.ts';
import type { EventKind } from '../../../core/model.ts';

/** The header note while the selected file has uncommitted changes (prototype copy). */
export const NOT_COMMITTED_NOTE = 'Not committed. Commit only when you approve.';

/** The file list's empty state (prototype copy). */
export const NO_CHANGES = 'No changes yet.';

/** How a diff body line is colored: `+` added, `-` removed, anything else context. */
export type DiffTone = 'add' | 'del' | 'ctx';

/** One row of the file list. */
export interface DiffFileRow {
  /** Stable identity across refreshes: solution + path. */
  readonly key: string;
  /** The file name (last path segment). */
  readonly short: string;
  /** `+118`, `+51 −12`, `−4`, or `—` without line changes (binary, empty, mode only). */
  readonly delta: string;
  /** `<solution> · <path>`. */
  readonly sub: string;
  readonly selected: boolean;
}

/** One line of the unified diff, verbatim (its `+` / `-` / space marker included). */
export interface DiffLine {
  readonly text: string;
  readonly tone: DiffTone;
}

/** The right pane: header + body of the selected file. */
export interface DiffPane {
  /** Key of the shown file, `null` without files. */
  readonly key: string | null;
  /** `<solution> / <path>`, empty without files. */
  readonly name: string;
  /** `⎇ <branch>`, empty without a branch (workspace-root files, a detached checkout). */
  readonly branch: string;
  /** Show {@link NOT_COMMITTED_NOTE}: `false` only for a file whose changes are all committed. */
  readonly note: boolean;
  readonly lines: readonly DiffLine[];
}

/** The whole tab. */
export interface DiffModel {
  readonly rows: readonly DiffFileRow[];
  readonly pane: DiffPane;
  /** No changed files: the list shows {@link NO_CHANGES}. */
  readonly empty: boolean;
}

const MINUS = '−';
const NONE = '—';

/**
 * Event kinds after which the diff is fetched again: edits and shell commands
 * (`impl`), loop / self-heal steps, other tools (MCP, subagents), results and
 * failures. Reads (`plan`), questions (`ask`) and chat text change no file (gap #7).
 */
const REFRESH_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['impl', 'loop', 'ok', 'tool', 'error']);

/** `true` when a `/hub` `event` of this kind can change the session's files. */
export function refreshesDiff(kind: EventKind): boolean {
  return REFRESH_KINDS.has(kind);
}

/** Identity of a file across refreshes (a path can repeat across solutions). */
export function fileKey(file: Pick<FileDiff, 'solution' | 'path'>): string {
  return `${file.solution}\u0000${file.path}`;
}

/** The list's `+added −removed` (the prototype's `+51 −12`, U+2212 minus); `—` when neither. */
export function deltaText(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`${MINUS}${removed}`);
  return parts.length > 0 ? parts.join(' ') : NONE;
}

/** The tone of one diff line by its first character. */
export function lineTone(line: string): DiffTone {
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

/** The last `/`-segment of a path (git paths always use `/`). */
export function shortName(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

/**
 * The file the pane shows: the one with `selectedKey`, else the first (a new
 * session, or the selected file left the diff, e.g. its change was reverted).
 */
export function selectedFile(files: readonly FileDiff[], selectedKey: string | null): FileDiff | null {
  if (selectedKey !== null) {
    const found = files.find((file) => fileKey(file) === selectedKey);
    if (found) return found;
  }
  return files[0] ?? null;
}

/** The Diff tab for `files` (server order: per solution, by path) with `selectedKey` picked. */
export function diffModel(files: readonly FileDiff[], selectedKey: string | null): DiffModel {
  const shown = selectedFile(files, selectedKey);
  const shownKey = shown ? fileKey(shown) : null;
  const rows = files.map((file) => {
    const key = fileKey(file);
    return {
      key,
      short: shortName(file.path),
      delta: deltaText(file.added, file.removed),
      sub: `${file.solution} · ${file.path}`,
      selected: key === shownKey,
    };
  });
  const pane: DiffPane = shown
    ? {
        key: shownKey,
        name: `${shown.solution} / ${shown.path}`,
        branch: shown.branch ? `⎇ ${shown.branch}` : '',
        note: shown.uncommitted,
        lines: shown.lines.map((text) => ({ text, tone: lineTone(text) })),
      }
    : { key: null, name: '', branch: '', note: true, lines: [] };
  return { rows, pane, empty: files.length === 0 };
}
