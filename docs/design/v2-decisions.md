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

## Lane S · The agent view (2026-10-25)

### Chat
- **ASSUMED** the chat is built from the classic chat model (`chatItems`), so it shows exactly what the classic chat shows; v2 only regroups it: agent text = a reply, every run of tool steps between two texts = one activity row, Agent / Task calls = one helpers thread. (S)
- **ASSUMED** "reply N" counts reply groups (a turn's texts within 10 minutes of each other share the first one's number and line); a pause of more than 45 minutes draws a time divider ("2 hours later · 16:42", or the day). (S)
- **ASSUMED** an activity row's words come from its step labels (`Read · a.ts` → "Read a.ts"; several: "Read 2 files · edited 1 file · ran 2 commands"; a test command reads "Ran tests"); its time is the first step's start to the last step's end, shown from 1 s. (S)
- **ASSUMED** a waiting question batch shows as the shared `AnswerSlot` at its place in the chat; the agent's other waiting items (permissions, asks, stopped…) show as cards at the chat's end. Once answered here the compact line stays (the store's answered map); an answer from elsewhere shows the server's record ("You answered …"). (S)
- **ASSUMED** results (artifacts) show as file attachments after the last message older than their first save; one opens the Results tab with the result in a drawer (`/agents/:id/results/:resultId`). Lane R's global result drawer was not there yet, so the agent view has its own (versions, rendered / source, the classic viewer's rules). (S)
- **ASSUMED** the reply ⋯ menu's **Save as result** saves the reply's Markdown (kind markdown) and a code block's own button saves the block (kind code); **Add to tasks** captures the selection (else the reply's first sentence) as a todo (`POST …/todos/capture`, `from: selection`); **Undo from here** is the D80 revert to before the turn that produced the reply (disabled with the reason when it has no save point or a turn runs). (S)
- **ASSUMED** the developer's message bubbles keep the classic Markdown renderer; "the task" origin is not shown (it is the first message). (S)

### Composer
- **ASSUMED** both Enter and ⌘↩ (Ctrl+Enter) send, Shift+Enter is a new line (D26 kept; the prototype shows ⌘↩). (S)
- **ASSUMED** messages the agent has not taken up move from the chat into the dock: queued (`turn` / `resume`, and D114's on-their-way while a turn runs) and paused (`credits`, D103). A queued message is already in the CLI's input, so it cannot be edited or removed alone: **Send now** stops the reply and sends what the Stop took back at once; **Edit** stops the reply and puts every queued message back into the box (D50's rule); **Remove** is disabled with the reason. (S)
- **ASSUMED** "Send with paid extra" on a paused message has no per-message route (D103 holds messages only by the setting): the button goes to Settings › Usage & accounts and its tooltip says so. Logged as a gap. (S)
- **ASSUMED** the tasks strip above the box shows this agent's todos folded to one line ("Tasks · 1 of 3 done · <the one in progress>"), ticked from the list; the full todo cards stay in the classic UI. The working-memory strip shows from 50 %; past Settings → Sessions' threshold (between replies) it is the amber "Continue with a clean slate" offer (D83, Not now snoozes like classic). (S)

### Header, panel, menus
- **ASSUMED** Smart = an Opus model (else the CLI's default), Fast = a Sonnet model (else Haiku); the exact model and effort are under Advanced, the effort as **Thinking depth** (Light / Normal / Deep…). (S)
- **ASSUMED** the folder in the header is the agent's sidebar folder path (D54/D58); a click is not wired (lane A owns the folder tree's selection). (S)
- **ASSUMED** the side panel's groups are remembered per browser (`switchboard.v2.agentPanelGroups`), and the panel's hidden state, the density and Full width in `switchboard.v2.agentView`. On a tablet the panel is a drawer and on a phone a bottom sheet (opened by Details; not remembered). (S)
- **ASSUMED** Background apps poll every 15 s like the classic section (there is no hub event for them). (S)
- **ASSUMED** **Add a routine** creates the agent's own Switchboard loop (D94, `POST …/loops`) from a small dialog (what to do, how often); **Make a teammate** adds it to a chosen crew with an empty job description and asks its agent to draft one (D105 `askCharter`); **Return to agents** uses the crew roster to find the member. **Draft notes** is Project memory's `draft` (D107). **Open in the Claude app** turns Remote Control on if needed and opens its claude.ai link. **Move to computer** reuses the classic take-over dialog (D65), which still has the classic look. (S)
- **ASSUMED** a helper's chat replaces the agent header with its own (back to the main chat, Esc too); helpers take no messages, so it has the live line and a note instead of a composer. (S)

### Shared / shell
- **ASSUMED** the shell renders `PeekHost` once (one added line in `shell/Shell.tsx`, next to the + New sheet), which also hosts the agent view's Undo-from-here and Save-as-result dialogs, so the full view and a peek over it never show two. (S)
- **ASSUMED** the classic composer's send machinery is reused, not copied: `views/session/ChatTab.tsx` now exports `deliver`, `sendsSettled`, `composers`, `refusedNotes` and `COMPOSER_INSERT_EVENT` (no behaviour change), so a refused send finds whichever composer is open. (S)
- **ASSUMED** `window.__sbV2Peek(id)` opens the peek (the E2E spec uses it; Home and Agents call `openPeek`). (S)
