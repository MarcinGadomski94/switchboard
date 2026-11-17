import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { type BackupChecksum, safeEntryName } from '../../core/backup.ts';
import { ByteReader } from './crypto.ts';

/**
 * D168 · the archive inside the encryption (`docs/backup.md` → *The file*): a sequence of
 * entries, each `header length (4, BE) | header JSON | data | sha256 (32)`, then an end marker.
 * The first entry is the preview (what the restore shows before writing anything), the last the
 * checksums of every file entry. A file is read up to the size it had when the backup started
 * (a transcript that grows meanwhile is cut there, never torn).
 */

/** One entry to write. */
export type EntrySource =
  | { readonly kind: 'json'; readonly role: 'preview' | 'checksums'; readonly value: unknown }
  | { readonly kind: 'file'; readonly name: string; readonly path: string; readonly size?: number }
  | { readonly kind: 'bytes'; readonly name: string; readonly bytes: Buffer };

interface EntryHeader {
  readonly t: 'preview' | 'checksums' | 'file' | 'end';
  readonly n?: string;
  readonly s?: number;
}

const MAX_HEADER = 64 * 1024;
const MAX_JSON = 256 * 1024 * 1024;

function frame(head: EntryHeader): Buffer {
  const json = Buffer.from(JSON.stringify(head), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length, 0);
  return Buffer.concat([length, json]);
}

/**
 * The archive's bytes (an async generator for `stream.pipeline`): every entry of `entries` in
 * order (the checksums of the file entries are appended by itself, before the end marker).
 * `onFile` hears each file entry's checksum.
 */
export async function* writeContainer(entries: AsyncIterable<EntrySource> | Iterable<EntrySource>): AsyncGenerator<Buffer> {
  const sums: BackupChecksum[] = [];
  for await (const entry of entries) {
    if (entry.kind === 'json') {
      const bytes = Buffer.from(JSON.stringify(entry.value), 'utf8');
      yield frame({ t: entry.role, s: bytes.length });
      yield bytes;
      yield createHash('sha256').update(bytes).digest();
      continue;
    }
    const name = safeEntryName(entry.name);
    if (!name) throw new Error(`refusing an archive entry named ${JSON.stringify(entry.name)}`);
    if (entry.kind === 'bytes') {
      yield frame({ t: 'file', n: name, s: entry.bytes.length });
      yield entry.bytes;
      const sha = createHash('sha256').update(entry.bytes).digest();
      sums.push({ name, size: entry.bytes.length, sha256: sha.toString('hex') });
      yield sha;
      continue;
    }
    const size = entry.size ?? (await stat(entry.path)).size;
    yield frame({ t: 'file', n: name, s: size });
    const hash = createHash('sha256');
    let read = 0;
    if (size > 0) {
      for await (const chunk of createReadStream(entry.path, { start: 0, end: size - 1, highWaterMark: 256 * 1024 })) {
        const bytes = chunk as Buffer;
        hash.update(bytes);
        read += bytes.length;
        yield bytes;
      }
    }
    if (read !== size) throw new Error(`${entry.path} changed while it was being backed up (it became shorter)`);
    const sha = hash.digest();
    sums.push({ name, size, sha256: sha.toString('hex') });
    yield sha;
  }
  const bytes = Buffer.from(JSON.stringify(sums), 'utf8');
  yield frame({ t: 'checksums', s: bytes.length });
  yield bytes;
  yield createHash('sha256').update(bytes).digest();
  yield frame({ t: 'end' });
}

/** Thrown to stop reading once the preview is in hand ({@link readContainer}'s `previewOnly`). */
export class PreviewRead extends Error {
  readonly preview: unknown;
  constructor(preview: unknown) {
    super('preview read');
    this.preview = preview;
  }
}

/** What reading an archive into a folder found. */
export interface ContainerRead {
  readonly preview: unknown;
  readonly checksums: readonly BackupChecksum[];
}

/** Why an archive's contents were refused. */
export class ContainerError extends Error {
  override name = 'ContainerError';
}

