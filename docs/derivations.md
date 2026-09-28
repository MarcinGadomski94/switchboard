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

The service shutting down is not a status: the stored status (`run` / `need`) is kept so a restart can resume those sessions (D7, M2.4). After the restart (`docs/supervisor.md` → *Restart recovery*) the resumed process derives its status afresh: a `run` session is `run` again with the restart message, a `need` session resumed idle is `idle` (its old request is stale, no longer open) until M3.1 decides how unanswered stale batches show; a session that could not be resumed safely, or whose pause the crash cut short, is `paused`. Results of the turn Switchboard interrupted do not count as an outcome. Background shells (`local_bash` tasks) do not keep a session in `run`, because a dev server can run for hours.

## Other stored state
- `sessions.observed_permission_mode` / `cli_version` from `system/init`; `requested_permission_mode` = `acceptEdits` (D6).
- `sessions.last_transcript_uuid`: the uuid of the newest **main-chain** stdout line that the CLI also writes to the transcript (replayed prompt, assistant line, tool result, interrupt marker). This is the Attach sync point (M4.1).
- `sessions.last_activity_at`: the newest event's `ts`.
- `usage_readings`: every `rate_limit_event` (utilization × 100, `resetsAt` epoch seconds → ISO), source `rate_limit_event`. The meter itself is M9.2.

## Embedded tools (M8.1, `docs/tools.md`)
- **Tool reachability**: `up` = any HTTP response to one server-side `GET` of the saved URL within 3 s (redirects not followed); `down` = anything else. The UI state (`idle` until probed, `checking`, `up`, `down`, `unset` once a URL-less tool was probed) follows the prototype's `tstate`.
- **`.codebase-memory-dirty` lines → strip chips**: a line is a codebase-memory project id (the workspace hook's rule: runs of `:` `/` `\` → `-`). An id under the workspace root's id (configured path or real path) followed by `-<category>-<repo>` names that repo (`mobile-…` = `mobile`); other ids show verbatim without a path. No times (`markedAt: null`) and no indexed count (`indexed: null`): the file holds neither and the service never calls codebase-memory (gap #4).

## Settings (M8.2, `docs/settings.md`)
- **Scan table rows** from `GET /api/solutions`: one row per top-level folder under the workspace root (first path segment of each solution; the "read-only" group splits into its folders, ordered as its note names them; without a root the group's folder), count = solutions, examples = first three names + ", …", rule = the strictest of its solutions.
- **Repositories** = every solution the scan lists (`n repos`). **PR merge detection** = the worktree manager's poll interval. **Workspace router** = the first `# ` heading of `<root>/AGENTS.md`.
- **Schedule dot**: paused → idle, else the last run's result (ok → done, fail, need, running → run, none/skipped → idle). **Cron label**: `m h * * *` → `HH:MM daily`, `0 */n * * *` → `every nh`, `m h * * 1-5` → `HH:MM weekdays`, `m h * * d` → `Ddd HH:MM`; anything else verbatim.
