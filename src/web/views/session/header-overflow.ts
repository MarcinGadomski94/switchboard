/**
 * D74 follow-up (`docs/responsive.md` → *Header actions in a narrow session column*):
 * the session header's actions adapt to the width the header really has (a narrow
 * session column next to the right panel / sidebar), not only to the window's.
 * When everything fits nothing changes; when it does not, long labels shorten first
 * ("Move to <machine> ▸" → "Move ▸"), then actions move into a ⋯ menu in this
 * order (first = first to go). Below 1024 px D74's own ⋯ menu holds them all.
 */
export const OVERFLOW_ORDER = ['takeover', 'handoff', 'remote', 'close', 'account', 'cli', 'pause', 'model'] as const;

/** One overflowable header action. */
export type OverflowKey = (typeof OVERFLOW_ORDER)[number];

/** How the header renders its actions. */
export interface HeaderOverflow {
  /** Long labels shortened (the take-over action). */
  readonly short: boolean;
  /** Actions in the ⋯ menu, in {@link OVERFLOW_ORDER}. */
  readonly hidden: readonly OverflowKey[];
}

export const NO_OVERFLOW: HeaderOverflow = { short: false, hidden: [] };

/** Width assumed for an action never measured in the row. */
const UNKNOWN_WIDTH = 120;
/** Width assumed for the short take-over label before it was measured. */
const UNKNOWN_SHORT_WIDTH = 70;

/** What {@link headerOverflow} decides from. */
export interface OverflowInput {
  /** Room for the actions (and the ⋯ button) in the top row, px. */
  readonly available: number;
  /** The gap between actions (and before the ⋯ button), px. */
  readonly gap: number;
  /** The ⋯ button's width, px. */
  readonly moreWidth: number;
  /** The actions present now (inline or in the menu). */
  readonly present: readonly OverflowKey[];
  /** Their widths in the row, full labels. */
  readonly widths: Readonly<Partial<Record<OverflowKey, number>>>;
  /** Their widths with short labels. */
  readonly shortWidths: Readonly<Partial<Record<OverflowKey, number>>>;
}

/** Pure: the least change that makes the actions fit (`NO_OVERFLOW` when they already do). */
export function headerOverflow(input: OverflowInput): HeaderOverflow {
  const present = OVERFLOW_ORDER.filter((key) => input.present.includes(key));
  const width = (key: OverflowKey, short: boolean): number =>
    short && key === 'takeover' ? (input.shortWidths[key] ?? UNKNOWN_SHORT_WIDTH) : (input.widths[key] ?? UNKNOWN_WIDTH);
  const needed = (short: boolean, hidden: readonly OverflowKey[]): number => {
    const shown = present.filter((key) => !hidden.includes(key));
    let total = shown.reduce((sum, key) => sum + width(key, short), 0) + Math.max(0, shown.length - 1) * input.gap;
    if (hidden.length > 0) total += input.moreWidth + (shown.length > 0 ? input.gap : 0);
    return total;
  };
  const fits = (short: boolean, hidden: readonly OverflowKey[]): boolean => needed(short, hidden) <= input.available + 0.5;
  if (fits(false, [])) return NO_OVERFLOW;
  const shortens = present.includes('takeover');
  if (shortens && fits(true, [])) return { short: true, hidden: [] };
  for (let count = 1; count <= present.length; count++) {
    const hidden = present.slice(0, count);
    if (fits(shortens, hidden)) return { short: shortens, hidden };
  }
  return { short: shortens, hidden: present };
}
