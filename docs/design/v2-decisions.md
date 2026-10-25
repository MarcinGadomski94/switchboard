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

- **ASSUMED** `/settings` opens Usage & accounts on a desktop and tablet (the prototype's first section); on a phone it is the list of sections and each section drills down with a "‹ Settings" back link (D74's pattern). (R)
- **ASSUMED** the Advanced pages embed the classic sections inside a v2 card (`settings/ClassicFrame.tsx`): the classic colour tokens are re-pointed at the v2 ones there, so they follow light / dark; the classic modal and toast contexts are provided locally (the setup wizard and the update dialog open over the v2 page; a classic toast shows as a v2 toast; the classic palette never opens). (R)
- **ASSUMED** the Advanced list is the prototype's pages plus every remaining classic section, each `/settings/advanced/<classic key>`: `code-projects` (Solutions), `connections` (MCP), `clis` (AI engines + Model by task), `workspace` (Folders; `folders` resolves), `sessions` ("Sessions & separate copies"), `schedules`, `tools`, `github`, `ci`, `processes` ("Background apps"), `jira` (`experimental` resolves), `updates`, `tutorial` ("What's new tours"), `cleanup`, `setup` (Run setup again), `login` (Start at login), `claude` ("Claude Code service"), `notify` ("Notifications & prices"), and the every-option pages `accounts`, `machines`, `devices` (their simplified v2 sections are Usage, Computers and Phones). The prototype's "Privacy" page is not built (no classic section). (R)
- **ASSUMED** "Switch when an account reaches 90 / 95 / 98 / 100 %" is D63's thresholds: a choice sets both the 5-hour and the weekly threshold; 100 % turns the thresholds off (switch at the limit error). Two different stored thresholds show the lower one. (R)
- **ASSUMED** "When all are out" is D103's `outOfAllowance` (Use paid extra = `use-credits`, Pause new work = `pause`); "Switch back after it resets" is `afterReset: back-to-first` / `stay`; the card's switch is the rules' master `enabled`. No new server setting. (R)
- **ASSUMED** the account order is per engine (D63 orders accounts within a CLI), so the list is grouped by engine; an engine's own login ("Your own login") has no Sign in / out here (it is the CLI's own). Sign in reuses classic's sign-in panel (additively exported from `AccountsSection.tsx`). (R)
- **ASSUMED** "Pin an account to an agent" = switch the agent to that account (`POST /api/sessions/:id/account`) and pin it (`PUT …/profile-pin`); the card says the agent's side panel can do the same. Only this computer's open agents are listed. (R)
- **ASSUMED** shared accounts across computers (D98) have no switch: the card lists which accounts are on several computers. The shared layout is D71's per-computer switch. (R)
- **ASSUMED** per-kind notifications and quiet hours are set on the phone itself (they belong to the phone's push subscription, D73/D87): on the computer, Phones lists the paired phones (notifications on / off), pairs by QR, revokes after a confirm and switches phone access; on a paired phone, Settings › Phones shows classic's own device panel. (R)
- **ASSUMED** the default text density is per browser: `localStorage['switchboard.v2.density']` (`comfortable` / `compact`), also on `<html data-density>`; lane S reads it with `readDensity()` from `src/web/v2/settings/density.ts` as the View menu's default. (R)
- **ASSUMED** `/tools/:id` and `/share` embed the classic tool page and the classic share page in a v2 frame (their own navigations use classic addresses, which the v2 shell maps). (R)
- **ASSUMED** "Background apps" Stop all stops each app that is not marked Keep (`POST …/processes/:pid/stop`), per computer. (R)

### + New

- (new)

### ⌘K palette

- (palette)

### Lane-wide

- (lane)
