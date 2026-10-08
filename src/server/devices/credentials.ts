import { randomBytes } from 'node:crypto';
import { machineIdFrom } from '../../core/peers.ts';
import { hashPeerToken, hashesMatch } from '../peers/tokens.ts';
import { readCookieValues } from '../security.ts';
import { generateToken } from '../token.ts';

/**
 * D73 device credentials (`docs/devices.md` → *Security*, `docs/security.md` →
 * *Device listener*): a long-lived cookie `__Host-sb_device=<device id>.<secret>`
 * (32 random bytes, base64url), HttpOnly, Secure, SameSite=Strict, host-only on
 * the device origin (the `__Host-` prefix forbids a `Domain` and needs `Path=/` +
 * `Secure`). The server keeps only sha256 of the secret, compared in constant time.
 */

/** The device cookie's name. */
export const DEVICE_COOKIE = '__Host-sb_device';

/** How long the browser keeps the cookie (400 days, Chrome's cap); refreshed on every page load. */
export const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

/** A new device id (12 characters a-z2-7). */
export function newDeviceId(): string {
  return machineIdFrom(randomBytes(16));
}

/** A new device secret (32 random bytes, base64url). */
export function newDeviceSecret(): string {
  return generateToken();
}

/** sha256 (base64url) of a device secret: what is stored. */
export function hashDeviceSecret(secret: string): string {
  return hashPeerToken(secret);
}

/** Constant-time comparison of a presented secret with a stored hash. */
export function deviceSecretMatches(secret: string, storedHash: string): boolean {
  return hashesMatch(hashDeviceSecret(secret), storedHash);
}

/** The `Set-Cookie` value carrying `<id>.<secret>`. */
export function serializeDeviceCookie(id: string, secret: string): string {
  return `${DEVICE_COOKIE}=${id}.${secret}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`;
}

/** The `Set-Cookie` value that removes the cookie (a revoked device's next page load). */
export function clearDeviceCookie(): string {
  return `${DEVICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/** The well-formed `{ id, secret }` pairs of a `Cookie` header (every value of the device cookie, in order). */
export function readDeviceCookies(header: string | undefined): Array<{ readonly id: string; readonly secret: string }> {
  const found: Array<{ readonly id: string; readonly secret: string }> = [];
  for (const value of readCookieValues(header, DEVICE_COOKIE)) {
    const match = /^([a-z2-7]{12})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (match) found.push({ id: match[1] as string, secret: match[2] as string });
  }
  return found;
}
