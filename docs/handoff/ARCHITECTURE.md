# Architecture

> Stack changed on 2026-09-27 by developer ruling: **Node.js**, one project, one process (see `docs/decisions.md`). The .NET plan in the original handoff is superseded.

## Processes (all on the developer's PC)
```
Browser (Switchboard UI, React)  ⇄  Switchboard service (Node.js + Fastify, 127.0.0.1:4870)
                                   ├─ SessionSupervisor → N × `claude` child processes (headless, stream-json)
                                   ├─ WorktreeManager   → git / gh CLI
                                   ├─ Scheduler         → starts sessions from templates on cron
                                   ├─ WorkspaceScanner  → reads the router AGENTS.md + folders
                                   ├─ SQLite (node:sqlite) → sessions, events, questions, artifacts, schedules, settings
                                   ├─ REST /api/*       → per contracts/local-api.md
                                   └─ SSE  /hub         → live events to the UI (Server-Sent Events)
Embedded tools (iframes): Codebase Memory UI (localhost:13000), Acme Tool (URL from settings)
```

**Stack:** Node.js ≥ 24 + TypeScript (strict; the server runs `.ts` directly via Node's type stripping), Fastify for HTTP, React + Vite for the UI (built to `dist/web`, served by the same process), built-in `node:sqlite` with plain SQL migrations, Vitest for unit/integration tests, `@playwright/test` for E2E + screenshots. One `package.json`, one install, one port, cross-platform (Windows, macOS, Linux).

Suggested layout (one package):
```
src/core/     domain types, stream-json parser, derivations, scanner, cron, worktrees (no HTTP)
src/server/   Fastify app: REST, SSE hub, security, supervisor, scheduler, db
src/web/      React UI (Vite root)
tools/fake-claude/   fake CLI + recorded fixtures
tests/        vitest (unit + integration) and e2e/ (Playwright)
```

## Claude Code integration
Confirmed by the M0 spike on CLI 2.1.283 (2026-09-27). Exact commands, captured samples and the reasoning are in `docs/spike-m0.md`; the recorded fixtures are in `tools/fake-claude/fixtures/`. `docs/decisions.md` wins where it differs.

**Process and flags.** Each session is one long-lived `claude` process with cwd = workspace root, so the router AGENTS.md applies. It is started with an argv array (`shell: false`):
```
claude -p --input-format stream-json --output-format stream-json --verbose
       --permission-prompt-tool stdio
       --permission-mode acceptEdits
       --session-id <uuid>              # new session; the uuid is the claudeSessionId
       | --resume <claudeSessionId>     # resume, attach, restart: the id never changes
       --name <session name>            # transcript title; resumes do not duplicate it
       --forward-subagent-text --replay-user-messages
```
- **No prompt argument.** Every user message, the first one included (M5.2), is one stdin line: `{"type":"user","message":{"role":"user","content":"<text>"}}`. Each message runs one turn that ends with a `result`. The process stays alive and idle between turns.
- **Stdin stays open** for the life of the process. EOF lets the running turn finish, then the process exits. Stdin is closed only to pause or stop.
- No `--model` / `--max-turns` in normal runs (the CLI's defaults). The CLI command is configurable (tests point it at `tools/fake-claude`). A dev-only extra-args env var appends flags for the D13 real-CLI smoke (`--model haiku --max-turns 3`).
- **Child env:** drop `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID` and `CLAUDE_EFFORT`, which would tie the child to a parent Claude Code session. Keep `CLAUDE_CONFIG_DIR`, which moves the transcripts.
- **Not used:** `--bg` / `claude attach` (TUI-only sessions: no stream-json, no answers); `--settings` hooks (questions and permissions do not need them; D6 still allows a Switchboard-owned file if a later need appears); `--no-session-persistence` (breaks resume); `--fork-session`; `--append-system-prompt` (not probed).

**Permission mode (D6).** `acceptEdits`, passed on **every** spawn: the mode belongs to the process and is not inherited on `--resume`. D6's fallback applies because M0 could not prove `auto` headless: it is gated by model, and an unsupported `auto` silently becomes `default`, which denies every edit headless. The supervisor compares `system/init.permissionMode` with the requested mode and flags a mismatch. A zero-cost switch to auto is documented in the spike and not enabled: `initialize` → `models[].supportsAutoMode` → `set_permission_mode auto`, staying on `acceptEdits` on any error.

**Auth.** The CLI's own subscription login (`claude auth status` for the wizard; the `initialize` control response also reports `account.subscriptionType`). Switchboard never reads, stores or proxies credentials. No API key.

**Reading stdout** (one JSON object per line):
- `system/init` repeats at the start of every turn. It is a metadata refresh (`permissionMode`, `tools`, `claude_code_version`), not a new session.
- `assistant` lines hold one content block each (thinking, text, or one `tool_use`); merge them by `message.id`. `user` lines carry `tool_result`s (paired by `tool_use_id`), replayed stdin messages (`isReplay: true`, the delivery ack) and interrupt markers.
- `result/*` ends a turn: `success`, `error_max_turns`, or `error_during_execution` after an interrupt. A result with `origin.kind:"task-notification"` has no stdin message behind it; it closes a background agent's work.
- **Subagents:** each `Agent` tool_use (listed as `Task` in `init.tools`) is one agent (gap #8). The subagent's lines carry `parent_tool_use_id`; its lifecycle is `system/task_started` → `task_progress` → `task_updated` → `task_notification`. Agents can run in the background, so the main `result` can come before they finish.
- `rate_limit_event` is a usage reading. `control_request` / `control_cancel_request` feed the question pipeline (below). `system/permission_denied` is an automatic denial.

**Questions and permission requests (M0.2).** `--permission-prompt-tool stdio` is required: without it `AskUserQuestion` is missing and every permission request is denied at once. With it, right after the matching `tool_use` the CLI writes `{"type":"control_request","request_id":…,"request":{"subtype":"can_use_tool","tool_name","input","tool_use_id",…}}` and waits for one stdin reply (20 min proven; no keepalive while it waits).
- `AskUserQuestion` → one question batch (`batchId` = `request_id`). `input.questions[]` = `{question, header, options[{label, description}], multiSelect}`, stored verbatim. Answer: `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow","updatedInput":{<input unchanged>,"answers":{"<question text>":"<option label>"}}}}}`. Only the main agent can ask (subagents have no `AskUserQuestion`), so a question's source is the session's main agent.
- Any other tool → an Inbox permission item with `tool_name` + `input` verbatim, plus `description` and `decision_reason`; `agent_id` (= the subagent's `task_id`) is present when a subagent asks. Allow once = `allow` + `updatedInput` unchanged, **never** `updatedPermissions` (its suggestions write the project's `.claude/settings.local.json`). Deny = `{"behavior":"deny","message":"<fixed text>"}`.
- A request subtype Switchboard does not handle gets `{"subtype":"error","request_id":…,"error":…}`.
- A `control_cancel_request` (after an interrupt), or the process ending, makes an open request **stale**: it is never answered. The model does not re-ask after `--resume`. A stale question batch that is answered later therefore goes to the session as a normal user message when it next runs. A stale permission item closes without a decision.

**Pause, resume, restart (D7).**
- **Pause:** mark the session pausing → stdin `{"type":"control_request","request_id":…,"request":{"subtype":"interrupt"}}` → its `control_response` (+ the interrupted `result` when a turn is running) → close stdin → exit. After a stop Switchboard started, exit 0 (idle) **and** exit 1 (mid-tool, or a question was open) both mean `paused`. Any other exit is `fail`. On timeout, escalate SIGINT → SIGTERM → SIGKILL.
- **Resume:** spawn with `--resume <claudeSessionId>` and send "Continue.".
- **Service restart:** sessions whose process was live are resumed. Two live processes on one id fork the conversation, so any leftover process of that session is stopped first (its recorded pid, when `claude agents --json` lists it with the same id). A `run` session then gets "Switchboard restarted. Continue.". A `need` session waits idle, and the note goes with its (now stale) answers.

**Terminal handoff (M0.4).**
- **Continue in terminal** = the Pause stop, then show `claude --resume <id>` (the prototype's copy). It works from any cwd, keeps the id and appends to the same transcript. Resuming outside the workspace root runs the session's tools there. Switchboard sessions never appear in the terminal's `/resume` picker (sdk sessions are hidden), so the copied id is the way in.
- **Attach here** = spawn `--resume` with the same flags, `--permission-mode` and `--name` included again. It must not overlap a live terminal: warn when the transcript changed less than 2 minutes ago (gap #5) or `claude agents --json` lists the id. An idle attached process writes nothing and makes no model call until the first message.
- **Sync back:** stdout does not replay history. After attaching, Switchboard imports the transcript entries written since it detached: those after the last stored `uuid`, on the newest leaf, skipping `model:"<synthetic>"` lines.

**Transcripts (M0.3; read-only).**
- Path: `<configDir>/projects/<slug(start cwd)>/<sessionId>.jsonl`, with configDir = `$CLAUDE_CONFIG_DIR` or `~/.claude`.
- Slug: every character other than `[A-Za-z0-9]` → `-`, plus a hash suffix past 200 characters. It is lossy, so never turn it back into a path.
- Lifecycle: the file appears with the first user message and grows with every message, so mtime tracks activity. It keeps one id across resumes from any cwd.
- `entrypoint` is `cli` for an interactive terminal and `sdk-cli` for `-p`. Subagent sidechains live in `<sessionId>/subagents/`, which History does not read.
- Files reach tens of MB: stream them asynchronously and cache by `(size, mtime)`. Switchboard never writes there.

**Stored state** (fields M1.3 adds for the integration, on top of the data model below):
- Session: `pid`, requested and observed permission mode, `cliVersion` (from `init`), `lastTranscriptUuid` (the sync point for Attach).
- Question: `requestId` (= `batchId`), `toolUseId`, `header`, `options[{label, description}]`, `multiSelect`, `state` (open | answered | stale), the answer label.
- Permission item (an Inbox item): `requestId`, `toolUseId`, `toolName`, `input` (JSON, verbatim), `description`, `decisionReason`, `agentId?`, `state`, decision.
- Agent: `toolUseId`, `taskId`, `subagentType`.
- Usage reading: 5-hour and weekly utilization with their `resetsAt`, source, received-at.
- History cache: transcript path, size, mtime, parsed row.

**Tests never call the real CLI.** `tools/fake-claude` replays the recorded fixtures with the same argv surface (M1.2).

## Data model (minimum)
- **Session**: id, name, claudeSessionId, status (need | run | done | fail | idle | paused), workType, mode, phase, coordination, qaStack, ultracode, solutions[], createdAt, attached(bool)
- **Agent**: sessionId, name, description, solutionPath, branch, status
- **Event**: sessionId, agent, ts, kind (plan | impl | loop | ask | ok | tool | text | error), label, payload(json). Drives the chat, timeline and terminal tail.
- **Question**: id, sessionId, batchId, source, text, options[], answerIndex?, answeredAt?
- **Worktree**: repo, branch, path, sessionId, prNumber?, prState, removable
- **Artifact**: type (PR | BRANCH | DIFF | DOC | CONTRACT | QA | FOLLOWUP | TICKET), name, solution, branch, sessionId, meta, createdAt
- **Schedule**: name, cron, template(session config + prompt), paused, runs[] (ts, result)
- **Loop**: sessionId, kind, iteration, cap, breakerCount, expiresAt
- **Tool**: id, name, url, showInSidebar
- **Setting**: key, value

## Workspace rules (from the router AGENTS.md)
- `microfrontends/*-front`, `mobile/`, `nugets/*-nuget`, `microservices/*-microservice`, `functions/*-func` → editable
- `other/*` → editable **only when explicitly chosen**
- `deprecated/**`, `infrastructure/` → **read-only**: never selectable as a write target
- Two sessions writing the same repo → each must have its own worktree, or a conflict warning appears.

## Usage meter (M0.3)
Confirmed in M0: the Max 5-hour and weekly utilization are both reliable. The sources are the stdin control request `get_usage` (`{"subtype":"get_usage","skip_behaviors":true}` → `rate_limits.five_hour` / `seven_day` = `{utilization 0–100, resets_at}`; no model call, no transcript; the CLI marks it experimental) and each turn's `rate_limit_event` (`unifiedWindows.*.utilization`, 0–1). Cost fields, transcripts and `/status` give no percentage. Anything missing, erroring or shaped differently shows "unknown". Never invent a percentage. Cadence and the `usagePct` rule are in `BACKLOG.md` M9.2.

## Security
- Bind to loopback only and reject non-loopback Host/Origin headers (CSRF / DNS-rebinding guard).
- A random per-install token set as a SameSite=Strict cookie is required on every API and `/hub` call. The cookie is set when the UI page is loaded from a loopback Host (see `docs/decisions.md` #20).
- Child processes are started with an argv array (`shell: false`), never a shell string.
- Iframes load only URLs configured in Settings.
- Data and the token live in the per-user app-data folder (macOS `~/Library/Application Support/Switchboard`, Windows `%LOCALAPPDATA%\Switchboard`, Linux `~/.local/share/switchboard`); tests always use temp folders.
