import { createCipheriv, createECDH, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * D73 Web Push with Node's own crypto (`docs/devices.md` → *Notifications*; no
 * dependency): VAPID (RFC 8292) and the `aes128gcm` message encryption of RFC 8291
 * (with the content coding of RFC 8188). Every step is a short, standard
 * construction; `tests/server/devices/push-crypto.test.ts` decrypts with an
 * independent receiver and checks the RFC 8291 appendix A example vector.
 */

/** A VAPID key pair: P-256, the public key as the uncompressed point (65 bytes, base64url). */
export interface VapidKeys {
  readonly publicKey: string;
  /** The private scalar `d` (32 bytes, base64url). */
  readonly privateKey: string;
}

/** A new VAPID key pair. */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // `getPrivateKey()` drops leading zero bytes (about 1 key in 256 is shorter): stored as the full 32-byte scalar.
  const scalar = ecdh.getPrivateKey();
  const privateKey = Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]);
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: privateKey.toString('base64url') };
}

/** `true` when `keys` is a usable pair (65-byte uncompressed public point, 32-byte private scalar that matches it). */
export function validVapidKeys(keys: unknown): keys is VapidKeys {
  if (typeof keys !== 'object' || keys === null) return false;
  const { publicKey, privateKey } = keys as Record<string, unknown>;
  if (typeof publicKey !== 'string' || typeof privateKey !== 'string') return false;
  try {
    const pub = Buffer.from(publicKey, 'base64url');
    const priv = Buffer.from(privateKey, 'base64url');
    if (pub.length !== 65 || pub[0] !== 0x04 || priv.length !== 32) return false;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(priv);
    return ecdh.getPublicKey().equals(pub);
  } catch {
    return false;
  }
}

/** The private key as a `KeyObject` (JWK from the raw point and scalar). */
function vapidPrivateKey(keys: VapidKeys): KeyObject {
  const pub = Buffer.from(keys.publicKey, 'base64url');
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url'), d: keys.privateKey },
    format: 'jwk',
  });
}

/** A public key (uncompressed point, base64url) as a `KeyObject`. */
export function p256PublicKey(publicKey: string): KeyObject {
  const pub = Buffer.from(publicKey, 'base64url');
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') }, format: 'jwk' });
}

/** The VAPID JWT lifetime (12 hours; RFC 8292 allows at most 24). */
export const VAPID_JWT_TTL_S = 12 * 60 * 60;

/**
 * The `Authorization` header of a push request (RFC 8292): `vapid t=<JWT>, k=<public key>`,
 * the JWT (ES256) naming the push service's origin (`aud`), an expiry and the contact (`sub`).
 */
export function vapidAuthorization(keys: VapidKeys, endpoint: string, subject: string, nowMs: number = Date.now()): string {
  const audience = new URL(endpoint).origin;
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + VAPID_JWT_TTL_S, sub: subject })).toString('base64url');
  const signingInput = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(signingInput), { key: vapidPrivateKey(keys), dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `vapid t=${signingInput}.${signature}, k=${keys.publicKey}`;
}

/** The record size written in the aes128gcm header (one record holds the whole short payload). */
export const RECORD_SIZE = 4096;

/** Largest plaintext one message may carry (record size minus the tag and the delimiter). */
export const MAX_PLAINTEXT = RECORD_SIZE - 16 - 1;

/** What {@link encryptPayload} may be given instead of random values (the RFC 8291 test vector). */
export interface EncryptOverrides {
  /** The sender's ephemeral ECDH private key (32 bytes). */
  readonly senderPrivateKey?: Buffer;
  readonly salt?: Buffer;
}

/**
 * Encrypts `plaintext` for a subscription (RFC 8291 §3.4 + RFC 8188, one record):
 * ECDH between a fresh sender key and the browser's `p256dh`; the IKM from HKDF
 * with the subscription's `auth` secret and `"WebPush: info" 0x00 ua_public as_public`;
 * the content key and nonce from HKDF with a random salt; AES-128-GCM over the
 * plaintext and the last-record delimiter `0x02`. The body is the header
 * (salt ‖ record size ‖ key id length ‖ sender public key) then the ciphertext.
 */
export function encryptPayload(plaintext: Buffer, p256dh: string, auth: string, overrides: EncryptOverrides = {}): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`push payload too large (${plaintext.length} bytes)`);
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('p256dh is not an uncompressed P-256 point');
  if (authSecret.length < 16) throw new Error('auth secret too short');
  const sender = createECDH('prime256v1');
  if (overrides.senderPrivateKey) sender.setPrivateKey(overrides.senderPrivateKey);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const salt = overrides.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}
