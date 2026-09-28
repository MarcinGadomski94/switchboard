# Session supervisor (M2.1)

`src/server/supervisor/` runs one long-lived `claude` process per session and is the only code that spawns the CLI for sessions. The flags, the protocol and the pause semantics come from the M0 spike (`docs/spike-m0.md`) and `docs/handoff/ARCHITECTURE.md` → *Claude Code integration*; D6 and D7 in `docs/decisions.md` win where they differ. What the stream turns into is in `docs/derivations.md`.

## Files
| File | Role |
|---|---|
| `argv.ts` | The baseline argv, the child env scrub, the handoff command. |
| `process.ts` | `ClaudeProcess`: `spawn(cmd, args, { shell: false })`, stdout split into lines, stdin JSON lines, stderr tail, exit. `exited` resolves only after stdout is drained. |
| `recorder.ts` | `StreamRecorder`: one per process; stores events, agents, artifacts, usage readings and the session's CLI fields, and keeps the bookkeeping the status is derived from. |
| `supervisor.ts` | `SessionSupervisor`: start, message, pause, resume, detach, attach, respond, shutdown; the status; notifications for `/hub`. |
| `../sessions/wire.ts`, `../sessions/validate.ts` | API shapes (Session, SessionDetail, SessionEvent) and NewSession validation. |

## Spawning
```
<SWITCHBOARD_CLAUDE_BIN…> -p --input-format stream-json --output-format stream-json --verbose
    --permission-prompt-tool stdio --permission-mode acceptEdits
    --session-id <new uuid> | --resume <claudeSessionId>
    --name <session name> --forward-subagent-text --replay-user-messages
    <SWITCHBOARD_CLAUDE_EXTRA_ARGS…>
```
- cwd = the workspace root (`SWITCHBOARD_WORKSPACE_ROOT`, canonicalized with `fs.promises.realpath`, stored as `sessions.cwd`). No workspace root → no session can start (`409 workspace-not-configured`).
- No prompt argument: the first message (the task text; M5.2 adds the confirmed session-start answers) is the first stdin line. An empty task starts the process idle.
- `--permission-mode acceptEdits` on **every** spawn (D6 fallback; the mode is not inherited on `--resume`). The `initialize` → `set_permission_mode auto` switch is documented in the spike and not enabled.
- No `--settings`: questions and permissions need no hooks (M0.2). D6 still allows a Switchboard-owned settings file if a later need appears; workspace/user settings files are never edited.
- Child env = the service's env without `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`; `CLAUDE_CONFIG_DIR` and everything else pass through.
- The pid is stored in `sessions.pid` while the process lives; `null` after it ended.

## Stdout, stdin
- Lines are handled strictly in order through a per-process queue (parse → record → derive status → notify), and the exit is handled after the last line.
- A `control_request` subtype Switchboard does not handle (anything but `can_use_tool`) gets `{"type":"control_response","response":{"subtype":"error","request_id":…,"error":"Switchboard does not handle control request subtype \"<x>\""}}` at once, so the CLI never waits on it.
- `can_use_tool` requests stay open (session `need`) until `respond(sessionId, requestId, decision)` writes the one `control_response` line. The question pipeline (M3.1) plugs in through `ControlRequestHandler` (`canUseTool`, `cancelled`, `orphaned`) and answers through `respond`; M2.1 itself stores no question batches or permission items. A cancelled request (`control_cancel_request`) or one still open when the process ends is never answered.
- Messages: `POST /messages` writes one stdin user line. A message sent while a turn runs is queued by the CLI (M0.1) and counted as another pending turn.

## Pause, resume, detach, attach (D7, M0.4)
- **Pause** = mark the stop (`sessions.stop_reason`) → stdin interrupt `control_request` → wait for its `control_response` and, when a turn was running or a request was open, for the turn's `result` → close stdin (EOF) → wait for the exit → on timeout SIGINT, then SIGTERM, then SIGKILL. Timeouts: 5 s for the ack, 10 s for the result, 10 s for the exit after EOF, 3 s after each signal. The exit then means `paused` whatever its code (0 idle, 1 mid-tool or with a question open). The lifecycle event records the code, the signal and how it ended (`stoppedBy`: `eof` or the last signal sent). The pause call returns after the process has ended.
- **Resume** = `--resume <claudeSessionId>` (same id, same flags) + the stdin message `Continue.`. Refused while the session is detached or already live.
- **A message to a paused (or ended) attached session** resumes it the same way but sends the message instead of `Continue.`.
- **Continue in terminal** (`/detach`) = the pause stop, then `attached = false` and `{ resumeCommand: "claude --resume <claudeSessionId>" }` (prototype copy). While detached, messages and Resume answer `409 detached`: the terminal owns the session.
- **Attach here** (`/attach`) = spawn `--resume` with the same flags and **no** message: the process stays idle (status `idle`), writes nothing and makes no model call until the developer writes (M0.4). When the session already has a live process nothing is spawned (never two live processes on one id). The "terminal still open" warning and the import of the terminal's turns from the transcript are M4.1's.
- **Service shutdown** (app close) stops every process with the same sequence but keeps each session's stored status, so a restart can resume `run` / `need` sessions (D7, M2.4). New sessions, messages, Resume and Attach are refused (`503 closing`) while it shuts down.

## REST (contract rows served at this layer)
| Route | Behavior |
|---|---|
| `GET /api/sessions` | `Session[]` newest first, with agents and the open question count. |
| `POST /api/sessions` | Validates NewSession (every failure `422 {error:"invalid", errors:[{field,message}]}`, a duplicate name included), creates the worktrees when `worktrees` is true (M2.2, `docs/worktrees.md`; linked through `start(…, { beforeSpawn })`), stores the session, creates the main agent, starts the process; `201` + Session. `409` without a (usable) workspace root. |
| `GET /api/sessions/{id}` | SessionDetail: the Session + `task`, the newest 200 events, `files` from the diff provider (M4.5; empty until then), artifacts. |
| `POST /api/sessions/{id}/messages` | `{ text }` (non-empty) → `202`. |
| `POST /api/sessions/{id}/pause`, `/resume` | The Session after the stop / after the new process got its message. |
| `POST /api/sessions/{id}/detach`, `/attach` | `{ resumeCommand }`. |
| `GET /api/sessions/{id}/events?since=` | Events with `ts` strictly after `since` (any ISO date; `422` otherwise), oldest first. |

Unknown ids answer `404 {error:"not-found"}`; supervisor refusals `409 {error:<code>, message}`. `GET /api/sessions/{id}/diff` stays 501 until M4.5.

Read-only solutions are refused with `422` when a name is a `deprecated/…` or `infrastructure` path, and, once the workspace scan exists (M6.1, `providers.solutions`), when the scan marks it read-only.

## Notifications
`supervisor.on('sessionUpdated' | 'event', listener)` delivers the contract's `/hub` payloads (`Session`, `{ sessionId, event }`) on every status/attachment change and every event insert or update (a merged assistant text or a closed tool call re-sends the event with the same `id`). M2.3 forwards them over SSE (`forwardServiceEvents`, `docs/hub.md`).

## Tests
`tests/server/supervisor/supervisor.test.ts` drives the supervisor against `tools/fake-claude` (temp workspace root and `CLAUDE_CONFIG_DIR`, `FAKE_CLAUDE_LOG` for argv/env/cwd/stdin), `tests/server/api/sessions.test.ts` the routes through `app.inject`, `tests/core/*.test.ts` the parser over every M0 fixture and the derivations. Stubs made with `node -e` cover the SIGINT → SIGTERM escalation and an unhandled control request.
