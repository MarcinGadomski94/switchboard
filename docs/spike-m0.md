# M0 spike: Claude Code headless surface

What the installed CLI actually does, captured with real probes. Later items build on these findings. Where this file and `docs/handoff/ARCHITECTURE.md` differ on CLI behavior, this file records what was observed; `docs/decisions.md` still wins on rulings.

## Summary

| Item | Status | Verdict (one line) |
|---|---|---|
| M0.1 Headless surface | done (2026-09-27) | One long-lived `claude -p --input-format stream-json --output-format stream-json --verbose` process per session works: multi-turn over stdin, interrupt via a stdin `control_request`, `--session-id` / `--resume` / `--fork-session` behave as needed, hooks from `--settings` fire in `-p`. `auto` permission mode could not be proven (the model gates it), so sessions default to `acceptEdits` (D6). Switchboard does not use `--bg`/`attach`. |
| M0.2 Questions & permissions | pending | |
| M0.3 Transcripts & usage | pending | Lead from M0.1: `rate_limit_event.rate_limit_info.unifiedWindows.{five_hour,seven_day}.utilization` arrives in every stream. |
| M0.4 Terminal handoff | pending | Lead from M0.1: `--resume <id>` works from any cwd and keeps the id. |

---

## M0.1 Claude Code headless surface

### Probe conditions
- CLI `2.1.283 (Claude Code)` at `~/.local/bin/claude`, Node `v24.21.0`, macOS.
- Every real call: `--model haiku` (resolved to `claude-haiku-4-5-20251001`), `--max-turns` 1 or 3, cwd `.spike/sandbox/<scenario>/` (D11). 23 real model calls in total.
- Probes were spawned by `.spike/probe.mjs` (gitignored) with `spawn('claude', argv, { shell: false })` and an env **without** `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`, which leak from the parent Claude Code session. Switchboard runs as a service and will not have them. The supervisor should still strip them from the child env as a defensive measure. `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN` in particular would tie a child to the parent session.
- The user-level settings of this machine were active (not isolated): they add a `SessionStart`/`PreToolUse`/`PostToolUse` hook (`codebase-memory-mcp hook-augment`), plugins and MCP servers. That is realistic for how Switchboard will run.

### Fixtures
`tools/fake-claude/fixtures/<scenario>.ndjson` is the stdout exactly as captured. `<scenario>.stdin.ndjson` is what was written to stdin, present only for stream-json input scenarios. The only change is a textual replacement of the home directory (`/Users/<name>` → `/Users/dev`, `-Users-<name>` → `-Users-dev`). `manifest.json` holds, per scenario, the exact argv, cwd, exit code, the stdin timing plan and a one-line note. M1.2 can drive `fake-claude` from it.

