# Performance with long sessions (D95)

Developer report 2026-10-10: "When using Switchboard longer, it slows down." The running install showed no server leak (≈107 MB RSS after 10 h, idle CPU 0 %) but a large database (163 MB + 24 MB WAL; the biggest session 13,249 events / 32 MB of payload, the next ones ≈4,700 / ≈10 MB). So the suspects were work that grows with a conversation's size or with the uptime of a tab. This page is the harness that measured it, the numbers before and after, and the design of the fixes (`docs/decisions.md` → D95).

## The harness (`tools/bench/`)

Everything runs on a test port (`SWITCHBOARD_TEST_PORTS`, e.g. `4900-4909`), a throwaway data folder and the fake CLIs; it never reads a real install, CLI config or keychain.

| Script | What it does |
|---|---|
| `tools/bench/world.ts` | `seedWorld(dir)`: a synthetic world from a fixed seed: one **big** session (≈13,000 events, ≈32 MB: turns of a user message, Markdown answers with code blocks / tables / lists, 6–17 tool calls with long inputs and outputs cut at 4,000 characters as the recorder cuts them, subagents with their prompt and own calls, Workflow launches), four **medium** sessions (≈4,700 events, ≈11.6 MB each), 2,000 usage readings, 280 turn checkpoints. `appendHistory(store, sessionId, …)` adds such a history to any session, also one a running server has open (SQLite WAL). |
| `tools/bench/server.ts` | One server run per phase, each with its own CPU profile (`--profile <dir>`). **open**: median of 5 for every route the session view calls (detail, events whole and paged, checkpoints, todos, loops, drafts, artifacts, diff count) for the big, a medium and a small session, plus the session list. **stream**: a live fake-claude session fires 100 turns of its own (`[fake:fire 100 20]`), once while its conversation is small and once after ≈13,000 events of history were added to it (with a live `CronCreate`, so the loop tracker follows it): server CPU (`ps`), events, `/hub` bytes per event name. `--out <file.json>` keeps the numbers. |
| `tools/bench/browser.ts` | Headless Chromium (Playwright) over CDP (`Performance.getMetrics`, `HeapProfiler.collectGarbage`, `Profiler`). **open**: the big session's chat, cold: time to its first message, time until the main thread is quiet, main-thread time, DOM nodes, heap after a GC. **typing**: 21 keys in the composer, main-thread time per key. **scroll**: the conversation from the bottom to the top in 20 steps. **timeline**: the big session's Timeline tab. **soak**: `--minutes` (default 3) of a live session streaming turns while the tab switches between all sessions every 4 s: heap after a forced GC and nodes each minute, main-thread busy share; then back to the Inbox: heap, renderer nodes (attached or not) and document elements. `--profile <dir>` writes `browser-open-big.cpuprofile` and the soak's first minute. |
| `tools/bench/profile.ts` | Summarizes a `.cpuprofile` (V8 `--cpu-prof` or CDP): self and total time per function. |

```sh
SWITCHBOARD_TEST_PORTS=4900-4909 node tools/bench/server.ts --profile .bench/prof --out .bench/server.json
SWITCHBOARD_TEST_PORTS=4900-4909 node tools/bench/browser.ts --minutes 3 --profile .bench/prof --out .bench/browser.json
node tools/bench/profile.ts .bench/prof/stream-big/*.cpuprofile --top 30
```

`.bench/` is git-ignored. Numbers below: one machine (Apple silicon, Node 24, Chromium of Playwright 1.62), before = `cd0b2c7` (1.15.0), after = the D95 branch; CPU times from `ps` are ±10 ms.

## Numbers

### Opening a session (server, median of 5)

| Route (big session, 13k events) | Before | After |
|---|---|---|
| `GET /api/sessions/{id}` | 34 ms, 642 KB | 3.7 ms, 642 KB |
| `GET /api/sessions/{id}/events` (what the chat loaded) | 151 ms, **35.2 MB** | (still served) 162 ms, 35.2 MB |
| `GET /api/sessions/{id}/events?limit=1000` (what the chat loads now) | — | 11.4 ms, **2.7 MB** |
| `GET /api/sessions/{id}/checkpoints` | 34.5 ms | 10.5 ms |
| Medium session (4.7k): detail / events → page / checkpoints | 13.9 ms / 46 ms, 12.7 MB / 18.5 ms | 3.1 ms / 11.2 ms, 2.7 MB / 11.4 ms |

### Streaming (server, 100 fired turns = 203 events)

| | Before | After |
|---|---|---|
| Small conversation: CPU, per event | 840 ms, 4.1 ms | 810–930 ms, 4.0–4.6 ms |
| Same session with ≈13k events of history: CPU, per event | 2,450 ms, **12.1 ms** | 1,250 ms, **6.2 ms** |
| … of which the loop tracker (profile, total) | 868 ms (13k events read and parsed per refresh) | 41 ms (+ one first read of 74 ms) |
| … agents read for `sessionUpdated` (profile, total) | 318 ms | ≈0 (from memory) |
| `/hub` bytes | 26.7 MB (`sessionUpdated` ≈125 KB each: ≈430 agents) | unchanged (see *Remaining*) |

