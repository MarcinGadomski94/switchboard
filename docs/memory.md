# Project memory (D107, experimental)

Durable, reusable facts and conventions about a project (build and test commands, gotchas, decisions and their reasons, where things live), kept **per folder** and given to every session that works there. Agents only **propose** entries; the developer **approves** them before any session ever sees them. Decision D107 (`docs/decisions.md`); contract → *Project memory (D107)* in `docs/handoff/contracts/local-api.md`; removal: `docs/memory-removal.md`.

## Always on (D132)

Project memory was experimental behind Settings → Experimental → **Project memory** (`experimental.memory`, off by default) until 2.0; it graduated to general release (D132, `docs/memory-removal.md`) and has **no switch** any more.

- **At start** `<dataDir>/memory.db` is opened (created on first use); the `switchboard` MCP server registers the memory tools for sessions with a folder.
- **No approved entries:** no session gets a memory block (`sessionInstruction` is exactly as without the feature); proposals are never injected.
- **Upgraded from 1.x with the switch off:** the stored `experimental.memory` row is deleted; approved entries kept from a time it was on reach new and resumed sessions, and open sessions of those folders show D91's "older instruction" state (below).
- **A broken `memory.db`:** every memory route but the state answers 503 `memory-unavailable` and nothing is injected.
- Demo mode never starts Project memory.

## Folder

An entry belongs to a **folder** (`MemoryEntry.scope`): the session's canonical root (`SessionRecord.root`): the saved workspace or repo folder (D14 / D18). A worktree session's folder is its repo. A session without a root uses its `cwd`. **Chats (D106)** have no project folder: they get neither the tools nor a block.

## Scopes

D107 follow-up 2026-10-15 (`docs/decisions.md`). Team members (D100) each maintain one feature but share the workspace folder, so folder-wide memory alone would mix every member's knowledge into every prompt. Every entry therefore also says **who it is for** (`scopeKind`, `scopeKey`, `scopeLabel`):

| Scope | Reaches | Key | Chip |
|---|---|---|---|
| `workspace` | every session of the entry's folder (what every entry was before: existing entries became `workspace`) | none | Workspace |
| `repo` | every session of this machine that works in that repository, whatever its folder | the repository's normalized remote key (`normalizeRemoteUrl` of `origin`, else of its only remote, `src/core/takeover.ts`), else its main checkout's path | ⎇ the repository's name |
| `member` | only that Team member's session, whatever its folder | the member id | ⚑ the role name |