| Scenario | Args beyond `-p … --output-format stream-json --verbose --model haiku` | Exit | Shows |
|---|---|---|---|
| `basic` | `--max-turns 1` | 0 | minimal message sequence |
| `tool-use` | `--max-turns 3 --permission-mode acceptEdits` | 0 | Write + Bash tool_use / tool_result |
| `perm-manual` | `… --permission-mode manual` | 0 | denial without a permission host |
| `perm-auto` | `… --permission-mode auto` | 0 | silent fallback to `default` |
| `perm-plan` | `… --permission-mode plan` | 0 | no tool calls, model asks to leave plan mode |
| `perm-dontask` | `… --permission-mode dontAsk` | 0 | denial with `decision_reason_type: "mode"` |
| `perm-bypass` | `… --permission-mode bypassPermissions` | 0 | everything allowed |
| `allowed-tools` | `… --permission-mode manual --allowedTools Write` | 0 | Write allowed, `touch` via Bash denied |
| `max-turns` | `--max-turns 1 --permission-mode acceptEdits` | **1** | `result/error_max_turns` |
| `subagent` | `--max-turns 3 --permission-mode acceptEdits` | 0 | Agent tool, `parent_tool_use_id`, `system/task_*` |
| `subagent-forward` | same + `--forward-subagent-text` | 0 | subagent text/thinking forwarded too |
| `hooks` | `… --settings <hooks file> --include-hook-events` | 0 | every hook event in the stream |
| `hooks-default` | `… --settings <hooks file>` | 0 | only SessionStart hook events in the stream |
| `multiturn` | `-p --input-format stream-json … --session-id <uuid> --replay-user-messages` | 0 | 2 turns in one process, replayed user messages |
| `eof-immediate` | `-p --input-format stream-json …` | 0 | stdin closed right after the first message |
| `interrupt` | `-p --input-format stream-json … --allowedTools "Bash(sleep *)"` | 0 | interrupt `control_request` between tool calls |
| `interrupt-tool` | `-p --input-format stream-json … --allowedTools "Bash(node -e *)"` | 0 | interrupt while a foreground Bash tool runs |
| `sigint` | `-p --input-format stream-json … --allowedTools "Bash(sleep *)"` + SIGINT | 0 | SIGINT mid-turn |
| `resume` | `--resume <multiturn id>` (from a different cwd) | 0 | same session id, context kept |
| `fork` | `--resume <multiturn id> --fork-session` | 0 | new session id, context kept |

Exact example (the `multiturn` shape, which is the one Switchboard uses):
```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --model haiku --max-turns 3 --permission-mode acceptEdits \
  --session-id 7286a5ee-4a39-47f3-821d-010c8dca1e50 --replay-user-messages
stdin: {"type":"user","message":{"role":"user","content":"Remember the code word: zeppelin. Reply with just OK."}}
       (after the result) {"type":"user","message":{"role":"user","content":"What code word did I ask you to remember? Reply with just the word."}}
       (then EOF)
```

### Recommended baseline for the SessionSupervisor (M2.1)
```
claude -p --input-format stream-json --output-format stream-json --verbose
       --session-id <uuid>            # new session; or --resume <id> to continue
       --permission-mode acceptEdits  # D6 fallback, see "Permission modes"
       --settings <switchboard-owned hooks file>   # only if M0.2 needs hooks
       [--forward-subagent-text] [--replay-user-messages] [--name <session name>]
cwd = workspace root; spawn(..., { shell: false }); env without CLAUDECODE / CLAUDE_CODE_*
```
No prompt argument. Every user message, the first one included, goes through stdin.

### Stream-json output (`--output-format stream-json --verbose`)
One JSON object per line. Every line except `control_response` has `session_id` and `uuid`. Observed `type[/subtype]` values:

