# Demo seed (gap #21, D13)

`SWITCHBOARD_DEMO=1` loads the prototype's mock data so every view can render the prototype's content **through the normal API** for the visual oracle and screenshots. It is never used in normal runs, and nothing outside `src/server/demo/` reads the demo data.

Demo names are fictional (Acme): the repos, features, branches and tickets in the demo data, the prototype, the tests and the docs are invented. The prototype and the demo data use the same names word for word, because the visual oracle compares them.

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
| `src/server/demo/login-service.ts` | The demo's "Start at login" (M9.1): an in-memory flag that starts on (the prototype's value) and never writes a service definition or runs a service manager (`docs/service.md`). |
| `src/server/demo/index.ts` | `startDemo()` (seed + providers) and `assertDemoDataDir()`, called from `src/server/main.ts`. |

The data files are the prototype's arrays with positional entries turned into named fields (`docs/handoff/prototype/Switchboard App.dc.html`, the `<script>` block and, for the footer, the markup). Every string is verbatim. `tests/server/demo/data.test.ts` checks each string against the prototype source, except the values the seed adds: run results (`ok` / `fail` / `need` / `skipped` / `running` for the prototype's letters and colors), cron expressions for the readable labels, the message author (`user` / `agent`) and the flag style (`warn` / `muted`).

