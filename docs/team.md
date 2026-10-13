# Team (D100, experimental)

Team lets the developer run a set of role agents ("members") from one page instead of switching sessions. A member wraps an ordinary Switchboard session: it keeps its conversation, worktrees, todos and loops, and gains a role, a charter, a rhythm, a budget and gates. Generic (any organisation) and single-user. Decision: `docs/decisions.md` → D100; API: `docs/handoff/contracts/local-api.md` → *Team (D100)*; removing it: `docs/team-removal.md`.

This document covers the core (lane T1) and the Team page (lane T3, *The Team page* below). Access requests (T2) build on it; their seams are named below.

## The switch

Settings → **Experimental** → **Team**, a row of the main `settings` table (`experimental.team`, default **off**; `PUT /api/settings`).

- **Off:** Team opens nothing, runs no timer and hides nothing. Only `GET /api/team/state` answers (the switch); every other Team route is 404 `team-off`. The agent routes refuse, so no session gets the Team MCP tools. The rest of Switchboard behaves exactly as without Team (the desktop visual oracle is unchanged; the only visible addition is the Experimental section in Settings).
- **On:** `<dataDir>/team.db` is opened (created on first use), the Team timers start (a one-minute tick and the 30-second sync), and member sessions leave the sidebar.
- **Off again:** the timers stop and `team.db` is closed (it stays on disk). Every member's session is back in the sessions list at its place; switching on again re-hides them. Member processes keep the charter they were started with until their next start (D91 shows them as running an older instruction and offers Reload).
- **Demo mode** never starts Team.

## Storage

All Team data lives in a separate SQLite file, `<dataDir>/team.db`, with its own migration list (`src/server/team/db.ts`, run by the main database's runner). **No migration in `switchboard.db`.** Tables: `teams`, `members`, `handoffs`, `requests` (each a JSON document per record with `clock`, `deleted`, `team_id`) and `activity` (the newest 500 per team). Records are read by the same readers that read a paired machine's records (`src/core/team-sync.ts`), so a row this build cannot read is skipped.

A missing file is created when Team is switched on. A file that cannot be opened or migrated (a broken `team.db`) leaves Team **unavailable**: `GET /api/team/state` reports `available: false` with the problem, **nothing is hidden**, and the other routes answer 503 `team-unavailable`. Hiding never loses a session: it only filters the sidebar list.

One team for now (`id: "team"`, default name **Team**, renamable); everything is keyed by team id so more teams can come later.

## Members

A member record (`TeamMemberRecord`, `src/core/team.ts`): id, role name, charter (owns / produces / never does), a charter draft for T3, template id, the machine id and that machine's session id, workplace (folders or none), provider / model / effort (D82's routing fields, as set up), rhythm, budget, gates, paused flag (with the loops Team paused and why), the CLI loops found at adoption, the original sidebar place, the access entries (T2 seam), created / updated. The status is derived, never stored: **offline** (its machine is not reachable or the session is gone) → **needs-you** (the session waits for the developer) → **paused** → **working** (a turn runs) → **idle**.

### Adopt an existing session

`POST /api/team/members { sessionId, name, charter?, templateId?, rhythm?, budget?, gates?, workplace? }`.

- Keeps the session's history, worktrees, todos and loops. Nothing of the session is changed.
- The charter reaches the agent through **D64's mechanism**: Team appends "You are now <role> in team <team>. Charter: … Ask the developer before: …" to the standing instruction of the member's process (`withTeamCharter`, read at every spawn), and asks for a **D91 reload**: an idle process restarts with `--resume` (no message), a running turn finishes first ("a mid-turn adoption applies from the next message"), a session without a process gets it at its next start. The restart also gives the session the Team MCP tools.
- Refused: a **hooked terminal session** (409 `hooked`: "Continue it in Switchboard first", D72), a session that continues in a terminal (409 `detached`), a closed session, a session already in the team (409 `already-member`), more than 30 members.
- CLI-run loops (`/loop`, CronCreate, ScheduleWakeup: the D52 / D93 cards) are **not** recreated: their labels are recorded in `cliLoops` and `cliLoopsUnmanaged` tells the UI to offer recreating them as Switchboard loops.
- A paired machine's session (`r~<machine>~<id>`) is adopted on that machine (forwarded).

