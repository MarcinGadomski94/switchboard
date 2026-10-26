#!/usr/bin/env node
/**
 * `node tools/release/server-json.ts` (npm's `version` lifecycle script, so `npm version <x.y.z>`
 * runs it): writes `package.json`'s version into `server.json`, the MCP Registry manifest that
 * lists Switchboard's user-facing environment variables for MCP directories
 * (`docs/configuration.md` → *MCP directories*), into the npx installer package
 * `packages/npx/package.json` (`@marcingadomski94/switchboard`, `docs/publishing.md`), whose
 * version the manifest's npm entry names, and into the manual install blocks of
 * `docs/setup.md` (`V=x.y.z`, `$V = "x.y.z"`). `tests/docs/server-json.test.ts` fails when they drift.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The npm package `server.json` points at: the npx installer in `packages/npx`. */
export const NPM_PACKAGE = '@marcingadomski94/switchboard';

/** The GitHub release asset a version installs from (the installers and the manual install download it). */
export function releaseAssetUrl(version: string): string {
  return `https://github.com/MarcinGadomski94/switchboard/releases/download/v${version}/switchboard-${version}.tar.gz`;
}

/** `server.json`'s shape, as far as the version sync touches it. */
interface ServerJson {
  version: string;
  packages?: { version?: string; identifier: string; registryType?: string }[];
}

/**
 * `manifest` with every version set to `version`; a `github-release` entry's asset URL
 * follows the version too, an `npm` entry keeps its package name.
 */
export function withVersion<T extends ServerJson>(manifest: T, version: string): T {
  return {
    ...manifest,
    version,
    ...(manifest.packages
      ? { packages: manifest.packages.map((pkg) => ({ ...pkg, version, ...(pkg.registryType === 'github-release' ? { identifier: releaseAssetUrl(version) } : {}) })) }
      : {}),
  };
}

/** `text` (`docs/setup.md`) with the manual install's version lines (`V=x.y.z`, `$V = "x.y.z"`) set to `version`. */
export function withSetupVersion(text: string, version: string): string {
  return text.replace(/^V=\d+\.\d+\.\d+$/gm, `V=${version}`).replace(/^\$V = "\d+\.\d+\.\d+"$/gm, `$V = "${version}"`);
}

/**
 * Rewrites `<repoDir>/server.json`, `<repoDir>/docs/setup.md` and `<repoDir>/packages/npx/package.json` with
 * `<repoDir>/package.json`'s version; returns that version.
 */
export async function syncServerJson(repoDir: string): Promise<string> {
  const { version } = JSON.parse(await readFile(path.join(repoDir, 'package.json'), 'utf8')) as { version: string };
  const file = path.join(repoDir, 'server.json');
  const manifest = JSON.parse(await readFile(file, 'utf8')) as ServerJson;
  await writeFile(file, `${JSON.stringify(withVersion(manifest, version), null, 2)}\n`);
  const npxFile = path.join(repoDir, 'packages', 'npx', 'package.json');
  const npx = JSON.parse(await readFile(npxFile, 'utf8')) as Record<string, unknown>;
  await writeFile(npxFile, `${JSON.stringify({ ...npx, version }, null, 2)}\n`);
  const setup = path.join(repoDir, 'docs', 'setup.md');
  await writeFile(setup, withSetupVersion(await readFile(setup, 'utf8'), version));
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const version = await syncServerJson(repoDir);
  process.stdout.write(`server.json, packages/npx/package.json, docs/setup.md -> ${version}\n`);
}
