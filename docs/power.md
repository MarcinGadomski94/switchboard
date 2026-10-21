# Machine power (D125)

Developer request D125 (`docs/decisions.md` → *Machine power*). Every machine that hosts Switchboard reports its own power: a **laptop** its battery, a machine **without a battery** an **estimated** total draw. It shows in the sidebar footer under RAM, in Settings → Machines, and on a paired machine (its tags and its Settings row). Phones are not hosts: a paired device reports nothing and shows nothing.

Code: the pure part `src/core/power.ts` (the parsers, the estimate, the UI text), the sampler `src/server/system/power.ts`, the footer row `PowerRow` (`src/web/shell/Sidebar.tsx`), `PowerLine` / `PowerBadge` (`src/web/components/Power.tsx`), `PowerEstimateRow` (`src/web/views/settings/PowerEstimateRow.tsx`).

## The reading

`SystemInfo.power` (`GET /api/system`, the `system` hub event) and `Machine.power` (`GET /api/machines`, `machineState`), both additive and optional:

```ts
{ kind: 'battery' | 'estimated' | 'none', percent?, charging?, pluggedIn?, minutesLeft?, minutesToFull?, watts?, adapterWatts?, parts?: { gpu?, gpuCount?, cpu?, cpuPct?, cpuMeasured?, base? }, at }
```

- **battery:** `percent`; `charging`; `pluggedIn` (on AC: charging, full or held); `minutesLeft` while discharging is **the OS's own estimate**; `minutesToFull` while charging (the OS's, else from the charge rate); `watts` the system's draw **when the OS tells it** (1 decimal); `adapterWatts` on a Mac on AC.
- **estimated:** `watts` = GPU + CPU + base (whole watts), with the `parts`. Always labelled *estimated* in the UI ("~210 W", "~210 W (estimated)"), never as measured.
- **none:** nothing could be read; the UI shows nothing. Omitted entirely before the first sample.

## Sources per OS (read-only, no admin or sudo, ever)

