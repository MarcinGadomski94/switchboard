import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * D73 tests: a fake Web Push service on a loopback test port. It plays the browser
 * vendor's endpoint *and* the browser: it holds the subscription's private key, and
 * for every push it verifies the VAPID `Authorization` (ES256 JWT: signature with
 * the `k=` key, `aud` = its own origin, `exp` in the future and within 24 h, a
 * `sub`), checks the headers (`Content-Encoding: aes128gcm`, `TTL`), and decrypts
 * the body (RFC 8291 / RFC 8188) independently of the server's code. A
 * subscription can be told to answer 404 / 410 (expired).
 */

/** One browser-side subscription: what the page would hand to `PUT /api/device/push`. */
export interface FakeSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  /** The private key (base64url), for decrypting. */
  readonly privateKey: string;
}

/** A received push, verified and decrypted. */
export interface ReceivedPush {
  readonly path: string;
  readonly ttl: string | undefined;
  readonly urgency: string | undefined;
  readonly topic: string | undefined;
  readonly vapidKey: string;
  readonly claims: { readonly aud: string; readonly exp: number; readonly sub: string };
  readonly payload: unknown;
}

/** A push the fake refused (what was wrong). */
export interface RefusedPush {
  readonly path: string;
  readonly reason: string;
}

/** Decrypts an aes128gcm body for the holder of `privateKey` / `auth` (RFC 8291 §3.4, receiver side). */
export function decryptPush(body: Buffer, privateKey: string, p256dh: string, auth: string): Buffer {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  if (rs < 18) throw new Error('bad record size');
  if (ciphertext.length > rs) throw new Error('more than one record');
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(Buffer.from(privateKey, 'base64url'));
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const ecdhSecret = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, Buffer.from(auth, 'base64url'), keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  // Strip padding: trailing zeros, then the delimiter (0x02 = last record).
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (padded[end] !== 0x02) throw new Error('missing last-record delimiter');
  return padded.subarray(0, end);
}

/** Verifies a `vapid t=…, k=…` header for `origin`; the claims and key, or throws with the reason. */
export function verifyVapid(header: string | undefined, origin: string, nowMs: number = Date.now()): { readonly key: string; readonly claims: ReceivedPush['claims'] } {
  const match = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(header ?? '');
  if (!match) throw new Error(`bad Authorization: ${header}`);
  const [, h, c, s, k] = match as unknown as [string, string, string, string, string];
  const head = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>;
  if (head['alg'] !== 'ES256' || head['typ'] !== 'JWT') throw new Error('bad JWT header');
  const pub = Buffer.from(k, 'base64url');
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('bad k');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  const ok = verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('bad JWT signature');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as ReceivedPush['claims'];
  if (claims.aud !== origin) throw new Error(`aud ${claims.aud} is not ${origin}`);
  const now = Math.floor(nowMs / 1000);
  if (!(claims.exp > now && claims.exp <= now + 24 * 3600)) throw new Error('exp out of range');
  if (typeof claims.sub !== 'string' || !/^(mailto:|https:)/.test(claims.sub)) throw new Error('bad sub');
  return { key: k, claims };
}

/** A running fake push service. */
export interface FakePushService {
  readonly origin: string;
  readonly port: number;
  readonly received: ReceivedPush[];
  readonly refused: RefusedPush[];
  /** A new subscription at `<origin>/push/<id>`. */
  subscribe(): FakeSubscription;
  /** Answer `status` (404 / 410) to pushes to this subscription from now on. */
  expire(subscription: FakeSubscription, status: 404 | 410): void;
  /** Waits until `count` pushes arrived (throws after `timeoutMs`). */
  waitFor(count: number, timeoutMs?: number): Promise<ReceivedPush[]>;
  close(): Promise<void>;
}

/** Starts the fake on `port` (127.0.0.1). */
export async function startFakePush(port: number): Promise<FakePushService> {
  const subscriptions = new Map<string, FakeSubscription>();
  const expired = new Map<string, number>();
  const received: ReceivedPush[] = [];
  const refused: RefusedPush[] = [];
  const origin = `http://127.0.0.1:${port}`;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url ?? '';
      const refuse = (status: number, reason: string): void => {
        refused.push({ path, reason });
        res.writeHead(status).end(reason);
      };
      const subscription = subscriptions.get(path);
      if (req.method !== 'POST' || !subscription) return refuse(404, 'no such subscription');
      const gone = expired.get(path);
      if (gone) {
        res.writeHead(gone).end('expired');
        return;
      }
      try {
        if (req.headers['content-encoding'] !== 'aes128gcm') throw new Error('Content-Encoding must be aes128gcm');
        if (req.headers['ttl'] === undefined) throw new Error('TTL missing');
        const { key, claims } = verifyVapid(req.headers['authorization'], origin);
        const plain = decryptPush(Buffer.concat(chunks), subscription.privateKey, subscription.keys.p256dh, subscription.keys.auth);
        received.push({
          path,
          ttl: req.headers['ttl'] as string | undefined,
          urgency: req.headers['urgency'] as string | undefined,
          topic: req.headers['topic'] as string | undefined,
          vapidKey: key,
          claims,
          payload: JSON.parse(plain.toString('utf8')),
        });
        res.writeHead(201).end();
      } catch (error) {
        refuse(400, error instanceof Error ? error.message : String(error));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const actual = (server.address() as AddressInfo).port;
  return {
    origin,
    port: actual,
    received,
    refused,
    subscribe() {
      const ua = createECDH('prime256v1');
      ua.generateKeys();
      const id = randomBytes(8).toString('hex');
      const subscription: FakeSubscription = {
        endpoint: `${origin}/push/${id}`,
        keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
        privateKey: ua.getPrivateKey().toString('base64url'),
      };
      subscriptions.set(`/push/${id}`, subscription);
      return subscription;
    },
    expire(subscription, status) {
      expired.set(new URL(subscription.endpoint).pathname, status);
    },
    async waitFor(count, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} pushes (got ${received.length}; refused ${JSON.stringify(refused)})`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return received;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