async function readJson(reader: ByteReader, size: number): Promise<unknown> {
  if (size > MAX_JSON) throw new ContainerError('the backup is damaged (an entry is too large)');
  const bytes = await reader.read(size);
  const sha = await reader.read(32);
  if (bytes.length < size || sha.length < 32 || !createHash('sha256').update(bytes).digest().equals(sha)) throw new ContainerError('the backup is damaged (a checksum does not match)');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

/**
 * Reads an archive (the decrypted, decompressed bytes): with `into`, writes every file entry
 * under that folder (its name's path, checked by {@link safeEntryName}) and checks each one's
 * sha256 and the closing list; with `previewOnly`, throws {@link PreviewRead} with the preview
 * as soon as it is read (the caller stops the stream).
 */
export async function readContainer(source: AsyncIterable<Buffer | string>, options: { readonly into?: string; readonly previewOnly?: boolean }): Promise<ContainerRead> {
  const reader = new ByteReader(source);
  let preview: unknown = null;
  const seen: BackupChecksum[] = [];
  let listed: BackupChecksum[] | null = null;
  for (;;) {
    const top = await reader.read(4);
    if (top.length < 4) throw new ContainerError('the backup is damaged (it ends too early)');
    const length = top.readUInt32BE(0);
    if (length > MAX_HEADER) throw new ContainerError('the backup is damaged (a bad entry header)');
    const rawHead = await reader.read(length);
    let head: EntryHeader;
    try {
      head = JSON.parse(rawHead.toString('utf8')) as EntryHeader;
    } catch {
      throw new ContainerError('the backup is damaged (a bad entry header)');
    }
    if (head.t === 'end') break;
    const size = typeof head.s === 'number' && Number.isSafeInteger(head.s) && head.s >= 0 ? head.s : -1;
    if (size < 0) throw new ContainerError('the backup is damaged (a bad entry size)');
    if (head.t === 'preview') {
      preview = await readJson(reader, size);
      if (options.previewOnly) throw new PreviewRead(preview);
      continue;
    }
    if (head.t === 'checksums') {
      listed = (await readJson(reader, size)) as BackupChecksum[];
      continue;
    }
    if (head.t !== 'file') throw new ContainerError('the backup is damaged (an unknown entry)');
    const name = safeEntryName(head.n);
    if (!name) throw new ContainerError(`the backup holds an entry this Switchboard refuses (${String(head.n)})`);
    const hash = createHash('sha256');
    let out: ReturnType<typeof createWriteStream> | null = null;
    if (options.into) {
      const target = path.join(options.into, ...name.split('/'));
      const root = path.resolve(options.into) + path.sep;
      if (!path.resolve(target).startsWith(root)) throw new ContainerError(`the backup holds an entry outside its folder (${name})`);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      out = createWriteStream(target, { mode: 0o600 });
    }
    let left = size;
    try {
      while (left > 0) {
        const piece = await reader.some(Math.min(left, 1024 * 1024));
        if (piece.length === 0) throw new ContainerError('the backup is damaged (it ends too early)');
        hash.update(piece);
        left -= piece.length;
        if (out && !out.write(piece)) await once(out, 'drain');
      }
    } finally {
      if (out) {
        out.end();
        await once(out, 'close');
      }
    }
    const sha = await reader.read(32);
    const digest = hash.digest();
    if (sha.length < 32 || !digest.equals(sha)) throw new ContainerError(`the backup is damaged (${name} does not match its checksum)`);
    seen.push({ name, size, sha256: digest.toString('hex') });
  }
  if (preview === null) throw new ContainerError('the backup is damaged (it has no preview)');
  if (!listed) throw new ContainerError('the backup is damaged (its list of files is missing)');
  const byName = new Map(listed.map((entry) => [entry.name, entry]));
  if (byName.size !== seen.length || seen.some((entry) => byName.get(entry.name)?.sha256 !== entry.sha256)) throw new ContainerError('the backup is damaged (its files do not match its list)');
  return { preview, checksums: listed };
}
