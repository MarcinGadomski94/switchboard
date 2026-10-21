/**
 * D125 · machine power (`docs/power.md`): the pure part. A laptop reports its
 * battery (percent, charging or not, the OS's own time estimate and the draw in
 * W when the OS tells it); a machine without a battery reports an **estimated**
 * total: measured GPU watts where a no-admin reading exists, the CPU from its
 * utilisation (or a real package reading on Linux), plus a fixed baseline for
 * the rest. This module parses each OS's command outputs, does the estimate and
 * formats the result for the UI. Side-effect free; shared by the server
 * (`src/server/system/power.ts`) and the UI. No admin or sudo is ever needed.
 */

/** What a machine's power reading is. */
export type PowerKind =
  /** A battery: `percent`, `charging`, the OS's estimate, `watts` when readable. */
  | 'battery'
  /** No battery: `watts` is an estimate (`parts`), never a measurement. */
  | 'estimated'
  /** Nothing could be read (the UI shows nothing). */
  | 'none';

/** D125: the parts of an estimated total (whole watts). */
export interface PowerParts {
  /** Measured GPU draw (`nvidia-smi`, Linux amdgpu hwmon), summed over GPUs; absent when none could be read. */
  readonly gpu?: number;
  /** How many GPUs `gpu` sums. */
  readonly gpuCount?: number;
  /** The CPU: `idle + util × (max − idle)`, or a real package reading when {@link cpuMeasured}. */
  readonly cpu?: number;
  /** The CPU utilisation the estimate used (0–100). */
  readonly cpuPct?: number;
  /** `cpu` is a real package reading (Linux RAPL), not the utilisation estimate. */
  readonly cpuMeasured?: true;
  /** The fixed baseline for the rest of the system. */
  readonly base?: number;
}

/**
 * D125 (additive `SystemInfo.power`, `Machine.power`): this machine's power as
 * last sampled (at most every 30 s).
 */
export interface PowerStatus {
  readonly kind: PowerKind;
  /** Battery charge, 0–100. */
  readonly percent?: number;
  /** The battery is charging now. */
  readonly charging?: boolean;
  /** On mains power (charging, full, or held below full). */
  readonly pluggedIn?: boolean;
  /** The OS's estimate of the time to empty while discharging (minutes). */
  readonly minutesLeft?: number;
  /** The time to full while charging (minutes): the OS's, else from the charge rate. */
  readonly minutesToFull?: number;
  /** Battery: the system's draw when readable (1 decimal). Estimated: the estimated total (whole W). */
  readonly watts?: number;
  /** macOS on AC: the adapter's rating (W). */
  readonly adapterWatts?: number;
  /** Estimated only: what the total is made of. */
  readonly parts?: PowerParts;
  /** When it was sampled (ISO). */
  readonly at: string;
}

/** A battery as one OS's commands describe it (before it becomes a {@link PowerStatus}). */
export interface BatteryReading {
  readonly percent: number;
  readonly charging: boolean;
  readonly pluggedIn: boolean;
  readonly minutesLeft?: number;
  readonly minutesToFull?: number;
  readonly watts?: number;
  readonly adapterWatts?: number;
}

/** D125: the editable estimate settings (Settings → Machines → *Power estimate*); `null` = this machine's default. */
export interface PowerEstimateSettings {
  readonly cpuIdleW: number | null;
  readonly cpuMaxW: number | null;
  readonly baseW: number | null;
}

/** D125: the numbers an estimate is made with. */
export interface PowerEstimateModel {
  readonly cpuIdleW: number;
  readonly cpuMaxW: number;
  readonly baseW: number;
}

/** Nothing set: every part uses this machine's default. */
export const POWER_ESTIMATE_UNSET: PowerEstimateSettings = { cpuIdleW: null, cpuMaxW: null, baseW: null };

/** The largest watt value the estimate settings accept. */
export const POWER_ESTIMATE_MAX_W = 2_000;

