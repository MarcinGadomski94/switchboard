# Team (D100, experimental)

Team lets the developer run a set of role agents ("members") from one page instead of switching sessions. A member wraps an ordinary Switchboard session: it keeps its conversation, worktrees, todos and loops, and gains a role, a charter, a rhythm, a budget and gates. Generic (any organisation) and single-user. Decision: `docs/decisions.md` → D100; API: `docs/handoff/contracts/local-api.md` → *Team (D100)*; removing it: `docs/team-removal.md`.

This document covers the core (lane T1), access requests (lane T2, *Access requests* below) and the Team page (lane T3, *The Team page* below).

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

- the members' open **questions, permission requests and system items** (D102: a plan's "Ready to merge" item of a member's session, with **Merge** / **Open plan**; D79's review cards are gone) from the Inbox (this machine's and the paired machines'), **derived** from `listInbox` / the peers' Inbox caches and filtered to member sessions (nothing is stored twice; answer them through the Inbox routes);
- Team's own open **requests** from `team.db`: `gate` (a gated action), `budget` (over its daily share), and `access` (T2: a member asks for data access; the item carries `access`, see *Access requests*).

Item shape: `{ id, source: inbox | team, kind, memberId, memberName, label: "Tracker · question", title, detail, createdAt, sessionRef, inbox?, request? }`. Requests are decided with `POST /api/team/requests/{id}/approve | decline | dismiss`; an approval runs the request's action on the member's machine.

## Budgets

A member's budget is a share of the **daily usage** of its account (D63 / D98): the daily allowance is a seventh of the weekly window; the member's use today is the sum of the rises of the account's weekly % between consecutive usage readings that its session reported, since local midnight (`src/core/team-budget.ts`; cheap and coarse). Once a minute, a member over its share (`usedTodayPct > dailyPct`) has its Team loops paused (`pausedBy: budget`) and a `budget` request is raised; its running turn continues. Approving the request resumes it for the rest of the day; the next day a budget-paused member resumes by itself.

## Gates

"Needs you for": a list of action kinds (`outward-facing`, `merge-default-branch`, `external-write`, `delete-data`, `release`, `spend`). **`outward-facing` is always on** and cannot be removed. The gates are part of the charter text the agent gets. A gated action becomes a `gate` request (Needs you); approving runs it.

Wired in v1:

