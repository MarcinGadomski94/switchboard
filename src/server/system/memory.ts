import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { runCommand, succeeded } from '../exec.ts';

/**
 * Memory actually in use (D17, `docs/setup.md` → *System*), the footer's RAM
 * meter. `os.totalmem() − os.freemem()` reads high on macOS, whose "free" leaves
 * out reclaimable file cache, so each OS is read the way its own tools count:
 * - **macOS:** app memory + wired + compressed from `vm_stat`, the way Activity
 *   Monitor's *Memory Used* counts it: (anonymous − purgeable pages) + wired
 *   pages + pages occupied by the compressor, × the page size of its header line;
 * - **Linux:** `MemTotal − MemAvailable` from `/proc/meminfo`;
 * - **Windows** (and any other OS): `null`, i.e. `totalmem − freemem`.
 * A read that fails (no `vm_stat`, an unreadable or unexpected output) is `null`
 * too, and the caller falls back to `total − free`.
 */

/** Reads the memory in use in bytes; `null` = use `total − free` (Windows, or the read failed). Never rejects. */
export type MemoryInUseReader = () => Promise<number | null>;

/** Where `vm_stat` is on macOS (a system binary; an absolute path, so `PATH` cannot redirect it). */
export const VM_STAT_PATH = '/usr/bin/vm_stat';

/** How long one `vm_stat` run may take (ms); it answers in a few ms. */
export const VM_STAT_TIMEOUT_MS = 5_000;

/** Where Linux keeps its memory counters. */
export const MEMINFO_PATH = '/proc/meminfo';

/** Options for {@link createMemoryInUseReader}. */
export interface MemoryReaderOptions {
  /** The OS (default `process.platform`). */
  readonly platform?: NodeJS.Platform;
  /** `vm_stat`'s output (default: {@link VM_STAT_PATH} run with `shell: false`); a rejection counts as a failed read. */
  readonly vmStat?: () => Promise<string>;
  /** The text of `/proc/meminfo` (default: read asynchronously); a rejection counts as a failed read. */
  readonly meminfo?: () => Promise<string>;
  /** Working folder of the `vm_stat` run (default the OS temp folder). */
  readonly cwd?: string;
}

/**
 * `vm_stat` output → bytes in use: (`Anonymous pages` − `Pages purgeable`) +
 * `Pages wired down` + `Pages occupied by compressor`, × the page size of the
 * header (`Mach Virtual Memory Statistics: (page size of 16384 bytes)`). `null`
 * when the page size or any of the four counters is missing or not a number.
 */
export function parseVmStat(text: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(text)?.[1];
  if (pageSize === undefined) return null;
  const counters = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*"?([^":]+?)"?:\s+(\d+)\.?\s*$/.exec(line);
    if (match) counters.set(match[1]!.trim().toLowerCase(), Number(match[2]));
  }
  const anonymous = counters.get('anonymous pages');
  const purgeable = counters.get('pages purgeable');
  const wired = counters.get('pages wired down');
  const compressor = counters.get('pages occupied by compressor');
  if (anonymous === undefined || purgeable === undefined || wired === undefined || compressor === undefined) return null;
  const pages = Math.max(0, anonymous - purgeable) + wired + compressor;
  const bytes = pages * Number(pageSize);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

/**
 * `/proc/meminfo` text → bytes in use: `MemTotal − MemAvailable` (both in kB).
 * `null` when either is missing (kernels before 3.14 have no `MemAvailable`) or
 * the result is negative.
 */
export function parseMeminfo(text: string): number | null {
  const read = (key: string): number | null => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB\\s*$`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = read('MemTotal');
  const available = read('MemAvailable');
  if (total === null || available === null || available > total) return null;
  return total - available;
}

/** Runs `vm_stat` (argv array, `shell: false`, async); rejects unless it exits 0. */
async function runVmStat(cwd: string): Promise<string> {
  const result = await runCommand([VM_STAT_PATH], [], { cwd, timeoutMs: VM_STAT_TIMEOUT_MS, maxOutputBytes: 64 * 1024 });
  if (!succeeded(result)) throw result.error ?? new Error(`vm_stat exited with ${String(result.code)}`);
  return result.stdout;
}

/** The {@link MemoryInUseReader} of this OS (the rules in this module's header). */
export function createMemoryInUseReader(options: MemoryReaderOptions = {}): MemoryInUseReader {
  const platform = options.platform ?? process.platform;
  const read = async (source: () => Promise<string>, parse: (text: string) => number | null): Promise<number | null> => {
    try {
      return parse(await source());
    } catch {
      return null;
    }
  };
  if (platform === 'darwin') {
    const cwd = options.cwd ?? os.tmpdir();
    const vmStat = options.vmStat ?? (() => runVmStat(cwd));
    return () => read(vmStat, parseVmStat);
  }
  if (platform === 'linux') {
    const meminfo = options.meminfo ?? (() => readFile(MEMINFO_PATH, 'utf8'));
    return () => read(meminfo, parseMeminfo);
  }
  return async () => null;
}
