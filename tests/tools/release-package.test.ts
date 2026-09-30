import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseChecksum } from '../../src/core/release.ts';
import { extractRelease } from '../../src/server/updates/extract.ts';
import { packageRelease } from '../../tools/release/package.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';

/**
 * D55 `npm run release:package` (`docs/updates.md` → *Release packages*) on a
 * temp git repo: the 1.0.0 layout the updater accepts (git archive under
 * `switchboard-<v>/`, minus the excluded paths, plus `dist/web`), and a
 * `.sha256` that verifies. Read back with the updater's own extraction.
 */

let tmp: string;
beforeEach(async () => {
  tmp = await makeTempDir('release-package');
});
afterEach(async () => {
  await removeTempDir(tmp);
});

function git(cwd: string, ...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} → ${code}`))));
  });
}

async function write(root: string, file: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { recursive: true })) {
    if ((await stat(path.join(dir, entry))).isFile()) out.push(entry.split(path.sep).join('/'));
  }
  return out.sort();
}

describe('packageRelease', () => {
  it('writes the tarball and checksum in the layout the updater installs', async () => {
    const repo = path.join(tmp, 'repo');
    await mkdir(repo);
    await git(repo, 'init', '-q');
    await write(repo, 'package.json', '{"name":"switchboard","version":"1.1.0"}\n');
    await write(repo, 'package-lock.json', '{}\n');
    await write(repo, 'src/server/main.ts', 'export {};\n');
    await write(repo, 'docs/updates.md', '# Updates\n');
    await write(repo, 'docs/visual/inbox.md', 'reference\n');
    await write(repo, 'tests/a.test.ts', 'test\n');
    await write(repo, '.loop/progress.md', 'loop\n');
    await write(repo, 'playwright.config.ts', 'x\n');
    await write(repo, 'vitest.config.ts', 'x\n');
    await write(repo, 'tsconfig.e2e.json', '{}\n');
    await write(repo, `tools/${'long-folder-name/'.repeat(8)}deep.ts`, 'deep\n');
    await write(repo, '.gitignore', 'dist/\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'release');
    // The built UI (ignored by git, as in the real repo).
    await write(repo, 'dist/web/index.html', '<!doctype html>\n');
    await write(repo, 'dist/web/assets/app.js', 'console.log(1);\n');
    const lines: string[] = [];
    const result = await packageRelease({ repoDir: repo, skipBuild: true, outDir: path.join(tmp, 'out'), log: (line) => lines.push(line) });
    expect(path.basename(result.tarball)).toBe('switchboard-1.1.0.tar.gz');
    expect(lines).toEqual(['note: there is no tag v1.1.0 yet (gh release create makes it from the target commit)']);
    const tarball = await readFile(result.tarball);
    const hex = createHash('sha256').update(tarball).digest('hex');
    expect(parseChecksum(await readFile(result.checksumFile, 'utf8'), 'switchboard-1.1.0.tar.gz')).toBe(hex);
    const unpacked = await extractRelease(result.tarball, path.join(tmp, 'x'), 'switchboard-1.1.0/');
    expect(await files(unpacked.root)).toEqual(
      ['.gitignore', 'dist/web/assets/app.js', 'dist/web/index.html', 'docs/updates.md', 'package-lock.json', 'package.json', 'src/server/main.ts', `tools/${'long-folder-name/'.repeat(8)}deep.ts`].sort(),
    );
  });

  it('refuses a dirty tree and a missing UI build', async () => {
    const repo = path.join(tmp, 'repo');
    await mkdir(repo);
    await git(repo, 'init', '-q');
    await write(repo, 'package.json', '{"version":"1.1.0"}\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'x');
    await expect(packageRelease({ repoDir: repo, skipBuild: true, outDir: path.join(tmp, 'out'), log: () => undefined })).rejects.toThrow(/dist\/web\/index.html is missing/);
    await write(repo, 'new.txt', 'x');
    await expect(packageRelease({ repoDir: repo, skipBuild: true, outDir: path.join(tmp, 'out'), log: () => undefined })).rejects.toThrow(/uncommitted changes/);
  });
});
