#!/usr/bin/env node
/**
 * `npm run release:package -- [--ref <git ref>] [--out <folder>] [--skip-build] [--allow-dirty]`
 * (D55, `docs/updates.md` → *Release packages*): writes
 * `switchboard-<version>.tar.gz` and `switchboard-<version>.tar.gz.sha256` in the
 * layout of 1.0.0, the one the updater accepts: `git archive` of the ref under
 * `switchboard-<version>/`, without the tests, the loop state, the visual
 * references and the test configs (`RELEASE_EXCLUDED`), plus the built UI in
 * `dist/web`. The version is `package.json`'s. It prints the `gh release create`
 * command; it never publishes anything itself.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checksumLine, checksumName, isReleaseExcluded, packagePrefix, releaseTag, tarballName } from '../../src/core/release.ts';
import { parseSemVer } from '../../src/core/semver.ts';
import { type TarInput, walkTar, writeTarGz } from '../../src/server/updates/tar.ts';

/** Options of {@link packageRelease}. */
export interface PackageOptions {
  /** The repository (default: this one). */
  readonly repoDir: string;
  /** What `git archive` packs (default `HEAD`). */
  readonly ref?: string;
  /** Where the two files go (default `<repo>/dist/release`). */
  readonly outDir?: string;
  /** Skip `vite build` (the UI in `dist/web` is used as it is). */
  readonly skipBuild?: boolean;
  /** Package even with uncommitted changes (the UI would be built from them). */
  readonly allowDirty?: boolean;
  readonly log?: (line: string) => void;
}

/** What {@link packageRelease} wrote. */
export interface PackageResult {
  readonly version: string;
  readonly tarball: string;
  readonly checksumFile: string;
  readonly sha256: string;
  readonly entries: number;
}

