# Search across everything (D97)

One field finds anything said or saved in Switchboard: the conversations (your messages, the agents' text and progress notes, subagent prompts, tool calls, session titles), the saved artifacts, the todos and History's terminal conversations, on this machine and on the paired ones. Decision: `docs/decisions.md` → D97. Contract: `docs/handoff/contracts/local-api.md` → *Search (D97)*.

## The index
Migration **0042** (`src/server/db/migrations/0042_search.sql`) adds one SQLite **FTS5** table, `search_fts` (contentless with deletes: it keeps the index, not the text; tokenizer `unicode61 remove_diacritics 2`, so case and accents do not matter), with two columns, `title` and `body`:

| rowid | What | Written by |
|---|---|---|
| `> 0` | an event, rowid = `events.id`, title empty | the events repository when it appends or updates an event (`SearchRepository.indexEvent`) |
| `< 0` | a `search_items` row (a session, todo, artifact or History row), rowid = −id | triggers on `search_items`, which triggers on the source tables keep |

`search_items` holds what the index has for a session / todo / artifact / History row (its title and body, read back for the snippets): its kind, the source's key (`ref`), its session, and a time for the recency boost. The `search_src_*` views say what each source contributes; the triggers and the backfill both read them.

### What is indexed
- **Events** (`eventSearchText`, `src/core/search.ts`): a user message (without the session-start block; not one a Stop withdrew), the agent's text and **progress notes** (D96), a subagent's prompt, and a tool call: its name, the strings of its input (the first 2,000 characters) and its result (the first 2,000). A message is cut at 32,000 characters. Binary-looking text (NUL / replacement characters, a run of 400+ characters without a space: base64, minified data) is left out. Lifecycle lines, results, permission requests and the like are not indexed.
- **Sessions**: the title (else the name) as the title; the name and the task as the body.
- **Todos**: the title; the description and the plan.
- **Artifacts** (D89): the title; the latest version's text (first 100,000 characters).
- **History** (D72's History rows of terminal conversations that are not sessions here): the conversation's name; its first prompt and summary. A row whose conversation became a session here (Continue in Switchboard) is not shown (the session is).

### Consistency
Every delete reaches the index in the same transaction, through triggers: an event row (a session deleted cascades its events; anything that prunes events), a session, a todo (delete, clear done, the hourly clean-up), an artifact or one of its versions (the artifact's text goes back to the latest remaining version), a History row. An update of an indexed column re-indexes the row (`AFTER UPDATE OF …`); other updates (a status change) do not touch the index. An event update re-indexes it only when its payload changed (a tool's result arriving), and removes it when it no longer has text (a withdrawn message).

Updates are written as delete + insert, never `INSERT OR REPLACE`: inside a trigger fired by an upsert, the outer statement's conflict policy wins over the trigger's, and FTS5 then keeps the old entry next to the new one.

An indexing error is reported and never thrown: the event is stored either way.

### Backfill
`SearchBackfill` (`src/server/search/backfill.ts`) fills the index with what was written before it existed (an upgrade), in the background:
- it starts 1.5 s after the server is ready (startup's own work first);
- each step is a timer callback doing at least one batch of 250 rows and more while 15 ms have not passed: the event loop is never held longer, so requests and event writes interleave;
- it waits while events are being written (one within 250 ms), but never more than 1 s between steps, so it finishes under a constant stream too;
- the session / todo / artifact / History rows go first (few), then the events up to the newest id at its start (newer events were indexed by their own write);
- its progress is stored after every step (`search_state`), so a restart resumes where it stopped; once complete it does nothing at start.

While it runs, answers carry `indexing: { done: false, percent }` and the Search page shows *Indexing older history… n%*. `SEARCH_INDEX_VERSION` versions what an event contributes: raising it makes the backfill index every event again.

## Query
`parseSearchQuery`: words (all must match, in any order, anywhere in a title or body), `"quoted phrases"` (the words next to each other, in order), `prefix*`. Everything else is text: FTS5 operators and syntax (`AND`, `OR`, `NOT`, `NEAR`, `:`, `^`, parentheses, `-`) are searched as words or dropped, never interpreted, because every term is sent as a quoted string. A word with inner punctuation (`file-1234`, `foo.bar`) is the phrase of its parts, as the tokenizer splits it. At most 200 characters and 12 terms are read.

**Ranking:** `bm25` with a title column weighted 4 × the body, times a recency boost (up to 1.5 × for something from today, fading over about two weeks); lower is better. Equal scores: the newer row first. A paired machine's scores are compared as they are (roughly comparable: the same formula on another corpus).

**Snippets** (`highlight`): about 180 characters around the first match (or the whole text when shorter), whitespace collapsed, `…` where it was cut, cut at word boundaries; the matches are marked as segments (`{ text, match: true }`), never HTML.

## `GET /api/search`
`src/server/search/service.ts`, route `src/server/api/search.ts`. `q`, `scope` (`all` default, `conversations`, `artifacts`, `todos`, `history`), `session` (only that session; a paired machine's remote id: only there), `machine` (`all`, `local` or a machine id), `limit` (1–50; default 5 per group for `all`, 20 for one scope), `cursor` (a group's `nextCursor`, one scope only). Groups come in the order above, each with its total `count`.

### Paired machines (D48)
Unless the request asks for this machine only, comes from a peer, or names a local session, the search asks every **online** paired machine at the same time (`PeerService.fanOutGet`, `GET /peer/v1/api/search?…&machine=local`), each bounded by 2.5 s (`PEER_SEARCH_TIMEOUT_MS`). Its results are namespaced (`r~<machine>~…` ids and session ids, as every peer answer) and tagged with the machine, then merged with this machine's by score; the cursor keeps an offset per machine. A machine that is offline or reconnecting, does not answer in time, answers an error, refuses the pairing, is an older Switchboard (403 / 404) or answers something that is not a search answer is listed in `notSearched` with the reason; the answer comes anyway. A peer request never fans out further. History stays on its machine (no History through the peer API, as D72).

## Opening a result
A result leads to (`resultRoute`, `src/web/views/search-view.ts`):
- a message: its chat at that event, **`/sessions/{id}/events/{eventId}`** (a subagent's: `/sessions/{id}/agents/{agentId}/events/{eventId}`);
- a session: its chat; an artifact: the session's Artifacts tab on it (the Artifacts page when its session is gone); a todo: its session's chat (the todo strip); History: the History page.

The chat loads its newest page (1,000 events, D95). When the event is not in the window the session has in this tab, the chat reads **`GET /api/sessions/{id}/events?limit=1000&around={eventId}`** instead: ⌊999 / 2⌋ = 499 events before it, the event, and up to 500 after it (a side that has fewer is not filled from the other). The window then may not reach the session's end:
- a **cursor** at its first event when its older side was full (*Show earlier messages*, as D95);
- **`newer`** at its last event when its newer side was full: a row under the messages, *Show later messages* (also when scrolled within 600 px of the end; `?after={eventId}&limit=1000`) and *Jump to latest* (the newest page, as when the session opens). While the window does not reach the end the chat never follows new items, `/hub` events newer than it wait and are added with the last page, and the window is not written to the per-tab cache (a revisit would miss the newest).

Once the event is in the chat it is scrolled to the middle of the conversation and highlighted for 2.6 s (`data-search-hit`, a ring in the status-need color that fades; reduced motion: no fade). Chat items carry their event id (`data-event-id`: user bubbles, agent blocks, step lines); a step line is highlighted itself.

A machine without `around` answers its newest page or every event; the chat takes that as the newest page.

## Search page
`/search` (`SearchView.tsx`, `search.css`), not in the prototype: it follows the Artifacts page (head, title, chips, rows) and the design tokens. The field (focused on open), the scope chips (**All · Conversations · Artifacts · Todos · History**; All shows each group's count on its chip), then the groups with results, each with its count (`5 of 42`) and *Show all* (picks that chip; one chip pages with *Show more*). Within a group the results come by machine (this machine first, then each paired machine) when any is a peer's. A row: its kind (You / Agent / Note / Prompt / the tool's name / Session / Artifact / Todo / History), its heading (the session's title for a message; the item's own title, highlighted, otherwise), the snippet (two lines at most) and its age. ↑ ↓ move the selection, Enter opens it. The query and the chip live in the address (`/search?q=…&scope=…`; typing replaces the entry, so Back leaves the page), the search runs 180 ms after the last key, and a late answer never replaces a newer one. Notes: *Indexing older history… n%*, *Not searched: Acme laptop (offline)*, *Search failed*.

**Opening it:** ⌘⇧F / Ctrl+Shift+F (on the page: back to the field); on tablets and phones the app bar's search button (before the Inbox); the palette's last search row. No sidebar item (the prototype's nav is compared by the visual oracle).

**Responsive** (`docs/responsive.md`): under 1024 px the head's edges tighten, the chips scroll sideways, the app bar carries the title; under 640 px a row is two lines (kind and age, then the text). Nothing overflows the width at 360 / 768 px (`tests/e2e/search.spec.ts`).

## Palette
In the ⌘K palette a query starting with **`?`** searches everything (`?invoice`): up to 8 of the best results (in group order), each opening where the page's row does, then *All results for "invoice"*, which opens the Search page. `?` alone shows *Search everything…*. The palette's other behavior is unchanged (no row is added to a normal query: its rows are compared with the prototype).

## Devices and peers
`GET /api/search` is allowed to paired devices (D73: a read) and is on the peer API (`PEER_API_ALLOW`).

## Performance
`node tools/bench/search.ts [--runs n] [--out file.json]` on the D95 bench world (31,819 events in 5 sessions, seeded before the server starts so the backfill runs). Measured with this change (30 runs a query, after a warm-up):

| Query | Matches | p50 | p95 |
|---|---|---|---|
| a word in most messages (`upload`, all scopes) | 27,674 | 52 ms | 55 ms |
| two common words | 26,403 | 52 ms | 60 ms |
| a phrase | 94 | 15 ms | 16 ms |
| a prefix (`retr*`) | 27,701 | 53 ms | 54 ms |
| a rare word (`file-12`) | 394 | 4.3 ms | 4.6 ms |
| no match | 0 | 0.3 ms | 0.4 ms |
| one scope, 20 results | 26,417 | 53 ms | 56 ms |
| one session (13k events) | 10,731 | 41 ms | 44 ms |
| **all 270** | | **41 ms** | **55 ms** |

The cost is counting and ranking every match (the synthetic history repeats a 30-word vocabulary, so most words match nearly every message: the worst case); a rare word is a few ms. Backfill: done 4.0 s after the server started (1.5 s start delay included); meanwhile `GET /api/sessions` answered p50 1.1 / p95 31 ms and the big session's newest page p50 11 / p95 37 ms. Index: 17.1 MB of a 127 MB database.

## Tests
`tests/server/search/index.test.ts` (indexing per event type, cut / binary text, consistency on every delete path, ranking, phrases, prefix, cursor paging, FTS syntax never run, backfill in steps and resume), `tests/server/search/fan-out.test.ts` (merge by score, namespacing, failures listed, no re-fan-out, remote session), `tests/server/api/search.test.ts` (the route, 422s, `indexing` while the backfill waits, the device and peer allow lists), `tests/server/peers/search.test.ts` (two real servers: find, open `around` through the proxy, degrade when the peer stops), `tests/server/api/sessions.test.ts` (`around=` / `after=`), `tests/web/search.test.ts` (the window around an event, the page and palette model, the addresses), `tests/e2e/search.spec.ts` (the page, the deep link outside the newest page, chips, keyboard, palette, design against the Artifacts page, phone and tablet).
