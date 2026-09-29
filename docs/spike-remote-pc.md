# Spike: hook into terminal sessions on a remote PC

Can a headless Switchboard **host** on a Windows PC (reachable over Tailscale) list the `claude` sessions the developer started by hand in a terminal there, and let the Mac's Switchboard **watch, approve and reply** to the ones the developer picks? This document is the written finding, not the feature. It builds on `docs/spike-remote.md`: the CLI has no listing or attach for sessions on other machines, and Switchboard must drive or observe only the unmodified `claude` binary. `docs/decisions.md` still wins on rulings.

## Summary

| # | Item | Status | Verdict (one line) |
|---|---|---|---|
| 1 | Discovery | **works** (run on macOS; code for Windows) | `claude agents --json` lists plain interactive TUI sessions (`kind:"interactive"`, `status` `idle` / `busy` / `waiting` + `waitingFor:"permission prompt"`), including sessions started before the host. It gives `pid, cwd, sessionId, name, status` but no transcript path. A `SessionStart` hook gives `session_id` + `transcript_path` + `cwd` exactly. Use both. |
| 2 | Live chat | **works** | The transcript JSONL is appended **per step** (prompt, thinking, tool_use, permission decision, tool_result, text, turn end), each with its own timestamp. `src/core/transcript-sync.ts` (`entriesSince`, `transcriptItems`) already turns it into chat items. It needs one addition: Mac replies arrive as `user` lines with `origin.kind:"task-notification"`. |
| 3 | Approve / deny from outside | **works, better than hoped** | 2.1.284 has a `PermissionRequest` hook. In the interactive TUI it runs **at the same time as** the normal dialog: the dialog appears at once, and whichever answers first wins. Hook `allow` → the tool runs and the TUI shows "Allowed by PermissionRequest hook". Hook `deny` + `message` → the model gets the message as the tool error. No output → nothing happens, and the dialog stays for the PC. No timeout race is needed. |
| 4 | Reply from the Mac, **including an idle session** | **works** | An `asyncRewake` hook wakes an **idle** interactive session. The hook runs in the background; when it exits with code 2, its stderr is queued as a `task-notification` and starts a new turn. This was run on a session idle before its first prompt (armed by `SessionStart`) and on a session idle after a turn (armed by `Stop`). Nothing is held open, and the TUI stays free while it waits. |
| 5 | Windows specifics | code + docs, **unverified on Windows** | Use exec-form hooks (`"command": "C:\\…\\node.exe", "args": [...]`), which need no shell. Without `args`, hooks run in Git Bash, or in PowerShell when Git Bash is missing. Config lives in `%USERPROFILE%\.claude` (or `CLAUDE_CONFIG_DIR`). The session registry is `~\.claude\sessions\<pid>.json`. The host runs as the existing Task Scheduler login task. |
| 6 | Security | proposal | The host stays **loopback-only**, and `tailscale serve` exposes it to the tailnet only (HTTPS, tailnet identity). Each Mac gets its own pairing token. Hooks authenticate to the host with a per-install hook token. The hook trusts nothing it receives beyond "allow / deny / message", and fails open to the normal TUI. No Anthropic API calls, no token reading. |

**Bottom line:** "Watch + approve + reply" is feasible with documented hook events plus one CLI-internal nicety (`rewakeMessage` / `rewakeSummary`, marked `@internal`). It does not need a PTY, TUI scraping, the peer-messaging socket or the claude.ai bridge.

---

## Probe conditions