/** Windows `Win32_Battery.EstimatedRunTime` when the time is unknown (or the machine is on AC). */
export const WIN_RUNTIME_UNKNOWN = 71_582_788;

const round1 = (value: number): number => Math.round(value * 10) / 10;

function finite(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

// ── macOS ───────────────────────────────────────────────────────────────

/** `pmset -g batt`, parsed. */
export interface PmsetBattery {
  /** `Now drawing from 'AC Power'` / `'Battery Power'`; `null` when the line is missing. */
  readonly source: 'ac' | 'battery' | null;
  /** The internal battery line; `null` on a Mac without one. */
  readonly battery: { readonly percent: number; readonly state: string; readonly minutes: number | null } | null;
}

/**
 * `pmset -g batt` → the power source and the internal battery (`64%;
 * discharging; 2:10 remaining`). `minutes` is `null` for `(no estimate)` and for
 * states without a time (`charged`, `AC attached; not charging`).
 */
export function parsePmsetBatt(text: string): PmsetBattery {
  const from = /drawing from '([^']+)'/.exec(text)?.[1]?.toLowerCase() ?? null;
  const source = from === null ? null : from.includes('ac') ? 'ac' : from.includes('battery') ? 'battery' : null;
  const line = /-InternalBattery-\d+[^\n]*?(\d{1,3})%;\s*([^;\n]+)(?:;\s*([^\n]*))?/.exec(text);
  if (!line) return { source, battery: null };
  const state = line[2]!.trim().toLowerCase();
  const time = /(\d+):(\d{2})\s+remaining/.exec(line[3] ?? '');
  let minutes = time ? Number(time[1]) * 60 + Number(time[2]) : null;
  // `0:00 remaining` on a full battery is no estimate.
  if (minutes === 0 && state !== 'discharging') minutes = null;
  return { source, battery: { percent: clampPercent(Number(line[1])), state, minutes } };
}

/** `ioreg -rn AppleSmartBattery`, the parts D125 uses. */
export interface IoregBattery {
  /** Current in mA: negative = discharging (the 64-bit unsigned value read as signed). */
  readonly amperageMa: number | null;
  readonly voltageMv: number | null;
  readonly charging: boolean | null;
  readonly externalConnected: boolean | null;
  /** `AdapterDetails` → `Watts`. */
  readonly adapterWatts: number | null;
  /** `PowerTelemetryData` → `SystemPowerIn` (mW): the whole system's draw from the adapter. */
  readonly systemPowerInMw: number | null;
}

/** An `ioreg` integer: values ≥ 2^63 are negative numbers printed unsigned. */
function ioregInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const big = BigInt(raw);
  const signed = big >= 1n << 63n ? big - (1n << 64n) : big;
  const value = Number(signed);
  return Number.isFinite(value) ? value : null;
}

/** `ioreg -rn AppleSmartBattery` → amperage, voltage, flags and the adapter; `null` when it lists no battery. */
export function parseIoregBattery(text: string): IoregBattery | null {
  const top = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^[\s|]*"(\w+)" = (.+?)\s*$/.exec(line);
    if (match && !top.has(match[1]!)) top.set(match[1]!, match[2]!);
  }
  if (!top.has('Voltage') && !top.has('Amperage') && !top.has('InstantAmperage')) return null;
  const int = (key: string): number | null => {
    const raw = top.get(key);
    return raw === undefined ? null : ioregInt(raw);
  };
  const flag = (key: string): boolean | null => {
    const raw = top.get(key);
    return raw === 'Yes' ? true : raw === 'No' ? false : null;
  };
  const nested = (key: string, field: string): number | null => {
    const raw = top.get(key);
    const match = raw ? new RegExp(`"${field}"=(\\d+)`).exec(raw) : null;
    return match ? ioregInt(match[1]!) : null;
  };
  const instant = int('InstantAmperage');
  return {
    amperageMa: instant !== null && instant !== 0 ? instant : int('Amperage'),
    voltageMv: int('Voltage'),
    charging: flag('IsCharging'),
    externalConnected: flag('ExternalConnected'),
    adapterWatts: nested('AdapterDetails', 'Watts'),
    systemPowerInMw: nested('PowerTelemetryData', 'SystemPowerIn'),
  };
}

