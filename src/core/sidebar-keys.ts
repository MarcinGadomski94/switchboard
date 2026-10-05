/**
 * D71 · order keys of the sidebar layout (`docs/sidebar.md` → *Shared layout
 * (D71)*): every pinned session, every session in a folder, every manually
 * ordered loose session and every folder among its siblings carries a short
 * string; a group is shown sorted by it (ties by id). Moving one item writes a
 * new key **between its neighbours'** and touches nothing else, so two machines
 * that each move a different item merge cleanly (last write wins per item).
 *
 * Keys are base-36 digits (`0-9a-z`, compared as plain strings, which is the
 * digits' order) and never end in `0`, so there is always a key between two
 * different keys.
 */

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

function digit(value: number): string {
  return DIGITS[value] as string;
}

function value(key: string, at: number): number {
  const index = DIGITS.indexOf(key[at] as string);
  if (index < 0) throw new Error(`not a sidebar order key: ${JSON.stringify(key)}`);
  return index;
}

/** `true` for a key this module writes (or migration 0029's `000000i`…): base-36 digits, not ending in `0`, not empty. */
export function isOrderKey(key: unknown): key is string {
  return typeof key === 'string' && /^[0-9a-z]{1,200}$/.test(key) && !key.endsWith('0');
}

/**
 * A key strictly between `before` and `after` (`null` = no bound on that side).
 * @throws when `before` is not smaller than `after`.
 */
export function keyBetween(before: string | null, after: string | null): string {
  const low = before ?? '';
  if (after !== null && low >= after) throw new Error(`no order key between ${JSON.stringify(low)} and ${JSON.stringify(after)}`);
  let high = after;
  let out = '';
  for (let i = 0; ; i++) {
    const a = i < low.length ? value(low, i) : 0;
    const b = high !== null && i < high.length ? value(high, i) : BASE;
    if (a === b) {
      out += digit(a);
      continue;
    }
    if (b - a > 1) {
      const lowOpen = i >= low.length;
      const highOpen = high === null || i >= high.length;
      // Appending / prepending steps by one digit (keys stay short); between two bounds, or with neither, the middle.
      if (highOpen && !lowOpen) return out + digit(a + 1);
      if (lowOpen && !highOpen) return out + digit(b - 1);
      // Past a carry (`low`'s digits used up, nothing above): an append takes the smallest next digit, a prepend the
      // largest, leaving room for the next ones, so either grows by one digit per ~35 keys.
      if (lowOpen && highOpen && i > 0) return out + digit(before === null ? BASE - 1 : 1);
      return out + digit(Math.floor((a + b) / 2));
    }
    // Adjacent digits: keep `a` here; from now on anything above `low`'s rest is below `high`.
    out += digit(a);
    high = null;
  }
}

/**
 * `count` increasing keys strictly between `before` and `after`, spread by
 * halving (so their length grows with log2(count), not with count).
 */
export function keysBetween(before: string | null, after: string | null, count: number): string[] {
  if (count <= 0) return [];
  const middle = keyBetween(before, after);
  const left = Math.floor((count - 1) / 2);
  return [...keysBetween(before, middle, left), middle, ...keysBetween(middle, after, count - 1 - left)];
}

/** Sort order of keyed items: the key, then the id (two machines may write the same key). */
export function compareKeyed(a: { readonly key: string; readonly id: string }, b: { readonly key: string; readonly id: string }): number {
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The positions (indexes into `keys`) of a longest strictly increasing run of
 * keys, `null` entries skipped: the items that keep their keys when a group is
 * re-ordered (only the others get new ones).
 */
export function longestIncreasing(keys: ReadonlyArray<string | null>): Set<number> {
  const tails: number[] = [];
  const previous = new Array<number>(keys.length).fill(-1);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === null || key === undefined) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((keys[tails[mid] as number] as string) < key) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1] as number;
    tails[lo] = i;
  }
  const out = new Set<number>();
  let at = tails.length > 0 ? (tails[tails.length - 1] as number) : -1;
  while (at >= 0) {
    out.add(at);
    at = previous[at] as number;
  }
  return out;
}

/**
 * The keys of a group shown in `ids` order, keeping every key it can: `current`
 * gives an item's key when it may keep it (it was in this group), else `null`.
 * Answers the key per id and the ids whose key is new.
 */
export function rekeyGroup(ids: readonly string[], current: (id: string) => string | null): { readonly keys: Map<string, string>; readonly changed: Set<string> } {
  const existing = ids.map((id) => {
    const key = current(id);
    return key !== null && isOrderKey(key) ? key : null;
  });
  const kept = longestIncreasing(existing);
  const keys = new Map<string, string>();
  const changed = new Set<string>();
  let i = 0;
  while (i < ids.length) {
    if (kept.has(i)) {
      keys.set(ids[i] as string, existing[i] as string);
      i++;
      continue;
    }
    let end = i;
    while (end < ids.length && !kept.has(end)) end++;
    const before = i > 0 ? (keys.get(ids[i - 1] as string) ?? null) : null;
    const after = end < ids.length ? (existing[end] as string) : null;
    const fresh = keysBetween(before, after, end - i);
    for (let j = i; j < end; j++) {
      keys.set(ids[j] as string, fresh[j - i] as string);
      changed.add(ids[j] as string);
    }
    i = end;
  }
  return { keys, changed };
}
