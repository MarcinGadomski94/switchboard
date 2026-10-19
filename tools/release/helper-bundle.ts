#!/usr/bin/env node
/**
 * `node tools/release/helper-bundle.ts` (part of `npm run build` and the release package): bundles
 * the MCP helpers (`src/hook/sb-mcp.ts`, `src/hook/sb-access-mcp.ts`) with their dependencies into
 * one minified ES module each in `dist/hook/`, plus `manifest.json` (the sources each was built
 * from, with their SHA-256, and `package-lock.json`'s). The server runs a bundle only while that
 * manifest matches (`src/server/mcp/helper-bundle.ts`, `docs/performance.md` → *The MCP helper's
 * footprint*).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { HELPER_MANIFEST, HELPER_MANIFEST_FORMAT, type HelperManifest, type HelperName, fileSha256, helperSource } from '../../src/server/mcp/helper-bundle.ts';

const HELPERS: readonly HelperName[] = ['sb-mcp', 'sb-access-mcp'];

/** Builds every helper's bundle in `outDir` (default `<repoDir>/dist/hook`) and writes the manifest; returns it. */
export async function buildHelperBundles(repoDir: string, log: (line: string) => void = () => undefined, outDir = path.join(repoDir, 'dist', 'hook')): Promise<HelperManifest> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const helpers: Record<string, { file: string; sources: Record<string, string> }> = {};
  for (const name of HELPERS) {
    const result = await build({
      configFile: false,
      root: repoDir,
      logLevel: 'warn',
      publicDir: false,
      build: {
        ssr: helperSource(name, repoDir),
        outDir,
        emptyOutDir: false,
        minify: true,
        target: 'node24',
        copyPublicDir: false,
        reportCompressedSize: false,
        rollupOptions: { output: { format: 'esm', entryFileNames: `${name}.js`, codeSplitting: false } },
      },
      // Everything in the one file: the helper never reads node_modules.
      ssr: { noExternal: true, target: 'node' },
    });
    const outputs = (Array.isArray(result) ? result : [result]) as Array<{ output?: Array<{ type: string; fileName: string; moduleIds?: string[] }> }>;
    const chunk = outputs.flatMap((out) => out.output ?? []).find((item) => item.type === 'chunk' && item.fileName === `${name}.js`);
    if (!chunk) throw new Error(`the ${name} bundle was not written`);
    const sources: Record<string, string> = {};
    for (const id of chunk.moduleIds ?? []) {
      if (!path.isAbsolute(id) || id.includes(`${path.sep}node_modules${path.sep}`)) continue;
      const relative = path.relative(repoDir, id);
      if (relative.startsWith('..')) continue;
      sources[relative.split(path.sep).join('/')] = await fileSha256(id);
    }
    if (Object.keys(sources).length === 0) throw new Error(`the ${name} bundle names no source`);
    helpers[name] = { file: `${name}.js`, sources };
    log(`${path.relative(repoDir, path.join(outDir, `${name}.js`))} (${Object.keys(sources).length} sources)`);
  }
  const manifest: HelperManifest = { format: HELPER_MANIFEST_FORMAT, helpers, lock: await fileSha256(path.join(repoDir, 'package-lock.json')) };
  await writeFile(path.join(outDir, HELPER_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.main) {
  try {
    await buildHelperBundles(path.resolve(import.meta.dirname, '..', '..'), (line) => console.log(line));
  } catch (error) {
    console.error(`helper bundle: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