/**
 * macOS: `pmset` (percent, state, the OS's time) + `ioreg` (the draw) → a
 * battery, or `null` on a Mac without one. Discharging: the draw is
 * |amperage| × voltage. On AC: the system's draw from the adapter
 * (`SystemPowerIn`) when the Mac reports it, and the adapter's rating.
 */
export function macBattery(pmset: PmsetBattery, ioreg: IoregBattery | null): BatteryReading | null {
  const battery = pmset.battery;
  if (!battery) return null;
  const charging = battery.state === 'charging' || battery.state === 'finishing charge';
  const discharging = battery.state === 'discharging';
  const pluggedIn = pmset.source === 'ac' || (!discharging && pmset.source !== 'battery');
  let watts: number | undefined;
  if (ioreg) {
    const { amperageMa, voltageMv, systemPowerInMw } = ioreg;
    if (discharging && amperageMa !== null && voltageMv !== null && amperageMa < 0) watts = round1((-amperageMa * voltageMv) / 1e6);
    else if (pluggedIn && systemPowerInMw !== null && systemPowerInMw > 0) watts = round1(systemPowerInMw / 1000);
  }
  return {
    percent: battery.percent,
    charging,
    pluggedIn,
    ...(discharging && battery.minutes !== null ? { minutesLeft: battery.minutes } : {}),
    ...(charging && battery.minutes !== null ? { minutesToFull: battery.minutes } : {}),
    ...(watts !== undefined && watts > 0 ? { watts } : {}),
    ...(pluggedIn && ioreg?.adapterWatts ? { adapterWatts: ioreg.adapterWatts } : {}),
  };
}

// ── Windows ─────────────────────────────────────────────────────────────

/**
 * The one PowerShell call per sample (no admin): `Win32_Battery` (percent, the
 * OS's run time, status), `root/wmi` `BatteryStatus` (charge / discharge rate in
 * mW, remaining mWh, on AC) and `BatteryFullChargedCapacity` (mWh), as one
 * compressed JSON object `{ battery, status, full }`.
 */
export const WINDOWS_POWER_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$b=@(Get-CimInstance -ClassName Win32_Battery | Select-Object EstimatedChargeRemaining,EstimatedRunTime,BatteryStatus)',
  '$s=@(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object ChargeRate,DischargeRate,RemainingCapacity,PowerOnline,Charging,Discharging)',
  '$f=@(Get-CimInstance -Namespace root/wmi -ClassName BatteryFullChargedCapacity | Select-Object FullChargedCapacity)',
  '[pscustomobject]@{battery=$b;status=$s;full=$f} | ConvertTo-Json -Compress -Depth 3',
].join(';');

function rows(value: unknown): Record<string, unknown>[] {
  const list = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return list.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
}

/**
 * {@link WINDOWS_POWER_SCRIPT}'s JSON → a battery, or `null` without one (a
 * desktop) or for an unreadable answer. Percent: the average
 * `EstimatedChargeRemaining`. Discharging: the draw is the summed
 * `DischargeRate`, the time `EstimatedRunTime` ({@link WIN_RUNTIME_UNKNOWN} =
 * unknown), else remaining ÷ rate. Charging: time to full = (full − remaining) ÷
 * `ChargeRate`.
 */