| Message | Key fields | Notes |
|---|---|---|
| `system/hook_started` | `hook_id, hook_name ("SessionStart:startup", "PreToolUse:Read"…), hook_event` | SessionStart ones always appear, **before** `system/init`. Others only with `--include-hook-events`. |
| `system/hook_response` | `hook_id, hook_name, hook_event, output, stdout, stderr, exit_code, outcome` | pairs with `hook_started` by `hook_id` |
| `system/init` | `session_id, cwd, model, permissionMode, tools[], mcp_servers[{name,status,source}], agents[], skills[], plugins[], slash_commands[], claude_code_version, capabilities[], apiKeySource, memory_paths` | With stream-json input it is **re-emitted at the start of every turn** (the tool count grew 102 → 119 as MCP tools loaded). Treat it as "turn started / metadata refresh", not a new session. `capabilities` includes `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`. |
| `system/commands_changed` | `commands[{name, description, argumentHint}]` | slash-command list, large |
| `system/thinking_tokens` | `estimated_tokens, estimated_tokens_delta` | progress tick while the model thinks |
| `assistant` | `message{id, model, content[], stop_reason, usage}, parent_tool_use_id, request_id, timestamp, wire_tool_inputs?` | **One message per content block**: thinking, text and each tool_use arrive as separate `assistant` lines sharing `message.id`. `stop_reason` is null on these lines. Content blocks: `{type:"thinking", thinking:"", signature}` (thinking text is empty), `{type:"text", text}`, `{type:"tool_use", id:"toolu_…", name, input}`. |
| `user` (tool result) | `message.content[{type:"tool_result", tool_use_id, content, is_error?}], tool_use_result{…}, parent_tool_use_id, timestamp` | `tool_use_result` is the structured result (Write: `type,filePath,content,structuredPatch,originalFile`; Bash: `stdout,stderr,interrupted,…`; Agent: `status,agentId,agentType,totalTokens,totalToolUseCount,usage,…`). |
| `user` (replay) | `message.content: "<text>", isReplay: true` | only with `--replay-user-messages`: acknowledges each stdin message as it is taken up |
| `user` (interrupt marker) | `message.content[{type:"text", text:"[Request interrupted by user]"}]` or `"… for tool use]"` | see "Interrupt" |
| `system/permission_denied` | `tool_name, tool_use_id, message, decision_reason_type?` | followed by an `is_error` tool_result with the same text |
| `system/task_started` | `task_id, tool_use_id, description, task_type ("local_agent" \| "local_bash"), subagent_type?, spawn_depth?, prompt?, is_backgrounded` | subagent or background shell started |
| `system/task_progress` | `task_id, tool_use_id, description, usage{total_tokens,tool_uses,duration_ms}, last_tool_name` | subagent progress |
| `system/task_updated` | `task_id, patch{status: "completed" \| "killed", end_time}` | |
| `system/task_notification` | `task_id, tool_use_id, status, summary, output_file, usage?` | final subagent/background-task summary |
| `system/background_tasks_changed` | `tasks[{task_id, task_type, description}]` | background Bash list |
| `rate_limit_event` | `rate_limit_info{status, resetsAt, rateLimitType, unifiedWindows{five_hour{utilization,resetsAt}, seven_day{utilization,resetsAt}}, overageStatus, isUsingOverage}` | one per turn. `utilization` is 0–1 (observed 0.07 / 0.17). Candidate source for the Max usage meter (M0.3/M9.2). |
| `control_response` | `response{subtype:"success", request_id, response{still_queued[]}}` | reply to a stdin `control_request`. No `session_id`. |
| `result/success` | `result (final text), num_turns, total_cost_usd, usage, modelUsage{<model>{costUSD,…}}, permission_denials[{tool_name,tool_use_id,tool_input}], terminal_reason ("completed"), duration_ms, duration_api_ms, stop_reason, subagent_stats, result_index, is_error:false` | one per turn. `result_index` counts results within the process (0, 1, …). |
| `result/error_max_turns` | `is_error:true, errors:["Reached maximum number of turns (1)"], terminal_reason:"max_turns"` | no `result` text. Process exit code 1 in `-p` text mode. |
| `result/error_during_execution` | `is_error:true, errors[…], terminal_reason: "aborted_streaming" \| "aborted_tools"` | after an interrupt or SIGINT |