| Data file | Prototype source |
|---|---|
| `sessions.json` | `S` (sessions with chips, agents, messages, questions, terminal lines, files, per-session artifacts, timeline lanes) |
| `inbox.json` | `INQ` + the toast and OS notification of `arrive()` (`incoming`), `SYS` (system items, with links to the failed schedule and the removable worktree) |
| `solutions.json` | the workspace root the prototype shows (`D:\acme`), `SG` (groups), the "moved to worktree" branch, `LED` (phase ledgers), `ARTS` (artifacts per solution), the dirty list with its times and the strip's indexed count ("16 projects indexed · full mode"), `G` + `ns` (New-session groups and draft) |
| `schedules.json` | `SCH` (with cron for `02:00 daily` → `0 2 * * *`, `every 4h` → `0 */4 * * *`, `08:30 weekdays` → `30 8 * * 1-5`, `Mon 07:00` → `0 7 * * 1`) |
| `loops.json` | `loops` (+ iteration, cap, breaker read from their facts) |
| `artifacts.json` | D89: 13 saved artifacts (title, kind, language, session, saved by, age, the versions' texts), as many per session as the prototype's tabs count; not the prototype's `ART` rows, which were derived (`docs/artifacts.md`) |
| `history.json` | `HIST` |
| `tools.json` | `TOOLS` + the default URLs |
| `setup.json` | wizard checks (`wzChecks`) + scan rows (`scan`) + the stored settings the prototype shows (M8.2) |
| `system.json` | the sidebar footer (CPU, RAM, Max, process count = sessions + 3) + CLI / gh status |

## What goes where
**Into the database** (`seedDemo`):
- D14: one saved folder, id `demo` (`DEMO_FOLDER_ID`), the prototype's root `D:\acme` as a workspace, the default unless a folder was saved before the seed (the visual Settings spec saves a temp workspace first). Every demo session and schedule belongs to it; the demo providers ignore the folder they are asked for (its live check reports the Windows path as missing off Windows).
- Sessions: id = name (`/sessions/pair-talk-feature`), `claudeSessionId` = the prototype's resume id, status, work type / mode / phase from the chips, solutions from the agents' folders, task = the first user message, `lastActivityAt` = now − age. The session list's newest-activity-first order equals the prototype's.
- Agents: the first agent is `main` for orchestrator and single-agent sessions, the rest `subagent`.
- Events: the chat as the real payloads the Chat tab renders (M4.2, `docs/chat.md`): each message → `user` (`origin` `task` for the first) / `assistant`, each of its tool lines → a step event with the same mark (`demoStep`: `✓` finished tool, `●` running tool, `✕` failed tool, `⏸` open permission request, `•` → `✓`); all carry `source: 'demo'`. Then the terminal lines (M4.3, `docs/session-panel.md`): each one a finished turn result whose text is the line (`demoResult`: kind `ok`, `type: 'result'`, `subtype: 'success'`), which the terminal tail shows verbatim and the chat does not show; the cursor line `▍` is not stored (the tail adds it while a session's status is `run`). Then the timeline blocks, `payload.channel` `timeline` (the block kind, `ts`/`endTs` = `timelineBase` + t0 + minutes, `{lane, solution}`). `timelineBase` defaults to 10:00 local time on the seeding day, so the timeline reads 10:02 – 10:48 as in the prototype. The timeline payloads are still provisional (M4.4).
- Question batches: one open batch per session with questions (`demo-<session>`), input in the AskUserQuestion shape, sources verbatim. D128: a demo question with `"multiSelect": true` in `sessions.json` is seeded as a multi-select question (input and stored question; none of the shipped data sets it).
- System items (`sys-run` linked to the failed schedule and its last run, `sys-wt` linked to a removable worktree with PR #231 `MERGED`), created at now − age, stored with the kinds M3.3 raises (`schedule-run-failed`, `worktree-removable`, `docs/system-items.md`) and action ids from their labels (`open-fix-session`, `retry-run`, `dismiss`, `remove-worktree`, `keep`); `sys-run` stores the prototype's "Open fix session" values (`ns`: `fix-xamlc-acmchip`, its task, `mobile`, single, UI-first; inbox.json `fixSession`) as `payload.prefill`.
- Worktrees: every Solutions branch that has a worktree folder (`../<repo>-wt-<session>`), linked to its session; in-place branches get no row.
- Schedules with their 14 runs, oldest first, one cron period apart, each ending 5 minutes after it started; the failed schedule's last run ended the system item's age ago, the others an hour ago; `need` runs have no end yet. The last run's summary is the prototype's "last" text without the prefix the Schedules view adds from the result (`runSummary`: `OK · `, `Failed <age> ago · `, `Asked: `; M7.1, `docs/schedules.md`). The template is `{name, task}` only (Edit opens with those; Run now in demo mode fails with `Not started: …`), and the cron timer never runs in demo mode.
- Loops, artifacts (D89: each version at now − its age, the latest at the artifact's age, versions a minute apart), tools (`cm` with `http://localhost:13000`, `sw` without a URL).
- Settings from `setup.json` → `settings` (M8.2): `service.startAtLogin` = true, the prototype's "Start at login · on".

**Into demo providers** (not in the database): git diffs (`sessions.json` files; every demo file is `uncommitted`, as the prototype shows the "Not committed" note for all of them, M4.5), the solutions scan (`solutions.json`: rows with the prototype's detail paths under `D:\acme` (`sd.path`), phase ledgers, per-solution artifacts and the dirty list as `codebaseMemory`, M6.2; the `mobile` row's `conflictSessions`, the names in the prototype's `sd.warn`, M6.3), system metrics (`system.json`, as contract units: percentages, bytes), History rows (`history.json`), and "Start at login" (in memory, on; M9.1).

**Kept in the data files for later lanes**, not loaded yet: the per-session artifact rows (`sessions.json` → `artifacts`: the prototype's derived rows, which D89 replaced with saved artifacts), the incoming question + toast (M3.4 raises toasts only from real `questionBatch` events, so the demo never simulates an arrival; its toast visual runs on the real path, `docs/visual/toast.md`), the dirty list's times (M6.4), the New-session groups and draft (M5.1), wizard checks and scan rows (M5.3), the prototype's `next` schedule texts (M7.1 computes them from the clock; `cronLabel` is what `cronLabel()` derives from the cron, and `last` is rebuilt from the run's result + summary) and loop facts (M7.2 shows D9's own facts from the stored fields instead: `docs/derivations.md` → *Loop cards*).

Since M8.1 the Codebase Memory strip also reads `solutions.json` → `codebaseMemoryDirty` (with today's times) + `codebaseMemoryIndexed`, and the demo tool probes always answer `down` (no network, as in the prototype's offline screenshots).

## Screenshot extras (`SWITCHBOARD_DEMO_EXTRAS=1`)
Demo mode never starts Team (D100) or Plans (D99) on the plain seed and keeps the prototype's footer figure, so the visual oracle is unaffected. `SWITCHBOARD_DEMO_EXTRAS=1` (`config.demoExtras`, ignored without `SWITCHBOARD_DEMO=1`) changes two things and nothing else:
- `installTeam` and `installPlans` read their switches in demo mode too;
- the footer grid reads the accounts' stored usage readings (`withAccountUsage`), so an account "on credits" (D103) can be shown.

It was written for the classic README screenshots. Since 2.0 `npm run screenshots` shoots the v2 theme on the v2 layer below and no longer sets it.

## README screenshots (`npm run screenshots`)
`tools/screenshots/readme.ts` retakes every image in `docs/screenshots/` (all of them are README images) from the demo with its v2 layer, in the v2 theme:
```sh
npm run screenshots
```
- It builds the UI into `.e2e-dist/web` first (`npm run screenshots -- --no-build` reuses the last build) and starts the app as a test server: a test port (`SWITCHBOARD_TEST_PORTS`, default 4871–4879), a throwaway data folder, the fake CLIs, the in-memory secret store, the setup wizard and the tours off, plus `SWITCHBOARD_DEMO=1`, `SWITCHBOARD_DEMO_V2=1` and `SWITCHBOARD_UI_THEME_DEFAULT=v2`. It never touches the real app's port or data.
- Before the start it names the machine `studio-mac` in the throwaway database, so no shot shows this computer's host name (the v2 layer adopts the teammates before the port opens, and each keeps the machine name it was adopted on).
- The browser is Playwright's bundled Chromium, headless. Desktop shots are 1440×900, phone shots 390×844 with touch, all at device scale 2 and light unless the name ends in `-dark`; `home-full.png` is Home's whole scrolling content. A welcome tour that shows is ended with Esc, and any console error fails the run.
- To add or change a shot, edit `SHOTS` in the script; a shot whose file the README no longer links should be removed with it.

## The v2 layer (D131, `config.demoV2`)
The prototype-verbatim seed above leaves several v2 pages empty (no folders, projects, crews, notes, tasks or Insights) and demo mode does not run Team, Plans or Project memory. The v2 layer (`src/server/demo/v2.ts`) adds plausible Acme rows for them. It runs with `SWITCHBOARD_DEMO=1` **unless the service's default theme is `classic`** (`SWITCHBOARD_UI_THEME_DEFAULT=classic`, which every E2E server sets), so the classic visual oracle (`tests/e2e/visual/`) keeps the plain seed; `npm run screenshots` uses it (*README screenshots* above); `SWITCHBOARD_DEMO_V2=1` / `0` forces it on or off. With it, Team, Plans and Project memory run in demo mode.

It runs once per data folder (the setting `demo.v2` = `{version, files, api}`), in two parts:
- **Before the app is built** (`seedDemoV2Files`, main database and `plans.db`): four teammates' agents with a two-message chat (`acme-web-lead`, `acme-web-reviewer`, `acme-release-manager`, `acme-mobile-dev`); tasks with estimates (open, in progress, and three done within the hour with their actual time, since done tasks leave the list after an hour); a week of `insight_turns_daily` rows for five agents (Insights); and three projects in `plans.db` before Plans opens it: "PROJ-123 Acme checkout" running (two steps done, one ready for approval, one with a question, one working, two waiting), "PROJ-140 Acme alerts digest" done and "PROJ-150 Acme loyalty points" a draft. Each step is a task of its project's agent, in the matching state. Steps run in existing demo agents; demo folders are not real, so nothing new starts.
- **Through the app's own API, in process** (`seedDemoV2Api`, `app.inject` with the host and token cookie, before the port opens): sidebar folders "Acme web" and "Maintenance" › "Releases" with agents in them and a pin (Agents' folder tree, the rail's Pinned); the crews "Acme web" (the first crew, renamed) and "Acme mobile" adopting the four teammates (`POST /api/team/members`, no charter ask); and three approved notes on the workspace folder (`POST /api/memory/entries`). A failed call is logged and skipped.

Tests: `tests/server/demo/v2.test.ts`, `tests/e2e/v2-demo.spec.ts`.
