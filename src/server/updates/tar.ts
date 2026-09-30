import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { createGunzip, createGzip } from 'node:zlib';

/**
 * A small, pure tar implementation (D55, `docs/updates.md` → *Extraction*): the
 * updater must unpack release tarballs on Windows too, where no system `tar`
 * can be relied on, and `npm run release:package` writes them. Reads ustar with
 * its `prefix` field, pax extended headers (`x`; `g` is skipped) and GNU long
 * names (`L` / `K`); writes ustar, with a pax header for a path that does not fit.
 * Checksums are verified; sizes and counts are bounded by the caller.
 */

/** Block size of the format. */
const BLOCK = 512;

/** The limit on a pax or GNU long-name header's data. */
const META_LIMIT = 1024 * 1024;

/** What kind of entry a header describes. */
export type TarEntryType = 'file' | 'dir' | 'symlink' | 'hardlink' | 'other';

/** One entry as read. */
export interface TarEntry {
  /** The path as stored (pax / GNU long names applied, ustar `prefix` joined). */
  readonly path: string;
  readonly type: TarEntryType;
  /** The type flag character (`0`, `5`, `2`, …). */
  readonly flag: string;
  readonly size: number;
  readonly mode: number;
  readonly linkname: string;
  /** Seconds since the epoch. */
  readonly mtime: number;
}

/** Receives a file's data; returned by {@link TarVisitor.entry}. */
export interface TarSink {
  write(chunk: Buffer): Promise<void>;
  close(): Promise<void>;
}

/** What {@link walkTar} calls per entry; returning a sink for a file receives its data (else it is skipped). */
export interface TarVisitor {
  entry(entry: TarEntry): Promise<TarSink | null> | TarSink | null;
}

/** A malformed or refused archive. */
export class TarError extends Error {
  override name = 'TarError';
}

function text(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function octal(block: Buffer, start: number, length: number, field: string): number {
  const slice = block.subarray(start, start + length);
  // GNU base-256 for big numbers: the first byte's high bit.
  if (((slice[0] ?? 0) & 0x80) !== 0) {
    let value = (slice[0] ?? 0) & 0x7f;
    for (let i = 1; i < slice.length; i++) value = value * 256 + (slice[i] ?? 0);
    if (!Number.isSafeInteger(value)) throw new TarError(`tar header ${field} is too large`);
    return value;
  }
  const raw = text(block, start, length).trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) throw new TarError(`tar header ${field} is not octal: "${raw}"`);
  return parseInt(raw, 8);
}

function checksumOf(block: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (block[i] ?? 0);
  return sum;
}

function typeOf(flag: string): TarEntryType {
  if (flag === '0' || flag === '\0' || flag === '' || flag === '7') return 'file';
  if (flag === '5') return 'dir';
  if (flag === '2') return 'symlink';
  if (flag === '1') return 'hardlink';
  return 'other';
}

/** Parses pax records (`<len> <key>=<value>\n`). */
export function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(data.subarray(offset, space).toString('ascii'));
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) throw new TarError('malformed pax header');
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return out;
}

/** Pulls exactly-sized pieces out of a chunk stream. */
class Reader {
  readonly #iterator: AsyncIterator<Buffer>;
  #buffer: Buffer = Buffer.alloc(0);
  #done = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  async #fill(min: number): Promise<boolean> {
    while (this.#buffer.length < min && !this.#done) {
      const next = await this.#iterator.next();
      if (next.done) this.#done = true;
      else this.#buffer = this.#buffer.length === 0 ? Buffer.from(next.value) : Buffer.concat([this.#buffer, next.value]);
    }
    return this.#buffer.length >= min;
  }

  /** Exactly `n` bytes, or `null` at a clean end (nothing left). */
  async take(n: number): Promise<Buffer | null> {
    if (!(await this.#fill(n))) {
      if (this.#buffer.length === 0) return null;
      throw new TarError('truncated tar archive');
    }
    const out = this.#buffer.subarray(0, n);
    this.#buffer = this.#buffer.subarray(n);
    return out;
  }

  /** Streams `n` bytes to `each` in pieces. */
  async pipe(n: number, each: (chunk: Buffer) => Promise<void>): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.#buffer.length === 0 && !(await this.#fill(1))) throw new TarError('truncated tar archive');
      const piece = this.#buffer.subarray(0, Math.min(left, this.#buffer.length));
      this.#buffer = this.#buffer.subarray(piece.length);
      left -= piece.length;
      await each(piece);
    }
  }
}

