import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { machineIdFrom, pairingCodeFrom } from '../../core/peers.ts';
import { generateToken } from '../token.ts';

/**
 * D48 credentials (`docs/peers.md` → *Security*): per-pair bearer tokens (32
 * random bytes, base64url, the same generator as the install token), stored hashed
 * on the side that checks them, compared in constant time.
 */

/** A new per-pair token: 32 random bytes, base64url. */
export function newPeerToken(): string {
  return generateToken();
}

/** sha256 of a token, base64url: what is stored for an inbound token. */
export function hashPeerToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/** Constant-time comparison of two token hashes. */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A bearer token from an `Authorization` header (`Bearer <token>`), `null` otherwise. */
export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(header.trim());
  return match ? (match[1] as string) : null;
}

/** A new pairing code (`XXXX-XXXX`). */
export function newPairingCode(): string {
  return pairingCodeFrom(randomBytes(16));
}

/** A new machine id. */
export function newMachineId(): string {
  return machineIdFrom(randomBytes(16));
}