### Create a new member

`POST /api/team/members { name, charter?, templateId?, …, session: <NewSession body> }` starts a new session in the chosen folder (`POST /api/sessions`' logic). The member is stored before the process starts, so the first spawn already carries the charter. A template fills the charter, gates and model when the body does not.

### Leaving the sidebar

The sidebar's SESSIONS list leaves member sessions out through **one filter** (`src/web/team/hidden.ts`, used once in `Sidebar.tsx`), fed by `GET /api/team/state` (`hiddenSessionIds`, this machine's ids and `r~…` ids of paired machines' members), read again on `teamChanged` and after the hub reconnects. The session's sidebar place (D54 / D71) is untouched, and the original place is also recorded at adoption. Search, the Inbox and notifications still find member sessions and label them with the role name (`InboxItem.teamRole` / `sourceTitle`, `SearchResult.teamRole` / `sessionTitle`; push titles read "Tracker needs you").

### Return to sessions

`POST /api/team/members/{id}/return`: the member is removed (a tombstone, so the removal syncs), the loops Team paused run again, the session is put back at its original folder and position if its place was lost meanwhile, the charter is withdrawn (D91 reload) and, when the process is running, the agent gets a short note ("You are no longer <role> in team <team> …"). `DELETE /api/team/members/{id}` does the same without the note (and drops a record whose session is gone).

### Pause and resume

`POST …/pause`: every active Switchboard loop (D94) of the member's session is paused and remembered; loops added while it is paused are paused by the next tick ("nothing new starts"); hand-offs still land as todos but the agent is not woken. The session itself is untouched (a running turn continues). `POST …/resume` resumes exactly the loops Team paused and sends the waiting hand-offs.

**Team loops** are the session's Switchboard loops; the rhythm names the ones that are the member's routine (`rhythm.loops`, by id, found again by prompt and schedule after a move) plus **on hand-off** (a new hand-off wakes the agent).

## Hand-offs

A written work item between members: from (a member or the developer), to, brief, expected result, state (`open` → `accepted` → `done`, or `declined`), links, the receiver's todo id, and `planRef`, the **seam for Plans (D99)** (null until Plans uses it).

- Created by the developer (`POST /api/team/handoffs`) or a member (`team_handoff`). The **receiver's machine** turns it into a todo (D68) in the receiver's session (title "Hand-off from <sender>: …", the brief and expected result in the description, a plan for an agent), so the existing todo machinery runs it. With rhythm "on hand-off" (and not paused) the agent also gets a service message naming the todo.
- The hand-off follows its todo: in progress → `accepted`, done → `done`. The developer can set the state (`PUT /api/team/handoffs/{id}`).

## The agent's tools

In the `switchboard` MCP server (`src/hook/sb-mcp.ts`), **only in member sessions and only while Team is on**: at start the helper asks `GET /agent/v1/team` (404 = not a member / Team off) and registers the tools only on 200; every call is checked again. Definitions: `src/core/team-tools.ts`.

- `team_handoff { to, brief, expected, links? }`: give another member a written work item.
- `team_members {}`: the members, their charters, status and machine, and your open hand-offs.
- `team_report { text }`: one short status line to the activity feed. Deliverables stay `artifact_save`.

There is no free-form agent-to-agent chat.

## Activity

Hand-offs (created, finished), adopt / create / return, pauses and resumes (also by budget), reports, approvals, moves ("Moved Tracker from Mac to Windows PC"), settings changes. Stored in `team.db`, the newest 500 per team; `GET /api/team` carries the newest 100, `GET /api/team/activity?before=&limit=` pages.

## Needs you

`GET /api/team/needs-you` aggregates, newest first:

- the members' open **questions, permission requests and review cards** from the Inbox (this machine's and the paired machines'), **derived** from `listInbox` / the peers' Inbox caches and filtered to member sessions (nothing is stored twice; answer them through the Inbox routes);
- Team's own open **requests** from `team.db`: `gate` (a gated action), `budget` (over its daily share), and `access` (T2, not built yet).

Item shape: `{ id, source: inbox | team, kind, memberId, memberName, label: "Tracker · question", title, detail, createdAt, sessionRef, inbox?, request? }`. Requests are decided with `POST /api/team/requests/{id}/approve | decline | dismiss`; an approval runs the request's action on the member's machine.

## Budgets

A member's budget is a share of the **daily usage** of its account (D63 / D98): the daily allowance is a seventh of the weekly window; the member's use today is the sum of the rises of the account's weekly % between consecutive usage readings that its session reported, since local midnight (`src/core/team-budget.ts`; cheap and coarse). Once a minute, a member over its share (`usedTodayPct > dailyPct`) has its Team loops paused (`pausedBy: budget`) and a `budget` request is raised; its running turn continues. Approving the request resumes it for the rest of the day; the next day a budget-paused member resumes by itself.

## Gates

"Needs you for": a list of action kinds (`outward-facing`, `merge-default-branch`, `external-write`, `delete-data`, `release`, `spend`). **`outward-facing` is always on** and cannot be removed. The gates are part of the charter text the agent gets. A gated action becomes a `gate` request (Needs you); approving runs it.

Wired in v1:

- **A member's review-card Merge into a protected / default branch** (`main`, `master`, `trunk`, `develop`, `dev`, `release…`) with `merge-default-branch` on: the Merge (from any screen) answers 409 with "<role> needs your approval to merge into main" and raises the request; **Approve** runs the merge (`POST /api/reviews/{id}/merge` with the approved request's id). Open PR, Commit and the rest are not held.
- **Jira / external writes**: the seam is `TeamService.requestGate({ kind: 'gate', gate: 'external-write', action: { type: 'external', ref } })`; T2's access mechanism calls it before a write and proceeds on approval.

