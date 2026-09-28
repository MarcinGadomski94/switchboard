# Derivations (M2.1)

How Switchboard turns a supervised `claude` process's stream-json stdout into what the UI shows: events (chat, timeline, terminal tail), agents, artifacts and the session status. The rules live in `src/core` (no HTTP, no database) and are applied by the recorder in `src/server/supervisor/recorder.ts`. The message shapes they read are in `docs/spike-m0.md` → *Stream-json output*; the parser is `src/core/stream-json.ts`, which never throws (a non-JSON line is `invalid`, an unknown type is `other`).

## Events
One stored event per thing the developer can see. `kind` is the timeline color (gap #7, below); `payload.type` says what it is (`src/core/event-payload.ts`). Events have `agentId` = the agent whose line produced them (below), `ts` = when Switchboard received the line, and `endTs` for tool calls once their result arrived.

| Source line | Event | `kind` | `payload.type` |
|---|---|---|---|
| a user message Switchboard writes to stdin (task, chat message, "Continue.") | one event, written **before** the line is sent | `text` (`loop` for `/loop …`) | `user` (`origin`: `task` / `user` / `resume` / `service`, `delivered`) |
| `user` with `isReplay: true` | updates that user event: `delivered: true`, `uuid` = the transcript uuid | — | — |
| `assistant` `text` blocks | the blocks of one `message.id` merge into **one** event (joined with a blank line) | `text` | `assistant` |
| `assistant` `thinking` blocks | nothing (the CLI sends them empty) | — | — |
| `assistant` `tool_use` | one event per call; its `tool_result` sets `endTs`, `result`, `isError` | by tool (gap #7) | `tool` |
| `user` text with `parent_tool_use_id` | a subagent's prompt | `text` | `agent-prompt` |
| `user` interrupt markers | nothing (they follow a pause) | — | — |
| `control_request/can_use_tool` for AskUserQuestion | updates the AskUserQuestion tool event: `requestId`, `requestState: open` | (`ask`) | (`tool`) |
| `control_request/can_use_tool` for any other tool | one event per permission request | `ask` | `request` (`state` open → responded / cancelled / stale) |
| `control_cancel_request` | the request's state → `cancelled` | — | — |
| `system/permission_denied` | an automatic denial | `ask` | `denied` |
| `result/*` | one event per turn, **except** the result of a turn Switchboard interrupted to stop the process | `ok` on success, else `error` | `result` |
| `system/init` with `permissionMode` ≠ the requested mode | one event per process (D6: an unsupported `auto` silently becomes `default`) | `error` | `mode-mismatch` |
| process started / resumed / attached / paused / detached / stopped / exited | one lifecycle event | `text` (`error` when it failed) | `lifecycle` |

Not events: `system/hook_*`, `system/thinking_tokens`, `system/commands_changed`, `system/task_*` (they drive agents), `rate_limit_event` (a usage reading), `control_response`.

Strings in payloads (tool inputs, tool results, texts) are cut at 4000 characters with `truncated` / `inputTruncated` / `resultTruncated` set. The full data stays in the CLI's transcript.

Labels are one line (first line, at most 120 characters): the text, `Write · file.md`, `Bash · <first command line>`, `Grep · <pattern>`, `Agent · <subagent_type> · <description>`, `n questions · <first question>`, `Permission · <tool label>`, `Denied · <tool>`, the result text (`Done` when empty) or `<subtype>: <first error>`.

## Event kinds (gap #7)
`src/core/derive/event-kind.ts`.

| Tool / message | Kind | Note |
|---|---|---|
| Read, Grep, Glob, LS, NotebookRead, and any tool whose name contains `search` (WebSearch, ToolSearch, MCP `search_*`) | `plan` | "Read/Grep/Glob/search" |
| Edit, Write, MultiEdit, NotebookEdit, Bash | `impl` | MultiEdit and NotebookEdit are edits too |
| ScheduleWakeup, CronCreate | `loop` | `/loop` schedules its wake-ups with them |
| a user message starting with `/loop` | `loop` | |
| a Bash command identical (whitespace collapsed) to an earlier Bash command **of the same turn** whose result was an error | `loop` | "rebuild / self-heal": the build loop reruns the failed command after a fix |
| AskUserQuestion, permission requests, automatic denials | `ask` | question / permission |
| a successful `result` | `ok` | |
| an error `result`, a failed process, a permission-mode mismatch | `error` | |
| any other tool (Agent/Task, TodoWrite, WebFetch, MCP tools…) | `tool` | |
| text (user, assistant, subagent prompt, lifecycle) | `text` | |

## Agents (gap #8)
`src/core/derive/agents.ts`. Agents = the session's main agent + one per Agent/Task tool call. Workflow agents are not visible in stream-json (M0.1), so none are derived.

- **Main agent**, created with the session: named `orchestrator` in orchestrator mode, the solution's name in single-solution mode with one solution, else `main`. Its status mirrors the session status. Every line without `parent_tool_use_id` belongs to it.
- **Subagent**, created at the `Agent`/`Task` `tool_use`: `name` = `input.subagent_type` (else `agent`), `description` = `input.description`, `toolUseId` = the call's id. `system/task_started` (only `task_type: local_agent`; background shells `local_bash` are not agents) adds `taskId` and `subagentType`. `task_progress.description` becomes its `statusText`. `task_updated` / `task_notification` end it: `completed` → `done`, `failed`/`error` → `fail`, `killed`/`stopped` → `idle`. A call that never started a task ends with its `tool_result` (`done`, or `fail` on an error). When the process ends, running subagents become `idle`.
- Attribution: a line's `parent_tool_use_id` = the subagent's `toolUseId`. A permission request's `agent_id` = the subagent's `taskId` (M0.2 `subagent-perm`).
- `solutionPath` and `branch` stay empty: the stream does not say where an agent works, and guessing from its prompt would be an inference.

## Artifacts (gap #9)
`src/core/derive/artifacts.ts`. Derived from **successful** tool results only, and upserted with a stable id, so writing a file twice keeps one artifact.

- **Where a file belongs** (the router's folder layout): `<group>/<repo>/…` for `microfrontends`, `nugets`, `microservices`, `functions`, `other` → solution `<repo>`; `mobile/…` → `mobile`; `deprecated/<type>/<repo>/…` → `<repo>`; `infrastructure/…` → `infrastructure`; anything else under the workspace root → the workspace root (solution `null`). A folder named `<repo>-wt-<session name>` (gap #1 worktree, a sibling of the repo) maps to `<repo>`. Files outside the workspace root give no artifact. The name is the path inside the solution (or the root), `/`-separated.
- **File artifacts** (Write / Edit / MultiEdit / NotebookEdit): `coverage-matrix.md` → QA; a file under a `mobile-followups/` folder → FOLLOWUP; `contracts/*.md` → CONTRACT; any other `.md` → DOC. Branch = the worktree's branch when the file is inside one of the session's registered worktrees (M2.2), else none.
- **DIFF**: one per solution + branch the session wrote into (workspace-root files have no repo, so no DIFF). Name = the written files' common folder inside the solution + the count (`Pages/FreeTalk · 6 files`, the prototype's form); `data.files` lists them. `meta` (the prototype's `+284 −12`) stays empty here: the line counts come from git (M4.5 / M4.6).
- **PR**: GitHub pull request URLs in the output of a Bash command that runs `gh` (e.g. `gh pr create`). Name `<repo> #<n>`, solution `<repo>`, `url`. `meta` (`open` / `merged` / `closed`, lower-cased from gh) is set by the worktree manager's PR check when a registered worktree's PR has the same URL (M2.2, `docs/worktrees.md`); nothing is guessed.
- **BRANCH**: branches a Bash command creates: `git checkout -b|-B`, `git switch -c|-C|--create`, `git worktree add … -b|-B`, `git branch <name>` (no options). The solution comes from a preceding `cd <dir>` or `git -C <dir>` in the same command, else none. Worktrees Switchboard creates itself are registered by M2.2.
- **TICKET**: not auto-detected in v1.

## Solutions rows (M6.2)
The live fields of `GET /api/solutions` (which sessions work on a solution, its branches, status, phase, changes, phase ledger, artifacts & follow-ups and codebase-memory freshness) are derived by `LiveSolutions`; the rules are in `docs/solutions.md` → *Live fields* and `src/core/solutions-live.ts`. Conflicts (M6.3: two or more open sessions write one repo and at least one has no worktree of its own) are in `docs/solutions.md` → *Conflicts* and `src/core/conflicts.ts`.

## New-session form (M5.1)
The modal derives, from `GET /api/solutions`: the summary's `cwd` (the first solution's `path` minus its `relativePath`), one locked chip per read-only top folder (`deprecated/*`, `infrastructure`) and each worktree folder `../<last segment of the solution>-wt-<name>` (gap #1). The router's recommended answers are the form's defaults, and coordination is sent only when its section is shown (`null` otherwise). Details: `docs/new-session.md`.

## First-turn payload (M5.2)
The first stdin message of a new session = the trimmed task, a blank line, then the confirmed session-start answers in the modal summary's terms, with each solution's workspace folder (from its worktree record, else `WorktreeManager.resolveRepo`, else the name as posted) and the absolute worktree paths + branches. Mobile coordination only for feature + single-solution + a `*-front` and a non-null value. An empty task: no first message; the block waits in the outbox (`pending_messages.kind = 'session-start'`). Details: `docs/new-session.md` → *First-turn payload*.

## Session status
`src/core/derive/status.ts`, re-derived after every stdout line.

While the process is live:
1. an open `can_use_tool` request (question or permission) → `need`;
2. else a running turn (a user message without its `result` yet, or a turn the CLI runs on its own, e.g. after a background agent finished) or a running subagent → `run`;
3. else the last finished turn: success → `done`, error (`error_max_turns`, …) → `fail`;
4. nothing ran yet (a fresh attach) → `idle`.

After the process ended:
- a stop Switchboard started (Pause, Continue in terminal) → `paused`, whatever the exit code: D7, exit 0 when idle and exit 1 mid-tool or with a question open both mean paused (M0.4);
- a process that could not start, exited non-zero or died from a signal Switchboard did not send → `fail`;
- a clean exit Switchboard did not ask for → `done` (`fail` if its last turn failed).

The service shutting down is not a status: the stored status (`run` / `need`) is kept so a restart can resume those sessions (D7, M2.4). After the restart (`docs/supervisor.md` → *Restart recovery*) the resumed process derives its status afresh: a `run` session is `run` again with the restart message, a `need` session resumed idle is `idle` (its old request is stale, no longer open; M3.1 keeps it that way: the unanswered stale batch shows in the Inbox and the session's `openQuestionCount`, not in the status, `docs/questions.md`); a session that could not be resumed safely, or whose pause the crash cut short, is `paused`. Results of the turn Switchboard interrupted do not count as an outcome. Background shells (`local_bash` tasks) do not keep a session in `run`, because a dev server can run for hours.

## Other stored state
- `sessions.observed_permission_mode` / `cli_version` from `system/init`; `requested_permission_mode` = `acceptEdits` (D6).
- `sessions.last_transcript_uuid`: the uuid of the newest **main-chain** stdout line that the CLI also writes to the transcript (replayed prompt, assistant line, tool result, interrupt marker). This is the Attach sync point (M4.1).
- `sessions.last_activity_at`: the newest event's `ts`.
- `usage_readings`: every `rate_limit_event` (utilization × 100, `resetsAt` epoch seconds → ISO), source `rate_limit_event`. The meter itself is M9.2.
- `system_items` (M3.3, `docs/system-items.md`): a `schedule_runs` row with `result = 'fail'` → one "Scheduled run failed" item (title = the run summary, detail = the green streak before it, chips from the run's session, the "Open fix session" prefill from the schedule template); a live worktree with `removable = 1` → one "PR merged" item. One item per run / worktree, open or closed.
