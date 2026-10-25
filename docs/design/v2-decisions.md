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

## Lane R · Results, Search, Insights, Settings, + New, ⌘K (2026-10-25)

### Results

- (results)

### Search

- (search)

### Insights

- (insights)

### Settings

- (settings)

### + New

- **ASSUMED** the Agent kind posts the classic bodies: a **Simple** start (the message alone, D56) unless Advanced › "Answer the workspace questions now" is on (a workspace folder only), then the **Full** start (work type / mode / phase / coordination, code projects, branch). The prototype's basic form has no router answers, so Simple is the honest default. (R, 2026-10-25)
- **ASSUMED** Speed and Thinking depth map onto D42's model / effort: Smart = the CLI's default model, Fast = the first offered model named sonnet / haiku / mini / fast / flash (else `sonnet` for Claude Code, else the default); Normal = the default effort, Deep = `high`. Advanced › Model picks an exact model instead. (R, 2026-10-25)
- **ASSUMED** "Put it in" (a sidebar folder) places only an agent started on this computer (`POST /api/sidebar/place`); on a paired computer the select is disabled (the sidebar layout is per install and the peer's new id is not known here). (R, 2026-10-25)
- **ASSUMED** a Conversation always starts on this computer (`POST /api/chats` has no machine). (R, 2026-10-25)
- **ASSUMED** a Task lives in one agent's list (todos belong to a session): the sheet asks **Whose list?**, defaulting to the agent on screen, else the most recently active open agent. "Start here / Run in its own agent" and "Import from Jira or GitHub" stay on the Tasks page (lane A). (R, 2026-10-25)
- **ASSUMED** a Routine is a D94 loop of an agent (`POST /api/sessions/{id}/loops`): the agent, a plain-words preset (every 30 min, every hour, every morning 08:00, weekdays 08:00, Friday 15:00) or a typed cron; it runs on the agent's computer, which the sheet names instead of offering a computer picker. (R, 2026-10-25)
- **ASSUMED** a Project needs an agent whose task list it runs (`POST /api/plans` requires `sourceSessionId`): the sheet asks **Which agent plans it?** and adds one item per written step (`(after <step>)` adds the dependency), with no target branch (a plan without a merge step); the merge mode is chosen at Start on the project page. **Import steps from a Jira epic** opens the classic Import dialog with no session (D112: a new agent in a folder owns the plan) — embedding it rather than rebuilding it. (R, 2026-10-25)
- **ASSUMED** a new Teammate gets its own new agent in the chosen project folder (as the classic dialog: no worktree, no router answers); "Make an existing agent a teammate instead" adopts and asks its agent for a charter (D105). The job description is the charter's owns / produces / never-does; Rhythm stays on the crew page. (R, 2026-10-25)
- **ASSUMED** a Crew is `POST /api/team/teams { name }`; the prototype's "What does this crew do?" is not asked because a team stores no description. (R, 2026-10-25)
- **ASSUMED** **Save as draft** writes this computer's `new-session` machine draft (D88) for every kind: the classic form's fields, plus `newKind` (a new additive key the draft check now keeps) and, for the other kinds, their title in `name` and their text in `task`. The sheet restores it when it opens plain (no text or prefill) on + New's default kind or on the draft's own kind; a successful create clears it; **Clear draft** forgets it. The classic New-session dialog keeps reading the same draft (it ignores `newKind`). (R, 2026-10-25)
- **ASSUMED** on a phone (≤ 767 px) the sheet fills the screen and the kinds scroll sideways. (R, 2026-10-25)

### ⌘K palette

- **ASSUMED** groups and order: Quick capture, Messages, Agents & projects, Results, Pages, Actions, then the last row "Search everything for “…”" (⌘⇧F). Each group sits where its best row ranks, so ↩ on a fresh query opens the best match. Opened empty it lists the four most recent agents and the actions. (R, 2026-10-25)
- **ASSUMED** ranking (`palette-model.ts`): every query word must match the label or its hidden keywords; the label starting with the query beats every word starting a label word beats a match inside; then the most recent; at most 12 rows. (R, 2026-10-25)
- **ASSUMED** Messages come from D97 search (`GET /api/search?scope=conversations`, 5 hits, after two characters) and open `/agents/:id/events/:eventId` (a helper's `/agents/:id/helpers/:helperId/events/:eventId`). Results open `/results?open=<artifactId>&agent=<sessionId>[&computer=<machineId>]` (the Results page's own deep link). (R, 2026-10-25)
- **ASSUMED** "task …" quick capture (D81 `captureTodo`, `from: 'palette'`) goes to the agent on screen, else the most recently active open agent (conversations and closed agents never); without one the row says to start an agent first. (R, 2026-10-25)
- **ASSUMED** "Replay a What’s new tour" opens Settings › Advanced › What’s new tours (`/settings/advanced/tutorial`): the tour host is mounted only in the classic shell, so v2 replays from that page. (R, 2026-10-25)
- **ASSUMED** the palette also switches light / dark / automatic (v2's scheme) besides the classic theme, and lists every Settings section and Advanced page (the classic section keys, Code projects and Connections). (R, 2026-10-25)

### Lane-wide

- (lane)
