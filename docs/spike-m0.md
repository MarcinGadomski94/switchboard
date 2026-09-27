# M0 spike: Claude Code headless surface

What the installed CLI actually does, captured with real probes. Later items build on these findings. Where this file and `docs/handoff/ARCHITECTURE.md` differ on CLI behavior, this file records what was observed; `docs/decisions.md` still wins on rulings.

## Summary

| Item | Status | Verdict (one line) |
|---|---|---|
| M0.1 Headless surface | done (2026-09-27) | One long-lived `claude -p --input-format stream-json --output-format stream-json --verbose` process per session works: multi-turn over stdin, interrupt via a stdin `control_request`, `--session-id` / `--resume` / `--fork-session` behave as needed, hooks from `--settings` fire in `-p`. `auto` permission mode could not be proven (the model gates it), so sessions default to `acceptEdits` (D6). Switchboard does not use `--bg`/`attach`. |
| M0.2 Questions & permissions | done (2026-09-27) | Mechanism (a) works end to end: add `--permission-prompt-tool stdio` to the supervised stream-json process. Every question batch (`AskUserQuestion`) and every permission request arrives on stdout as `control_request/can_use_tool` and is answered with one `control_response` line on stdin (`allow` + `updatedInput.answers`, or `allow` / `deny`). (b) SDK and (c) hooks were not needed. `auto` is still not proven (Haiku lacks it), so `acceptEdits` stays the default. |
| M0.3 Transcripts & usage | done (2026-09-27) | Transcripts are `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug(cwd)>/<session-id>.jsonl`, slug = every non-`[A-Za-z0-9]` char → `-` (+ hash suffix past 200 chars), verified on spaces, symbols, a 230-char path, a case-mismatched cwd and a worktree. History reads first prompt / last text / titles / PR links / timestamps from the file; `entrypoint: "cli"` marks terminal-started sessions. Usage: **5-hour % and weekly % are both reliable** from the stdin control request `get_usage` (no model call, 0–100) and from each turn's `rate_limit_event` (0–1). They agreed with `/usage`. Cost/transcript fields give no %. |
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

---

## M0.3 Transcripts & usage

### Probe conditions
- Same CLI (2.1.283), Node and machine as M0.1/M0.2. Every real call used `--model haiku` and `--max-turns` 1 or 3, with cwd under `.spike/sandbox/` (D11). The env was scrubbed as in M0.1.
- Runner: `.spike/probe3.mjs` (gitignored). It is `probe2.mjs` plus four additions: a free-form cwd (spaces, symbols, long paths, case changes), control requests before and after the prompts, a `stat` of `~/.claude/projects/*/<id>.jsonl` before the first message, after each result and after exit, and a D11 guard that refuses argv without `--model haiku --max-turns ≤3` or a cwd outside the sandbox.
- **11 `claude` processes, 8 API requests** in total. `usage-ctl`, `usage-cache` and the three slash-command runs made no model call. The API requests: `usage-turn` 1, `tx-main` 3 (two turns plus one tool round trip), `slug-chars`, `slug-long`, `slug-case` and `tx-main-wt` 1 each.
- The developer's own transcripts on this machine (22 files at the workspace root, 63 in all) were read **for structure only**. The tools printed entry types, key names, counts, sizes and redacted flags, never content. Nothing from them is in the repo.
- Sample parser: `.spike/parse-transcript.mjs` (gitignored, async `fs`/`readline`, no dependencies).

### Fixtures (M0.3)
They use the same format and home-dir scrub as M0.1, and `manifest.json` has an entry for each. In `usage-*`, the money amounts in the `get_usage` response (`extra_usage.monthly_limit`, `spend.*.amount_minor`) are replaced with `0`.

