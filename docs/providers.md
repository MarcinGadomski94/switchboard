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
| Continue in terminal / Attach here | ✓ | ✓ `codex resume <id>`; no terminal-turn import | ✓ `opencode --session <id>`; no terminal-turn import |
| History import (D16) | ✓ transcripts | ✓ rollout files (read only) | ✓ `opencode session list` / `export` |
| MCP page (D61) | ✓ | ✓ `codex mcp` | ✓ `opencode mcp` / config |
| Hooked terminal sessions (D48 P4) | ✓ | ✗ not bridged | ✗ not bridged |
| Worktrees (D40 / D47), schedules, peers (D48) | ✓ | ✓ | ✓ |
| Mid-session switch (D62) | ✓ | ✓ | ✓ |

(The table is completed in P7; rows not built yet are said so in `.loop/questions.md` → *D62*.)
