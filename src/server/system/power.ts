import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type BatteryReading,
  type LinuxSupply,
  LINUX_SUPPLY_FILES,
  POWER_ESTIMATE_UNSET,
  type PowerEstimateSettings,
  type PowerStatus,
  WINDOWS_POWER_SCRIPT,
  batteryPower,
  defaultPowerEstimate,
  effectivePowerEstimate,
  estimatedPower,
  macBattery,
  parseIoregBattery,
  parseLinuxBatteries,
  parseNvidiaSmi,
  parsePmsetBatt,
  parseWindowsBattery,
  readPowerStatus,
  samePower,
} from '../../core/power.ts';
import { type RunResult, runCommand, succeeded } from '../exec.ts';

/**
 * D125 · the power sampler (`docs/power.md`): this machine's battery, or an
 * estimated total on a machine without one, for `SystemInfo.power` (the footer,
 * Settings → Machines) and the paired machines (`/hub` `machinePower`).
 *
 * - **On demand, at most every {@link POWER_SAMPLE_MS}:** {@link PowerSampler.current}
 *   answers from the last sample and starts a new one in the background when it
 *   is older. It is asked by `GET /api/system` / the `/hub` `system` tick (while a
 *   page is open) and by the peer streams' keepalive (while a paired machine
 *   listens); nobody asking = nothing runs. Samples never overlap.
 * - **Read-only, no admin / sudo, `shell: false`, every command with a timeout.**
 * - **A source that is not there is not retried every time:** no battery, no
 *   `nvidia-smi`, no amdgpu, an unreadable RAPL counter are remembered for
 *   {@link POWER_UNAVAILABLE_RETRY_MS} (then checked again).
 * - Nothing is stored; only the last reading is kept in memory.
 */

/** The shortest gap between two samples (ms). */
export const POWER_SAMPLE_MS = 30_000;

/** How long a missing source is not asked again (ms). */
export const POWER_UNAVAILABLE_RETRY_MS = 60 * 60_000;

/** One command's time limit (ms): `pmset`, `ioreg`, `nvidia-smi`. */
export const POWER_COMMAND_TIMEOUT_MS = 5_000;

/** The PowerShell call's time limit (ms): its start alone can take a second on a busy Windows. */
export const POWER_WINDOWS_TIMEOUT_MS = 15_000;

/** Absolute paths of the macOS tools (system binaries, so `PATH` cannot redirect them). */
export const PMSET_PATH = '/usr/bin/pmset';
export const IOREG_PATH = '/usr/sbin/ioreg';

const POWER_SUPPLY_DIR = '/sys/class/power_supply';
const DRM_DIR = '/sys/class/drm';
const POWERCAP_DIR = '/sys/class/powercap';

/** Runs one command (argv, `shell: false`) with a time limit. */
export type PowerRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<RunResult>;

/** Options of {@link PowerSampler}; everything defaults to this machine. */
export interface PowerSamplerOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  /** The command runner (tests: canned outputs). */
  readonly run?: PowerRunner;
  /** Reads a text file (Linux sysfs); rejects when missing or unreadable. */
  readonly readText?: (file: string) => Promise<string>;
  /** Lists a folder's entries; rejects when missing. */
  readonly listDir?: (dir: string) => Promise<string[]>;
  readonly now?: () => number;
  /** CPU times (default `os.cpus()`), for the utilisation. */
  readonly cpus?: () => readonly os.CpuInfo[];
  /** The stored estimate settings (Settings → Machines → *Power estimate*). */
  readonly estimateSettings?: () => Promise<PowerEstimateSettings>;
  /** A sample said something new (not just a newer time). */
  readonly onChange?: (power: PowerStatus) => void;
  readonly intervalMs?: number;
  readonly retryMs?: number;
  readonly timeoutMs?: number;
  readonly windowsTimeoutMs?: number;
  /**
   * **Tests only** (`SWITCHBOARD_POWER_TEST_FILE`): a JSON file holding the
   * reading to report (its `at` is replaced), read again at every sample; no
   * command runs.
   */
  readonly testFile?: string | null;
  /** Working folder of the commands (default the OS temp folder). */
  readonly cwd?: string;
  readonly onError?: (error: unknown) => void;
}