Other outward-facing actions are not intercepted technically in v1: the charter tells the agent to ask, and the CLI's own permission prompts still apply.

## Sync between paired machines

Like D48 / D71 / D98: `POST /api/team/sync` (on `PEER_API_ALLOW`) exchanges `{ v, machine, snapshot }` both ways every 30 s, when a machine comes online and 300 ms after a local change. The team (name), members (charter, rhythm, budget, gates, which machine), hand-offs and requests are **last writer wins per record** by hybrid clock (`core/hlc.ts`); removals travel as tombstones; the activity feed is a union by id, capped. **Secrets are never part of it** (T2's access entries carry names and machine ids only).

- Each member **runs on the machine whose session it wraps**; the other machine shows it (session `r~<machine>~<id>`, hidden from its sidebar too) and can message it (the session routes, through the peer proxy), pause / resume, return, remove, edit, approve its requests and move it: those calls are forwarded to the member's machine over the peer API. A request that came in through the peer API is never forwarded again (409 `not-here`).
- A machine that is offline shows its members as **offline** (the last known records stay); actions on them answer 502 `peer-unreachable`.
- **Older peers** (no Team: 403 on the exchange) and machines with Team off (404) are simply not synced; nothing breaks.

## Moving a member to another machine

Built on the **D65 take-over**; no new transfer mechanism.

1. `POST /api/team/members/{id}/move/check { targetMachineId }` runs the take-over's checks on both machines (`TakeoverRunner.preview`) plus Team's: **refused while a turn is running**. Nothing changes; the blockers are listed.
2. `POST /api/team/members/{id}/move { targetMachineId }` → 202 `TeamMoveRun`; poll `GET /api/team/moves/{runId}`. It runs on the member's machine (forwarded from the other one; the run id is then `<machine>~<id>`) and refuses with 409 `blocked` and the blockers.
3. The take-over moves the session with its repos, conversation, queued messages, todos and loops (re-created on the target, ended on the source: no double firing).
4. On success the member's machine id and session id change; charter, rhythm (loop ids remapped by prompt and schedule), budget, gates, pause, hand-offs and activity are kept. The activity says "Moved <role> from <source> to <target>".
5. **Access (T2 seam):** secrets are not moved. Every access entry loses its machines except the target, so it reads "needs setup on <target>", and the member's agent is told which accesses are missing (none exist until T2).

## Devices (D73)

Phones may read the team (state, members, templates, suggestions, activity, Needs you, move runs), answer (approve / decline / dismiss requests; Inbox answers as before), pause / resume, give tasks (hand-offs and their state), adopt / create, return and remove a member (the session is never lost by any of them). Refused (`DEVICE_REFUSED`): renaming the team and editing a member's charter / rhythm / budget / gates (configuration), moving a member (a take-over, desktop only like D65) and the machines' sync exchange.

## Templates and suggestions

- `GET /api/team/templates`: Planner, Developer, Reviewer / QA, Release manager, On-call / Production monitoring, Delivery tracking, Marketing monitoring (read-only), each with a charter, rhythm (suggested loops and on hand-off), gates and model defaults (`src/core/team-templates.ts`).
- `GET /api/team/suggestions`: candidate members from this machine's open, non-member, non-hooked sessions, with evidence over the last 7 days from the database only: repos, Switchboard and CLI loops, events, edit vs read tool calls; a heuristic template and reason, a score, and `charterDraft: null`.
- **Charter drafts** are made by the Team page, on demand, when the review opens (`src/web/team/charter-draft.ts`): Switchboard has no model call for summaries (History and review-card summaries are the agent's own last message), so the draft is built deterministically from the template the heuristic picked and the evidence (the session's title and folder, its loops, its repos). Instant, free, never blocking the dialog, cached for the page's lifetime. The developer edits it in the Adopt form before anything is stored.

## The Team page (T3)

`/team`, reachable only while Team is on (`src/web/team/`; the hooks are listed in `docs/team-removal.md`). With Team off the page says so and links to the switch; the nav, the sidebar and every other page are exactly as without Team.

**Sidebar.** While Team is on the nav ends with **Team** (its badge: how many members need you) and **⚑ Team · <name> · N members** sits above SESSIONS in the role colour (`--team-role-fg` `oklch(0.78 0.09 300)` on `--team-role-bg` `oklch(0.25 0.04 300)`) with the needs-you count. Both render nothing while Team is off (`SidebarTeam.tsx`), so the sidebar's DOM is the prototype's.

**Header.** "Team · <name>", "⇄ synced with <PC>" while a paired machine is online, "N members · N working · N need you", **＋ Member**.

**Suggestions banner** (`GET /api/team/suggestions`): "Switchboard found N sessions that look like team members…" with **Review** and **Later** (Later hides it until a suggestion appears that was not there; kept in this browser).

**Member cards**: a 3 px top border by status (working = `--status-run`, needs you = `--status-need`, idle = `--status-idle`, paused and offline dimmed, offline with ⌁), the status icon, the role, "from “<session title>”", the work line (the session's live activity, else what it waits for), the machine chip, the budget ("12% / 20% a day") and a "needs you" badge. A card counts as needing you when its session waits or it has Needs-you items. Click selects; right click or ⋯ opens the menu.

**Left column.** *Needs you (N)* from `GET /api/team/needs-you`, answered in place: a one-question batch shows its options (a tap answers it) and **Reply…** (selects the member and focuses its chat); several questions use the shared question card; a permission request its Inbox actions; a review card **Merge** / **Send back** (a comment) / **Open diff**; a gate or budget request **Approve** / **Decline**. *Activity*: time, the member's role, text.

**Right column: the member panel.** Name, **⏸ Pause** / **▶ Resume**, **Open session**, ⋯; a subline (from session, model, machine, rhythm, needs-you-for). Tabs: **Chat** (default; the session view's own `ChatTab` over `useSessionData`, reloaded on the same `/hub` events, so the composer, queued messages, questions and the D88 per-session draft all work as in the session), **Access** (a marked slot: lane T2 wires its tab at merge), **Settings** (the member form saved with `PUT /api/team/members/{id}`, and *Runs on* with **Move to <PC>…**).

**⋯ menu**: Give a task… (a hand-off from the developer: brief, expected result), Edit charter… / Model & effort… / Budget… (open Settings at that part), Schedule… (the D94 loop dialog for the member's session), Pause / Resume, Move to <PC>… (one per other machine; offline ones disabled), then **↩ Return to sessions (back to “<folder>”)**: the toast "“X” is back in your session list (Work) as a plain session" and its row is highlighted in the sidebar for a moment (`data-team-returned`, DOM only).

**Move dialog**: `POST …/move/check` first (the take-over's blockers of both machines, nothing changes), **Move** only when it is clear, then the run is polled until done or failed.

**Empty state**: "No team members yet — Adopt one of your sessions, or start a new member from a template." with **Review suggestions** and **＋ Member**. **＋ Member**: Adopt one of your sessions (the review when there are suggestions, else a session picker) / From a template (the registry) / From scratch.

**Review dialog**: one card per suggestion: the role, a confidence pill (high green, medium amber, low grey; "new member" violet for a template no session or member covers yet, at most two, with **Create…**), "← “<title>”" (+ the machine chip for a paired machine's session), "Why: <reason> (<counts>)", "Draft charter: …", **Adopt…** / **Create…** / **Dismiss** (Undo; dismissed ones are kept in this browser). *Not suggested*: dismissed ones, ones with no activity in 7 days (Adopt anyway…), hooked sessions, sessions continuing in a terminal, a paired machine's sessions.

**Adopt / Create form**: role name, charter, rhythm (the session's live Switchboard loops, or a template's suggested loops, which are created as Switchboard loops of the new session only when kept), on hand-off, model / effort, budget, needs-you-for (Anything outward-facing always on, disabled), folder (create). The adopt form's note: "“<title>” leaves your session list and lives in Team from now on — history, worktrees, todos and loops included. ↩ Return to sessions on the member puts it back in “<folder>”, where it was. Switching Team off returns every member automatically." Toast after adopting: "“X” moved from your session list into Team as Tracker".

**Layouts (D74).** Desktop (≥ 1280 px): three columns (Needs you + Activity 300 px | cards | panel 380–460 px). Tablet: two columns (cards, Needs you, Activity | panel). Phone: one column: Needs you first, the cards (the members that need you on top), Activity; a card opens the panel full screen with **‹ Team**; dialogs are full-screen sheets.

**Live updates.** `useTeamData` reads `GET /api/team` and Needs you while Team is on and something shows them, again on `teamChanged`, `inboxChanged`, a member session's `sessionUpdated` (at most once a second) and a hub reconnect. The switch itself (`hidden.ts`) is read on load, on `teamChanged`, on reconnect and right after Settings saves it.

**What's new**: the `team` mini-tour (V1_18 = 1.18.0): the switch, adopting, Needs you and Return to sessions (`data-tour`: `experimental-team`, `team-add`, `team-needs-you`, `team-member-menu`); on an install with Team off its later steps show a card pointing to the switch.

**Tests**: `tests/web/team.test.ts` (the rules), `tests/e2e/team-page.spec.ts` (switch, review → adopt → chat → Return, template, Needs you, pause, phone), `tests/e2e/team-move.spec.ts` (two machines), `tests/e2e/visual/team.spec.ts` (desktop, tablet, phone; empty and populated; report `docs/visual/team.md`).

## Not in v1

- A coordinator / team-lead agent (ASSUMED, `.loop/questions.md` → *D100*).
- Access requests (T2): the member panel's Access tab is a marked slot until T2 is merged.
