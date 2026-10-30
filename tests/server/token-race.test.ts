import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';

/**
 * `loadOrCreateToken` under a slow disk. Creating a file and writing it are two steps for the
 * OS: a racer can see the file another start just created while it is still empty. Before the
 * fix that racer took the empty file as unusable and replaced it with its own token, so two
 * starts at once got two tokens (seen on a busy machine in the CI-like server run). Here every
 * `writeFile` creates its file first and writes it a moment later, which makes that window
 * certain instead of rare.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile: typeof real.writeFile = async (file, data, options) => {
    const flag = typeof options === 'object' && options !== null ? options.flag : undefined;
    // Create (honouring 'wx'), let other starts run, then write the content.
    await real.writeFile(file, '', typeof options === 'object' && options !== null ? { ...options } : options);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await real.writeFile(file, data, typeof options === 'object' && options !== null ? { ...options, flag: flag === 'wx' ? 'w' : flag } : options);
  };
  return { ...real, writeFile, default: { ...real, writeFile } };
});

const { TOKEN_FILE, loadOrCreateToken } = await import('../../src/server/token.ts');

let tmp: string;

beforeEach(async () => {
  tmp = await makeTempDir('token-race');
});
afterEach(async () => {
  await removeTempDir(tmp);
});

describe('loadOrCreateToken on a slow disk', () => {
  it('gives concurrent starts one token, and the file holds it', async () => {
    const tokens = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateToken(tmp)));
    expect(new Set(tokens).size).toBe(1);
    expect((await readFile(path.join(tmp, TOKEN_FILE), 'utf8')).trim()).toBe(tokens[0]);
  });
});
