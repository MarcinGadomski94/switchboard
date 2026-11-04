import { fstat, type Stats } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * The service log's size cap (`docs/service.md` → *The service log*). On macOS
 * launchd writes the service's stdout + stderr to `<dataDir>/logs/service.log`
 * (`StandardOutPath` / `StandardErrorPath`, opened with `O_APPEND`) and never
 * rotates it, so it grew without end (1.85 GB seen). Switchboard now keeps it
 * small itself: when `service.log` is over half of {@link SERVICE_LOG_MAX_BYTES},
 * its newest half goes to `service.log.1` (replacing the older copy) and
 * `service.log` is truncated **in place**. Truncating keeps launchd's file
 * descriptor valid, and because it appends (`O_APPEND`) the next line lands at
 * the new end of the file: no reopen, no restart, no change to the plist, so an
 * existing install benefits as soon as it runs the new version. Linux (the
 * journal) and Windows (no output file) have nothing to rotate: the check runs
 * only when this process's stdout or stderr **is** that file.
 */

/** Both files together (`service.log` + `service.log.1`) stay around this size: 50 MiB. */
export const SERVICE_LOG_MAX_BYTES = 50 * 1024 * 1024;

/** How often the running service checks the log's size. */
export const SERVICE_LOG_CHECK_MS = 5 * 60_000;

/** The file launchd writes the service's output to (`servicePaths().logFile` on macOS). */
export function serviceLogFile(dataDir: string): string {
  return path.join(dataDir, 'logs', 'service.log');
}

/** The rotated copy of `file`: `<file>.1`. */
export function rotatedLogFile(file: string): string {
  return `${file}.1`;
}

/** What {@link rotateLog} did. */
export interface RotateResult {
  /** `true` when the file was over the limit and was rotated. */
  readonly rotated: boolean;
  /** The file's size before (0 when it does not exist). */
  readonly sizeBefore: number;
  /** Bytes kept in `<file>.1` (0 when nothing was rotated, or the copy failed). */
  readonly kept: number;
}

const CHUNK = 1024 * 1024;

/**
 * Rotates `file` when it is larger than `segmentBytes`: its newest
 * `segmentBytes` (from the first full line) go to `<file>.1`, replacing it, and
 * `file` is truncated to 0 in place, so a writer that holds it open with
 * `O_APPEND` keeps writing into it. Lines appended while the copy runs are
 * copied too, right before the truncation. When the copy fails (a full disk)
 * `file` is still truncated: a lost log is better than a full disk.
 */
export async function rotateLog(file: string, segmentBytes: number): Promise<RotateResult> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rotated: false, sizeBefore: 0, kept: 0 };
    throw error;
  }
  if (size <= segmentBytes) return { rotated: false, sizeBefore: size, kept: 0 };
  const sizeBefore = size;
  const source = await open(file, 'r+');
  const rotated = rotatedLogFile(file);
  const temp = `${rotated}.tmp`;
  let kept = 0;
  let copyError: unknown = null;
  try {
    try {
      const target = await open(temp, 'w');
      try {
        let from = Math.max(0, size - segmentBytes);
        if (from > 0) from = await nextLineStart(source, from, size);
        const buffer = Buffer.allocUnsafe(CHUNK);
        // Copy up to the current end, then whatever was appended meanwhile, until the end stands still.
        for (let round = 0; round < 10; round += 1) {
          while (from < size) {
            const { bytesRead } = await source.read(buffer, 0, Math.min(CHUNK, size - from), from);
            if (bytesRead === 0) break;
            await target.write(buffer, 0, bytesRead);
            from += bytesRead;
            kept += bytesRead;
          }
          const now = (await source.stat()).size;
          if (now <= size) break;
          size = now;
        }
      } finally {
        await target.close();
      }
    } catch (error) {
      copyError = error;
    }
    await source.truncate(0);
  } finally {
    await source.close();
  }
  if (copyError !== null) {
    await rm(temp, { force: true });
    throw copyError;
  }
  await rename(temp, rotated);
  return { rotated: true, sizeBefore, kept };
}

