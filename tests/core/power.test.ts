import { describe, expect, it } from 'vitest';
import {
  type LinuxSupply,
  WIN_RUNTIME_UNKNOWN,
  defaultPowerEstimate,
  effectivePowerEstimate,
  estimateCpuWatts,
  estimatedPower,
  formatPowerMinutes,
  macBattery,
  parseIoregBattery,
  parseLinuxBatteries,
  parseNvidiaSmi,
  parsePmsetBatt,
  parsePowerEstimateSettings,
  parseWindowsBattery,
  powerView,
  readPowerEstimateSettings,
  readPowerStatus,
  samePower,
} from '../../src/core/power.ts';

/**
 * D125 (`docs/power.md`): the pure power core. Fixture outputs are shaped like
 * each OS's real command output (ids and serials replaced with placeholders).
 */

const AT = '2026-10-21T10:00:00.000Z';

const PMSET_DISCHARGING = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234567)\t64%; discharging; 2:10 remaining present: true\n";
const PMSET_CHARGING = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234567)\t81%; charging; 0:35 remaining present: true\n";
const PMSET_FULL = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234567)\t100%; charged; 0:00 remaining present: true\n";
const PMSET_HELD = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234567)\t80%; AC attached; not charging present: true\n";
const PMSET_NO_ESTIMATE = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234567)\t97%; discharging; (no estimate) present: true\n";
const PMSET_DESKTOP = "Now drawing from 'AC Power'\n";

/** `ioreg -rn AppleSmartBattery` (the lines D125 reads, in its tree form). */
function ioreg(fields: Record<string, string>): string {
  const lines = ['+-o AppleSmartBattery  <class AppleSmartBattery, id 0x100000abc, registered, matched, active, busy 0 (0 ms), retain 7>', '    {'];
  for (const [key, value] of Object.entries(fields)) lines.push(`      "${key}" = ${value}`);
  lines.push('      "BatteryData" = {"CurrentCapacity"=1,"Voltage"=1}', '    }');
  return lines.join('\n');
}

/** −298 mA, as ioreg prints it (unsigned 64-bit). */
const MINUS_298 = (2n ** 64n - 298n).toString();

describe('D125 · macOS pmset + ioreg', () => {
  it('pmset: discharging with the OS estimate, charging, full on AC, held on AC, no estimate, no battery', () => {
    expect(parsePmsetBatt(PMSET_DISCHARGING)).toEqual({ source: 'battery', battery: { percent: 64, state: 'discharging', minutes: 130 } });
    expect(parsePmsetBatt(PMSET_CHARGING)).toEqual({ source: 'ac', battery: { percent: 81, state: 'charging', minutes: 35 } });
    expect(parsePmsetBatt(PMSET_FULL)).toEqual({ source: 'ac', battery: { percent: 100, state: 'charged', minutes: null } });
    expect(parsePmsetBatt(PMSET_HELD).battery).toEqual({ percent: 80, state: 'ac attached', minutes: null });
    expect(parsePmsetBatt(PMSET_NO_ESTIMATE).battery?.minutes).toBeNull();
    expect(parsePmsetBatt(PMSET_DESKTOP)).toEqual({ source: 'ac', battery: null });
  });

  it('ioreg: signed amperage × voltage, flags, the adapter and SystemPowerIn; no battery → null', () => {
    const discharging = parseIoregBattery(ioreg({ Amperage: MINUS_298, InstantAmperage: MINUS_298, Voltage: '12493', IsCharging: 'No', ExternalConnected: 'No', AdapterDetails: '{"FamilyCode"=0}' }));
    expect(discharging).toEqual({ amperageMa: -298, voltageMv: 12493, charging: false, externalConnected: false, adapterWatts: null, systemPowerInMw: null });
    const onAc = parseIoregBattery(ioreg({ Amperage: '1500', Voltage: '12900', IsCharging: 'Yes', ExternalConnected: 'Yes', AdapterDetails: '{"Watts"=96,"FamilyCode"=1}', PowerTelemetryData: '{"SystemLoad"=9000,"SystemPowerIn"=18250}' }));
    expect(onAc).toMatchObject({ amperageMa: 1500, charging: true, externalConnected: true, adapterWatts: 96, systemPowerInMw: 18250 });
    expect(parseIoregBattery('')).toBeNull();
  });

  it('a battery: discharging draws |A| × V; on AC the system draw (SystemPowerIn) and the adapter; no battery → null', () => {
    const io = parseIoregBattery(ioreg({ Amperage: MINUS_298, Voltage: '12493' }));
    expect(macBattery(parsePmsetBatt(PMSET_DISCHARGING), io)).toEqual({ percent: 64, charging: false, pluggedIn: false, minutesLeft: 130, watts: 3.7 });
    const ac = parseIoregBattery(ioreg({ Amperage: '1500', Voltage: '12900', IsCharging: 'Yes', AdapterDetails: '{"Watts"=96}', PowerTelemetryData: '{"SystemPowerIn"=18250}' }));
    expect(macBattery(parsePmsetBatt(PMSET_CHARGING), ac)).toEqual({ percent: 81, charging: true, pluggedIn: true, minutesToFull: 35, watts: 18.3, adapterWatts: 96 });
    expect(macBattery(parsePmsetBatt(PMSET_FULL), null)).toEqual({ percent: 100, charging: false, pluggedIn: true });
    expect(macBattery(parsePmsetBatt(PMSET_DESKTOP), null)).toBeNull();
  });
});

