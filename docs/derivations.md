# Derivations (M2.1)

How Switchboard turns a supervised `claude` process's stream-json stdout into what the UI shows: events (chat, timeline, terminal tail), agents, artifacts and the session status. The rules live in `src/core` (no HTTP, no database) and are applied by the recorder in `src/server/supervisor/recorder.ts`. The message shapes they read are in `docs/spike-m0.md` → *Stream-json output*; the parser is `src/core/stream-json.ts`, which never throws (a non-JSON line is `invalid`, an unknown type is `other`).

## Events
One stored event per thing the developer can see. `kind` is the timeline color (gap #7, below); `payload.type` says what it is (`src/core/event-payload.ts`). Events have `agentId` = the agent whose line produced them (below), `ts` = when Switchboard received the line, and `endTs` for tool calls once their result arrived.

| Source line | Event | `kind` | `payload.type` |
|---|---|---|---|
| a user message Switchboard writes to stdin (task, chat message, "Continue.") | one event, written **before** the line is sent | `text` (`loop` for `/loop …`) | `user` (`origin`: `task` / `user` / `resume` / `service`, `delivered`) |
| `user` with `isReplay: true` | updates that user event: `delivered: true`, `uuid` = the transcript uuid | — | — |
| a prompt a terminal sent while the session was detached (transcript, on Attach, M4.1) | one event, with the transcript's timestamp (`docs/supervisor.md` → *Attach here*) | `text` (`loop` for `/loop …`) | `user` (`origin: terminal`, `delivered: true`) |
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
- `solutionPath` and `branch` (M4.3, the agent card's path + ⎇ branch): set by the agent's first **successful** write into a solution: the solution's workspace-relative folder (`solutionFolder`: `microfrontends/<repo>`, `mobile/`, …) and the branch of the session's registered worktree that holds the file (else none). Later writes elsewhere do not move it; workspace-root files place nobody (`docs/session-panel.md`). The stream never says where an agent works, and its prompt is not read (that would be an inference).

## Artifacts (gap #9)
`src/core/derive/artifacts.ts`. Derived from **successful** tool results only, and upserted with a stable id, so writing a file twice keeps one artifact.

- **Where a file belongs** (the router's folder layout): `<group>/<repo>/…` for `microfrontends`, `nugets`, `microservices`, `functions`, `other` → solution `<repo>`; `mobile/…` → `mobile`; `deprecated/<type>/<repo>/…` → `<repo>`; `infrastructure/…` → `infrastructure`; anything else under the workspace root → the workspace root (solution `null`). A folder named `<repo>-wt-<session name>` (gap #1 worktree, a sibling of the repo) maps to `<repo>`. Files outside the workspace root give no artifact. The name is the path inside the solution (or the root), `/`-separated.
- **File artifacts** (Write / Edit / MultiEdit / NotebookEdit): `coverage-matrix.md` → QA; a file under a `mobile-followups/` folder → FOLLOWUP; `contracts/*.md` → CONTRACT; any other `.md` → DOC. Branch = the worktree's branch when the file is inside one of the session's registered worktrees (M2.2), else none.
- **DIFF**: one per solution + branch the session wrote into (workspace-root files have no repo, so no DIFF). Name = the written files' common folder inside the solution + the count (`Pages/FreeTalk · 6 files`, the prototype's form); `data.files` lists them. `meta` (the prototype's `+284 −12`) stays empty here: the line counts come from git, and the session's Artifacts tab reads them from the session's diff (M4.6, *Artifacts tab* below).
- **PR**: GitHub pull request URLs in the output of a Bash command that runs `gh` (e.g. `gh pr create`). Name `<repo> #<n>`, solution `<repo>`, `url`. `meta` (`open` / `merged` / `closed`, lower-cased from gh) is set by the worktree manager's PR check when a registered worktree's PR has the same URL (M2.2, `docs/worktrees.md`); nothing is guessed.
- **BRANCH**: branches a Bash command creates: `git checkout -b|-B`, `git switch -c|-C|--create`, `git worktree add … -b|-B`, `git branch <name>` (no options). The solution comes from a preceding `cd <dir>` or `git -C <dir>` in the same command, else none. Worktrees Switchboard creates itself are registered by M2.2.
- **TICKET**: not auto-detected in v1.

## Solutions rows (M6.2)
The live fields of `GET /api/solutions` (which sessions work on a solution, its branches, status, phase, changes, phase ledger, artifacts & follow-ups and codebase-memory freshness) are derived by `LiveSolutions`; the rules are in `docs/solutions.md` → *Live fields* and `src/core/solutions-live.ts`. Conflicts (M6.3: two or more open sessions write one repo and at least one has no worktree of its own) are in `docs/solutions.md` → *Conflicts* and `src/core/conflicts.ts`.

## Session chips (M4.1)
`src/core/derive/chips.ts`, sent as `Session.chips` and shown in the session header (SPEC → Session: "Chips (k v, mono); loop/workflow chips are blue").

| Chip | From | Value |
|---|---|---|
| `work` | `workType` | `feature-building` / `test-authoring (QA)` |
| `mode` | `mode` | `single-solution` / `orchestrator` |
| `phase` | `phase` | `UI-first` / `integration` |
| `stack` | `qaStack`, QA sessions only | `web` / `mobile` / `both` |
| `scope` | `solutions` | the names joined with ` + ` |
| `ultracode` (blue) | `ultracode` | `on` |
| `run` (blue) | each `loops` row of kind `Workflow` (D9) | its label, else the kind |
| `loop` (blue) | each other `loops` row | its label, else the kind |

The words are the prototype's for a session started from the New-session form (`nsLaunch`). A chip is left out when its source is empty; nothing is invented (D13). The prototype's mock sessions carry hand-written chips with no data source (`bp 360`, `cap 12 items · breaker 2`, `contract …`, `runbook …`, `expires …`, a path-style scope such as `functions/calendar-func`); the app does not show them (`docs/visual/session-header.md`).

## Artifacts view (M7.3)
`src/core/artifacts-view.ts`, used by `GET /api/artifacts?type=&q=` (`src/server/api/artifacts.ts`) and the view (`src/web/views/ArtifactsView.tsx`).

- **Rows**: every stored artifact (above), newest `updatedAt` first (a DIFF moves up with every write), as `ArtifactListItem` = `Artifact` + `sessionName` (`null` when it has no session or its session was deleted) + `updatedAt`. The Age column reads `updatedAt` (`now`, `4m`, `3h`, `2d`, the sidebar's format).
- **Type filters** (the prototype's `artFilters` + `AMAP`): All · Diffs = DIFF · PRs / branches = PR, BRANCH · Docs & contracts = DOC, CONTRACT, QA, FOLLOWUP · Ticket replies = TICKET. The view sends the pill's types as `type=PR,BRANCH`; the service accepts a comma list or a repeated `type`, case-insensitive, blank = every type, and answers `400 {error:"invalid", message}` for anything that is not an artifact type.
- **Solution · branch**: `solution ⎇ branch`; the solution alone without a branch; `root` for the workspace root (`solution: null`). A BRANCH artifact whose branch is its name shows the solution only (the prototype's BRANCH row).
- **Search** (`q`, trimmed, case-insensitive substring) runs on the service over the row as shown, joined by spaces: type, name, Solution · branch, session name, status (`meta`). The prototype's `a.join(' ')` also held the age; the age is left out because it changes by itself.
- **Count** `n of m`: `n` rows shown, `m` = every artifact (a second, unfiltered request while a filter or search is active).
- **Click** opens the source session on its Chat tab (the prototype's `openSession`); a row without a session is not a link and shows `—` as its session.
- **Live**: the recorder derives artifacts from tool results and `/hub` has no artifact event, so the view reloads (trailing, 250 ms) after `event` / `sessionUpdated` hub messages; `aria-busy` is on while the rows on screen belong to an older filter or search.
- **Empty**: "No artifacts yet." when nothing exists, "No artifacts match." when a filter or search hides everything (History's style; the prototype has no empty state here).

## History (M7.4)
`src/core/transcript.ts` (the transcript parser) and `src/core/history.ts` (rows, search), used by `GET /api/history?q=` through `src/server/history/transcripts.ts` (`TranscriptHistory`, the real `HistoryProvider`) and by the view (`src/web/views/HistoryView.tsx`). Formats per `docs/spike-m0.md` → M0.3 / M0.4.

- **Which files.** `configDir` = `$CLAUDE_CONFIG_DIR` (resolved, NFC) or `~/.claude`, read once at startup. Only `<configDir>/projects/<folder>/` whose folder name starts with the sanitized workspace root (cut at 200 chars, so long slugs match too; case-insensitive on macOS/Windows), for both the configured root and its `realpath`. Only top-level `*.jsonl` (never `<id>/subagents/`). Without a workspace root nothing is scanned and only stored sessions are listed. Nothing is ever written under `configDir`.
- **Parsing.** Each file is streamed with `readline` and parsed once per `(size, mtime)`: the facts (`TranscriptFacts`: start cwd, cwds, first `gitBranch`, first/last timestamp, entrypoint of the first human prompt else of the first command, first prompt, first command, last prompt, titles, last text, last `pr-link`, all prompts for search, capped) are cached in memory and in `history_cache.item` (with a version number; an older version is parsed again). Cache rows of files that disappeared from a scanned folder are deleted. `history_cache.item` therefore holds parsed facts, not a finished row: whether and how a file is shown depends on the database at request time.
- **Human prompt / command.** A prompt is a main-chain `user` line that is not `isMeta`, not a `tool_result`, not `promptSource:"system"` / `turnOrigin:"task_notification"`, and whose text does not start with `<command-`, `<local-command-` or `[Request interrupted`. A slash command is a `user` line whose text has `<command-name>`; it reads `/name args` (whitespace collapsed).
- **Last text (summary).** The newest assistant text on the chain of the newest leaf: start at the last chain entry in the file (`user` / `assistant` / `attachment` / `system` with a `uuid`, not a sidechain; the last one written is always a leaf, and the CLI continues from it, M0.4) and follow `parentUuid` (`logicalParentUuid` when `parentUuid` is null) until an assistant line with text; `model:"<synthetic>"` lines are skipped. A message written as several lines (one per content block) contributes all its text blocks. When a `parentUuid` names a line the file does not have (the fixtures dropped some attachment lines), the walk continues with the previous chain entry in file order.
- **Rows.** Every stored session, whatever its transcript's entrypoints (a Switchboard session continued in a terminal mixes `sdk-cli` and `cli` and keeps its row). Plus every transcript whose id is not stored, whose start `cwd` is the root or under it, whose first prompt (else first command) has `entrypoint:"cli"`, and which has a prompt or a command (gap #5). Hidden: headless `sdk-cli` files nobody stored, stubs, other roots. Two files for one id: the most recently modified wins. Order: newest `startedAt` first.
- **Fields, stored session.** date = `createdAt`; name = DB name; mode = the sidebar's mode line (`orch · feature · UI-first`); summary = the transcript's last text, else the task; branches = its worktrees (removed ones too: the branch is kept, gap #3); `solutions` = solutions in scope without a worktree; outcome = the first worktree PR as `PR #n <state>` (gh state lower-cased, `+k` when more worktrees have PRs), else a transcript `pr-link` as `PR #n`, else the status word (`needs you`, `running`, `done`, `failed`, `idle`, `paused`); status = the session's.
- **Fields, terminal session.** date = first timestamp (else the mtime); name = last `custom-title` → last `ai-title` → first prompt → first command (prompt/command collapsed, cut at 60 chars with `…`); mode = `terminal`, plus ` · /loop 1h` (the command and its first argument) when it started with a command; summary = last text → last prompt → first prompt; branches = the start folder's solution `⎇` `gitBranch` when that is not `HEAD` (`root` for the root itself); `solutions` = the solutions of the other folders it worked in; outcome = `PR #n` from the last `pr-link`, else `active` (file changed less than 2 minutes ago, gap #5's window) or `ended`; status = `run` while active, else `idle` (the outcome's color).
- **Solution of a folder** (router layout): `microfrontends|nugets|microservices|functions|other/<repo>/…` → `<repo>`; `deprecated/<type>/<repo>/…` → `<repo>` (`deprecated/mobile` → `mobile`); any other top folder (`mobile`, `infrastructure`) → itself.
- **Summary** is shown collapsed and cut at 240 chars with `…`; the search sees the stored text (up to 4000 chars).
- **Search** (`q`, trimmed, case-insensitive substring) runs on the service over: name, mode, the whole last text, the solutions/branches line, outcome, the task (stored sessions), every human prompt (up to 8000 chars), the last prompt, titles, the first command, the working folders and the session id. The date is not searched (it is formatted in the browser's time zone).
- **View.** Rows are not links (the prototype has no click). The search waits 150 ms after typing; the list reloads (trailing, 250 ms) on `/hub` `sessionUpdated`; `aria-busy` is on while the rows belong to an older search. Empty: "No sessions match." with a search, "No sessions yet." without one (the prototype only has the first).

## New-session form (M5.1)
The modal derives, from `GET /api/solutions`: the summary's `cwd` (the first solution's `path` minus its `relativePath`), one locked chip per read-only top folder (`deprecated/*`, `infrastructure`) and each worktree folder `../<last segment of the solution>-wt-<name>` (gap #1). The router's recommended answers are the form's defaults, and coordination is sent only when its section is shown (`null` otherwise). Details: `docs/new-session.md`.

## First-turn payload (M5.2)
The first stdin message of a new session = the trimmed task, a blank line, then the confirmed session-start answers in the modal summary's terms, with each solution's workspace folder (from its worktree record, else `WorktreeManager.resolveRepo`, else the name as posted) and the absolute worktree paths + branches. Mobile coordination only for feature + single-solution + a `*-front` and a non-null value. An empty task: no first message; the block waits in the outbox (`pending_messages.kind = 'session-start'`). Details: `docs/new-session.md` → *First-turn payload*.

## Setup wizard (M5.3)
The step 1 rows from `GET /api/system`, the root line from the router's first `# ` heading and line count, and the scan table (one row per top-level folder, the read-only group split back in its note's order, three names + `, …`, the strictest rule) are in `docs/setup.md` → *The steps*; `cpu` / `ramUsed` / `processes` in `docs/setup.md` → *System*.

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
- `usage_readings`: every `rate_limit_event` (utilization × 100 rounded to 2 decimals and capped at 100, `resetsAt` epoch seconds → ISO; a missing or malformed window is `null`), source `rate_limit_event`. The meter (its `get_usage` readings, the max rule, the unknown cases and the warnings) is M9.2: `docs/usage.md`.
- `system_items` (M3.3, `docs/system-items.md`): a `schedule_runs` row with `result = 'fail'` → one "Scheduled run failed" item (title = the run summary, detail = the green streak before it, chips from the run's session, the "Open fix session" prefill from the schedule template); a live worktree with `removable = 1` → one "PR merged" item. One item per run / worktree, open or closed.

## Embedded tools (M8.1, `docs/tools.md`)
- **Tool reachability**: `up` = any HTTP response to one server-side `GET` of the saved URL within 3 s (redirects not followed); `down` = anything else. The UI state (`idle` until probed, `checking`, `up`, `down`, `unset` once a URL-less tool was probed) follows the prototype's `tstate`.
- **`.codebase-memory-dirty` lines → strip chips**: a line is a codebase-memory project id (the workspace hook's rule: runs of `:` `/` `\` → `-`). An id under the workspace root's id (configured path or real path) followed by `-<category>-<repo>` names that repo (`mobile-…` = `mobile`); other ids show verbatim without a path. No times (`markedAt: null`) and no indexed count (`indexed: null`): the file holds neither and the service never calls codebase-memory (gap #4).

## Settings (M8.2, `docs/settings.md`)
- **Scan table rows** from `GET /api/solutions`: one row per top-level folder under the workspace root (first path segment of each solution; the "read-only" group splits into its folders, ordered as its note names them; without a root the group's folder), count = solutions, examples = first three names + ", …", rule = the strictest of its solutions.
- **Repositories** = every solution the scan lists (`n repos`). **PR merge detection** = the worktree manager's poll interval. **Workspace router** = the first `# ` heading of `<root>/AGENTS.md`.
- **Schedule dot**: paused → idle, else the last run's result (ok → done, fail, need, running → run, none/skipped → idle). **Cron label**: `m h * * *` → `HH:MM daily`, `0 */n * * *` → `every nh`, `m h * * 1-5` → `HH:MM weekdays`, `m h * * d` → `Ddd HH:MM`; anything else verbatim.

- `schedule_runs` (M7.1, `docs/schedules.md` → *A run*): a run's `result` follows the status of the session it started (`run` → `running`, `need` → `need`, `done` → `ok`, `fail` → `fail`; `idle` / `paused` change nothing); its `summary` is the first open question verbatim (`need`), else the label of the last turn's result, else of the newest error event; a session that could not start gives `fail` + `Not started: …`.

## Timeline tab (M4.4)
`src/web/views/session/timeline.ts` (pure, `tests/web/timeline.test.ts`), rendered by `TimelineTab.tsx`. The UI computes it from the session's events (`GET /api/sessions/{id}/events`, then every `/hub` `event` for the session, new or updated, the newest copy of an event winning; fetched again when the hub stream reopens) and agents (`GET /api/sessions/{id}`, then `sessionUpdated`; fetched again when an event names an agent the tab does not know, because a new subagent is not a session status change). No demo special case: the demo seed's timeline blocks are ordinary events with a kind, `ts`, `endTs` and an agent.

- **Blocks** = events of kind `plan` / `impl` / `loop` / `ask` / `ok` (SPEC) plus `error`, so failures show. `tool` (Agent/Task, TodoWrite, MCP tools…) and `text` (chat, lifecycle) events are not blocks. Colors: the prototype's `K` map (`[bg, border, text, log dot]`); `error` follows the same pattern on the fail hue (`oklch(0.3 0.06 25)` / `oklch(0.45 0.09 25)` / `#e8e7e3` / the fail status color). A block runs from `ts` to `endTs`. An **open** block (a tool call without its result, an open permission request) runs to now while the session is `run` / `need` (the tab re-renders every second then), otherwise to the axis end. Anything else is a point, drawn at the block's minimum width (padding + border = 14 px), kept inside the lane.
- **Lanes** = the session's agents: the main agent first, then the others in the order of their first block, agents without blocks last. Events of an unknown agent, or of none (service events after a restart), go to the main agent's lane. Second line = the agent's `solutionPath`; the main agent without one shows `workspace root` (its process runs there); a subagent without one shows nothing (the stream does not say where it works, gap #8).
- **Axis** = the first event's `ts` (text included: the task starts the session) to the newest `ts` / `endTs`, or now while an open block runs; at least 1 s. 7 ticks at 0/6 … 6/6. Clock labels are local `H:MM` rounded to the minute (the prototype's `10:02`), or `H:MM:SS` when the span is under 6 minutes so a short session's ticks differ; the log's times are always `H:MM` (44 px column).
- **Playhead / scrubber**: value 0–1000 (the prototype's range input), playhead at value / 10 %, the clock label = axis start + value / 1000 × span. Blocks that start after the playhead are drawn at opacity 0.35. ▶ plays from the scrubber (from 0 when it is at the end), 8 steps every 50 ms; ❚❚ pauses. The scrubber stays at the end when new events arrive, so the view follows a live session.
- **"Events up to {clock}"**: the blocks that start at or before the playhead, by start time (then event id), the last 8: `H:MM`, a dot in the kind's log color, `<lane name> · <label>`.

## Diff tab (M4.5)
`src/web/views/session/diff.ts` (pure, `tests/web/diff.test.ts`), rendered by `DiffTab.tsx`. The UI reads `GET /api/sessions/{id}/diff` (gap #10, `docs/worktrees.md` → *Diff*) and fetches it again, folded to one call per 500 ms, when a `/hub` `event` of the session has a kind that can change files (`impl`, `loop`, `ok`, `tool`, `error`; not `plan`, `ask`, `text`), on the session's `sessionUpdated`, when the hub stream reopens, and when the window regains focus (edits made outside Switchboard, e.g. the developer committing in a terminal). No demo special case: in demo mode the same route answers from the demo provider.

- **File list** (300 px), in the server's order (per solution, by path): the file name (last path segment), the delta `+<added>` / `−<removed>` (U+2212) / both (`+51 −12`), or `—` when the file has no line changes (binary, empty, mode only), always in the prototype's green; second line `<solution> · <path>`. Empty list → "No changes yet.". The selection is kept by solution + path across refreshes; when the selected file leaves the diff, the first file is shown (the prototype clamps its index). Rows are focusable buttons (Enter / Space select).
- **Header**: `<solution> / <path>`, `⎇ <branch>` (nothing for a file without a branch: workspace root, detached checkout), and the note "Not committed. Commit only when you approve." while the selected file is `uncommitted` (hidden once all of its changes are committed, i.e. the developer approved and the agent committed). Without files the header is empty and the note shows, as the prototype renders it.
- **Body**: `FileDiff.lines` verbatim with their marker, `white-space: pre`; `+` lines on the diff-add colors, `-` lines on the diff-remove colors, anything else #8d8c87 (SPEC → diff + / −). Hunk headers are not in `FileDiff.lines` (gap #10), so hunks follow each other without a separator, as in the prototype.

## Artifacts tab (M4.6)
`src/web/views/session/artifacts.ts` (pure, `tests/web/artifacts.test.ts`), rendered by `ArtifactsTab.tsx`. The UI reads `GET /api/sessions/{id}` (its `artifacts`, the recorder's rows above, and its `files`, the session's git diff) and fetches it again on the Diff tab's triggers (`useSessionRefresh.ts`, shared with the Diff tab: a `/hub` `event` of kind `impl` / `loop` / `ok` / `tool` / `error`, the session's `sessionUpdated`, the hub stream reopening, window focus; folded to one call per 500 ms). No demo special case: in demo mode the same route answers from the seeded rows and the demo diff provider.

- **Rows** in the server's order (most recently updated first): the type tag, the name, the meta (the prototype's `ss.arts` row: tag + name + meta). No artifacts → one row `INFO · No artifacts` (the Solutions detail's form, M6.2).
- **DIFF** rows use the session tab's form `<solution> · <n files>` (the tab has no solution column; the global list keeps the stored `<common folder> · <n files>` name, M7.3). A stored `meta` is shown as is, with the count from the stored name (`Pages/FreeTalk · 6 files` → `acme-app-front · 6 files`; a stored name without a count follows the solution verbatim). Otherwise, the count and `+added −removed` (`deltaText`, the Diff tab's form; `—` for binary-only changes) come from the session's diff files of the same solution and, when the artifact has one, the same branch; a DIFF without a branch (files written outside the session's worktrees) takes the solution's files on branches no other DIFF of that solution names. So the numbers follow git: changes made by Bash or committed by the developer count, reverted ones drop out. Without matching diff files (the solution is outside the session's scope, the changes are gone) the stored count stays and the meta is empty.
- **Every other type** shows its stored name and meta verbatim (PR `open` / `merged` / `closed` from the worktree manager's PR check); an unknown meta stays empty, nothing is invented (the prototype's `locked`, `1 new`, `7 commits` are mock data).
- Each row's tooltip names where the artifact lives: `<solution> ⎇ <branch>`, `<solution>`, or `workspace root`.

## Terminal tail (M4.4, shared with the right panel of M4.3)
`src/web/views/session/terminal-tail.ts` (pure, `tests/web/terminal-tail.test.ts`). Switchboard has no TTY, so the tail is rendered from the stored events, never invented. One or two lines per event, oldest first, the newest 8 kept (the whole session, not cut at the playhead: the prototype shows the full tail under the timeline):

| Event | Line(s) |
|---|---|
| `tool` Bash | `$ <first command line>`; after the result: its last non-empty output line, or `✕ <first line>` on an error |
| `tool` AskUserQuestion with its request open | `⏸ <label>` |
| any other `tool` | `● <label>` while running, `✓ <label>` / `✕ <label>` after the result |
| `request` (permission) | `⏸ <label>` open, `✓` / `✕` (deny) after the response, `⚠ <label> · stale` / `· cancelled` |
| `denied` | `✕ <label>` |
| `result` | `✓ <label>` / `✕ <label>` |
| `lifecycle` | the label (`Started`, `Paused`, …); `✕ <label>` when it failed |
| `mode-mismatch` | `⚠ <label>` |
| `user`, `assistant`, `agent-prompt` (the chat), unknown shapes | nothing |

A subagent's lines start with `[<agent name>] ` (the prototype's `[web]`); the main agent's lines have no tag. Colors = the prototype's `lineColor` after that tag: `$` `#6d6c67`, `✓` green, `⏸` / `⚠` amber, `✕` red, anything else `#bfbeb8`.

The demo seed still stores its terminal lines as provisional `channel: "terminal"` payloads (M2.1 note in `docs/demo.md`), which this real-path tail does not render, so the demo Timeline's terminal stays empty until those lines are mapped onto real payloads.

## Loop cards (M7.2, D9)
`src/core/derive/loops.ts` (pure, `tests/core/loops.test.ts`), run by the `LoopTracker` (`src/server/loops/tracker.ts`, `tests/server/loops/tracker.test.ts`), rendered by `src/web/views/LoopCards.tsx` from `src/web/views/loops.ts` (`tests/web/loops.test.ts`). Values come only from observed events and a progress file; anything unknown is `null` and shows "—" (D9: never invented).

**Where they come from.** The tracker listens to the supervisor's `event` notifications. A `/loop` user message or a `ScheduleWakeup` / `CronCreate` / `CronDelete` / `Workflow` tool event, and afterwards any event of a session that has loops, schedules a refresh of that session (at most one per 150 ms, one at a time): all of the session's events (insert order) go through `deriveLoops`, and the result is written to the `loops` table with a stable id per session + source (`loop:<session>:<key>`), created or updated, never deleted. A change is published as `sessionUpdated`. The loops reach the UI as the additive `Session.loops` field (`GET /api/sessions` and the `sessionUpdated` hub event; the contract has no loop route, so no route was added). At start the tracker re-derives its own rows that still show a next firing or an expiry (`sweep()`), because a service stop ends every process after the tracker stopped listening. Rows it does not own (the demo seed's) are never touched.

**Sources and rules.**
| Source | Card | Iteration | Next firing | Expiry |
|---|---|---|---|---|
| a user message starting with `/loop` | kind `/loop`, label `/loop <interval>` (`/loop 1h`), or `/loop` when self-paced | 1 = the `/loop` turn itself; +1 per **firing** | from the `CronCreate` / `ScheduleWakeup` calls after it (they belong to it, also after a resume) | from its `CronCreate` |
| `CronCreate {cron, prompt, recurring?}` without a `/loop` | kind `CronCreate`, label `cron <expression>`, one card per call | firings only | the cron's next match after now (local time, `src/core/derive/cron-next.ts`); `recurring: false` = the first match after the call, gone once it fired | recurring: the call's time + 7 days (the tool's documented auto-expiry); past it the card says "Expired 7 days after the cron job was created." |
| `ScheduleWakeup {delaySeconds}` without a `/loop` | kind `ScheduleWakeup`, one card per session | firings only | the call's time + `delaySeconds`, until a firing (a wake-up the firing turn sets itself is the next one) | — |
| `Workflow` | kind `Workflow`, label `Workflow · <input name / description / title>`, one card per session | one per call (run) | — | — |

- A **firing** is a turn the CLI ran on its own: a `result` with no Switchboard message still waiting for its result (messages are counted in order; the process ending clears them) that is not a background agent's task-notification. It counts for the most recently scheduled live loop. While such a turn runs (main-agent activity with nothing pending) its cell is already shown.
- Only successful `CronCreate` / `ScheduleWakeup` calls schedule (an error result or an unparseable cron / delay schedules nothing). `CronDelete` stops the cron whose id appears in a `CronCreate` result, else the only live cron.
- **Session-only schedules die with the process:** when the process ends (pause, terminal handoff, exit, failure, service stop), live scheduled loops lose their next firing and expiry, open iterations become `none` cells, and the note says "Stopped: the session's claude process ended." A later `CronCreate` / `ScheduleWakeup` in the session revives its `/loop` card.
- **Strip cells** per iteration: `ok` (green) / `fail` (red) from the result; an open one takes the session status (`need` amber, `run` blue, `fail` red, else `none`). The newest 100 are stored; the card shows the newest 30, padded with empty cells up to a known cap (the prototype's `gggggggrrnnn`).
- **Cap + breaker** (`src/core/loop-progress.ts`, `src/server/loops/progress.ts`): the newest `.loop/progress.md` (by mtime) in the session's working folders: its live worktrees, its solutions' folders (router layout, `solutionCandidates`), its cwd. LOOP.md format: cap = `n` of `attempt: a/n` (LOOP.md's iteration cap), breaker = the count of the first `consecutive_<what>: <n>` line under `## Breaker`. The note then ends with "Cap and breaker from <path>." (relative to the workspace root). The file is re-read on every refresh (every turn of the session), never written.
- **Note** (observed facts only): "Session-only schedule. It stops when the session closes or after 7 days." for a live recurring cron (CronCreate's documented behavior; the prototype's copy), the stop / expiry sentence, "Last iteration: <result label>.", the progress-file source.

**The card** (SPEC → Schedules & loops; prototype inline styles in `loops.css`): session status dot, session name, the label (else the kind) in mono, "Open session" (→ `/sessions/<id>`), the strip, three facts, the note. Border `oklch(0.45 0.08 70)` while the session needs the developer, else `#26272c`. The facts are fixed: **Iteration / cap** (`17 / —`), **Next / expires** (`15:00 / in 6 days`: today's clock, `tomorrow 02:00`, a weekday within a week, else `MM-DD HH:MM`; expiry `in n days` / `in n h` / `in n min` / `expired`), **Breaker** (`tripped (2)` when a state is stored, `2 in a row` for a count only, else "—"). Cards are listed in the order their loops started (oldest first; loops stored at the same moment follow their sessions' start, then the server's order), two per row; with none the grid shows "No loops yet. A card appears when a session runs /loop, ScheduleWakeup, CronCreate or Workflow." Relative times re-render every 30 s.

Not observed, so not shown: the CLI's firing jitter, workflow-internal iterations (workflow agents are not visible in stream-json, M0.1), the prototype's hand-written facts (`Next sweep`, `Progress 7 / 12 items`, `Isolation`), and a breaker "tripped" state for real loops (the threshold is not in the progress file).

## ⌘K palette (M8.3)
The palette (`src/web/modals/Palette.tsx`, model `palette.ts`) opens with ⌘K / Ctrl+K or the sidebar badge and lists, in the prototype's `PAL` order:

| Kind | Label | Hint | Pick |
|---|---|---|---|
| `view` | Inbox, Solutions, Schedules & loops, Artifacts, History, Settings | — | navigate to the view |
| `action` | New session | — | open the New-session modal (in place of the palette) |
| `tool` | the tool's name, every tool of `GET /api/tools` in its order (the sidebar filter `showInSidebar` does not apply) | the URL's host (`localhost:13000`), empty when not configured | `/tools/<id>` (the tool view probes it) |
| `session` | the session's name, `GET /api/sessions` in its order | the sidebar's mode line (`orch · feature · UI-first`), built from the session's fields | `/sessions/<id>` (Chat) |
| `solution` | the solution's name, `GET /api/solutions` groups and rows in order | the group's folder (`microfrontends/`, `read-only`) | `/solutions` with that solution selected |

- **Filter:** an entry matches when `label kind hint`, lower-cased, contains the query lower-cased (the prototype's rule: no trimming, no fuzzy match); an empty query keeps everything. At most **10** results are shown.
- **Keys:** typing highlights the first result; ↓ / ↑ move the highlight and stop at the last / first row (no wrap); Enter picks the highlighted row (nothing when there are no results); a click picks a row. Esc and a click on the overlay close (`ModalHost`); ⌘K / Ctrl+K while the palette is open clears the query and highlights the first row again, as reopening does. The highlighted row is scrolled into view.
- **Data:** each opening loads the three lists again; while one has not answered (or answers an error, e.g. `GET /api/tools` before M8.1) it adds nothing. The session list reloads on `sessionUpdated` (at most once a second) while the palette is open. No list is cached between openings, so a query typed faster than the API answers matches the views and the action only until the lists arrive.
- **Solution selection:** the Solutions view keeps its selection in local state and has no URL for it, so a picked solution is handed over through a one-shot request (`src/web/views/solution-focus.ts`): the view reads it when it mounts or at once when it is already open, then clears it. Navigating to Solutions any other way keeps the old behavior (the first row is selected).
