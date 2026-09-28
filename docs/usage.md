# Max usage meter (M9.2, D17, D23)

The footer's usage rows and the usage warning. Sources and the verdict come from the M0.3 spike (`docs/spike-m0.md` → *Usage %*); the item is BACKLOG M9.2 (adapted after M0). **Never a guessed percentage:** anything missing, erroring or shaped differently is "unknown", and `usagePct` is left out.

**D17 (2026-09-28):** the single "Max" bar became one row per window: **Session** (the 5-hour window) and **Week** (the weekly limit, all models), plus a row per model-specific weekly limit (e.g. Fable) only while it is in use. `/api/system` keeps `usagePct` (the max rule below) and gains the additive `usageWindows` (*`usageWindows`* below). The 90 % warning applies to each window, model windows included.

**D23 (2026-09-28):** the Week bar shows whether usage is on pace for the week: green below the day's allowance, yellow at or above it, with a marker at the allowance (*Weekly pace* below). No API change: the browser computes it from `usageWindows`.

## Files
| File | Role |
|---|---|
| `src/core/usage.ts` | The rules, pure: parse a `get_usage` answer or a `rate_limit_event`, the state at a moment (max rule, unknown cases), the warnings due, the `/api/system` fields; D23: `weeklyPace`. |
| `src/server/usage/meter.ts` | `UsageMeter`: when to read, storing readings, firing warnings, pruning. |
| `src/server/usage/poller.ts` | `UsagePoller`: the short-lived `claude` process that reads usage while no session is live. |
| `src/server/usage/wire.ts` | `withUsage(providers, meter)` (adds the fields to `providers.system`) and `createUsageMeter` (normal runs). |
| `src/server/supervisor/supervisor.ts` | `idleLiveSessionIds()` and `controlRequest()`: a stdin control request to a live session between turns. |
| `src/server/supervisor/recorder.ts` | Stores every `rate_limit_event` as a reading (M2.1; now through `readingFromRateLimit`). |
| `src/web/toast/usage-warning.ts`, `useUsageWarnings.ts` | The warning toast. |
| `src/web/shell/format.ts` → `usageRows` | The footer rows (D17, replacing M1.4's single `maxMeter`): Session and Week from `usageWindows` (each "unknown" without its window), then one row per model window; D23: the Week row's `pace`. |
| `src/web/shell/Sidebar.tsx` → `MeterRow`, `shell.css` | One footer row; D23: `data-pace`, the tooltip, the allowance marker and the pace colors. |

## Readings
Each reading is one `usage_readings` row: 5-hour and weekly utilization (0–100) with their reset times (ISO), the source, the session it came from (or none), when Switchboard received it, and the CLI's payload verbatim (`raw`). Only the newest reading drives the meter.

| Source | How | When |
|---|---|---|
| `get_usage` on a live session | stdin `{"type":"control_request","request_id":"sb-usage-<uuid>","request":{"subtype":"get_usage","skip_behaviors":true}}` to a supervised process **between turns** (no turn running, no open request, not being stopped); its `control_response` is not a chat event | at most once per **60 s** (the CLI caches the answer for about a minute) |
| `rate_limit_event` | stored by the recorder for every one a turn emits (`unifiedWindows.*.utilization` × 100, `resetsAt` epoch seconds → ISO) | free, whenever a turn calls the API |
| the poller | `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio` (+ `SWITCHBOARD_CLAUDE_EXTRA_ARGS`, like every spawn) in the **app-data folder**, env scrubbed as in M2.1 → `get_usage` → EOF once answered. No user message: no model call, no transcript. Stopped (SIGTERM → SIGKILL) after 30 s | only while **no session is live**, at most once per **5 min**, and not while a reading younger than 5 min exists |

The meter checks every 15 s and makes requests (live `get_usage` or the poller) **only while a `/hub` client is connected**, i.e. while someone has the UI open (`SseHub.clientCount`, wired by `buildApp({ usage })`). `rate_limit_event` readings are stored regardless. Readings older than 24 h are deleted (checked hourly); by then the 5-hour window of any of them has reset, so the meter would say "unknown" anyway.

A request that fails (an error `control_response`, no answer within 15 s, the process ended, the CLI missing, the poller timing out) is stored as a reading with both windows unknown, so the meter says "unknown" until the next good reading rather than showing an older number.

## `usageWindows` (D17)
`usageWindows` on `GET /api/system` and the `system` event (additive; `UsageWindow` in `src/core/api.ts`, `usageWindows()` in `src/core/usage.ts`) lists each window **known now**, in this order:

| `key` | `label` | From | Listed when |
|---|---|---|---|
| `session` | `Session` | the newest reading's 5-hour window (`five_hour`, `unifiedWindows.five_hour`) | it is valid now: a number and a reset still ahead |
| `week` | `Week` | the newest reading's weekly window (`seven_day`, all models) | the same, independently of Session |
| `model` | the model's name (`Fable`), also in `model` | the newest **`get_usage`** reading: `rate_limits.model_scoped[]` (`display_name`, `utilization` 0–100, `resets_at`) joined by name with `rate_limits.limits[]` entries of `kind: "weekly_scoped"` (`scope.model.display_name`, `percent`, `resets_at`, `is_active`); `model_scoped` wins where both have a value, a model only in `limits` is kept, the CLI's order is kept | it is valid now **and in use**: above 0 % **or** `is_active` |

- **Unknown stays unknown:** a window that is missing, malformed, expired, or from a failed reading is left out, and the field is omitted when nothing is known. Session and Week are independent: `usagePct` needs both (the max rule), but a known Week is still listed when Session is unknown.
- **Model windows only come from `get_usage`** (a `rate_limit_event` has no model data), so a newer `rate_limit_event` does not hide them; they are read from the newest `get_usage` reading **while it is at most 10 minutes old** (`MODEL_WINDOW_MAX_AGE_MS`, twice the poller's interval). A failed newer `get_usage`, or no `get_usage` for 10 minutes (e.g. every live session busy in long turns), makes them unknown until the next good answer. The recorded M0.3 answer lists Fable at 0 % and not active, so it has no row.
- Nothing is stored for them: they are parsed from the reading's `raw` (the CLI's answer verbatim), so no migration.
- **Demo mode** (`src/server/demo/providers.ts`): the prototype's one Max figure (`62% · 1h48`) stays `usagePct` / `usageResetsAt` and is the Session window; the Week window comes from an optional `footer.week` in `system.json` (same `18% · 74h12` form), which the prototype data does not have, so demo mode lists Session only and the footer's Week row reads "unknown". No number is invented.

### Footer (D17)
`Sidebar.tsx` shows, under CPU and RAM, a **Session** row and a **Week** row, then one row per model window (its label is the model's name). Each row: the label, a 4 px bar (the prototype's Max bar: `--border-card` track, 2 px radius, `--text` fill = the %), and the value `62% · 1h48` (the % rounded, then the time until the reset in the existing `formatResetsIn` form: `1h48`, `45m`, `74h12`); a window that is not listed reads `unknown`, and before `/api/system` answers every value reads `—`. The rows use the footer's tokens (Geist Mono 11 px, `--muted-2`, 7 px row gap). "Session" is wider than the prototype's 34 px label column, so the usage rows share their own columns (`.sb-usage`, a CSS subgrid): the label column as wide as the widest label and the value column as wide as the widest value, at least 34 / 76 px, so their bars line up with each other and end where the CPU / RAM bars end; CPU and RAM keep the prototype's columns.

## Weekly pace (D23)
The Week row says whether the week's usage is on pace: the allowance is spread evenly over the window's 7 days, 100 % ÷ 7 ≈ 14.29 % per day, counted from the window's own reset.

**The rule** (`weeklyPace(week, now)` in `src/core/usage.ts`, pure):
- The window started **7 × 24 h before** its `resetsAt` (the Week window's, i.e. `seven_day.resets_at`). Days start at the reset's time of day, and each day's share is available from the start of that day: during day *n* (1–7) the allowance is *n* × 100 / 7 %. A Thursday 15:00 reset gives days Thu 15:00 → Fri 15:00 … Wed 15:00 → Thu 15:00, so Mon 14:59 is day 4 (57.14 %) and Mon 15:00 is day 5 (71.43 %).
- **Days are 24-hour periods**, counted back from the reset instant, not calendar days: across a daylight-saving change they stay 24 h long, so in local time their start moves by the hour. Example: a Thu 15:00 CET reset on 29 Oct 2026 (Europe/Warsaw leaves summer time on Sun 25 Oct): days 1–3 start at 16:00 CEST (Thu 22, Fri 23, Sat 24), days 4–7 at 15:00 CET. The rule is pure time arithmetic, so it does not depend on the machine's time zone.
- The allowance is rounded to 2 decimals like the utilization (14.29, 28.57, 42.86, 57.14, 71.43, 85.71, 100), and **on pace** means `pct < allowance`: a Week at exactly the allowance (as shown) is yellow.
- It also gives `nextStepAt`, the end of the current day (on day 7, the reset).
- **Unknown stays unknown** (`null`, no color, no marker, no tooltip): no Week window (D17: missing, malformed, expired), a reset that is not ahead of now (the page's clock may pass it before the next `system` event), or a reset more than 7 days ahead (now would be outside the window it closes).

**The footer** (`usageRows` → `pace`, `MeterRow`, `shell.css`): computed in the browser from `usageWindows`' `key: 'week'` entry and the page's clock (the sidebar re-renders every 30 s and on every `system` event, so a step shows within 30 s; a moved reset is followed as soon as a new window arrives). No API field is added.
- The row gets `data-pace="on"` (bar fill SPEC *status done*, green) below the allowance or `data-pace="ahead"` (*status need*, yellow) at or above it; the bar width, the value text (`62% · 74h12`) and the 90 % warning are unchanged.
- A **2 px marker** in `--muted-3` sits on the bar at the allowance (centered on it, as high as the 4 px bar, inside the track; on day 7 half of it shows at the bar's end).
- The row's `title`: `On pace: 33% of 57.14% allowed until Mon 15:00` or `Ahead of pace: 62% of 57.14% allowed until Mon 15:00`: the utilization and the allowance with up to 2 decimals (trailing zeros dropped: `33%`, `18.4%`, `100%`), then the next step's local weekday and `HH:MM`.
- The Session row and the model rows never get a pace, color or marker.
- **Demo mode:** the demo's Week row is "unknown" (D17), so the demo views and the visual specs are unchanged.

## `usagePct` (the max rule)
`GET /api/system` and the `system` hub event get, from `providers.system` wrapped by `withUsage`:
- `usagePct` = the higher of the 5-hour and weekly utilization (the binding limit), rounded to 2 decimals, capped at 100.
- `usageResetsAt` (additive, M1.4) = when **that** window resets; on a tie the window that resets later (it binds longer). The footer shows `62% · 1h48`.
- Both are **omitted** ("unknown") when: there is no reading; `get_usage` errored or did not answer; `rate_limits_available` is false; `rate_limits`, a window, its `utilization` or its `resets_at` is null; any of them has another type (or a negative utilization, or an unparseable date); or either window's `resets_at` has passed without a newer reading.
- Whatever the base system provider said about usage is dropped, never mixed in.

## Warnings ("just warn")
- A window (5-hour, weekly, or D17: a model window from the rules above) that is valid now and at or above the threshold fires **one** warning. It is not repeated for that window until the window's `resets_at` passes; after the reset a new reading at or above the threshold warns again. Each window warns on its own. Nothing is paused, ever.
- Threshold: Settings `usage.warnAtPct` (the key M8.2 stores; a whole number 1–100), default **90**.
- Fired warnings are kept in the settings table under `usage.warned` (`{five_hour?, seven_day?, model?: {<name>: warning}}`), so a service restart does not repeat them. A model warning stays in force until its window's reset even when the model window is no longer read (the 10-minute limit above). This is internal state, not a preference: `GET /api/settings` (M8.2) lists known keys only.
- Warnings are evaluated on every meter tick and every `/api/system` / `system` call, serialized so two callers never fire the same one.
- The warnings in force (fired, window not reset yet) are on `/api/system` and the `system` event as the additive `usageWarnings: [{ window, pct, threshold, resetsAt, firedAt }]` (omitted when none); D17: `window: "model"` entries carry `model: "<name>"`. Order: 5-hour, weekly, then the model ones.
- **UI:** the toast host (`useUsageWarnings`) reads `usageWarnings` from `/api/system` when the page loads and from every `system` event, and shows each warning once per window and reset in this browser: title `Max usage 91%`, sub `5-hour window` / `weekly limit` / `Fable weekly limit` (D17), text `Your Max 5-hour window reached 91% (warning at 90%). It resets in 1h48. Nothing is paused automatically.`, only a "Later" button. Shown keys (`<window>@<resetsAt>`, D17: `model:<name>@<resetsAt>`) are remembered in `localStorage` (`switchboard.usageWarningsShown`, newest 20) as a per-viewer convenience; without storage a reload may show a warning again. No sound and no OS notification (those are for questions, M3.4). There is no prototype frame for this toast; it reuses the M3.4 toast styles, and the copy is derived from the prototype's "Usage-limit warnings … Nothing is paused automatically." and Settings' "5-hour window and weekly limit".

## Wiring
- `main.ts` creates the meter in normal runs (never in demo mode: the demo's usage is prototype data) **when there is a system provider to report through**, wraps `providers.system` with `withUsage`, passes it to `buildApp({ usage })`, starts it after restart recovery and stops it before the supervisor on shutdown. Warnings are also logged (`switchboard usage: Max 5-hour window at 91% (warning at 90%)`).
- **On `main` today there is no real system provider**: `GET /api/system` belongs to M5.3 (`SystemProbe`), which is on the unmerged lane `lane/w2-newsession`. Until that merge, normal runs have no `providers.system`, so the meter does not run, the route answers 501 and the footer reads "unknown". **Merge note:** keep M5.3's `providers = { …, system }` **before** the `const usage = …` block in `main.ts`, and turn `it.fails` in `tests/server/usage/wire.test.ts` ("GET /api/system carries usagePct …") into a plain `it`; M5.3's route serves `providers.system`, so it then carries `usagePct`, `usageResetsAt` and `usageWarnings`. M5.3's `SystemProvider.system(options)` signature passes through `withUsage` unchanged.

## Tests (the M9.2 oracle: unit)
- `tests/core/usage.test.ts` — the recorded `usage-ctl` / `usage-turn` payloads (`get_usage` 10 / 18 and the `rate_limit_event` 0.1 / 0.18), the stdin request equal to the recorded one, the max rule and ties, every unknown case, the warning once per window until its reset, the threshold, the stored state.
- `tests/server/usage/meter.test.ts` — the poll limits on a fake clock (no viewer → nothing; live ≤ 1/60 s and only between turns; poller ≤ 1/5 min, not with a live session, not with a fresh reading; overlapping ticks), failures stored as unknown, `start` / `stop`, pruning, the warning firing once across ticks, `/api/system` calls and a restart, the Settings threshold.
- `tests/server/usage/poller.test.ts` — the poller against fake-claude: exact argv and cwd, the env scrub, one `get_usage` line and no user message, no transcript; missing CLI, exit without an answer, timeout.
- `tests/server/usage/live.test.ts` — the real `SessionSupervisor` with fake-claude: `get_usage` over a live idle session's stdin (not a chat event, ≤ 1/60 s), never mid-turn, a turn's `rate_limit_event` as a reading.
- `tests/server/usage/wire.test.ts` — `withUsage`, and the `system` hub event carrying `usagePct` once a client connects and the real poller (fake-claude) has read; the `it.fails` for `GET /api/system` until the M5.3 merge.
- `tests/web/usage-warning.test.ts` — the toast copy, once per window and reset, the storage helpers; D17: the model toast and key.
- **D17:** `tests/core/usage.test.ts` → *D17: usage windows* (the recorded answer: Session + Week, Fable at 0 % not listed; in use above 0 % or active; the `model_scoped` / `limits` join; every unknown case; Session and Week independent; the model warning once until its reset and its stored state; labels). `tests/server/usage/meter.test.ts` → *D17 model-scoped windows* (a newer `rate_limit_event` keeps them, gone after 10 min or a failed `get_usage`, the warning once across a restart). `tests/server/usage/wire.test.ts` (`usageWindows` on `GET /api/system` and the `system` event from the real poller with fake-claude, and a Fable window with its warning), `tests/server/demo/providers.test.ts` (the demo's Session window, a Week figure when present), `tests/web/format.test.ts` (`usageRows`), `tests/e2e/usage-footer.spec.ts` (the footer on the real path) and the shell / full-pass visual specs (the rows as D17 additions).
- **D23:** `tests/core/usage.test.ts` → *D23: weekly pace* (the day boundaries at the reset hour, Mon 14:59 → day 4 / 57.14 %, Mon 15:00 → day 5 / 71.43 %; every day's allowance; day 1 right at the previous reset, day 7 just before the next; at the allowance → not on pace; unknown / past / too-far reset → `null`; a week across the Europe/Warsaw DST change). `tests/web/format.test.ts` → *D23* (the Week row's state, marker position and tooltip; Session and model rows without a pace; unknown → none; `MeterRow`'s markup with and without a pace). `tests/e2e/week-pace.spec.ts` (real path, one seeded reading, the page on a fixed clock in UTC: yellow one minute before the step into day 5, green at it, the marker at 57.14 % / 71.43 %, the tooltip, the Session row unchanged, nothing after the reset) and `tests/e2e/usage-footer.spec.ts` (on the page's own clock: day 4, on pace, one marker). The demo's Week row is unknown, so the shell / full-pass visual specs are unchanged.