export function parseWindowsBattery(json: string): BatteryReading | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.trim().replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const batteries = rows(record['battery']);
  if (batteries.length === 0) return null;
  const status = rows(record['status']);
  const full = rows(record['full']);
  const percents = batteries.map((row) => finite(row['EstimatedChargeRemaining'])).filter((n): n is number => n !== null);
  const sum = (list: Record<string, unknown>[], key: string): number => list.reduce((total, row) => total + Math.max(0, finite(row[key]) ?? 0), 0);
  const remaining = sum(status, 'RemainingCapacity');
  const fullCapacity = sum(full, 'FullChargedCapacity');
  let percent: number | null = percents.length > 0 ? percents.reduce((a, b) => a + b, 0) / percents.length : null;
  if (percent === null && remaining > 0 && fullCapacity > 0) percent = (remaining / fullCapacity) * 100;
  if (percent === null) return null;
  // Win32_Battery.BatteryStatus: 1 discharging, 2 on AC, 3 fully charged, 6–9 charging.
  const codes = batteries.map((row) => finite(row['BatteryStatus']));
  const charging = status.some((row) => row['Charging'] === true) || codes.some((code) => code !== null && code >= 6 && code <= 9);
  const pluggedIn = charging || status.some((row) => row['PowerOnline'] === true) || codes.some((code) => code === 2 || code === 3);
  const dischargeMw = sum(status, 'DischargeRate');
  const chargeMw = sum(status, 'ChargeRate');
  const discharging = !pluggedIn;
  let minutesLeft: number | undefined;
  if (discharging) {
    const runtimes = batteries.map((row) => finite(row['EstimatedRunTime'])).filter((n): n is number => n !== null && n > 0 && n !== WIN_RUNTIME_UNKNOWN);
    if (runtimes.length > 0) minutesLeft = Math.round(Math.max(...runtimes));
    else if (remaining > 0 && dischargeMw > 0) minutesLeft = Math.round((remaining / dischargeMw) * 60);
  }
  let minutesToFull: number | undefined;
  if (charging && chargeMw > 0 && fullCapacity > remaining && remaining > 0) minutesToFull = Math.round(((fullCapacity - remaining) / chargeMw) * 60);
  return {
    percent: clampPercent(percent),
    charging,
    pluggedIn,
    ...(minutesLeft !== undefined ? { minutesLeft } : {}),
    ...(minutesToFull !== undefined ? { minutesToFull } : {}),
    ...(discharging && dischargeMw > 0 ? { watts: round1(dischargeMw / 1000) } : {}),
  };
}

// ── Linux ───────────────────────────────────────────────────────────────

/** One `/sys/class/power_supply/<name>` folder: its readable files' trimmed text. */
export interface LinuxSupply {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
}

/** The files D125 reads from a power supply folder. */
export const LINUX_SUPPLY_FILES = [
  'type',
  'scope',
  'online',
  'status',
  'capacity',
  'power_now',
  'current_now',
  'voltage_now',
  'energy_now',
  'energy_full',
  'charge_now',
  'charge_full',
  'time_to_empty_now',
  'time_to_full_now',
] as const;

/**
 * `/sys/class/power_supply/*` → the system batteries combined (`type` Battery,
 * not a device's `scope`), or `null` without one. Draw: `power_now` (µW), else
 * `current_now` × `voltage_now` (µA × µV). Time: the kernel's
 * `time_to_empty_now` / `time_to_full_now` (s) when given, else from the energy
 * (`energy_now` / `energy_full` µWh, or `charge_*` µAh × voltage) and the draw.
 */
