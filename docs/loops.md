# Loops run by Switchboard (D94)

Recurring or one-time prompts that **Switchboard** sends into a session, instead of the CLI's own session crons (`/loop`, `CronCreate`, `ScheduleWakeup`). Those die with the CLI process, survive invisibly in some resumes, expire after 7 days without saying so, and `CronList` / `CronDelete` do not always agree with what fires (D93). Developer ruling 2026-10-09: **Switchboard owns the loops**: agents create them through MCP, Switchboard fires them.

Code: rules `src/core/owned-loops.ts` (pure: validation, due times, texts, the tool definitions), storage `src/server/db/repos/session-loops.ts` (migration `0041_session_loops.sql`), the service `src/server/loops/owned.ts` (`LoopService`: commands + the timer), routes `src/server/api/loops.ts`, the MCP tools in `src/hook/sb-mcp.ts`, the UI `src/web/views/OwnedLoops.tsx` + `owned-loops.ts`. Tests: `tests/core/owned-loops.test.ts`, `tests/server/loops/owned.test.ts`, `tests/server/loops/owned-api.test.ts`, `tests/server/peers/owned-loops.test.ts`, `tests/web/owned-loops.test.ts`, `tests/e2e/owned-loops.spec.ts`.

## The agent's tools
In the built-in `switchboard` MCP server (D68: same helper, same per-session agent token, same injection into Claude Code / Codex / OpenCode), annotated like the todo and artifact tools:

| Tool | Input | Hints |
|---|---|---|
| `loop_create` | `prompt` (required), exactly one of `cron` (5 fields, machine-local time) / `every_minutes` (1–44 640) / `at` (ISO 8601, in the future), optional `expires_at` (ISO, in the future; leave out = no expiry), `max_runs` (1–100 000), `label` (≤ 60) | write, not destructive |
| `loop_list` | — | read-only |
| `loop_update` | `id` + any of the create fields (one schedule field replaces the schedule; `null` removes the expiry / run limit) | write, destructive, idempotent |
| `loop_pause` / `loop_resume` | `id` | write, idempotent |
| `loop_cancel` | `id` | destructive (the loop is removed) |

The descriptions and the server's instructions tell agents to prefer these over `CronCreate`, `ScheduleWakeup` and `/loop` for anything recurring or scheduled; the default standing instruction (D64) has one line about it. A validation error comes back as a tool error with the field's message (e.g. "every_minutes must be a whole number of minutes, 1–44640"). Answers print `[id] title · schedule · next: <UTC ISO> · expires: <UTC ISO | no expiry> · runs: n [of max] [(k skipped)] · state` and the prompt. The agent token reaches only its own session's loops (another session's id answers not found).

## Firing
One timer for all loops (the scheduler's clock and 60 s bound, `SchedulerClock`), one queue (commands and firings never interleave). At each due time the prompt goes into the session as a **message with origin `service`** carrying `loop: { id, label, run }` (`UserPayload.loop`), through the usual path:
- **idle** → sent now; **busy** (a turn runs, it waits on the developer) → queued behind the turn (D44's clock);
- **at most one firing waits**: while the previous firing's message has not been taken up (still `queued`, not withdrawn / not sent), a due time is **skipped** (counted, `lastError` "the previous firing has not been taken up yet"); never stacked;
- **paused** (no process) → the message resumes the session (`--resume`, as any message does);
- **hooked terminal session** → the hook mailbox (D48 P4: delivered to the next waiter; a waiting firing holds the next one back);
- **closed** → the loop **ends** (`session closed`; `the session moved to <machine>` after a take-over); continued in a terminal / being taken over / the message refused (e.g. a slash command to a hooked session) → skipped with the reason;
- **Run now** → one firing at once (counts as a run, the schedule unchanged), refused while one waits (409 `pending`) or for a closed session / ended loop.

**No catch-up:** due times missed while Switchboard was not running (or the machine slept, or the timer was late) are counted as skipped and only the next due time fires; `every` keeps its rhythm (created + n × interval). At start, an active loop whose time passed waits for its next due time (no firing at start); a one-shot whose time passed ends (`missed: Switchboard was not running at its time`).

**Ends:** at `expires_at` (`expired`; default none: until cancelled), after `max_runs` firings (`ran n times (max_runs)`), a one-shot after its firing, a closed session. Ended loops stay listed for the agent (`loop_list` says why) and are removed 7 days later; Cancel removes a loop at once. A session keeps at most 20 loops that have not ended.

**Moves with the session:** process restarts, resumes and Switchboard restarts (the rows are in the database); D72 Continue in Switchboard (same session record); D83 fresh session (the loops move to the new session, ids and counts kept); D65 take-over (re-created on the target with new ids, next due time from then; ended on the source).

## UI
- **Schedules & loops:** a **Loops** line with **+ New loop** above the cards; each Switchboard loop is a card (first): session, `⟳ <title>`, Open session, the prompt's first line, **Schedule** (`every 30 min`, the cron's preview, `once at …`), **Next** (exact: today's clock / `tomorrow 02:00` / weekday; the full time as a tooltip; `paused`), **Expires** (`in 6 days` or `no expiry`), **Runs** (`12 of 20 (3 skipped)`), "Run by Switchboard · active / paused" (+ the last skip's reason), actions **Pause / Resume**, **Run now**, **Edit**, **Cancel** (with a confirmation). The CLI's own loops keep their D9 / D93 cards (the unlisted-schedule card included), tagged **Managed by the CLI**.
- **The session:** a strip above the composer lists its active and paused loops with the same actions; the chat shows a firing with the chip **⟳ <label> · run <n>** above its bubble.
- **New loop…:** the session's ⋯ menu (sidebar row) or + New loop (with a session picker): prompt, schedule (Every n minutes / Cron / Once at), Expires (empty = no expiry), Max runs, Label. Edit opens the same dialog.
- Live through `sessionUpdated` (`Session.ownedLoops`, additive); no new hub event.

## Peers and devices
A paired machine's session's loops are read and changed through the proxy (`/api/sessions/r~<machine>~<id>/loops…`, on `PEER_API_ALLOW`); they fire on that machine. Its `Session.ownedLoops` carry the namespaced session id; the loop ids stay raw. Paired devices (D73) may list, create, edit, pause / resume, run now and cancel (normal use).
