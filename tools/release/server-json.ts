#!/usr/bin/env node
/**
 * `node tools/release/server-json.ts` (npm's `version` lifecycle script, so `npm version <x.y.z>`
 * runs it): writes `package.json`'s version into `server.json`, the MCP Registry manifest that
 * lists Switchboard's user-facing environment variables for MCP directories
 * (`docs/configuration.md` → *MCP directories*). `tests/docs/server-json.test.ts` fails when the
 * two drift.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The GitHub release asset a version installs from (the README's install blocks use the same URL). */
export function releaseAssetUrl(version: string): string {
  return `https://github.com/MarcinGadomski94/switchboard/releases/download/v${version}/switchboard-${version}.tar.gz`;
}

/** `server.json`'s shape, as far as the version sync touches it. */
interface ServerJson {
  version: string;
  packages?: { version?: string; identifier: string }[];
}

/** `manifest` with every version (and the release asset URL) set to `version`. */
export function withVersion<T extends ServerJson>(manifest: T, version: string): T {
  return {
    ...manifest,
    version,
    ...(manifest.packages
      ? { packages: manifest.packages.map((pkg) => ({ ...pkg, version, identifier: releaseAssetUrl(version) })) }
      : {}),
  };
}

/** Rewrites `<repoDir>/server.json` with `<repoDir>/package.json`'s version; returns that version. */
export async function syncServerJson(repoDir: string): Promise<string> {
  const { version } = JSON.parse(await readFile(path.join(repoDir, 'package.json'), 'utf8')) as { version: string };
  const file = path.join(repoDir, 'server.json');
  const manifest = JSON.parse(await readFile(file, 'utf8')) as ServerJson;
  await writeFile(file, `${JSON.stringify(withVersion(manifest, version), null, 2)}\n`);
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const version = await syncServerJson(repoDir);
  process.stdout.write(`server.json -> ${version}\n`);
}
