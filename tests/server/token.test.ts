import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOKEN_FILE, loadOrCreateToken } from '../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';

const posix = process.platform !== 'win32';
let tmp: string;

beforeEach(async () => {
  tmp = await makeTempDir('token');
});
afterEach(async () => {
  await removeTempDir(tmp);
});

describe('loadOrCreateToken', () => {
  it('creates the data dir and a random base64url token on first start', async () => {
    const dataDir = path.join(tmp, 'nested', 'data');
    const token = await loadOrCreateToken(dataDir);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await readFile(path.join(dataDir, TOKEN_FILE), 'utf8')).trim()).toBe(token);
    if (posix) {
      expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(dataDir, TOKEN_FILE))).mode & 0o777).toBe(0o600);
    }
  });

  it('returns the same token on every later start', async () => {
    const first = await loadOrCreateToken(tmp);
    expect(await loadOrCreateToken(tmp)).toBe(first);
  });

  it('gives concurrent starts one token', async () => {
    const tokens = await Promise.all(Array.from({ length: 5 }, () => loadOrCreateToken(tmp)));
    expect(new Set(tokens).size).toBe(1);
  });

  it('replaces an unusable token file', async () => {
    await writeFile(path.join(tmp, TOKEN_FILE), 'short\n', { mode: 0o644 });
    const token = await loadOrCreateToken(tmp);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await readFile(path.join(tmp, TOKEN_FILE), 'utf8')).trim()).toBe(token);
    if (posix) expect((await stat(path.join(tmp, TOKEN_FILE))).mode & 0o777).toBe(0o600);
  });

  it('makes a different token per install', async () => {
    const other = await makeTempDir('token-b');
    try {
      expect(await loadOrCreateToken(tmp)).not.toBe(await loadOrCreateToken(other));
    } finally {
      await removeTempDir(other);
    }
  });
});
