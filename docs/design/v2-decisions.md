# Switchboard 2: the assumptions log (all lanes)

The developer asked for v2 to be built without questions (D131, `docs/decisions.md`). Every lane records here what it had to decide on its own: one line per assumption, **ASSUMED** first, then why. The orchestrator reviews them at the end; anything the developer overrules becomes a fix.

Format: `- **ASSUMED** <what>. <why>. (lane, date)`

## Lane F · Foundation (2026-10-25)

### Branching and structure
- **ASSUMED** the lane branches are named `v2-<lane>` (`v2-foundation`), not `v2/<lane>`: git cannot hold `refs/heads/v2/foundation` while a branch `v2` exists. Lane G already used `v2-graduation`. (F)
- **ASSUMED** all v2 code lives under `src/web/v2/`; the only classic files touched are the boot (`main.tsx`, the new `Root.tsx` and `theme.ts`), `router.tsx` (its value also carries the raw `pathname`), `shell/Panes.tsx` (`loadPaneState` takes the boot's settings read) and classic Settings (a new **Appearance** section). (F)
- **ASSUMED** v2 CSS never meets classic CSS: every v2 token is named `--v2-*` and defined on `<html data-ui="v2">`, every rule is scoped under `.sb2` (the v2 root) and every class starts with `v2-`. Both UIs' code is on the page at once (the switch needs no reload), so names must not collide. (F)
- **ASSUMED** the v2 UI's code is a separate chunk, loaded before the first render when v2 is the boot theme (no flash) and fetched when the browser is idle otherwise (an instant switch). (F)

### The theme switch
- **ASSUMED** the per-browser choice is `localStorage['switchboard.ui.theme']` (`v2` / `classic`); without one, the service's `ui.theme` (default `v2`) applies. A phone is a browser like any other. (F)
- **ASSUMED** `SWITCHBOARD_UI_THEME_DEFAULT` (`v2` / `classic`) sets the service's default until `ui.theme` is stored. The E2E test servers set `classic`, so every spec written before v2 keeps testing the classic UI; v2 specs opt in (`tests/e2e/v2-world.ts`). (F)
- **ASSUMED** classic Settings gets a new **Appearance** section (after Notifications & usage) with the Theme switch and "Default for new browsers" (shown, or "Make … the default"). v2's twin is `settings/ThemeRow.tsx` (lane R places it). (F)
- **ASSUMED** switching replaces the current history entry with the other UI's address for the same page (`toV2Path` / `toClassicPath`); where the other UI has no such page the address is kept and that UI shows its default page. (F)
- **ASSUMED** the placeholder pages' "Open the classic page" switches this browser to Classic (the same switch as Settings), so it persists until switched back. (F)
- **ASSUMED** v2's light / dark follows the system by default; Settings › Appearance may fix it per browser (`localStorage['switchboard.v2.scheme']`). Classic stays dark only. (F)

### Routes
- **ASSUMED** the v2 addresses: `/` Home, `/needs-you`, `/agents` (`?show=closed` = closed agents, the classic History), `/agents/:id[/changes|results|timeline|helpers]`, `/agents/:id/helpers/:helperId[/events/:eventId]`, `/agents/:id/results/:resultId`, `/agents/:id/events/:eventId`, `/projects[/:id]`, `/crews[/:id]`, `/results`, `/search?q=`, `/insights`, `/settings[/usage|computers|phones|rules|appearance|advanced[/<classic section>]]`, `/notes`, `/routines`, `/tasks`, `/tools/:id`, `/share`, and `/more` (the phone's More tab). (F)
- **ASSUMED** classic → v2: `/inbox` → `/needs-you`, `/sessions/…` → `/agents/…` (Diff → Changes, Artifacts → Results, agents → helpers), `/plans` → `/projects`, `/team` → `/crews` (`/team/all` → `/crews`), `/artifacts` → `/results`, `/memory` → `/notes`, `/todos` → `/tasks`, `/schedules` → `/routines`, `/history` → `/agents?show=closed`, `/solutions` → `/settings/advanced/code-projects`, `/mcp` → `/settings/advanced/connections`, `/settings/accounts|machines|devices` → `/settings/usage|computers|phones`, any other classic section → `/settings/advanced/<key>`; v2 → classic the reverse (`/settings/rules` → `/settings/sessions`, where the standing instruction is). (F)

### Needs you
- **ASSUMED** no new server route is needed: `GET /api/inbox` (already merging paired computers), `GET /api/team/needs-you?teamId=all`, `GET /api/memory/entries?scope=` and `GET /api/system` cover every source. System items are told apart by their action ids and labels (`plan-merge` / `merge-pr` → ready, `plan-ask-repos` → pick code projects, `retry-run` → routine failed, `open-memory` → notes, `Stopped` / `CI keeps failing` → stopped, `turn-waiting` → ask). (F)
- **ASSUMED** an answer waits 5 s before it is sent, so the toast's **Undo** really takes it back; it is sent at once when the page is hidden or closed. (F)
- **ASSUMED** a folder's "N memory proposals" item is replaced by one card per proposed note (Approve / Edit first / Reject); if its notes cannot be read, the summary item stays with its Review link. (F)
- **ASSUMED** usage alerts (an account out of usage, or paying from paid extra usage) are derived from `GET /api/system` and dismissed per browser (`localStorage['switchboard.v2.dismissedAlerts']`); the server has no such item. (F)
- **ASSUMED** "Go ahead" on an agent's ask sends `Go ahead.`; **Try again** on a stopped step sends `Please try again and finish the task.` and dismisses the item; **Send back** on a ready plan step uses the plan's send-back (found by the item's run session), else a message to the agent. (F)
- **ASSUMED** an access request's **Add key** opens `/crews/<crew>?member=<id>&tab=access` (lane P: honour these query keys); **Not now** declines it. A gate or budget request is an approval (Approve / Deny). (F)
- **ASSUMED** the rail's badges: Home = everything waiting; Agents = items of agents that are neither a teammate nor a project step; Projects = project steps' items (and pick code projects); Crews = teammates' items. Results and Settings have none. (F)

### Shell
- **ASSUMED** every v2 overlay (menu, popover, dialog, sheet, drawer) renders into one overlay layer at the end of the v2 root (`components/Portal.tsx`), not into `<body>`: it keeps the `.sb2` scope and the React context. (F)
- **ASSUMED** the status pill's usage meters say **5 hours** and **Week** (the prototype says "Today"): the window is five hours, not a day. (F)
- **ASSUMED** the Pinned list is the shared sidebar layout's pins (sessions only; closed ones hidden). (F)
- **ASSUMED** the shell owns ⌘K, ⌘⇧F and `?`, and emits ⌘. (side panel, lane S) and ⌘\\ (folder tree, lane A) to the page that registered `useShortcut(…)`; Esc (stop the agent) and number keys belong to the pages and the answer cards. (F)
- **ASSUMED** the "unread" and "draft" markers are building blocks only: the service has no unread state yet, so the lanes decide when to show them. (F)
- **ASSUMED** no What's-new tour for Lane F: lane X adds "Welcome to Switchboard 2" (the plan's Phase 2). (F)

### Tests
- **ASSUMED** `tests/e2e/settings.spec.ts`'s section list also gains **Processes** (D127), which it was missing (it failed before v2), besides **Appearance**. (F)
- **ASSUMED** `tests/e2e/responsive.spec.ts` › *phone landscape 640×360 › menus fit the window* fails on the `v2` base too (the classic sidebar ⋯ menu ends 1 px below the window); not touched by lane F. (F)

## Lane G · Graduation (D132)

- **ASSUMED G1 · branch name.** The brief asked for `v2/graduation`, but git cannot create `refs/heads/v2/graduation` while the integration branch `v2` exists (a ref cannot be both a branch and a folder). Lane G works on **`v2-graduation`** (cut from `v2`).
- **ASSUMED G2 · stored switches: delete once at start.** The three 1.x keys (`experimental.team`, `experimental.plans`, `experimental.memory`) are ignored (no longer known settings) and deleted at every start by `forgetGraduatedSwitches` (idempotent, so it is effectively one-time). No migration: they are settings values, not schema. `PUT /api/settings` now refuses them with 422 like any unknown key.
- **ASSUMED G3 · the Jira connection gets its own section.** Settings → Experimental held only the three switches and, under the Plans row, the Jira connection. With the switches gone the section had nothing switchable left, so it is removed and the Jira connection moved to a new classic section **Settings → Jira** (`/settings/jira`, placed where Experimental was, before Clean-up); `/settings/experimental` resolves to it so old links and bookmarks still land somewhere sensible. Lane R may reuse or embed it in the v2 Settings → Advanced.
- **ASSUMED G4 · the sidebar's team entry for an untouched Team.** Team always has its first team (`team.db` creates it), so turning Team on for everyone would add "⚑ Team · 0 members" above SESSIONS for users who never used Team. The entry now stays hidden while only the first team exists with its default name and no member (`untouchedTeams`, `src/web/team/sidebar-roster.ts`); a member, a rename or a second team shows it as before. The nav grid's Team cell is always there (that is how Team is reached).
- **ASSUMED G5 · the nav grid grows to eleven cells.** With Plans, Team and Memory always on, the classic nav grid has eleven cells (three rows of five instead of two) for users who had any of them off. Not changed (the cells are how the features are reached; v2 has its own rail).
- **ASSUMED G6 · plans paused by a 1.x switch-off stay paused.** A plan that 1.x paused when Plans was switched off keeps its "Plans was switched off" reason until the developer resumes it, exactly as switching Plans on did in 1.x. Nothing resumes by itself on upgrade.
- **ASSUMED G7 · demo mode unchanged.** Demo mode still does not run Team, Plans or Project memory (their state answers `enabled: false` there, as before); with `SWITCHBOARD_DEMO_EXTRAS=1` Team and Plans run for the README screenshots. Lane X owns how the demo seed renders in v2.
- **ASSUMED G8 · the state routes keep `enabled`.** `GET /api/{team,plans,memory}/state` still answers `enabled` (always `true` outside demo mode) so a 1.x peer or an older page reading them keeps working; `available` remains the field that matters (false only for a broken database).
- **ASSUMED G9 · a What's-new tour for the graduation.** Existing installs that had the features off would otherwise see three new sidebar cells unexplained, so a short `graduated` tour (D132, version 2.0.0) points at the Plans, Team and Memory cells and says Settings → Experimental is gone and the Jira connection moved. Lane X's "Welcome to Switchboard 2" tour is separate; the orchestrator may merge them.
- **ASSUMED G10 · the removal docs stay as the wiring map.** `docs/*-removal.md` became short "graduated" notes that keep the hook table (file → hook) as *How it is wired*; the `removal.test.ts` files still check the markers against those tables. The 1.x step-by-step removal procedure is in the files' git history.

## Lane A · Agents (Notes, Routines)

### Notes (`/notes`)
- **ASSUMED** Notes lists every folder's entries at once (`GET /api/memory/entries` with no scope answers all of them), this computer's and each paired computer's through the proxy; an offline computer is named with "its notes show when it is back", and paired computers are read again every 30 s (their `memoryChanged` does not reach this hub). The classic page reads one folder at a time; the prototype shows one list. (A, 2026-10-25)
- **ASSUMED** the scope words: a `workspace` entry is "Folder · <saved folder label>", a `repo` entry "Code project · <repo name>", a `member` entry "Teammate · <role>". These are the API's three scope kinds; the prototype's labels match them. (A, 2026-10-25)
- **ASSUMED** the scope filter's keys are `folder:<path>`, `repo:<key>`, `member:<id>`, and a bare `?scope=<folder path>` (the classic Memory page's and Needs you's links) selects that folder, which shows everything stored for it whatever its scope kind (what the classic page shows for a folder). (A, 2026-10-25)
- **ASSUMED** order: proposed notes first (oldest first, a queue, amber-marked with a "Proposed" badge), then approved ones (pinned, then newest, as agents get them), and rejected ones only behind "Show rejected". The brief asks for proposed first; rejected ones are noise but the classic page keeps them. (A, 2026-10-25)
- **ASSUMED** a row shows the entry's title and its text in quotes (the prototype only quotes a text; real entries have both). (A, 2026-10-25)
- **ASSUMED** a proposal's Edit is "Edit first" (edit, then "Approve edited note", as in the prototype's Needs you card); an approved note's Edit saves the change. Both in a Dialog. (A, 2026-10-25)
- **ASSUMED** Delete hides the note at once and deletes it when the toast's Undo window (5.6 s) ends; Undo cancels it. The API cannot bring an entry back as it was (re-adding would lose its author and dates). Approve and Reject have no Undo: the API cannot undo a decision. (A, 2026-10-25)
- **ASSUMED** "Draft notes from this agent" exists in the API (`POST /api/memory/draft`), so the page offers "Draft notes from an agent…": pick one of this computer's open agents (never a conversation or another computer's, as the classic menu); the toast says its notes wait in Needs you. The per-agent ⋯ entry belongs to the agent pages. (A, 2026-10-25)