export function parseLinuxBatteries(supplies: readonly LinuxSupply[]): BatteryReading | null {
  const num = (files: Readonly<Record<string, string>>, key: string): number | null => {
    const value = finite(files[key]);
    return value === null ? null : value;
  };
  const batteries = supplies.filter((supply) => supply.files['type']?.trim() === 'Battery' && supply.files['scope']?.trim().toLowerCase() !== 'device');
  if (batteries.length === 0) return null;
  const mainsOnline = supplies.some((supply) => supply.files['type']?.trim() === 'Mains' && supply.files['online']?.trim() === '1');
  let watts = 0;
  let energyNow = 0;
  let energyFull = 0;
  let energyKnown = true;
  let osEmpty: number | null = null;
  let osFull: number | null = null;
  const capacities: number[] = [];
  const statuses: string[] = [];
  for (const { files } of batteries) {
    statuses.push((files['status'] ?? '').trim().toLowerCase());
    const capacity = num(files, 'capacity');
    if (capacity !== null) capacities.push(capacity);
    const voltage = num(files, 'voltage_now');
    const power = num(files, 'power_now');
    const current = num(files, 'current_now');
    if (power !== null && power !== 0) watts += Math.abs(power) / 1e6;
    else if (current !== null && voltage !== null) watts += Math.abs(current * voltage) / 1e12;
    let now = num(files, 'energy_now');
    let full = num(files, 'energy_full');
    if ((now === null || full === null) && voltage !== null) {
      const chargeNow = num(files, 'charge_now');
      const chargeFull = num(files, 'charge_full');
      if (chargeNow !== null && chargeFull !== null) {
        now = (chargeNow * voltage) / 1e6;
        full = (chargeFull * voltage) / 1e6;
      }
    }
    if (now !== null && full !== null && full > 0) {
      energyNow += now;
      energyFull += full;
    } else energyKnown = false;
    const empty = num(files, 'time_to_empty_now');
    const toFull = num(files, 'time_to_full_now');
    if (empty !== null && empty > 0) osEmpty = (osEmpty ?? 0) + empty;
    if (toFull !== null && toFull > 0) osFull = Math.max(osFull ?? 0, toFull);
  }
  let percent: number | null = null;
  if (energyKnown && energyFull > 0) percent = (energyNow / energyFull) * 100;
  else if (capacities.length > 0) percent = capacities.reduce((a, b) => a + b, 0) / capacities.length;
  if (percent === null) return null;
  const charging = statuses.includes('charging');
  const discharging = !charging && statuses.includes('discharging') && !mainsOnline;
  const pluggedIn = !discharging;
  let minutesLeft: number | undefined;
  let minutesToFull: number | undefined;
  if (discharging) {
    if (osEmpty !== null) minutesLeft = Math.round(osEmpty / 60);
    else if (energyKnown && watts > 0) minutesLeft = Math.round((energyNow / 1e6 / watts) * 60);
  }
  if (charging) {
    if (osFull !== null) minutesToFull = Math.round(osFull / 60);
    else if (energyKnown && watts > 0 && energyFull > energyNow) minutesToFull = Math.round(((energyFull - energyNow) / 1e6 / watts) * 60);
  }
  return {
    percent: clampPercent(percent),
    charging,
    pluggedIn,
    ...(minutesLeft !== undefined ? { minutesLeft } : {}),
    ...(minutesToFull !== undefined ? { minutesToFull } : {}),
    // Charging, the battery's rate is the charge going in, not the system's draw.
    ...(discharging && watts > 0 ? { watts: round1(watts) } : {}),
  };
}

// ── GPUs and the estimate ───────────────────────────────────────────────

/**
 * `nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits` → the draw
 * summed over the GPUs that report one (`[N/A]` lines are skipped); `null` when
 * none does.
 */
export function parseNvidiaSmi(text: string): { readonly watts: number; readonly count: number } | null {
  let watts = 0;
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const value = finite(line.trim());
    if (value === null || value < 0) continue;
    watts += value;
    count += 1;
  }
  return count > 0 ? { watts, count } : null;
}

/**
 * D125: this machine's default estimate (W). Apple silicon draws far less than a
 * desktop x86 CPU: idle 4, max 5 + 2.5 per core, the rest 15. Otherwise by
 * logical core count: ≤ 4 cores 5 / 35, ≤ 8 cores 8 / 65, ≤ 16 cores 12 / 125,
 * more 20 / 200; the rest of the system 40.
 */
export function defaultPowerEstimate(cores: number, platform: string, arch: string): PowerEstimateModel {
  const n = Math.max(1, Math.round(cores));
  if (platform === 'darwin' && arch === 'arm64') return { cpuIdleW: 4, cpuMaxW: Math.round(5 + 2.5 * n), baseW: 15 };
  if (n <= 4) return { cpuIdleW: 5, cpuMaxW: 35, baseW: 40 };
  if (n <= 8) return { cpuIdleW: 8, cpuMaxW: 65, baseW: 40 };
  if (n <= 16) return { cpuIdleW: 12, cpuMaxW: 125, baseW: 40 };
  return { cpuIdleW: 20, cpuMaxW: 200, baseW: 40 };
}

