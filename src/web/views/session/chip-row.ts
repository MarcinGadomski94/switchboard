/**
 * D104 (`docs/responsive.md` → *Session header: title and chips*): the session
 * header's chip row folds to one line. When the chips need more than one line,
 * the row shows the chips that fit plus a "+N more ▾" toggle; "▴ less" folds it
 * again. The choice is remembered per session in this browser (folded by default).
 * Pure parts: the chips' order, the fitting and the storage.
 */
import type { SessionChip } from '../../../core/api.ts';

/** One chip as the header shows it. */
export interface HeaderChip {
  /** Stable React key. */
  readonly id: string;
  /** The muted key (`work`, `scope`…); `null` for the second and later solutions of the scope. */
  readonly k: string | null;
  readonly v: string;
  readonly loop: boolean;
  /** A solution of the session's scope (shown after the status chips). */
  readonly scope: boolean;
}

/**
 * The header's chips in the order they show: the status chips first (work, mode,
 * phase, stack, ultracode, loops / runs: the session's state), then the scope, one
 * chip per solution (the first keyed `scope`), so folding the row hides solutions
 * before anything about the session's state. A `scope` chip without the
 * session's solutions (an older peer) stays one chip.
 */
export function headerChips(chips: readonly SessionChip[], solutions: readonly string[]): HeaderChip[] {
  const status: HeaderChip[] = [];
  const scope: HeaderChip[] = [];
  for (const chip of chips) {
    if (chip.k !== 'scope') {
      status.push({ id: `${chip.k} ${chip.v}`, k: chip.k, v: chip.v, loop: chip.loop, scope: false });
    } else if (solutions.length === 0) {
      scope.push({ id: `${chip.k} ${chip.v}`, k: chip.k, v: chip.v, loop: chip.loop, scope: true });
    } else {
      solutions.forEach((solution, index) => scope.push({ id: `scope ${solution}`, k: index === 0 ? 'scope' : null, v: solution, loop: false, scope: true }));
    }
  }
  return [...status, ...scope];
}

/** What {@link foldChips} decides from (px). */
export interface FoldInput {
  /** The row's inner width. */
  readonly available: number;
  /** The gap between chips. */
  readonly gap: number;
  /** Each chip's natural (one-line) width, in display order. */
  readonly widths: readonly number[];
  /** The "+N more ▾" toggle's width with `hidden` chips behind it. */
  readonly toggleWidth: (hidden: number) => number;
}

/**
 * Pure: `null` when every chip fits on one line (no toggle, nothing changes);
 * otherwise how many chips the folded row shows before its toggle (at least one;
 * a chip that is wider than what is left is cut with … by the CSS).
 */
export function foldChips(input: FoldInput): number | null {
  const { available, gap, widths } = input;
  const count = widths.length;
  const slack = 0.5;
  const sum = (end: number): number => widths.slice(0, end).reduce((total, width) => total + width, 0) + Math.max(0, end - 1) * gap;
  if (count <= 1 || sum(count) <= available + slack) return null;
  for (let shown = count - 1; shown >= 1; shown--) {
    if (sum(shown) + gap + input.toggleWidth(count - shown) <= available + slack) return shown;
  }
  return 1;
}

/** The folded toggle's label. */
export function moreLabel(hidden: number): string {
  return `+${hidden} more ▾`;
}

/** The unfolded toggle's label. */
export const LESS_LABEL = '▴ less';

/** `localStorage` key: the sessions whose chip row is unfolded (`true`) or folded (`false`), newest last. */
export const CHIP_ROWS_KEY = 'switchboard.chipRows';

/** At most this many sessions are remembered (the newest). */
const MAX_REMEMBERED = 200;

/** The minimal storage this needs (`window.localStorage`; tests pass a map). */
export interface FoldStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function readRows(storage: FoldStorage | null): Record<string, boolean> {
  try {
    const raw = storage?.getItem(CHIP_ROWS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
  } catch {
    return {};
  }
}

/** Whether the session's chip row is unfolded in this browser (`false`, folded, by default). */
export function loadChipsExpanded(storage: FoldStorage | null, sessionId: string): boolean {
  return readRows(storage)[sessionId] ?? false;
}

/** Remembers the session's choice (the newest {@link MAX_REMEMBERED} sessions are kept). */
export function saveChipsExpanded(storage: FoldStorage | null, sessionId: string, expanded: boolean): void {
  const all = readRows(storage);
  delete all[sessionId];
  all[sessionId] = expanded;
  try {
    storage?.setItem(CHIP_ROWS_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-MAX_REMEMBERED))));
  } catch {
    // Storage blocked: the choice lasts this page only.
  }
}
