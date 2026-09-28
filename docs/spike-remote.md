# Spike: remote sessions (cloud and Remote Control)

What the installed CLI can do with the developer's **remote** Claude sessions, so a design can be picked: (1) **cloud sessions** (claude.ai/code, `--cloud`, `--teleport`) and (2) **Remote Control** sessions (`--remote-control`, `claude remote-control`, sessions driven from claude.ai or the phone, possibly on other machines). The developer approved **read-only** probing only: no session was created, resumed, teleported, attached, stopped or messaged, and no model call was made. Everything that needs a real remote session is listed under [Next probes](#next-probes-that-need-the-developers-ok). `docs/decisions.md` still wins on rulings; `docs/spike-m0.md` holds the local stream-json baseline this builds on.

## Summary

| Item | Status | Verdict (one line) |
|---|---|---|
| R.1 List cloud sessions | answered (2026-09-28) | **No non-interactive listing.** `claude agents --json [--all]` shows local processes only. The only pickers (`claude --teleport`, `/teleport`, `/tasks`) are TTY UIs. The docs say to find IDs "in your session list at claude.ai/code". |
| R.2 Attach to a cloud session headlessly | answered, code + docs | **No streaming attach today.** `claude -p "<msg>" --cloud <id>` only **queues one message and exits** (`--output-format json` → `{ok, session_id, url}`; `stream-json` is refused). A headless stream-json cloud client exists in the binary (`claude --cloud … --input-format stream-json --output-format stream-json`, no `-p`) but is behind the account gate `tengu_violin_wood`, which is **off** for this account. Interactive `claude --cloud <id>` is refused ("not enabled for your account"). |
| R.3 Teleport → a session Switchboard can supervise | code path exists, **not run** | `claude -p --teleport <id>` is implemented in print mode: it checks a clean git tree and the matching repo, fetches the session log, runs `git fetch` + `git checkout <branch>` in cwd, and seeds a **local copy** of the conversation. Combined with stream-json it should give a normal supervised session (then `--resume` as in M0.4). Needs a test cloud session (P6). |
| R.4 Create a cloud session from Switchboard | answered, code + docs | **Interactive (TTY) only.** `-p` + `--cloud "<task>"` is refused; the headless create path is compiled off in 2.1.283 (`cloudPrintEnabled` returns `false`); the stream-json client is gated off (R.2). `-p --environment ccpool_…` creates headlessly but only on a self-hosted environment (Team/Enterprise). |
| R.5 Read a cloud transcript without attaching | answered | **No read-only command.** Only teleport reads it, and teleport makes a local copy and checks out the branch. |
| R.6 Switchboard's own sessions **with** Remote Control | code path found, **not run** | `-p --remote-control` is parsed but **ignored** in print mode (code; also [issue #80954](https://github.com/anthropics/claude-code/issues/80954)). The working hook is the stdin control request **`{"subtype":"remote_control","enabled":true,"name":…}`** on the existing stream-json process (what the Agent SDK's undocumented `query.enableRemoteControl()` sends). Reply: `{session_url, connect_url, environment_id, bridge_epoch, bridge_session_id}`. `initialize` reports `remote_control_available: true` for this account. Enabling it creates a real Remote Control session, so it needs P1. |
| R.7 See / reach Remote Control sessions on other machines | answered, docs + code | **No CLI listing or send for them.** They are visible only *inside* a session that is itself connected to Remote Control, through the `/list-agents` command (text) and the model's `ListAgents` / `SendMessage` tools (plain-text peer messages that can't approve anything). Whether `-p --cloud <id>` also delivers to a Remote Control session is unknown (P7). `--teleport` can pull one as a local copy. |
| R.8 Identity | answered | IDs `session_…` and `cse_…` are the **same session** in two forms (prefix swap). URL `https://claude.ai/code/session_…`. Remote Control names: explicit name, else `<prefix>-<adjective>-<noun>` with prefix = hostname, or `--remote-control-session-name-prefix` / `CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX`. A local transcript records its Remote Control id in a `bridge-session` line. |
| R.9 Constraints | answered | claude.ai subscription login required for both (this machine: `authMethod: "claude.ai"`, Max). API keys, `setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock/Vertex/Foundry and a non-default `ANTHROPIC_BASE_URL` all disable them. Cloud usage shares the subscription's rate limits. Anthropic's terms forbid a third-party app from collecting or intermediating claude.ai tokens, so **Switchboard must drive the unmodified `claude` binary and never call the sessions API itself**. |

**Recommendation in one line:** build the Remote Control toggle for Switchboard's own sessions first (design A), after P1–P3 confirm it. Add the cloud follow-up and "continue locally" actions (B, C) once P5–P6 pass. Park "run in the cloud" (E) until the CLI exposes a headless create.

---

## Probe conditions

- CLI `2.1.283 (Claude Code)` (`~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.283`), Node `v24.21.0`, macOS arm64, logged in with claude.ai (Max).
- Every CLI call went through `.spike/remote/run.mjs`, which uses `spawn(cmd, args, { shell: false })` with stdin `/dev/null` and a hard timeout (SIGTERM, then SIGKILL). It scrubs `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID` and `CLAUDE_EFFORT` from the env, as in M0. macOS has no `timeout(1)`, so the runner does it.
- **Processes run: 19, all bounded, no model call, no session created, nothing sent.**
  - 14 help/version runs: `--version`, root `--help`, and `--help` of every subcommand.
  - `claude agents --json`, `claude agents --json --all`, `claude auth status --json`, `claude doctor`.
  - One control-protocol probe (`ctl-probe.mjs`): a `claude -p` stream-json Haiku process that got three read-only control requests and no user message.
- **Static reading of the binary.** `strings -n 6` of the 2.1.283 executable (Bun bundle, JS source embedded) → `.spike/remote/out/bin-strings.txt`, searched with `.spike/remote/ctx.mjs`. Code reading shows **intent, not behavior**. Every such finding is marked *(code)* and names the verbatim string or function behavior it rests on.
- **Local state, non-secret only.**
  - `~/.claude.json`: key names, the cached feature gates whose names contain remote/bridge/ccr/cloud/violin/teleport, and the GitHub-connection status. Never `oauthAccount` or anything named like a token, key or credential.
  - `~/.claude/settings.json`: key names only. `~/.claude/sessions/*.json`: key names only.
  - A structural scan of all 76 local transcripts (`tx-scan.mjs`, `tx-bridge.mjs`, `tx-url.mjs`): counts, key names and ID *prefixes* only.
  - Credential files, `*.key` files and the keychain were not touched. No token was printed.
- **Public docs read (2026-09-28):**
  - [Remote Control](https://code.claude.com/docs/en/remote-control)
  - [Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web)
  - [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
  - [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
  - [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
  - GitHub issues [anthropics/claude-code#80954](https://github.com/anthropics/claude-code/issues/80954) and [nimbalyst/nimbalyst#1480](https://github.com/nimbalyst/nimbalyst/issues/1480).
- **Side effects observed:**
  - No transcript was written by the control probe: no `~/.claude/projects/*remote-spike*` folder exists afterwards, as M0.3 predicts for control-only processes.
  - The CLI rewrites its own `~/.claude.json` caches and keeps per-process state under `~/.claude/session-env/` and `~/.claude/sessions/` (its own state, as in M0; not inspected further).
  - Nothing else was written outside the worktree.
- **Deliberately not run** (side effects unclear or they need a TTY; see [Next probes](#next-probes-that-need-the-developers-ok)):
  - `claude remote-control --help`: runs the eligibility and trusted-device preflight before printing help, see R.6.
  - `claude daemon remote-control list --json`: hidden command, may cold-start the daemon.
  - `claude --teleport` without an id: interactive picker.
  - `claude -p "/list-agents"`: writes a new local session.
- Scratch in `.spike/remote/` (gitignored): `run.mjs`, `ctx.mjs`, `ctl-probe.mjs`, `tx-*.mjs`, and captures in `out/`. `prev-run/` holds the interrupted run's files, which this run did not rely on.

---

## Help surface (run)

`claude --help` (trimmed to the relevant flags; `out/help-root.txt`):
```
--cloud [description|session_id|url]  Create a cloud session with the given description, or attach
                                      to an existing one by session ID or claude.ai/code URL
--environment <environment_id>        Create a new cloud session that runs on the given self-hosted
                                      environment (ccpool_...).
--remote-control [name]               Start an interactive session with Remote Control enabled (optionally named)
--remote-control-session-name-prefix <prefix>
                                      Prefix for auto-generated Remote Control session names (default: hostname)
--teleport [session]                  Resume a teleport session, optionally specify session ID
```
There is **no** `sessions`, `cloud` or `remote` listing subcommand. The listed commands are `agents, attach, auth, auto-mode, doctor, gateway, import, install, logs, mcp, plugin, project, respawn, rm, setup-token, stop|kill, ultrareview, update`. `attach/logs/stop/rm/respawn` act on local `--bg` sessions only (M0.1).

Hidden options found in the binary *(code)*:
- `--remote` ("Deprecated alias for --cloud"), `--rc` (alias for `--remote-control`).
- `--ref <ref>` and `--on-branch <branch>` ("Requires --cloud or --environment").
- `--forward-home-settings`, `--correlation-id` (requires `--environment`).
- `--attach-serve` ("Attach a serve-only helper to a bound cloud session (spawned by the desktop app; not for interactive use)").
- `--sdk-url` ("reserved for Remote Control worker processes connecting to Anthropic's backend").
- A `claude remote-control` verb (aliases `rc`, `remote`, `sync`, `bridge`) that bypasses commander. Its help text is embedded (quoted under R.6).
- A `claude daemon` verb whose help includes `remote-control list [--json]  List remote-control servers`. That lists servers registered in `~/.claude/daemon.json` on **this** machine, not sessions. The file does not exist here.

`claude agents --json` and `--json --all` (`out/agents*.json`): one row, `{pid, cwd, kind:"interactive", startedAt, sessionId, name, status:"waiting", waitingFor:"input needed"}`, the orchestrating terminal session. The implementation (`printAgentsJson`) merges only the local process registry and background jobs. **Cloud and Remote Control sessions never appear** *(code + run)*.

`claude auth status --json` (identifiers redacted): `loggedIn: true, authMethod: "claude.ai", subscriptionType: "max"`.

`claude doctor` (cwd `.spike/remote/sandbox/ctl`, redacted):
```
Managed settings (remote): not fetched — requires an Enterprise or Team subscription
Organization policy: not applicable to Pro and Max accounts

Remote Control
Control this session from claude.ai/code or the Claude mobile app

No installation issues found.
```
(The Remote Control section shows no failing check, which matches `remote_control_available: true` below.)

## Local state and gates (read)

`~/.claude.json` → `cachedGrowthBookFeatures` (cached 2026-09-28T12:16Z; the CLI's own feature flags for this account):

| Gate | Value | What it controls |
|---|---|---|
| `tengu_violin_wood` | **false** | *(code)* the headless stream-json cloud client (`isViolinWoodEnabled` in the `--cloud` option parser, R.2) |
| `tengu_remote_backend` | *absent* (→ false) | *(code)* interactive `claude --cloud <session_id>` attach: `if(attachId && !(defaultedToCloud \|\| gate)) → "Error: Attaching to an existing cloud session is not enabled for your account."` |
| `tengu_teleport_send_to_cloud` | false | *(by name only)* sending a local session to the cloud |
| `tengu_ccr_bridge`, `tengu_ccr_bridge_multi_session`, `tengu_bridge_repl_v2` | true | *(by name only)* the Remote Control bridge |
| `tengu_ccr_v2_send_events_cli`, `tengu_ccr_v2_session_crud_cli` | true | *(by name only)* the CLI's session event and CRUD calls |

Also in `~/.claude.json`:
- `hasUsedRemoteControl: true`, `remoteControlSurfacesSeen: ["mobile"]`: the developer has used Remote Control from the phone before.
- `githubWebConnectionStatusCache.status: "not_connected"`: claude.ai has no GitHub connection cached for this account, which matters for creating cloud sessions from GitHub.

`~/.claude/settings.json` sets none of `remoteControlAtStartup`, `autoUploadSessions`, `disableRemoteControl`, `crossSessionInbound`, `isolatePeerMachines`.

Transcripts (76 files, structure only):
- **`bridge-session` lines** (65 lines, all in one transcript): `{type:"bridge-session", sessionId, bridgeSessionId:"cse_…", lastSequenceNum, ownerAccountUuid, ownerOrganizationUuid}`. A session that had Remote Control on records its remote id in its own transcript, so History can show it. M0.3's entry-type table did not list this type.
- One `system/bridge_status` line: `content: "/remote-control is active · Continue here, on your phone, or at <url>"`, `url: "https://claude.ai/code/session_<id>"`, `entrypoint: "cli"`.
- The `remote_session_change` attachment (66 lines) is the commit/PR attribution setting (`{url, commit, pr, sendUserFileHint, managedCommit, managedPr}`), not a Remote Control marker.

## Control-protocol probe (run)

`node .spike/remote/ctl-probe.mjs`: one process, cwd `.spike/remote/sandbox/ctl`, **no user message**.
```
claude -p --input-format stream-json --output-format stream-json --verbose \
       --model haiku --max-turns 1 --permission-prompt-tool stdio
stdin → {"type":"control_request","request_id":"req_init","request":{"subtype":"initialize","hooks":null}}
stdin → {"type":"control_request","request_id":"req_settings","request":{"subtype":"get_settings"}}
stdin → {"type":"control_request","request_id":"req_status","request":{"subtype":"get_status"}}
(EOF) → exit 0, stdout types: system/hook_started, system/hook_response, control_response
```
`initialize` response, remote-related fields (the account block is reduced to `subscriptionType: "Claude Max"`, `apiProvider: "firstParty"`):
```json
{"remote_control_available":true,"remote_control_auto_enable":false,"remote_control_auto_connect_default":false,
 "remote_control_auto_on_by_default":false,"ide_rc_auto_enable_gate":true,"session_state":"idle","current_permission_mode":"default"}
```
`get_status` returns sections of rows:
- `Session`: Version, Session ID, `Session kind = interactive`, `Peer address = uds:/tmp/cc-socks/<pid>.sock`, cwd, `Login method = Claude Max account`, Organization, Email.
- `Environment`: Model, MCP servers, Setting sources, Auto mode server.

It has no remote-session data. `get_settings` returns `{effective, sources, applied}` and holds no remote keys on this machine.

**Reading:** a host is expected to read `remote_control_available` / `remote_control_auto_enable` from `initialize` and then decide whether to send `remote_control` (R.6).

---

## R.1–R.5 Cloud sessions

### Listing (R.1)
- **Run:** `claude agents --json` shows local processes only (above).
- **Docs:** "`--resume` reopens a conversation from this machine's local history and doesn't list cloud sessions". To find an ID: "Find the ID in your session list at claude.ai/code". Pickers: `claude --teleport` (no id), `/teleport`, `/tasks` → all interactive.
- **Code:**
  - The CLI's hint when no ID is given: "`claude --cloud <session-id>` re-attaches to another one; a picker is coming".
  - The only structured listing in the binary is internal: `walkCcrSessionList` / `listBridgePeerSessions`. It is a paged GET on the sessions API with the OAuth token, max 5 pages, `statuses=active,paused`. Rows: `{id, title, status, updated_at, environment_kind, connection_status}`, later mapped to `{id, title, lastActive, workerStatus: running|idle|requires_action, remoteControl: environment_kind==="bridge", offline}`. It feeds `ListAgents` / `/list-agents` (R.7). Switchboard **must not call it itself**; see R.9.

### Attaching and sending (R.2)
- **Docs + code, one-shot send:** `claude -p "<msg>" --cloud <session_…|cse_…|claude.ai/code URL>`.
  - Docs: "The CLI queues the message into the session and exits without waiting for a reply."
  - `--output-format json` → `{"ok":true,"session_id":…,"url":…}` or `{"ok":false,"session_id":…,"error":…}`.
  - Code: `if (outputFormat==="stream-json") → "Error: --cloud <session_id> does not support --output-format stream-json"`; the prompt comes from the positional or stdin.
  - It posts one `{type:"user", message:{role:"user", content}}` event to the session. It works from any machine and any cwd, needs no git, and fails with `cloud session <id> is archived and cannot accept new messages` for archived sessions.
- **Code, interactive attach:** `claude --cloud <id>` without `-p` → `Error: Attaching to an existing cloud session is not enabled for your account.` (gate above). The docs say to use `-p` instead.
- **Code, headless stream-json cloud client:** the option parser enables it when `!print && nonInteractive && inputFormat==="stream-json" && outputFormat==="stream-json" && !sdkUrl && isViolinWoodEnabled()`. It then runs `runHeadlessCloudAttach(id)` or `runHeadlessCloudCreate()`. Its messages show it talks to its host over the SDK control channel ("could not ask the host about file sync…", "unattended-serving question", "device-MCP question"). That is the Desktop app's path. With `tengu_violin_wood: false` this account gets the normal refusals instead:
  - for a description: "Error: --cloud requires an interactive terminal. Non-interactive invocations … would silently ignore --cloud";
  - for an id: the one-shot send path, which refuses `stream-json`.

  **Not available today**; worth re-checking when the CLI updates.
- **Verdict:** Switchboard can **send** to a cloud session but not **watch** it, answer its questions or stream it. The session has to be followed on claude.ai (the send returns the `url`).

### Creating (R.4)
- **Code**, when `-p` is combined with a description: "Error: --cloud cannot be combined with --print. Starting a new cloud session with --cloud is interactive only: drop --print, or drop --cloud to run locally. To message an existing cloud session instead, pass its ID…".
- **Code:** the `-p` create path (`runHeadlessCloudPrintArm`) sits behind `cloudPrintEnabled: f8r()`, and `function f8r(){return!1}` compiles it off in 2.1.283.
- **Code:** `claude -p "<task>" --environment ccpool_…` creates headlessly and prints `{ok, session_id, title, url, pool_id}`, but only on an organization's **self-hosted** environment (Team/Enterprise). A Max account has none.
- **Docs, requirements for `claude --cloud "<task>"` (TTY):**
  - It "clones your current directory's GitHub remote at your current branch, not your local checkout, so push first".
  - GitHub access comes from the Claude GitHub App or `/web-setup`. Otherwise it bundles the local repo (git repo with at least one commit, under 100 MB, untracked files excluded; `CCR_FORCE_BUNDLE=1` forces it).
  - The session runs in the **Default** cloud environment (auto-created at onboarding).
  - Plans: Pro, Max, Team, Enterprise premium. Not with ZDR or third-party providers.
  - This account's cached GitHub status is `not_connected`, so a create would bundle.

### Teleport (R.3)
- **Docs:** Teleport "verifies you're in the correct repository, fetches and checks out the branch from the cloud session, and loads the full conversation history into your terminal. The terminal gets its own copy of the session: new work there stays local and doesn't appear in the cloud session." Requirements: clean git state, a checkout of the same repository (not a fork), the branch pushed, the same account, claude.ai login.
- **Code, print mode supports it** (`HP` → `if(s.teleport)` branch, logged as `tengu_teleport_print`):
  1. Checks the `allow_remote_sessions` policy.
  2. `validateGitState()`: "Git working directory is not clean. Please commit or stash your changes before using --teleport." Untracked files are ignored. In print mode there is no stash prompt: it fails.
  3. `teleportResumeCodeSession(id)`: first-party API and a claude.ai access token only. It validates the repo against the session's `git_repository` source (`match` / `no_repo_required` pass; `not_in_repo` / `mismatch` → "You must run claude --teleport <id> from a checkout of <owner/repo>"). Then it fetches the log (`/v1/code/sessions/<id>/teleport-events`, falling back to session-ingress) and keeps non-sidechain messages.
  4. `checkOutTeleportedSessionBranch(branch)`: `git fetch origin <b>:<b>`, then `git checkout <b>`, falling back to `checkout -b <b> --track origin/<b>`, then sets the upstream.
  5. Returns the messages as the conversation's start (`messagesOrigin: "remote"`). For a session whose `environment_kind` is `"bridge"` it adds: "This terminal now has its own copy of the session: new work here stays local and will not appear in the Claude app." So **Remote Control sessions from another machine can be teleported too**, as a copy.
- **Not verified:**
  - that `-p --teleport <id>` accepts `--input-format stream-json` (no code guard against it was found);
  - which session id the local copy gets and when its transcript is written;
  - that a later `--resume <local id>` works.
- **Side effects:** a `git fetch` and a branch **checkout in the process cwd**, so Switchboard must run it in a dedicated clean worktree or clone of the session's repo. The cloud session itself is not changed (docs).

### Reading a transcript without attaching (R.5)
There is no read-only command. The session log is only fetched by teleport (above) and by the gated attach paths. The endpoints exist in the binary (`/v1/code/sessions/<id>/teleport-events`, session events), but calling them means using the developer's OAuth token outside the CLI. That is excluded (R.9).

---

## R.6–R.8 Remote Control

### Starting it on sessions Switchboard supervises (R.6)
- **`-p --remote-control` does nothing.**
  - *(Code)* The flag is parsed. It exports `CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX` when `--remote-control-session-name-prefix` is given, but the print/headless runner (`Gr`) never reads `remoteControl`; only the interactive path (`yi`) acts on it.
  - [Issue #80954](https://github.com/anthropics/claude-code/issues/80954) (2.1.216, closed as not planned): "The `-p --remote-control "name"` flag is accepted but silently ignored. The run completes normally (exit 0), no RC state is recorded in the session file".
- **`remoteControlAtStartup` does not help either.** Docs: "connect automatically when an interactive session starts". `initialize` shows `remote_control_auto_enable: false` here.
- **The working path is a stdin control request** *(code; not run, because it creates a real Remote Control session)*. The print-mode control loop handles `T.request.subtype==="remote_control"`:
  ```
  stdin → {"type":"control_request","request_id":"rc1","request":{"subtype":"remote_control","enabled":true,
           "name":"<title>","reattach_session_id":"<cse_…, optional>","keep_session_on_exit":<bool, optional>}}
  stdout ← control_response success {session_url, connect_url, environment_id, bridge_epoch, bridge_session_id}
  stdin → {"type":"control_request","request_id":"rc2","request":{"subtype":"remote_control","enabled":false}}
  stdout ← control_response success {}          (tears the bridge down, reason "remote_control_disabled")
  ```
  - Response builder, verbatim: `function Ho(v,I){return{session_url:…(v.bridgeSessionId,…),connect_url:…(v.environmentId,…),environment_id:v.environmentId,bridge_epoch:I,bridge_session_id:v.bridgeSessionId}}`. `connect_url` is `https://claude.ai/code?environment=<environment_id>`.
  - The embedded Agent SDK sends exactly this from `async enableRemoteControl(enabled, name, {reattachSessionId, keepSessionOnExit, workSecret, refreshWorkSecret})`. The public TypeScript reference does not document it; nimbalyst#1480 calls it "undocumented and untyped … could change without notice" and shows the reply `{ session_url: "https://claude.ai/code/session_...", bridge_session_id: "cse_..." }`.
  - The bridge is created with `remoteControlOrigin:"sdk"` and gets the backlog (`getBackfillMessages`), so the phone sees the conversation so far.
  - Refusals *(code)*:
    - "Remote Control cannot be enabled from inside a remote session";
    - eligibility errors from `getBridgeDisabledDiagnosis`: not first-party, inside a cloud session, `disableRemoteControl`, not signed in, not subscription auth, token scope limited, org policy, version floor `2.1.139`.
- **Two answerers for one question** *(code)*. While the bridge is attached, every pending and new `can_use_tool` / dialog request is also forwarded to claude.ai (`sendControlRequest` for `getPendingPermissionRequests()` and `getPendingUserDialogRequests()`).
  - When **the phone answers first**, `injectControlResponse` resolves the request and writes **`{"type":"control_cancel_request","request_id":…}` to stdout**. That is the same cancellation M0.2 already handles: mark the Inbox batch closed.
  - When **Switchboard answers first**, `setOnControlRequestResolved` sends the cancel to the bridge.
  - Messages typed on the phone go through `onInboundMessage` into the same message queue as stdin messages. How they appear on Switchboard's stdout (for example a `user` line with `isReplay`) is **not verified** (P2).
- **Workspace trust.** `claude remote-control` refuses an untrusted directory ("Error: Workspace not trusted…"). Whether the control-request path checks trust is unknown (P1). M0.1 found the sandbox untrusted and the workspace root trusted.
- **`claude remote-control` (server mode) is not a fit.** It is its own supervisor: it spawns and serves child sessions to claude.ai (`--spawn same-dir|worktree|session`, `--capacity`, default 32 per docs), and Switchboard would not see their streams. Its preflight (`preflightTrustedDeviceBlocking` → `enrollTrustedDeviceIfNeeded`) can lazily **enroll this computer as a trusted device** ("This computer was enrolled as a trusted device for your account (you will also get an email)"). The docs add: "Claude Code checks Remote Control eligibility before printing help". That is why even `claude remote-control --help` was not run. Its help text, read from the binary:
  ```
  Remote Control - Control local sessions from claude.ai/code or the Claude mobile app
    claude remote-control [options]
    --name <name> · --remote-control-session-name-prefix <prefix> · -c, --continue · --session-id <id>
    --permission-mode <mode> · --[no-]chrome · -d, --debug[=<filter>] · --debug-file <path> · -v, --verbose
    --spawn <mode> (same-dir, worktree, session) · --capacity <N> · --[no-]create-session-in-dir
    - You must be logged in with a Claude account that has a subscription
    - Run `claude` first in the directory to accept the workspace trust dialog
  ```

### Seeing and reaching sessions on other machines (R.7)
- **No CLI command lists, inspects or messages them** (help, `agents --json`, code above).
- **Docs** ([cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)):
  - `/list-agents` (alias `/peers`) shows "Your cloud sessions: shown while this session is connected to Remote Control" and "Your Remote Control sessions on other machines: shown while this session is connected to Remote Control, and labeled `Remote Control`", with `offline` when disconnected.
  - Messages go through Anthropic's servers and arrive as plain text from "another session, not from you". They "can't approve anything", and commands in them don't run.
  - While connected to Remote Control, the listing withholds working directories and unattributable names.
- **Code:** `/list-agents` is `{type:"local", supportsNonInteractive:true}`, so it would run in `-p` without a model call. Its output is text, though, not JSON. The model-facing `ListAgents` tool carries the structured rows listed under R.1.
- `-p --cloud <cse_…>` accepts any `session_`/`cse_` id and posts a user event. Whether the server routes it to a Remote Control session on another machine is unverified (P7); the docs only promise cloud sessions.
- `--teleport <id>` of a Remote Control session → local copy (R.3).
- **Verdict:** Switchboard could see them only through a helper session that is itself Remote-Control-connected, by parsing `/list-agents` text (fragile), and could reach them only through a model-written `SendMessage` or the unverified `-p --cloud` send.

### Identity (R.8)
| Thing | Form | Evidence |
|---|---|---|
| Session id | `session_<X>` (v1 / URL form) = `cse_<X>` (v2 form), a plain prefix swap | *(code)* `function i(e){if(!e.startsWith("cse_"))return e;return"session_"+e.slice(4)}` and the reverse; id regex `/^(?:session\|cse)_[A-Za-z0-9_]+$/`; the transcript stores `cse_…` while the `bridge_status` URL shows `session_…` |
| Session URL | `https://claude.ai/code/session_<X>` (with `?from=cli&m=0` from the CLI) | docs; `bridge_status` line |
| Environment | `environment_id` (Remote Control registration); `ccpool_…` for self-hosted | *(code)* `connect_url = …/code?environment=<id>`; `--environment` help |
| Title | explicit `--name` / `remote_control.name` → `/rename` → last meaningful message → `<prefix>-<adjective>-<noun>` | docs ("An auto-generated name like `myhost-graceful-unicorn`") |
| Prefix | `CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX` \|\| hostname, lower-cased, non-alphanumerics → `-`, fallback `remote-control` | *(code)* `GAe()`; `--remote-control-session-name-prefix` sets the env var in `-p` too |
| Local ↔ remote link | transcript line `{type:"bridge-session", sessionId, bridgeSessionId:"cse_…", lastSequenceNum, …}` | run (transcript scan) |

---

## R.9 Constraints

- **Auth.**
  - Both features need a claude.ai subscription login used as the active auth. From the Remote Control docs:
    - "API keys are not supported."
    - "Long-lived tokens (from `claude setup-token` or `CLAUDE_CODE_OAUTH_TOKEN`) … can't establish Remote Control sessions".
    - Not available with Bedrock, Agent Platform or Foundry, a non-default `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DISABLE_GROWTHBOOK`.
  - Cloud: "`--cloud` requires an Anthropic account", plus the org policy `allow_remote_sessions` (n/a on Max).
  - This machine: `authMethod: "claude.ai"`, Max, `apiProvider: firstParty`, `remote_control_available: true`.
  - Switchboard's children must not get `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL`.
- **Interactive-only today:**
  - creating a cloud session (`claude --cloud "<task>"`);
  - attaching to one (refused for this account);
  - the teleport picker (`claude --teleport`, `/teleport`, `/tasks`);
  - `--remote-control` / `remoteControlAtStartup` (interactive sessions only);
  - `claude remote-control` server mode.
- **Headless today:**
  - `-p "<msg>" --cloud <id>` (send only);
  - `-p --teleport <id>` (code path, unverified);
  - the `remote_control` control request (code path, unverified);
  - `-p --environment ccpool_…` (self-hosted only).
- **Rate limits and quota.**
  - Docs: "cloud sessions share rate limits with all other Claude and Claude Code usage within your account … There is no separate compute charge for the cloud VM."
  - Remote Control runs locally, so it costs what the local session costs. Messages from the phone are ordinary turns.
  - Cloud VMs expire after inactivity ("Environment expired"; reopening restores the history, not running background work).
  - `claude remote-control` servers give up after about 10 minutes offline; interactive Remote Control keeps retrying.
- **Data.** "While Remote Control is connected, the session transcript … is stored on Anthropic servers."
- **Trusted devices** (beta, opt-in on Max): the terminal enrolls automatically at sign-in, and `claude remote-control` may enroll lazily (R.6).
- **Third-party tools** ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)):
  - "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens".
  - The same page allows "an end user … signing in to the unmodified Claude Code binary with their own Claude subscription".
  - "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
  - Switchboard is the developer's own local supervisor of their own signed-in CLI, so the designs below stay within that: they only spawn `claude`, never read the token, and never call `api.anthropic.com` directly.
  - The `remote_control` request is used by the Agent SDK's own `ProcessTransport`, but it is undocumented, so treat it as unstable.

---

## Proposed designs (ranked)

| Rank | Design | Headless today | Needs a test session first | UI placement | Main risks |
|---|---|---|---|---|---|
| **A** | **"Reachable from phone" for Switchboard's own sessions**: send `remote_control` on the supervised stream-json process, show the link and QR; Switchboard stays the primary host | yes, by code (`remote_control_available: true`) | **P1, P2, P3** | session header toggle **Remote** plus link/QR popover; a phone glyph on the SESSIONS row; Settings → Sessions "Reachable from phone by default" (off); Inbox marks a batch "answered on claude.ai" on `control_cancel_request`; History badge from the `bridge-session` line | undocumented request (pin the CLI version and fall back to hiding the toggle on error); one claude.ai entry per enable (name it with prefix `switchboard`); transcript stored at Anthropic while on; archive on EOF unless `keep_session_on_exit`; possible trusted-device enrollment |
| **B** | **Cloud follow-ups and bookmarks**: a **Remote** group in the sidebar; the developer adds a cloud session by pasting its claude.ai/code URL; actions **Send follow-up** (`claude -p "<msg>" --cloud <id> --output-format json`) and **Open on claude.ai** | yes (documented) | **P5** | sidebar group **REMOTE** under SESSIONS (title, the id's short form, last-sent time); a small composer; no chat view, only a note "replies appear on claude.ai" | no listing, no status and no replies, so it is blind; the send is a write, so only on an explicit click; IDs typed by hand |
| **C** | **Continue a remote session locally**: teleport into a new supervised session, the way D16 moves terminal conversations. `claude -p --teleport <id> --input-format stream-json --output-format stream-json …` in a fresh clean worktree of the session's repo, then normal `--resume` | code path exists | **P6** | New-session form option **Pull a cloud session** (paste URL); REMOTE row action **Continue locally**; History shows it as a normal session tagged "teleported" | git fetch and checkout (always use a dedicated worktree); needs a clean tree, the same GitHub repo and a pushed branch; it is a one-way copy, so two diverging conversations exist and the UI must say so |
| D | **Remote peers panel**: list cloud and other-machine Remote Control sessions with status by running `/list-agents` in a Remote-Control-connected Switchboard session (or a small helper session) | partly (needs A) | P1, **P4** | the REMOTE group fills itself (status dot: running / idle / needs input / offline) | text output, not JSON; details withheld while connected; bounded pages; each helper is another claude.ai entry; reaching a session is only via model-written `SendMessage` or unverified P7 |
| E | **"Run in the cloud"** New-session option | **no** (TTY only; headless create compiled off; stream-json client gated off) | none | for now a disabled option with the reason, plus **Copy command** `claude --cloud "<task>"` for a terminal | re-check on CLI updates (`initialize` has no flag for it; the gate lives in the CLI's own cache) |
| ✕ | Call the sessions API with the developer's OAuth token; drive `claude --cloud` / `--teleport` pickers in a PTY; run `claude remote-control` under Switchboard | — | — | — | the first breaks the terms (token intermediation) and an undocumented API; the second is TUI scraping; the third is a competing supervisor whose streams Switchboard can't see |

Notes for A (implementation shape, after P1–P3):
- **Where:** in `SessionSupervisor`, after `initialize`, keep `remote_control_available`.
- **Toggle on:** send `remote_control{enabled:true, name:<session name>, keep_session_on_exit:true}`. Store `bridge_session_id` and `session_url` on the session row.
- **Toggle off:** send `enabled:false`.
- **D7 resume:** send `reattach_session_id:<cse_…>` so the phone keeps the same claude.ai entry.
- **Children:** always pass `--remote-control-session-name-prefix switchboard` so unnamed ones are recognizable.
- **fake-claude:** gets a `remote_control` scenario that returns the reply above, plus `control_cancel_request` for a question answered "remotely".

## Next probes that need the developer's OK

The first two columns say what runs; the Cost column counts model calls.

| # | Probe | Exact commands (all in `.spike/remote/sandbox/<name>/`, via `run.mjs`, D11 flags) | Cost | Shows up in claude.ai? | Answers |
|---|---|---|---|---|---|
| P1 | Remote Control on a throwaway supervised process, no message | `claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --max-turns 1 --permission-prompt-tool stdio --remote-control-session-name-prefix switchboard-probe`; stdin: `initialize`, `remote_control{enabled:true,name:"switchboard-probe"}`, wait 30 s, `remote_control{enabled:false}`, EOF | 0 model calls; one Remote Control registration | **yes**, one "switchboard-probe" session (check whether disable archives it); possibly a trusted-device email if the account requires trusted devices | does the request work in `-p`; the reply fields; trust needed in cwd; archive on disable or exit; `bridge-session` line written without a turn? |
| P2 | Phone round trip on P1 (kept on) | as P1, but the developer opens the link and (1) types "reply ok", (2) answers one Bash permission Haiku asks for (`node -e 1`) **on the phone** | 1–2 Haiku turns (max-turns 3) | yes (same session) | what a phone message looks like on stdout; `control_cancel_request` when the phone answers; whether Switchboard's late answer is ignored |
| P3 | Pause/resume keeps the same claude.ai entry | P1 with `keep_session_on_exit:true`, EOF; then `claude -p --resume <id> …` + `remote_control{enabled:true, reattach_session_id:"cse_…"}` | 0–1 Haiku turns | yes (same entry, or a second one if it fails) | D7 compatibility |
| P4 | Listing remote sessions from inside | on P1 while enabled: stdin user message `/list-agents` | 0 model calls (local command) | no new entry; **prints the developer's real session titles** (read-only) | whether cloud and other-machine Remote Control sessions are listed in `-p`; the text format; statuses |
| P5 | Cloud send | developer creates one cloud session "switchboard-probe" on claude.ai (or `CCR_FORCE_BUNDLE=1 claude --cloud "reply ok"` from a TTY on a tiny local repo) and sets `/model haiku` there (D11); then `claude -p "reply ok" --cloud <id> --output-format json` | 1–2 Haiku turns **in the cloud** (shared quota; the VM is free) | **yes**, a new cloud session | the JSON shape; delivery while idle or busy; archived error |
| P6 | Teleport into a supervised session | clean throwaway clone of P5's repo under `sandbox/teleport/`: `claude -p --teleport <id> --input-format stream-json --output-format stream-json --verbose --model haiku --max-turns 1 --permission-prompt-tool stdio`; first EOF with no message, then again with "reply ok"; then `claude -p --resume <new id> …` | 0–1 local Haiku turns; a git fetch and checkout in the throwaway clone | no (the cloud session is unchanged per docs) | the stream-json and teleport combination; the local session id; when and where the transcript is written; history shape; resume |
| P7 | Send to a Remote Control session via `--cloud` | `claude -p "reply ok" --cloud <cse_… of P1's session> --output-format json` from a second process while P1 is on | 1 Haiku turn in the P1 process | yes (P1's session) | whether the documented cloud send also reaches Remote Control sessions (other machines) |
| P8 | Low-value leftovers | `claude remote-control --help`; `claude daemon remote-control list --json` | 0 model calls | no | the help text is already known from the binary; the daemon list covers local servers only. Side effects: eligibility and trusted-device preflight; possible daemon cold start |

P1 first: A, D and P2–P4 and P7 depend on it. P5 is the gate for B and C, and needs the developer to create the cloud session because the CLI can't create one headlessly.

## Could not determine (and why)

- **Does the `remote_control` request work end to end in `-p` on this account?** Code and `remote_control_available: true` say yes, but running it creates a Remote Control session, which was out of bounds (P1).
- **How phone-typed messages and phone-answered prompts appear on Switchboard's stdout.** This needs a live bridge (P2). Only the `control_cancel_request` behavior is visible in code.
- **Whether `-p --resume` of a session that had Remote Control on reconnects it by itself.** The docs describe that only for interactive `--resume` (P3).
- **Whether `-p --teleport` works with stream-json input**, what id the local copy gets and when its transcript appears (P6).
- **Whether `-p --cloud <id>` reaches Remote Control sessions on other machines** (P7).
- **When the headless cloud client (`tengu_violin_wood`) or interactive attach (`tengu_remote_backend`) will be enabled for this account.** These are server-side feature flags. Only today's cached values were read.
- **Exact rate or quota numbers for cloud and Remote Control.** The docs give none beyond "shared with all other Claude and Claude Code usage".
- **Whether this account has Trusted Devices on.** It is off by default on Max and the setting is only visible on claude.ai, so it is unknown whether P1 would trigger an enrollment email.