/** A stored `power.estimate` value as settings (anything unusable reads as unset). */
export function readPowerEstimateSettings(value: unknown): PowerEstimateSettings {
  if (typeof value !== 'object' || value === null) return POWER_ESTIMATE_UNSET;
  const record = value as Record<string, unknown>;
  const watt = (key: string): number | null => {
    const n = record[key];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= POWER_ESTIMATE_MAX_W ? n : null;
  };
  return { cpuIdleW: watt('cpuIdleW'), cpuMaxW: watt('cpuMaxW'), baseW: watt('baseW') };
}

/** Validates a `power.estimate` patch: each of the three a number 0–{@link POWER_ESTIMATE_MAX_W} or `null`, idle ≤ max when both are set. */
export function parsePowerEstimateSettings(value: unknown): { readonly ok: true; readonly settings: PowerEstimateSettings } | { readonly ok: false; readonly message: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, message: 'power.estimate must be an object { cpuIdleW, cpuMaxW, baseW }' };
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'cpuIdleW' && key !== 'cpuMaxW' && key !== 'baseW') return { ok: false, message: `power.estimate has an unknown field ${key}` };
  }
  const out: Record<string, number | null> = {};
  for (const key of ['cpuIdleW', 'cpuMaxW', 'baseW'] as const) {
    const n = record[key] ?? null;
    if (n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > POWER_ESTIMATE_MAX_W)) {
      return { ok: false, message: `power.estimate.${key} must be a number of watts 0–${POWER_ESTIMATE_MAX_W}, or null for the default` };
    }
    out[key] = n as number | null;
  }
  if (out['cpuIdleW'] !== null && out['cpuMaxW'] !== null && out['cpuIdleW']! > out['cpuMaxW']!) {
    return { ok: false, message: 'power.estimate.cpuIdleW must not be above cpuMaxW' };
  }
  return { ok: true, settings: out as unknown as PowerEstimateSettings };
}

/** The settings over the defaults (a set idle above the default max raises the max with it). */
export function effectivePowerEstimate(settings: PowerEstimateSettings, defaults: PowerEstimateModel): PowerEstimateModel {
  const cpuIdleW = settings.cpuIdleW ?? defaults.cpuIdleW;
  const cpuMaxW = Math.max(cpuIdleW, settings.cpuMaxW ?? defaults.cpuMaxW);
  return { cpuIdleW, cpuMaxW, baseW: settings.baseW ?? defaults.baseW };
}

/** D125: the CPU estimate, `idle + util × (max − idle)` (`util` 0–1, clamped). */
export function estimateCpuWatts(util: number, model: PowerEstimateModel): number {
  const u = Math.max(0, Math.min(1, Number.isFinite(util) ? util : 0));
  return model.cpuIdleW + u * (model.cpuMaxW - model.cpuIdleW);
}

/** What an estimated total is made from. */
export interface EstimateInput {
  /** CPU utilisation 0–1 since the last sample. */
  readonly cpuUtil: number;
  /** A real CPU package reading (W), Linux RAPL; `null` = estimate it. */
  readonly cpuMeasuredW: number | null;
  /** Measured GPU draw; `null` when no GPU reading exists. */
  readonly gpu: { readonly watts: number; readonly count: number } | null;
  readonly model: PowerEstimateModel;
  readonly at: string;
}

