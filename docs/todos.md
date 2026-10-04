# Session todos (D68)

Every session has a todo list: things that still need doing. The developer keeps it in the session (and on the Todos page); the session's agent keeps it through built-in MCP tools, so "add it to the todo list" in the chat lands on the same list. Ruling: `docs/decisions.md` → D68. Contract: `docs/handoff/contracts/local-api.md` → *Session todos (D68)*.

## Storage
- Migration **0026** (`session_todos`, `docs/database.md`): id, session, text, state (`open` / `done`), who added it (`developer` / `agent`), position, created / updated, `done_at`. Deleting a session deletes its items.
- `src/server/db/repos/todos.ts` (the rows), `src/server/todos/service.ts` (`TodoService`: validation, events, the hour's removal), `src/core/todos.ts` (the shared rules and the tool definitions).
- Text is trimmed, 1–1,000 characters; a session keeps at most 200 items (open and done together), so a runaway agent stops with `409 too-many`.

## Done items
- A ticked item stays visible (struck through, under a collapsed **Done (n)**) and is **removed automatically one hour after it was ticked**, earlier by its ✕ or **Clear done**. Unticking it before the hour cancels the removal (its `done_at` is cleared).
- Server side: `TodoService.start()` sweeps at startup (items whose hour passed while Switchboard was stopped go at once), then a timer is armed for the earliest `done_at` + 1 hour, re-armed after every change and every sweep. The hour is computed from the stored `done_at`, so a restart keeps it. Every item answer carries `removeAt`.

## The agent's tools
- Every session Switchboard **starts or resumes** (new, resume, restart recovery, Attach here, account and CLI switches, take-over) gets an MCP server named **`switchboard`** with five tools: `todo_list`, `todo_add` (text), `todo_update` (id, text), `todo_done` (id; `done: false` reopens), `todo_remove` (id). Items show their id in brackets in every tool answer (`[3f9a1c2b7d4e] ☐ Fix the login test`), so the agent can name them.
- The server is a small stdio helper, `src/hook/sb-mcp.ts` (no dependencies, run by Switchboard's own Node like the hook script), started by the CLI as `node sb-mcp.ts --switchboard-mcp <port> <sessionId>` with the session's **agent token** in `SWITCHBOARD_TODO_TOKEN`. It speaks MCP over stdio (`initialize`, `tools/list`, `tools/call`, `ping`) and turns each call into one request to `http://127.0.0.1:<port>/agent/v1/todos`. Failures (Switchboard stopped, an unknown id) are tool errors the agent can read.
- **Scope:** the agent token is HMAC-SHA256 of the session id under the install's secret (`src/server/todos/agent-token.ts`): it opens that one session's list and nothing else (no `/api`, no other session; an item id of another session is 404). See `docs/security.md` → *Agent todo tools (D68)*.
- **Injection** (`src/server/todos/agent-mcp.ts`, `SpawnRequest.agentMcp`), added to the developer's own MCP configuration, never replacing it, and never writing their files:
  - **Claude Code:** `--mcp-config <dataDir>/agent-mcp/<session id>.json` (0600, rewritten at every spawn, so the token is not on the argv) and `--allowedTools mcp__switchboard` (its tools run without a permission prompt). No `--strict-mcp-config`: the developer's user / project / local servers load as before. VERIFIED with one bounded real probe (CLI 2.1.285, Haiku, an isolated config folder): `system/init` lists `switchboard` as `connected` (source `dynamic`) with the five `mcp__switchboard__todo_*` tools. The tool call itself was not run against the model (the isolated folder has no login, by design).
  - **Codex CLI:** `-c mcp_servers.switchboard.command=…`, `.args=[…]`, `.env_vars=["SWITCHBOARD_TODO_TOKEN"]` before `app-server`; the token is in the app-server's own environment. UNVERIFIED (no Codex CLI here; `docs/spike-providers.md` lists the probe).
  - **OpenCode:** an `mcp.switchboard` entry (`type: local`, `command`, `environment`, `enabled`) merged into `OPENCODE_CONFIG_CONTENT` next to the environment's own servers. UNVERIFIED likewise.
- A launch that cannot be prepared (the config file cannot be written) is reported and the session starts without the tools.
- **Not injected:** hand-started hooked terminal sessions (D48 P4): Switchboard does not start their process, so their list is the UI's only. The D61 helper processes, the usage poller and model listings are not sessions either.
- **The MCP page (D61)** does not show the server: it is not in any of the developer's config files, and the page's helper process starts without it.
- **Standing instruction (D64):** the default gains one sentence: "Todo list: when asked to add to it, use the switchboard todo tools; mark items done when finished; check it when asked what's left." A stored text equal to an earlier default reads as the new default (`currentStandingInstruction`); a text the developer edited stays theirs and does not get the sentence (ASSUMED D68-instruction-edited). The server's MCP `instructions` say the same, for CLIs that pass them on.

## In the session
- A collapsible strip just above the composer: **TODO (n)** with the open count (collapsed it also shows the first open item). Expanded (remembered in this browser): the open items with a box to tick, the text (click to edit, Enter saves, Esc cancels), who added it (`you` / `agent`, subtle), ↑ ↓ to reorder and ✕ to delete (on hover / focus); an **Add a todo…** field; and, when there are done items, **▸ Done (n)** (collapsed) with the note "removed an hour after done" and **Clear done**.
- While the list is empty the strip is not shown; a small **+ Todo** pill sits just above the composer's top edge at the right (out of the flow: no part of the chat or the composer moves) and opens the strip with the add field focused.
- Live: `todosChanged` reloads the list, so an item the agent adds shows at once. An unreachable peer's session shows its list read-only.

## Sidebar and Todos page
- A session row with open items shows **☐ n** right of its title, before its age.
- The nav has **Todos** after History (like D61's MCP after the prototype's items, so the prototype's parts keep their places), with the total open count of the listed sessions (this machine's and the paired machines').
- `/todos`: every open session that has items, most recently active first, as a card: the session's title (opens it), its machine tag, where it works (solutions, else the folder), its open count, and its open items with a box to tick (an item's text opens the session). **Show done (n)** adds the done items. Closed sessions are left out.

## Peers (D48) and take-over (D65)
- A paired machine's session's list is read and edited through the peer proxy like every session route (`r~<machine>~<id>`, the routes are on `PEER_API_ALLOW`); answers and `todosChanged` carry the remote ids. The Todos page lists the paired machines' groups as last known (`PEER_LISTS.todos`, snapshotted like the schedules; fetched again when a `todosChanged` arrives from that machine or after an edit through the proxy).
- A take-over carries the list: `SourceInspect.todos` (text, state, author, created, done time), re-created on the new session before the agent's first turn (`beforeSpawn`), so a done item keeps its hour. An older Switchboard sends none: its list stays behind with the moved-away session.
