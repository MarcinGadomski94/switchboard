# M0 spike: Claude Code headless surface

What the installed CLI actually does, captured with real probes. Later items build on these findings. Where this file and `docs/handoff/ARCHITECTURE.md` differ on CLI behavior, this file records what was observed; `docs/decisions.md` still wins on rulings.

## Summary

| Item | Status | Verdict (one line) |
|---|---|---|
| M0.1 Headless surface | done (2026-09-27) | One long-lived `claude -p --input-format stream-json --output-format stream-json --verbose` process per session works: multi-turn over stdin, interrupt via a stdin `control_request`, `--session-id` / `--resume` / `--fork-session` behave as needed, hooks from `--settings` fire in `-p`. `auto` permission mode could not be proven (the model gates it), so sessions default to `acceptEdits` (D6). Switchboard does not use `--bg`/`attach`. |
| M0.2 Questions & permissions | done (2026-09-27) | Mechanism (a) works end to end: add `--permission-prompt-tool stdio` to the supervised stream-json process. Every question batch (`AskUserQuestion`) and every permission request arrives on stdout as `control_request/can_use_tool` and is answered with one `control_response` line on stdin (`allow` + `updatedInput.answers`, or `allow` / `deny`). (b) SDK and (c) hooks were not needed. `auto` is still not proven (Haiku lacks it), so `acceptEdits` stays the default. |
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

---

## M0.2 Questions & permissions

### Probe conditions
- Same CLI, Node and machine as M0.1. Every real call used `--model haiku`, `--max-turns 3` (1 for `ctl-init`) and cwd `.spike/sandbox/<scenario>/` (D11). The env was scrubbed the same way as in M0.1. That makes 14 `claude` processes: 13 made model calls and `ctl-init` made none.
- Runner: `.spike/probe2.mjs` (gitignored). It is `probe.mjs` plus a small **control host**. It reads stdout line by line and answers each `control_request/can_use_tool` with a `control_response` line on stdin. Every stdin line is logged to `<scenario>.stdin.ndjson`.
- Order tried, per the item: (a) native stream-json control protocol → **worked on the first probe**, so (b) the Agent SDK and (c) a PreToolUse hook were **not probed**.

### Fixtures (M0.2)
Same format and scrub as M0.1 (`manifest.json` has argv, cwd, exit code, stdin plan and a note per scenario). In `ctl-init` only, the account email and organization from the `initialize` response are also replaced (`dev@example.com`, `Example Org`).

| Scenario | Extra args (all: `-p --input-format stream-json --output-format stream-json --verbose --model haiku --max-turns 3 --permission-mode acceptEdits`) | Exit | Shows |
|---|---|---|---|
| `ask-2q` | `--permission-prompt-tool stdio` | 0 | **Oracle (1):** 2-question AskUserQuestion answered end to end; the model replies "You chose a green button in small size." |
| `perm-allow` | `--permission-prompt-tool stdio` | 0 | **Oracle (2):** Bash permission request → allow once → runs, prints 42 |
| `perm-deny` | `--permission-prompt-tool stdio` | 0 | **Oracle (3):** the same request → deny → the model says it did not run |
| `perm-noflag` | *(none)* | 0 | without the flag: no AskUserQuestion tool, and the request is denied at once |
| `ask-multiselect` | `--permission-prompt-tool stdio` | 0 | `multiSelect: true`, answer `"Tests, Docs"` |
| `ask-delay` | `--permission-prompt-tool stdio` | 0 | answered 240 s after the request |
| `ask-interrupt` | `--permission-prompt-tool stdio --session-id 3c1f0e52-…` | **1** | interrupt while a question is open → `control_cancel_request` |
| `ask-resume` | `--permission-prompt-tool stdio --resume 3c1f0e52-…` | 0 | "Continue." after that: the question is **not** asked again |
| `subagent-perm` | `--permission-prompt-tool stdio --forward-subagent-text` | 0 | a subagent's permission request carries `agent_id` |
| `subagent-ask` | `--permission-prompt-tool stdio --forward-subagent-text` | 0 | subagents have no AskUserQuestion |
| `ctl-init` | `--permission-prompt-tool stdio` (`--max-turns 1`) | 0 | `initialize` + `set_permission_mode`, no model call |