describe('D125 · Windows Win32_Battery + root/wmi BatteryStatus', () => {
  const json = (value: unknown): string => JSON.stringify(value);

  it('discharging: the OS run time and DischargeRate in W', () => {
    const answer = json({
      battery: [{ EstimatedChargeRemaining: 64, EstimatedRunTime: 130, BatteryStatus: 1 }],
      status: [{ ChargeRate: 0, DischargeRate: 12_400, RemainingCapacity: 32_000, PowerOnline: false, Charging: false, Discharging: true }],
      full: [{ FullChargedCapacity: 50_000 }],
    });
    expect(parseWindowsBattery(answer)).toEqual({ percent: 64, charging: false, pluggedIn: false, minutesLeft: 130, watts: 12.4 });
  });

  it('71582788 = unknown: the time from remaining ÷ rate; a single object (not an array) reads the same', () => {
    const answer = json({
      battery: { EstimatedChargeRemaining: 50, EstimatedRunTime: WIN_RUNTIME_UNKNOWN, BatteryStatus: 1 },
      status: { ChargeRate: 0, DischargeRate: 10_000, RemainingCapacity: 25_000, PowerOnline: false, Charging: false, Discharging: true },
      full: { FullChargedCapacity: 50_000 },
    });
    expect(parseWindowsBattery(answer)).toEqual({ percent: 50, charging: false, pluggedIn: false, minutesLeft: 150, watts: 10 });
  });

  it('charging: time to full from ChargeRate (71582788 on AC is ignored); no draw', () => {
    const answer = json({
      battery: [{ EstimatedChargeRemaining: 80, EstimatedRunTime: WIN_RUNTIME_UNKNOWN, BatteryStatus: 6 }],
      status: [{ ChargeRate: 20_000, DischargeRate: 0, RemainingCapacity: 40_000, PowerOnline: true, Charging: true, Discharging: false }],
      full: [{ FullChargedCapacity: 50_000 }],
    });
    expect(parseWindowsBattery(answer)).toEqual({ percent: 80, charging: true, pluggedIn: true, minutesToFull: 30 });
  });

  it('a desktop (no Win32_Battery) and an unreadable answer → null', () => {
    expect(parseWindowsBattery(json({ battery: [], status: [], full: [] }))).toBeNull();
    expect(parseWindowsBattery('')).toBeNull();
    expect(parseWindowsBattery('not json')).toBeNull();
  });
});

