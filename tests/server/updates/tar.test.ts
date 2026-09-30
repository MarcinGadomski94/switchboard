import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TarEntry, TarError, type TarInput, tarBuffer, walkTar, walkTarGz, writeTarGz } from '../../../src/server/updates/tar.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

/** D55: the pure tar reader / writer (`docs/updates.md` → *Extraction*). */

let tmp: string;
beforeEach(async () => {
  tmp = await makeTempDir('tar');
});
afterEach(async () => {
  await removeTempDir(tmp);
});

async function read(buffer: Buffer, chunk = 7000): Promise<Array<TarEntry & { data: string }>> {
  const pieces: Buffer[] = [];
  for (let i = 0; i < buffer.length; i += chunk) pieces.push(buffer.subarray(i, i + chunk));
  const out: Array<TarEntry & { data: string }> = [];
  await walkTar(Readable.from(pieces), {
    entry(entry) {
      const chunks: Buffer[] = [];
      const record = { ...entry, data: '' };
      out.push(record);
      if (entry.type !== 'file') return null;
      return {
        write: async (c) => {
          chunks.push(c);
        },
        close: async () => {
          record.data = Buffer.concat(chunks).toString('utf8');
        },
      };
    },
  });
  return out;
}

describe('tar round trip', () => {
  const long = `switchboard-1.1.0/${'deep/'.repeat(30)}file.txt`;
  const longName = `switchboard-1.1.0/${'n'.repeat(120)}.md`;
  const entries: TarInput[] = [
    { path: 'switchboard-1.1.0/', type: 'dir' },
    { path: 'switchboard-1.1.0/a.txt', type: 'file', data: Buffer.from('hello'), mode: 0o755, mtime: 1_700_000_000 },
    { path: 'switchboard-1.1.0/empty', type: 'file' },
    { path: long, type: 'file', data: Buffer.from('x'.repeat(1500)) },
    { path: longName, type: 'file', data: Buffer.from('pax') },
    { path: 'switchboard-1.1.0/link', type: 'symlink', linkname: '../outside' },
  ];

  it('reads back what it wrote (ustar prefix and pax paths, modes, sizes), across chunk boundaries', async () => {
    for (const chunk of [1, 511, 512, 7000]) {
      const got = await read(tarBuffer(entries), chunk);
      expect(got.map((e) => [e.path, e.type, e.size])).toEqual([
        ['switchboard-1.1.0/', 'dir', 0],
        ['switchboard-1.1.0/a.txt', 'file', 5],
        ['switchboard-1.1.0/empty', 'file', 0],
        [long, 'file', 1500],
        [longName, 'file', 3],
        ['switchboard-1.1.0/link', 'symlink', 0],
      ]);
      expect(got[1]).toMatchObject({ data: 'hello', mode: 0o755, mtime: 1_700_000_000 });
      expect(got[3]?.data).toBe('x'.repeat(1500));
      expect(got[5]?.linkname).toBe('../outside');
    }
  });

  it('writes and reads .tar.gz files', async () => {
    const file = path.join(tmp, 'a.tar.gz');
    await writeTarGz(entries, file);
    expect(gunzipSync(await readFile(file)).length % 512).toBe(0);
    const seen: string[] = [];
    await walkTarGz(file, { entry: (entry) => (seen.push(entry.path), null) });
    expect(seen).toHaveLength(entries.length);
  });

  it('applies GNU long names (L)', async () => {
    const name = `switchboard-1.1.0/${'g'.repeat(150)}`;
    const data = Buffer.from(`${name}\0`);
    const meta = tarBuffer([{ path: '././@LongLink', type: 'file', data }]).subarray(0, 512 + 512);
    meta.write('L', 156, 1, 'ascii');
    // Recompute the checksum after changing the type flag.
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (meta[i] ?? 0);
    meta.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    const body = tarBuffer([{ path: 'short', type: 'file', data: Buffer.from('z') }]);
    const got = await read(Buffer.concat([meta, body]));
    expect(got.map((e) => e.path)).toEqual([name]);
  });

  it('refuses a bad header checksum and a truncated archive', async () => {
    const good = tarBuffer([{ path: 'switchboard-1.1.0/a', type: 'file', data: Buffer.from('abc') }]);
    const bad = Buffer.from(good);
    bad[0] = 'X'.charCodeAt(0);
    await expect(read(bad)).rejects.toBeInstanceOf(TarError);
    await expect(read(good.subarray(0, 600))).rejects.toThrow(/truncated/);
  });
});
