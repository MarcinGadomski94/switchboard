# Demo seed (gap #21, D13)

`SWITCHBOARD_DEMO=1` loads the prototype's mock data so every view can render the prototype's content **through the normal API** for the visual oracle and screenshots. It is never used in normal runs, and nothing outside `src/server/demo/` reads the demo data.

## Running it
```sh
SWITCHBOARD_DEMO=1 SWITCHBOARD_DATA_DIR="$(mktemp -d)" SWITCHBOARD_PORT=4871 npm start
```
- `SWITCHBOARD_DATA_DIR` must be a throwaway folder. Demo mode refuses the per-user app-data folder (the real database) before it opens anything (`assertDemoDataDir`, exit 1 with `switchboard: …`).
- The seed goes into an empty database once, in one transaction, and is marked with the setting `demo.seed` = `{version, seededAt}`. Starting again on the same folder is a no-op. A database that already holds sessions without that marker is refused, and nothing is written.
- The API routes still answer 501 until their items land (`docs/lanes.md`); from then on the demo data shows up in the UI with no extra work.

## Files
| File | What |
|---|---|
| `src/server/demo/data/*.json` | The data. Lanes extend these files when their view needs more demo data. |
| `src/server/demo/data.ts` | Types of the data files + `loadDemoData()` + `ageMinutes()`. |
| `src/server/demo/seed.ts` | `seedDemo(store, data, {now, timelineBase})`: data → database rows. |
| `src/server/demo/providers.ts` | Demo implementations of the provider interfaces (`src/server/providers.ts`). |
| `src/server/demo/index.ts` | `startDemo()` (seed + providers) and `assertDemoDataDir()`, called from `src/server/main.ts`. |

The data files are the prototype's arrays with positional entries turned into named fields (`docs/handoff/prototype/Switchboard App.dc.html`, the `<script>` block and, for the footer, the markup). Every string is verbatim. `tests/server/demo/data.test.ts` checks each string against the prototype source, except the values the seed adds: run results (`ok` / `fail` / `need` / `skipped` / `running` for the prototype's letters and colors), cron expressions for the readable labels, the message author (`user` / `agent`) and the flag style (`warn` / `muted`).

| Data file | Prototype source |
|---|---|
| `sessions.json` | `S` (sessions with chips, agents, messages, questions, terminal lines, files, per-session artifacts, timeline lanes) |
| `inbox.json` | `INQ` + the toast and OS notification of `arrive()` (`incoming`), `SYS` (system items, with links to the failed schedule and the removable worktree) |
| `solutions.json` | the workspace root the prototype shows (`D:\acme`), `SG` (groups), the "moved to worktree" branch, `LED` (phase ledgers), `ARTS` (artifacts per solution), the dirty list with its times, `G` + `ns` (New-session groups and draft) |
| `schedules.json` | `SCH` (with cron for `02:00 daily` → `0 2 * * *`, `every 4h` → `0 */4 * * *`, `08:30 weekdays` → `30 8 * * 1-5`, `Mon 07:00` → `0 7 * * 1`) |
| `loops.json` | `loops` (+ iteration, cap, breaker read from their facts) |
| `artifacts.json` | `ART.slice(1)` (the 13 rows the prototype shows), location split into solution + branch |
| `history.json` | `HIST` |
| `tools.json` | `TOOLS` + the default URLs |
| `setup.json` | wizard checks (`wzChecks`) + scan rows (`scan`) |
| `system.json` | the sidebar footer (CPU, RAM, Max, process count = sessions + 3) + CLI / gh status |

## What goes where
**Into the database** (`seedDemo`):
- Sessions: id = name (`/sessions/free-talk-feature`), `claudeSessionId` = the prototype's resume id, status, work type / mode / phase from the chips, solutions from the agents' folders, task = the first user message, `lastActivityAt` = now − age. The session list's newest-activity-first order equals the prototype's.
- Agents: the first agent is `main` for orchestrator and single-agent sessions, the rest `subagent`.
- Events: the chat as the real payloads the Chat tab renders (M4.2, `docs/chat.md`): each message → `user` (`origin` `task` for the first) / `assistant`, each of its tool lines → a step event with the same mark (`demoStep`: `✓` finished tool, `●` running tool, `✕` failed tool, `⏸` open permission request, `•` → `✓`); all carry `source: 'demo'`. Then the terminal lines (M4.3, `docs/session-panel.md`): each one a finished turn result whose text is the line (`demoResult`: kind `ok`, `type: 'result'`, `subtype: 'success'`), which the terminal tail shows verbatim and the chat does not show; the cursor line `▍` is not stored (the tail adds it while a session's status is `run`). Then the timeline blocks, `payload.channel` `timeline` (the block kind, `ts`/`endTs` = `timelineBase` + t0 + minutes, `{lane, solution}`). `timelineBase` defaults to 10:00 local time on the seeding day, so the timeline reads 10:02 – 10:48 as in the prototype. The timeline payloads are still provisional (M4.4).
- Question batches: one open batch per session with questions (`demo-<session>`), input in the AskUserQuestion shape, sources verbatim.
- System items (`sys-run` linked to the failed schedule and its last run, `sys-wt` linked to a removable worktree with PR #231 `MERGED`), created at now − age, stored with the kinds M3.3 raises (`schedule-run-failed`, `worktree-removable`, `docs/system-items.md`) and action ids from their labels (`open-fix-session`, `retry-run`, `dismiss`, `remove-worktree`, `keep`); `sys-run` stores the prototype's "Open fix session" values (`ns`: `fix-xamlc-acmchip`, its task, `mobile`, single, UI-first; inbox.json `fixSession`) as `payload.prefill`.
- Worktrees: every Solutions branch that has a worktree folder (`../<repo>-wt-<session>`), linked to its session; in-place branches get no row.
- Schedules with their 14 runs, oldest first, one cron period apart; the failed schedule's last run is the system item's age ago, the others ran an hour ago; the last run's summary is the prototype's "last" text.
- Loops, artifacts (at now − age), tools (`cm` with `http://localhost:13000`, `sw` without a URL).

**Into demo providers** (not in the database): git diffs (`sessions.json` files), the solutions scan (`solutions.json`: rows with the prototype's detail paths under `D:\acme` (`sd.path`), phase ledgers, per-solution artifacts and the dirty list as `codebaseMemory`, M6.2; the `mobile` row's `conflictSessions`, the names in the prototype's `sd.warn`, M6.3), system metrics (`system.json`, as contract units: percentages, bytes), History rows (`history.json`).

**Kept in the data files for later lanes**, not loaded yet: the per-session artifact rows (`sessions.json` → `artifacts`; the database holds the global `ART` list, whose names differ), the incoming question + toast (M3.4 raises toasts only from real `questionBatch` events, so the demo never simulates an arrival; its toast visual runs on the real path, `docs/visual/toast.md`), the dirty list's times (M6.4), the New-session groups and draft (M5.1), wizard checks and scan rows (M5.3), the prototype's readable schedule texts (`last`, `next`, `cronLabel`) and loop facts (M7.x).