### Browser (big session, 1440×900)

| | Before | After |
|---|---|---|
| Open the chat: first message shown | 3.5 s | 0.47 s |
| … until the main thread is quiet | **8.7 s** (7.9 s of main-thread work) | **1.7 s** (0.48 s of work) |
| … chat messages rendered / DOM nodes | 2,128 / ≈371,000 | 163 / ≈44,000 |
| … heap after a GC | 143 MB | 24 MB |
| Typing, main-thread time per key | 7.7 ms | 3.1 ms |
| Soak (3 min streaming + 44 switches): main thread busy | **≈92 %** | ≈10 % |
| … heap after a GC, minute 1 / 2 | 198 / 197 MB | 36 / 37 MB |
| Back on the Inbox after the soak: heap / renderer nodes (document elements: 203 both) | 149 MB / **367,404** | 26 MB / 283 |
| Inbox before any visit (baseline) | 3.3 MB / ≈265 nodes | same |

Scrolling to the top cost 14 ms a step before (one 690,000 px conversation, everything already there) and 22 ms after (each step near the top now loads and draws the page before: that is the load, not a slower scroll).

## What the profiles showed (the top offenders)

1. **The chat drew the whole history** (`browser-open-big.cpuprofile`: Markdown parsing and highlight.js regexes, React mounting 2,128 messages, 1.0 s of layout). `GET /events` sent 35 MB, the tab parsed and kept it, and the per-tab session cache kept up to 20 such lists (the soak's 150–200 MB).
2. **Every message's Markdown was parsed again on every `/hub` event.** D89 passed a new `onSaveCode` closure on each chat render, which defeated `ChatMarkdown`'s memo: during the soak the main thread was busy 92 % of the time.
3. **The loop tracker re-read the session** (`#refreshNow → events.list → JSON decode`: 868 ms of 2,450 ms in `stream-big`): a session with loops is refreshed every 150 ms while it streams, and each refresh read and parsed all 13k events (32 MB).
4. **History scans on hot routes**: the detail's reported status table (`assistantTextsNewestFirst`, ≈13 ms: `json_extract` + `LIKE` over every payload when no table matches) on every detail read (twice a second while a session streams), and the checkpoints' turn count (`countUserMessages`, ≈11 ms) on **every event**: the chat keyed its checkpoints read on the event count, and each read also runs git in the session's repos.
5. **The agents list** for every `sessionUpdated` (`toSession → agents.listBySession`: ≈430 rows decoded each time).
6. **A detached view kept alive** (heap snapshot retainer path): React DOM's select-event plugin keeps the focused text field in a module variable until it handles a `focusout`; a field removed with its view sends that `focusout` while React commits, when React ignores events, so a focused composer kept the whole left chat (≈44k nodes) in memory.
7. Found while fixing 1: measuring the scroll anchor on every render laid the page out from a layout effect on each `/hub` event (0.9 s a minute of `getBoundingClientRect` in the soak profile) — fixed before it shipped.

## Design

### Paged events (server)
`GET /api/sessions/{id}/events` takes additive, combinable queries (`docs/handoff/contracts/local-api.md` → *Paged events (D95)*): `?limit=n` the newest n matching events (oldest first), `?before=<eventId>` only events older than that one in time order (ts, then id: the chat's order, so imported terminal turns with older timestamps land in the right page), `?agent=<agentId>` that agent's events plus the Agent / Task call that started it (its `toolUseId`). Without them it answers every event, as before (old clients, peers, the Timeline). `EventRepository.page` reads them through the `(session_id, ts, id)` index; no migration was needed (0042 not used). The peer proxy keeps only the latest page as a session's offline snapshot (`before` / `agent` reads are not snapshots).

### Chat window (browser)
- `useSessionData` fetches the newest `CHAT_EVENTS_PAGE` (1,000) events; a full page leaves a **cursor** at its oldest event (time order). `older.load()` fetches the page before the cursor and puts it in front (`withOlderPage`); a page that adds nothing (a machine without paging answers everything) ends the window.
- The chat loads that page when scrolled within 600 px of the top, or through the row above the messages ("Show earlier messages" / "Loading earlier messages…" / "Could not load earlier messages · Retry"), and by itself when the window is too short to scroll. While a page lands, the item the view is anchored to (the topmost one in view, never the first item, which can merge with the text before it) stays where it was on screen; the anchor is measured only while scrolled up.
- `/hub` events older than the cursor are left for their page (`inWindow`); events already in the window update as before. A question batch without its call among the loaded events goes last only while it waits (an answered one belongs to a page not loaded yet).
- A subagent's chat loads that subagent's events whole (`?agent=`, `useAgentEvents`) and merges them with the window, so its brief, steps and result show whatever the main chat has loaded.
- The per-tab session cache (D45) keeps a session's window cut to its newest page once it grew past two pages, and 6,000 events across all sessions (the least recently stored lose their events first; their detail stays).
- Checkpoints are read again per turn, not per event (`checkpointsKey`: the user messages, their withdrawn / queued marks, revert dividers, the status); the header's Undo follows the status and, at most once a minute, the activity time.
- `ChatMarkdown`'s memo compares `onSaveCode` by presence and calls the newest one through a ref.
- `useReleaseFocus` (the composer): when the field unmounts with the focus, a `focusout` goes to React's root after the commit, so React lets go of the field.

### Incremental derivations (server)
- **Write revisions.** `EventRepository` counts the writes (append / update) per session in this process and keeps a log of the newest ids written (`revision`, `changedSince`, `byIds`). Every write to `events` goes through it, so "revision unchanged" means "history unchanged".
- **Loop tracker.** Keeps each session's events cut to what `deriveLoops` reads (`loopPayloadEssentials`: the type; a `/loop` message's text; a lifecycle action; a result's error and task-notification flags; a loop tool call whole; any other call its name) with their times parsed once (16 sessions at most); a refresh reads only the rows written since. `deriveLoops(slim) = deriveLoops(whole)` is a unit test.
- **`EventMemo`.** A value derived from a whole history is kept until an event that can change it is written: the reported status table (assistant messages), the session's turn count (user messages). After writes only the changed rows are read to decide.
- **Agents.** `listBySession` answers from memory while a count / newest-row mark says nothing changed; an update replaces its row in the kept list. `mainOf` reads the main agent alone.

### Database maintenance
`DatabaseMaintenance` (`src/server/db/maintenance.ts`): at start `PRAGMA analysis_limit=400; PRAGMA optimize=0x10002` (2 ms on the synthetic world); every 10 minutes, once no event was written for a minute, `PRAGMA optimize` and `PRAGMA wal_checkpoint(TRUNCATE)` (the WAL goes back to empty). No index was missing for the paths above: the hot queries use `(session_id, ts, id)`, `agents(session_id)`, and the remaining JSON scans are now memoized.

## Guards
- `tests/e2e/long-session.spec.ts`: a real fake-claude session grown to ≈13k events opens with ≤ 400 messages (163 measured; 2,087 before) and the earlier-messages row; scrolling to the top loads the page before without moving the message in view (±2 px); the button loads the next page. Five rounds of switching between it and a 2k-event session, leaving each with a draft in the focused composer: heap and renderer nodes do not grow after the first round, the heap stays under 30 MB (≈15 measured, ≈50 before), and back on the Inbox no node of the left views is alive (31,664 before the focus fix, against 289).
- `tests/server/loops/tracker.test.ts` (*D95 incremental refresh*): after the first refresh, `events.list` is never called again; a refresh after two appends and an update reads exactly those two ids; nothing written, nothing read.
- `tests/core/loops.test.ts` (*loopPayloadEssentials*), `tests/server/db/event-memo.test.ts` (revisions, the change log, `EventMemo`, the turn count, the agents cache), `tests/server/db/maintenance.test.ts`, `tests/server/api/sessions.test.ts` (*D95 pages*), `tests/web/session-loading.test.ts` (*the chat window*: cursor, `inWindow`, older pages, trimming, the cache budget), `tests/web/chat.test.ts` (trailing batches), `tests/web/undo.test.ts` (`checkpointsKey`).
- Unchanged and still green: `typing-long-chat.spec.ts` (no message re-renders while typing), `session-loading.spec.ts`, `subagent-chat.spec.ts`, `session-chat.spec.ts`, `undo.spec.ts`, `drafts.spec.ts`.

## Remaining hotspots
- **`sessionUpdated` size.** Each carries the session's whole `agents` list (≈125 KB for ≈430 subagents), sent for every status or context change while a turn runs (26.7 MB over `/hub` for 100 short turns; every open tab parses it). Shrinking it needs a contract change (e.g. finished subagents left out, or a delta) or coalescing per session, which drops intermediate states some listeners read: not done (`.loop/questions.md` → D95-q1).
- **The Timeline tab** still loads every event (35 MB for the big session) and draws a lane per agent (428 lanes, ≈95,000 nodes, 1.3 s to settle). It was not in the chat path; windowing it needs a design decision (D95-q2).
- **Git per turn.** The checkpoint snapshot, the review card's fingerprint and the touched-files snapshot spawn git several times per turn (the largest remaining share of the server's streaming CPU, ≈0.4 s per 100 turns here); not conversation-size dependent.
- **The session list** (`GET /api/sessions`, 281 KB for six sessions) carries every session's agents too.