| Scenario | Args (all `-p --output-format stream-json --verbose --model haiku`) | Exit | Shows |
|---|---|---|---|
| `usage-ctl` | `--input-format stream-json --max-turns 1 --permission-prompt-tool stdio` | 0 | stdin `get_usage` + `get_session_cost` control requests, **no user message, no model call, no transcript written** |
| `usage-turn` | same | 0 | `get_usage` → one turn (`rate_limit_event` 0.1 / 0.18) → `get_usage` (10 / 18) → `get_session_cost` |
| `tx-main` | `--input-format stream-json --max-turns 3 --permission-mode acceptEdits --permission-prompt-tool stdio --session-id <uuid> --name sb-tx-probe` | 0 | 2 turns (Write + text) in cwd `.spike/sandbox/tx main` (with a space; its own git repo on branch `feature/tx-probe`) |
| `transcripts/tx-main.jsonl` | the transcript `tx-main` wrote | — | **transcript fixture.** Whole lines as written by the CLI, home dir scrubbed. 32 of 44 lines are kept. The dropped lines are 12 `attachment` lines that carry the machine's CLAUDE.md/AGENTS.md/memory (`instructions`), the system prompt (`prompt_snapshot`), the account e-mail (`session_context`), the org id (`credential_org`), the commit/PR attribution settings (`remote_session_change`) and the tool/skill/agent/MCP listings. The `attachment` lines kept are `environment`, `model`, `date` and `total_tokens_reminder`. `parentUuid` links to the dropped lines dangle. |

Not exported: the `slash-usage`/`slash-cost` output, because its text includes a usage attribution computed from the developer's own sessions. `slash-status`, `slug-*`, `tx-main-wt` and `usage-cache` are not exported either, since they add nothing a later item replays. They are described below.

### Transcript location
**Path:** `<configDir>/projects/<slug>/<sessionId>.jsonl`.
- `configDir` is `$CLAUDE_CONFIG_DIR` when it is set, otherwise `~/.claude`. The binary has `(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")).normalize("NFC")` with `projects` joined under it. The Agent SDK code in the same binary uses `CLAUDE_CONFIG_DIR ?? join(home, ".claude")` + `"projects"` too.
- `CLAUDE_CONFIG_DIR` is unset on this machine. It is **not** one of the `CLAUDE_CODE_*` variables the supervisor strips, so a developer who sets it passes it to every child, and Switchboard must read transcripts from that same folder.
- **`sessionId` = the file name.** It is the `--session-id` Switchboard passes, the same value as `init.session_id`.

**Slug.** The 2.1.283 binary computes it like this (found in the binary, then checked against the real folders of 5 probes):
```js
// cwd = the process's canonical working directory (see "case" below)
function slugForCwd(cwd) {
  const s = cwd.replace(/[^a-zA-Z0-9]/g, '-');          // every char except ASCII letters/digits → '-', one per UTF-16 unit
  if (s.length <= 200) return s;
  let h = 0;                                              // Java-style string hash of the *unsanitized* cwd
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return `${s.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}
```

| Probe | cwd (home = `/Users/dev`) | Project folder | Shows |
|---|---|---|---|
| `tx-main` | `…/switchboard/.spike/sandbox/tx main` | `-Users-dev-RiderProjects-Acme-Corp-workspace-other-switchboard--spike-sandbox-tx-main` | a space → `-`; `/.` → `--`. The workspace root itself (`/Users/dev/RiderProjects/Acme Corp/workspace`) → `-Users-dev-RiderProjects-Acme-Corp-workspace`. |
| `slug-chars` | `…/sandbox/slug chars (a+b) ż_é.v2@#1` | `…--spike-sandbox-slug-chars--a-b------v2--1` | `( + ) ż _ é . @ #` each → one `-`. Non-ASCII letters (BMP) and `_` are replaced too. |
| `slug-long` | `…/sandbox/slug-long/a×60/b×60/cc dd` (230 chars with the real home dir) | first 200 chars of the sanitized path + `-mouvan` (207 chars) | the 200-char cut + base-36 hash, reproduced exactly by the code above from the real path |
| `slug-case` | spawned with cwd `…/.spike/SANDBOX/Slug-Case` | `…--spike-sandbox-slug-case` | the CLI uses the **on-disk case** (getcwd). `init.cwd` and the transcript `cwd` show `…/sandbox/slug-case` too. |
| `tx-main-wt` | `…/sandbox/tx-main-wt`, a `git worktree` of `tx main` (branch `feature/wt-probe`) | `…--spike-sandbox-tx-main-wt` | a worktree gets its **own** folder, keyed by its own path, not the main repo's. `gitBranch` = the worktree's branch. |