- **D102: the `review-merge` gate is gone** with review cards (it held a member's review-card Merge into a protected / default branch). `merge-default-branch` stays a charter rule the member's agent is told; where merges happen in Plans, agents never merge into a protected / default branch (D99's `target-forbidden`), and a plan item's Merge is the developer's own click. An approved request of the old `review-merge` kind (synced from an older machine) carries no action any more.
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
5. **Access (T2):** secrets are not moved. Every access entry loses its machines except the target, so it reads "needs setup on <target>", and the member's agent is told which accesses are missing (see *Access requests*).

## Devices (D73)

Phones may read the team (state, members, templates, suggestions, activity, Needs you, move runs), answer (approve / decline / dismiss requests; Inbox answers as before), pause / resume, give tasks (hand-offs and their state), adopt / create, return and remove a member (the session is never lost by any of them). Refused (`DEVICE_REFUSED`): renaming the team and editing a member's charter / rhythm / budget / gates (configuration), moving a member (a take-over, desktop only like D65) and the machines' sync exchange.

## Templates and suggestions

- `GET /api/team/templates`: Planner, Developer, Reviewer / QA, Release manager, On-call / Production monitoring, Delivery tracking, Marketing monitoring (read-only), each with a charter, rhythm (suggested loops and on hand-off), gates and model defaults (`src/core/team-templates.ts`).
- `GET /api/team/suggestions`: candidate members from this machine's open (not closed: done and idle sessions count too), non-member, non-hooked sessions, with evidence over the last 7 days from the database only: repos, Switchboard and CLI loops, events, active days, edit vs read tool calls, planning calls (TodoWrite, plan mode, Switchboard todos and hand-offs); a template, a reason, a `confidence` (`high` / `medium` / `low`), a score, and `charterDraft: null`. Cheap and deterministic, no model call (`classifySuggestion`). A session needs at least 50 events; then:
  - **The title is strong evidence** (`titleTemplate`, whole words, case-insensitive): monitor / tracking / KPI / metrics / dashboard / report → Delivery tracking, or On-call when the title is also about prod / errors / logs / incidents / alerts (incidents, alerts, outages, on-call alone suffice); release → Release manager; review / QA / test → Reviewer / QA; plan / planning / roadmap / breakdown → Planner; implement / feature / epic / ticket / Jira / bug / fix / maintenance → Developer (checked in that order).
  - **The behaviour** (`behaviourTemplate`): loops + < 20 % edits + under 3 edits per active day → On-call (≥ 10 file calls) or Delivery tracking (fewer). Loops alone do not make a monitor: an orchestrating session reads a lot but still edits every day. ≥ 5 planning calls and < 30 % edits → Planner; ≥ 50 % edits of ≥ 10 file calls → Developer; 20–50 % edits with ≥ 30 file calls and ≥ 20 edits → Developer; < 20 % edits of ≥ 20 file calls, no loops → Reviewer / QA.
  - **Combined, with a confidence**: the title and the behaviour agree (the behaviour matches the title's template, or backs it: loops for On-call / tracking, ≥ 20 edits for Developer, ≥ 5 planning calls for Planner, mostly reading for Reviewer) → the title's template, **high**; they disagree → the title wins at **medium** and the reason names both; only one of them → **medium**; a title with no loops and under 10 file calls → **low**. Neither → not suggested.

  There is no fallback template, and sessions with identical evidence get a template once (`dedupeSuggestions`). The Team page shows the server's confidence in its pill (suggestions from an older machine without one get a derived pill) and lists the others under "Not suggested · too little activity or no clear role to tell".
- **Charter drafts** are made by the Team page, on demand, when the review opens (`src/web/team/charter-draft.ts`): Switchboard has no model call for summaries (History summaries are the agent's own last message), so the draft is built deterministically from the template the heuristic picked and the evidence (the session's title and folder, its loops, its repos). Instant, free, never blocking the dialog, cached for the page's lifetime. The developer edits it in the Adopt form before anything is stored.

## The Team page (T3)

`/team`, reachable only while Team is on (`src/web/team/`; the hooks are listed in `docs/team-removal.md`). With Team off the page says so and links to the switch; the nav, the sidebar and every other page are exactly as without Team.

**Sidebar.** While Team is on the nav ends with **Team** (its badge: how many members need you) and **⚑ Team · N members** ("⚑ Team · <name> · N members" once renamed) sits above SESSIONS in the role colour (`--team-role-fg` `oklch(0.78 0.09 300)` on `--team-role-bg` `oklch(0.25 0.04 300)`) with the needs-you count. Both render nothing while Team is off (`SidebarTeam.tsx`), so the sidebar's DOM is the prototype's.

**Header.** "Team" ("Team · <name>" once renamed: a click on the title edits the name in place, `PUT /api/team`; empty = back to "Team"), "⇄ synced with <PC>" while a paired machine is online, "N members · N working · N need you", **＋ Member**.

**Suggestions banner** (`GET /api/team/suggestions`): "Switchboard found N sessions that look like team members…" with **Review** and **Later** (Later hides it until a suggestion appears that was not there; kept in this browser).

**Member cards** (a full-width grid at the top, `repeat(auto-fill, minmax(180px, 1fr))`, compact): a 3 px top border by status (working = `--status-run`, needs you = `--status-need`, idle = `--status-idle`, paused and offline dimmed, offline with ⌁), the status icon, the role, "from “<session title>”", the work line (the session's live activity, else what it waits for), the machine chip, the budget ("12% / 20% a day") and a "needs you" badge on the card's top-right corner. A card counts as needing you when its session waits or it has Needs-you items. Click selects; right click or ⋯ opens the menu.

**Below the cards, left (330 px).** *Needs you (N)* from `GET /api/team/needs-you`, answered in place: a one-question batch shows its options (a tap answers it) and **Reply…** (selects the member and focuses its chat); several questions use the shared question card; a permission request its Inbox actions; (D102) a plan's "Ready to merge" item **Merge** / **Open plan**; a gate or budget request **Approve** / **Decline**. *Activity*: time, the member's role, text.

**Below the cards, right: the member panel** (to the page's bottom, the chat filling it). Name, **⏸ Pause** / **▶ Resume**, **Open session**, ⋯; a subline (from session, the model and effort as the CLI names them, e.g. "Sonnet 5.5 · high", else "the session's model", machine, rhythm, needs-you-for). Tabs: **Chat** (default; the session view's own `ChatTab` over `useSessionData`, reloaded on the same `/hub` events, so the composer, queued messages, questions and the D88 per-session draft all work as in the session), **Access** (T2's `AccessTab`, see *The Access tab*; Set up… in Needs you opens it focused on that access), **Settings** (the member form saved with `PUT /api/team/members/{id}`, and *Runs on* with **Move to <PC>…**).

**⋯ menu**: Give a task… (a hand-off from the developer: brief, expected result), Edit charter… / Model & effort… / Budget… (open Settings at that part), Schedule… (the D94 loop dialog for the member's session), Pause / Resume, Move to <PC>… (one per other machine; offline ones disabled), then **↩ Return to sessions (back to “<folder>”)**: the toast "“X” is back in your session list (Work) as a plain session" and its row is highlighted in the sidebar for a moment (`data-team-returned`, DOM only).

**Move dialog**: `POST …/move/check` first (the take-over's blockers of both machines, nothing changes), **Move** only when it is clear, then the run is polled until done or failed.

**Empty state**: "No team members yet — Adopt one of your sessions, or start a new member from a template." with **Review suggestions** and **＋ Member**. **＋ Member**: Adopt one of your sessions (the review when there are suggestions, else a session picker) / From a template (the registry) / From scratch.

**Review dialog**: one card per suggestion: the role, a confidence pill (high green, medium amber, low grey; "new member" violet for a template no session or member covers yet, at most two, with **Create…**), "← “<title>”" (+ the machine chip for a paired machine's session), "Why: <reason> (<counts>)", "Draft charter: …", **Adopt…** / **Create…** / **Dismiss** (Undo; dismissed ones are kept in this browser). *Not suggested*: dismissed ones, ones with no activity in 7 days (Adopt anyway…), hooked sessions, sessions continuing in a terminal, a paired machine's sessions.

**Adopt / Create form**: role name, charter, rhythm (the session's live Switchboard loops, or a template's suggested loops, which are created as Switchboard loops of the new session only when kept), on hand-off, model / effort, budget, needs-you-for (Anything outward-facing always on, disabled), folder (create). The adopt form's note: "“<title>” leaves your session list and lives in Team from now on — history, worktrees, todos and loops included. ↩ Return to sessions on the member puts it back in “<folder>”, where it was. Switching Team off returns every member automatically." Toast after adopting: "“X” moved from your session list into Team as Tracker".

**Layouts (D74).** Desktop (≥ 1280 px): header, banner, the cards across the full width, then Needs you + Activity (330 px) | the member panel. Tablet: the same, the cards wrapping and the left column 260 px. Phone: one column: Needs you first, the cards (the members that need you on top), Activity; a card opens the panel full screen with **‹ Team**; dialogs are full-screen sheets.

**Live updates.** `useTeamData` reads `GET /api/team` and Needs you while Team is on and something shows them, again on `teamChanged`, `inboxChanged`, a member session's `sessionUpdated` (at most once a second) and a hub reconnect. The switch itself (`hidden.ts`) is read on load, on `teamChanged`, on reconnect and right after Settings saves it.

**What's new**: the `team` mini-tour (V1_17 = 1.17.0): the switch, adopting, Needs you and Return to sessions (`data-tour`: `experimental-team`, `team-add`, `team-needs-you`, `team-member-menu`); on an install with Team off its later steps show a card pointing to the switch.

**Tests**: `tests/web/team.test.ts` (the rules), `tests/e2e/team-page.spec.ts` (switch, review → adopt → chat → Return, template, Needs you, pause, phone), `tests/e2e/team-move.spec.ts` (two machines), `tests/e2e/visual/team.spec.ts` (desktop, tablet, phone; empty and populated; report `docs/visual/team.md`).

## Access requests (D100-T2)

"For each team member, a dynamic settings page where the agent can request either MCPs or API keys in order to fetch the data for analysis." Code: `src/core/team-access*.ts`, `src/server/team/access/`, `src/hook/sb-access-mcp.ts`, `src/web/team/access/`. Contract: `docs/handoff/contracts/local-api.md` → *Team access (D100-T2)*. Security: `docs/security.md` → *Team access (D100-T2)*.

### The agent asks

`request_access` is a Team tool of the built-in `switchboard` MCP server, so it exists **only in a member's session and only while Team is on** (registered with `team_handoff` & co. by `registerTeamToolsIfMember`; `POST /agent/v1/team/access` checks again). Its description tells the agent to ask only when it is actually blocked, to ask for the minimum (one service, the one host, the smallest read-only scope, only the fields it needs) and never to ask for credentials in chat. A request carries:

- `kind`: `mcp` (`source`: `catalog` + `catalogId`, `custom` + an optional `server` suggestion, or `shared` + `sharedServer` from the MCP page) or `api-key`;
- `service` and `host` (normalized: a URL is reduced to its host);
- `why` and the smallest `scope`;
- `fields`: what the developer fills, each `{ name, label, secret, help, helpUrl?, pattern? }`. `name` is the environment variable (`ACME_ANALYTICS_KEY`); names that change how a program runs (`PATH`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, proxies, CA bundles, `GIT_*`, `SSH_*`, `CLAUDE*`, `ANTHROPIC_*`, `SWITCHBOARD_*`, …) are refused;
- `api-key`: an optional `testUrl` **on the declared host** (https; http only on loopback) and `testHeader` (`{FIELD}` placeholders).

A catalog request runs **exactly the catalog's command with the catalog's fields** (the agent cannot change what it runs); a custom server's command is only a suggestion the developer confirms or edits at setup. The answer tells the agent to carry on without it meanwhile.

### Needs you

Each new request becomes a `requests` row of kind `access` with `action: { type: 'external', ref: 'access:<id>' }` (the core's seam), titled "Marketing monitoring asks for Acme Analytics (read-only, reports)" with the why, the **exact service and host** and the scope in its detail. `GET /api/team/needs-you` adds `access` (the entry) to the item. Actions: **Set up…** (opens the member's Access tab at that access; only typing the values sets it up), **Deny** (`decline`: denied, the agent is told not to ask again unless things change) and **Not now** (`dismiss`: deferred, the agent is told; it can still be set up later from the tab). A plain Approve marks it approved, waiting for setup.

Prompt-injection safety: never auto-approved; the card always shows service and host; a catalog request whose host differs from the entry's known host carries a **warning** (on the card and in its detail); the same open request is reused; **at most 5 new requests per member per hour** (429 `rate-limited`).

### The Access tab

`AccessTab` (`src/web/team/access/`, mounted by T3 in the member's panel; dev mount `/team-access-dev.html?member=<id>`) is built from the member's requests: one section per data source with **exactly the declared fields** (secret ones as password fields), the service, host, scope and what it gives (the variables, or the MCP server's name), the warning, the status ("Ready on Mac", "Set up on Mac only", "Needs setup on PC", Denied, Not now, Revoked, Expired), last used (and on which machine), used by (the member's session and its loops), **Set up** / **Set up here too** / **Replace**, **Test connection**, **Revoke**, an optional **expiry**, and the **audit trail** (asked, approved, denied, not now, set up, replaced, used, tested, revoked, expired). `AccessRequestActions` is the Needs-you card's part (service + host, warning, Set up… / Deny / Not now).

- **Test connection** (this machine, its values): an MCP server is started (stdio with `spawn(…, { shell: false })`, http with its headers) and its tools listed within 20 s, then stopped; an API key gets one `HEAD` (then `GET` on 405 / 501) to the declared test URL, only on the declared host, redirects not followed, 10 s. No test URL: nothing is sent. Anything that comes back is masked.
- **Revoke** removes this machine's values from its keychain, marks the access revoked everywhere (the other machines remove theirs when the record reaches them) and restarts the member without it.
- **Expiry**: past it the access is no longer given (the minute tick marks it expired and restarts the member); Replace or a new expiry gives it back.

### Where the values live

**The OS keychain only** (`src/server/team/access/secret-store.ts`, a pluggable `SecretStore`): service **`Switchboard Team`**, account `<member id>/<access id>/<FIELD>`.

- **macOS**: the login keychain through `/usr/bin/security`: stored with `add-generic-password -U … -X <hex>` written to `security -i`'s stdin (never on an argv), read with `find-generic-password -w`, removed with `delete-generic-password`.
- **Windows**: Credential Manager (`CredWrite` / `CredRead` / `CredDelete` of `advapi32` through PowerShell `Add-Type`; the script goes encoded on the argv, the value on stdin). The fallback named in the brief (DPAPI-protected storage under the data folder) is **documented, not built**: without PowerShell, setup is refused with the reason.
- **Linux**: the Secret Service through `secret-tool` (value on stdin). Without it, setup is refused ("install libsecret-tools"); the same file fallback is documented, not built.

`team.db` keeps only the references (`secretRefs`) and metadata; the settings, logs, API answers, events and the sync never hold a value. Tests use `MemorySecretStore`: under Vitest and in every test server (`SWITCHBOARD_TEST_SECRET_STORE=memory`) the OS keychain is never touched.

### Delivery to that member only

- **API keys** (and the values an http MCP server's headers reference) are **environment variables of the member's process**, added at its spawn (supervisor hook `teamAccessEnv`); no other session gets them.
- **MCP servers** join **that session's** MCP config at spawn (D68's launch gains `extraServers`, hook `withTeamAccessServers`): a stdio server is started through **`src/hook/sb-access-mcp.ts`**, which asks Switchboard (`GET /agent/v1/team/access/{id}/launch`, the session's agent token) for the command, arguments and values when it starts and runs the server with `shell: false`, so no value is in any config file. An http server is written with `${FIELD}` header references and the values in the CLI's environment (Claude Code only; Codex CLI and OpenCode get stdio servers only). Server names are `access-<service>-<id>`.
- After a setup (or Replace, Revoke, expiry), the member's charter lines change ("Access the developer set up for you (as of …): Acme Analytics (ACME_ANALYTICS_KEY)…", names only), so D91 restarts its idle process once with `--resume` (a running turn finishes first); when it restarted, the agent also gets a short service message naming the access. Its last use is recorded at each spawn (and each launch of its MCP server).
- **Masking**: every value given to a session is replaced by `•••• (ACME_ANALYTICS_KEY)` in each line of that session's output before the recorder stores or sends it (events, transcript rows, the hub, peers, notifications) and in the CLI's notices (supervisor hook `mask`). A value once given stays masked for that session until Switchboard restarts. The CLI's own transcript files (e.g. `~/.claude/projects/…`) are written by the CLI and are **not** masked.

### Paired machines and moves

Access records sync with the team (`snapshot.access`, last writer wins per record); **values never do**. Another machine shows "Set up on Mac only" with **Set up here too** (the values entered again, into that machine's keychain). After a member **move**, the access is "needs setup" on the target until it is set up there (readiness is "set up on the member's machine"; the core's move also trims the member's `access` summary), and the agent's charter lists it as needing setup. Revoking on any machine removes the values everywhere as the record arrives. Returning or removing a member revokes its accesses on its machine.

### Devices (D73) and peers (D48)

Phones read the tab (`device: true`: read-only, "Set this up on a computer") and may Deny / Not now (the request routes); **setup, test, revoke and expiry are refused** (`DEVICE_REFUSED`, and the routes refuse a device request themselves). The peer API carries the metadata reads only; every route that touches a value refuses a peer request.

## Not in v1

- A coordinator / team-lead agent (ASSUMED, `.loop/questions.md` → *D100*).
- Nothing else of the brief: access requests (T2) and the Team page (T3) are both in.