describe('D125 · Linux /sys/class/power_supply', () => {
  const bat = (files: Record<string, string>, name = 'BAT0'): LinuxSupply => ({ name, files: { type: 'Battery', ...files } });

  it('power_now: the draw, the time from energy_now', () => {
    const reading = parseLinuxBatteries([
      bat({ status: 'Discharging', capacity: '64', power_now: '12000000', energy_now: '30000000', energy_full: '50000000' }),
      { name: 'AC', files: { type: 'Mains', online: '0' } },
    ]);
    expect(reading).toEqual({ percent: 60, charging: false, pluggedIn: false, minutesLeft: 150, watts: 12 });
  });

  it('current_now × voltage_now when there is no power_now; charge_* × voltage for the energy', () => {
    const reading = parseLinuxBatteries([bat({ status: 'Discharging', capacity: '50', current_now: '1000000', voltage_now: '11000000', charge_now: '2000000', charge_full: '4000000' })]);
    expect(reading).toEqual({ percent: 50, charging: false, pluggedIn: false, minutesLeft: 120, watts: 11 });
  });

  it('charging: time to full; the kernel time when given; a device battery (a mouse) is not the system\'s', () => {
    expect(parseLinuxBatteries([bat({ status: 'Charging', capacity: '80', power_now: '20000000', energy_now: '40000000', energy_full: '50000000' })])).toEqual({
      percent: 80,
      charging: true,
      pluggedIn: true,
      minutesToFull: 30,
    });
    expect(parseLinuxBatteries([bat({ status: 'Discharging', capacity: '70', power_now: '10000000', time_to_empty_now: '5400' })])?.minutesLeft).toBe(90);
    expect(parseLinuxBatteries([bat({ status: 'Discharging', capacity: '40', scope: 'Device' }, 'hidpp_battery_0')])).toBeNull();
    expect(parseLinuxBatteries([])).toBeNull();
  });
});

describe('D125 · nvidia-smi and the estimate', () => {
  it('nvidia-smi: one GPU, two GPUs (summed), [N/A] / nothing → null', () => {
    expect(parseNvidiaSmi('118.42\n')).toEqual({ watts: 118.42, count: 1 });
    expect(parseNvidiaSmi('120.50\r\n45.25\r\n')).toEqual({ watts: 165.75, count: 2 });
    expect(parseNvidiaSmi('[N/A]\n')).toBeNull();
    expect(parseNvidiaSmi('')).toBeNull();
  });

  it('defaults by core count (Apple silicon lower); the formula idle + util × (max − idle)', () => {
    expect(defaultPowerEstimate(4, 'win32', 'x64')).toEqual({ cpuIdleW: 5, cpuMaxW: 35, baseW: 40 });
    expect(defaultPowerEstimate(8, 'linux', 'x64')).toEqual({ cpuIdleW: 8, cpuMaxW: 65, baseW: 40 });
    expect(defaultPowerEstimate(16, 'win32', 'x64')).toEqual({ cpuIdleW: 12, cpuMaxW: 125, baseW: 40 });
    expect(defaultPowerEstimate(32, 'win32', 'x64')).toEqual({ cpuIdleW: 20, cpuMaxW: 200, baseW: 40 });
    expect(defaultPowerEstimate(10, 'darwin', 'arm64')).toEqual({ cpuIdleW: 4, cpuMaxW: 30, baseW: 15 });
    const model = { cpuIdleW: 10, cpuMaxW: 110, baseW: 40 };
    expect(estimateCpuWatts(0, model)).toBe(10);
    expect(estimateCpuWatts(0.5, model)).toBe(60);
    expect(estimateCpuWatts(2, model)).toBe(110);
  });

  it('an estimated total: GPU + CPU + base, whole watts, always labelled estimated; RAPL replaces the CPU estimate', () => {
    const model = { cpuIdleW: 12, cpuMaxW: 125, baseW: 40 };
    expect(estimatedPower({ cpuUtil: 0.35, cpuMeasuredW: null, gpu: { watts: 130.4, count: 1 }, model, at: AT })).toEqual({
      kind: 'estimated',
      watts: 222,
      parts: { gpu: 130, gpuCount: 1, cpu: 52, cpuPct: 35, base: 40 },
      at: AT,
    });
    expect(estimatedPower({ cpuUtil: 0.35, cpuMeasuredW: 33.6, gpu: null, model, at: AT })).toEqual({
      kind: 'estimated',
      watts: 74,
      parts: { cpu: 34, cpuPct: 35, cpuMeasured: true, base: 40 },
      at: AT,
    });
  });

  it('the settings: null = default, validation, a set idle above the default max raises the max', () => {
    const defaults = { cpuIdleW: 8, cpuMaxW: 65, baseW: 40 };
    expect(effectivePowerEstimate({ cpuIdleW: null, cpuMaxW: null, baseW: 25 }, defaults)).toEqual({ cpuIdleW: 8, cpuMaxW: 65, baseW: 25 });
    expect(effectivePowerEstimate({ cpuIdleW: 90, cpuMaxW: null, baseW: null }, defaults)).toEqual({ cpuIdleW: 90, cpuMaxW: 90, baseW: 40 });
    expect(parsePowerEstimateSettings({ cpuIdleW: 10, cpuMaxW: 95, baseW: null })).toEqual({ ok: true, settings: { cpuIdleW: 10, cpuMaxW: 95, baseW: null } });
    expect(parsePowerEstimateSettings({ baseW: 30 })).toEqual({ ok: true, settings: { cpuIdleW: null, cpuMaxW: null, baseW: 30 } });
    expect(parsePowerEstimateSettings({ cpuIdleW: 100, cpuMaxW: 50 }).ok).toBe(false);
    expect(parsePowerEstimateSettings({ baseW: -1 }).ok).toBe(false);
    expect(parsePowerEstimateSettings({ watts: 3 }).ok).toBe(false);
    expect(parsePowerEstimateSettings([]).ok).toBe(false);
    expect(readPowerEstimateSettings({ cpuIdleW: 'x', baseW: 22 })).toEqual({ cpuIdleW: null, cpuMaxW: null, baseW: 22 });
    expect(readPowerEstimateSettings(undefined)).toEqual({ cpuIdleW: null, cpuMaxW: null, baseW: null });
  });
});