/** The start of the first full line at or after `from` (`from` itself when a line starts there; `end` when none does). */
async function nextLineStart(handle: Awaited<ReturnType<typeof open>>, from: number, end: number): Promise<number> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  // Searching from the byte before `from`: a newline there means a line starts at `from`.
  let at = from - 1;
  while (at < end) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - at), at);
    if (bytesRead === 0) break;
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline >= 0) return at + newline + 1;
    at += bytesRead;
  }
  return end;
}

function fstatFd(fd: number): Promise<Stats | null> {
  return new Promise((resolve) => {
    fstat(fd, (error, stats) => resolve(error ? null : stats));
  });
}

/**
 * `true` when this process's stdout or stderr (`fds`, default 1 and 2) is the
 * regular file `file` (same device and inode): the service started by launchd.
 * `npm start` in a terminal, the journal (Linux) and Windows' task answer
 * `false`, so a Switchboard never trims a file it does not write to.
 */
export async function writesTo(file: string, fds: readonly number[] = [1, 2]): Promise<boolean> {
  let target: Stats;
  try {
    target = await stat(file);
  } catch {
    return false;
  }
  if (!target.isFile()) return false;
  for (const fd of fds) {
    const stats = await fstatFd(fd);
    if (stats && stats.isFile() && stats.dev === target.dev && stats.ino === target.ino) return true;
  }
  return false;
}

/** Options of {@link ServiceLogRotation}. */
export interface ServiceLogRotationOptions {
  /** The log file (`serviceLogFile(dataDir)`). */
  readonly file: string;
  /** Both files together; default {@link SERVICE_LOG_MAX_BYTES}. */
  readonly maxBytes?: number;
  /** Default {@link SERVICE_LOG_CHECK_MS}. */
  readonly intervalMs?: number;
  /** Whether this process writes to `file`; default {@link writesTo}. Checked once, at start. */
  readonly isOwnOutput?: (file: string) => Promise<boolean>;
  readonly onRotate?: (result: RotateResult) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Keeps the service log under its cap while Switchboard runs: a check at start
 * (an already huge file is trimmed to its newest part right away) and then
 * every {@link SERVICE_LOG_CHECK_MS}. Does nothing unless this process's output
 * goes to that file.
 */
export class ServiceLogRotation {
  readonly #file: string;
  readonly #segment: number;
  readonly #intervalMs: number;
  readonly #isOwnOutput: (file: string) => Promise<boolean>;
  readonly #onRotate: (result: RotateResult) => void;
  readonly #onError: (error: unknown) => void;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(options: ServiceLogRotationOptions) {
    this.#file = options.file;
    this.#segment = Math.max(1, Math.floor((options.maxBytes ?? SERVICE_LOG_MAX_BYTES) / 2));
    this.#intervalMs = options.intervalMs ?? SERVICE_LOG_CHECK_MS;
    this.#isOwnOutput = options.isOwnOutput ?? ((file) => writesTo(file));
    this.#onRotate = options.onRotate ?? (() => undefined);
    this.#onError = options.onError ?? (() => undefined);
  }

  /** Checks now and, when this process writes the file, every interval. Resolves once the first check is done. */
  async start(): Promise<void> {
    let own: boolean;
    try {
      own = await this.#isOwnOutput(this.#file);
    } catch (error) {
      this.#onError(error);
      return;
    }
    if (!own || this.#stopped) return;
    await this.check();
    if (this.#stopped) return;
    this.#timer = setInterval(() => void this.check(), this.#intervalMs);
    this.#timer.unref();
  }

  /** One size check (and rotation when over the limit); never two at once. */
  check(): Promise<void> {
    this.#running = this.#running.then(async () => {
      try {
        const result = await rotateLog(this.#file, this.#segment);
        if (result.rotated) this.#onRotate(result);
      } catch (error) {
        this.#onError(error);
      }
    });
    return this.#running;
  }

  /** Stops the timer and waits for a check in progress. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }
}