Exact oracle-(1) run:
```
cd .spike/sandbox/ask-2q
claude -p --input-format stream-json --output-format stream-json --verbose \
  --model haiku --max-turns 3 --permission-mode acceptEdits --permission-prompt-tool stdio
stdin  → {"type":"user","message":{"role":"user","content":"Use the AskUserQuestion tool to ask me exactly two questions in a single call. Question 1: \"Which color should the button be?\" … Question 2: \"Which size should it be?\" …"}}
stdout ← {"type":"assistant", … "content":[{"type":"tool_use","id":"toolu_01E65…","name":"AskUserQuestion","input":{"questions":[…]}}]}
stdout ← {"type":"control_request","request_id":"86a2f717-…","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion",
          "input":{"questions":[{"question":"Which color should the button be?","header":"Color","options":[{"label":"Red","description":"A red button"},{"label":"Green",…},{"label":"Blue",…}],"multiSelect":false},
                                {"question":"Which size should it be?","header":"Size","options":[{"label":"Small",…},{"label":"Large",…}],"multiSelect":false}]},
          "tool_use_id":"toolu_01E65…","requires_user_interaction":true}}
stdin  → {"type":"control_response","response":{"subtype":"success","request_id":"86a2f717-…","response":{"behavior":"allow",
          "updatedInput":{"questions":[…unchanged…],"answers":{"Which color should the button be?":"Green","Which size should it be?":"Small"}}}}}
stdout ← {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01E65…","content":"Your questions have been answered: \"Which color should the button be?\"=\"Green\", \"Which size should it be?\"=\"Small\". You can now continue with these answers in mind."}]},
          "tool_use_result":{"questions":[…],"answers":{…}}}
stdout ← assistant text "You chose a green button in small size." → result/success
```

### The control protocol (what M3.1 builds on)
- **`--permission-prompt-tool stdio` is required.** Without it (`perm-noflag`), `init.tools` has **no** `AskUserQuestion`, and a permission request is denied at once (`system/permission_denied`, `result.permission_denials[]`). The model then says it "can't proceed". That happens even with stream-json input and the default `--permission-prompts host`. With the flag, `init.tools` includes `AskUserQuestion`.
- **No handshake is needed.** Requests arrived without the SDK's `initialize` control request. `initialize` works (see `ctl-init`), and it is useful for the D6 check below.
- **Order on stdout:** the `assistant` line with the `tool_use` comes first, then `control_request` about 10 ms later, with the same `tool_use_id`. The CLI waits for an answer and emits nothing while it waits. There is no keepalive, and the `rate_limit_event` can come before or after the request.
- **Request** (`type:"control_request"`, `request_id` = a CLI-generated uuid, `request.subtype:"can_use_tool"`):
  - Always: `tool_name`, `display_name`, `input` (the tool input, verbatim), `tool_use_id`.
  - AskUserQuestion adds `requires_user_interaction: true`. `input.questions[]` = `{question, header, options[{label, description}], multiSelect}`: the question text verbatim. These probes saw 1 or 2 questions per call with 2 or 3 options each; the tool's upper limits were not probed.
  - Permission requests add `description` (the model's own description of the command), `decision_reason` ("This command requires approval"), `decision_reason_type` ("other"), and `permission_suggestions[]`. The suggestion seen was `{type:"addRules", rules:[{toolName:"Bash", ruleContent:"<command>"}], behavior:"allow", destination:"localSettings"}`.
  - A request raised inside a **subagent** adds `agent_id`, equal to `system/task_started.task_id` and to the Agent tool result's `agentId` (`subagent-perm`). A request from the main agent has no `agent_id`.
- **Response** (one stdin line; the CLI sends no acknowledgement):
  - Answer questions: `{"type":"control_response","response":{"subtype":"success","request_id":"<request_id>","response":{"behavior":"allow","updatedInput":{…input, "answers":{"<question text>":"<option label>"}}}}}`. The key is the question text verbatim. For `multiSelect`, the value is the chosen labels joined with `", "` (`"Tests, Docs"`; the model listed both). The CLI turns it into the tool_result text `Your questions have been answered: "<q>"="<a>", … You can now continue with these answers in mind.` and `tool_use_result.answers`.
  - Allow once: `{"behavior":"allow","updatedInput":<input unchanged>}`. **Never send `updatedPermissions`.** The CLI's suggestions target `localSettings` (the project's `.claude/settings.local.json`), and D6 forbids Switchboard from writing settings files.
  - Deny: `{"behavior":"deny","message":"<text>"}`. The model gets an `is_error` tool_result whose content is exactly `<text>`. `result.permission_denials[]` lists the call. **No** `system/permission_denied` line is emitted. That line appeared only for the automatic denial in `perm-noflag`.
  - A control request the host does not handle should get `{"subtype":"error","request_id":…,"error":"…"}`. The CLI sent no other request subtype in these probes. The host registered no hooks or SDK MCP servers, so any subtypes tied to those (e.g. `hook_callback`, `mcp_message`) were not probed.
