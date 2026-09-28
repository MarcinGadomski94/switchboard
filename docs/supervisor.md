# Session supervisor (M2.1)

`src/server/supervisor/` runs one long-lived `claude` process per session and is the only code that spawns the CLI for sessions. The flags, the protocol and the pause semantics come from the M0 spike (`docs/spike-m0.md`) and `docs/handoff/ARCHITECTURE.md` → *Claude Code integration*; D6 and D7 in `docs/decisions.md` win where they differ. What the stream turns into is in `docs/derivations.md`.

## Files
| File | Role |
|---|---|
| `argv.ts` | The baseline argv, the child env scrub, the handoff command. |
| `process.ts` | `ClaudeProcess`: `spawn(cmd, args, { shell: false })`, stdout split into lines, stdin JSON lines, stderr tail, exit. `exited` resolves only after stdout is drained. |
| `recorder.ts` | `StreamRecorder`: one per process; stores events, agents, artifacts, usage readings and the session's CLI fields, and keeps the bookkeeping the status is derived from. |
| `supervisor.ts` | `SessionSupervisor`: start, message, pause, resume, detach, attach, respond, shutdown; the status; notifications for `/hub`; the restart-recovery steps (`resumeAfterRestart`, `settleAfterCrash`, `markPausedAfterRestart`, `recordServiceEvent`); `idleLiveSessionIds` + `controlRequest` (a stdin control request between turns, M9.2's `get_usage`, `docs/usage.md`). |
| `recovery.ts` | `recoverSessions` (M2.4, D7): what the service does at start with the sessions it finds; `stopProcess`, `claudeAgentsLister`. |
| `../sessions/wire.ts`, `../sessions/validate.ts` | API shapes (Session, SessionDetail, SessionEvent) and NewSession validation. |

## Spawning
```
<SWITCHBOARD_CLAUDE_BIN…> -p --input-format stream-json --output-format stream-json --verbose
    --permission-prompt-tool stdio --permission-mode acceptEdits
    --session-id <new uuid> | --resume <claudeSessionId>
    --name <session name> --forward-subagent-text --replay-user-messages
    <SWITCHBOARD_CLAUDE_EXTRA_ARGS…>
```
- cwd = the session's own place (D14, `docs/folders.md`): `SessionSupervisor.start(input, { folder, cwd }, …)` gets the folder the session starts in and its working folder: the workspace root for a workspace folder; the repo, or its worktree `../{repo}-wt-{name}` when Worktree is on, for a repo folder. The cwd is canonicalized with `fs.promises.realpath` and stored as `sessions.cwd`, the folder as `sessions.folder_id` / `root` / `root_kind`; a folder that is gone refuses the start (`409 folder-missing`). Every later spawn (resume, a message to a paused session, attach, restart recovery) runs in that stored cwd, never in a global root. Without a saved folder `POST /api/sessions` answers `409 no-folder` before the supervisor is asked.
- No prompt argument: the first message is the first stdin line. `POST /api/sessions` passes the task followed by the confirmed session-start answers (M5.2, `docs/new-session.md` → *First-turn payload*). An empty task starts the process idle; the route then queues the answers in the outbox (kind `session-start`) for the developer's first message.
- `--permission-mode acceptEdits` on **every** spawn (D6 fallback; the mode is not inherited on `--resume`). The `initialize` → `set_permission_mode auto` switch is documented in the spike and not enabled.
- No `--settings`: questions and permissions need no hooks (M0.2). D6 still allows a Switchboard-owned settings file if a later need appears; workspace/user settings files are never edited.
- Child env = the service's env without `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`; `CLAUDE_CONFIG_DIR` and everything else pass through.
- The pid is stored in `sessions.pid` while the process lives; `null` after it ended.

## Stdout, stdin
- Lines are handled strictly in order through a per-process queue (parse → record → derive status → notify), and the exit is handled after the last line.
- A `control_request` subtype Switchboard does not handle (anything but `can_use_tool`) gets `{"type":"control_response","response":{"subtype":"error","request_id":…,"error":"Switchboard does not handle control request subtype \"<x>\""}}` at once, so the CLI never waits on it.
- `can_use_tool` requests stay open (session `need`) until `respond(sessionId, requestId, decision)` writes the one `control_response` line. The question pipeline (M3.1, `docs/questions.md`) plugs in through `ControlRequestHandler` (`canUseTool`, `cancelled`, `orphaned`, `pendingDelivered`) and answers through `respond`; stale answers go out through `sendToLive` (a user message only to a live process that is not being stopped; `false` = nothing written, never spawns) or the outbox. The supervisor itself stores no question batches or permission items. A cancelled request (`control_cancel_request`) or one still open when the process ends is never answered.
- Messages: `POST /messages` writes one stdin user line. A message sent while a turn runs is queued by the CLI (M0.1) and counted as another pending turn.

## Pause, resume, detach, attach (D7, M0.4)
- **Pause** = mark the stop (`sessions.stop_reason`) → stdin interrupt `control_request` → wait for its `control_response` and, when a turn was running or a request was open, for the turn's `result` → close stdin (EOF) → wait for the exit → on timeout SIGINT, then SIGTERM, then SIGKILL. Timeouts: 5 s for the ack, 10 s for the result, 10 s for the exit after EOF, 3 s after each signal. The exit then means `paused` whatever its code (0 idle, 1 mid-tool or with a question open). The lifecycle event records the code, the signal and how it ended (`stoppedBy`: `eof` or the last signal sent). The pause call returns after the process has ended.
- **Resume** = `--resume <claudeSessionId>` (same id, same flags) + the stdin message `Continue.`. Refused while the session is detached or already live.
- **A message to a paused (or ended) attached session** resumes it the same way but sends the message instead of `Continue.`.
- **Continue in terminal** (`/detach`) = the pause stop, then `attached = false` and `{ resumeCommand: "claude --resume <claudeSessionId>" }` (prototype copy). While detached, messages and Resume answer `409 detached`: the terminal owns the session.
- **Attach here** (`/attach`) = the terminal check, the sync back, then spawn `--resume` with the same flags and **no** message: the process stays idle (status `idle`), writes nothing and makes no model call until the developer writes (M0.4). When the session already has a live process nothing is spawned (never two live processes on one id). Details below (*Attach here*, M4.1).
- **Service shutdown** (app close) stops every process with the same sequence but keeps each session's stored status, so a restart can resume `run` / `need` sessions (D7, M2.4, below). New sessions, messages, Resume and Attach are refused (`503 closing`) while it shuts down.

## Attach here (M4.1, gap #5, M0.4)
`src/server/supervisor/attach.ts` (file access, the check, the import) + `src/core/transcript-sync.ts` (pure: which entries are new, what they show). `SessionSupervisor.attach(id, { confirm })`; calls on one session run one at a time, so two clicks never spawn two processes.

1. **Live already?** Nothing happens; `{ resumeCommand }`.
2. **The warning** (skipped with `confirm: true`). Two live processes on one id silently fork the conversation (M0.4 `handoff-conc`), so Switchboard asks first when a terminal may still hold the session:
   - `transcript-recent`: the transcript's mtime is less than 2 minutes ago (gap #5);
   - `terminal-live`: `claude agents --json` lists the session id (an idle interactive terminal does not touch the file, M0.3); the list comes from `claudeAgentsLister` (recovery.ts) with the configured CLI, run in the session's cwd (D14), passed as `SupervisorOptions.listLive` (app.ts);
   - `liveness-unknown`: that list could not be read (or no lister was given).
   Any reason → `AttachWarningError` → `409 { error: "attach-warning", message, reasons }`; nothing is spawned or written. The UI shows the warning and repeats the call with `{ "confirm": true }` ("Attach anyway").
3. **Sync back.** stdout never replays history, so the turns the terminal added are read from the transcript and stored as events **before** the spawn:
   - The transcript is `<configDir>/projects/*/<claudeSessionId>.jsonl` (configDir = `CLAUDE_CONFIG_DIR` from the children's env, else `~/.claude`); every project folder is checked (the slug is lossy, M0.3) and the newest file wins if the id is in two. No file → nothing to import. Read only; Switchboard never writes there.
   - New entries = the newest leaf's `parentUuid` chain after the sync point `sessions.last_transcript_uuid` (the newest main-chain uuid seen on stdout, `docs/derivations.md`). A sync point on an older branch (the file forked) → the entries after the fork point; no sync point yet → the whole chain; a sync point missing from the file → nothing is imported and an `error` event "Could not sync the terminal's turns" says so. `logicalParentUuid` links a chain across a compaction boundary.
   - Each new prompt → a `user` event with origin `terminal` (delivered); assistant text blocks of one message → one `assistant` event; `tool_use` → a `tool` event (kind per gap #7) closed by its `tool_result` (`endTs`, `result`, `isError`). Skipped: `model:"<synthetic>"` lines, `isMeta` lines, interrupt markers, thinking blocks, attachment / system entries, entries already stored (same uuid). Events carry the **transcript's timestamps**, so they sit between "Continued in a terminal" and "Attached" (a client that polls `/events?since=` with its newest `ts` would miss them; the UI uses the `/hub` `event` stream). All go to the main agent. Not derived from terminal turns: subagents and artifacts (the Diff tab reads git, M4.5).
   - The sync point moves to the chain's tip; `lastActivityAt` to the newest imported event.
   - A failure to read or parse is recorded as an `error` event and the attach goes on.
4. **Spawn** `--resume <claudeSessionId>` with the baseline flags (`--permission-mode` and `--name` again), `attached = true`, lifecycle `attached`, status `idle`.

Oracle: `tests/server/supervisor/attach.test.ts` (fake-claude, a text-mode `claude -p --resume <id> "<prompt>"` run as the terminal: the warning reasons, the import, the argv, no duplicates on a second attach, concurrent attaches), `tests/core/transcript-sync.test.ts` (the M0.4 transcript fixtures: one chain, the synthetic line, the forked file), `tests/e2e/session-handoff.spec.ts` (the UI flow on the real path).

## Restart recovery (M2.4, D7)
`src/server/supervisor/recovery.ts` → `recoverSessions`, called by `main.ts` once at start, **right after the server has bound its port** (a second instance that cannot bind exits before it touches anything: recovering first would let it stop and re-spawn the running instance's processes), and only in normal runs (the demo's sessions are not real). While it runs, reads are served but `sendMessage`, `pause`, `resume`, `detach` and `attach` wait (`SessionSupervisor.holdCommands()`), so no command can spawn a second process on an id whose leftover is still being stopped; closing the app waits for it too. A failure is logged and the service keeps running. Not guarded: a second instance on **another** port with the **same** data folder (single instance per data folder is assumed, as for the database).

Candidates: every session with a recorded `pid` (its process was live when the service died: a clean shutdown clears the pid, a crash does not) and every attached `run` / `need` session. No candidates → nothing runs, not even `claude agents --json`. Sessions are handled in parallel; for each:
1. **Leftover.** If the recorded pid is alive, `claude agents --json` (the configured CLI, scrubbed child env, cwd = the session's cwd (D14); read once per cwd per start) must list that pid **with the session's `claudeSessionId`**. Then it is stopped: SIGINT, then SIGTERM, then SIGKILL, each followed by up to 3 s of polling (there is no stdin left to interrupt it). A lifecycle event `leftover-stopped` records `leftoverPid` and `stoppedBy`. A live pid listed under another id, or not listed, belongs to another program now (pid reuse) and is never signalled. If the list cannot be read, or the leftover survives SIGKILL, the session is not resumed (step 4).
2. **Crash clean-up** (only with a recorded pid): requests still marked open in the events become `stale` (never answered, M0.2) and go to `ControlRequestHandler.orphaned`, running subagents become `idle`, the pid is cleared.
3. Sessions that are not attached `run` / `need` stop here (a live-but-idle `done` session is only cleaned up; `paused`, detached and ended sessions are untouched). A **pause or "Continue in terminal" the crash cut short** (`stop_reason` `pause` / `detach` still set) is finished instead of resumed: `paused` (detach also ends the attachment) + its lifecycle event with `message: "finished after a Switchboard restart"`.
4. **Never two live processes on one id** (M0.4): when the id is listed under another live pid (e.g. a terminal opened while the service was down), or step 1 could not make sure, the session is left `paused` with an `error` lifecycle event `not-resumed` whose message says why. Resume stays the developer's call.
5. **Resume** = `--resume <claudeSessionId>` with the baseline flags (`resumeAfterRestart`, lifecycle `recovered`):
   - `run` → the stdin message `Switchboard restarted. Continue.` (origin `service`);
   - `need` → no message: the process stays idle (status `idle`; the old request is stale). The note `Switchboard restarted.` waits in the session's outbox (`pending_messages`, kind `restart-note`, queued once) and goes out with the session's next message, i.e. its answers once they are given.

**Outbox.** Every stdin user message the supervisor writes (`start`, `sendMessage`, `resume`, `resumeAfterRestart`) first takes the session's undelivered `pending_messages`, oldest first, and sends them in the **same** message ahead of the text, separated by a blank line (`Switchboard restarted.\n\n<answers>`); they are marked delivered once written. One message = one turn. M3.1 delivers a stale batch's answers through `sendToLive(sessionId, text)` when the session has a live process, else enqueues them (kind `stale-answers`), and the restart note rides along; the `pendingDelivered` hook tells the pipeline when queued ones went out.

Oracle: `tests/server/supervisor/restart.test.ts` runs `src/server/main.ts` as a child process with fake-claude, SIGKILLs it while one session is in a `hang` turn and another has an open `ask-2q` question, restarts it on the same data folder and checks: the leftover `hang` process is gone (stopped with SIGINT), the new processes use `--resume` with the same ids and the baseline argv, the fake's live-process files (`sessions/<pid>.json`) never show two live processes on one id, the `run` session got the restart message, the `need` session got nothing until its stale batch was answered through `POST /api/questions/batch/{batchId}/answers` (M3.1), whose answers then carried the note; a second instance started on the same port exits 1 without touching the processes. `tests/server/supervisor/recovery.test.ts` covers the other rules in process.

## REST (contract rows served at this layer)
| Route | Behavior |
|---|---|
| `GET /api/sessions` | `Session[]` newest first, with agents and the open question count; since M4.1 also `cwd`, `live` (a pid is recorded), `resumeCommand` and the header `chips` (`docs/derivations.md` → *Session chips*). |
| `POST /api/sessions` | Resolves the session's folder (D14: `folder`, else the default; `409 no-folder` / `folder-missing`, 422 for an unknown id), validates NewSession for it (every failure `422 {error:"invalid", errors:[{field,message}]}`, a duplicate name included; a repo folder allows only its own solution), creates the worktrees when `worktrees` is true (M2.2, `docs/worktrees.md`; linked through `start(…, { beforeSpawn })`), stores the session with its folder and cwd, creates the main agent, starts the process; `201` + Session (with `folder`, `folderPath`, `folderKind`, `cwd`). |
| `GET /api/sessions/{id}` | SessionDetail: the Session + `task`, the newest 200 events, `files` from the diff provider (M4.5; empty until then), artifacts, and (M4.2) `questions`: every question batch of the session (`docs/chat.md`). |
| `POST /api/sessions/{id}/messages` | `{ text }` (non-empty) → `202`. |
| `POST /api/sessions/{id}/pause`, `/resume` | The Session after the stop / after the new process got its message. |
| `POST /api/sessions/{id}/detach`, `/attach` | `{ resumeCommand }`. `/attach` takes an optional `{ confirm: true }`; without it a terminal warning answers `409 { error: "attach-warning", message, reasons }` (M4.1, *Attach here*). |
| `GET /api/sessions/{id}/events?since=` | Events with `ts` strictly after `since` (any ISO date; `422` otherwise), oldest first. |

Unknown ids answer `404 {error:"not-found"}`; supervisor refusals `409 {error:<code>, message}`. `GET /api/sessions/{id}/diff` stays 501 until M4.5.

Read-only solutions are refused with `422` when a name is a `deprecated/…` or `infrastructure` path, and, with the workspace scan (M6.1, `providers.solutions`), when the router's folder rules make it read-only (`docs/solutions.md` → *Read-only sessions*).

## Notifications
`supervisor.on('sessionUpdated' | 'event', listener)` delivers the contract's `/hub` payloads (`Session`, `{ sessionId, event }`) on every status/attachment change and every event insert or update (a merged assistant text or a closed tool call re-sends the event with the same `id`). M2.3 forwards them over SSE (`forwardServiceEvents`, `docs/hub.md`).

## Tests
`tests/server/supervisor/supervisor.test.ts` drives the supervisor against `tools/fake-claude` (a temp workspace folder passed as each session's place, `CLAUDE_CONFIG_DIR`, `FAKE_CLAUDE_LOG` for argv/env/cwd/stdin), `tests/server/api/sessions.test.ts` the routes through `app.inject`, `tests/core/*.test.ts` the parser over every M0 fixture and the derivations. Stubs made with `node -e` cover the SIGINT → SIGTERM escalation and an unhandled control request.
