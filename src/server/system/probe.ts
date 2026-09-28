import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SystemInfo } from '../../core/api.ts';
import { type RunResult, runCommand, succeeded } from '../exec.ts';
import type { SystemProvider } from '../providers.ts';
import { childEnv } from '../supervisor/argv.ts';
import { type MemoryInUseReader, createMemoryInUseReader } from './memory.ts';

/** How long a CLI / gh check is reused (ms): `/hub` asks every 5 s while a client is connected. */
export const CLI_CHECK_CACHE_MS = 30_000;

/** How long one `--version` / `auth status` may take (ms). */
export const CLI_CHECK_TIMEOUT_MS = 15_000;

/**
 * D17: a `system()` call starts a new memory read (`vm_stat` / `/proc/meminfo`) when
 * the last one started at least this long ago (ms). `/hub` asks every 5 s, so the
 * answer is the read after the previous tick; the route and the hub share reads.
 */
export const MEMORY_READ_INTERVAL_MS = 2_000;

/** The CLI and GitHub CLI part of `GET /api/system`. */
export interface CliStatus {
  readonly cli: string | null;
  readonly cliVersion: string | null;
  readonly signedIn: boolean;
  readonly ghSignedIn: boolean;
}

/** Machine-wide CPU time totals (ms) from `os.cpus()`. */
interface CpuSample {
  readonly idle: number;
  readonly total: number;
}

/** Options for {@link SystemProbe}. */
export interface SystemProbeOptions {
  /** `SWITCHBOARD_CLAUDE_BIN` as an argv prefix. */
  readonly claudeCommand: readonly string[];
  /** `SWITCHBOARD_GH_BIN` as an argv prefix. */
  readonly ghCommand: readonly string[];
  /** Working folder of the checks (the app-data folder). */
  readonly cwd: string;
  /** Live supervised `claude` processes (gap #11: `SessionSupervisor.liveCount`). */
  readonly processCount: () => number;
  /** Environment of the checks (default `process.env`); the claude checks get the supervisor's scrubbed copy. */
  readonly env?: NodeJS.ProcessEnv;
  readonly cacheMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /** CPU times (default `os.cpus()`). */
  readonly cpus?: () => readonly os.CpuInfo[];
  /** Memory in bytes (default `os.totalmem()` / `os.freemem()`). */
  readonly memory?: () => { readonly total: number; readonly free: number };
  /**
   * D17: memory actually in use, bytes (default: this OS's reader, `./memory.ts`:
   * `vm_stat` on macOS, `/proc/meminfo` on Linux, `null` elsewhere). `null` or a
   * failed read → `total − free`.
   */
  readonly memoryInUse?: MemoryInUseReader;
}

function cpuSample(cpus: readonly os.CpuInfo[]): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/**
 * `claude --version` prints `2.1.283 (Claude Code)`: the version is its first
 * word that looks like one, else the first line as printed.
 */
export function parseCliVersion(stdout: string): string | null {
  const line = stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (!line) return null;
  return /\d+\.\d+\.\d+[^\s]*/.exec(line)?.[0] ?? line;
}

/**
 * Where a one-word command resolves on `PATH` (with `PATHEXT` on Windows), like
 * the shell would; a command with a path separator resolves against the working
 * folder. `null` when no executable file is found.
 */
