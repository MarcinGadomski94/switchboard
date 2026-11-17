/**
 * D174 (`docs/worktrees.md` → *Side by side (D174)*): a file's unified diff (`FileDiff.lines`:
 * `@@` hunk headers, then ` ` / `-` / `+` lines) as two aligned columns: the file before (left)
 * and after (right), with each side's line numbers. Context lines sit on both sides; a block of
 * removed lines and the added lines right after it are paired row by row (a changed line reads
 * across), the shorter side padded with empty cells. Pure: the Changes tab renders the rows.
 */

/** How a cell looks: unchanged, removed (left), added (right), or an empty pad. */
export type SideTone = 'ctx' | 'del' | 'add' | 'empty';

/** One side of a row: its line number on that side (`null` for a pad) and its text (no `+` / `-` / ` ` marker). */
export interface SideCell {
  readonly no: number | null;
  readonly text: string;
  readonly tone: SideTone;
}

/** A row: a hunk header across both columns, or a pair of cells. */
export type SideRow = { readonly kind: 'hunk'; readonly text: string } | { readonly kind: 'pair'; readonly left: SideCell; readonly right: SideCell };

/** The `-a,b +c,d` starts of a hunk header (`@@ -12,5 +12,7 @@ fn`), `null` when it is not one. */
export function hunkStarts(header: string): { readonly old: number; readonly new: number } | null {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  return match ? { old: Number(match[1]), new: Number(match[2]) } : null;
}

const EMPTY: SideCell = { no: null, text: '', tone: 'empty' };

/** The unified lines as side-by-side rows (see the module comment). */
export function sideBySide(lines: readonly string[]): SideRow[] {
  const rows: SideRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  let removed: SideCell[] = [];
  let added: SideCell[] = [];
  const flush = (): void => {
    const n = Math.max(removed.length, added.length);
    for (let i = 0; i < n; i++) rows.push({ kind: 'pair', left: removed[i] ?? EMPTY, right: added[i] ?? EMPTY });
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.startsWith('@@')) {
      flush();
      const starts = hunkStarts(line);
      if (starts) {
        oldNo = starts.old;
        newNo = starts.new;
      }
      rows.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file": about the line before, not a line of the file.
      continue;
    } else if (line.startsWith('-')) {
      removed.push({ no: oldNo++, text: line.slice(1), tone: 'del' });
    } else if (line.startsWith('+')) {
      added.push({ no: newNo++, text: line.slice(1), tone: 'add' });
    } else {
      flush();
      const text = line.startsWith(' ') ? line.slice(1) : line;
      rows.push({ kind: 'pair', left: { no: oldNo++, text, tone: 'ctx' }, right: { no: newNo++, text, tone: 'ctx' } });
    }
  }
  flush();
  return rows;
}

/** How the Changes tab lays a file's diff out: one column (`unified`) or two (`split`). */
export type DiffLayout = 'unified' | 'split';

/** `localStorage` key of the layout picked in this browser. */
export const DIFF_LAYOUT_KEY = 'switchboard.diffLayout';

/** Below this width the tab shows one column whatever was picked (a phone, a narrow window). */
export const SPLIT_MIN_QUERY = '(max-width: 719px)';

/** The layout this browser picked (`unified` when none, or storage is blocked). */
export function loadDiffLayout(storage: { getItem(key: string): string | null } | null): DiffLayout {
  try {
    return storage?.getItem(DIFF_LAYOUT_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

/** Remembers the layout in this browser. */
export function saveDiffLayout(storage: { setItem(key: string, value: string): void } | null, layout: DiffLayout): void {
  try {
    storage?.setItem(DIFF_LAYOUT_KEY, layout);
  } catch {
    // Storage blocked: the pick lasts this page only.
  }
}
