# Max usage meter (M9.2)

The footer's **Max** bar and the usage warning. Sources and the verdict come from the M0.3 spike (`docs/spike-m0.md` → *Usage %*); the item is BACKLOG M9.2 (adapted after M0). **Never a guessed percentage:** anything missing, erroring or shaped differently is "unknown", and `usagePct` is left out.

## Files
| File | Role |
|---|---|
| `src/core/usage.ts` | The rules, pure: parse a `get_usage` answer or a `rate_limit_event`, the state at a moment (max rule, unknown cases), the warnings due, the `/api/system` fields. |
| `src/server/usage/meter.ts` | `UsageMeter`: when to read, storing readings, firing warnings, pruning. |
| `src/server/usage/poller.ts` | `UsagePoller`: the short-lived `claude` process that reads usage while no session is live. |
| `src/server/usage/wire.ts` | `withUsage(providers, meter)` (adds the fields to `providers.system`) and `createUsageMeter` (normal runs). |
| `src/server/supervisor/supervisor.ts` | `idleLiveSessionIds()` and `controlRequest()`: a stdin control request to a live session between turns. |
| `src/server/supervisor/recorder.ts` | Stores every `rate_limit_event` as a reading (M2.1; now through `readingFromRateLimit`). |
| `src/web/toast/usage-warning.ts`, `useUsageWarnings.ts` | The warning toast. |
| `src/web/shell/format.ts` → `maxMeter` | The footer bar (M1.4): `usagePct` + `usageResetsAt`, "unknown" without them. |

## Readings
Each reading is one `usage_readings` row: 5-hour and weekly utilization (0–100) with their reset times (ISO), the source, the session it came from (or none), when Switchboard received it, and the CLI's payload verbatim (`raw`). Only the newest reading drives the meter.

| Source | How | When |
|---|---|---|
| `get_usage` on a live session | stdin `{"type":"control_request","request_id":"sb-usage-<uuid>","request":{"subtype":"get_usage","skip_behaviors":true}}` to a supervised process **between turns** (no turn running, no open request, not being stopped); its `control_response` is not a chat event | at most once per **60 s** (the CLI caches the answer for about a minute) |
| `rate_limit_event` | stored by the recorder for every one a turn emits (`unifiedWindows.*.utilization` × 100, `resetsAt` epoch seconds → ISO) | free, whenever a turn calls the API |
| the poller | `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio` (+ `SWITCHBOARD_CLAUDE_EXTRA_ARGS`, like every spawn) in the **app-data folder**, env scrubbed as in M2.1 → `get_usage` → EOF once answered. No user message: no model call, no transcript. Stopped (SIGTERM → SIGKILL) after 30 s | only while **no session is live**, at most once per **5 min**, and not while a reading younger than 5 min exists |

The meter checks every 15 s and makes requests (live `get_usage` or the poller) **only while a `/hub` client is connected**, i.e. while someone has the UI open (`SseHub.clientCount`, wired by `buildApp({ usage })`). `rate_limit_event` readings are stored regardless. Readings older than 24 h are deleted (checked hourly); by then the 5-hour window of any of them has reset, so the meter would say "unknown" anyway.

A request that fails (an error `control_response`, no answer within 15 s, the process ended, the CLI missing, the poller timing out) is stored as a reading with both windows unknown, so the meter says "unknown" until the next good reading rather than showing an older number.

## `usagePct` (the max rule)
`GET /api/system` and the `system` hub event get, from `providers.system` wrapped by `withUsage`:
- `usagePct` = the higher of the 5-hour and weekly utilization (the binding limit), rounded to 2 decimals, capped at 100.
- `usageResetsAt` (additive, M1.4) = when **that** window resets; on a tie the window that resets later (it binds longer). The footer shows `62% · 1h48`.
- Both are **omitted** ("unknown") when: there is no reading; `get_usage` errored or did not answer; `rate_limits_available` is false; `rate_limits`, a window, its `utilization` or its `resets_at` is null; any of them has another type (or a negative utilization, or an unparseable date); or either window's `resets_at` has passed without a newer reading.
- Whatever the base system provider said about usage is dropped, never mixed in.

