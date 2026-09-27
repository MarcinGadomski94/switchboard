import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** File name of the per-install token inside the data dir. */
export const TOKEN_FILE = 'sb_token';

/** 32 random bytes as base64url = 43 characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Creates a new random token (32 bytes, base64url). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

async function readToken(file: string): Promise<string | null> {
  try {
    const text = (await readFile(file, 'utf8')).trim();
    return TOKEN_PATTERN.test(text) ? text : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Returns the per-install `sb_token`, creating the data dir (0700) and the token
 * file (0600) on first start. The same token is returned on every later start.
 * A token file that exists but does not hold a valid token is replaced.
 */
export async function loadOrCreateToken(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, TOKEN_FILE);
  const existing = await readToken(file);
  if (existing) return existing;
  const token = generateToken();
  try {
    // 'wx' fails if another starting process created the file in the meantime.
    await writeFile(file, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const raced = await readToken(file);
  if (raced) return raced;
  // The file exists but is unusable (empty or corrupt): replace it.
  await writeFile(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600);
  return token;
}