Subagents (the `Agent` tool; `init.tools` still lists it as `Task`):
- Main-agent `tool_use` `{name:"Agent", input:{description, subagent_type, prompt, run_in_background}}`.
- The subagent's own messages (its prompt as a `user` line, its `tool_use`, its `tool_result`) carry `parent_tool_use_id = <Agent tool_use id>`, plus `subagent_type` and `task_description`. Its text and thinking are forwarded only with `--forward-subagent-text`.
- Lifecycle: `task_started` → `task_progress`* → `task_updated{status:completed}` → `task_notification{summary}` → the Agent `tool_result` in the main thread.
- `result.subagent_stats` counts spawned / completed / failed agents by type.
- For the agents panel (gap #8), one agent = one Agent `tool_use` id. Use `--forward-subagent-text` so the chat and timeline can show subagent text.

### Streaming input (`--input-format stream-json`)
- User message line: `{"type":"user","message":{"role":"user","content":"<text>"}}`. No prompt argument is needed with `-p`.
- **One process is multi-turn.** Each stdin message runs a full turn and ends with its own `result`. The process stays alive and idle while stdin is open (it was checked 8 s after the last result).
- **What closes it: EOF on stdin.** If EOF arrives mid-turn, the running turn still completes and emits its `result`, then the process exits with code 0 (`eof-immediate`). Pausing does not need a signal.
- `--replay-user-messages` echoes each consumed stdin message as a `user` line with `isReplay: true`. That is useful to confirm delivery of queued messages.
- `result.queued_turn_count` and `control_response.response.still_queued` suggest that a message sent while a turn is running gets queued. Their names suggest this; sending mid-turn without an interrupt was not probed.

### Session id, resume, fork
- `--session-id <uuid>` on start: `init.session_id` equals the given uuid (`multiturn`).
- `--resume <id>` keeps the **same** `session_id` and the full context, even when started from a **different cwd** (`resume` ran in `sandbox/resume` and resumed a session created in `sandbox/multiturn`). The new turns are appended to the **original** transcript file, `~/.claude/projects/<dashed original cwd>/<id>.jsonl`, with the new `cwd` on each entry. No new project folder is created.
- `--resume <id> --fork-session` gives a **new** `session_id` with the context copied (`fork`). A new transcript file is created under the fork's cwd.
- Implication (D7, M2.4): Resume = spawn with `--resume <claudeSessionId>` and send "Continue." on stdin. The id stays stable, so the Session↔claudeSessionId mapping never changes.

### Permission modes (`--permission-mode`)
`--help` lists `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`. `default` is also accepted (undocumented alias). `manual` is reported as `"default"` in `init.permissionMode`.

Same prompt for every probe: Write `out.txt` + run `ls` with Bash. Text-mode `-p`, so there is no permission host.

| Mode | init.permissionMode | Write | Bash | Stream evidence |
|---|---|---|---|---|
| `manual` | `default` | denied | `ls` allowed (read-only) | `system/permission_denied` + `is_error` tool_result + `result.permission_denials[]`; the run continues, no hang |
| `acceptEdits` | `acceptEdits` | allowed | `ls` allowed; `touch bash.txt` allowed (`max-turns`) | none |
| `auto` | **`default`** | denied | `ls` allowed | silent fallback. The debug log says `auto mode disabled: model claude-haiku-4-5-20251001 does not support auto mode` (`verifyAutoModeGateAccess … modelSupported=false`). Nothing on stdout/stderr. |
| `plan` | `plan` | not attempted | not attempted | the model answers in text and asks to leave plan mode |
| `dontAsk` | `dontAsk` | denied, `decision_reason_type:"mode"` | `ls` allowed | the denial message tells the model not to work around it |
| `bypassPermissions` | `bypassPermissions` | allowed | allowed | works in `-p` without `--allow-dangerously-skip-permissions` |

**Verdict for D6.** Auto mode is gated by model. Haiku is not supported, and D11 forbids other models in probes, so **M0 could not prove auto works headless**. Per D6 the default is **`acceptEdits`** (logged as ASSUMED). Whatever mode it requests, Switchboard must read `init.permissionMode` and flag a mismatch, because an unsupported `auto` silently becomes `default`, which denies every edit in headless mode. Related flag for M0.2: `--permission-prompts host|none` ("who answers permission prompts with --print: the SDK host or --permission-prompt-tool"). Without a host, as in these probes, requests are denied immediately.

### `--allowedTools`
- `--allowedTools Write` in `manual` mode: Write ran without a prompt; `touch` via Bash was denied ("touch in '…/bash.txt' needs approval … Claude Code asks before a shell command creates, changes or removes files there").
- Rule syntax with arguments works: `"Bash(sleep *)"`, `"Bash(node -e *)"`.
- **An allowed Write is not confined to cwd.** In `allowed-tools` the model wrote `out.txt` to the repo root, the git root above the sandbox cwd. The file was deleted right away. Allow-rules are no sandbox.
- The CLI itself blocks standalone `sleep N` in Bash ("Blocked: standalone sleep 25. To wait for a condition, use Monitor …"). A long-running fake tool needs another command.
- `--disallowedTools` and `--tools` exist. They were not probed.

### `--max-turns`
`--max-turns 1` on a two-tool task: the run stopped after the tool calls with `result/error_max_turns`, `is_error:true`, `errors:["Reached maximum number of turns (1)"]`, `terminal_reason:"max_turns"`, `num_turns:2`, and the **process exit code was 1**. The Write and Bash calls had already executed.

### Hooks in `-p` mode (`--settings <file>`)
Probe settings (`.spike/sandbox/hooks-shared/settings.json`): `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `Notification`, `SessionEnd`, plus `PreToolUse`/`PostToolUse` with matcher `*`. Each one runs `node "<abs path>/log.mjs" <Event>`, which appends `{ev, input}` to `./hooks.log`. The SessionStart hook also prints `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"SB_PROBE_CONTEXT: the magic word is marmalade"}}`.

- **All of them fire in `-p`:** SessionStart (`source:"startup"`), UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd. SubagentStop and Notification had no trigger in this probe. `--settings` hooks **merge** with the user's own hooks, so both SessionStart hooks and both PostToolUse:Read hooks ran.
- The SessionStart `additionalContext` reached the model: it answered "marmalade".
- Hook stdin fields: SessionStart `session_id, transcript_path, cwd, hook_event_name, source`; UserPromptSubmit adds `prompt_id, permission_mode, prompt`; PreToolUse `… tool_name, tool_input, tool_use_id`; PostToolUse adds `tool_response, duration_ms`; Stop `… stop_hook_active, last_assistant_message, background_tasks, session_crons`; SessionEnd `… reason`. `transcript_path` gives the transcript location directly (M0.3).
- In the stream: without `--include-hook-events` only SessionStart `hook_started`/`hook_response` appear. The other hooks still run. With it, every hook shows up as a `hook_started`/`hook_response` pair (`hook_name` e.g. `"PreToolUse:Read"`, `"Stop"`).

### Interrupting a running turn
- **Stdin control message (preferred):** `{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}`.
  - The reply is `{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"still_queued":[]}}}`.
  - During a running tool (`interrupt-tool`): an `is_error` tool_result ("The user doesn't want to proceed with this tool use. The tool use was rejected …"), then `user` "[Request interrupted by user for tool use]", then `result/error_during_execution` with `terminal_reason:"aborted_tools"`.
  - Between tool calls or while streaming (`interrupt`): `user` "[Request interrupted by user]", then `result/error_during_execution` with `terminal_reason:"aborted_streaming"`.
  - **The process stays alive.** The next stdin message ran normally (`resumed-ok`, `result_index:1`).
- **SIGINT** (`sigint`): the same "[Request interrupted by user]" + `result/error_during_execution` (`aborted_streaming`). A running background Bash task was killed (`task_updated{status:"killed"}`). The process then **exited with code 0** within ~0.5 s.
- D7 Pause = send the interrupt `control_request`, wait for the `result`, close stdin (EOF, exit 0). Escalate to SIGINT, then SIGTERM/SIGKILL on timeout.

### Background sessions and attach (`--bg`, `claude attach`, `claude agents`)
- `--help` on 2.1.283 has `--bg/--background` ("Start the session in the background and return immediately. Prints the id that `claude attach`, `logs`, `stop` and `rm` take; `claude agents` lists them"). The related subcommands are `attach <id>` (opens the background session's TUI in this terminal), `logs <id>`, `stop|kill <id>`, `rm <id>`, `respawn`, and `agents [--json] [--all] [--cwd <path>]`.
- `claude --bg --model haiku --max-turns 1 "…"` in the sandbox **refused** before any model call: `Workspace not trusted. Run \`claude\` in <dir> once and accept the trust prompt, then retry.` (exit 1). Accepting trust writes the user's `~/.claude.json`, which is outside D12, so it was not done. For reference, the real workspace root is already trusted there. The live `--bg`/`attach` round trip is **not verified**.
- `claude agents --json [--all] [--cwd <dir>]` (no model call) returns the live sessions: `[{pid, cwd, kind:"interactive", startedAt (ms), sessionId, name, status:"busy"|"idle"}]`. **A supervised `-p` stream-json process is listed too** while it runs (`agents-visibility` probe: `kind:"interactive"`, auto name `<cwd basename>-NN`, `status` busy then idle), and it disappears on exit.
- **Verdict.** Switchboard does not use `--bg`/`attach`. A `--bg` session is TUI-driven, so Switchboard could not read stream-json from it or answer its questions. "Continue in terminal" stays as ARCHITECTURE describes: stop the supervised process, show `claude --resume <id>` (M0.4 proves it). `claude agents --json` is a cheap, model-free check that a session id is currently open in some terminal. Use it for the "Attach here" warning (gap #5) alongside the transcript-mtime rule.

### Other `--help` flags worth knowing
`--include-partial-messages` (token-level streaming chunks), `--name <name>` (display name shown in `claude agents` and the resume picker; pass the Switchboard session name), `--add-dir`, `--agents <json|file>`, `--append-system-prompt`, `--mcp-config`/`--strict-mcp-config`, `--setting-sources`, `--max-budget-usd`, `--no-session-persistence` (do not use: it breaks resume), `--effort`, `--fallback-model`, `-w/--worktree`, `--prompt-suggestions`, `--brief`. Subcommand `claude auth status` exists for the wizard (M5.3). It was not run here.

### Incidents during the spike
- One early call (`claude -p hi --permission-mode default --model haiku --max-turns 1`, meant to test flag validation) ran with cwd `.spike/` instead of `.spike/sandbox/` and with the parent env. It was a text-only reply with no tools. The only effect is a transcript under `~/.claude/projects/` (accepted by D11).
- The `allowed-tools` probe wrote `out.txt` (content `HELLO`) to the repo root. It was removed immediately, and `git status` was clean afterwards.

### Implications for later items
- **M1.2 fake-claude:** replay `fixtures/*.ndjson` per `manifest.json`. Support these behaviors:
  - Stream-json input with one `result` per stdin user message.
  - `system/init` repeated per turn.
  - Interrupt `control_request` → `control_response` + interrupted result.
  - SIGINT → interrupted result, exit 0.
  - EOF → finish the turn, exit 0.
  - `--session-id` / `--resume` (same id) / `--fork-session` (new id).
  - `--max-turns` → `error_max_turns`, exit 1.
  - Rewrite `cwd`/`session_id` on replay.
- **M2.1 parser:** key events by `session_id` + `parent_tool_use_id`.
  - Merge `assistant` lines by `message.id`.
  - Pair `tool_use.id` ↔ `tool_result.tool_use_id`.
  - Treat `result` as turn end, `system/task_*` as agent lifecycle, `rate_limit_event` as usage.
  - Timeline kinds (gap #7): tool names come from `tool_use.name`; permission/question events come from `system/permission_denied` (M0.2 will add the interactive path).
- **M2.4 crash recovery / D7:** `--resume <id>` + "Continue." keeps the id. Detect a failed start with `result.is_error` / the exit code.
- **M5.2 first-turn payload (adapt after M0):** the confirmed session-start answers go into the **first stdin user message**, since there is no prompt argument. Optionally they can also go in via `--append-system-prompt`. That flag was not probed.
- **M9.2 usage meter:** the `rate_limit_event` utilization values are the lead. M0.3 decides.