export async function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Promise<string | null> {
  const isWindows = process.platform === 'win32';
  const exts = isWindows ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const candidates: string[] = [];
  if (command.includes('/') || (isWindows && command.includes('\\'))) {
    for (const ext of exts) candidates.push(path.resolve(cwd, command + ext));
  } else {
    for (const dir of (env['PATH'] ?? '').split(path.delimiter).filter(Boolean)) {
      for (const ext of exts) candidates.push(path.join(dir, command + ext));
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, isWindows ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

/**
 * The real {@link SystemProvider} behind `GET /api/system` and the `/hub`
 * `system` event (M5.3, gap #11, `docs/setup.md` → *System*):
 * - `cli` / `cliVersion`: `<claude bin> --version` exits 0 → the command (its
 *   `PATH` location for a one-word command, the whole argv prefix otherwise) and
 *   the version it printed; anything else → `null` / `null`.
 * - `signedIn`: `<claude bin> auth status` exits 0 (only the exit code is read,
 *   M1.2); `ghSignedIn`: `<gh bin> auth status` exits 0.
 * - `cpu`: machine-wide CPU % since the previous reading (`os.cpus()` times);
 *   `ramTotal`: `os.totalmem()`; `ramUsed` (D17): the memory actually in use
 *   ({@link MemoryInUseReader}: Activity Monitor's *Memory Used* on macOS,
 *   `MemTotal − MemAvailable` on Linux), `totalmem − freemem` on Windows or when
 *   that read fails; bytes. The read runs in the background: `system()` answers
 *   from the last one (started at construction, then at most every
 *   {@link MEMORY_READ_INTERVAL_MS}) and never waits for it.
 * - `processes`: live supervised `claude` processes.
 * - Usage fields are added by the meter (`withUsage`, M9.2 / D17).
 * The three commands run with `shell: false`, never make a model call, and are
 * reused for {@link CLI_CHECK_CACHE_MS}; `fresh` checks again.
 */
export class SystemProbe implements SystemProvider {
  readonly #options: SystemProbeOptions;
  readonly #now: () => number;
  readonly #cpus: () => readonly os.CpuInfo[];
  readonly #memory: () => { readonly total: number; readonly free: number };
  readonly #memoryInUse: MemoryInUseReader;
  /** The last memory read (bytes); `null` = none yet, or it failed → `total − free`. */
  #ramInUse: number | null = null;
  #ramReadAt = Number.NEGATIVE_INFINITY;
  #ramReading: Promise<void> | null = null;
  #cached: { readonly at: number; readonly value: CliStatus } | null = null;
  #inflight: Promise<CliStatus> | null = null;
  #lastCpu: CpuSample;
  #cpuPct = 0;

  constructor(options: SystemProbeOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#cpus = options.cpus ?? os.cpus;
    this.#memory = options.memory ?? (() => ({ total: os.totalmem(), free: os.freemem() }));
    this.#memoryInUse = options.memoryInUse ?? createMemoryInUseReader({ cwd: options.cwd });
    this.#lastCpu = cpuSample(this.#cpus());
    void this.refreshMemory();
  }

  async system(options: { readonly fresh?: boolean } = {}): Promise<SystemInfo> {
    const status = await this.cliStatus(options.fresh ?? false);
    const memory = this.#memory();
    if (this.#now() - this.#ramReadAt >= MEMORY_READ_INTERVAL_MS) void this.refreshMemory();
    const used = this.#ramInUse ?? memory.total - memory.free;
    return {
      ...status,
      cpu: this.#cpu(),
      ramUsed: Math.min(memory.total, Math.max(0, used)),
      ramTotal: memory.total,
      processes: this.#options.processCount(),
    };
  }

  /**
   * Reads the memory in use now (D17) and keeps it for the next `system()` answers;
   * a failed read (or `null`) makes them use `total − free`. Concurrent callers
   * share one read; never rejects.
   */
  refreshMemory(): Promise<void> {
    if (this.#ramReading) return this.#ramReading;
    this.#ramReadAt = this.#now();
    const run = Promise.resolve()
      .then(() => this.#memoryInUse())
      .catch(() => null)
      .then((value) => {
        this.#ramInUse = value !== null && Number.isFinite(value) && value >= 0 ? value : null;
      })
      .finally(() => {
        this.#ramReading = null;
      });
    this.#ramReading = run;
    return run;
  }

  /** The CLI / gh checks, from the cache unless `fresh` or older than {@link CLI_CHECK_CACHE_MS}; concurrent callers share one run. */
  async cliStatus(fresh = false): Promise<CliStatus> {
    const cacheMs = this.#options.cacheMs ?? CLI_CHECK_CACHE_MS;
    if (!fresh && this.#cached && this.#now() - this.#cached.at < cacheMs) return this.#cached.value;
    if (this.#inflight) return this.#inflight;
    const run = this.#check().then(
      (value) => {
        this.#cached = { at: this.#now(), value };
        return value;
      },
    );
    this.#inflight = run;
    try {
      return await run;
    } finally {
      this.#inflight = null;
    }
  }

  async #check(): Promise<CliStatus> {
    const { claudeCommand, ghCommand, cwd } = this.#options;
    const env = this.#options.env ?? process.env;
    const timeoutMs = this.#options.timeoutMs ?? CLI_CHECK_TIMEOUT_MS;
    const claudeEnv = childEnv(env);
    const run = (command: readonly string[], args: readonly string[], runEnv: NodeJS.ProcessEnv): Promise<RunResult> =>
      runCommand(command, args, { cwd, env: runEnv, timeoutMs, maxOutputBytes: 1024 * 1024 });
    const [version, auth, gh] = await Promise.all([
      run(claudeCommand, ['--version'], claudeEnv),
      run(claudeCommand, ['auth', 'status'], claudeEnv),
      run(ghCommand, ['auth', 'status'], env),
    ]);
    const found = succeeded(version);
    return {
      cli: found ? await this.#display(claudeCommand, env) : null,
      cliVersion: found ? parseCliVersion(version.stdout) : null,
      signedIn: found && succeeded(auth),
      ghSignedIn: succeeded(gh),
    };
  }

  async #display(command: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
    if (command.length !== 1) return command.join(' ');
    const only = command[0] as string;
    return (await resolveExecutable(only, env, this.#options.cwd)) ?? only;
  }

  #cpu(): number {
    const sample = cpuSample(this.#cpus());
    const total = sample.total - this.#lastCpu.total;
    const idle = sample.idle - this.#lastCpu.idle;
    if (total > 0) {
      this.#cpuPct = Math.min(100, Math.max(0, Math.round((1 - idle / total) * 100)));
      this.#lastCpu = sample;
    }
    return this.#cpuPct;
  }
}
