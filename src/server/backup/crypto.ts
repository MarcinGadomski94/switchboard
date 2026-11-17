import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * D168 · the backup file's encryption (`docs/backup.md` → *The file*): the whole archive is
 * encrypted with a key derived from the developer's passphrase (scrypt), in authenticated
 * chunks (AES-256-GCM, the STREAM construction: a nonce of a per-file random prefix, the
 * chunk's counter and a last-chunk flag), so a file of any size streams through in bounded
 * memory, a changed byte, a reordered, missing or added chunk and a cut-off file are all
 * refused, and a wrong passphrase is told apart from a damaged file (a key check value in the
 * header).
 *
 * Layout: header `SBBK` | version (1) | log2 N (1) | r (1) | p (1) | salt (16) | nonce prefix (7) |
 * key check (16) — then records `last (1) | length (4, BE) | ciphertext | tag (16)`; the header is
 * every record's additional authenticated data.
 */

const MAGIC = Buffer.from('SBBK', 'ascii');
const VERSION = 1;
const HEADER_LENGTH = 4 + 1 + 3 + 16 + 7 + 16;
/** Plaintext per record. */
export const BACKUP_CHUNK_BYTES = 1024 * 1024;
const TAG_BYTES = 16;
/** A record longer than this is refused (a damaged length cannot make the reader allocate gigabytes). */
const MAX_RECORD = BACKUP_CHUNK_BYTES + 64;

/** The scrypt cost: N = 2^logN, r, p. */
export interface KdfParams {
  readonly logN: number;
  readonly r: number;
  readonly p: number;
}

/** The default cost (about 128 MB and a fraction of a second; ASSUMED D168). */
export const DEFAULT_KDF: KdfParams = { logN: 17, r: 8, p: 1 };

/** A key ready to encrypt with: the derived key and what derived it (stored in the header). */
export interface BackupKey {
  readonly key: Buffer;
  readonly salt: Buffer;
  readonly params: KdfParams;
}

/** Why a backup could not be read or written. */
export class BackupCryptoError extends Error {
  readonly code: 'wrong-passphrase' | 'damaged' | 'not-a-backup' | 'unsupported';
  constructor(code: BackupCryptoError['code'], message: string) {
    super(message);
    this.name = 'BackupCryptoError';
    this.code = code;
  }
}

function validParams(params: KdfParams): boolean {
  return Number.isInteger(params.logN) && params.logN >= 10 && params.logN <= 20 && Number.isInteger(params.r) && params.r >= 1 && params.r <= 16 && Number.isInteger(params.p) && params.p >= 1 && params.p <= 4;
}

/** Derives the 32-byte key of `passphrase` (scrypt). */
export function deriveKey(passphrase: string, salt: Buffer, params: KdfParams = DEFAULT_KDF): Promise<BackupKey> {
  if (!validParams(params)) return Promise.reject(new BackupCryptoError('unsupported', 'unsupported key derivation parameters'));
  const n = 2 ** params.logN;
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize('NFC'), salt, 32, { N: n, r: params.r, p: params.p, maxmem: 256 * n * params.r + 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve({ key, salt, params });
    });
  });
}

/** A new key for `passphrase` (a fresh random salt). */
export async function newKey(passphrase: string, params: KdfParams = DEFAULT_KDF): Promise<BackupKey> {
  return deriveKey(passphrase, randomBytes(16), params);
}

function keyCheck(key: Buffer): Buffer {
  return createHmac('sha256', key).update('switchboard-backup key check').digest().subarray(0, 16);
}

function header(key: BackupKey, prefix: Buffer): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([VERSION, key.params.logN, key.params.r, key.params.p]), key.salt, prefix, keyCheck(key.key)]);
}

function nonce(prefix: Buffer, counter: number, last: boolean): Buffer {
  const out = Buffer.alloc(12);
  prefix.copy(out, 0);
  out.writeUInt32BE(counter, 7);
  out[11] = last ? 1 : 0;
  return out;
}

/**
 * Encrypts a byte stream (an async-generator stage for `stream.pipeline`): the header, then
 * one record per {@link BACKUP_CHUNK_BYTES} of input, the last one flagged.
 */
export function encryptStage(key: BackupKey): (source: AsyncIterable<Buffer | string>) => AsyncGenerator<Buffer> {
  return async function* encrypt(source) {
    const prefix = randomBytes(7);
    const aad = header(key, prefix);
    yield aad;
    let counter = 0;
    let buffered: Buffer[] = [];
    let size = 0;
    let pending: Buffer | null = null;
    const seal = (plain: Buffer, last: boolean): Buffer => {
      if (counter > 0xffffffff) throw new BackupCryptoError('unsupported', 'the backup is too large');
      const cipher = createCipheriv('aes-256-gcm', key.key, nonce(prefix, counter, last));
      cipher.setAAD(aad);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      const head = Buffer.alloc(5);
      head[0] = last ? 1 : 0;
      head.writeUInt32BE(body.length, 1);
      counter += 1;
      return Buffer.concat([head, body, cipher.getAuthTag()]);
    };
    for await (const piece of source) {
      const bytes = typeof piece === 'string' ? Buffer.from(piece) : piece;
      buffered.push(bytes);
      size += bytes.length;
      while (size >= BACKUP_CHUNK_BYTES) {
        const all = Buffer.concat(buffered);
        const chunk = all.subarray(0, BACKUP_CHUNK_BYTES);
        const rest = all.subarray(BACKUP_CHUNK_BYTES);
        buffered = rest.length > 0 ? [rest] : [];
        size = rest.length;
        if (pending) yield seal(pending, false);
        pending = Buffer.from(chunk);
      }
    }
    const tail = Buffer.concat(buffered);
    if (pending && tail.length === 0) {
      yield seal(pending, true);
    } else {
      if (pending) yield seal(pending, false);
      yield seal(tail, true);
    }
  };
}

