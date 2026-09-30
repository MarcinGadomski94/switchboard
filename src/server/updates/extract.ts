import { type FileHandle, chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { type TarEntry, TarError, type TarSink, walkTarGz } from './tar.ts';

/**
 * Safe extraction of a release tarball (D55, `docs/updates.md` →
 * *Extraction*). Every entry must sit under the one expected top folder
 * (`switchboard-<version>/`); absolute paths, `..`, backslashes, drive letters,
 * NULs and Windows device names are refused, and so is any link (symbolic or
 * hard: a release has none, and a link is how an archive escapes its folder) or
 * special file. Files are created exclusively (`wx`) under a fresh folder, so
 * nothing outside it can be written. Sizes and counts are bounded.
 */

/** Limits of one extraction. */
export interface ExtractLimits {
  /** Total bytes of file data. */
  readonly maxBytes: number;
  /** Entries (files + folders). */
  readonly maxEntries: number;
}

/** Defaults: 512 MiB of data, 50 000 entries (1.0.0: ~12 MB, 692 entries). */
export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = { maxBytes: 512 * 1024 * 1024, maxEntries: 50_000 };

/** What an extraction wrote. */
export interface ExtractResult {
  /** `<dest>/<prefix without the slash>`. */
  readonly root: string;
  readonly files: number;
  readonly folders: number;
  readonly bytes: number;
}

/** A refused archive: the reason names the entry. */
export class ExtractError extends Error {
  override name = 'ExtractError';
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * The path segments of an entry under `prefix` (`switchboard-1.1.0/`), `[]` for
 * the top folder itself.
 * @throws {ExtractError} when the path is not a plain relative path under `prefix`.
 */
export function entrySegments(entryPath: string, prefix: string): string[] {
  const top = prefix.replace(/\/+$/, '');
  if (entryPath.includes('\0')) throw new ExtractError('an entry name contains a NUL byte');
  if (entryPath.includes('\\')) throw new ExtractError(`entry "${entryPath}" contains a backslash`);
  if (entryPath.startsWith('/') || /^[a-zA-Z]:/.test(entryPath)) throw new ExtractError(`entry "${entryPath}" is an absolute path`);
  const segments = entryPath.replace(/\/+$/, '').split('/');
  if (segments.some((segment) => segment === '..')) throw new ExtractError(`entry "${entryPath}" leaves its folder (..)`);
  const parts = segments.filter((segment) => segment !== '' && segment !== '.');
  if (parts[0] !== top) throw new ExtractError(`entry "${entryPath}" is not under ${top}/`);
  const rest = parts.slice(1);
  for (const segment of rest) {
    if (segment.includes(':')) throw new ExtractError(`entry "${entryPath}" contains a colon`);
    if (WINDOWS_DEVICE.test(segment) || /[. ]$/.test(segment)) throw new ExtractError(`entry "${entryPath}" is not a valid file name on Windows`);
  }
  return rest;
}

/**
 * Extracts `archive` (a `.tar.gz`) into `dest`, which must be an empty or
 * missing folder, accepting only entries under `prefix`.
 * @throws {ExtractError} on a refused entry or a limit; {@link TarError} on a malformed archive.
 */
export async function extractRelease(archive: string, dest: string, prefix: string, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<ExtractResult> {
  const base = path.resolve(dest);
  const root = path.join(base, prefix.replace(/\/+$/, ''));
  await mkdir(root, { recursive: true });
  let files = 0;
  let folders = 0;
  let bytes = 0;
  // The file being written, closed on a failure (Windows cannot remove the staging folder while it is open).
  let current: FileHandle | null = null;
  const target = (entry: TarEntry): string => {
    const segments = entrySegments(entry.path, prefix);
    const full = path.join(root, ...segments);
    if (full !== root && !full.startsWith(root + path.sep)) throw new ExtractError(`entry "${entry.path}" leaves its folder`);
    return full;
  };
  try {
    await walkTarGz(archive, {
      entry: async (entry): Promise<TarSink | null> => {
        if (files + folders + 1 > limits.maxEntries) throw new ExtractError(`the archive has more than ${limits.maxEntries} entries`);
        if (entry.type === 'symlink' || entry.type === 'hardlink') throw new ExtractError(`entry "${entry.path}" is a link; release packages have none`);
        if (entry.type === 'other') throw new ExtractError(`entry "${entry.path}" is not a file or folder (type ${JSON.stringify(entry.flag)})`);
        const full = target(entry);
        if (entry.type === 'dir') {
          await mkdir(full, { recursive: true });
          folders++;
          return null;
        }
        if (full === root) throw new ExtractError(`entry "${entry.path}" is the top folder but not a folder`);
        bytes += entry.size;
        if (bytes > limits.maxBytes) throw new ExtractError(`the archive unpacks to more than ${limits.maxBytes} bytes`);
        await mkdir(path.dirname(full), { recursive: true });
        // `wx`: never over an existing file (a duplicate entry is refused).
        const handle = await open(full, 'wx').catch((error: NodeJS.ErrnoException) => {
          throw new ExtractError(error.code === 'EEXIST' ? `entry "${entry.path}" appears twice` : `could not create ${full}: ${error.message}`);
        });
        current = handle;
        files++;
        const executable = (entry.mode & 0o111) !== 0;
        let written = 0;
        return {
          write: async (chunk) => {
            written += chunk.length;
            await handle.write(chunk);
          },
          close: async () => {
            current = null;
            await handle.close();
            if (written !== entry.size) throw new ExtractError(`entry "${entry.path}" is truncated`);
            if (process.platform !== 'win32') await chmod(full, executable ? 0o755 : 0o644);
          },
        };
      },
    });
  } catch (error) {
    await (current as FileHandle | null)?.close().catch(() => undefined);
    if (error instanceof ExtractError || error instanceof TarError) throw error;
    // zlib's "incorrect header check", a read error, …
    throw new ExtractError(`could not unpack the archive: ${(error as Error).message}`);
  }
  return { root, files, folders, bytes };
}
