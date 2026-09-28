import { X509Certificate, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * A throwaway self-signed TLS certificate for test servers (D28: the https "site"
 * stub the frame-helper E2E frames). Built with `node:crypto` alone (an ECDSA
 * P-256 key, a minimal X.509 v3 certificate encoded by hand in DER), so tests need
 * neither an `openssl` binary nor a key committed to the repo. Only a test browser
 * started with certificate errors ignored accepts it.
 */
export interface SelfSigned {
  /** PEM certificate. */
  readonly cert: string;
  /** PEM PKCS#8 private key. */
  readonly key: string;
}

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(value.length), value]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const explicit = (n: number, value: Buffer): Buffer => tlv(0xa0 + n, value);

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * first + second];
  for (const part of rest) {
    const encoded = [part % 128];
    for (let value = Math.floor(part / 128); value > 0; value = Math.floor(value / 128)) encoded.unshift((value % 128) | 0x80);
    bytes.push(...encoded);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** A non-negative INTEGER from big-endian bytes. */
function integer(bytes: Buffer): Buffer {
  let value = bytes;
  while (value.length > 1 && value[0] === 0 && (value[1]! & 0x80) === 0) value = value.subarray(1);
  if ((value[0]! & 0x80) !== 0) value = Buffer.concat([Buffer.from([0]), value]);
  return tlv(0x02, value);
}

function utcTime(date: Date): Buffer {
  const iso = date.toISOString();
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * A certificate for `names` (the first is the subject's CN, all of them are DNS
 * subject alternative names), valid from an hour ago for `days` days.
 */
export function selfSignedCertificate(names: readonly string[], days = 2): SelfSigned {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdsaWithSha256 = sequence(oid('1.2.840.10045.4.3.2'));
  const name = sequence(set(sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(names[0] ?? 'localhost', 'utf8')))));
  const now = Date.now();
  const validity = sequence(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + days * 86_400_000)));
  const subjectAltName = sequence(oid('2.5.29.17'), tlv(0x04, sequence(...names.map((dns) => tlv(0x82, Buffer.from(dns, 'ascii'))))));
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(randomBytes(12)),
    ecdsaWithSha256,
    name,
    validity,
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, sequence(subjectAltName)),
  );
  const signature = sign('sha256', tbs, privateKey);
  const cert = pem('CERTIFICATE', sequence(tbs, ecdsaWithSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature]))));
  if (!new X509Certificate(cert).verify(publicKey)) throw new Error('self-signed certificate does not verify');
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