- **Long waits work.** A 240 s wait (`ask-delay`) and a 1200 s wait (`ask-delay-20m`, not exported because its stream matches `ask-delay`) both went through normally. The process wrote nothing to stdout during the wait. After the answer it replied "You chose **Production** as the target environment." and exited 0. Waits of hours were not probed. If the process dies while a request is open, the cancellation rules below apply.
- **Cancellation.** An interrupt `control_request` while a question is open (D7 Pause, `ask-interrupt`) makes the CLI emit `{"type":"control_cancel_request","request_id":"<the can_use_tool request_id>"}`. Then come the interrupt `control_response`, a rejected `is_error` tool_result, `[Request interrupted by user for tool use]`, and `result/error_during_execution` (`terminal_reason:"aborted_tools"`, the question listed in `permission_denials`). After EOF the process exited with **code 1**, not 0 as in M0.1's interrupt, where another turn ran before EOF.
- **After resume the question is gone.** `--resume <id>` + "Continue." (`ask-resume`, D7) got "What would you like me to help with?". The model does **not** ask the cancelled question again.
- **Background agents and stdin.** In this CLI the `Agent` tool ran **in the background** (`task_started.is_backgrounded: true`). The main turn's `result` came *before* the subagent finished. A later `result` with `origin:{kind:"task-notification"}` closes the loop, so one stdin message can produce two results. When stdin was closed after the first `result`, the process kept running the subagent, but each subagent permission request failed at once with the tool_result `Tool permission request failed: AbortError: Stream closed` (first `subagent-perm` run, not exported). With stdin open, the request arrived with `agent_id` and was answered normally.
- **Subagents cannot ask.** A subagent told to use AskUserQuestion answered "I don't have access to an `AskUserQuestion` tool" (`subagent-ask`). So every question batch comes from the **main** agent. A subagent's doubt only reaches the developer as the main agent relaying it: as its own AskUserQuestion, or, as here, as plain text in the final reply.

### D6: auto mode headless
- `--permission-mode auto` is accepted as a flag, but on Haiku it silently becomes `default` (M0.1).
- New in M0.2, with no model call (`ctl-init`):
  - The `initialize` response lists `models[]` with `supportsAutoMode: true` for `default`/`opus`/`sonnet`/`fable`/… and **no** such flag for `haiku`. It also returns `current_permission_mode` and `account.subscriptionType` (`"Claude Max"`: the CLI uses the subscription login, and nothing else is needed).
  - The control request `{"subtype":"set_permission_mode","mode":"auto"}` on the Haiku session returned `{"subtype":"error","error":"Cannot set permission mode to auto: auto mode unavailable for this model","error_code":"auto_mode_model"}`. `mode:"acceptEdits"` returned `success {mode:"acceptEdits"}`.
- **Verdict.** D11 allows only Haiku, so it is still not proven that auto works headless: **`acceptEdits` stays the default** (the M0.1 ASSUMED entry stands). There is now a safe, zero-cost way to switch later. At spawn, send `initialize`. If the session's model has `supportsAutoMode`, send `set_permission_mode auto`. On `error_code:"auto_mode_model"` (or any error), stay on `acceptEdits`. Also keep M0.1's `init.permissionMode` mismatch check.