### Routines (`/routines`)
- **ASSUMED** a routine is any of three things: a Switchboard loop (D94; Pause / Resume / Run now / Edit / Cancel), a scheduled run (D8; the same), or a loop the AI engine runs itself in an agent or a terminal (D9 / D52), which is listed but watched only: every action is disabled with "Managed by the AI engine: Switchboard can only watch it." (A, 2026-10-25)
- **ASSUMED** a Switchboard loop's run history is what the API keeps: its last firing ("sent to its agent (run 5)") and its last skip with the reason, plus "5 runs so far (1 skipped)" in the summary. The API keeps no per-run list or pass/fail for loops (a gap against the prototype's "13:00 ✓ passed in 41 s", which scheduled runs do show). (A, 2026-10-25)
- **ASSUMED** "Run now" toasts "Sent it to “<agent>” now." (a loop) or "Started a run now." (a schedule), not the prototype's "Ran it now. Passed.": the result comes later and shows in the history. (A, 2026-10-25)
- **ASSUMED** Cancel's confirmation says what really happens: a Switchboard loop "stops running and is removed" (D94 removes it at once; it does not move to Closed), a scheduled run "is removed, with its run history" (`DELETE /api/schedules`), refused while a run is in progress. Loops that ended on their own (expired, max runs, agent closed) are under "Show ended". (A, 2026-10-25)
- **ASSUMED** a scheduled run belongs to the agent its last run started ("Last run: <agent>"): schedules start a new agent each run. A loop belongs to its agent ("Agent: <agent>"). (A, 2026-10-25)
- **ASSUMED** Edit is an in-page Dialog, because lane R's + New sheet only creates: a loop's name, what it does and how often (every N minutes / cron / once; `updateLoop`, expiry and run limit kept as they are); a schedule's prompt and cron (`POST /api/schedules` with its id, its other settings kept). "New routine" opens `openNew({ kind: 'routine' })`. (A, 2026-10-25)
- **ASSUMED** the status words: On schedule (idle), Paused, Running now (working), Last run failed (stopped), Waiting for you (needs), Ended (done). (A, 2026-10-25)
- **ASSUMED** schedules in plain words come from the classic `cronLabel` ("Weekdays at 08:00", "Every day at 02:00", "Every hour", "Monthly on the 1st at 09:00"); an expression it cannot describe reads "On schedule <expression>". (A, 2026-10-25)

### Both
- **ASSUMED** a computer tag shows only for paired computers (this one has none), as the shared agent rows do; an offline computer's items keep their tag "· offline" and every action is disabled with its reason. (A, 2026-10-25)
- **ASSUMED** no server change was needed: every read and action has an endpoint. (A, 2026-10-25)
- **ASSUMED** no What's-new tour for Notes and Routines: they are v2 pages of existing features, and lane X's "Welcome to Switchboard 2" tour introduces the v2 pages (as lane F assumed). (A, 2026-10-25)