- CLI `2.1.284 (Claude Code)` (`~/.local/bin/claude` → `versions/2.1.284`), Node `v24.21.0`, macOS arm64. Worktree `.worktrees/remote-pc-spike`, branch `spike/remote-pc` from `c32bc19`. The main checkout, the `com.switchboard` service and port 13001 were not touched.
- **Static reading:** `strings -n 6` of the 2.1.284 binary → `.spike/remote-pc/out/bin-strings.txt`, searched with `.spike/remote-pc/ctx.mjs`. Findings marked *(code)* show intent, not behaviour. **Docs:** [Hooks reference](https://code.claude.com/docs/en/hooks), read 2026-09-29.
- **Interactive probes:** a Python `pty` driver with the `pyte` terminal emulator (venv inside `.spike/remote-pc/`) ran real `claude` TUIs.
  - Flags: `--model haiku --setting-sources project,local` (the developer's user settings and their hooks were **not** loaded). Hooks came from `--settings .spike/remote-pc/ctl/<probe>/settings.json`, or for T3 from `.spike/sandbox/t3/.claude/settings.json`, a spike-owned project file.
  - cwd `.spike/sandbox/<probe>/`. The env was scrubbed of `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID` and `CLAUDE_EFFORT`.
  - Screens were saved as text (`.spike/remote-pc/out/<probe>/NN-*.txt`). The hook script `hook.mjs` logged every hook input to `ctl/<probe>/events.ndjson`.
- The **workspace-trust dialog** was accepted for `.spike/sandbox/t1`, `t2` and `t3`. That is the CLI's own state in `~/.claude.json`; no settings file was edited.
- **Sessions run** (every one Haiku; details at the end): 5 interactive sessions, plus 3 `claude agents --json` runs and 1 `claude agents --help` (no model call). The first session exited at the trust dialog. The second **ran away**: a bug in my probe hook re-delivered the same "Mac message" after every turn, which gave **52 extra one-word Haiku turns in ~50 s** before I killed it. That is also evidence for a design rule (consume-once, below). The status line of a later probe showed **"You've used 91% of your session limit"**, so probing stopped there.

---

## 1. Discovery

**Verdict:** list with `claude agents --json` and read the transcript path from a `SessionStart` hook. Use `~/.claude/sessions/<pid>.json` only as a fallback for fields.

Evidence:
- **`claude agents --json`, run while probe T3 was an idle TUI and then showed a permission dialog** (cwd, name and ids shortened):
  ```json
  [{"pid":48150,"cwd":"…/sandbox/t3","kind":"interactive","startedAt":1790678062694,"sessionId":"7b6d7a38-…","name":"t3-0f","status":"idle"}]
  [{"pid":48150,"cwd":"…/sandbox/t3","kind":"interactive","startedAt":1790678062694,"sessionId":"7b6d7a38-…","name":"t3-0f","status":"waiting","waitingFor":"permission prompt"}]
  ```
  The help says: "`--json` Print active sessions (interactive and background) as a JSON array and exit (for scripting; does not require a TTY)". It also listed the two other interactive sessions running on this Mac, so it **includes sessions started before any host existed**. Running it takes a few seconds (a CLI start); poll it, for example every 10 s, rather than per request.
- **Session registry `~/.claude/sessions/<pid>.json`** (key names; values only where harmless): `pid, sessionId, cwd, startedAt, procStart, version:"2.1.284", peerProtocol:1, peerFeatures, kind:"interactive", entrypoint:"cli", pidDomain, messagingSocketPath, name, nameSource, nameSince, status:"idle"|"waiting"|"busy", waitingFor, updatedAt, statusUpdatedAt`.
  - It sits next to `<pid>.<sha256>.key` files, which are secret (peer tokens). The host must **never** read the `.key` files.
  - `entrypoint:"cli"` marks a hand-started TUI; Switchboard's own children say `sdk-cli`. The host can use this to hide sessions that another Switchboard supervises.
  - The file format is internal *(code)*, so `agents --json` is the supported surface.
- **Hook input** (logged, 2.1.284). Every event carries `session_id, transcript_path, cwd, scratchpad_dir, prompt_id, permission_mode, hook_event_name`.
  - `SessionStart` adds `source:"startup"` (also `resume` / `clear` / `compact`) and `model`.
  - `SessionEnd` adds `reason` (`other` on Ctrl-C). `Stop` adds `stop_hook_active, last_assistant_message, background_tasks, session_crons`.
  - Hook env includes `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_ENTRYPOINT`, plus `CLAUDE_CODE_MESSAGING_SOCKET` / `_TOKEN`. The hook must not forward the last two.
- **Sessions started before the hook was installed.**
  - T3 started with project settings that had no `UserPromptSubmit` hook. The file was rewritten to add one while the TUI was idle, and the next prompt fired it. The docs say: "Direct edits to hooks in settings files are normally picked up automatically by the file watcher."
  - The `--settings <file>` flag file was **not** re-read (T2: the added hook never fired). This doesn't matter, because the host installs into `~/.claude/settings.json`, a watched file. That path is inferred from the project-file result and the docs; it is unverified, because editing the real user settings was out of bounds.
  - A running session gets the hooks, but its `SessionStart` has already happened. So the host learns its transcript path from its first later hook, or derives it from `agents --json` (`<config>/projects/<slugForCwd(cwd)>/<sessionId>.jsonl`, which Switchboard's `slugForCwd` already computes).
- **Chosen rule:** `agents --json` is the list of what is running (authoritative for liveness). Hook registrations add `transcript_path` and mark a session "hook-capable". A listed session with no hook contact yet is shown as "watch only until its next turn" (see *Limits*).

## 2. Live chat from the transcript

**Verdict:** tail the JSONL. It is written incrementally, and the existing parser covers almost all of it.

Evidence (T1 transcript, one line per entry; `ts type origin content`):
```
10:26:58.170 user      {"kind":"task-notification","producer":"session-task"} "<task-notification>\n<summary>Message from the Mac</summary>\n</task-notification>\n<system-reminder>\nThe developer sent this message from Switchboard on their Mac: Reply with …"
10:27:00.633 assistant text:ALPHA
10:27:00.718 system    stop_hook_summary
10:27:25.982 user      {"kind":"human"} "Use the Bash tool to run exactly this command: touch p1.txt …"
10:27:28.032 assistant tool_use:Bash
10:27:31.465 attachment hook_permission_decision {"decision":"allow","toolUseID":"toolu_…","hookEvent":"PermissionRequest",…}
10:27:31.995 user      tool_result:(Bash completed with no output)
10:27:33.060 assistant text:DONE1
10:28:38.835 user      tool_result:"The user doesn't want to proceed with this tool use…"   (answered with Esc on the PC)
10:28:38.835 user      text:"[Request interrupted by user for tool use]"
10:29:18.272 attachment hook_permission_decision {"decision":"deny",…}
10:29:18.273 user      tool_result:"Denied from the Mac by the developer."
```
- Each step is a separate line, appended at the moment it happens. A pending permission dialog writes **nothing**: the Mac learns about prompts from the hook, not the transcript.
- **Reuse:**
  - `src/core/transcript-sync.ts` → `parseTranscript`, `newestChain`, `entriesSince(entries, syncUuid)` and `transcriptItems` give prompt / text / tool-use / tool-result items with uuids and timestamps.
  - `src/server/history/transcripts.ts` → `readTranscriptFacts` gives title, first prompt and similar.
  - `src/core/transcript.ts` → `slugForCwd`.
  - These are the D16 "Attach here" and History readers.
- **Gaps to add:**
  1. A `user` line with `origin.kind === "task-notification"` whose `<summary>` is the host's summary should show as "You (from Mac): <text after the prefix>". Today `transcriptItems` would show the raw `<task-notification>…` wrapper as a prompt.
  2. `attachment/hook_permission_decision` could label a tool call "approved on Mac".
  3. The file is tailed with an offset (read new bytes on `fs.watch` / a 1 s poll), not re-parsed whole. Transcripts reach tens of MB.
  4. `origin.kind:"human"` lines are the PC's own prompts.

## 3. Approve / deny from outside

**Verdict:** `PermissionRequest` hook; no race rule needed, because the TUI dialog is live the whole time.

- **Schema *(code)*:**
  - Input `{hook_event_name:"PermissionRequest", tool_name, tool_input, permission_suggestions?, mcp_server?}` + the common fields.
  - Output `hookSpecificOutput: {hookEventName:"PermissionRequest", decision: {behavior:"allow", updatedInput?, updatedPermissions?} | {behavior:"deny", message?, interrupt?}}`.
  - Logged input keys: `session_id, transcript_path, cwd, scratchpad_dir, prompt_id, permission_mode, hook_event_name, tool_name, tool_input, permission_suggestions`. There is **no `tool_use_id`** in 2.1.284, even though the docs mention one.
  - `PreToolUse` fires ~40 ms earlier with `tool_use_id` and the same `tool_input`, so the host pairs them (same session + tool + input, most recent).
- **What the terminal shows while the hook waits** (T1, `04-perm-waiting`): the normal dialog, immediately.
  ```
  ⏺ Bash(touch p1.txt)
    ⎿  Waiting…
   Bash command
     touch p1.txt
   Do you want to proceed?
   ❯ 1. Yes
     2. Yes, and always allow access to …/sandbox/t1 from this project
     3. No
   Esc to cancel · Tab to amend
  ```
  A `Notification` hook with `notification_type:"permission_prompt"`, "Claude needs your permission", fired 6 s later while the hook was still waiting. `agents --json` meanwhile said `waitingFor:"permission prompt"`.
- **Hook allow** (decided 3 s later): the dialog closed, `touch` ran, and the TUI printed `⎿ Done` / `⎿ Allowed by PermissionRequest hook`.
- **Hook deny with message:** `⎿ Error: Denied from the Mac by the developer.` / `⎿ Denied by PermissionRequest hook`. The model continued ("The Bash tool was denied by the developer on the Mac."). `interrupt:true` would stop the turn *(code: `abortController.abort()`)*.
- **Hook gives no decision** (exit 0, no output, after 20 s): nothing changed, and the dialog stayed as it was. Esc on the PC → "Interrupted · What should Claude do instead?". So the "no decision" fallback is simply "the PC dialog, which was already there".
- **PC answers first** (T2, `1` pressed while the hook waited): the tool ran at once. The hook process was **not** killed: it kept waiting until its own 60 s limit, and its later "no decision" was harmless. The host therefore has to withdraw the Mac card itself, when the paired `tool_use_id` gets a `tool_result` in the transcript. The alternative is a `PostToolUse` / `PostToolUseFailure` hook with that id. A late Mac answer after a PC answer must be dropped by the host; whether the CLI would ignore it anyway was not tested.
- **Timeouts:**
  - The default is 600 s for command hooks (*code* `Wa=600000`; docs: "Defaults: 600 for `command`…"). The schema has no maximum (`timeout: positive()`).
  - On timeout the hook is cancelled and the dialog simply stays.
  - The recommended hook `timeout` is ~3600 s, with the host deciding when to give up (it answers "no decision" when the Mac card is dismissed or the session is unhooked).
- **Fast path for sessions the Mac hasn't hooked:**
  - The hook script POSTs to `http://127.0.0.1:<hostPort>/hook/permission`. Connection refused → exit 0 at once. The session isn't hooked → the host answers `204` at once → exit 0.
  - Cost: one `node` start (~50–100 ms) in parallel with a dialog that is already on screen, so nothing is delayed.
  - Only a hooked session keeps the request open (long-poll) until the Mac answers.
- **Race rule (proposed, simpler than asked):** there is no N-second hand-back. Both sides can answer from the start and the first answer wins.
  - Mac first → the hook returns the decision.
  - PC first → the transcript shows the result, and the host closes the Mac card as "answered on the PC" (the D24 `answeredOn` idea).
  - The hook's own `timeout` is only a safety net.
- **Question cards stay on the PC:** use matcher `"^(?!AskUserQuestion$).*"`, or have the host answer 204 for `AskUserQuestion`. Also `ExitPlanMode`, if the developer wants plan approval on the PC; that is an open question.

## 4. Reply from the Mac, and the idle session

**Verdict:** an **`asyncRewake` waiter** hook on `SessionStart` and `Stop` delivers a Mac message whether the agent is busy or idle. Verified idle both before the first prompt and after a turn.

- **Mechanism *(code + docs)*:**
  - Schema: `asyncRewake: "If true, hook runs in background and wakes the model on exit code 2 (blocking error). Implies async."`
  - Docs: "The hook's stderr, or stdout if stderr is empty, is shown to Claude as a system reminder".
  - On exit 2 the CLI calls its notification queue with `{mode:"task-notification", priority:"next", …}`. That is the same path that wakes a session when a background task finishes.
  - Docs: the timeout is "not enforce[d] on a command hook you run with `async: true`", so the waiter decides how long it lives.
  - The optional `rewakeMessage` (prefix of the system reminder) and `rewakeSummary` (the one-line terminal label, default "Stop hook feedback") are marked **`@internal`** in the schema. Without them it still works, but the model reads `Stop hook blocking error from command "<name>": <text>` and the terminal says "Stop hook feedback".
- **Probe T1, idle before any prompt:**
  - A `SessionStart` waiter picked up the "Mac message" 13 s after start. The session woke on its own; `UserPromptSubmit` fired with the prompt:
    ```
    <task-notification>\n<summary>Message from the Mac</summary>\n</task-notification>\n<system-reminder>\nThe developer sent this message from Switchboard on their Mac: Reply with exactly the word ALPHA and nothing else.\n</system-reminder>
    ```
  - The TUI showed `⏺ Message from the Mac` / `⏺ ALPHA`.
- **Probe T1, idle after a turn:** after "DONE1" the TUI sat idle for 8 s, then the `Stop` waiter got the message → `⏺ Message from the Mac` / `⏺ BRAVO`. T2 and T3 repeated this with a free-text instruction ("Also include the word CHARLIE…") and Haiku obeyed ("Got it! CHARLIE. I've received your message from the Mac via Switchboard…").
- **The terminal shows only the summary line**, not the message text. The model and the transcript get the full text. A settings hook cannot make the summary dynamic; the CLI reads a per-message `rewakeSummary` only from **plugin** hooks' stdout *(code)*.
- **Every turn re-arms it**, which cuts both ways.
  - `Stop` fires after every turn, including rewoken ones (`stop_hook_active:true`), so the next waiter starts at once.
  - Waiters from earlier turns keep running until they exit. T2 had 3 alive at exit, all got `SIGTERM` when the CLI quit.
  - The runaway second session shows that a message which isn't consumed exactly once loops forever: 52 turns in 50 s.
  - Host rules:
    - a message is **claimed atomically** by exactly one waiter;
    - a newer waiter for the same session **supersedes** older ones (the host answers the old long-poll with "exit 0");
    - a per-session rate limit on deliveries acts as a circuit breaker (for example at most 3 wakes a minute).
  - `Stop` does **not** fire after an interrupt (Esc), but the previous waiter is still alive then.
- **Busy session:** a message that arrives mid-turn is delivered by the waiter still alive from the previous turn. The CLI queues it with `priority:"next"`, and it is expected to be taken up at the next turn boundary, as queued prompts are (see D44's root cause). **Not verified.** In T3 no waiter was alive yet, so it went out at the turn end. The conservative design: the host holds Mac messages while the session is running (`UserPromptSubmit` → running, `Stop` → idle) and releases them to the waiter armed by `Stop`. Then "picked up at the next turn boundary" is exactly what was verified.
- **Alternatives checked and rejected:**
  - A *synchronous* `Stop` hook with `{"decision":"block","reason":…}` held open: it works for "the turn just ended", but the TUI shows the hook running and the session looks busy (the input is taken but queued) the whole time it waits. It also can't be used for a session idle before its first turn.
  - `UserPromptSubmit.additionalContext`: it only rides along with a prompt someone types on the PC.
  - Peer messaging (`SendMessage` / `ListAgents`, `messagingSocketPath`): it needs the `.key` peer token (a credential) and an undocumented socket protocol, and the docs say such messages "can't approve anything" and come "from another session, not from you".
  - Remote Control: claude.ai, not local (`docs/spike-remote.md`).
  - PTY injection: impossible for a TUI the developer started in their own terminal.

## 5. Windows specifics (all unverified on Windows)

- **Hook commands:**
  - Without `args` the command runs through Git Bash, or through PowerShell when Git Bash isn't installed (`shell` option; the error text: "requires bash but Git Bash was not found… or add "shell": "powershell"").
  - **Use exec form**, which spawns without a shell, so quoting doesn't arise. Docs: "On Windows, exec form requires `command` to resolve to a real executable such as a `.exe`… invoke the underlying script with `node` directly".
    ```json
    {"type":"command","command":"C:\\Program Files\\nodejs\\node.exe","args":["C:\\Users\\<u>\\AppData\\Local\\Switchboard\\hook\\sb-hook.mjs","permission"],"timeout":3600}
    ```
  - The host writes the **absolute** `node.exe` path it runs under (`process.execPath`), and re-writes it when that changes. Spawns use `windowsHide: true` *(code)*.
  - On Windows the CLI ends async hooks with `TerminateProcess`, not a signal, so the host must treat a dropped long-poll as "waiter gone".
- **Paths:**
  - Config is `%USERPROFILE%\.claude` unless `CLAUDE_CONFIG_DIR` is set (Switchboard's `claudeConfigDir` already handles both).
  - Transcripts are `%USERPROFILE%\.claude\projects\<slug>\<id>.jsonl`, where `slugForCwd("C:\\Users\\me\\repo")` → `C--Users-me-repo`. The hook's `transcript_path` is authoritative anyway.
  - The session registry is `…\.claude\sessions\<pid>.json`. Peer sockets are `\\.\pipe\…` names, which the host doesn't use.
- **Installing the hook:**
  - The host merges its entries into `%USERPROFILE%\.claude\settings.json` once. That needs the developer's explicit approval in the UI; it is the only place a hook reaches hand-started sessions.
  - It also has to survive other edits to the file: identify entries by the script path, and offer "Remove hooks".
  - Changes are picked up by running sessions (§1).
  - A project-level install is not viable, since sessions start in any folder.
- **Service:** `src/server/service/` + `src/core/service-files.ts` already generate a per-user Task Scheduler task (`switchboard-task.xml`, `schtasks`, an env file). The host mode reuses it with a `SWITCHBOARD_MODE=host` env entry. A logon task runs while the user is logged on, which is when TUI sessions exist.
- **Tailscale address:** `tailscale ip -4` (100.x.y.z) or `tailscale status --json` (`Self.DNSName`). With the recommended `tailscale serve` (§6) the host needs neither: the Mac uses `https://<pc>.<tailnet>.ts.net`.
- `claude agents --json` on Windows: the code has Windows branches (`pidDomain`, named pipes). Run time and output are unverified there.

## 6. Security

- **Nothing listens beyond loopback.**
  - The host binds `127.0.0.1` as today: `assertLoopbackBind` and the AGENTS.md rule "The service binds to loopback only" stay intact.
  - Tailnet exposure is `tailscale serve --bg --https=443 http://127.0.0.1:<hostPort>`. This gives TLS and tailnet-only reach, and adds `Tailscale-User-Login` identity headers the host can check against an allowlist.
  - Binding directly to the 100.x address would need an AGENTS.md amendment and a bind-address check. That is an open question and the fallback.
- **Two kinds of callers, two credentials:**
  1. **Mac → host** (`/remote/*`): each Mac pairs once. The PC shows a one-time code (host CLI `switchboard host pair`, or a line in its log). The Mac sends it and gets a **per-Mac bearer token**; the host stores a hash, revocable per Mac. Every request needs the token (plus the Tailscale identity when served). Reuse `generateToken` / `tokenMatches` (constant-time) from `src/server/token.ts` / `security.ts`.
  2. **Hook → host** (`/hook/*`): a per-install hook token in a file only the user can read (`%LOCALAPPDATA%\Switchboard\hook-token`), read by the hook script. This stops other local users and processes from injecting "Mac messages" into sessions. The Host header must be `127.0.0.1:<port>`, and the Tailscale-served path must refuse `/hook/*`.
- **What the hook trusts:** only `{decision: allow|deny, message?}` for permissions and `{message}` for replies. It never takes `updatedInput` or `updatedPermissions` from the Mac in v1, so the Mac can't rewrite a command or add "always allow" rules; that is an open question.
  - Everything fails open to normal behaviour: host down, bad reply, timeout → exit 0.
  - Mac message text is limited (for example 8 kB). It goes in as model-visible text and is shown on the PC only as the fixed summary.
- **Anthropic terms** (per `docs/spike-remote.md` R.9):
  - Only the unmodified `claude` binary runs. The host never reads `~/.claude/.credentials*`, the keychain, the `sessions/*.key` peer tokens or `CLAUDE_CODE_MESSAGING_TOKEN`, and it never calls Anthropic APIs.
  - Transcripts are read locally and sent to the developer's own Mac over their tailnet.
  - The model turns caused by a Mac reply are ordinary turns of the developer's own session.

---

## Recommended design

**Host (PC, `SWITCHBOARD_MODE=host`, same codebase, no UI, Task Scheduler login task):**
1. **Hook script `sb-hook.mjs`** (Node, no deps), installed into user settings as exec-form hooks:
   - `SessionStart` + `SessionEnd` + `UserPromptSubmit` + `PreToolUse` + `PostToolUse` + `Stop`: `register` / `event` (fire-and-forget POST, 300 ms connect timeout, exit 0).
   - `PermissionRequest` (matcher excludes `AskUserQuestion`): `permission`, a long-poll with fast exit when the session is unhooked or the host is down.
   - `SessionStart` + `Stop` with `asyncRewake: true`, `rewakeMessage`, `rewakeSummary: "Message from the Mac (Switchboard)"`: `waiter`, a long-poll that exits 2 with the message on stderr, or 0 when superseded, unhooked for long, or after a max life of ~12 h.
2. **Session registry:** poll `claude agents --json` every 10 s and merge in hook registrations. The state is `{sessionId, pid, cwd, name, status, transcriptPath, hooked, lastHookAt, waiterAlive}` in memory (plus a small `node:sqlite` table for paired Macs and hooked ids).
3. **Transcript tailer** per hooked session: byte offset → `transcriptItems` → events.
4. **Permission broker:** open request ↔ `PreToolUse` `tool_use_id`. It resolves by Mac answer, or withdraws on `tool_result` / `PostToolUse` (answered on the PC).
5. **Message mailbox:** one queue per session. Messages are held while running and released to the newest waiter after `Stop`, claimed once, with a rate limit.
6. **Pairing + auth:** per-Mac tokens and the hook token; `tailscale serve` for reach.

**Mac (the normal Switchboard):**
- **Settings → Machines:** add a PC (URL `https://<pc>.ts.net` + pairing code), with status, last seen and a remove button; several PCs are allowed.
- **"Hook into…" picker** per machine: the host's live list (name, cwd, status, started) with a Hook / Unhook toggle.
- **Sidebar:** hooked sessions appear in SESSIONS with a **machine tag** (e.g. `pc-office`) and a status dot from the host. They are a new session kind, `remote-hooked` (no local process, never resumed or paused by the Mac).
- **Chat view:** reuses the chat renderer on the host's transcript items. The composer sends to the mailbox (marked "queued until the agent's turn ends" per D44's queued-message clock).
- **Inbox:** permission items reuse the D6 *Allow once / Deny* cards with a machine tag. They close as "answered on the PC" when withdrawn.
- **Protocol:** the Mac server connects **outbound** to each host: REST for commands (`GET /remote/sessions`, `POST /remote/sessions/:id/hook`, `POST /remote/sessions/:id/messages`, `POST /remote/permissions/:id`) and SSE for events (`GET /remote/events?since=<cursor>`, the same event style as `/hub`, D5). The Mac UI talks only to its own server. When the Mac disconnects, the host keeps running: permissions fall back to the PC dialog as always, messages already queued still get delivered, and the SSE resumes from the cursor.

**What is reused:** transcript parsing (`transcript-sync.ts`, `transcript.ts`, `history/transcripts.ts`), Inbox permission items and cards, `/hub` SSE shapes, token helpers and Host checks, the service installers (`service-files.ts`, `login-service.ts`), `claudeConfigDir`, and `claudeAgentsLister` (`supervisor/recovery.ts`).

## Limits the developer must accept

1. **A reply is picked up at the next turn boundary, and only if the session has run a hook since the host installed it.** A session started before the install gets the hooks, but has no waiter until its next turn end. Until then the Mac can watch it but not wake it. Starting `claude` after the install (or typing anything once on the PC) fixes it.
2. **After a long idle (the waiter's max life, proposed 12 h) the session can't be woken from the Mac** until something happens on the PC. A longer life means one idle `node` process per session for longer.
3. **On the PC, a Mac reply shows as one fixed line ("Message from the Mac (Switchboard)")**, not its text. The text is in the model's context and in the transcript (ctrl+o).
4. **To the model, a Mac reply is a system reminder inside a task notification, not a typed prompt.** Haiku obeyed it every time here; a model could weigh it less than a typed message.
5. **`rewakeMessage` / `rewakeSummary` are `@internal` CLI fields** and can change without notice. Without them the fallback wording is "Stop hook blocking error…" / "Stop hook feedback". Pin a tested CLI version range and check it on the host's start (`claude --version`).
6. **The PC dialog is shown while the Mac decides** (they race; first answer wins). Someone at the PC can always answer. That is the safety property, not a bug.
7. **A new file in the developer's `~/.claude/settings.json` on each PC** (hooks for every session on that PC, cheap no-ops when not hooked). Every tool call that needs permission starts one short `node` process.
8. **Question cards (AskUserQuestion), plan approval, `/` commands, model changes and interrupts stay on the PC.**
9. **Mid-turn delivery is not used:** a message sent while a long turn runs waits for the turn to end.

## Open questions for the developer

1. Expose the host with **`tailscale serve`** (loopback bind stays, HTTPS, tailnet identity), or amend AGENTS.md to let host mode bind the Tailscale 100.x address directly?
2. May the host **write into `%USERPROFILE%\.claude\settings.json`** on each PC (with an explicit install / remove button and a backup), given that user settings are otherwise never edited (D6)?
3. The waiter's **max life for an idle session**: 12 h (proposed), 24 h, or unlimited (one idle node process per open terminal session)?
4. Should **`ExitPlanMode`** (plan approval) also be answerable from the Mac, or stay on the PC like questions?
5. Should Mac approvals ever carry **"always allow"** (`updatedPermissions`) or **edited input** (`updatedInput`), or only *Allow once / Deny* (proposed)?
6. Is relying on the **`@internal` `rewakeMessage` / `rewakeSummary`** fields acceptable, with a version check and the plain fallback, or should v1 use only the documented `asyncRewake` with the default wording?
7. Should the Mac also show **un-hooked sessions read-only** (live transcript without hooking), or list them only?
8. Should **Switchboard-supervised sessions on the PC** (`entrypoint: sdk-cli`), if the PC ever runs the full app, be hidden from the picker?
9. Mid-turn delivery (a message folded into a running turn at a tool boundary): worth one more Haiku probe to verify, or keep "held until the turn ends"?

## Estimated build (milestones)

| # | Milestone | Content | Size |
|---|---|---|---|
| R0 | Host skeleton | `SWITCHBOARD_MODE=host` (no web build, loopback), host config, Task Scheduler target with the mode env, `switchboard host pair`, per-Mac tokens, the hook token | S |
| R1 | Discovery | `agents --json` poller + hook `register` / `event` endpoints + registry; hook script `sb-hook.mjs` + settings merge / remove (backup, idempotent, exec form, Windows paths) | M |
| R2 | Watch | transcript tailer (offset), task-notification prompt parsing, SSE `/remote/events` with cursor; Mac: Settings → Machines, the "Hook into" picker, `remote-hooked` sessions with a machine tag in the sidebar, read-only chat | M–L |
| R3 | Approve | `PermissionRequest` long-poll, `PreToolUse` pairing, PC-answered withdrawal, Mac Inbox cards with a machine tag | M |
| R4 | Reply | mailbox (hold while running, claim once, supersede, rate limit), `asyncRewake` waiters, composer | M |
| R5 | Hardening | CLI version check, reconnect / backoff, fake-claude scenarios for hooks (tests never call the real CLI), Windows smoke on the real PC (live test by the developer), docs | M |

Tests: extend `tools/fake-claude` to emit hook calls into the host (register, permission, stop and waiter) and to write transcript lines. Windows behaviour needs one supervised live run on the PC.

---

## Real-CLI runs (all of them)

| # | What | Model | User turns | Model turns | Notes |
|---|---|---|---|---|---|
| 1 | `claude agents --help` | none | – | 0 | help text |
| 2 | `claude agents --json` | none | – | 0 | listed 2 existing interactive sessions |
| 3 | TTY session "t1" try 1 | haiku | 0 | 0 | the driver pressed Enter on the trust dialog's default "No, exit" |
| 4 | TTY session "t1" try 2 | haiku | 1 typed (maybe) | **~52** | runaway: my hook re-delivered the used message file every turn (prefix match on `mac-msg-1.used…`); killed after ~50 s |
| 5 | TTY session T1 | haiku | 3 | 5 | idle wake before the first prompt (ALPHA), hook allow, idle wake after a turn (BRAVO), no decision → PC dialog → Esc, hook deny with message |
| 6 | TTY session T2 | haiku | 2 | 4 | PC answers first (the hook keeps waiting), `--settings` file not hot-reloaded, wake with a free-text instruction (CHARLIE) |
| 7 | TTY session T3 | haiku | 1 | 2 | project settings hot-reloaded, `agents --json` idle / waiting + registry, a message sent mid-turn delivered at the turn end |
| 8–9 | `claude agents --json` inside T3 | none | – | 0 | idle, then "permission prompt" |

Interactive sessions: 5 (limit 10). Every one ran with `--model haiku`, cwd `.spike/sandbox/<probe>`, and hooks only from spike-owned files. No `claude -p` runs were needed.

Scratch (gitignored): `.spike/remote-pc/` holds `drive.py`, `probe_t1..3.py`, `hook.mjs`, `mksettings.mjs`, `mkproj.mjs`, `ctx.mjs`, `out/` (screens, a copy of the T1 transcript, the runaway run's log) and `ctl/` (hook event logs).
