/**
 * The small part of Semantic Versioning the updater needs (D55,
 * `docs/updates.md`): `MAJOR.MINOR.PATCH` with an optional pre-release and build
 * part, a `v` prefix accepted on tags, and precedence as semver.org §11 defines it.
 */

/** A parsed version. `prerelease` is empty for a release. */
export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
  /** The canonical text: `1.2.3` or `1.2.3-rc.1` (no `v`, no build part). */
  readonly text: string;
}

const NUMBER = '0|[1-9]\\d*';
const IDENT = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)';
const PATTERN = new RegExp(`^v?(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`);

/**
 * Parses `1.2.3`, `v1.2.3`, `1.2.3-rc.1`, `1.2.3+build`; `null` for anything
 * else (leading zeros, missing parts, spaces, numbers beyond the safe range).
 */
export function parseSemVer(text: string): SemVer | null {
  const match = PATTERN.exec(text.trim());
  if (!match) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  const core = `${major}.${minor}.${patch}`;
  return { major, minor, patch, prerelease, text: prerelease.length > 0 ? `${core}-${prerelease.join('.')}` : core };
}

function compareIdentifier(a: string, b: string): number {
  const numA = /^\d+$/.test(a);
  const numB = /^\d+$/.test(b);
  if (numA && numB) return Math.sign(Number(a) - Number(b));
  if (numA) return -1;
  if (numB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Precedence: `-1` when `a` < `b`, `0` when equal (build parts ignored), `1` when `a` > `b`. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  // A pre-release sorts before its release.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const n = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const order = compareIdentifier(x, y);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * `true` when `candidate` is a **release** (no pre-release part) newer than
 * `current`. Unparseable input is never newer.
 */
export function isNewerRelease(candidate: string, current: string): boolean {
  const next = parseSemVer(candidate);
  const now = parseSemVer(current);
  if (!next || !now || next.prerelease.length > 0) return false;
  return compareSemVer(next, now) > 0;
}
