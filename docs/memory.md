# Project memory (D107, experimental)

Durable, reusable facts and conventions about a project (build and test commands, gotchas, decisions and their reasons, where things live), kept **per folder** and given to every session that works there. Agents only **propose** entries; the developer **approves** them before any session ever sees them. Decision D107 (`docs/decisions.md`); contract → *Project memory (D107)* in `docs/handoff/contracts/local-api.md`; removal: `docs/memory-removal.md`.

## The switch

Settings → Experimental → **Project memory** (`experimental.memory`), **off by default**. While off:

- no `memory.db` is created or opened, nothing runs in the background;
- every route answers 404 `memory-off` except `GET /api/memory/state`;
- the `switchboard` MCP server registers no memory tools;
- no session gets a memory block (`sessionInstruction` is exactly as without the feature);
- the Memory cell, the page and the session panel's line are not rendered.

Switching it on opens (or creates) `<dataDir>/memory.db`; open sessions of folders that have approved entries show D91's "older instruction" state (below). Switching it off closes the file (it stays on disk), resolves its Inbox items and flags those sessions the same way (their next spawn, or a reload, drops the block). A broken `memory.db` answers 503 `memory-unavailable` and injects nothing; the rest of Switchboard is unaffected. Demo mode never starts it.

## Scope

An entry belongs to a **folder**: the session's canonical root (`SessionRecord.root`): the saved workspace or repo folder (D14 / D18). A worktree session's folder is its repo, so every worktree of a repo shares its memory. A session without a root uses its `cwd`. **Chats (D106)** have no project folder: they get neither the tools nor a block.

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

Tests: `tests/server/memory/injection.test.ts` (fake-claude's argv, fake-codex's `developerInstructions`, fake-opencode's `system`), `tests/server/memory/switch.test.ts`, `tests/e2e/memory.spec.ts`.

## Agents' tools

In the `switchboard` MCP server (D68 helper and token), registered only while the feature is on and the session has a folder (`registerMemoryToolsIfOn` probes `GET /agent/v1/memory` once at start, like Plans):

- **`memory_propose { title, text, tags? }`**: a proposal for the caller's folder. The description says what it is for (durable, reusable facts and conventions, not task notes), to keep entries short (title ≤ 80, text ≤ 1,000 characters, ≤ 8 tags) and that the developer reviews each one. Refused with 429 `rate-limited` after **10 proposals per session in the last hour** (every state counts; stored, so a restart does not reset it), and with 409 `duplicate` when the title is **near-identical** (`nearDuplicateTitle`: equal once lower-cased with accents and punctuation dropped, or within one edit per ten characters, at most three) to a proposed or approved entry of the folder, to one the developer **rejected in the last 30 days** (ruling 2026-10-14; after that a similar proposal enters the queue again), or to an agent's original title of an edited one.
- **`memory_list { }`**: the folder's approved entries (title, text, tags), in block order.

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

- **Order:** pinned first, then newest (approved or last edited), then title.
- **Cap:** the entries' text is at most the cap (default **4,000** characters, 500–20,000, set on the Memory page and stored in `memory.db`). Entries are added in order while they fit; the first that does not fit and every one after it are named on one overflow line (at most 20 titles, then "and N more") pointing to `memory_list`.

### Open sessions (D91, reused as it is)

The block is part of the instruction D91 compares, so a session whose process started with other memory is "older" (`Session.instructionOutdated`). **Ruling 2026-10-14: nothing is restarted.** Whenever a folder's approved set changes (approve, edit or pin of an approved entry, add, delete, the cap, the switch), the open sessions are only flagged: the service republishes them (`supervisor.instructionSettingChanged`), they show D91's "older instruction" state, and the developer applies it when they choose (Settings → Apply to open sessions, or a session's ⋯ → Reload instruction: idle → one `--resume` restart, busy → after its turn). New and resumed sessions get the current approved memory at their spawn. A proposal or a rejection changes nothing for any session.

## The Memory page

`/memory` (`?scope=` picks the folder), the nav grid's **Memory** cell (D101; an amber badge with the proposals waiting) while the feature is on.

- **Folder picker:** the saved folders, then any other folder with entries, each "label · N approved · M to review"; a **machine picker** when machines are paired (D48: a paired machine's memory through `/api/machines/{id}/api/memory/…`).
- **To review:** each proposal with its title, text, tags and "proposed by <session>" (a link to the session) · **Approve**, **Edit…** (the form; its Approve approves the edit), **Reject**.
- **Approved:** ☆ / ★ pin, **Edit**, **Delete…** (asks once more); **+ Add entry** (title, text, tags, pinned): the developer's entries are approved at once.
- **Rejected (n):** folded; **Approve after all** or **Delete**.
- **Block size per session:** the cap.

The **Inbox** has one item per folder with proposals ("3 memory proposals for Acme app", kind `memory-proposals`, label *Memory*), its title following the count; **Review** opens the page at the folder (a link: the item stays), **Dismiss** closes it until the next proposal. It is resolved by itself once the folder's queue is empty.

The **session's right panel** shows "Memory: N entries" (its folder's approved entries) and "· M to review", a link to the page (this machine's sessions only).

## Phones and paired machines

- **Devices (D73):** phones may read everything and review: approve, reject, edit, pin (`DEVICE_ALLOWED`). Adding by hand, deleting and the cap stay on the desktop (`DEVICE_REFUSED`).
- **Peers (D48):** memory is per machine (its own `memory.db`, its own sessions). Every `/api/memory` route is on `PEER_API_ALLOW`, so the Memory page reaches a paired machine's memory through the proxy; approving there reloads that machine's sessions. There is no exchange or snapshot of memory between machines.

## Storage

`<dataDir>/memory.db`, its own migration list (`MEMORY_MIGRATIONS`, run by the main database's runner like Team's and Plans'): `memory_entries` (id, scope, title, text, tags, author kind / session / label, status, pinned, timestamps, decided at / by, proposed title / text) and `memory_meta` (the cap). Nothing in `switchboard.db` besides the setting and the Inbox items it raises.
