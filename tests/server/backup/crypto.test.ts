import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BACKUP_CHUNK_BYTES, BackupCryptoError, type KdfParams, decryptStage, encryptStage, newKey, passphraseKey } from '../../../src/server/backup/crypto.ts';

/** D168 (`docs/backup.md` → *The file*): the encryption of a backup, in chunks. */

const FAST: KdfParams = { logN: 10, r: 8, p: 1 };

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(part);
  return Buffer.concat(parts);
}

async function encrypt(plain: Buffer, passphrase = 'correct horse battery'): Promise<Buffer> {
  const key = await newKey(passphrase, FAST);
  // Feed it in odd-sized pieces, as a stream would.
  const pieces: Buffer[] = [];
  for (let at = 0; at < plain.length; at += 70_001) pieces.push(plain.subarray(at, at + 70_001));
  return collect(encryptStage(key)(Readable.from(pieces)));
}

async function decrypt(file: Buffer, passphrase = 'correct horse battery'): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for (let at = 0; at < file.length; at += 50_003) pieces.push(file.subarray(at, at + 50_003));
  return collect(decryptStage(passphraseKey(passphrase))(Readable.from(pieces)));
}

describe('the backup file’s encryption', () => {
  it('round-trips any size, at and around the chunk boundaries', async () => {
    for (const size of [0, 1, BACKUP_CHUNK_BYTES - 1, BACKUP_CHUNK_BYTES, BACKUP_CHUNK_BYTES + 1, 2 * BACKUP_CHUNK_BYTES, 2 * BACKUP_CHUNK_BYTES + 17]) {
      const plain = randomBytes(size);
      const file = await encrypt(plain);
      expect(file.subarray(0, 4).toString()).toBe('SBBK');
      expect((await decrypt(file)).equals(plain), String(size)).toBe(true);
    }
  });

  it('the same input encrypts differently each time, and never shows its plaintext', async () => {
    const plain = Buffer.from('a very recognisable secret value '.repeat(100));
    const a = await encrypt(plain);
    const b = await encrypt(plain);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from('recognisable'))).toBe(false);
  });

  it('a wrong passphrase is told apart from a damaged file, before any output', async () => {
    const file = await encrypt(randomBytes(3000));
    await expect(decrypt(file, 'not the passphrase')).rejects.toMatchObject({ code: 'wrong-passphrase' });
  });

  it('any changed byte, a cut-off end, extra bytes, or not a backup at all: refused', async () => {
    const plain = randomBytes(BACKUP_CHUNK_BYTES + 500);
    const file = await encrypt(plain);
    for (const at of [60, Math.floor(file.length / 2), file.length - 1]) {
      const changed = Buffer.from(file);
      changed[at] = (changed[at] as number) ^ 0x01;
      await expect(decrypt(changed), String(at)).rejects.toBeInstanceOf(BackupCryptoError);
    }
    await expect(decrypt(file.subarray(0, file.length - 40))).rejects.toMatchObject({ code: 'damaged' });
    // The first record alone (the last one is missing): a truncated file.
    const firstRecordEnd = 47 + 5 + BACKUP_CHUNK_BYTES + 16;
    await expect(decrypt(file.subarray(0, firstRecordEnd))).rejects.toMatchObject({ code: 'damaged' });
    await expect(decrypt(Buffer.concat([file, Buffer.from('more')]))).rejects.toMatchObject({ code: 'damaged' });
    await expect(decrypt(Buffer.from('hello, this is just text, not a backup at all ........'))).rejects.toMatchObject({ code: 'not-a-backup' });
  });
});