describe('D125 · the wire and the UI text', () => {
  it('readPowerStatus keeps the known fields only; samePower ignores the time', () => {
    expect(readPowerStatus({ kind: 'battery', percent: 64, charging: false, extra: 'x', at: AT })).toEqual({ kind: 'battery', percent: 64, charging: false, at: AT });
    expect(readPowerStatus({ kind: 'phone', at: AT })).toBeNull();
    expect(readPowerStatus(null)).toBeNull();
    expect(samePower({ kind: 'estimated', watts: 200, at: AT }, { kind: 'estimated', watts: 200, at: '2026-10-21T10:00:30.000Z' })).toBe(true);
    expect(samePower({ kind: 'estimated', watts: 200, at: AT }, { kind: 'estimated', watts: 201, at: AT })).toBe(false);
  });

  it('the footer texts: discharging, charging, on AC, estimated; none → nothing', () => {
    expect(formatPowerMinutes(130)).toBe('2h10');
    expect(formatPowerMinutes(35)).toBe('35m');
    expect(powerView({ kind: 'battery', percent: 64, charging: false, pluggedIn: false, minutesLeft: 130, watts: 9.5, at: AT })).toMatchObject({
      state: 'discharging',
      icon: '🔋',
      text: '64% · 2h10',
      badge: '🔋64%',
      line: '64% · 2h10 left · 9.5 W',
      label: 'Battery 64%, discharging, 2 hours 10 minutes left',
      title: "Battery 64% · discharging\n2h10 left (the OS's estimate)\nDraw: 9.5 W",
    });
    expect(powerView({ kind: 'battery', percent: 81, charging: true, pluggedIn: true, minutesToFull: 35, at: AT })).toMatchObject({ state: 'charging', icon: '⚡', text: '81% · 35m to full', short: '81% · 35m', badge: '⚡81%' });
    expect(powerView({ kind: 'battery', percent: 100, charging: false, pluggedIn: true, at: AT })).toMatchObject({ state: 'plugged', text: '100% · on AC' });
    const desktop = powerView({ kind: 'estimated', watts: 210, parts: { gpu: 120, gpuCount: 1, cpu: 50, cpuPct: 35, base: 40 }, at: AT });
    expect(desktop).toMatchObject({ state: 'estimated', icon: null, text: '~210 W', badge: '~210 W', line: '~210 W (estimated)', label: 'Estimated power draw about 210 watts' });
    expect(desktop?.title).toBe('~210 W (estimated, not measured)\nGPU: 120 W (measured)\nCPU: 50 W (estimated from 35% CPU)\nRest of the system: 40 W (fixed)\nSettings → Machines → Power estimate');
    expect(powerView({ kind: 'none', at: AT })).toBeNull();
    expect(powerView(undefined)).toBeNull();
  });
});