- **A session's repositories** are the shared repo set (`src/server/worktrees/session-repos.ts`: its worktrees, the declared solutions it watches, the working trees of the files it edited, its cwd's), each named through `git rev-parse --git-common-dir`, so a **linked worktree is its repository** (`src/server/memory/reach.ts`; cached a minute per working tree).
- **A session's member** comes from Team's hooks (`teamMemberOf`, through `src/server/memory/team-link.ts`); with Team off nobody is a member and member entries are not injected (they stay stored).
- **A member moving to another machine** (D65 / D110) takes its member entries along: once the move is done the old machine sends them (every state, as they are) to the new one (`POST /api/memory/import` through the peer API), where they belong to the member's session's folder, and deletes them. If the new machine cannot take them (offline, Project memory off there, an older build) they stay on the old one as a **pending copy** (below). Repo and workspace entries stay per machine.
- **A pending copy** (D107 follow-up 2026-10-16, ruling on scopes-q2): the old machine keeps a record per member in `memory.db` (`memory_pending_copies`: target machine and session, attempts, first failure, next try, last error, its Inbox item) and retries:
  - with backoff: 1 minute, 5 minutes, 30 minutes, then hourly (`MEMORY_COPY_BACKOFF_MS`; one timer, only while Project memory is on; it survives a restart);
  - at once when that machine comes **online** (the peer link's `machineState`) and when its Project memory **changes** there, e.g. is switched on (its `memoryChanged`, now carried by the peer stream and never republished locally; an older build does not send it, so the backoff covers it);
  - before each try: a member that runs on this machine again needs no copy (dropped); one that moved on is copied to where it runs now.
  - After **3 failed copies or an hour** since the first, the Inbox gets "**<member> is missing its memory on <PC>**" (kind `memory-copy`, label *Memory*) with **Retry** (copies now; refused with the reason while it still fails, the item stays) and **Keep on this PC** (stops retrying; the entries stay here and reach the member again if it moves back). Later failures update the same item.
  - On success the old copies are deleted, the record goes and the item is resolved.
- `memory_list`, the block and the session panel's count all use the same rule (`memoryVisible` / `MemoryDb.list({ visibleTo })`).

## The review gate

Nothing an agent writes reaches any session's system prompt / instruction unreviewed:

1. `memory_propose` (and `POST /agent/v1/memory`) can only create rows with `status = 'proposed'`; so can D135's `memory_propose_edit` / `memory_propose_retract` (`POST /agent/v1/memory/edit|retract`), whose rows can never become approved at all (a CHECK in `memory.db`). There is no agent route that approves, edits or deletes.
2. The block (`MemoryService.blockFor`) and `memory_list` read `status = 'approved'` rows only (the SQL filter, and `memoryBlockParts` drops anything else again).
3. Only the developer's routes (the `sb_token` cookie; phones with their device credential; a paired machine through its peer token) can approve. An approval writes the **approved title and text into the same row** the block reads; when the developer edited them (Edit… then Approve, or `approve` with fields), the edit is what is stored and injected, and the agent's own words are kept only as `proposedTitle` / `proposedText` (a record, never read for the block).
4. Rejected entries are kept (they block a near-identical re-proposal for 30 days) and never injected; deleting removes the row.

### Approval presence (q4)

Ruling 2026-10-14 (q4) asked for a confirmation an agent cannot give: an agent running with the developer's OS rights, able to read the UI token from the data folder and call `/api` or load the page, must not be able to approve its own proposal. **Nothing was built for it, because no option is agent-proof under that threat model:**

- **The data is the agent's to write.** `memory.db` is a file of the developer's user. An agent that can read `sb_token` from the data folder can just as well run `UPDATE memory_entries SET status = 'approved'` on it (the `sqlite3` CLI or `node:sqlite`); the next spawn injects the row. Any check on the approve *route* (a passkey, a phone, a dialog) is skipped, not defeated.
- **Signing the approved rows does not close it.** Storing a WebAuthn assertion over each approved entry's text and verifying it at every spawn moves the question to the trust anchor (the registered public key and credential id): it lives in a file or keychain item of the same user, so the agent replaces it with its own key and signs with a virtual authenticator (Chrome DevTools Protocol). The first registration is trust-on-first-use with the same weakness. Attestation that proves a real platform authenticator (Touch ID / Windows Hello) is not given by browsers for these passkeys in a usable form (`none` attestation), and its verification root would again sit in user-writable storage.
- **(a) WebAuthn / passkey:** technically feasible for a loopback app (an IP is not a valid RP ID, `localhost` is: browsers treat `http://localhost` as a secure context and accept `localhost` as the RP ID; Switchboard's Host / Origin checks already accept `localhost:<port>`, but D34 redirects page loads to `127.0.0.1`, so the ceremony would need its own `localhost` page or the D34 redirect reversed). It needs human presence for the ceremony itself, but for the reasons above it only guards the route, not the data.
- **(b) approval only from a paired phone:** the device credentials are rows in `switchboard.db` (hashes), and a pairing code is a desktop route; the agent can pair a "device" of its own through `/api` with the token, or write the row.
- **(c) an OS confirmation dialog** (e.g. `osascript display dialog`): shown by the server, answered by whoever controls the session; an agent with the user's rights can dismiss or click it through the same scripting (System Events) where accessibility is granted, and again it guards only the route.
- **Beyond Switchboard:** the same agent can write `CLAUDE.md` / `AGENTS.md` into the repo or the CLI's own configuration, which every future session loads without Switchboard. Project memory cannot be safer than those channels.

**What the gate does protect against:** an agent acting through its intended interface (the `switchboard` MCP tools and its agent token, which reaches only `/agent/v1`): it can only propose; nothing it proposes reaches any session until the developer approves it in the UI (desktop, a paired phone, or a paired machine). **What it does not:** an agent that escapes that interface with the developer's OS rights (reads the UI token, writes the data folder). Containing that needs a boundary the OS enforces: the CLIs' own sandboxes / permission modes, or Switchboard's data under another OS user or on another machine; recorded as an open question (`.loop/questions.md` → *D107* → memory-q4b).

Tests: `tests/server/memory/changes.test.ts` (D135: ids in `memory_list`, edit / retract proposals, approve / reject, refusals, the CHECK, migration 4 on a v3 database, a moved member's pending edit, the tools and routes over the app), `tests/e2e/memory-changes.spec.ts`, `tests/e2e/v2-notes-changes.spec.ts`, `tests/server/memory/scopes.test.ts` (scopes, budgets on the real service, draft asks, the migration, a member's move), `tests/server/memory/move-retry.test.ts` (pending copies: offline then online, memory off then on, backoff, the item's Retry / Keep, migration 3), `tests/server/memory/injection.test.ts` (fake-claude's argv, fake-codex's `developerInstructions`, fake-opencode's `system`), `tests/server/memory/switch.test.ts`, `tests/e2e/memory.spec.ts`.

## Agents' tools

In the `switchboard` MCP server (D68 helper and token), registered only while the feature is on and the session has a folder (the helper probes `GET /agent/v1/memory`, like Plans; since 2026-10-16 again on each wake-up and every ~25 s, so switching Project memory on gives running sessions the tools **without a restart** through MCP `list_changed`, and the draft ask makes sure the CLI has `memory_propose` first: live, else one `--resume` restart when idle; `docs/mcp.md` → *Tools that appear without a restart*). Only a missing **tool** can restart a session, and only right before an ask that needs it; changed approved memory still only flags (ruling 2026-10-14):

- **`memory_propose { title, text, tags?, scope?, repo? }`**: a proposal for the caller's folder. `scope` is `member`, `repo` or `workspace`; without it: `member` for a Team member's session, `repo` when the session works in exactly one repository, otherwise `workspace` (`defaultProposalScope`). `repo` names the repository (its folder name or remote) when the session works in several. The description asks for the narrowest scope that holds and workspace only for facts true for everyone in the folder; the developer confirms or changes the scope when approving. Refused (422) are `member` from a non-member and `repo` without a (known) repository. The description says what it is for (durable, reusable facts and conventions, not task notes), to keep entries short (title ≤ 80, text ≤ 1,000 characters, ≤ 8 tags) and that the developer reviews each one. Refused with 429 `rate-limited` after **10 proposals per session in the last hour** (every state counts; stored, so a restart does not reset it), and with 409 `duplicate` when the title is **near-identical** (`nearDuplicateTitle`: equal once lower-cased with accents and punctuation dropped, or within one edit per ten characters, at most three) to a proposed or approved entry of the folder, to one the developer **rejected in the last 30 days** (ruling 2026-10-14; after that a similar proposal enters the queue again), or to an agent's original title of an edited one.
- **`memory_list { }`**: the approved entries the caller sees (its member's, its repositories', its folder's), member first, then repo, then workspace, each labelled with its scope ("[member Builder]", "[repo acme-app]", "[workspace]") and, since D135, followed by a line with its id and last update ("(id: 0a1b2c3d4e · updated 2026-10-26 10:00 UTC)"), so the agent can name it in the two tools below. The lines before D135 read as they did.
- **`memory_propose_edit { entry, title?, text?, reason? }`** and **`memory_propose_retract { entry, reason }`** (D135): proposals to change or remove an approved entry; *Changing approved entries (D135)* below.

## Changing approved entries (D135)

Decision D135 (`docs/decisions.md`). An agent that finds an approved entry wrong, outdated or no longer true proposes to **edit** or **retract** (remove) it, instead of adding a second entry that contradicts it (the tools' descriptions say so, and to always give a reason). Nothing changes until the developer approves.

- **`memory_propose_edit { entry, title?, text?, reason? }`**: `entry` is the id `memory_list` shows; at least one of `title` / `text` (the complete new wording, not a diff), checked like a proposal's (≤ 80 / ≤ 1,000 characters); `reason` optional but asked for (≤ 500).
- **`memory_propose_retract { entry, reason }`**: the reason is required.
- **Which entries:** an approved entry the calling session sees (`memory_list`'s: its folder's workspace entries, its repositories', its member's). Refused: an unknown id or one that is not an approved entry (404 `not-found`), one outside that reach (403 `out-of-scope`), an edit without a field, a retract without a reason, a reason over 500 characters (422 `invalid`), an edit that changes nothing (422 `no-change`), a pending change of the same kind for the same entry from the same session (409 `duplicate`; other sessions may propose their own), and the shared limit of 10 proposals of any kind per session per hour (429).
- **Stored as proposals:** a row of `memory_entries` with `status = 'proposed'`, `change_kind` `edit` / `retract`, `target_id`, `reason` and the target's title and text as the agent saw them (`target_title` / `target_text`); it lives in the target's folder and scope, so it is reviewed next to it, counts in the folder's Inbox item ("Newest: "Edit: …"") and moves with a moved member like its target. For an edit, `title` / `text` are the proposed ones (the unchanged field copied from the target); for a retract, the target's own.
- **Approve an edit** (`POST /api/memory/entries/{proposal}/approve`, optionally with `{ title?, text? }` after Edit first): the target's title and / or text are replaced (a field the agent left as it was is not written, so a change the developer made meanwhile survives); the entry **keeps its id**, scope, tags and pin; `decided_at` / `decided_by` / `updated_at` record who and when. The proposal row is deleted. The folder's open sessions are flagged (D91), as for any approved change.
- **Approve a retract:** the target is **deleted** (a hard delete: the store has no soft delete; *rejected* is a review state, not an archive), with every other proposal about it.
- **Reject** either: the entry stays exactly as it is; the proposal is kept as rejected (shown under Rejected; Approve after all still applies it while the entry exists). Unlike a rejected entry, a rejected change does not block a new one.
- **The entry is gone** (deleted by hand or retracted): the proposals about it are deleted with it; one approved anyway answers 409 `target-gone`.
- **Never approved, never injected:** an `edit` / `retract` row cannot be set to `approved` (the CHECK of migration 4), so the block and `memory_list`, which read approved rows only, can never contain one.
- **Review UI:** `GET /api/memory/entries` gives each change proposal its `target` (the entry as it is now, `null` once gone). Classic Memory page and v2 Notes page: an **edit** shows *Now* and *Proposed* side by side (title and text; removed words struck, added words marked, `memoryWordDiff`; stacked on a phone) with the reason, **Approve**, **Edit…** / **Edit first** (the new title and text, then approve) and **Reject**; a **removal** shows the entry struck through with the reason, **Approve removal** and **Reject**. v2 Needs you shows the same as the item kinds **Note edit** / **Note removal**. Phones and paired machines approve and reject them like any proposal (the same routes, already on the allow-lists).
- Out of scope: approving a new proposal that duplicates an approved entry (only the near-identical title check at proposal time guards that).

## Checking notes (D136)

Decision D136 (`docs/decisions.md`). The developer asked: "Can Switchboard check whether stored memories are still true when new memories are added, and from time to time by itself?" Both happen now, in the background, and neither is a session: no `sessions` row, nothing in Agents, the sidebar or Home, nothing to interact with, no Inbox item, toast or push for a run.

### (A) When an agent proposes a note

When `memory_propose` adds a proposal, a short model call compares it with the approved notes the proposing session sees (the same reach as `memory_list`: its folder's workspace notes, its repositories', its member's). It answers **none**, **duplicate** (says the same thing) or **conflict** (they contradict each other), naming the approved note and a one-sentence reason.

- A duplicate or a conflict is kept (`memory_proposal_checks`) and the review card shows **"Duplicates: <title>"** / **"Conflicts with: <title>"** with the reason: the classic Memory page, the v2 Notes page and the v2 Needs-you "Note to approve" card. `GET /api/memory/entries` carries it as `check` on the proposal (only while the approved note still exists).
- **Approve and remove the old note** approves the proposal and moves the old note to the removed list (below) in one step (`POST /api/memory/entries/{id}/approve` with `{ removeConflicting: true }`; the same route, already on the phone and paired-machine allow-lists). **Approve** alone still works and keeps both.
- A failed, skipped or unreadable check shows nothing. Skipped: the checks are off (globally or for the folder), the session sees no approved note, the folder's agents use a CLI without a headless check mode, usage is paused or the account is at the warning level.
- Only new notes (`add`) are checked; D135's edit and removal proposals are not.

### (B) By itself, per folder

A **periodic check** per folder that has approved notes, **weekly** by default (Settings → Project memory: daily, every 3 days, weekly, every 2 weeks, monthly). The folder's approved notes (at most 60, the least recently changed first) go to a fresh, short-lived, read-only run of the folder's CLI in the folder itself, which verifies each against the code and recent git history (do the files, settings, commands, scripts and branches it names exist; does the code still behave as it says) and answers per note **keep**, **edit** (new title and / or text, reason) or **remove** (reason).

- **When:** a folder's first run is due a stable offset after the scheduler first sees it with approved notes (0–6 hours, a hash of its path, so folders do not all run at once); then the last run + the frequency + the same offset; a failed run is tried again after at most a day. A run also needs **agent activity in the folder since its last run** (never run: within the last period), and the account it would use **below the developer's usage warning level** ("Warn at", `usage.warnAtPct`) and not paused (D103: every account out of allowance). The scheduler looks every 10 minutes and starts **at most one** folder per look; runs never overlap.
- **Persisted:** `memory_check_folders` keeps per folder the first sighting, the last run's start and its result, so a restart neither re-runs a folder nor forgets when it ran (a run interrupted by a restart counts as run and shows "did not finish").
- **Output, validated on the server:** JSON `{ "notes": [ { "id", "action": "keep" | "edit" | "remove", "title"?, "text"?, "reason"? } ] }` (code fences and words around it are tolerated). An id must be one of the notes sent to that run; one decision per id (the first counts); edits and removals need a reason (≤ 500 characters); an edit needs a title (≤ 80) and / or a text (≤ 1,000). Anything else is dropped and logged. A note the developer changed while the run worked is left alone.
- **Removals are applied** (the developer's allowance) but **recoverable**: the note moves to **Removed by memory check** (below). At most **5 removals per run, and at most half of the folder's approved notes** (rounded down: a folder with one note never loses it by itself); removals over that cap become normal D135 removal proposals.
- **Edits still need approval:** they are filed as D135 edit proposals (author "Memory check", no session), shown in Needs you as **Note edit** as today. A pending check-filed proposal of the same kind for the same note is not filed again.
- **The result** is shown quietly on the Memory page and the v2 Notes page (when a folder is chosen): "Checked 2 days ago: checked 12 notes, removed 1, proposed 2 edits." (plus "proposed N removals for review" over the cap), "Checking the notes now…", "Not checked yet.", or why it was skipped or failed. **Check now** runs the folder at once (whatever its schedule and activity; it skips the warning level but not a pause).

### How a check runs

The check uses Claude Code only (the folder's CLI is the CLI of its newest session; a folder whose agents use Codex or OpenCode is skipped with "…, which has no headless check mode in Switchboard yet", recorded as its result). The binary and the account are resolved as for every spawn (the supervisor's CLI registry; D63's pick of the account a new session would start on, its profile folder in the environment, the environment scrubbed like every child). The argv (`memoryCheckArgs`, `src/server/memory/check.ts`):

- `-p --input-format stream-json --output-format stream-json --verbose` (the prompt goes over stdin; the turn's `result` is the answer);
- `--restricted`: the CLI's restricted mode: **no command or code tools** (no Bash, PowerShell or the like) and no WebFetch, **file tools confined to the working folder**, **user, project and local settings files ignored** (so their hooks and permission rules do not apply), writes never approved but by a person;
- `--permission-mode dontAsk` (anything not allowed is refused, never asked);
- (B) `--allowedTools Read,Grep,Glob,LS` (no shell at all); both `--disallowedTools` Bash, PowerShell, the editors, the web tools, agents and workflows (belt and braces), (A) also every reading tool (it only compares texts);
- `--strict-mcp-config` (no MCP servers), `--no-session-persistence` (no transcript: nothing in History);
- `--model sonnet` for both (A) and (B) (the developer's choice; Haiku at first); time limits 2 and 10 minutes (then stopped).

(A) runs in Switchboard's data folder (no project files needed), (B) in the folder. **The git history comes from Switchboard, not the agent:** before a periodic run Switchboard reads it itself with fixed, read-only git commands (argv, no shell, `GIT_OPTIONAL_LOCKS=0`: whether the folder is a working tree, the current branch, `git branch --list`, and `git log --since=<the last run, else 30 days> -n 200 --name-status`), truncated to 20,000 characters, and puts it in the prompt (`memoryGitContext`); the prompt tells the agent it has no shell. A folder that is not a git working tree gets no history (the notes are checked against the files only). Only the machine that owns the folder runs its checks; a paired machine's notes are checked there. **Demo mode never runs checks.**

### Removed by memory check

A removed note (by a check, or by "Approve and remove the old note") leaves `memory_entries`, so it is **never injected** and never listed to agents; its pending edit / removal proposals go with it. It is kept in `memory_removed` (the note as it was, the reason, who removed it, when) for **30 days**, then purged (the scheduler purges on each look). The classic Memory page and the v2 Notes page list them under **Removed by memory check** (struck through, the reason, "deleted for good on <date>") with **Restore**: the note is approved again **under the same id** (a new one only if that id was taken meanwhile), as it was, and the folder's open sessions are flagged (D91).

### Cost

Each run's tokens (per model, from the result's `modelUsage`, else its `usage`) are recorded in `insight_background_turns` (main database, migration 0051) and counted in **Insights → Usage** as kind **Memory check**, one row per folder ("Memory check · <folder>"), in the account's windows like any turn; it has nothing to open.

### Settings

**Settings → Project memory** (classic; v2: Settings → Advanced → **Notes checks**): **Check notes automatically** (on by default; it switches both checks), **How often** (weekly by default) and one switch per folder with approved notes (its last result next to it). Stored in `memory.db` (`memory_meta` `check.enabled` / `check.days`, `memory_check_folders.enabled`).

### Phones and paired machines

Phones read the removed notes and a folder's check state and use **Restore** and **Approve and remove the old note** (`DEVICE_ALLOWED`); the switches and **Check now** stay on the desktop (`DEVICE_REFUSED`). Every check route is on `PEER_API_ALLOW`, so the Memory and Notes pages reach a paired machine's checks through the proxy; its runs happen on that machine.

Tests: `tests/server/memory/checks.test.ts` (the schedule: first sighting and jitter, the activity gate, the usage gate, persistence across a restart, one run per tick, the switches, a failed run; the output validation; the removal cap; removal, never injected, Restore, the 30-day purge; check-filed proposals; a note changed meanwhile; "Approve and remove the old note"; the argv; the proposal check through the real runner and fake-claude, its tokens in Insights → Usage; the allow-lists), `tests/e2e/memory-checks.spec.ts` (classic Memory page and Settings, phone width), `tests/e2e/v2-notes-checks.spec.ts` (v2 Notes, Needs you, Settings → Advanced, phone width).

## Injection

`sessionInstruction` (D64, read at every spawn) appends the folder's block after the standing instruction and the D100 charter, so new sessions, resumes, restart recovery, account and CLI switches all carry it: Claude Code's `--append-system-prompt` (one argv entry), Codex's `developerInstructions`, OpenCode's `system`. With the standing instruction off, the block alone is passed.

```
=== Project memory (approved by the developer) ===
Folder: Acme app. Durable facts and conventions about this project that the developer reviewed and approved. …
- Run the tests with the test ports [tests]
  SWITCHBOARD_TEST_PORTS=4900-4909, port-hungry files one by one.
- Where the migrations live
  src/server/db/migrations; never edit an applied one.
2 more approved entries, not shown to save space: "Acme release notes", "Branch names". Read them with the switchboard memory_list tool when they matter.
=== End of project memory ===
```

- **Order:** **member** entries first, then **repo**, then **workspace**; within each, pinned first, then newest (approved or last edited), then title. When the session sees member or repo entries the block has a heading per scope ("-- For you, Builder (member memory) --", "-- Repository acme-app (repo memory) --", "-- Everyone in Acme app (workspace memory) --"); a block of workspace entries only reads exactly as before scopes.
- **Cap:** the entries' text is at most the cap (default **4,000** characters, 500–20,000, set on the Memory page and stored in `memory.db`). The Team charter (D100) is **not** counted against it, nor are the head lines and headings.
- **Budgets per scope** (`memoryBudgets`, `memoryBlockParts`): member 50 %, repo 30 %, workspace 20 % of the cap; a session that is no member gives the member share to repo and workspace (60 % / 40 %). Within a scope, entries are added in order while they fit in its budget; the first that does not fit stops that scope. A scope's unused budget passes on to the next (member → repo → workspace); whatever is still unused at the end goes back, in the same order, to the scopes that stopped early. The entries that did not fit are named on one overflow line (at most 20 titles, then "and N more") pointing to `memory_list`, so nothing silently disappears.
- **Example** (cap 4,000, a member's session; sizes are each entry's block text, and every entry after the first costs one more character for its line break): budgets 2,000 / 1,200 / 800. Member entries of 900, 700 and 600: 900 + 701 = 1,601 fit, the 600 (601) would make 2,202 > 2,000 and stops the scope; 399 passes on. Repo entries of 300 and 200: 301 + 201 = 502 of 1,599; 1,097 passes on. Workspace entries of 500, 500 and 400: 501 + 501 + 401 = 1,403 of 1,897; 494 left. Back down: the member's 601 does not fit in 494, so "its title" is named on the overflow line; the other seven entries are in the block (2 member, 2 repo, 3 workspace; `tests/core/memory.test.ts` has the same cases).

### Open sessions (D91, reused as it is)

The block is part of the instruction D91 compares, so a session whose process started with other memory is "older" (`Session.instructionOutdated`). **Ruling 2026-10-14: nothing is restarted.** Whenever a folder's approved set changes (approve, edit or pin of an approved entry, add, delete, the cap, the switch), the open sessions are only flagged: the service republishes them (`supervisor.instructionSettingChanged`), they show D91's "older instruction" state, and the developer applies it when they choose (Settings → Apply to open sessions, or a session's ⋯ → Reload instruction: idle → one `--resume` restart, busy → after its turn). New and resumed sessions get the current approved memory at their spawn. A proposal or a rejection changes nothing for any session.

## Draft memory from a session

D107 follow-up 2026-10-15. **Draft memory from this session** (a session's ⋯ menu in the sidebar: this machine's open sessions with a folder; a member's ⋯ on the Team page, wherever the member runs) and **Draft memory for all members** (the Memory page while Team has members, and the Team page header, for the team shown or All teams) send the session a normal message (`memoryDraftAskText`, origin `service`: queued while a turn runs, held while new turns pause, D103, like D105's charter ask). It asks the agent to read `memory_list`, review its own history and propose its durable facts with `memory_propose`, one per call, scoped as narrowly as they hold (member by default for members). **Nothing is applied:** the proposals go through the review queue.

- **One ask per session per 24 hours** (`memory_draft_asks` in `memory.db`): another within 24 hours is ignored and answered `asked: false, reason: asked-recently` (the toast says so); a closed session or one without a folder is not asked; a failed send forgets the ask.
- "For all members" skips paused members and those asked in the last 24 hours, listing them with the reason; a member on a paired machine is asked there (the peer API).
- Phones cannot send asks (D107 ruling q3: phones read and review).

## The Memory page

`/memory` (`?scope=` picks the folder), the nav grid's **Memory** cell (D101; an amber badge with the proposals waiting) while the feature is on.

- **Folder picker:** the saved folders, then any other folder with entries, each "label · N approved · M to review"; a **machine picker** when machines are paired (D48: a paired machine's memory through `/api/machines/{id}/api/memory/…`).
- **Scope filter:** Every scope / Member / Repo / Workspace; each entry shows its **scope chip** (Workspace, ⎇ repository name, ⚑ role name).
- **To review:** D135: a proposal to change an approved entry shows as *Edit* (now vs proposed, side by side) or *Removal* (the entry and the reason), with Approve / Edit… / Reject (*Changing approved entries (D135)*). Every other proposal with its title, text, tags, "proposed by <session>" (a link to the session) and **Suggested for** — a scope selector (`GET /api/memory/scope-options`: Workspace, the proposing session's repositories, the folder's sessions' repositories and existing repo entries, the Team members) preset to the agent's suggestion; the developer confirms or changes it · **Approve** (with the chosen scope), **Edit…** (the form with the same selector; its Approve approves the edit), **Reject**.
- **Approved:** ☆ / ★ pin, **Edit** (the scope too), **Delete…** (asks once more); **+ Add entry** (title, text, tags, pinned, scope: Workspace by default): the developer's entries are approved at once.
- **Draft memory for all members** (while Team has members) next to the pickers.
- **Rejected (n):** folded; **Approve after all** or **Delete**.
- D136: under the folder's path its **check line** with **Check now**; a flagged proposal's "Conflicts with / Duplicates" and **Approve and remove the old note**; **Removed by memory check (n)** with **Restore** (*Checking notes (D136)*).
- **Block size per session:** the cap.

The **Inbox** has one item per folder with proposals ("3 memory proposals for Acme app", kind `memory-proposals`, label *Memory*), its title following the count; **Review** opens the page at the folder (a link: the item stays), **Dismiss** closes it until the next proposal. It is resolved by itself once the folder's queue is empty. A paired machine's item (D48) keeps its Review link: the route becomes `/memory?scope=<its folder>&machine=<its id>`, so the classic Memory page opens with that machine picked and v2 opens Notes at that folder; v2's Needs you reads that machine's proposed notes for it and shows them as note cards of that computer (`peerRoute`, `src/core/peer-wire.ts`). Before, every peer route but a plan's became `/inbox`, so on v2 **Review notes** went back to Needs you and seemed to do nothing.

The **session's right panel** shows "Memory: N entries": what **this session receives** (the entries in its block: its member's, its repositories', its folder's; `GET /api/memory/sessions/{id}`), with the breakdown in the tooltip ("member 1 · repo 2 · workspace 1; 1 more over the size cap…"), and "· M to review" (its folder's proposals), a link to the page at its folder (this machine's sessions only).

## Phones and paired machines

- **Devices (D73):** phones may read everything (a session's count and the scope options too) and review: approve, reject, edit, pin, and change an entry's scope while doing so (`DEVICE_ALLOWED`). Adding by hand, deleting, the cap, the draft asks and the import stay on the desktop (`DEVICE_REFUSED`).
- **Peers (D48):** memory is per machine (its own `memory.db`, its own sessions). Every `/api/memory` route is on `PEER_API_ALLOW`, so the Memory page reaches a paired machine's memory through the proxy; approving there reloads that machine's sessions. There is no exchange or snapshot of memory between machines, except a moved member's member entries (*Scopes*) and draft asks for a member running there.

## Storage

`<dataDir>/memory.db`, its own migration list (`MEMORY_MIGRATIONS`, run by the main database's runner like Team's and Plans'; never edit an applied one: they are checksummed, comments included): `memory_entries` (id, scope, title, text, tags, author kind / session / label, status, pinned, timestamps, decided at / by, proposed title / text; migration 2 `memory_scopes` added `scope_kind` (default `workspace`, so every earlier row is a workspace entry and is injected exactly as approved), `scope_key`, `scope_label`), `memory_meta` (the cap) `memory_draft_asks` (migration 2: the last draft ask per session), `memory_pending_copies` (migration 3: a moved member's entries not yet taken by its new machine), migration 5 `memory_checks` (D136: `memory_removed`, `memory_proposal_checks`, `memory_check_folders`; *Checking notes (D136)*) and, migration 4 `memory_changes` (D135), `memory_entries.change_kind` (`add`, the default for every earlier row, `edit`, `retract`; a CHECK refuses an approved `edit` / `retract`), `target_id`, `reason`, `target_title`, `target_text`, indexed by target. A change proposal is a row of the same table rather than a table of its own so that the review queue, the Inbox item, the rate limit, the routes, their allow-lists, the peer proxy and a member's move needed no new paths; the CHECK keeps the review gate's one rule (only approved `add` rows are read for a session). Nothing in `switchboard.db` besides the setting and the Inbox items it raises.