/** Reads exact byte counts from an async byte stream. */
export class ByteReader {
  readonly #source: AsyncIterator<Buffer | string>;
  #chunks: Buffer[] = [];
  #size = 0;
  #done = false;

  constructor(source: AsyncIterable<Buffer | string>) {
    this.#source = source[Symbol.asyncIterator]();
  }

  async #fill(n: number): Promise<void> {
    while (this.#size < n && !this.#done) {
      const next = await this.#source.next();
      if (next.done) {
        this.#done = true;
        break;
      }
      const bytes = typeof next.value === 'string' ? Buffer.from(next.value) : next.value;
      this.#chunks.push(bytes);
      this.#size += bytes.length;
    }
  }

  /** Exactly `n` bytes, or fewer at the end of the stream (an empty buffer at its very end). */
  async read(n: number): Promise<Buffer> {
    await this.#fill(n);
    const all = this.#chunks.length === 1 ? (this.#chunks[0] as Buffer) : Buffer.concat(this.#chunks);
    const out = all.subarray(0, Math.min(n, all.length));
    const rest = all.subarray(out.length);
    this.#chunks = rest.length > 0 ? [rest] : [];
    this.#size = rest.length;
    return out;
  }

  /** Up to `max` bytes as soon as some are there (an empty buffer at the end). */
  async some(max: number): Promise<Buffer> {
    if (this.#size === 0) await this.#fill(1);
    return this.read(Math.min(max, Math.max(1, this.#size)));
  }

  /** Whether the stream has ended with nothing left. */
  async atEnd(): Promise<boolean> {
    await this.#fill(1);
    return this.#size === 0;
  }
}

/** The header of a backup file, read: what derives its key. */
export interface BackupHeader {
  readonly params: KdfParams;
  readonly salt: Buffer;
  readonly prefix: Buffer;
  readonly check: Buffer;
  readonly raw: Buffer;
}

/** Reads and checks the header from `reader`. */
export async function readHeader(reader: ByteReader): Promise<BackupHeader> {
  const raw = await reader.read(HEADER_LENGTH);
  if (raw.length < HEADER_LENGTH || !raw.subarray(0, 4).equals(MAGIC)) throw new BackupCryptoError('not-a-backup', 'this is not a Switchboard backup file');
  if (raw[4] !== VERSION) throw new BackupCryptoError('unsupported', `backup file version ${raw[4]} is not supported here`);
  const params: KdfParams = { logN: raw[5] as number, r: raw[6] as number, p: raw[7] as number };
  if (!validParams(params)) throw new BackupCryptoError('unsupported', 'unsupported key derivation parameters');
  return { params, salt: raw.subarray(8, 24), prefix: raw.subarray(24, 31), check: raw.subarray(31, 47), raw };
}

/**
 * Decrypts a backup byte stream (an async-generator stage): the key comes from `keyOf` (the
 * passphrase, derived with the header's salt and cost). Throws {@link BackupCryptoError}
 * `wrong-passphrase` before any output when the key does not match, `damaged` on any change,
 * a cut-off end or bytes after the last record.
 */
export function decryptStage(keyOf: (header: BackupHeader) => Promise<Buffer>): (source: AsyncIterable<Buffer | string>) => AsyncGenerator<Buffer> {
  return async function* decrypt(source) {
    const reader = new ByteReader(source);
    const head = await readHeader(reader);
    const key = await keyOf(head);
    try {
      if (!timingSafeEqual(keyCheck(key), head.check)) throw new BackupCryptoError('wrong-passphrase', 'the passphrase is not the one this backup was made with');
      let counter = 0;
      for (;;) {
        const top = await reader.read(5);
        if (top.length === 0) throw new BackupCryptoError('damaged', 'the backup file ends too early (it is incomplete)');
        if (top.length < 5) throw new BackupCryptoError('damaged', 'the backup file is damaged');
        const last = top[0] === 1;
        if (top[0] !== 0 && top[0] !== 1) throw new BackupCryptoError('damaged', 'the backup file is damaged');
        const length = top.readUInt32BE(1);
        if (length > MAX_RECORD) throw new BackupCryptoError('damaged', 'the backup file is damaged');
        const body = await reader.read(length + TAG_BYTES);
        if (body.length < length + TAG_BYTES) throw new BackupCryptoError('damaged', 'the backup file ends too early (it is incomplete)');
        const decipher = createDecipheriv('aes-256-gcm', key, nonce(head.prefix, counter, last));
        decipher.setAAD(head.raw);
        decipher.setAuthTag(body.subarray(length));
        let plain: Buffer;
        try {
          plain = Buffer.concat([decipher.update(body.subarray(0, length)), decipher.final()]);
        } catch {
          throw new BackupCryptoError('damaged', 'the backup file is damaged or was changed');
        }
        counter += 1;
        if (plain.length > 0) yield plain;
        if (last) {
          if (!(await reader.atEnd())) throw new BackupCryptoError('damaged', 'the backup file has extra bytes after its end');
          return;
        }
      }
    } finally {
      key.fill(0);
    }
  };
}

/** A `keyOf` for {@link decryptStage} from a passphrase. */
export function passphraseKey(passphrase: string): (header: BackupHeader) => Promise<Buffer> {
  return async (head) => (await deriveKey(passphrase, Buffer.from(head.salt), head.params)).key;
}