| OS | Battery | Draw |
|---|---|---|
| macOS | `/usr/bin/pmset -g batt` (percent, `discharging` / `charging` / `charged` / `AC attached`, the OS's `h:mm remaining`) | `/usr/sbin/ioreg -rn AppleSmartBattery`: discharging = \|`InstantAmperage` (else `Amperage`)\| × `Voltage` (mA × mV; ioreg prints negative currents as unsigned 64-bit, read back as signed); on AC the system's draw from `PowerTelemetryData.SystemPowerIn` when the Mac reports it, and the adapter's `AdapterDetails.Watts` |
| Windows | One `powershell.exe -NoProfile -NonInteractive -Command` call per sample: `Win32_Battery` (`EstimatedChargeRemaining`, `EstimatedRunTime` — `71582788` = unknown / on AC — and `BatteryStatus`), `root/wmi` `BatteryStatus` (`ChargeRate` / `DischargeRate` in mW, `RemainingCapacity` mWh, `PowerOnline`, `Charging`) and `BatteryFullChargedCapacity`, as one JSON object | `DischargeRate` while discharging; the time `EstimatedRunTime`, else remaining ÷ rate; to full = (full − remaining) ÷ `ChargeRate` |
| Linux | `/sys/class/power_supply/*` with `type` Battery (not a device's `scope`, e.g. a mouse): `capacity`, `status`; several batteries are combined; a `Mains` supply's `online` | `power_now` (µW), else `current_now` × `voltage_now`; the time from the kernel's `time_to_empty_now` / `time_to_full_now`, else from `energy_now` / `energy_full` (or `charge_*` × voltage) and the draw |

`powermetrics` (macOS) and the Windows / Linux sensors that need admin are never used.

## No battery: the estimate

`watts = GPU + CPU + base`, each whole watts:

- **GPU (measured where possible):** `nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits`, summed over the GPUs that report a number (not on macOS); on Linux also each `amdgpu` hwmon's `power1_average` (else `power1_input`, µW) under `/sys/class/drm/card*/device/hwmon/*`. No reading → the GPU is left out (it is then part of the baseline in effect) and the tooltip says so.
- **CPU:** `idle + util × (max − idle)`, `util` = machine-wide CPU use since the last sample (`os.cpus()` times). On Linux a readable RAPL package counter (`/sys/class/powercap/intel-rapl:N/energy_uj`, root-only on most current kernels) replaces the estimate from its second sample on (watts = energy change ÷ time, wrapping at `max_energy_range_uj`); macOS and Windows have none without admin.
- **base:** the rest of the system (board, RAM, drives, fans, PSU losses), fixed.

**Defaults** (`defaultPowerEstimate`, by logical cores): ≤ 4 cores idle 5 W / max 35 W, ≤ 8 cores 8 / 65, ≤ 16 cores 12 / 125, more 20 / 200, base 40 W. Apple silicon (a Mac mini / Studio): idle 4 W, max 5 + 2.5 W per core, base 15 W. **Settings → Machines → Power estimate** overrides each of the three for this machine (the `power.estimate` setting, `{ cpuIdleW, cpuMaxW, baseW }`, each `null` = the default; 0–2000 W, idle ≤ max; `power.estimateDefaults` reports the defaults read-only). Stored with the other settings: no migration. The next sample uses it.

## Sampling

- **On demand, at most every 30 s** (`POWER_SAMPLE_MS`; `SWITCHBOARD_POWER_SAMPLE_MS` shortens it for tests): `PowerSampler.current()` answers the last reading and starts a new sample in the background when the last one is due. It is asked by `GET /api/system` and the `/hub` `system` tick (only while a page is open) and by each paired machine's event stream at its 10 s keepalive. Nobody asking = nothing runs.
- **Never overlapping:** callers share a running sample.
- **Time limits:** 5 s per command (`pmset`, `ioreg`, `nvidia-smi`), 15 s for the PowerShell call. A failed or timed-out battery read fails that sample only (the last reading stays).
- **Missing sources are cached for an hour** (`POWER_UNAVAILABLE_RETRY_MS`): no battery (so a Windows desktop does not start PowerShell every 30 s), no `nvidia-smi`, no amdgpu, an unreadable RAPL counter. Checked again after the hour.
- Nothing is stored; only the last reading is kept in memory.
- **Cost on a MacBook (Apple silicon), measured 2026-10-21:** one sample (`pmset` + `ioreg`) takes ~25 ms wall time and ~20 ms CPU (the two processes and Node's parsing), so under 0.1 % of one core at one sample per 30 s. On a Mac desktop `pmset` runs once an hour and a sample is otherwise only arithmetic. **Windows was not measured** (no Windows machine was available when this was built): the PowerShell start dominates (typically a few hundred ms of CPU), and it runs per sample **only on a laptop**; a desktop asks once an hour and otherwise runs only `nvidia-smi` (when present).

## Paired machines

Each machine sends its own reading over its peer event stream as the `/hub` event **`machinePower`** (on `PEER_HUB_EVENTS`): the last reading when the stream opens, then each new one (a sample that says something new; at most every 30 s). The receiving machine keeps it per machine and publishes it as `Machine.power` with `machineState`; it never republishes `machinePower` itself. `Machine.power` is shown only while that machine is online (or reconnecting): a stale reading of an unreachable machine is not. An older Switchboard sends none, so it shows nothing. A paired phone (D73) reads its host's power through the host's own routes like any machine status; it reports nothing.

## Where it shows

- **Sidebar footer**, a `PWR` line under RAM: `🔋 64% · 2h10` (discharging), `⚡ 81% · 35m to full` (charging; `81% · 35m` on phones), `🔌 100% · on AC`, `~210 W` (estimated). The tooltip has the details (the draw, the adapter, an estimate's parts); screen readers get one sentence ("Battery 64%, discharging, 2 hours 10 minutes left", "Estimated power draw about 210 watts"); the glyphs are decorative.
- **Settings → Machines:** this machine's line (`64% · 2h10 left · 9.5 W`, `~210 W (estimated)`) under its id, the *Power estimate* row, and each online paired machine's line.
- **Machine tags** (a paired machine's sessions and items): a small `🔋64%` / `⚡81%` / `~210 W` after the name while it is online.

## Limits

- A desktop's wattage is an **estimate**: a fixed baseline and a linear CPU model; the GPU is measured only where `nvidia-smi` or amdgpu hwmon is there. It is never presented as measured.
- No admin or sudo is ever used, so macOS's `powermetrics`, Windows' energy counters and root-only Linux sensors are out of reach.
- The battery time is the OS's own estimate, as noisy as the OS's (macOS shows none for a while after unplugging).

## Tests

`tests/core/power.test.ts` (the parsers with fixture outputs: pmset / ioreg discharging, charging, full on AC, held on AC, no battery; Windows JSON incl. `71582788` and a single object; Linux `power_now` vs current × voltage, `charge_*`, a device battery; `nvidia-smi` one / two / none; the defaults, the formula, the settings, the UI text), `tests/server/system/power.test.ts` (a mocked command runner: macOS, a Windows desktop with two GPUs, no overlap, the cache of a missing source, a failed read, Linux RAPL and amdgpu; `GET /api/system` carrying `power`), two processes `tests/server/peers/power.test.ts` (each machine's power on the other, a change live as `machineState`), E2E `tests/e2e/power.spec.ts` (the footer's battery and desktop variants at desktop and phone width; Settings → Machines). Test servers report no power by default (`tests/fixtures/power-none.json` as `SWITCHBOARD_POWER_TEST_FILE`, tests only), so no spec reads the machine's real battery.
