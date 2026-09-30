/**
 * The release package layout (D55, `docs/updates.md` → *Release packages*),
 * shared by the updater (what it downloads and accepts) and
 * `npm run release:package` (what it writes), so future releases stay
 * installable by the updater. The layout is the one of 1.0.0.
 */

/** The GitHub repository releases come from (`owner/name`); `SWITCHBOARD_UPDATE_REPO` overrides it (forks, tests). */
export const RELEASE_REPO = 'MarcinGadomski94/switchboard';

/** The release tarball of `version`: `switchboard-<version>.tar.gz`. */
export function tarballName(version: string): string {
  return `switchboard-${version}.tar.gz`;
}

/** The checksum asset of `version`: `switchboard-<version>.tar.gz.sha256`. */
export function checksumName(version: string): string {
  return `${tarballName(version)}.sha256`;
}

/** The one top folder every entry of the tarball sits under: `switchboard-<version>/`. */
export function packagePrefix(version: string): string {
  return `switchboard-${version}/`;
}

/** The tag of `version`: `v<version>`. */
export function releaseTag(version: string): string {
  return `v${version}`;
}

/**
 * Paths (repo-relative, `/`-separated) left out of a release package: the tests
 * and their configs, the loop state and the visual oracle's references. Folders
 * end with `/`.
 */
export const RELEASE_EXCLUDED: readonly string[] = ['tests/', '.loop/', 'docs/visual/', 'playwright.config.ts', 'vitest.config.ts', 'tsconfig.e2e.json'];

/** `true` when the repo-relative `file` (or folder) is left out of a release package. */
export function isReleaseExcluded(file: string): boolean {
  const clean = file.replace(/^\.\//, '');
  return RELEASE_EXCLUDED.some((rule) => (rule.endsWith('/') ? clean === rule.slice(0, -1) || clean.startsWith(rule) : clean === rule));
}

/** A `.sha256` file's line, the `sha256sum` / `shasum -a 256` format: `<hex>  <file>\n`. */
export function checksumLine(hex: string, file: string): string {
  return `${hex}  ${file}\n`;
}

/**
 * Reads a `.sha256` file for `file`: one line `<64 hex>  <name>` (also `<hex>
 * *<name>`, the binary-mode marker); the name must be `file`. `null` when the
 * text is not exactly that.
 */
export function parseChecksum(text: string, file: string): string | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length !== 1) return null;
  const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec((lines[0] as string).trim());
  if (!match || match[2] !== file) return null;
  return (match[1] as string).toLowerCase();
}
