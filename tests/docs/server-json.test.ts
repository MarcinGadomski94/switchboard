import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/net.ts';
import { NPM_PACKAGE, releaseAssetUrl, withSetupVersion, withVersion } from '../../tools/release/server-json.ts';

/**
 * `server.json` (the MCP Registry manifest MCP directories read for the environment
 * variables, `docs/configuration.md` → *MCP directories*) must follow `package.json`'s
 * version, and list only variables `docs/configuration.md` documents, none of them
 * test-only. `npm version` keeps it in step (`tools/release/server-json.ts`).
 */
const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'server.json'), 'utf8')) as {
  version: string;
  name: string;
  packages: { registryType: string; version: string; identifier: string; environmentVariables: { name: string; description: string; isSecret?: boolean }[] }[];
};
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
const npx = JSON.parse(readFileSync(path.join(REPO_ROOT, 'packages/npx/package.json'), 'utf8')) as { name: string; version: string; mcpName?: string };
const configDoc = readFileSync(path.join(REPO_ROOT, 'docs/configuration.md'), 'utf8');

describe('server.json', () => {
  it("carries package.json's version everywhere, the npx package's too", () => {
    expect(manifest.version).toBe(pkg.version);
    for (const entry of manifest.packages) expect(entry.version).toBe(pkg.version);
    expect(withVersion(manifest, pkg.version)).toEqual(manifest);
    expect(npx.version).toBe(pkg.version);
  });

  it('points at the npx installer package, which names the server for the MCP Registry', () => {
    expect(manifest.packages.map((entry) => [entry.registryType, entry.identifier])).toEqual([['npm', NPM_PACKAGE]]);
    expect(npx.name).toBe(NPM_PACKAGE);
    expect(npx.mcpName).toBe(manifest.name);
  });

  it("gives docs/setup.md's manual install blocks package.json's version", () => {
    const setup = readFileSync(path.join(REPO_ROOT, 'docs/setup.md'), 'utf8');
    expect(setup.match(/^V=.*$/gm)).toEqual([`V=${pkg.version}`, `V=${pkg.version}`]);
    expect(setup.match(/^\$V = .*$/gm)).toEqual([`$V = "${pkg.version}"`]);
    expect(withSetupVersion(setup, pkg.version)).toBe(setup);
    expect(withSetupVersion('V=1.0.0\n$V = "1.0.0"\nkeep V=1.0.0\n', '1.2.3')).toBe('V=1.2.3\n$V = "1.2.3"\nkeep V=1.0.0\n');
  });

  it('moves a github-release asset URL with the version, never an npm name', () => {
    const moved = withVersion({ version: '1.0.0', packages: [{ registryType: 'github-release', version: '1.0.0', identifier: releaseAssetUrl('1.0.0') }, { registryType: 'npm', version: '1.0.0', identifier: NPM_PACKAGE }] }, '1.2.3');
    expect(moved.packages.map((entry) => [entry.version, entry.identifier])).toEqual([['1.2.3', releaseAssetUrl('1.2.3')], ['1.2.3', NPM_PACKAGE]]);
  });

  it('lists only documented, user-facing, non-secret variables', () => {
    const names = manifest.packages.flatMap((entry) => entry.environmentVariables.map((variable) => variable.name));
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const variable of manifest.packages.flatMap((entry) => entry.environmentVariables)) {
      expect(configDoc, variable.name).toContain(`\`${variable.name}\``);
      expect(variable.name).not.toMatch(/_TEST_|^SWITCHBOARD_(DEMO|WEB_ROOT|VITE_WATCH|E2E_|TEST_)/);
      expect(variable.description.trim()).not.toBe('');
      expect(variable.isSecret ?? false).toBe(false);
    }
  });
});
