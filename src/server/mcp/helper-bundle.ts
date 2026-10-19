import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 1.24 perf (`docs/performance.md` → *The MCP helper's footprint*): the stdio helpers every
 * running agent CLI starts (`src/hook/sb-mcp.ts`, the built-in `switchboard` server, and D100-T2's
 * `src/hook/sb-access-mcp.ts`) ship prebuilt as one small JavaScript file each in `dist/hook/`
 * (`npm run build`, and the release package). Run from TypeScript, each helper loaded Node's
 * type stripper (≈31 MB of resident memory) and the module graphs of the MCP SDK and zod
 * unbundled: ≈125 MB per helper, ≈1.8 GB with 16 agents. The bundle is used only while
 * `dist/hook/manifest.json` matches the sources it was built from (each one's SHA-256, and
 * `package-lock.json`'s for the dependencies), so a checkout edited after its last build runs
 * the sources, as before.
 */

/** The helpers that have a bundle. */
export type HelperName = 'sb-mcp' | 'sb-access-mcp';

/** The repository (or install) root. */
export const APP_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** Where the bundles and their manifest are written. */
export const HELPER_BUNDLE_DIR = path.join(APP_ROOT, 'dist', 'hook');

/** The manifest's file name in {@link HELPER_BUNDLE_DIR}. */
export const HELPER_MANIFEST = 'manifest.json';

/** The manifest format this server reads. */
export const HELPER_MANIFEST_FORMAT = 1;

/**
 * Node flags of every helper process: a 1 MB young generation (V8's default grows it to 16 MB
 * per semi-space; a helper handles a call now and then). Measured: −4 MB resident per helper.
 */
export const HELPER_NODE_ARGS: readonly string[] = ['--max-semi-space-size=1'];

/** `dist/hook/manifest.json`. */
export interface HelperManifest {
  readonly format: number;
  /** Per helper: its bundle (relative to the manifest) and each source it holds (app-root-relative path → SHA-256). */
  readonly helpers: Partial<Record<HelperName, { readonly file: string; readonly sources: Readonly<Record<string, string>> }>>;
  /** `package-lock.json`'s SHA-256 (the bundled dependencies' versions). */
  readonly lock: string;
}

/** The source of a helper (what runs without a bundle). */
export function helperSource(name: HelperName, root = APP_ROOT): string {
  return path.join(root, 'src', 'hook', `${name}.ts`);
}

/** SHA-256 of a file's bytes (hex). */
export async function fileSha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/**
 * The bundle of `name` when the manifest in `dir` (default `<root>/dist/hook`) lists it and every source it was built
 * from is unchanged, else `null` (no build, an older build, an edited checkout, an unreadable file).
 */
export async function freshHelperBundle(name: HelperName, root = APP_ROOT, dir = path.join(root, 'dist', 'hook')): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, HELPER_MANIFEST), 'utf8')) as HelperManifest;
    if (manifest.format !== HELPER_MANIFEST_FORMAT) return null;
    const entry = manifest.helpers?.[name];
    if (!entry || typeof entry.file !== 'string' || entry.file.includes('/') || entry.file.includes('\\')) return null;
    if ((await fileSha256(path.join(root, 'package-lock.json'))) !== manifest.lock) return null;
    for (const [relative, hash] of Object.entries(entry.sources)) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) return null;
      if ((await fileSha256(path.join(root, relative))) !== hash) return null;
    }
    const bundle = path.join(dir, entry.file);
    await readFile(bundle);
    return bundle;
  } catch {
    return null;
  }
}

const resolved = new Map<HelperName, Promise<string>>();

/**
 * The script the helper `name` runs as (checked once per server process): its fresh bundle, else
 * its TypeScript source.
 */
export function helperScript(name: HelperName): Promise<string> {
  let script = resolved.get(name);
  if (!script) {
    script = freshHelperBundle(name).then((bundle) => bundle ?? helperSource(name));
    resolved.set(name, script);
  }
  return script;
}