function run(command: string, args: readonly string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The files of `ref` as `git archive` gives them (paths repo-relative), without the excluded ones. */
async function archiveEntries(repoDir: string, ref: string, prefix: string): Promise<TarInput[]> {
  const child = spawn('git', ['archive', '--format=tar', ref], { cwd: repoDir, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const entries: TarInput[] = [];
  await walkTar(child.stdout, {
    entry(entry) {
      const relative = entry.path.replace(/\/+$/, '');
      if (relative === '' || isReleaseExcluded(entry.type === 'dir' ? `${relative}/` : relative)) return null;
      if (entry.type === 'dir') {
        entries.push({ path: `${prefix}${relative}/`, type: 'dir', mode: 0o755, mtime: entry.mtime });
        return null;
      }
      if (entry.type !== 'file') throw new Error(`${relative} is a ${entry.type}; release packages hold files and folders only`);
      const chunks: Buffer[] = [];
      return {
        write: async (chunk) => {
          chunks.push(Buffer.from(chunk));
        },
        close: async () => {
          entries.push({ path: `${prefix}${relative}`, type: 'file', mode: (entry.mode & 0o111) !== 0 ? 0o755 : 0o644, mtime: entry.mtime, data: Buffer.concat(chunks) });
        },
      };
    },
  });
  const code = await closed;
  if (code !== 0) throw new Error(`git archive ${ref} failed: ${stderr.trim()}`);
  return entries;
}

/** Every file and folder under `dir`, as tar entries under `as` (sorted, so the package is reproducible for the same build). */
async function folderEntries(dir: string, as: string, mtime: number): Promise<TarInput[]> {
  const out: TarInput[] = [{ path: `${as}/`, type: 'dir', mode: 0o755, mtime }];
  const names = (await readdir(dir)).sort();
  for (const name of names) {
    const full = path.join(dir, name);
    const info = await stat(full);
    if (info.isDirectory()) out.push(...(await folderEntries(full, `${as}/${name}`, mtime)));
    else if (info.isFile()) out.push({ path: `${as}/${name}`, type: 'file', mode: 0o644, mtime, data: await readFile(full) });
  }
  return out;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Builds the UI (unless skipped) and writes the release package of
 * `package.json`'s version.
 * @throws when the tree is dirty (without `allowDirty`), the build or `git archive` fails, or `dist/web` is missing.
 */
export async function packageRelease(options: PackageOptions): Promise<PackageResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const repoDir = path.resolve(options.repoDir);
  const ref = options.ref ?? 'HEAD';
  const pkg = JSON.parse(await readFile(path.join(repoDir, 'package.json'), 'utf8')) as { version?: unknown };
  const version = typeof pkg.version === 'string' ? pkg.version : '';
  if (!parseSemVer(version)) throw new Error(`package.json's version "${version}" is not a version`);
  const status = await run('git', ['status', '--porcelain'], repoDir);
  if (status.code !== 0) throw new Error(`git status failed: ${status.stderr.trim()}`);
  if (status.stdout.trim() !== '' && !options.allowDirty) throw new Error('the working tree has uncommitted changes (commit them, or pass --allow-dirty)');
  const tagged = await run('git', ['rev-parse', '--verify', '--quiet', `${releaseTag(version)}^{commit}`], repoDir);
  const head = await run('git', ['rev-parse', '--verify', `${ref}^{commit}`], repoDir);
  if (head.code !== 0) throw new Error(`${ref} is not a commit`);
  if (tagged.code !== 0) log(`note: there is no tag ${releaseTag(version)} yet (gh release create makes it from the target commit)`);
  else if (tagged.stdout.trim() !== head.stdout.trim()) log(`warning: ${releaseTag(version)} is not ${ref}`);
  if (!options.skipBuild) {
    log('building the UI (vite build)…');
    const build = await run(process.execPath, [path.join(repoDir, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], repoDir);
    if (build.code !== 0) throw new Error(`vite build failed:\n${build.stderr || build.stdout}`);
  }
  const web = path.join(repoDir, 'dist', 'web');
  try {
    await stat(path.join(web, 'index.html'));
  } catch {
    throw new Error('dist/web/index.html is missing: build the UI first (npm run build)');
  }
  const prefix = packagePrefix(version);
  const committed = await archiveEntries(repoDir, ref, prefix);
  const mtime = committed.find((entry) => entry.mtime)?.mtime ?? Math.floor(Date.now() / 1000);
  const entries: TarInput[] = [{ path: prefix, type: 'dir', mode: 0o755, mtime }, ...committed];
  if (!committed.some((entry) => entry.path === `${prefix}dist/`)) entries.push({ path: `${prefix}dist/`, type: 'dir', mode: 0o755, mtime });
  entries.push(...(await folderEntries(web, `${prefix}dist/web`, mtime)));
  const outDir = path.resolve(options.outDir ?? path.join(repoDir, 'dist', 'release'));
  await mkdir(outDir, { recursive: true });
  const tarball = path.join(outDir, tarballName(version));
  await writeTarGz(entries, tarball);
  const hex = await sha256(tarball);
  const checksumFile = path.join(outDir, checksumName(version));
  await writeFile(checksumFile, checksumLine(hex, tarballName(version)));
  return { version, tarball, checksumFile, sha256: hex, entries: entries.length };
}

function parseArgs(argv: readonly string[]): Omit<PackageOptions, 'repoDir'> | string {
  const out: { ref?: string; outDir?: string; skipBuild?: boolean; allowDirty?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ref') out.ref = argv[++i] ?? '';
    else if (arg === '--out') out.outDir = argv[++i] ?? '';
    else if (arg === '--skip-build') out.skipBuild = true;
    else if (arg === '--allow-dirty') out.allowDirty = true;
    else return `unknown argument ${String(arg)}`;
  }
  if (out.ref === '' || out.outDir === '') return '--ref and --out need a value';
  return out;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    console.error(`release:package: ${args}\nusage: npm run release:package -- [--ref <ref>] [--out <folder>] [--skip-build] [--allow-dirty]`);
    process.exit(2);
  }
  try {
    const repoDir = path.resolve(import.meta.dirname, '..', '..');
    const result = await packageRelease({ repoDir, ...args });
    const rel = (file: string): string => {
      const relative = path.relative(process.cwd(), file);
      return relative && !relative.startsWith('..') ? relative : file;
    };
    console.log(`wrote ${rel(result.tarball)} (${result.entries} entries)\nwrote ${rel(result.checksumFile)}\nsha256 ${result.sha256}\n`);
    console.log('Publish it (the tag is created from the pushed commit if it does not exist):');
    console.log(`  gh release create ${releaseTag(result.version)} "${rel(result.tarball)}" "${rel(result.checksumFile)}" --title "Switchboard ${result.version}" --notes-file <notes.md>`);
  } catch (error) {
    console.error(`release:package: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
