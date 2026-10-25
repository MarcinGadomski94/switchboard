import { NEEDS_FILTERS, NEEDS_FILTER_OF, type NeedsFilter } from '../glossary.ts';
import type { NeedsCrew, NeedsItem } from '../shared/needs-you-model.ts';

/**
 * D131 · the Needs-you page's filters (lane H; the prototype's `qfilter`): one
 * chip per kind group (`NEEDS_FILTERS`: All, Questions, Approvals, Ready for
 * approval, Notes & setup, Asks, Stopped & alerts) and one per crew. Pure and
 * unit-tested (`tests/web/v2-home.test.ts`); `index.tsx` renders it.
 */

/** A crew chip's filter value. */
export type CrewFilter = `crew:${string}`;

/** What the page shows: a kind group (or All), or one crew's items. */
export type PageFilter = NeedsFilter | CrewFilter;

/** The key a crew is told apart by (its id; its name, else its teammate, for a crew tag without an id). */
export function crewKey(crew: Pick<NeedsCrew, 'id' | 'name' | 'teammate'>): string {
  return crew.id ?? (crew.name || crew.teammate);
}

/** `true` when `item` is shown under `filter`. */
export function matchesFilter(item: Pick<NeedsItem, 'kind' | 'crew'>, filter: PageFilter): boolean {
  if (filter === 'all') return true;
  if (filter.startsWith('crew:')) return item.crew !== null && crewKey(item.crew) === filter.slice(5);
  return NEEDS_FILTER_OF[item.kind] === filter;
}

/** The items shown under `filter` (the queue's order kept). */
export function applyFilter<T extends Pick<NeedsItem, 'kind' | 'crew'>>(items: readonly T[], filter: PageFilter): T[] {
  return items.filter((item) => matchesFilter(item, filter));
}

/** How many items each kind chip has (`all` = every item). */
export function kindCounts(items: readonly Pick<NeedsItem, 'kind'>[]): Readonly<Record<NeedsFilter, number>> {
  const counts = Object.fromEntries(NEEDS_FILTERS.map((filter) => [filter, 0])) as Record<NeedsFilter, number>;
  for (const item of items) {
    counts.all += 1;
    counts[NEEDS_FILTER_OF[item.kind]] += 1;
  }
  return counts;
}

/** One crew chip. */
export interface CrewChip {
  readonly filter: CrewFilter;
  readonly label: string;
  readonly count: number;
}

/**
 * One chip per crew with items waiting, by name; the chip of the selected crew
 * stays (with 0) once its last item is answered, so the page does not jump.
 */
export function crewChips(items: readonly Pick<NeedsItem, 'crew'>[], selected: PageFilter = 'all'): CrewChip[] {
  const chips = new Map<string, { label: string; count: number }>();
  for (const item of items) {
    if (!item.crew) continue;
    const key = crewKey(item.crew);
    if (!key) continue;
    const chip = chips.get(key) ?? { label: item.crew.name || item.crew.teammate, count: 0 };
    chip.count += 1;
    chips.set(key, chip);
  }
  if (selected.startsWith('crew:') && !chips.has(selected.slice(5))) chips.set(selected.slice(5), { label: selected.slice(5), count: 0 });
  return [...chips.entries()].map(([key, chip]) => ({ filter: `crew:${key}` as CrewFilter, label: chip.label, count: chip.count })).sort((a, b) => a.label.localeCompare(b.label));
}

/** `true` for a known kind group or a crew filter (`?filter=` in the address). */
export function isPageFilter(value: string | null | undefined): value is PageFilter {
  if (!value) return false;
  return (NEEDS_FILTERS as readonly string[]).includes(value) || (value.startsWith('crew:') && value.length > 5);
}

/** The card to focus after ↑ / ↓ (wrapping, as the prototype does); `-1` with no cards. */
export function stepIndex(current: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : length - 1;
  return (current + delta + length) % length;
}