Consequences:
- The slug is lossy: `a b`, `a-b` and `a.b` all map to `a-b`. Never turn a slug back into a path. Read `cwd` from the entries instead.
- On macOS, canonicalize a configured path with **`fs.promises.realpath`** (libuv, native) before slugging or comparing. In Node `fs.promises.realpath` and `fs.realpathSync.native` return `…/sandbox/slug-case` for `…/SANDBOX/Slug-Case`, while the JS `fs.realpathSync` keeps the typed case. NFD vs NFC file names were not probed. The binary NFC-normalizes the config dir, not visibly the cwd.
- Most robust lookup for a known session: find `<configDir>/projects/*/<sessionId>.jsonl`. A readdir of ~50 folders is a few ms. Use the slug only as the fast path.

**When and how the file is written** (`tx-main` stat log):
- The file does **not** exist at spawn (checked 2.5 s after spawn). It is created with the first user message.
- A process that only exchanges control requests and gets EOF (`usage-ctl`, `usage-cache`) **writes no transcript**. A `-p "/usage"` slash command does write one.
- Entries are appended as the turn runs. After result 1 the file was 385,369 bytes (mtime 21:19:54.795Z), after result 2 390,418 bytes (21:19:56.020Z), after exit 391,102 bytes (21:19:56.233Z, the `last-prompt` + `cost-state` lines). **mtime tracks activity.**
- An `--resume` from another cwd appends to the original file (M0.1). `--fork-session` starts a new file under the fork's cwd.
- Beside the file: `<sessionId>/subagents/agent-<agentId>.jsonl` holds each subagent's sidechain, and `agent-<agentId>.meta.json` holds `{agentType, description, toolUseId, spawnDepth, requestShape, requestNonInteractive}`. Workflow agents go to `<sessionId>/subagents/workflows/wf_*/…`. Other files are `.json`/`.txt`/`.md`/`.js`. History reads **only the top-level `*.jsonl`**.
- **Sizes:** the files are big because the CLI stores the system prompt and instructions as attachments. A 2-turn Haiku session is ~390 KB. The developer's 22 workspace-root files total 54 MB, the largest 19 MB.