interface CpuTotals {
  readonly idle: number;
  readonly total: number;
}

function cpuTotals(cpus: readonly os.CpuInfo[]): CpuTotals {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** A missing source (not there, or no permission): retried after {@link POWER_UNAVAILABLE_RETRY_MS}. */
class Unavailable extends Error {}

/** Where `powershell.exe` is (`%SystemRoot%`, else `PATH`). */
function powershellPath(): string {
  const root = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'];
  return root ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}

/** See the module header. */
export class PowerSampler {
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;
  readonly #run: PowerRunner;
  readonly #readText: (file: string) => Promise<string>;
  readonly #listDir: (dir: string) => Promise<string[]>;
  readonly #now: () => number;
  readonly #cpus: () => readonly os.CpuInfo[];
  readonly #options: PowerSamplerOptions;
  #last: PowerStatus | null = null;
  #startedAt = Number.NEGATIVE_INFINITY;
  #inflight: Promise<void> | null = null;
  /** Source → when it may be asked again (ms). */
  readonly #unavailable = new Map<string, number>();
  #lastCpu: CpuTotals;
  /** Linux RAPL: each package zone's last counter (µJ) and when it was read (ms). */
  #rapl: Map<string, { readonly energy: number; readonly max: number; readonly at: number }> | null = null;
  /** How many samples ran (tests and the docs' cost note). */
  samples = 0;

  constructor(options: PowerSamplerOptions = {}) {
    this.#options = options;
    this.#platform = options.platform ?? process.platform;
    this.#arch = options.arch ?? process.arch;
    const cwd = options.cwd ?? os.tmpdir();
    this.#run = options.run ?? ((command, args, timeoutMs) => runCommand([command], args, { cwd, timeoutMs, maxOutputBytes: 1024 * 1024 }));
    this.#readText = options.readText ?? ((file) => readFile(file, 'utf8'));
    this.#listDir = options.listDir ?? ((dir) => readdir(dir));
    this.#now = options.now ?? Date.now;
    this.#cpus = options.cpus ?? os.cpus;
    this.#lastCpu = cpuTotals(this.#cpus());
  }

  /** The last reading (`null` before the first); starts a new sample in the background when the last one is due. */
  current(): PowerStatus | null {
    if (!this.#inflight && this.#now() - this.#startedAt >= (this.#options.intervalMs ?? POWER_SAMPLE_MS)) void this.refresh();
    return this.#last;
  }

  /** The last reading, without starting a sample. */
  get last(): PowerStatus | null {
    return this.#last;
  }

  /** Takes a sample now (callers share a running one); never rejects. */
  refresh(): Promise<void> {
    if (this.#inflight) return this.#inflight;
    this.#startedAt = this.#now();
    const run = this.#sample()
      .then((power) => {
        this.samples += 1;
        const changed = !samePower(this.#last, power);
        this.#last = power;
        if (changed) this.#options.onChange?.(power);
      })
      .catch((error: unknown) => this.#options.onError?.(error))
      .finally(() => {
        this.#inflight = null;
      });
    this.#inflight = run;
    return run;
  }

  #at(): string {
    return new Date(this.#now()).toISOString();
  }

  #available(source: string): boolean {
    const until = this.#unavailable.get(source);
    return until === undefined || this.#now() >= until;
  }

  #markUnavailable(source: string): void {
    this.#unavailable.set(source, this.#now() + (this.#options.retryMs ?? POWER_UNAVAILABLE_RETRY_MS));
  }

  /**
   * Runs `read` unless `source` is known missing; a missing source (an
   * {@link Unavailable} thrown, or a `null` answer unless `nullIsMissing` is off)
   * is remembered, then `null`.
   */
  async #guarded<T>(source: string, read: () => Promise<T | null>, nullIsMissing = true): Promise<T | null> {
    if (!this.#available(source)) return null;
    try {
      const value = await read();
      if (value === null && nullIsMissing) this.#markUnavailable(source);
      else this.#unavailable.delete(source);
      return value;
    } catch (error) {
      if (error instanceof Unavailable) {
        this.#markUnavailable(source);
        return null;
      }
      throw error;
    }
  }

  async #sample(): Promise<PowerStatus> {
    if (this.#options.testFile) {
      const reading = readPowerStatus(JSON.parse(await this.#readText(this.#options.testFile)));
      return reading ? { ...reading, at: this.#at() } : { kind: 'none', at: this.#at() };
    }
    const util = this.#cpuUtil();
    const battery = await this.#guarded('battery', () => this.#battery());
    if (battery) return batteryPower(battery, this.#at());
    const [gpu, cpuMeasuredW, stored] = await Promise.all([this.#gpu(), this.#guarded('rapl', () => this.#raplWatts(), false), this.#estimateSettings()]);
    const model = effectivePowerEstimate(stored, defaultPowerEstimate(this.#cpus().length, this.#platform, this.#arch));
    return estimatedPower({ cpuUtil: util, cpuMeasuredW, gpu, model, at: this.#at() });
  }

  async #estimateSettings(): Promise<PowerEstimateSettings> {
    try {
      return (await this.#options.estimateSettings?.()) ?? POWER_ESTIMATE_UNSET;
    } catch {
      return POWER_ESTIMATE_UNSET;
    }
  }

  /** CPU utilisation (0–1) since the last sample. */
  #cpuUtil(): number {
    const sample = cpuTotals(this.#cpus());
    const total = sample.total - this.#lastCpu.total;
    const idle = sample.idle - this.#lastCpu.idle;
    this.#lastCpu = sample;
    return total > 0 ? Math.max(0, Math.min(1, 1 - idle / total)) : 0;
  }

  /** This OS's battery, `null` without one; a failed command fails the sample (the last reading stays). */
  async #battery(): Promise<BatteryReading | null> {
    const timeout = this.#options.timeoutMs ?? POWER_COMMAND_TIMEOUT_MS;
    if (this.#platform === 'darwin') {
      const pmset = await this.#run(PMSET_PATH, ['-g', 'batt'], timeout);
      if (!succeeded(pmset)) throw new Error(`pmset failed: ${pmset.error?.message ?? `exit ${String(pmset.code)}`}`);
      const parsed = parsePmsetBatt(pmset.stdout);
      if (!parsed.battery) return null;
      const ioreg = await this.#run(IOREG_PATH, ['-rn', 'AppleSmartBattery'], timeout);
      return macBattery(parsed, succeeded(ioreg) ? parseIoregBattery(ioreg.stdout) : null);
    }
    if (this.#platform === 'win32') {
      const result = await this.#run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_POWER_SCRIPT], this.#options.windowsTimeoutMs ?? POWER_WINDOWS_TIMEOUT_MS);
      if (!succeeded(result)) throw new Error(`the battery query failed: ${result.error?.message ?? `exit ${String(result.code)}`}`);
      return parseWindowsBattery(result.stdout);
    }
    if (this.#platform === 'linux') return parseLinuxBatteries(await this.#linuxSupplies());
    return null;
  }

  async #linuxSupplies(): Promise<LinuxSupply[]> {
    let names: string[];
    try {
      names = await this.#listDir(POWER_SUPPLY_DIR);
    } catch {
      return [];
    }
    return Promise.all(
      names.map(async (name) => {
        const files: Record<string, string> = {};
        await Promise.all(
          LINUX_SUPPLY_FILES.map(async (file) => {
            try {
              files[file] = (await this.#readText(path.posix.join(POWER_SUPPLY_DIR, name, file))).trim();
            } catch {
              // Not every supply has every file.
            }
          }),
        );
        return { name, files };
      }),
    );
  }

  /** Measured GPU draw: `nvidia-smi` (not on macOS), plus Linux amdgpu hwmon; `null` without a reading. */
  async #gpu(): Promise<{ readonly watts: number; readonly count: number } | null> {
    const [nvidia, amd] = await Promise.all([
      this.#platform === 'darwin' ? null : this.#guarded('nvidia-smi', () => this.#nvidia()),
      this.#platform === 'linux' ? this.#guarded('amdgpu', () => this.#amdgpu()) : null,
    ]);
    if (!nvidia && !amd) return null;
    return { watts: (nvidia?.watts ?? 0) + (amd?.watts ?? 0), count: (nvidia?.count ?? 0) + (amd?.count ?? 0) };
  }

  async #nvidia(): Promise<{ readonly watts: number; readonly count: number } | null> {
    const result = await this.#run('nvidia-smi', ['--query-gpu=power.draw', '--format=csv,noheader,nounits'], this.#options.timeoutMs ?? POWER_COMMAND_TIMEOUT_MS);
    if (!succeeded(result)) throw new Unavailable('nvidia-smi');
    return parseNvidiaSmi(result.stdout);
  }

  /** Linux amdgpu: `power1_average` (else `power1_input`) in µW of each `amdgpu` hwmon. */
  async #amdgpu(): Promise<{ readonly watts: number; readonly count: number } | null> {
    let cards: string[];
    try {
      cards = (await this.#listDir(DRM_DIR)).filter((name) => /^card\d+$/.test(name));
    } catch {
      return null;
    }
    let watts = 0;
    let count = 0;
    for (const card of cards) {
      const hwmonDir = path.posix.join(DRM_DIR, card, 'device', 'hwmon');
      let hwmons: string[];
      try {
        hwmons = await this.#listDir(hwmonDir);
      } catch {
        continue;
      }
      for (const hwmon of hwmons) {
        const dir = path.posix.join(hwmonDir, hwmon);
        const name = await this.#readText(path.posix.join(dir, 'name')).then((text) => text.trim(), () => '');
        if (name !== 'amdgpu') continue;
        for (const file of ['power1_average', 'power1_input']) {
          const raw = await this.#readText(path.posix.join(dir, file)).catch(() => null);
          const value = raw === null ? NaN : Number(raw.trim());
          if (Number.isFinite(value) && value >= 0) {
            watts += value / 1e6;
            count += 1;
            break;
          }
        }
      }
    }
    return count > 0 ? { watts, count } : null;
  }

  /**
   * Linux RAPL: the package zones' (`intel-rapl:N`) energy counters, watts from
   * their change since the last sample (wrapping at `max_energy_range_uj`). The
   * first read only primes them (the estimate is used). Unreadable (root-only
   * on most current kernels) → unavailable.
   */
  async #raplWatts(): Promise<number | null> {
    if (this.#platform !== 'linux') throw new Unavailable('rapl');
    let zones: string[];
    try {
      zones = (await this.#listDir(POWERCAP_DIR)).filter((name) => /^intel-rapl:\d+$/.test(name));
    } catch {
      throw new Unavailable('rapl');
    }
    if (zones.length === 0) throw new Unavailable('rapl');
    const now = this.#now();
    const next = new Map<string, { energy: number; max: number; at: number }>();
    for (const zone of zones) {
      const dir = path.posix.join(POWERCAP_DIR, zone);
      let energy: number;
      try {
        energy = Number((await this.#readText(path.posix.join(dir, 'energy_uj'))).trim());
      } catch {
        throw new Unavailable('rapl');
      }
      const max = Number((await this.#readText(path.posix.join(dir, 'max_energy_range_uj')).catch(() => '0')).trim());
      if (!Number.isFinite(energy)) throw new Unavailable('rapl');
      next.set(zone, { energy, max: Number.isFinite(max) ? max : 0, at: now });
    }
    const previous = this.#rapl;
    this.#rapl = next;
    if (!previous) return null;
    let watts = 0;
    for (const [zone, reading] of next) {
      const before = previous.get(zone);
      if (!before || reading.at <= before.at) return null;
      let delta = reading.energy - before.energy;
      if (delta < 0) delta += reading.max;
      if (delta < 0) return null;
      watts += delta / 1e6 / ((reading.at - before.at) / 1000);
    }
    return watts;
  }
}
