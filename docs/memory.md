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

1. `memory_propose` (and `POST /agent/v1/memory`) can only create rows with `status = 'proposed'`. There is no agent route that approves, edits or deletes.
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

Tests: `tests/server/memory/scopes.test.ts` (scopes, budgets on the real service, draft asks, the migration, a member's move), `tests/server/memory/move-retry.test.ts` (pending copies: offline then online, memory off then on, backoff, the item's Retry / Keep, migration 3), `tests/server/memory/injection.test.ts` (fake-claude's argv, fake-codex's `developerInstructions`, fake-opencode's `system`), `tests/server/memory/switch.test.ts`, `tests/e2e/memory.spec.ts`.

## Agents' tools

In the `switchboard` MCP server (D68 helper and token), registered only while the feature is on and the session has a folder (the helper probes `GET /agent/v1/memory`, like Plans; since 2026-10-16 again on each wake-up and every ~25 s, so switching Project memory on gives running sessions the tools **without a restart** through MCP `list_changed`, and the draft ask makes sure the CLI has `memory_propose` first: live, else one `--resume` restart when idle; `docs/mcp.md` → *Tools that appear without a restart*). Only a missing **tool** can restart a session, and only right before an ask that needs it; changed approved memory still only flags (ruling 2026-10-14):

- **`memory_propose { title, text, tags?, scope?, repo? }`**: a proposal for the caller's folder. `scope` is `member`, `repo` or `workspace`; without it: `member` for a Team member's session, `repo` when the session works in exactly one repository, otherwise `workspace` (`defaultProposalScope`). `repo` names the repository (its folder name or remote) when the session works in several. The description asks for the narrowest scope that holds and workspace only for facts true for everyone in the folder; the developer confirms or changes the scope when approving. Refused (422) are `member` from a non-member and `repo` without a (known) repository. The description says what it is for (durable, reusable facts and conventions, not task notes), to keep entries short (title ≤ 80, text ≤ 1,000 characters, ≤ 8 tags) and that the developer reviews each one. Refused with 429 `rate-limited` after **10 proposals per session in the last hour** (every state counts; stored, so a restart does not reset it), and with 409 `duplicate` when the title is **near-identical** (`nearDuplicateTitle`: equal once lower-cased with accents and punctuation dropped, or within one edit per ten characters, at most three) to a proposed or approved entry of the folder, to one the developer **rejected in the last 30 days** (ruling 2026-10-14; after that a similar proposal enters the queue again), or to an agent's original title of an edited one.
- **`memory_list { }`**: the approved entries the caller sees (its member's, its repositories', its folder's), member first, then repo, then workspace, each labelled with its scope ("[member Builder]", "[repo acme-app]", "[workspace]").

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
- **To review:** each proposal with its title, text, tags, "proposed by <session>" (a link to the session) and **Suggested for** — a scope selector (`GET /api/memory/scope-options`: Workspace, the proposing session's repositories, the folder's sessions' repositories and existing repo entries, the Team members) preset to the agent's suggestion; the developer confirms or changes it · **Approve** (with the chosen scope), **Edit…** (the form with the same selector; its Approve approves the edit), **Reject**.
- **Approved:** ☆ / ★ pin, **Edit** (the scope too), **Delete…** (asks once more); **+ Add entry** (title, text, tags, pinned, scope: Workspace by default): the developer's entries are approved at once.
- **Draft memory for all members** (while Team has members) next to the pickers.
- **Rejected (n):** folded; **Approve after all** or **Delete**.
- **Block size per session:** the cap.

The **Inbox** has one item per folder with proposals ("3 memory proposals for Acme app", kind `memory-proposals`, label *Memory*), its title following the count; **Review** opens the page at the folder (a link: the item stays), **Dismiss** closes it until the next proposal. It is resolved by itself once the folder's queue is empty.

The **session's right panel** shows "Memory: N entries": what **this session receives** (the entries in its block: its member's, its repositories', its folder's; `GET /api/memory/sessions/{id}`), with the breakdown in the tooltip ("member 1 · repo 2 · workspace 1; 1 more over the size cap…"), and "· M to review" (its folder's proposals), a link to the page at its folder (this machine's sessions only).

## Phones and paired machines

- **Devices (D73):** phones may read everything (a session's count and the scope options too) and review: approve, reject, edit, pin, and change an entry's scope while doing so (`DEVICE_ALLOWED`). Adding by hand, deleting, the cap, the draft asks and the import stay on the desktop (`DEVICE_REFUSED`).
- **Peers (D48):** memory is per machine (its own `memory.db`, its own sessions). Every `/api/memory` route is on `PEER_API_ALLOW`, so the Memory page reaches a paired machine's memory through the proxy; approving there reloads that machine's sessions. There is no exchange or snapshot of memory between machines, except a moved member's member entries (*Scopes*) and draft asks for a member running there.

## Storage

`<dataDir>/memory.db`, its own migration list (`MEMORY_MIGRATIONS`, run by the main database's runner like Team's and Plans'; never edit an applied one: they are checksummed, comments included): `memory_entries` (id, scope, title, text, tags, author kind / session / label, status, pinned, timestamps, decided at / by, proposed title / text; migration 2 `memory_scopes` added `scope_kind` (default `workspace`, so every earlier row is a workspace entry and is injected exactly as approved), `scope_key`, `scope_label`), `memory_meta` (the cap) `memory_draft_asks` (migration 2: the last draft ask per session) and `memory_pending_copies` (migration 3: a moved member's entries not yet taken by its new machine). Nothing in `switchboard.db` besides the setting and the Inbox items it raises.