### Transcript format (2.1.283)
One JSON object per line. Every `user`, `assistant`, `attachment` and `system` line has the same envelope: `parentUuid, isSidechain, type, uuid, timestamp (ISO-8601 UTC), userType ("external"), entrypoint, cwd, sessionId, version, gitBranch`. The other types are small records keyed by `sessionId`.
- `entrypoint` is `"cli"` for an interactive terminal session and `"sdk-cli"` for `-p` / stream-json (every spike line).
- **`cwd` is the session's current directory.** It follows `cd` in Bash. The developer's workspace-root sessions have 1–22 distinct `cwd` values each, and the first is always the root. The project folder comes from the **start** cwd.
- **`gitBranch` is resolved from the start cwd.** It is `"HEAD"` when that is not a git repo. Every entry of every workspace-root session reads `"HEAD"`, even after a `cd` into a repo, because the workspace root is not a repo. It is the branch name when started inside a repo (`feature/tx-probe`, the worktree's `feature/wt-probe`, `main` for sandbox probes inside this repo).

Entry types seen across the 261 transcript files on this machine (versions 2.1.278–2.1.283), with the ones History needs in bold:

| Type | Fields | Written in `-p`? | Notes |
|---|---|---|---|
| **`user`** | `message.content` (string = a prompt; blocks = `tool_result`), `promptId`, `promptSource` (`sdk`, `typed`, `queued`, `system`, `suggestion_accepted`), `turnOrigin` (`sdk`, `human`, `peer`, `task_notification`), `permissionMode`, `isMeta?` | yes | Switchboard prompts: `promptSource/turnOrigin = "sdk"`. Interactive slash commands appear as `<command-name>/x</command-name>…<command-args>…</command-args>`, plus `isMeta` `<local-command-caveat>` and `<local-command-stdout>` lines. |
| **`assistant`** | `message{id, model, content[], stop_reason, usage}`, `requestId` | yes | one line per content block, as on stdout; group by `message.id`. **There is no `result` line.** The last result is the last main-chain assistant text. |
| **`last-prompt`** | `lastPrompt, leafUuid` | yes | re-appended every turn; the last one is the latest prompt |
| **`custom-title`** + **`agent-name`** | `customTitle` / `agentName` | yes, with `--name` | `--name sb-tx-probe` wrote both, repeated each turn. Also present in interactive sessions (667 lines on this machine). |
| **`ai-title`** | `aiTitle` | **no** | interactive only |
| **`system/away_summary`** | `content` (free text) + envelope | no | interactive only. The closest thing to a summary entry. |
| **`pr-link`** | `prNumber, prUrl, prRepository, timestamp` | not observed | present in interactive transcripts (652 lines). Useful for History's outcome and for Artifacts (gap #9). |
| `cost-state` | `totalCostUSD, totalDuration, startTime, totalLinesAdded/Removed, modelUsage` | yes (at exit) | list-price cost, not a plan % (see Usage) |
| `queue-operation` | `operation (enqueue/dequeue), timestamp, content` | yes | stdin message queueing |
| `system/turn_duration` | `durationMs, messageCount, slug` | no | `slug` here is a three-word `word-word-word` value, not the project slug |
| `mode`, `permission-mode`, `file-history-snapshot`, `file-history-delta`, `frame-link`, `bridge-session`, `atis-latch`, `system/compact_boundary`, `system/local_command`, `attachment:*` (instructions, prompt_snapshot, environment, skill_listing, …) | — | mixed | not needed by History |

**There is no `type: "summary"` entry** in any of the 261 files. On 2.1.283 the "summary" role is split three ways: title (`custom-title` → `ai-title`), recap (`system/away_summary`, interactive only) and the last assistant text.

Offsets in the developer's files (numbers only): the first prompt is always within the first 12 KB. The last title is within the last 32 KB, the last `last-prompt` within the last 21 KB, and the last assistant text within the last 108 KB. A streaming full read is also cheap (below).

### What History needs → where it comes from
| History field (SPEC §History, contract `HistoryItem`) | Switchboard-started session | Terminal-started session (transcript only) |
|---|---|---|
| date | DB `createdAt` | `timestamp` of the first entry (`startedAt`). Show the last entry's `timestamp` or the file mtime as "last active". |
| name | DB name (also written as `custom-title` because Switchboard passes `--name`) | last `custom-title` → last `ai-title` → first prompt (truncated) |
| mode line | DB (work type · mode · phase) | `terminal` (+ first slash command, e.g. `/loop 1h`, when the session started with one) |
| summary | last main-chain assistant text (the final reply) | last `system/away_summary` if present, else last assistant text, else `lastPrompt` |
| solutions / branches | DB worktrees + solutions | distinct `cwd` values under the workspace root → solution folders; `gitBranch` only when ≠ `"HEAD"` |
| outcome | DB status (+ PR state via gh, M2.2) | `pr-link` entries ("PR #n"), else "ended" / "active" by mtime and liveness |
| search (`?q=`) | name, task, prompts, final text, solutions, branches | first prompt, `lastPrompt`, title, last text, cwds |

### Terminal-started sessions and last-modified time (gap #5)
- **Which folders count as the workspace:** every project folder whose name starts with `slug(workspaceRoot)`. Then, because the slug is lossy (`…-workspace2` also matches), keep a file only if its first entry's `cwd` equals the root or starts with `root + path.sep`. Compare case-insensitively on macOS/Windows.
- **Terminal-started:** the `sessionId` is not in Switchboard's DB **and** the first human prompt's `entrypoint` is `"cli"`. Evidence: all 23 of the developer's terminal files are `cli` only, and all 40 spike files are `sdk-cli` only. A Switchboard session continued in a terminal (M0.4) mixes both, but its id is in the DB, so it keeps its Switchboard row. A headless `sdk-cli` session that is not in the DB comes from some other tool. It is not "terminal-started" by the gap #5 wording, and M7.4 decides whether to show it.
- **Stubs:** 12 of the 22 workspace-root files have no typed prompt. 7 have no user line at all (a session opened and closed) and 5 contain only slash commands. Hide files with neither a prompt nor a command. A command-only session (e.g. `/loop …`) shows its command as the name.
- **Last modified:** `fs.stat(file).mtime` (async). The CLI appends on every message, so a running turn keeps it fresh. An interactive session that sits **idle** in an open terminal does not write, so mtime alone misses it. For the "Attach here" warning, combine mtime with a liveness check:
  - `mtime` less than 2 min ago (gap #5), **or**
  - the id is live in `claude agents --json` (M0.1, no model call). The same fields also sit in one file per live CLI process, `<configDir>/sessions/<pid>.json` = `{pid, sessionId, cwd, startedAt, version, kind:"interactive", entrypoint:"cli", status:"busy"|"idle", updatedAt, name, …}` (2 files seen). That file format is undocumented, so prefer the command and read the files only as a fallback.
  - Warn in either case.

### Sample parse
`.spike/parse-transcript.mjs --session <id> | --cwd <dir> | --file <path> [--redact]`. One async streaming pass per file (`readline` over `createReadStream`). Core rules:
```js
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
function isHumanPrompt(m) {            // a prompt someone typed or Switchboard sent, not a tool result / meta / notification
  if (m.type !== 'user' || m.isSidechain || m.isMeta) return false;
  const c = m.message?.content;
  if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) return false;
  if (m.promptSource === 'system' || m.turnOrigin === 'task_notification') return false;
  const t = textOf(c).trim();
  return !!t && !t.startsWith('<local-command-') && !t.startsWith('<command-') && !t.startsWith('[Request interrupted');
}
// per line: startedAt ??= m.timestamp; lastActivityAt = m.timestamp; startCwd ??= m.cwd; cwds.add(m.cwd); gitBranch ??= m.gitBranch
// user → firstPrompt ??= text, origin = entrypoint "cli" ? "terminal" : "headless"; <command-name> → firstCommand
// assistant (!isSidechain, has text) → lastResult = text of the latest message.id
// last-prompt → lastPrompt; custom-title / ai-title → title (custom wins); pr-link → prLinks; cost-state → costUSD
// system/away_summary → awaySummary; subagent count = readdir(<id>/subagents/*.jsonl)
```
Output for `node .spike/parse-transcript.mjs --cwd "$PWD/.spike/sandbox/tx main"` (home shown as `/Users/dev`; condensed: `file`, `cwds` and the empty `awaySummary`/`firstCommand`/`commands` fields omitted):
```json
{ "sessionId": "b8b908e5-75ad-4201-8f37-056b3bb0a379",
  "projectDir": "-Users-dev-RiderProjects-Acme-Corp-workspace-other-switchboard--spike-sandbox-tx-main",
  "sizeBytes": 391102, "mtime": "2026-09-27T21:19:56.233Z", "modifiedAgoSec": 239,
  "origin": "headless", "entrypoints": ["sdk-cli"], "version": "2.1.283",
  "startCwd": "/Users/dev/RiderProjects/Acme Corp/workspace/other/switchboard/.spike/sandbox/tx main",
  "gitBranch": "feature/tx-probe", "title": "sb-tx-probe", "titleSource": "custom-title", "agentName": "sb-tx-probe",
  "firstPrompt": "Create a file named notes.txt containing the text ALPHA using the Write tool. Then reply with the single word DONE.",
  "lastPrompt": "Reply with exactly the word: finished", "lastResult": "finished",
  "startedAt": "2026-09-27T21:19:49.586Z", "lastActivityAt": "2026-09-27T21:19:55.998Z",
  "humanTurns": 2, "prLinks": [], "costUSD": 0.0805611, "subagentFiles": 0, "badLines": 0 }
parsed 1 file(s), 391102 bytes in 6 ms
```
Two more checks:
- M0.1's `multiturn` session was resumed from `sandbox/resume`. It parses to `cwds: [.../multiturn, .../resume]`, `humanTurns: 3`, `lastResult: "zeppelin"`.
- The redacted run over the developer's workspace root (`--cwd <workspace> --redact`, flags only) parsed **22 files / 54 MB in 194 ms**. The breakdown: 10 terminal sessions with a prompt, all titled (8 `custom-title`, 2 `ai-title`); 5 command-only sessions; 7 empty stubs. 7 files had `pr-link`, 9 had `away_summary`, 5 had subagents, 0 lines were unparseable. A full streaming re-parse is affordable at startup. Refresh a file only when its `(size, mtime)` changes.

### Usage %
Sources checked on 2.1.283:

| Source | How | Observed | Gives a Max %? |
|---|---|---|---|
| `claude --help` | subcommands | `agents, attach, auth, auto-mode, doctor, gateway, import, install, logs, mcp, plugin, project, respawn, rm, setup-token, stop, ultrareview, update`. **No usage command.** `auth status [--json\|--text]` is auth only. | no |
| `/usage` in `-p` (`claude -p "/usage" --output-format stream-json …`) | slash command | Works without a model call: a synthetic `assistant` (`model:"<synthetic>"`), then `result/success` with `num_turns:0`, `total_cost_usd:0`. Text: `Current session: 10% used · resets Sep 28 at 1:40am (Europe/Copenhagen)` / `Current week (all models): 18% used · resets Oct 1 at 3pm (…)` / `Current week (Fable): 0% used …`. It then prints a "What's contributing" attribution scanned from local transcripts. | yes, but only as locale-formatted human text, plus a transcript file and a transcript scan per call. Not recommended. |
| `/cost` in `-p` | slash command | On a subscription it prints the same text as `/usage` | as `/usage` |
| `/status` in `-p` | slash command | `"/status isn't available in this environment."` | no |
| `result` (`total_cost_usd`, `usage`, `modelUsage[*].costUSD`) | stream-json | per-process token counts and cost at **list price** (`get_usage` labels it `costBasis:"list"`). The subscription is not billed per token. | **no.** It measures cost, not the plan quota. |
| Transcripts (`assistant.message.usage`, `cost-state`) | files | tokens and list-price cost only. No utilization and no limit to divide by. | **no** |
| `rate_limit_event` | stream-json, one per API turn | `rate_limit_info.unifiedWindows.five_hour.utilization` = **0.1**, `seven_day.utilization` = **0.18**, `resetsAt` in epoch seconds, `rateLimitType:"five_hour"`, `status:"allowed"`. Only when a turn calls the API. `status` values other than `allowed` were not seen. | **yes** (fraction × 100) |
| stdin control request **`get_usage`** | `{"type":"control_request","request_id":"…","request":{"subtype":"get_usage","skip_behaviors":true}}` on the stream-json process | `response.rate_limits.five_hour = {utilization: 10, resets_at: "2026-09-27T23:40:00…+00:00"}`, `seven_day = {utilization: 18, resets_at: "2026-10-01T13:00:00…"}`. Also `subscription_type:"max"`, `rate_limits_available:true`, `model_scoped[{display_name:"Fable", utilization:0}]`, `limits[{kind:"session"\|"weekly_all"\|"weekly_scoped", percent, resets_at, is_active}]`, `extra_usage`, `seven_day_breakdown{as_of}` and `session{total_cost_usd,…}`. **No model call, no transcript**, answered 0.3–0.7 s fresh and 10 ms cached. | **yes** (0–100) |
| `~/.claude.json` → `cachedUsageUtilization` | file | `{fetchedAtMs, accountUuid, utilization{five_hour, seven_day, …}}`, updated by any CLI process that fetches usage | yes, but undocumented and in the user's config file. Not recommended. |

**Cross-check at the same moment (21:18–21:19Z):** `get_usage` 10 / 18, `rate_limit_event` 0.1 / 0.18 and `/usage` "10% / 18%" all agree. Eight minutes later `get_usage` read 11 / 18 (other sessions were running).

**`get_usage` specifics:**
- The binary describes it as *"Requests the structured /usage data: session cost/usage totals plus claude.ai plan rate-limit utilization when available. Experimental — the response shape may change."* The SDK method is named `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`.
- `skip_behaviors: true` skips the 7-day local transcript scan, which is exactly the "usage meter" case the binary's own description names.
- **The CLI caches it for about a minute** (`usage-cache`: one process asked at 0 s, 40 s and 110 s):
  - The 40 s answer repeated the 0 s one (same `seven_day_breakdown.as_of`, same `resets_at` microseconds).
  - The 110 s answer was fresh.
  - The first request of a new process can also be served from another process's cache: the first answer in `usage-turn` carried an `as_of` about 28 s old.
- A `get_usage` sent **mid-turn** was not probed. Every probe sent it between turns.
- `get_session_cost` returns only the `/cost` text for the process (`Total cost: $0.0603 …`). It has no %.

**Verdict:**
- **Max 5-hour window %: reliable.** Source: `get_usage` → `rate_limits.five_hour.utilization` (0–100) + `resets_at`. Every turn also brings a free update: `rate_limit_event.rate_limit_info.unifiedWindows.five_hour.utilization × 100`.
- **Weekly %: reliable.** Same sources, `seven_day` (all models). `model_scoped[]` adds per-model weekly windows (e.g. "Fable") if the UI ever wants them.
- **Show "unknown"** (never a guessed number) in any of these cases:
  - `get_usage` returns an error.
  - `rate_limits_available` is false.
  - `rate_limits`, the window object or `utilization` is null.
  - The response shape changes.
  - The last reading's `resets_at` has passed without a newer reading.
- Cost fields, transcripts and `/status`: **unknown / no**. `/usage` text: a readable fallback only, not recommended.

### Implications for later items
- **M9.2 usage meter:**
  - Read `get_usage` (`skip_behaviors:true`) over the stdin of any live supervised session. That needs no new process.
  - When no session runs, spawn a short-lived poller: `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio` → `get_usage` → EOF. It exits 0 in ~3.5 s with no model call and no transcript. It does run the user's SessionStart hooks, which took ~1.6 s here, and it should follow the M0.1 env scrub. Its cwd should be Switchboard's app-data folder, not a repo.
  - Take free updates from every `rate_limit_event` in between.
  - Poll at most once per 60 s, since the CLI cache makes faster polling pointless. Record "as of" = when Switchboard received the value.
  - The contract has one optional `usagePct` on `/api/system`, and the footer has one "Max" bar, while Settings says "5-hour window and weekly limit". Suggestion for M9.2 (not decided here): `usagePct` = the higher of the two (the binding limit), with the warning at ≥ 90 % on either. Omit the field when unknown.
- **M1.2 fake-claude:**
  - Answer `get_usage` / `get_session_cost` control requests with the `usage-ctl` payloads, and emit `rate_limit_event` per turn as recorded.
  - Honour `CLAUDE_CONFIG_DIR`: write a transcript to `$CLAUDE_CONFIG_DIR/projects/<slugForCwd(cwd)>/<session-id>.jsonl` built from `transcripts/tx-main.jsonl`, rewriting `sessionId`, `cwd`, `gitBranch` and timestamps. Create it at the first user message, append per message, add `last-prompt` + `cost-state` at exit.
  - Emit `custom-title` + `agent-name` lines when `--name` is given.
  - Tests then point `CLAUDE_CONFIG_DIR` at a temp dir, and no real `~/.claude` is touched.
- **M2.1 SessionSupervisor:**
  - Keep `CLAUDE_CONFIG_DIR` in the child env.
  - Pass `--name <session name>`. It becomes the transcript title that terminal History and the `claude --resume` picker show.
  - Parse `rate_limit_event` into the usage store.
  - The transcript path of a session = `<configDir>/projects/<slugForCwd(init.cwd)>/<init.session_id>.jsonl`. Use `init.cwd`, which is already canonical.
- **M7.4 History:**
  - Use the "What History needs" table and the terminal-session rules above.
  - Resolve `configDir` once from the env (Settings may show it).
  - Scan the workspace-slug-prefixed folders, confirm by `cwd`, read only top-level `*.jsonl` with async streaming, and cache rows by `(size, mtime)`.
  - Never write into `~/.claude`.
- **Gap #5 "Attach here":** warn when the mtime is less than 2 min old or `claude agents --json` lists the id as live.
- **M0.4:** confirm that a terminal `claude --resume <id>` appends `entrypoint:"cli"` lines to the same file, and that `--name`'s `custom-title` survives.
