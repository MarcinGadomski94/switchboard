# MCP servers page (D61)

The **MCP** nav item (after *Schedules & loops*, route `/mcp`) shows the MCP servers Claude Code would load in a saved folder, and manages them: **check**, **reconnect**, **sign in** (OAuth), **enable / disable** for the folder, **add**, **edit** and **remove**. It is one global page (no per-session tab). Everything goes through the `claude` CLI: Switchboard never writes Claude Code's config files itself.

Code: `src/core/mcp.ts` (wire types, masking, parsing, validation), `src/server/mcp/` (`config.ts` reads the files, `helper.ts` the short-lived control-request process, `service.ts` the actions), `src/server/api/mcp.ts` (routes), `src/web/views/McpView.tsx` + `mcp.ts` (page). Contract: `docs/handoff/contracts/local-api.md` → *MCP servers page (D61)*. Security: `docs/security.md` → *MCP servers (D61)*.

## The page

- **Folder selector** at the top: this machine's saved folders (the default first), then each online paired machine's folders as `<machine> · <folder>` (D48). What loads depends on the folder: project and local servers are per folder.
- **Groups by scope:** *Local* (private to you in this folder, `~/.claude.json`), *Project* (`.mcp.json` in the folder: shared, may be committed, needs approval), *User* (all your folders, `~/.claude.json`), then read-only groups for what a **Check all** found beyond the config files (plugin servers, claude.ai connectors, managed / enterprise servers). A plugin or connector row can be checked, reconnected, signed in and disabled, but not edited or removed here.
- **Per server:** name, transport (stdio / http / sse / ws), `command args…` or the URL (secrets masked, see below), the **names** of its env variables / headers, status (connected · failed + the CLI's error · needs authentication · still connecting · pending approval · rejected · disabled · not checked), the tool count of the last check, and when it was checked.
- **Actions per row:** Check · Reconnect · Authenticate / Re-authenticate (HTTP / SSE / claude.ai only) · Disable / Enable · Edit · Remove (confirmed). In the header: **Check all** and **+ Add server**.
- After every action the page shows the **CLI command(s)** it ran (secrets masked) and, on failure, the CLI's own words. After an add, edit, remove, enable or disable a note says: *live sessions pick the change up on their next start* (a running `claude` process keeps the servers it started with).

## Where servers come from (reading)

Listing reads the files the CLI reads (read-only, CLI 2.1.285, read in its code):

| Scope | File | Key |
|---|---|---|
| user | `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json` (`<config dir>/.config.json` wins when it exists) | `mcpServers` |
| local | the same file | `projects[<folder>].mcpServers` |
| project | `<folder>/.mcp.json` | `mcpServers` |

- **Disabled for the folder:** `projects[<folder>].disabledMcpServers` (what the CLI's `mcp_toggle` writes).
- **Project approval:** `enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers` in `<config dir>/settings.json`, `<folder>/.claude/settings.json`, `<folder>/.claude/settings.local.json` and the folder's entry in the global file. Not approved → *pending approval* (approve it by running `claude` in the folder); rejected → *rejected*.
- The project key is the folder's path; both the path as saved and its realpath are tried (ASSUMED D61-project-key).
- Listing starts no process and connects to nothing. Statuses come from the last check (kept in memory per folder, lost at a restart: ASSUMED D61-cache).

## Checking

- **Check (one server):** `claude mcp get <name>` with the folder as cwd (45 s limit). Only its `Status:` and `Issue:` lines are read; the rest of its output prints env values and headers in clear, so it is never stored or sent on. Status texts (CLI 2.1.285, VERIFIED in code): `✓ Connected`, `! Connected · tools fetch failed`, `! Needs authentication`, `✗ Failed to connect`, `✗ Connection error`, `- Not configured`, `⏸ Pending approval (run \`claude\` to approve)`, `✗ Rejected (see disabledMcpjsonServers in settings)`, `⊘ Disabled for this project (re-enable via /mcp)`.
- **Check all:** the helper process (below) answers `mcp_status`: every server Claude Code loads in the folder with `status` (`connected | failed | needs-auth | pending | disabled`), `error`, `error_code` (`APPROVAL_REQUIRED` → pending approval), `scope`, `source` (`plugin`, a config scope, …), `config` and `tools[]` (counted). While a server is still `pending` the helper asks again every second, up to 30 s. When the helper fails, `claude mcp list` is the fallback (`<name>: <command or URL> - <status>[ — <issue>]`, VERIFIED in code; no tool counts, no scopes).

## The helper process

Reconnect, enable / disable, sign-in and Check all use a short-lived `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio` (the usage poller's argv) in the folder, driven only by **control requests**: `initialize`, then the action's request. It never gets a user message, so **no model call and no transcript** (VERIFIED for the usage poller in M0.3; the MCP handlers answer in the CLI's control loop without starting a turn, VERIFIED in code). It is closed right after the answer (EOF, then SIGTERM / SIGKILL), also on errors and timeouts; a sign-in keeps it until the server connects, the sign-in is cancelled or 5 minutes pass. Every helper is stopped when Switchboard stops.

| Action | Control request (CLI 2.1.285, schema read in the binary) | Effect |
|---|---|---|
| Check all | `{subtype:"mcp_status"}` → `{mcpServers:[…]}` | read-only |
| Reconnect | `{subtype:"mcp_reconnect", serverName}`, then `mcp_status` | reconnects in the helper; the status shows what a new session would get |
| Disable / Enable | `{subtype:"mcp_toggle", serverName, enabled}` | the CLI writes `disabledMcpServers` of the folder's project entry in `~/.claude.json` (for the built-in servers `enabledMcpServers`): **the CLI's own mechanism**, per folder |
| Authenticate | `{subtype:"mcp_authenticate", serverName}` | answers `{authUrl, requiresUserAction, callbackExpected, redirectScheme:"localhost", state, callbackPort}` and listens on localhost for the redirect |
| Re-authenticate | `{subtype:"mcp_clear_auth", serverName}`, then `mcp_authenticate` | clears the stored tokens first |
| Paste the redirect | `{subtype:"mcp_oauth_callback_url", serverName, callbackUrl}` | completes a sign-in whose browser could not reach the localhost callback |

There is no `claude mcp enable/disable` command; `mcp_toggle` is what `/mcp` → Disable does inside Claude Code.

### Sign-in (OAuth), headless

VERIFIED in the CLI's code: `mcp_authenticate` runs the OAuth flow **without opening a browser** (`skipBrowserOpen`) and answers the authorization URL; the CLI's local callback server (on `callbackPort`) takes the browser's redirect, stores the tokens and reconnects the server. So the page:

1. opens a new tab (at the click, so no popup blocker) and points it at `authUrl`;
2. keeps the helper running and polls its `mcp_status` every second until the server is `connected` → **Signed in** (or 5 minutes → failed);
3. offers a field to **paste the redirect URL** (`mcp_oauth_callback_url`) when the browser is not on the machine that runs the helper (a paired machine's server) or the callback could not be reached;
4. on a failure shows the CLI's error and the terminal fallback with a Copy button: *Run `claude` in a terminal in `<folder>` and use /mcp → `<server>` → Authenticate (or `claude mcp login <server>` there).*

A claude.ai connector's `mcp_authenticate` answers `callbackExpected: false` (the sign-in completes on claude.ai); the page then waits for the status like any other. Stdio servers have no OAuth: the service refuses before starting anything.

## Add, edit, remove

| Action | Command (cwd = the folder) |
|---|---|
| Add | `claude mcp add-json <name> '<json>' --scope <local\|project\|user>` |
| Edit, same name and scope | `claude mcp remove <name> --scope <scope>`, then `claude mcp add-json <name> '<json>' --scope <scope>`; if that add fails, `add-json` with the **previous** definition restores it |
| Edit, new name or scope | `add-json` the new one first, then `remove` the old one (nothing is lost if the add fails) |
| Remove | `claude mcp remove <name> --scope <scope>` (after a confirm) |

- The JSON: stdio `{"type":"stdio","command","args":[…],"env":{…}}`; http / sse / ws `{"type","url","headers":{…}}`. On an edit the keys the form does not show (`oauth`, `timeout`, …) are carried over when the transport stays.
- **Validation mirrors the CLI** (code read): name `[a-zA-Z0-9_-]+` (*Invalid name X. Names can only contain letters, numbers, hyphens, and underscores.*), scope local / user / project, transport stdio / sse / http / ws, a command for stdio, an http(s) URL for http / sse and a ws(s) URL for ws (ASSUMED D61-url-rule), env names `[A-Za-z_][A-Za-z0-9_]*` (ASSUMED), header names RFC 7230 tokens (the CLI's rule), one-line values. The CLI checks again; its error (e.g. *MCP server x already exists in user config*) is shown verbatim (409).
- **Project scope** writes `<folder>/.mcp.json`: the form says it is a file in the repo that may get committed. A new project server then needs approval like any other.

## Secrets

- The list and the Edit form **never carry an env value or a header value**: only their names. Args are masked where they look like secrets (`--token x`, `--api-key=x`, `API_KEY=x`, `Bearer x`, URLs), and URLs lose their password and secret-looking query values (`token`, `key`, `secret`, `password`, `auth`, `session`, `signature`, …) → `••••`.
- **Edit keeps secrets server-side:** a kept env / header row is sent as `{name, keep:true}` and the service puts the stored value back; a masked arg or URL posted back unchanged is restored from the stored definition. Typing a value replaces it.
- Command logs, CLI errors and outputs pass through a scrubber that replaces every known secret value (and any `Authorization: …` value) with `••••`.
- The one place a secret leaves the service: the `add-json` argv (the CLI takes the definition only as an argument), visible to this user's own processes while the command runs (`docs/security.md`).

## Peers (D48)

The MCP routes are on `PEER_API_ALLOW`, so the page manages a paired machine's servers through `/api/machines/{id}/api/mcp…` (its folders, its CLI, its files). A sign-in on a peer: its CLI listens on **that** machine's localhost, so after signing in in the browser paste the address the browser ends on (the page shows the field).

## Switchboard's own server (D68)
Every session Switchboard starts gets a built-in `switchboard` server (its todo tools, `docs/todos.md`), passed to the CLI at spawn (`--mcp-config`). It is in none of the config files this page reads, and the page's helper process starts without it, so it is not listed here and cannot be edited or removed from this page.

### Tools that appear without a restart (2026-10-16)
The feature tools of the `switchboard` server (Team's `team_*` and `request_access`, Plans' `plan_*`, Project memory's `memory_*`) depend on state that changes while a process runs. The helper (`src/hook/sb-feature-tools.ts`) therefore keeps them in step:

- **Probes.** At start, and again on every wake-up, it asks `GET /agent/v1/team`, `/agent/v1/plans` and `/agent/v1/memory` (3 s each). 200 = the tools are registered, any other answer = removed. A probe that fails (no answer in time, Switchboard not reachable) leaves its set as it was; the next check tries again, so a timeout at start no longer leaves the session without its tools.
- **Wake-ups.** It holds `GET /agent/v1/tools/watch?since=N` open; Switchboard answers it when something the tools depend on changed for that session (adopt, return, move or a charter change: `TeamService` → `supervisor.agentToolsChanged(sessionId)`) or for everyone (Settings → Experimental → Team / Plans / Project memory), and otherwise after **25 s**, which makes the periodic check. An older Switchboard (404) or none: a plain 30 s wait.
- **list_changed.** Adding and removing go through the MCP SDK's `registerTool` / `RegisteredTool.remove()`, which send `notifications/tools/list_changed` once connected. Claude Code (VERIFIED in 2.1.296's code) then lists the tools again; Codex CLI and OpenCode are ASSUMED not to (`.loop/questions.md` → *Feature tools without a restart*).
- **Reports.** Every `tools/list` answer the CLI gets is reported as `POST /agent/v1/tools { tools }` (`ListedToolsTransport`), kept in memory per session (`AgentToolsRegistry`, `src/server/todos/agent-tools.ts`) and dropped when the process ends. So Switchboard knows what the CLI really has, whatever the CLI does with `list_changed`.
- **Asks that need a tool** (`SessionSupervisor.sendNeedingTool`: D105's charter ask needs `team_propose_charter`, D107's draft ask `memory_propose`): listed already → sent; else the helper is woken and the ask waits up to 8 s for a report with the tool (a CLI that re-lists: no restart); else the process restarts **once** with `--resume` (D91's restart; the chat's divider "Switchboard tools updated") and the ask goes to the new process once its helper listed the tool. A running turn (or a question waiting on the developer) is never interrupted: the restart and the ask wait for its end, in order. No process: the ask starts one as any message does (its helper probes at start). A helper that never reported (a CLI without it, a hooked terminal session): sent as before.
- **The least disruptive rule.** Adoption, return and the switches only **wake** the helpers; nothing restarts for a missing tool unless an ask that needs it is about to go out. (Adoption itself still restarts an idle process because its charter changes the instruction, D64 / D91, as before.)
- **A call to a tool that is off** (a CLI that has not re-listed yet) is answered by the helper with a tool error that says why (the probe route's message, e.g. "this session is not a team member (or Team is off): the Team tools work only in a member's session") and that the tools come back by themselves, instead of the SDK's bare "Tool … not found". The routes check eligibility on every call as before.
- Tests: `tests/server/todos/feature-tools.test.ts` (the tool list before and after, over the SDK's in-memory transport; the registry), `tests/server/team/tools-refresh.test.ts` (fake-claude runs the real helper, `docs/fake-claude.md` → *Running the switchboard MCP server*: the charter ask live, with one restart, and after a running turn).

### Tool annotations (2026-10-19)
Every tool the `switchboard` server can expose declares a `title` and all four MCP behaviour hints as explicit booleans (directories, OpenAI's among them, reject a tool with a hint missing or not a boolean). They are written out in the tool's definition (`src/core/todos.ts`, `artifacts.ts`, `owned-loops.ts`, `plans.ts`, `plans-jira.ts`, `memory.ts`, `team-tools.ts`, `team-access-tools.ts`) and again, as literals, where the tool is registered, so a static scanner resolves them too. Read-only = changes nothing; destructive = can delete or overwrite; idempotent = repeating it with the same arguments has no further effect; open-world = reaches outside Switchboard's own state.

| Tool | Feature | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|---|
| `todo_list` | always | true | false | true | false |
| `todo_get` | always | true | false | true | false |
| `todo_add` | always | false | false | false | false |
| `todo_update` | always | false | true | true | false |
| `todo_start` | always | false | false | true | false |
| `todo_done` | always | false | false | true | false |
| `todo_remove` | always | false | true | true | false |
| `artifact_save` | always | false | false | false | false |
| `artifact_list` | always | true | false | true | false |
| `artifact_get` | always | true | false | true | false |
| `loop_create` | always | false | false | false | false |
| `loop_list` | always | true | false | true | false |
| `loop_update` | always | false | true | true | false |
| `loop_pause` | always | false | false | true | false |
| `loop_resume` | always | false | false | true | false |
| `loop_cancel` | always | false | true | true | false |
| `team_handoff` | Team (member) | false | false | false | false |
| `team_members` | Team (member) | true | false | true | false |
| `team_report` | Team (member) | false | false | false | false |
| `team_propose_charter` | Team (member) | false | false | true | false |
| `request_access` | Team (member) | false | false | true | false |
| `plan_create` | Plans | false | false | false | false |
| `plan_add_item` | Plans | false | false | false | false |
| `plan_add_dependency` | Plans | false | false | true | false |
| `plan_status` | Plans | true | false | true | false |
| `plan_start` | Plans | false | false | true | true |
| `plan_set_solutions` | Plans | false | true | true | false |
| `plan_propose_dependencies` | Plans | false | false | true | false |
| `memory_propose` | Project memory | false | false | true | false |
| `memory_list` | Project memory | true | false | true | false |

`plan_start` is the one open-world tool: the plan's runs work in git repositories and merge pull requests. `tests/server/todos/tool-annotations.test.ts` lists every tool with all features on in a member's session and fails when a tool lacks a hint, a hint is not a boolean, a hint differs from this table, or the registered hints differ from the definition; a new tool needs a row there and here.

## Tests

- `tests/core/mcp.test.ts`: masking, `mcp get` / `mcp list` text (fixtures built from the CLI's code), `mcp_status` rows, validation, the add-json definition with kept secrets.
- `tests/server/mcp/mcp.test.ts`: the routes against fake-claude with a temp `HOME` / `CLAUDE_CONFIG_DIR`: the exact argv of get / add-json / remove, the helper's control requests, the edit orders and the restore, 409 verbatim errors, plugin rows read-only, the OAuth flow (URL, completion, pasted redirect, cancel), no secret in any answer, the peer allow-list.
- `tests/tools/fake-claude-mcp.test.ts`: the fake's `mcp` family and control requests.
- `tests/web/mcp.test.ts`: labels, groups, folder choices, form ↔ input.
- E2E `tests/e2e/mcp.spec.ts`: open /mcp, see the folder's servers, check, add, edit (the kept env value), disable / enable, remove with confirm, sign in (the fake's authorization page opens in a new tab).

## Codex CLI and OpenCode (D62)
Under Claude Code's servers, a *Codex CLI and OpenCode* section lists each CLI's own servers through its CLI: Codex with `codex mcp list --json`, **+ Add server** (a command and its arguments, or an https URL → `codex mcp add`) and **Remove** (`codex mcp remove`); OpenCode with `opencode mcp list`, Add / Remove marked (its `mcp add` is interactive: edit opencode.json). Check, Reconnect and sign-in are Claude Code's control requests and stay Claude Code's. Routes `GET|POST|DELETE /api/mcp/cli/{provider}…` (on the peer API). `docs/providers.md` → *MCP*.
