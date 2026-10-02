# CLI providers: Claude Code, Codex CLI, OpenCode (D62)

Every Switchboard session runs one agent CLI: **Claude Code** (every session from before D62), **Codex CLI** or **OpenCode**. The developer picks the CLI per session (New-session forms), sets a default for new sessions (the sidebar footer's CLI switcher), and can **switch a running session to another CLI** with a handover. Codex and OpenCode are optional: Switchboard works without them, and a CLI that is missing, or signed out, simply cannot be chosen (with the reason).

Neither Codex nor OpenCode was installed when this was built (developer instruction). Everything below comes from their official source and documentation, pinned to the versions read; the tests run against fakes that model those shapes (`tools/fake-codex`, `tools/fake-opencode`). `docs/spike-providers.md` lists the probes to run once a real CLI is installed.

## Design

### One seam: stream-json in, stream-json out
The supervisor (`src/server/supervisor/`), the stream recorder, the status derivation, the question pipeline, the Inbox, the chat and the right panel all speak **Claude Code's stream-json** (`docs/supervisor.md`, `docs/derivations.md`). D62 keeps that as the one internal protocol:

- `src/server/cli/agent-process.ts` → `AgentProcess`: the members the supervisor uses of a process (`pid`, `running`, `exited`, `write(obj)`, `endInput()`, `kill()`, …). `ClaudeProcess` already is one.
- `src/server/cli/adapter.ts` → `CliAdapter.spawn(SpawnRequest)`: starts a session's process. `SpawnRequest` carries the stored session (title, model, effort), Claude's start (`--session-id` / `--resume` / `--teleport`), the other CLIs' own conversation id (`nativeId`), the cwd, the scrubbed env, the command and `onLine`.
- `src/server/cli/claude.ts` → Claude Code, exactly as before (`buildClaudeArgs` + `ClaudeProcess`): nothing is translated.
- `src/server/cli/codex/bridge.ts` → `CodexBridge`: spawns `codex app-server` and translates both ways between stream-json and Codex's JSON-RPC.
- `src/server/cli/opencode/bridge.ts` → `OpenCodeBridge`: spawns `opencode serve` on a loopback port and translates both ways between stream-json and OpenCode's HTTP API + SSE event stream.
- `src/server/cli/registry.ts` → `CliRegistry`: each provider's command (env, Settings override) and adapter.

So a Codex or OpenCode session gets the recorder's events, agents, artifacts, activity, context meter, D44 queue accounting, D50 Stop and the Inbox for free, through the same code Claude sessions use. Claude Code's path is unchanged; its tests are the guard (P1).

Why a bridge rather than a second recorder: the recorder is ~1100 lines of hard-won rules (turn accounting, the D44 queue, the D50 Stop, subagent placement, background tasks); a second implementation per CLI would drift. The bridges are small translators with their own tests against the fakes.

### What a bridge writes (stdout side)
| Stream-json line the bridge writes | When |
|---|---|
| `system/init` `{session_id, cwd, model, permissionMode, tools: [], claude_code_version: "<cli> <version>"}` | a turn starts (the CLI took a message up) |
| `user` `{isReplay: true, message}` | the message the turn took up (D44: the bubble's clock clears) |
| `assistant` `{message: {id, model, content: [text \| thinking \| tool_use], usage?}, parent_tool_use_id}` | text, reasoning, a tool call starting (one block per line, as Claude Code writes them) |
| `user` `{message: {content: [tool_result]}, parent_tool_use_id}` | a tool call ended |
| `control_request` `can_use_tool` `{tool_name, input, tool_use_id, switchboard_always?}` | an approval or a question (→ Inbox) |
| `control_cancel_request` | the CLI withdrew it (a resolved / stopped request) |
| `control_response` | the reply to a stdin control request |
| `system/compact_boundary` | the CLI compacted its context |
| `result` `{subtype, is_error, result, terminal_reason?, modelUsage: {<model>: {contextWindow}}, total_cost_usd?}` | the turn ended (`aborted_streaming` after a Stop) |

Tool names are mapped to Claude Code's, so the activity line (D19), the timeline kinds (gap #7), artifacts and D38's "solution written" work unchanged: a shell command → `Bash` `{command}`, a file change → `Edit` / `Write` `{file_path}`, a read → `Read`, a search → `Grep` / `Glob`, a web fetch → `WebFetch`, a subagent → `Agent` `{description, prompt}`, an MCP tool → `mcp__<server>__<tool>`, anything else → its own name.

### What a bridge reads (stdin side)
| Stream-json stdin | Codex app-server | OpenCode server |
|---|---|---|
| `control_request initialize` | `initialize` + `initialized`, `model/list` → `models[]` (`value`, `displayName`, `supportedEffortLevels`) | `GET /config/providers` → `models[]` (`provider/model`, the model's `variants` as efforts) |
| `user` message (text + D57 blocks) | `turn/start {threadId, input: [text, localImage]}` | `POST /session/:id/prompt_async {parts: [text, file]}` |
| `control_request interrupt` | `turn/interrupt {threadId, turnId}` | `POST /session/:id/abort` |
| `control_response` to `can_use_tool` | the JSON-RPC response `{decision: accept \| acceptForSession \| decline}` / `{answers}` | `POST /permission/:id/reply {reply: once \| always \| reject}` / `POST /question/:id/reply {answers}` |
| `set_model`, `apply_flag_settings {effortLevel}` | kept; sent as `model` / `effort` on the next `turn/start` | kept; sent as `model` / `variant` on the next prompt |
| `stop_task`, `remote_control`, `get_usage`, other | `control_response` error "not available in Codex CLI" | `control_response` error "not available in OpenCode" |
| EOF | the running turn ends, then the app-server's stdin is closed | the running turn ends, then the server gets SIGTERM |

A message written while a turn runs is held by the bridge and started when the turn ends (the D44 clock shows meanwhile; a Stop withdraws it from the bridge's queue).

### Permissions (D6 equivalent)
- **Claude Code:** unchanged (`--permission-mode auto`, fallback `acceptEdits`).
- **Codex:** `thread/start` / `thread/resume` with `sandbox: "workspace-write"` and `approvalPolicy: "on-request"`: edits and commands inside the cwd run, anything that needs to leave the sandbox asks (Codex's own "Auto" preset). Approvals become Inbox items with **Allow once / Always for this session / Deny** (`accept` / `acceptForSession` / `decline`).
- **OpenCode:** the server starts with `OPENCODE_CONFIG_CONTENT` = `{"permission":{"edit":"allow","bash":"ask","webfetch":"ask","external_directory":"ask"}}` (edits run, shell commands, fetches and paths outside the project ask: Claude's `acceptEdits`). Requests become Inbox items with **Allow once / Always for this session / Deny** (`once` / `always` / `reject`).

### Session ids
- Claude Code: `sessions.claude_session_id` as before (`--session-id` / `--resume`).
- Codex: the thread id from `thread/start` (`result.thread.id`); later spawns `thread/resume {threadId}`.
- OpenCode: the session id from `POST /session` (`ses…`); later spawns reuse it.
- Each is stored in `session_providers` (migration 0023) when the bridge learns it, so a switch back reopens the CLI's own conversation.

## Evidence (VERIFIED from source / docs, not run)

### Codex CLI — `rust-v0.159.3` (latest release, 2026-09-30)
Source root `R/` = `https://raw.githubusercontent.com/openai/codex/rust-v0.159.3/codex-rs/`.
- VERIFIED transport: `codex app-server` reads newline-delimited JSON on stdin and writes it on stdout (`R/app-server-transport/src/transport/stdio.rs`); messages carry **no** `"jsonrpc": "2.0"` field (`R/app-server-protocol/src/rpc.rs`): request `{id, method, params}`, notification `{method, params}`, response `{id, result}` / `{id, error: {code, message}}`.
- VERIFIED handshake: `initialize {clientInfo: {name, title, version}, capabilities?: {experimentalApi}}` → `{userAgent, codexHome, platformFamily, platformOs}`, then the notification `initialized`; requests before it fail "Not initialized" (`R/app-server-protocol/src/protocol/v1.rs`, `R/app-server/src/message_processor.rs`).
- VERIFIED threads and turns (`R/app-server-protocol/src/protocol/v2/thread.rs`, `turn.rs`): `thread/start {model?, cwd?, approvalPolicy?, sandbox?, …}` → `{thread: {id, …}, model, reasoningEffort, …}`; `thread/resume {threadId, …same overrides}`; `turn/start {threadId, input: UserInput[], model?, effort?, …}` → `{turn}`; `turn/interrupt {threadId, turnId}`; `thread/list {cwd?, limit, cursor, …}` → `{data: Thread[], nextCursor}`; `thread/read {threadId, includeTurns}`.
- VERIFIED `UserInput`: `{type: "text", text, text_elements: []}`, `{type: "image", url}`, `{type: "localImage", path}` (`R/…/v2/turn.rs`).
- VERIFIED `model/list {includeHidden?}` → `{data: [{id, model, displayName, description, hidden, supportedReasoningEfforts: [{reasoningEffort, description}], defaultReasoningEffort, isDefault, inputModalities}]}` (`R/…/v2/model.rs`).
- VERIFIED account (`R/…/v2/account.rs`): `account/read` → `{account: {type: "apiKey"} | {type: "chatgpt", email, planType} | null, requiresOpenaiAuth}`; `account/rateLimits/read` → `{rateLimits: {primary, secondary: {usedPercent, windowDurationMins, resetsAt}}}`; notification `account/rateLimits/updated {rateLimits}`.
- VERIFIED notifications (`R/app-server-protocol/src/protocol/common.rs`, `v2/notification.rs`, `v2/item.rs`): `turn/started` / `turn/completed {threadId, turn: {id, status: completed | interrupted | failed | inProgress, error}}`; `item/started` / `item/completed {item, threadId, turnId}`; `item/agentMessage/delta`; `item/reasoning/summaryTextDelta`; `thread/tokenUsage/updated {tokenUsage: {total, last: {inputTokens, cachedInputTokens, outputTokens, …}, modelContextWindow}}`; `error {error, willRetry}`.
- VERIFIED items: `userMessage`, `agentMessage {text}`, `reasoning {summary[], content[]}`, `commandExecution {command, cwd, status, aggregatedOutput, exitCode}`, `fileChange {changes: [{path, kind, diff}], status}`, `mcpToolCall {server, tool, arguments, result, error, status}`, `collabAgentToolCall {tool: spawnAgent | …, receiverThreadIds, prompt}`, `webSearch`, `plan`, `contextCompaction` (`R/…/v2/item.rs`).
- VERIFIED approvals: server requests `item/commandExecution/requestApproval {threadId, turnId, itemId, reason?, command?, cwd?}` and `item/fileChange/requestApproval {threadId, turnId, itemId, reason}`, answered `{decision: "accept" | "acceptForSession" | "decline" | "cancel"}`; questions: `item/tool/requestUserInput {questions: [{id, header, question, options: [{label, description}] | null}]}` answered `{answers: {<questionId>: {answers: string[]}}}` (EXPERIMENTAL in its doc comment) (`R/…/common.rs`, `v2/item.rs`).
- VERIFIED policies: approval `untrusted | on-request | never` (`on-failure` is an alias of `on-request`), sandbox `read-only | workspace-write | danger-full-access` (`R/protocol/src/protocol.rs`, `R/…/v2/shared.rs`).
- VERIFIED CLI: `codex login status` exits 0 signed in ("Logged in using …", on stderr), 1 otherwise ("Not logged in") (`R/cli/src/login.rs`); `codex mcp list --json` → `[{name, enabled, transport: {type: "stdio", command, args, …} | {type: "streamable_http", url, …}, auth_status}]`; `codex mcp add|remove|get|login|logout` (`R/cli/src/mcp_cmd.rs`); `codex resume`, `codex exec --json`, `codex exec resume <id>` (`R/exec/src/cli.rs`, `exec_events.rs`).
- VERIFIED storage: `$CODEX_HOME` (default `~/.codex`) holds `config.toml`, `auth.json`, `sessions/YYYY/MM/DD/rollout-<ts>-<thread uuid>.jsonl` (`.jsonl.zst` possible), lines `{timestamp, type: session_meta | response_item | event_msg | …, payload}` (`R/rollout/src/recorder.rs`); `[mcp_servers.<name>]` keys `command, args, env, url, enabled, …` (`R/config/src/mcp_types.rs`); `notify = [argv]` gets a JSON `{type: "agent-turn-complete", …}` argument (`R/hooks/src/legacy_notify.rs`).
- ASSUMED `codex --version` prints `codex-cli 0.159.3` (clap's default from the package name; not run). Switchboard keeps the whole first line.

### OpenCode — `v1.18.34` (latest release, 2026-09-30; repo `github.com/anomalyco/opencode`, formerly `sst/opencode`)
Source root `O/` = `https://raw.githubusercontent.com/anomalyco/opencode/v1.18.34/`.
- VERIFIED server: `opencode serve [--port <n>] [--hostname 127.0.0.1]` prints `opencode server listening on http://<host>:<port>` (`O/packages/opencode/src/cli/cmd/serve.ts`, `src/cli/network.ts`); port 0 tries 4096 first, so Switchboard passes an explicit free port. HTTP Basic auth when `OPENCODE_SERVER_PASSWORD` is set (user `OPENCODE_SERVER_USERNAME`, default `opencode`) (`src/server/auth.ts`). Every route takes `?directory=<abs path>` (the SDK's `x-opencode-directory`) (`O/packages/sdk/js/src/v2/client.ts`).
- VERIFIED HTTP API (`O/packages/sdk/openapi.json`): `POST /session {title?, permission?}` → `Session {id: "ses…", directory, title, …}`; `GET /session/:id`; `GET /session/:id/message`; `POST /session/:id/prompt_async {model?: {providerID, modelID}, variant?, agent?, parts: [{type: "text", text} | {type: "file", mime, url, filename?}]}` → 204; `POST /session/:id/abort`; `POST /permission/:requestID/reply {reply: once | always | reject, message?}`; `POST /question/:requestID/reply {answers: string[][]}`, `/reject`; `GET /config/providers` → `{providers: [{id, name, models: {<id>: {name, limit: {context, output}, variants?}}}], default: {<provider>: <model>}}`; `GET /provider` → `{all, default, connected: string[]}`; `GET /mcp`; `GET /global/health` → `{healthy, version}`.
- VERIFIED events: `GET /event?directory=…` is SSE, one `data: {id, type, properties}` per event, `server.connected` first, `server.heartbeat` every 10 s (`O/packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`). Types used: `session.status {sessionID, status: {type: idle | busy | retry}}`, `session.error {sessionID?, error: {name, data: {message}}}` (`MessageAbortedError` after an abort), `session.compacted`, `message.updated {info}` (assistant: `modelID, providerID, tokens {input, output, reasoning, cache {read, write}}, cost, time {created, completed?}`), `message.part.updated {part}` (`text`, `reasoning`, `tool {callID, tool, state: {status: pending | running | completed | error, input, output, error}}`, `step-finish`, `compaction`), `message.part.delta {messageID, partID, field, delta}`, `permission.asked {id, sessionID, permission, patterns, metadata, always, tool?: {messageID, callID}}`, `permission.replied`, `question.asked {id, sessionID, questions: [{question, header, options: [{label, description}], multiple?}]}`, `session.created {info: {parentID?}}` (subagent child sessions).
- VERIFIED config: permission keys `edit, bash, webfetch, external_directory, …` with `ask | allow | deny`; `OPENCODE_CONFIG_CONTENT` (inline JSON, high precedence); MCP `mcp: {<name>: {type: local, command: [...], environment, enabled} | {type: remote, url, headers, enabled}}` (`O/packages/opencode/src/config/config.ts`, opencode.ai/docs/permissions, /docs/mcp-servers).
- VERIFIED CLI: `opencode --version` prints the bare version (`1.18.34`); `opencode auth list` (alias of `opencode providers list`) prints `N credentials` (`0 credentials` signed out; ANSI, not machine format); `opencode models [provider]` prints `provider/model` lines; `opencode mcp list|add|auth|logout`; `opencode session list --format json` → `[{id, title, updated, created, projectId, directory}]`; `opencode export <id>` → `{info, messages: [{info, parts}]}` (`O/packages/opencode/src/cli/cmd/*.ts`).
- VERIFIED storage: sessions are in SQLite (`~/.local/share/opencode/opencode.db`; never read by Switchboard, which uses the CLI); `auth.json` in the same folder (never read); config in `~/.config/opencode/opencode.json(c)` and the project's `opencode.json`.
- ASSUMED the SSE stream writes no `event:` line Switchboard needs (only `data:` is parsed, as the SDK does).

## Capability matrix
`src/core/cli-providers.ts` → `CLI_CAPABILITIES` is the source; the UI shows a missing feature as a disabled control with "Not available in <CLI>: <reason>".

| Feature (decision) | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|
| Chat, tool steps, live activity (D19) | ✓ | ✓ app-server items | ✓ server events |
| Images (D57) | ✓ inline | ✓ `localImage` (the attachment's path) | ✓ `file` part (data: URL) |
| PDFs (D57) | ✓ inline | ✗ images only: sent as a file path | ✓ `file` part |
| Other files (D57) | ✓ path lines | ✓ path lines | ✓ path lines |
| Permission requests → Inbox (D6) | ✓ Allow once / Deny | ✓ + Always for this session (`acceptForSession`) | ✓ + Always (`always`) |
| Question cards (M3) | ✓ AskUserQuestion | ✓ `requestUserInput` (experimental) | ✓ `question.asked` |
| Stop the turn (D50) | ✓ | ✓ `turn/interrupt` | ✓ `abort` |
| Pause / resume (D7) | ✓ | ✓ `thread/resume` | ✓ same session id |
| Model (D31 / D42) | ✓ | ✓ `model/list` | ✓ `/config/providers` |
| Effort (D31 / D42) | ✓ | ✓ reasoning effort | ✓ model variants |
| Context meter (D49) | ✓ | ✓ `tokenUsage` + window | ✓ message tokens + model limit |
| Usage footer (D17 / D46) | ✓ 5 h / week | ✓ primary / secondary windows | ✗ cost only, no plan limits |
| Background tasks (D30 / D43), Stop background (D50) | ✓ | ✗ none | ✗ none |
| Subagents (D21 / D36) | ✓ | ✓ collab `spawnAgent` | ✓ `task` child sessions |
| Workflow agents (D51) | ✓ | ✗ Claude Code feature | ✗ Claude Code feature |
| Remote Control (D24), teleport (D25) | ✓ | ✗ claude.ai only | ✗ claude.ai only |
| Continue in terminal / Attach here | ✓ | ✓ `codex resume <id>`; Attach always asks first, no terminal-turn import | ✓ `opencode --session <id>`; Attach always asks first, no terminal-turn import |
| History import (D16) | ✓ transcripts | ✓ rollout files (read only), on request | ✓ `opencode session list` / `export`, on request |
| MCP page (D61) | ✓ every action | ✓ list / add / remove (`codex mcp`); Check, Reconnect, sign-in ✗ | ✓ list (`opencode mcp list`); add / remove ✗ (interactive) |
| Hooked terminal sessions (D48 P4) | ✓ | ✗ not bridged | ✗ not bridged |
| Worktrees (D40 / D47), schedules, peers (D48) | ✓ | ✓ | ✓ |
| Mid-session switch (D62) | ✓ | ✓ | ✓ |

Every ✗ is a control that stays visible and is disabled with "Not available in <CLI>: <reason>" (the header's Remote toggle, the Full form's "From a remote session", the MCP page's Add / Remove for OpenCode), or a feature with no data on that CLI (background tasks, Workflow agents); every CLI choice's tooltip names what that CLI lacks ("Not in Codex CLI: PDFs inline, background tasks, …", `missingFeaturesText`).

## Settings → CLIs
`src/server/cli/status.ts` → `CliStatusService`; routes in `src/server/api/clis.ts`; the page in `src/web/views/settings/ClisSection.tsx`.

- **Command:** Claude Code's is `SWITCHBOARD_CLAUDE_BIN` (env only, as before). Codex: `SWITCHBOARD_CODEX_BIN`, OpenCode: `SWITCHBOARD_OPENCODE_BIN` (a name, a path, or a JSON argv array), overridden by the page (settings rows `cli.codex.command` / `cli.opencode.command`, an argv array; **Reset** goes back to the environment's).
- **Checks** (read-only, argv arrays, 20 s each, never a credential file): `<cli> --version` (its first line), then the sign-in: `claude auth status` (exit code), `codex login status` (exit 0 = signed in, its stderr line shown; signed out with `OPENAI_API_KEY` / `CODEX_API_KEY` set = unknown), `opencode auth list` ("N credentials" + "M environment variables"; none = unknown, since a local model needs no key). Kept 60 s; **Check** runs them again and reads the models (Codex: a short-lived `codex app-server` doing `initialize` + `model/list` only; OpenCode: `opencode models`).
- **States:** installed / not installed (with the install commands and the docs link; Switchboard never installs a CLI) / signed out (the CLI's sign-in hint) / not supported by this build. A Codex / OpenCode that is not installed or signed out cannot be chosen (forms, the default, a switch, a schedule's run), with that reason. Claude Code stays choosable as before D62 (its failures show at the spawn).
- **Default CLI** (settings row `cli.default`, Claude Code on a fresh install): what new sessions start on; set here or in the sidebar footer.
- **Models:** each CLI keeps its own last list and last choice (`models.options.<cli>`, `models.last.<cli>`; Claude Code keeps D42's `models.options` / `models.last`), filled by its sessions' `initialize` and by Check.

## A CLI per session
- `NewSession.provider` / `NewSimpleSession.provider` (omitted = the default CLI); 422 on `provider` for an unknown or unavailable one. Stored in `sessions.provider` (migration 0023: every older session is `claude`).
- The **Simple** form has a CLI row above Model; the **Full** form a CLI row under D42's Model row (the visual oracle keeps the Model row's place); picking another CLI clears the model choice and the Model row lists that CLI's models. The summary's `model` line names a CLI other than Claude Code.
- A **schedule** template stores its CLI; a template without one (saved before D62) runs on Claude Code.
- Attachments (D57): images inline everywhere; PDFs inline for Claude Code and OpenCode, as file paths for Codex (images only).

## Switching CLIs (P5)
`SessionSupervisor.switchProvider`, `POST /api/sessions/{id}/provider { provider }` → 202 `{ session, switchId }`; the header's CLI switcher (`ProviderSwitcher.tsx`) asks first ("Switch this session from Claude Code to Codex CLI? …").

1. **Capacity** (`src/server/cli/capacity.ts`): the outgoing CLI is supported, installed, not signed out, and none of its reported usage windows is at 100 % before its reset (Claude Code: the latest D17 reading; Codex: its rate-limit windows; OpenCode reports none).
2. **With capacity** the outgoing agent gets a service message asking for a handover (goal, decisions, files changed, open tasks, next step, anything uncommitted; `handoverRequest`); a paused session is resumed on its own CLI for it. Switchboard waits for that turn (10 minutes at most) and takes the agent's last reply.
3. **Without capacity, or when that fails** (the turn's error, e.g. "Codex: You've hit your usage limit", no reply, the process ending, the timeout), the chat is exported as Markdown to `<dataDir>/handovers/<session>/<stamp>-<from>-to-<to>.md` (folder 0700, file 0600; the developer's and Switchboard's messages, the agents' texts, one line per tool step, errors, earlier switches; the newest 2 MB) and the incoming agent's first message tells it to read it, and the outgoing CLI's own record (Claude Code's transcript, Codex's rollout file, `opencode export <id>`), summarize where things stand and continue.
4. The outgoing process is stopped (D7's stop), the session's CLI becomes the new one, its model / effort choice, model list and context meter start over (each CLI has its own), Remote Control is off, and the incoming CLI starts **in the same cwd**. A CLI that ran the session before reopens **its own** conversation (Claude Code `--resume <id>`, Codex `thread/resume`, OpenCode the same session) and gets the handover of what happened meanwhile; one that never ran it starts new.
5. The chat shows the divider (the lifecycle event `switched`): "Switched from Claude Code to Codex CLI · handover by Claude Code (outgoing agent)" / "… · handover by Codex CLI from the history".

While a switch runs, `Session.providerSwitch` says its step (`handover` → `export` → `stopping` → `starting`), the header shows "Switching to Codex CLI… asking Claude Code for a handover", and messages, Resume and Attach answer 409 `switching`. Each switch is a `provider_switches` row (`running` → `done` / `failed`); a restart marks a cut switch failed; shutdown waits for a running switch once the processes are stopped. Hooked terminal sessions, closed and detached sessions cannot switch.

## Sidebar (P6)
- The footer's "claude code" label is the **default-CLI switcher** (its text the default CLI: `claude code`, `codex cli`, `opencode`): a menu with the three CLIs (unavailable ones disabled with their reason) and **Switch running sessions…**.
- **Switch running sessions…** lists the sessions with a live process (attached, open, not hooked; a paired machine's too), all ticked, the target CLI defaulting to the default CLI; **Switch N sessions** starts each one's own switch (P5) at once; each row shows its progress, "✓ on Codex CLI" or why it failed; the others go on.
- Rows carry a small CLI badge (`claude`, `codex`, `opencode`) once the list holds a session on another CLI than Claude Code (a Claude-only list looks as before, D14's folder-tag rule).

## Usage, context, history, MCP (P7)
- **Usage:** Codex's rate limits (`account/rateLimits/read` at the bridge's start, `account/rateLimits/updated`) become footer rows `Codex 5h` / `Codex week` (`SystemInfo.cliUsage`) while known; OpenCode reports a cost per message, no plan limits. Claude Code's `get_usage` poller never asks another CLI's session.
- **Context:** Codex `thread/tokenUsage/updated` (tokens = `last.inputTokens`, window = `modelContextWindow`); OpenCode a completed assistant message's `tokens` and the model's `limit.context`; no auto-compact tick for either (their thresholds are not known); their compactions reset the meter.
- **History:** with the page's "Also list Codex CLI and OpenCode terminal conversations" (`GET /api/history?cli=1`; off by default because it reads `$CODEX_HOME/sessions` and runs `opencode session list` in each saved folder) the conversations not in Switchboard yet are rows (`terminal · Codex CLI`); **Continue in Switchboard** (`POST /api/history/cli/{provider}/{id}/continue`) always asks first (no CLI but Claude Code can say whether a terminal holds it), needs a saved folder that holds where it started, imports its prompts and replies, and the CLI reopens it idle (`SessionSupervisor.adoptCli`).
- **MCP page:** under Claude Code's servers, a *Codex CLI and OpenCode* section (`src/server/mcp/cli-mcp.ts`): Codex's servers through `codex mcp list --json` / `add` / `remove`; OpenCode's through `opencode mcp list` (Add / Remove marked: its `mcp add` is interactive); secrets masked as D61 does.
- **Peers (D48):** a peer's sessions carry their CLI through the proxy; the forms' CLI row and the header's switcher read that machine's `GET /api/clis`; the switch and the CLI MCP routes are on `PEER_API_ALLOW`. Hooking into terminal sessions (P4) stays Claude Code's.

## Restart recovery
A Codex / OpenCode session whose recorded pid is still alive after a crash is not resumed and its process is not signalled (`claude agents --json` cannot tell it from pid reuse); the session is left paused with the reason. A Codex app-server ends with its stdin (ASSUMED); an `opencode serve` does not, so a SIGKILLed Switchboard can leave one running (OPEN D62-orphan-opencode).

### Servers that outlive Switchboard
A Codex app-server ends with its stdin (ASSUMED); an `opencode serve` does not watch its stdin, so a Switchboard killed before its own shutdown has stopped it (a SIGKILL, a crash, launchd's exit timeout: a clean stop of a busy CLI can take up to ~30 s — interrupt, result, exit, signals — and test servers are SIGKILLed after 5 s) used to leave it running. Now (`src/server/cli/reaper.ts`):
- the OpenCode server runs in its own process group (POSIX), and every stop signals the group, so the server's own children stop with it;
- it is registered with the **orphan reaper**: one small Node process per Switchboard (`src/server/cli/reaper-main.ts`, started with the first server, in its own process group, not keeping Switchboard alive), fed `+<pid>` / `-<pid>` lines on its stdin. When that pipe ends — Switchboard is gone, however it ended — every server still listed gets SIGTERM to its group, SIGKILL 2 s later; then the reaper exits. A server Switchboard stopped itself was unregistered on its exit, so a clean stop leaves the reaper nothing to do.
- Windows has no process groups here: the reaper signals the pid alone.
Tests: `tests/server/cli/reaper.test.ts` (a SIGKILLed stand-in; its server and the server's child are stopped; an unregistered server is left alone).

## Tests
Fakes: `tools/fake-codex` (`docs/fake-codex.md`), `tools/fake-opencode` (`docs/fake-opencode.md`); every test server and supervisor world points `SWITCHBOARD_CODEX_BIN` / `SWITCHBOARD_OPENCODE_BIN` at them with `CODEX_HOME` / `XDG_DATA_HOME` in a temp folder. Oracles: `tests/server/cli/*.test.ts` (registry, status, codex, opencode, switch, parity), `tests/server/api/clis.test.ts`, `tests/server/history/cli-history.test.ts`, `tests/server/db/migrate.test.ts` (0023), `tests/tools/fake-codex.test.ts`, `tests/tools/fake-opencode.test.ts`, `tests/web/cli-*.test.ts`, `tests/web/provider-switch.test.ts`, `tests/e2e/cli-providers.spec.ts`.

## Standing instruction (D64)
Settings → Sessions & worktrees → *Standing instruction for agents* (`docs/settings.md`) reaches every CLI at every spawn (`SpawnRequest.standingInstruction`, read by `#spawn`; `null` when it is off or empty). It is never a user message, so the chat shows nothing extra.

| CLI | Mechanism |
|---|---|
| Claude Code | `--append-system-prompt <text>` in `buildClaudeArgs` (VERIFIED in `claude --help`, 2.1.285) |
| Codex CLI | `developerInstructions` in the `thread/start` and `thread/resume` parameters (ASSUMED D64-codex-developer-instructions: not run; if a real `codex app-server` rejects or ignores the field, the fallback is the first turn's text marked as a service message) |
| OpenCode | `system` in each `POST /session/:id/prompt_async` body (ASSUMED D64-opencode-system: not run), so a reopened session carries it too |

Hooked terminal sessions (D48) and terminal runs the developer starts themselves are not affected. `tools/fake-codex` logs `{kind:"thread-params", method, developerInstructions}`; `tools/fake-opencode` already logs the prompt body; `tools/fake-claude` accepts the flag (the argv log is what tests read). Oracle: `tests/server/supervisor/standing-instruction.test.ts`.

## Accounts (D63)
Each CLI can have several subscription logins ("account profiles") and a session moves to another one when its account hits a usage limit: `docs/accounts.md`. A profile's process gets its own `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_DATA_HOME` (`SpawnRequest.env`); the D62 handover is the fallback when a conversation cannot be carried over, and "switch to another CLI" is one of the rules for a CLI whose accounts are all spent.