/**
 * Walks a tar stream (already un-gzipped), calling `visitor.entry` for each
 * entry (metadata entries `x` / `g` / `L` / `K` are applied, not reported).
 * Stops at the end-of-archive block or the end of the stream.
 * @throws {TarError} on a bad checksum, a truncated archive or malformed metadata.
 */
export async function walkTar(source: AsyncIterable<Buffer>, visitor: TarVisitor): Promise<void> {
  const reader = new Reader(source);
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  let longLink: string | null = null;
  for (;;) {
    const header = await reader.take(BLOCK);
    if (header === null) return;
    if (header.every((byte) => byte === 0)) return;
    const stored = octal(header, 148, 8, 'checksum');
    if (stored !== checksumOf(header)) throw new TarError('tar header checksum mismatch');
    const flag = String.fromCharCode(header[156] ?? 0);
    let size = octal(header, 124, 12, 'size');
    const padded = (n: number): number => Math.ceil(n / BLOCK) * BLOCK;
    if (flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K') {
      if (size > META_LIMIT) throw new TarError('tar metadata entry is too large');
      const data = size === 0 ? Buffer.alloc(0) : await reader.take(padded(size));
      if (data === null) throw new TarError('truncated tar archive');
      const body = data.subarray(0, size);
      if (flag === 'x') pax = parsePax(body);
      else if (flag === 'L') longName = text(body, 0, body.length);
      else if (flag === 'K') longLink = text(body, 0, body.length);
      continue;
    }
    const name = text(header, 0, 100);
    const magic = text(header, 257, 6);
    const prefix = magic.startsWith('ustar') ? text(header, 345, 155) : '';
    let entryPath = longName ?? (prefix ? `${prefix}/${name}` : name);
    let linkname = longLink ?? text(header, 157, 100);
    if (pax['path'] !== undefined) entryPath = pax['path'];
    if (pax['linkpath'] !== undefined) linkname = pax['linkpath'];
    if (pax['size'] !== undefined) {
      if (!/^\d+$/.test(pax['size'])) throw new TarError('malformed pax size');
      size = Number(pax['size']);
    }
    pax = {};
    longName = null;
    longLink = null;
    const type = typeOf(flag);
    // Only regular files carry data that is theirs; anything else's data is skipped.
    const entry: TarEntry = { path: entryPath, type, flag, size: type === 'dir' ? 0 : size, mode: octal(header, 100, 8, 'mode'), linkname, mtime: octal(header, 136, 12, 'mtime') };
    const sink = await visitor.entry(entry);
    if (sink) {
      await reader.pipe(size, (chunk) => sink.write(chunk));
      await sink.close();
      const rest = padded(size) - size;
      if (rest > 0 && (await reader.take(rest)) === null) throw new TarError('truncated tar archive');
    } else if (size > 0) {
      await reader.pipe(padded(size), async () => undefined);
    }
  }
}

/** Walks a `.tar.gz` file (see {@link walkTar}). */
export async function walkTarGz(file: string, visitor: TarVisitor): Promise<void> {
  const input = createReadStream(file);
  const gunzip = createGunzip();
  input.on('error', (error) => gunzip.destroy(error));
  input.pipe(gunzip);
  try {
    await walkTar(gunzip, visitor);
  } finally {
    input.destroy();
    gunzip.destroy();
  }
}

// ── writing ──────────────────────────────────────────────────────────────

/** One entry to write. Paths are written as given (tests build hostile archives with it). */
export interface TarInput {
  readonly path: string;
  readonly type: 'file' | 'dir' | 'symlink' | 'hardlink';
  /** Default 0o644 (files) / 0o755 (folders). */
  readonly mode?: number;
  /** Seconds since the epoch (default 0). */
  readonly mtime?: number;
  readonly data?: Buffer;
  readonly linkname?: string;
}

