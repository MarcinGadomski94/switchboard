import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * D165 · a profile's password (`docs/profiles.md`, `docs/security.md` → *Profiles*): scrypt with
 * a random 16-byte salt per hash, stored as `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`, compared in
 * constant time. The password itself is never stored, logged or sent anywhere.
 */

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** A new hash of `password`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Whether `password` matches `stored` (a malformed hash never matches). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every((value) => Number.isInteger(value) && value > 0) || n > 1 << 20) return false;
  const salt = Buffer.from(parts[4] as string, 'base64');
  const expected = Buffer.from(parts[5] as string, 'base64');
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;
  const key = await derive(password, salt, n, r, p);
  return timingSafeEqual(key, expected);
}

/** Whether a peer's stored hash has the shape this build writes (the sync never stores anything else). */
export function isPasswordHash(value: unknown): value is string {
  return typeof value === 'string' && /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(value) && value.length < 400;
}
