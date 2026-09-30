import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExtractError, entrySegments, extractRelease } from '../../../src/server/updates/extract.ts';
import { type TarInput, writeTarGz } from '../../../src/server/updates/tar.ts';
import { packageEntries } from '../../helpers/fake-github.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

/** D55: safe extraction of a release tarball (`docs/updates.md` → *Extraction*). */

const PREFIX = 'switchboard-1.1.0/';
let tmp: string;
beforeEach(async () => {
  tmp = await makeTempDir('extract');
});
afterEach(async () => {
  await removeTempDir(tmp);
});

async function archive(entries: TarInput[]): Promise<string> {
  const file = path.join(tmp, `a-${Math.random().toString(36).slice(2)}.tar.gz`);
  await writeTarGz(entries, file);
  return file;
}

async function list(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const name of await readdir(d)) {
      const full = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if ((await stat(full)).isDirectory()) await walk(full, r);
      else out.push(r);
    }
  };
  await walk(dir, '');
  return out.sort();
}

describe('entrySegments', () => {
  it('accepts plain paths under the prefix', () => {
    expect(entrySegments('switchboard-1.1.0/', PREFIX)).toEqual([]);
    expect(entrySegments('switchboard-1.1.0/src/a.ts', PREFIX)).toEqual(['src', 'a.ts']);
    expect(entrySegments('./switchboard-1.1.0//src/./a.ts', PREFIX)).toEqual(['src', 'a.ts']);
  });

  it('refuses traversal, absolute paths, other prefixes and names Windows cannot hold', () => {
    for (const bad of [
      'switchboard-1.1.0/../evil',
      'switchboard-1.1.0/a/../../evil',
      '../switchboard-1.1.0/a',
      '/etc/passwd',
      'C:/Windows/x',
      'c:evil',
      'switchboard-1.1.0\\..\\evil',
      'switchboard-1.0.9/a',
      'other/a',
      'a',
      'switchboard-1.1.0/NUL',
      'switchboard-1.1.0/com1.txt',
      'switchboard-1.1.0/a:stream',
      'switchboard-1.1.0/trailing.',
      'switchboard-1.1.0/a\0b',
    ]) {
      expect(() => entrySegments(bad, PREFIX), bad).toThrow(ExtractError);
    }
  });
});

describe('extractRelease', () => {
  it('unpacks a release package under its top folder (executable bit kept)', async () => {
    const entries = [...packageEntries('1.1.0'), { path: `${PREFIX}tools/run.sh`, type: 'file', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 } satisfies TarInput];
    const dest = path.join(tmp, 'staging');
    const result = await extractRelease(await archive(entries), dest, PREFIX);
    expect(result.root).toBe(path.join(dest, 'switchboard-1.1.0'));
    expect(await list(dest)).toEqual(
      ['README.md', 'dist/web/index.html', 'package-lock.json', 'package.json', 'src/server/main.ts', 'tools/run.sh'].map((f) => `switchboard-1.1.0/${f}`),
    );
    expect(JSON.parse(await readFile(path.join(result.root, 'package.json'), 'utf8')).version).toBe('1.1.0');
    if (process.platform !== 'win32') {
      expect((await stat(path.join(result.root, 'tools', 'run.sh'))).mode & 0o777).toBe(0o755);
      expect((await stat(path.join(result.root, 'README.md'))).mode & 0o777).toBe(0o644);
    }
  });

  const refused: Array<[string, TarInput[], RegExp]> = [
    ['a path that leaves the folder', [{ path: `${PREFIX}../evil.txt`, type: 'file', data: Buffer.from('x') }], /leaves its folder/],
    ['an absolute path', [{ path: '/tmp/evil.txt', type: 'file', data: Buffer.from('x') }], /absolute/],
    ['another top folder', [{ path: 'switchboard-9.9.9/a', type: 'file', data: Buffer.from('x') }], /not under switchboard-1.1.0/],
    ['a symbolic link', [{ path: `${PREFIX}link`, type: 'symlink', linkname: '/etc' }], /is a link/],
    ['a relative symbolic link', [{ path: `${PREFIX}link`, type: 'symlink', linkname: 'src' }], /is a link/],
    ['a hard link', [{ path: `${PREFIX}hard`, type: 'hardlink', linkname: `${PREFIX}package.json` }], /is a link/],
    ['a duplicate file', [{ path: `${PREFIX}a`, type: 'file', data: Buffer.from('1') }, { path: `${PREFIX}a`, type: 'file', data: Buffer.from('2') }], /appears twice/],
  ];
  for (const [what, entries, message] of refused) {
    it(`refuses ${what} and writes nothing outside the staging folder`, async () => {
      const dest = path.join(tmp, 'staging');
      await expect(extractRelease(await archive(entries), dest, PREFIX)).rejects.toThrow(message);
      expect(await readdir(tmp)).not.toContain('evil.txt');
    });
  }

  it('refuses special files (a FIFO entry)', async () => {
    const file = path.join(tmp, 'fifo.tar');
    const { tarBuffer } = await import('../../../src/server/updates/tar.ts');
    const raw = tarBuffer([{ path: `${PREFIX}fifo`, type: 'file' }]);
    raw.write('6', 156, 1, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (raw[i] ?? 0);
    raw.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    const { gzipSync } = await import('node:zlib');
    await writeFile(file, gzipSync(raw));
    await expect(extractRelease(file, path.join(tmp, 'staging'), PREFIX)).rejects.toThrow(/not a file or folder/);
  });

  it('enforces the size and entry limits', async () => {
    const big = [{ path: PREFIX, type: 'dir' }, { path: `${PREFIX}big`, type: 'file', data: Buffer.alloc(4096) }] satisfies TarInput[];
    await expect(extractRelease(await archive(big), path.join(tmp, 's1'), PREFIX, { maxBytes: 1000, maxEntries: 100 })).rejects.toThrow(/more than 1000 bytes/);
    await expect(extractRelease(await archive(packageEntries('1.1.0')), path.join(tmp, 's2'), PREFIX, { maxBytes: 1e9, maxEntries: 3 })).rejects.toThrow(/more than 3 entries/);
  });

  it('refuses a file that is not gzip', async () => {
    const file = path.join(tmp, 'junk.tar.gz');
    await writeFile(file, 'not a tarball');
    await expect(extractRelease(file, path.join(tmp, 'staging'), PREFIX)).rejects.toThrow(ExtractError);
  });
});