/** D125: a machine without a battery: GPU (measured) + CPU (estimated or measured) + the baseline, whole watts, always `estimated`. */
export function estimatedPower(input: EstimateInput): PowerStatus {
  const cpu = Math.round(input.cpuMeasuredW ?? estimateCpuWatts(input.cpuUtil, input.model));
  const gpu = input.gpu ? Math.round(input.gpu.watts) : null;
  const base = Math.round(input.model.baseW);
  const parts: PowerParts = {
    ...(gpu !== null ? { gpu, gpuCount: input.gpu!.count } : {}),
    cpu,
    cpuPct: Math.round(Math.max(0, Math.min(1, input.cpuUtil)) * 100),
    ...(input.cpuMeasuredW !== null ? { cpuMeasured: true as const } : {}),
    base,
  };
  return { kind: 'estimated', watts: (gpu ?? 0) + cpu + base, parts, at: input.at };
}

/** A battery reading as the wire's {@link PowerStatus}. */
export function batteryPower(reading: BatteryReading, at: string): PowerStatus {
  return { kind: 'battery', ...reading, at };
}

/** `true` when two readings say the same (their times aside): no new event is needed. */
export function samePower(a: PowerStatus | null, b: PowerStatus | null): boolean {
  if (a === null || b === null) return a === b;
  const { at: _a, ...restA } = a;
  const { at: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

/** A received `PowerStatus` (a paired machine's), checked; `null` when it is not one. */
export function readPowerStatus(value: unknown): PowerStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (kind !== 'battery' && kind !== 'estimated' && kind !== 'none') return null;
  if (typeof record['at'] !== 'string') return null;
  const num = (key: string): number | undefined => (typeof record[key] === 'number' && Number.isFinite(record[key]) ? (record[key] as number) : undefined);
  const bool = (key: string): boolean | undefined => (typeof record[key] === 'boolean' ? (record[key] as boolean) : undefined);
  const out: Record<string, unknown> = { kind, at: record['at'] };
  for (const key of ['percent', 'minutesLeft', 'minutesToFull', 'watts', 'adapterWatts']) {
    const n = num(key);
    if (n !== undefined) out[key] = n;
  }
  for (const key of ['charging', 'pluggedIn']) {
    const b = bool(key);
    if (b !== undefined) out[key] = b;
  }
  const parts = record['parts'];
  if (typeof parts === 'object' && parts !== null) {
    const p = parts as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const key of ['gpu', 'gpuCount', 'cpu', 'cpuPct', 'base']) {
      if (typeof p[key] === 'number' && Number.isFinite(p[key])) kept[key] = p[key];
    }
    if (p['cpuMeasured'] === true) kept['cpuMeasured'] = true;
    out['parts'] = kept;
  }
  return out as unknown as PowerStatus;
}

// ── UI text ─────────────────────────────────────────────────────────────

/** `2h10`, `35m`. */
export function formatPowerMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const hours = Math.floor(m / 60);
  return hours > 0 ? `${hours}h${String(m % 60).padStart(2, '0')}` : `${m}m`;
}

function spokenMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  const h = hours === 1 ? '1 hour' : `${hours} hours`;
  const r = rest === 1 ? '1 minute' : `${rest} minutes`;
  if (hours === 0) return r;
  return rest === 0 ? h : `${h} ${r}`;
}

/** What a power reading looks like in the UI (`null`: show nothing). */
export interface PowerView {
  /** `discharging` 🔋, `charging` ⚡, `plugged` 🔌 (on AC, not charging), `estimated` (no icon). */
  readonly state: 'discharging' | 'charging' | 'plugged' | 'estimated';
  /** The glyph before the text (decorative; `aria-hidden`), `null` for an estimate. */
  readonly icon: string | null;
  /** The footer's text: `64% · 2h10`, `81% · 35m to full`, `100% · on AC`, `~210 W`. */
  readonly text: string;
  /** The same, shorter (phones): `81% · 35m`, `~210 W`. */
  readonly short: string;
  /** The machine tags' indicator: `🔋64%`, `⚡81%`, `🔌100%`, `~210 W`. */
  readonly badge: string;
  /** Settings → Machines: the text with the draw / the estimate's label (`64% · 2h10 · 9.5 W`, `~210 W (estimated)`). */
  readonly line: string;
  /** The tooltip, one fact per line. */
  readonly title: string;
  /** For screen readers: `Battery 64%, discharging, 2 hours 10 minutes left`. */
  readonly label: string;
}