### (b) Agent SDK and (c) hooks
Not probed: (a) worked end to end on the installed CLI, and the item says to stop at the first mechanism that works. No `@anthropic-ai/claude-agent-sdk` was installed, and no hook bridge was built. Hooks stay unnecessary for questions and permissions, so the `--settings <hooks file>` line in the M0.1 baseline can be dropped unless another item needs hooks.

### Updated baseline for the SessionSupervisor (M2.1)
```
claude -p --input-format stream-json --output-format stream-json --verbose
       --permission-prompt-tool stdio          # M0.2: questions + permission requests over stdio
       --session-id <uuid> | --resume <id>
       --permission-mode acceptEdits           # D6 (see above for the auto switch)
       [--forward-subagent-text] [--replay-user-messages] [--name <session name>]
```
Keep stdin open for the life of the process. Close it only to pause or stop, and only after background tasks have ended (`system/background_tasks_changed` → `tasks: []`) or after the developer has accepted that they will lose their permission host.

### Implications for later items
- **M1.2 fake-claude:** on a stdin `user` message that matches a question/permission scenario, emit the `assistant` tool_use + `control_request/can_use_tool` and **block** until a `control_response` with the same `request_id` arrives. Then emit the tool_result built from `updatedInput.answers` (or the deny message) and the rest of the fixture. On interrupt while it is blocked, emit `control_cancel_request` + the `ask-interrupt` tail. Without `--permission-prompt-tool stdio`, behave like `perm-noflag`.
- **M3.1 question pipeline:**
  - One `can_use_tool` for `AskUserQuestion` = one **batch**: `batchId` ← the control `request_id` (keep `tool_use_id` too); each `input.questions[i]` → one `Question`. `text` = `question` verbatim; `options` = labels, keeping `header` and `description` for display.
  - Source: always the main agent (subagents cannot ask), shown as the session's orchestrator/main source. Permission requests with `agent_id` are attributed to the subagent through `task_started` (`subagent_type`, `description`).
  - Answer: `answerIndex` → `options[answerIndex].label` → `updatedInput.answers[question] = label` with `questions` passed back unchanged. **Gap for M3.1:** the locked contract has one `answerIndex` per question, so a `multiSelect` question cannot carry several choices through the API as it stands. Two identical question texts in one batch would also collide, because `answers` is keyed by text.
  - A `control_cancel_request` for an open batch, or the process exiting while one is open, means the CLI will not take that answer any more. Mark the batch closed or stale; do not write a `control_response` to a dead request. If it is still answered later, the only channel is a normal user message on resume, because the model does not re-ask.
- **D6 Inbox permission items:** `can_use_tool` for any other tool → an *Allow once / Deny* item showing `tool_name` + `input` verbatim (plus `description` / `decision_reason`). Allow once = `allow` + unchanged `updatedInput`, never `updatedPermissions`. Deny = `deny` + a fixed message, for example "The user denied this tool use in Switchboard."
- **M2.1 parser:** add `control_request` (to the pipeline), `control_cancel_request`, and `result.origin.kind:"task-notification"` (a result with no stdin message behind it). Timeline kind `ask` (gap #7) comes from `can_use_tool` requests, and `system/permission_denied` stays for automatic denials.

### Recommendation for M3.1
**Use (a): the native stream-json control protocol, with `--permission-prompt-tool stdio` on the one supervised `claude -p` process.** It is the only mechanism probed end to end, and it covers every case M3.1 and D6 need:
- It carries the questions, headers, options and permission inputs verbatim.
- It takes the answers back through a single stdin line.
- It attributes subagent requests (`agent_id`).
- It waits for the developer's answer: 20 min proven, hours not probed.
- It signals cancellation explicitly.

It adds no dependency (no Agent SDK), no second channel (no hook script, no loopback HTTP endpoint for the CLI to call), and no settings files. It also uses the same stdin/stdout pipe the SessionSupervisor already owns for messages and interrupts (M0.1), with the CLI's own subscription login.