## Warnings ("just warn")
- A window (5-hour or weekly) that is valid now and at or above the threshold fires **one** warning. It is not repeated for that window until the window's `resets_at` passes; after the reset a new reading at or above the threshold warns again. Each window warns on its own. Nothing is paused, ever.
- Threshold: Settings `usage.warnAtPct` (the key M8.2 stores; a whole number 1–100), default **90**.
- Fired warnings are kept in the settings table under `usage.warned` (`{five_hour?, seven_day?}` → the warning), so a service restart does not repeat them. This is internal state, not a preference: `GET /api/settings` (M8.2) lists known keys only.
- Warnings are evaluated on every meter tick and every `/api/system` / `system` call, serialized so two callers never fire the same one.
- The warnings in force (fired, window not reset yet) are on `/api/system` and the `system` event as the additive `usageWarnings: [{ window, pct, threshold, resetsAt, firedAt }]` (omitted when none).
- **UI:** the toast host (`useUsageWarnings`) reads `usageWarnings` from `/api/system` when the page loads and from every `system` event, and shows each warning once per window and reset in this browser: title `Max usage 91%`, sub `5-hour window` / `weekly limit`, text `Your Max 5-hour window reached 91% (warning at 90%). It resets in 1h48. Nothing is paused automatically.`, only a "Later" button. Shown keys are remembered in `localStorage` (`switchboard.usageWarningsShown`, newest 20) as a per-viewer convenience; without storage a reload may show a warning again. No sound and no OS notification (those are for questions, M3.4). There is no prototype frame for this toast; it reuses the M3.4 toast styles, and the copy is derived from the prototype's "Usage-limit warnings … Nothing is paused automatically." and Settings' "5-hour window and weekly limit".

## Wiring
- `main.ts` creates the meter in normal runs (never in demo mode: the demo's usage is prototype data) **when there is a system provider to report through**, wraps `providers.system` with `withUsage`, passes it to `buildApp({ usage })`, starts it after restart recovery and stops it before the supervisor on shutdown. Warnings are also logged (`switchboard usage: Max 5-hour window at 91% (warning at 90%)`).
- **On `main` today there is no real system provider**: `GET /api/system` belongs to M5.3 (`SystemProbe`), which is on the unmerged lane `lane/w2-newsession`. Until that merge, normal runs have no `providers.system`, so the meter does not run, the route answers 501 and the footer reads "unknown". **Merge note:** keep M5.3's `providers = { …, system }` **before** the `const usage = …` block in `main.ts`, and turn `it.fails` in `tests/server/usage/wire.test.ts` ("GET /api/system carries usagePct …") into a plain `it`; M5.3's route serves `providers.system`, so it then carries `usagePct`, `usageResetsAt` and `usageWarnings`. M5.3's `SystemProvider.system(options)` signature passes through `withUsage` unchanged.

## Tests (the M9.2 oracle: unit)
- `tests/core/usage.test.ts` — the recorded `usage-ctl` / `usage-turn` payloads (`get_usage` 10 / 18 and the `rate_limit_event` 0.1 / 0.18), the stdin request equal to the recorded one, the max rule and ties, every unknown case, the warning once per window until its reset, the threshold, the stored state.
- `tests/server/usage/meter.test.ts` — the poll limits on a fake clock (no viewer → nothing; live ≤ 1/60 s and only between turns; poller ≤ 1/5 min, not with a live session, not with a fresh reading; overlapping ticks), failures stored as unknown, `start` / `stop`, pruning, the warning firing once across ticks, `/api/system` calls and a restart, the Settings threshold.
- `tests/server/usage/poller.test.ts` — the poller against fake-claude: exact argv and cwd, the env scrub, one `get_usage` line and no user message, no transcript; missing CLI, exit without an answer, timeout.
- `tests/server/usage/live.test.ts` — the real `SessionSupervisor` with fake-claude: `get_usage` over a live idle session's stdin (not a chat event, ≤ 1/60 s), never mid-turn, a turn's `rate_limit_event` as a reading.
- `tests/server/usage/wire.test.ts` — `withUsage`, and the `system` hub event carrying `usagePct` once a client connects and the real poller (fake-claude) has read; the `it.fails` for `GET /api/system` until the M5.3 merge.
- `tests/web/usage-warning.test.ts` — the toast copy, once per window and reset, the storage helpers.