function writeText(block: Buffer, value: string, start: number, length: number): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new TarError(`"${value}" does not fit a ${length}-byte tar field`);
  bytes.copy(block, start);
}

function writeOctal(block: Buffer, value: number, start: number, length: number): void {
  const digits = value.toString(8).padStart(length - 1, '0');
  if (digits.length > length - 1) throw new TarError(`${value} does not fit a ${length}-byte tar field`);
  block.write(`${digits}\0`, start, length, 'ascii');
}

/** Splits `file` into ustar `prefix` + `name`, or `null` when it cannot fit. */
function ustarSplit(file: string): { prefix: string; name: string } | null {
  if (Buffer.byteLength(file) <= 100) return { prefix: '', name: file };
  for (let i = file.length - 1; i > 0; i--) {
    if (file[i] !== '/') continue;
    const prefix = file.slice(0, i);
    const name = file.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name !== '') return { prefix, name };
  }
  return null;
}

function header(options: { name: string; prefix: string; flag: string; size: number; mode: number; mtime: number; linkname: string }): Buffer {
  const block = Buffer.alloc(BLOCK);
  writeText(block, options.name, 0, 100);
  writeOctal(block, options.mode & 0o7777, 100, 8);
  writeOctal(block, 0, 108, 8);
  writeOctal(block, 0, 116, 8);
  writeOctal(block, options.size, 124, 12);
  writeOctal(block, options.mtime, 136, 12);
  block.write(options.flag, 156, 1, 'ascii');
  writeText(block, options.linkname, 157, 100);
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  writeText(block, options.prefix, 345, 155);
  // The checksum field counts as spaces while summing, then holds 6 octal digits, NUL, space.
  block.write(`${checksumOf(block).toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`, 'utf8');
}

function padding(size: number): Buffer {
  const rest = size % BLOCK;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest);
}

/** The blocks of one entry (a pax header first when the path or link does not fit ustar). */
export function tarEntryBlocks(input: TarInput): Buffer[] {
  const flag = input.type === 'dir' ? '5' : input.type === 'symlink' ? '2' : input.type === 'hardlink' ? '1' : '0';
  const data = input.type === 'file' ? (input.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
  const mode = input.mode ?? (input.type === 'dir' ? 0o755 : 0o644);
  const mtime = input.mtime ?? 0;
  const linkname = input.linkname ?? '';
  const out: Buffer[] = [];
  const split = ustarSplit(input.path);
  const linkFits = Buffer.byteLength(linkname) <= 100;
  let name = split?.name ?? '';
  let prefix = split?.prefix ?? '';
  if (!split || !linkFits) {
    const records = Buffer.concat([...(split ? [] : [paxRecord('path', input.path)]), ...(linkFits ? [] : [paxRecord('linkpath', linkname)])]);
    const paxName = `PaxHeaders/${input.path.split('/').filter(Boolean).at(-1) ?? 'entry'}`.slice(0, 100);
    out.push(header({ name: paxName, prefix: '', flag: 'x', size: records.length, mode: 0o644, mtime, linkname: '' }), records, padding(records.length));
    if (!split) {
      name = input.path.slice(-100).replace(/^[^/]*\//, '').slice(-100);
      prefix = '';
    }
  }
  out.push(header({ name, prefix, flag, size: data.length, mode, mtime, linkname: linkFits ? linkname : '' }));
  if (data.length > 0) out.push(data, padding(data.length));
  return out;
}

/** A whole tar archive (with the two end blocks). */
export function tarBuffer(entries: readonly TarInput[]): Buffer {
  return Buffer.concat([...entries.flatMap(tarEntryBlocks), Buffer.alloc(BLOCK * 2)]);
}

/** Writes `entries` as a gzip-compressed tar archive to `file`. */
export async function writeTarGz(entries: readonly TarInput[], file: string): Promise<void> {
  const gzip = createGzip({ level: 9 });
  const output = createWriteStream(file);
  gzip.pipe(output);
  for (const entry of entries) {
    for (const block of tarEntryBlocks(entry)) {
      if (!gzip.write(block)) await once(gzip, 'drain');
    }
  }
  gzip.end(Buffer.alloc(BLOCK * 2));
  await once(output, 'close');
}
