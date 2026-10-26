import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/net.ts';
import { releaseAssetUrl, withVersion } from '../../tools/release/server-json.ts';

/**
 * `server.json` (the MCP Registry manifest MCP directories read for the environment
 * variables, `docs/configuration.md` → *MCP directories*) must follow `package.json`'s
 * version, and list only variables `docs/configuration.md` documents, none of them
 * test-only. `npm version` keeps it in step (`tools/release/server-json.ts`).
 */
const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'server.json'), 'utf8')) as {
  version: string;
  packages: { version: string; identifier: string; environmentVariables: { name: string; description: string; isSecret?: boolean }[] }[];
};
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
const configDoc = readFileSync(path.join(REPO_ROOT, 'docs/configuration.md'), 'utf8');

describe('server.json', () => {
  it("carries package.json's version everywhere", () => {
    expect(manifest.version).toBe(pkg.version);
    for (const entry of manifest.packages) {
      expect(entry.version).toBe(pkg.version);
      expect(entry.identifier).toBe(releaseAssetUrl(pkg.version));
    }
    expect(withVersion(manifest, pkg.version)).toEqual(manifest);
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