/** D125: the UI's view of a reading; `null` for none (or a phone, which reports nothing). */
export function powerView(power: PowerStatus | null | undefined): PowerView | null {
  if (!power || power.kind === 'none') return null;
  if (power.kind === 'estimated') {
    if (power.watts === undefined) return null;
    const parts = power.parts ?? {};
    const lines = [`~${power.watts} W (estimated, not measured)`];
    if (parts.gpu !== undefined) lines.push(`GPU: ${parts.gpu} W (measured${parts.gpuCount && parts.gpuCount > 1 ? `, ${parts.gpuCount} GPUs` : ''})`);
    else lines.push('GPU: no reading (counted in the rest)');
    if (parts.cpu !== undefined) lines.push(parts.cpuMeasured ? `CPU: ${parts.cpu} W (measured package power)` : `CPU: ${parts.cpu} W (estimated from ${parts.cpuPct ?? 0}% CPU)`);
    if (parts.base !== undefined) lines.push(`Rest of the system: ${parts.base} W (fixed)`);
    lines.push('Settings → Machines → Power estimate');
    return {
      state: 'estimated',
      icon: null,
      text: `~${power.watts} W`,
      short: `~${power.watts} W`,
      badge: `~${power.watts} W`,
      line: `~${power.watts} W (estimated)`,
      title: lines.join('\n'),
      label: `Estimated power draw about ${power.watts} watts`,
    };
  }
  if (power.percent === undefined) return null;
  const pct = `${power.percent}%`;
  const draw = power.watts !== undefined ? `Draw: ${power.watts} W` : null;
  const adapter = power.adapterWatts !== undefined ? `Adapter: ${power.adapterWatts} W` : null;
  const withDraw = (text: string): string => (power.watts !== undefined ? `${text} · ${power.watts} W` : text);
  if (power.charging) {
    const time = power.minutesToFull !== undefined ? formatPowerMinutes(power.minutesToFull) : null;
    const lines = [`Battery ${pct} · charging`, time ? `${time} to full` : 'Time to full: not known yet', draw, adapter].filter((line): line is string => line !== null);
    return {
      state: 'charging',
      icon: '⚡',
      text: time ? `${pct} · ${time} to full` : pct,
      short: time ? `${pct} · ${time}` : pct,
      badge: `⚡${pct}`,
      line: withDraw(time ? `${pct} · charging, ${time} to full` : `${pct} · charging`),
      title: lines.join('\n'),
      label: `Battery ${pct}, charging${power.minutesToFull !== undefined ? `, ${spokenMinutes(power.minutesToFull)} to full` : ''}`,
    };
  }
  if (power.pluggedIn) {
    const lines = [`Battery ${pct} · on AC, not charging`, draw, adapter].filter((line): line is string => line !== null);
    return {
      state: 'plugged',
      icon: '🔌',
      text: `${pct} · on AC`,
      short: pct,
      badge: `🔌${pct}`,
      line: withDraw(`${pct} · on AC`),
      title: lines.join('\n'),
      label: `Battery ${pct}, on AC power, not charging`,
    };
  }
  const time = power.minutesLeft !== undefined ? formatPowerMinutes(power.minutesLeft) : null;
  const lines = [`Battery ${pct} · discharging`, time ? `${time} left (the OS's estimate)` : 'Time left: not known yet', draw].filter((line): line is string => line !== null);
  return {
    state: 'discharging',
    icon: '🔋',
    text: time ? `${pct} · ${time}` : pct,
    short: time ? `${pct} · ${time}` : pct,
    badge: `🔋${pct}`,
    line: withDraw(time ? `${pct} · ${time} left` : pct),
    title: lines.join('\n'),
    label: `Battery ${pct}, discharging${power.minutesLeft !== undefined ? `, ${spokenMinutes(power.minutesLeft)} left` : ''}`,
  };
}
