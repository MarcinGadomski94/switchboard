# Local API contract (locked)

Base: `http://127.0.0.1:4870`. JSON, camelCase. Auth: the `sb_token` cookie.

## REST
| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | /api/sessions | — | Session[] (with agents, open question count) |
| POST | /api/sessions | NewSession | Session |
| GET | /api/sessions/{id} | — | SessionDetail (agents, recent events, files, artifacts) |
| POST | /api/sessions/{id}/messages | { text } | 202 |
| POST | /api/sessions/{id}/pause · /resume | — | Session |
| POST | /api/sessions/{id}/detach · /attach | — | { resumeCommand } |
| GET | /api/sessions/{id}/events | ?since=ts · D95 (additive): ?limit=n · ?before=eventId · ?agent=agentId | Event[] |
| GET | /api/sessions/{id}/diff | ?file= · ?scope=head\|branch\|repo (D90, default head) | FileDiff[] |
| GET | /api/sessions/{id}/diff/targets | — (D90) | DiffTargets |
| GET | /api/sessions/{id}/diff/count | ?scope=head\|branch\|repo (D90 ruling, default head) | DiffCount |
| GET | /api/inbox | — | InboxItem[] |
| POST | /api/questions/batch/{batchId}/answers | { answers: [{questionId, answerIndex}] } | 204 (400 unless all are answered) |
| POST | /api/inbox/{id}/actions/{action} | — | 204 |
| GET | /api/solutions | — | SolutionGroup[] |
| POST | /api/solutions/{repo}/isolate | { sessionId } | Worktree |
| GET/POST | /api/schedules, /api/schedules/{id}/run, /pause, /resume | — | Schedule |
| GET | /api/artifacts | ?kind=&q=&session= | ArtifactListItem[] (D89: the artifacts saved on purpose; until 1.13.0 `?type=&q=` over derived rows, see *Artifacts saved on purpose (D89)*) |
| GET | /api/history | ?q= | HistoryItem[] |
| GET/PUT | /api/settings | Settings | Settings |
| GET/PUT | /api/tools | Tool[] | Tool[] |
| POST | /api/tools/{id}/probe | — | { state: up\|down } |
| GET | /api/system | — | { cli, cliVersion, signedIn, ghSignedIn, cpu, ramUsed, ramTotal, processes, usagePct? } |

### NewSession
```json
{ "name": "checkout-page-640", "task": "…", "workType": "feature|qa", "mode": "single|orchestrator",
  "solutions": ["acme-web-front","mobile"], "phase": "ui-first|integration",
  "coordination": "sequential|parallel-twin|none|null", "qa": { "stack": "web|mobile|both", "confluenceUrl": "", "figmaUrls": [] } ,
  "worktrees": true, "ultracode": false }
```
Validation: name unique and kebab-case; solutions not empty (D38: an empty list is allowed for a workspace folder, see below); read-only paths are rejected (422); `qa` is required when workType = qa.

## Folders per session (D14, 2026-09-28, additive)
Developer ruling D14 (`docs/decisions.md`): there is no single configured workspace root. Sessions start in **saved folders**, each a *workspace* (a folder with a router `AGENTS.md` that is not itself a git main checkout) or a *repo* (a git main checkout). Everything below is additive; the rows and payloads above keep their meaning. Details: `docs/folders.md`.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | /api/folders | — | Folder[] (each with its live `check`; the default first, then most recently used) |
| GET | /api/folders/check | ?path= | FolderCheck (nothing is saved); 400 without `path` |
| POST | /api/folders | { path } | 201 Folder (added) · 200 Folder (already saved) · 422 `{ error: "invalid", message, check }` when it is not a workspace or a git repo |
| DELETE | /api/folders/{id} | — | 200 Folder[] (the list left) · 404 · 409 `{ error: "folder-in-use", message, schedules }` |
| PUT | /api/folders/{id}/default | — | 200 Folder[] · 404 |
| GET | /api/solutions | ?folder= | one folder's SolutionGroup[]: `folder` = a saved folder's id (or the path of a saved folder or of a session's folder); the default folder when omitted; a repo folder is one group with its one solution; 409 `no-folder` when nothing is saved, 404 `not-found`, 409 `folder-missing` |
| GET / POST | /api/codebase-memory, /api/codebase-memory/reindex | ?folder= | as above; a repo folder's list is empty |

```json
Folder      { "id", "path", "canonicalPath", "name", "kind": "workspace|repo", "isDefault", "addedAt", "lastUsedAt", "check": FolderCheck }
FolderCheck { "path", "canonicalPath", "exists", "kind": "workspace|repo|null", "router": { "title", "lines" } | null,
              "solutionCount", "repoName", "problem": "not-absolute|missing|not-a-folder|git-worktree|unsupported|null", "message" }
```

- **NewSession** gains `folder` (a saved folder's id; omitted or `null` = the default folder; an unknown id is 422 with field `folder`; 409 `no-folder` when nothing is saved; 409 `folder-missing` when the folder is gone). For a **repo** folder the router-only fields (`workType`, `mode`, `phase`, `coordination`, `qa`) are ignored and stored `null`, and `solutions` may be empty: the repo is the one solution (any other name is 422).
- **Session / SessionDetail** gain `folder` (id; `null` once the folder left the list), `folderPath` (the folder's canonical path) and `folderKind`; `cwd` is the workspace root, the repo, or the repo's worktree.
- **Schedule** gains `folder`; its `template` (ScheduleInput → NewSession) carries `folder` the same way and the stored template always holds the folder's id.
- **HistoryItem** gains `folder` and `folderPath`.
- `GET /api/setup` lists the saved `folders` (the wizard's skippable "Add your first folder") instead of a workspace root; the workspace-root routes of the wizard are gone; `GET /api/setup/folders` (Browse…) stays.

## Terminal conversations move in (D16, 2026-09-28, additive)
Developer ruling D16 (`docs/decisions.md`): a conversation started in a terminal continues in Switchboard **as the same conversation** (same Claude session id; its history imported; `claude --resume <id>` under supervision with no new message). Additive; nothing above changes. Details: `docs/supervisor.md` → *Continue in Switchboard*, `docs/derivations.md` → *History*.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | /api/history/{claudeSessionId}/continue | { name?, addFolder?, confirm? } | 201 Session · 404 `not-found` · 409 `already-in-switchboard` `{ sessionId }` · 409 `folder-not-saved` `{ check: FolderCheck }` (the workspace or repo it sits in; send `addFolder: true`) · 409 `terminal-open` `{ reasons }` (the Attach-here reasons; send `confirm: true`) · 409 `folder-missing` · 422 `not-in-a-folder` `{ cwd }` · 422 `not-a-terminal-conversation` · 422 `invalid` `{ errors }` (name) · 503 `closing` |

- The session's folder is the saved folder that holds the conversation's start folder; its `cwd` is that start folder; its name is `name`, else the title, else the first prompt, kebab-case, made unique. `workType`, `mode`, `phase` are `null`; `worktrees` and `ultracode` are false; no first message is sent.
- **HistoryItem** gains `terminal` (`true` on a terminal conversation not in Switchboard yet), `firstPrompt` and `cwd` (its start folder). A moved conversation is listed once, as the stored session.

## Embedded tools through a framing proxy (D15, 2026-09-28, additive)
Developer ruling D15 (`docs/decisions.md`): each tool with a URL is served through its own loopback framing proxy, and the Tool view's iframe loads that. Both fields are additive; the rows above keep their meaning. Details: `docs/tools.md` → *Framing proxy*.

- **Tool** gains `frameUrl`: the proxy URL the iframe loads (`http://127.0.0.1:<proxy port>` or `http://localhost:<proxy port>`, as the page's host, + the tool URL's path and query), or `null` when the tool has no URL or no proxy runs for it (demo mode). It is ignored in a `PUT /api/tools` body; the `PUT` answer already names the restarted proxy of a changed URL. "New tab" keeps using `url`.
- **`POST /api/tools/{id}/probe`** may add `framing: "refused"`: only when the tool is up, its answer refuses to be framed by the page (`X-Frame-Options` / CSP `frame-ancestors`) and no proxy runs for it; the UI then offers New tab instead of a blank frame.

```json
Tool      { "id", "name", "url", "description", "showInSidebar", "frameUrl": "http://127.0.0.1:52841/" | null }
ToolProbe { "state": "up|down", "framing"?: "refused" }
```

## Footer meters (D17, 2026-09-28, additive)
Developer ruling D17 (`docs/decisions.md`). `GET /api/system` and the `system` event keep every field above, `usagePct` included (the higher of the 5-hour and weekly windows, M9.2), and gain:

- `ramUsed` keeps its name and unit (bytes) but means the memory **actually in use**: Activity Monitor's *Memory Used* on macOS (`vm_stat`), `MemTotal − MemAvailable` on Linux, `totalmem − freemem` on Windows and whenever that read fails (`docs/setup.md` → *System*).
- `usageWindows?: UsageWindow[]`: each usage window known now, omitted when none is (a window that is unknown is left out, never guessed). Order: `session`, `week`, then the model windows.

```json
UsageWindow { "key": "session|week|model", "label": "Session|Week|<model>", "pct": 0-100, "resetsAt": "ISO 8601", "model"?: "<model display name>" }
```
`session` = the 5-hour window, `week` = the weekly limit (all models); a `model` window (e.g. `Fable`) is listed only while that model-scoped weekly limit is in use (above 0 % or active). Details: `docs/usage.md`.
- `usageWarnings[]` (M9.2, additive) entries may have `window: "model"` with `model: "<name>"` for a model-scoped limit.

## Folder names (D18, 2026-09-28, additive)
Developer ruling D18 (`docs/decisions.md`): a saved folder can have a **custom name** of its own. It is a label on top of the folder's own name: `Folder.name` (the last path segment) does not change, and worktrees keep being named after it (`<repo>-wt-<session>`); a repo folder's one solution is still `name`. Everything is additive; the D14 rows above keep their meaning. Details: `docs/folders.md` → *Names (D18)*.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | /api/folders | { path, label? } | as in D14; `label` (optional) is the custom name (trimmed; empty or omitted = none; for a folder saved already, a non-empty `label` renames it) · 409 `{ error: "label-taken", message }` · 422 `{ error: "invalid-label", message }`; a refused name saves nothing |
| PUT | /api/folders/{id}/label | { label: string \| null } | 200 Folder[] (the whole list, as `PUT /api/folders/{id}/default`) · 404 `not-found` · 409 `label-taken` (another saved folder has that name, ignoring case) · 422 `invalid-label` (over 40 characters, or `label` not a string / `null`); `null` or an empty string removes the custom name |

```json
Folder { …D14 fields, "label": "Side project" | null, "displayName": "Side project" }
```
- `label`: trimmed, at most 40 characters (Unicode code points), unique among saved folders ignoring case; `null` = none.
- `displayName` = `label`, else `name`: what the UI shows for the folder (the New-session Folder dropdown, Settings → Folders, the Solutions and Codebase Memory folder switchers, the folder tags), always with the path next to it (second line or tooltip).

## Live activity (D19, 2026-09-28, additive)
Developer ruling D19 (`docs/decisions.md`): while a session's turn runs, the service reports what it is doing now, derived in memory from the CLI's stream-json. Additive; nothing above or below changes meaning. Details: `docs/derivations.md` → *Live activity*, `docs/hub.md`.

- **Session** (so also SessionDetail and the `sessionUpdated` payload) gains `activity: SessionActivity | null` (`null` when no turn runs, always for a session without a live process).
- New `/hub` event **`activity`** `{ sessionId, activity: SessionActivity | null }`, sent when a session's activity changes, **at most one per second per session** (the newest value always goes out).

```json
SessionActivity { "turnStartedAt": "ISO", "state": "thinking|tool|writing|waiting", "since": "ISO", "tool": "<name>|null", "summary": "<short text>|null",
                  "thinkingTokens": 1234|null, "agents": { "<agent id>": AgentActivity } }
AgentActivity   { "state": "thinking|tool|writing|waiting", "since": "ISO", "startedAt": "ISO", "tool": "<name>|null", "summary": "<short text>|null" }
```
`state` is `waiting` while any question or permission request is open, else the main agent's; `since` is when that state (for `tool`, that tool call) began; `thinkingTokens` is the turn's estimated thinking tokens (`null` before the first tick); `agents` holds the main agent and each subagent working now, keyed by `Agent.id` (`startedAt` = when that agent became active in the turn).

## Background work (D30, 2026-09-28, additive)
Developer ruling D30 (`docs/decisions.md`): a session waiting on background work it started (a `Bash` run in the background, an async `Agent`, a `Monitor`, a `ScheduleWakeup`) shows that it is still working after its turn ended. Additive to *Live activity* above; nothing above or below changes meaning. Details: `docs/derivations.md` → *Background work*.

- **SessionActivity** gains `background: BackgroundTask[]`: the main agent's pending background tasks, oldest first; empty when none. It is there while a turn runs too (the state then reads as before).
- **ActivityState** gains `background`: no turn runs, but a task is pending. `Session.activity` is then non-`null` (it used to be `null` whenever no turn ran): `since` = `turnStartedAt` = the oldest task's start, `tool` / `summary` = the tool that started it (`Bash`, `Agent`, `Monitor`, `ScheduleWakeup`) and its summary, `thinkingTokens: null`, `agents` = the main agent alone, in state `background` with the same fields. `null` again once no task is pending and no turn runs.
- The `/hub` event **`activity`** carries it unchanged (at most one per second per session). No new route, no new event; the session's `status` is not affected (a finished turn stays `done`).

```json
SessionActivity { …D19 fields, "state": "thinking|tool|writing|waiting|background", "background": [BackgroundTask] }
BackgroundTask  { "id": "<CLI task id | tool_use id>", "toolUseId": "toolu_…", "kind": "bash|agent|monitor|wakeup",
                  "summary": "<short text>", "startedAt": "ISO", "wakeAt"?: "ISO", "github": true|false }
```
`id` = the CLI's task id (the background command's, the async agent's, the monitor's), the `tool_use` id when there is none (a wake-up); `summary` = D19's short text (a GitHub wait: its `gh …` command; a wake-up: its reason); `startedAt` = its tool call; `wakeAt` only on a wake-up (the call's time + `delaySeconds`); `github` = the command uses `gh run`, `gh pr checks` or `gh workflow`. A task ends with the CLI's `system/task_notification` for it, a wake-up when the next turn starts, all of them when the process ends (exit, pause, detach).

**D43 (2026-09-29, additive): every background task counts.** Developer ruling D43 (`docs/decisions.md`): a background **Workflow**, and every other background task the CLI reports (`system/task_started`), keeps a session working like D30's tasks. Nothing above changes meaning; no new route, event or field.
- **`BackgroundTask.kind`** gains `workflow` (a `Workflow` call whose result confirms a background launch; `summary` = the result's `Summary:` line, else the call's description / name) and `task` (a task the CLI reported of a type Switchboard does not map; `summary` = its description). A background shell or subagent the CLI reports without a known call has kind `bash` / `agent`.
- For a task the CLI reported without a `tool_use_id`, **`toolUseId`** is its task id; **`startedAt`** of a task known only from its `system/task_started` is that line's arrival.
- In state `background`, **`SessionActivity.tool`** is `Workflow` for a workflow and `null` for a `task`.
- A task also ends with a `system/task_updated` whose status is terminal. Details: `docs/derivations.md` → *Background work* → *Every background task counts (D43)*.

**2026-10-16 (additive): background waits keep `run`.** `BackgroundTask` gains **`waiting`** (boolean, always sent by this version): the agent waits on the task (a subagent; a GitHub wait; a wake-up; another shell / monitor / task for at most 30 minutes without a sign of life; never a dev server or watcher; a GitHub wait or a wake-up stops after a 2 h stale guard). While any such task is pending the session's `status` is `run`, which revises D30's "the session's `status` is not affected" for these tasks. A client reading a payload without `waiting` counts a subagent, a GitHub wait and a wake-up. `TeamMember` and `TeamRosterEntry` gain `waitingOn` (`github` | `background` | `wakeup` | `null`) and `wakeAt` (ISO | `null`). Details: `docs/derivations.md` → *Session status* → *Waiting on background work*.

**Background shells are no wait (D143, no shape change).** `BackgroundTask.waiting` is `false` for every shell: a background `Bash` of any command (a GitHub wait included: `github` stays `true` for its words), a `Monitor`, a `local_bash` / `monitor_mcp` task. So such a task never makes `status` `run` (nor hides a `turnWait`); `TeamMember.waitingOn` / `TeamRosterEntry.waitingOn` are `github` / `background` only from an older machine. A client reading a payload without `waiting` counts a subagent and a wake-up only. Clients show those tasks as the agent's background apps (`docs/processes.md` → *Background apps of an agent (D143)*).

```json
BackgroundTask  { …D30 fields, "kind": "bash|agent|monitor|wakeup|workflow|task" }
```

## Session titles (D22, 2026-09-28, additive)
Developer ruling D22 (`docs/decisions.md`): a session keeps its technical short name (`name`: kebab-case, unique; its worktree `../{repo}-wt-{name}` and branch `session/{name}` are built from it, so it never changes) and may have a free-text **title**, which the UI shows wherever the session is named. Additive; the rows and payloads above keep their meaning. Details: `docs/derivations.md` → *Session titles*.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| PUT | /api/sessions/{id}/title | { title } | 200 Session (`sessionUpdated` is published) · 404 `not-found` · 422 `invalid` `{ errors: [{ field: "title" }] }` |

- **NewSession** (and the repo folder's body) gains optional `title`: trimmed, 1–80 characters, else 422 on field `title`; omitted or `null` = no title. `name` keeps its rules (kebab-case, unique).
- **`PUT /api/sessions/{id}/title`** validates `title` the same way; `null` or an empty (blank) title clears it, and the name is shown again. Only the title changes: the name, branch and worktree stay. Every spawn from then on passes the title (else the name) as `--name`; a live process keeps the name it was started with.
- **Session / SessionDetail** (and the `sessionUpdated` payload) gain `title` (`null` when none) and `displayTitle` (the title, else the name).
- **InboxItem** gains `sourceTitle` on question and permission items (the session's display title; `source` stays its name). **ArtifactListItem** gains `sessionTitle` (the source session's display title, `null` without a session). **HistoryItem** gains `displayTitle` on a stored session's row (a terminal conversation's row shows `name`). The Artifacts and History searches match the title too.
- A session moved in from a terminal (D16) takes the conversation's title (the last custom title, else the AI title; at most 80 characters) as its title; a scheduled run's session takes the schedule's name.
- **ContinueConversation** (`POST /api/history/{claudeSessionId}/continue`, D16) gains optional `title` (developer ruling 2026-09-28): trimmed, 1–80 characters, else 422 `invalid` on field `title`; it is the moved session's title, and without a `name` the short name is derived from it as for a new session (`-2`, `-3`, … when taken). Omitted or `null` = the conversation's own title, as above.
- **ConflictSession** (`Solution.conflictSessions`, M6.3) gains `title` (`null` when none; developer ruling 2026-09-28): the conflict card and its "Move … to worktree" action name the session by its display title (the title, else `name`); the worktree and branch the action creates are still built from `name`.
- **SolutionBranch** (`Solution.branches`, M6.2) gains `ownerTitle` (developer ruling 2026-09-28): the owner session's display title (its title, else its name), `null` when no session owns the branch (`owner` is then a note such as `idle`). The Solutions branch chips and detail cards name the owner by it, else by `owner`, with the short name (`owner`) as the tooltip; `branch` and `worktree` stay the short name's.
- **The UI's use:** the New-session form posts both: `title` = the name field as typed (trimmed) and `name` = the short name derived from it (lower-case, runs of anything but letters and digits → `-`, at most 64 characters, `-2`, `-3`, … when taken); text that already is its own short name is posted as the title too (developer ruling 2026-09-28), only an empty field posts no title. With a terminal conversation picked, typed text goes as `ContinueConversation.title`. The session header (click) and a sidebar row (double-click) rename in place through `PUT /api/sessions/{id}/title`. Details: `docs/new-session.md` → *Name and title*, `docs/derivations.md` → *Session titles* → *In the UI*.

```json
Session           { …, "title": "JIRA Ticket handling" | null, "displayTitle": "JIRA Ticket handling" }
SessionTitleInput { "title": "JIRA Ticket handling" | null }
ContinueConversation { "name"?: "…", "title"?: "Lantern follow-up" | null, "addFolder"?: true, "confirm"?: true }
ConflictSession   { …, "title": "JIRA Ticket handling" | null }
SolutionBranch    { …, "owner": "jira-ticket-handling", "ownerTitle": "JIRA Ticket handling" | null }
```

## Agent overview (D21, 2026-09-28, additive)
Developer ruling D21 (`docs/decisions.md`): the right panel's agent overview repeats the newest status table the agent printed in the chat under its derived table. Additive; nothing above or below changes meaning. Details: `docs/derivations.md` → *Agent overview*, `docs/session-panel.md` → *Agent overview*.

- **SessionDetail** (`GET /api/sessions/{id}`) gains `reportedTable: ReportedTable | null`: the newest status table in the main conversation's agent messages (the messages the chat shows), searched in the whole stored chat, not only the detail's recent `events`; `null` when the agent printed none. `Session` (`GET /api/sessions`, `sessionUpdated`) does not carry it.
- No new `/hub` event: a new agent message is an `event` for the session, on which the session view already reloads the detail.
- The derived table (Agent · Description · Solution · Status) needs no field: the UI builds it from `Session.agents` and `Session.activity` (D19).

```json
ReportedTable { "text": "<the table's lines as printed>", "format": "box|gfm", "at": "ISO" }
```
A status table is a box-drawing table (┌ ─ ┬ ┐ │ ├ ┼ ┤ └ ┴ ┘; in a code fence or not) or a GFM pipe table (outside code fences) whose header row has an `Agent` cell and a `Status` cell (case-insensitive, trimmed). `text` = its lines as printed, with only their common indentation removed (a fenced box table without its fence lines); `at` = when the message holding it arrived (its event's `ts`); the last table of the newest message that has one wins.

## Remote Control (D24, 2026-09-28, additive)
Developer ruling D24 (`docs/decisions.md`): a session's live process can be made reachable from claude.ai and the phone through the CLI's Remote Control (the stdin `remote_control` control request, `docs/spike-remote.md` → R.6). Additive; the rows and payloads above keep their meaning. Details: `docs/remote-control.md`, migration `0007_session_remote.sql`.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| PUT | /api/sessions/{id}/remote | { enabled: boolean } | 200 Session (`sessionUpdated` is published) · 404 `not-found` · 422 `invalid` `{ errors: [{ field: "enabled" }] }` · 409 `not-live` (no live process, or it is being stopped) · 409 `remote-unavailable` (its `initialize` did not report `remote_control_available: true`) · 502 `remote-failed` `{ message }` = the CLI's error text, verbatim (also a reply without an `https://` `session_url`, no reply within 60 s, or a process that ended first) |

```json
Session            { …, "remote": { "available": true, "enabled": true, "url": "https://claude.ai/code/session_…" } | null }
SessionRemoteInput { "enabled": true }
Question           { …, "answeredOn": "claude.ai" | null }
HistoryItem        { …, "remoteControl"?: true }
```
- **Session.remote** (so also SessionDetail and `sessionUpdated`): `available` = the session has a live process whose `initialize` reported `remote_control_available: true` (the toggle is enabled only then); `enabled` = Remote is on (it stays on across a pause and restart recovery: every new process re-enables it with `reattach_session_id`, and a failed reattach turns it off); `url` = the last bridge's claude.ai link, kept after Remote is turned off. `null` for a session Switchboard never ran a process for (the demo's seeded sessions: no toggle). Optional in `src/core/api.ts` (like D22's `title`) so older fixtures type-check; the server always sends it.
- **Question.answeredOn**: `claude.ai` when the phone answered the batch first (the CLI withdrew the request with `control_cancel_request` while Remote was on); the batch is then `answered` without `answerIndex`, leaves the Inbox, and answering it is 409 `already-answered` ("… already answered on claude.ai"). `null` otherwise.
- **HistoryItem.remoteControl**: `true` on a terminal conversation whose transcript has a `{type:"bridge-session", …}` line (the "Remote Control" badge); absent otherwise.
- **SessionEvent.payload** gains the type `remote` (`{ action: "on" | "off" | "failed", reattach?, url?, enabled?, error? }`; the CLI's error text verbatim in `error` and the label), and `request` / `tool` payloads gain `answeredOn`.

## Remote sessions continue locally (D25, 2026-09-28, additive)
Developer ruling D25 (`docs/decisions.md` → *Remote sessions*): a remote session (claude.ai/code, or Remote Control on another machine) continues as a **local copy** that Switchboard supervises: a new clean worktree of a saved **repo** folder, `claude -p --teleport <session_X> …` there (the CLI checks the tree and the repo, fetches and checks out the session's branch, loads its history), then an ordinary session (`--resume <local id>` later). New work in the copy stays local. Additive; nothing above changes. Details: `docs/supervisor.md` → *Teleport*, `docs/new-session.md` → *From a remote session*.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | /api/sessions/teleport | TeleportSession | 201 Session · 422 `invalid` `{ errors }` (fields `remote`, `folder`, `title`, `task`) · 409 `folder-missing` / `no-commits` / `branch-exists` / `path-exists` / `git-failed` (the worktree could not be made) · 502 `teleport-failed` `{ message }` · 504 `teleport-timeout` `{ message }` · 503 `closing` |

- **TeleportSession** `{ remote, folder, title?, task? }`: `remote` is a claude.ai/code session URL (`https://claude.ai/code/session_<X>`; query string, fragment and a trailing `/` ignored), `session_<X>` or `cse_<X>` (the same session, `docs/spike-remote.md` → R.8; `<X>` = `[A-Za-z0-9_]+`), normalized to `session_<X>`; anything else is 422 on `remote`. `folder` is required: a saved **repo** folder's id (a workspace folder or an unknown id is 422 on `folder`: teleport needs a checkout of the session's GitHub repo). `title` follows D22 (1–80 characters once trimmed, else 422; omitted, `null` or blank = none). `task` is an optional first message, written to the local copy right after the spawn (blank = none: the copy stays idle).
- **Names:** the title is `title`, else `Remote <first 8 characters of X>`; the short name is derived from `title` (D22), else `remote-<first 8 characters of X, lower-cased>`; `-2`, `-3`, … when taken.
- **The local copy:** worktree `../{repo}-wt-{name}` on branch `session/{name}` from the repo's HEAD, then the teleport checks out the remote session's branch there; the worktree row (`Worktree.branch`) records the branch the teleport checked out. `claudeSessionId` is the id the CLI's `system/init` reported (never passed with `--session-id`). `workType`, `mode`, `phase`, `coordination` are `null`, `worktrees` true, `ultracode` false, `solutions` the repo.
- **Refusals:** when `claude` exits before its `system/init` (a dirty tree, the wrong repo, a branch that is not pushed, not signed in, an archived session, …) the answer is 502 `{ error: "teleport-failed", message }` with the CLI's text **verbatim** (its stderr, else the non-JSON lines it printed); with no `system/init` in time (120 s) the process is stopped and the answer is 504 `teleport-timeout`. Either way nothing is left: no session, and the worktree and `session/{name}` branch Switchboard made are removed (`git worktree remove`, `git branch -d`; if git keeps the worktree, the message says so). Nothing is retried.
- **Session / SessionDetail** (and `sessionUpdated`) gain `remoteSource`: the remote session (`session_<X>`) a local copy came from, `null` for every other session. A teleport that has not reported `system/init` yet is neither listed by `GET /api/sessions` nor announced on `/hub`; it is announced (`sessionUpdated`) once it has started.
- **HistoryItem:** a local copy's `mode` is `remote · local copy`.
- **SessionEvent:** a local copy starts with a lifecycle event `teleported` (`message` = the remote session); the remote history is imported from the local copy's transcript as the chat's first messages, prompts as `user` events with the new origin `remote`.

```json
TeleportSession   { "remote": "https://claude.ai/code/session_011CU…", "folder": "<repo folder id>", "title"?: "Cloud health work" | null, "task"?: "Run the tests." }
TeleportRefusal   { "error": "teleport-failed" | "teleport-timeout", "message": "You must run claude --teleport session_011CU… from a checkout of acme/app" }
Session           { …, "remoteSource": "session_011CU…" | null }
```

## Signed-in sites in a frame (D28, 2026-09-28, additive)
Developer ruling D28 (`docs/decisions.md`): a tool whose URL is a non-loopback `https:` site (e.g. Jira) is framed directly with the Switchboard frame helper extension, not through a D15 proxy. Additive; the rows above keep their meaning. Details: `docs/frame-helper.md`, `docs/tools.md` → *Signed-in sites*.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | /api/frame-helper/check | – | 200 `text/html`: a page with `X-Frame-Options: DENY` and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (its `<html>` has `data-sb-frame-check="ok"`); the UI frames it to learn whether the frame helper removes those headers in this browser |

- **Tool.frameUrl** is also `null` for a signed-in site (no proxy runs for it). The probe is unchanged.

## Model and effort (D31, 2026-09-28, additive)
Developer ruling D31 (`docs/decisions.md` → *Background work and live model choice*): the session header's model and effort pickers. The choices come from the CLI (the models its `initialize` reports, the effort levels the chosen model supports); a change goes to a live process through the control protocol (`set_model`, `apply_flag_settings {effortLevel}`, probed on CLI 2.1.283) and is stored on the session, and every later spawn passes `--model` / `--effort`. Additive; the rows and payloads above keep their meaning. Details: `docs/model-effort.md`, migration `0009_session_model.sql`.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| PUT | /api/sessions/{id}/model | SessionModelInput | 200 Session (`sessionUpdated` is published) · 404 `not-found` · 422 `invalid` `{ errors: [{ field: "model" \| "effort", message }] }` (the body; a model the session's list does not offer; an effort the chosen model does not support; with no list reported: not a model name / not one of `low, medium, high, xhigh, max`) · 502 `model-failed` `{ message }` = the CLI's error text, verbatim (or no reply within 30 s) · 503 `closing` |

```json
SessionModelInput { "model"?: "opus" | "default" | null, "effort"?: "high" | null }
Session           { …, "model": { "current": "opus" | null, "effort": "high" | null, "available": [ { "value": "opus", "label": "Opus 5.5", "description"?: "Most capable for ambitious work", "efforts"?: ["low", "medium", "high", "xhigh", "max"] } ] | null } | null }
```
- **SessionModelInput:** a field left out keeps the stored value; `null`, blank or (model) `"default"` goes back to the CLI's default. At least one field. A live process gets `set_model` when the model changes and `apply_flag_settings {effortLevel}` when the effort does (each reply awaited); without one the choice is only stored and the next spawn passes it. A choice equal to the stored one does nothing. On a 502 nothing is stored, except a model the CLI took before it refused the effort.
- **Session.model** (so also SessionDetail and `sessionUpdated`): `current` / `effort` = the stored choice (`null` = the CLI's default; no `--model` / `--effort`); `available` = the models the session's last claude process reported in its `initialize` reply (kept after it ends; `null` until one did; the pickers are disabled then). `null` for a session with no model information at all (Switchboard never ran a process for it and nothing is stored: the demo's seeded sessions show no pickers). Optional in `src/core/api.ts` (like D22's `title`) so older fixtures type-check; the server always sends it.
- **SessionEvent.payload** gains the type `model` (`{ action: "changed" | "failed", model, effort, live?, request?, error? }`): a change is a `text` event labelled `Model: <the CLI's displayName> · effort: <level | default>`; a refusal an `error` event `Could not change the model: <text>` / `Could not change the effort: <text>` (the CLI's text verbatim in `error` and the label).

## Ticket branches (D32, 2026-09-28, additive)
Developer ruling D32 (`docs/decisions.md` → *Ticket branches and closing sessions*): whenever the developer creates a git worktree, its branch is named after the ticket instead of `session/{name}`: the Jira-style key, its number and a kebab-case description, `^[A-Z][A-Z0-9]*-[0-9]+-[a-z0-9]+(-[a-z0-9]+)*$` (e.g. `PROJ-0001-test-branch-name`), no prefix. Additive fields; the rows above keep their meaning. Details: `docs/worktrees.md` → *Ticket branches (D32)*, `docs/new-session.md` → *Ticket branch (D32)*, `docs/solutions.md` → *Conflicts*.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | /api/sessions | NewSession (+ `branch`) | 201 Session · 422 `invalid` `{ errors: [{ field: "branch" }] }` (with `worktrees: true`: missing, or not a ticket branch) · 409 `branch-exists` `{ message: "<repo> already has a branch <branch>" }` |
| POST | /api/solutions/{repo}/isolate | IsolateRequest `{ sessionId, branch }` | 201 / 200 Worktree · 422 `invalid` `{ errors: [{ field: "sessionId" \| "branch" }] }` · 409 `branch-exists` (nothing is created or paused) · the other refusals as before (D60: `{ sessionId, existingBranch }` instead, see *Move to worktree on an existing branch (D60)*) |

- **NewSession** (and the repo folder's `NewRepoSession`) gains `branch`: **required with `worktrees: true`**, a ticket branch once trimmed (never tidied by the server); the 422 messages: `name the branch after its ticket: the key, its number and a short description, e.g. PROJ-0001-short-description` (missing or blank) and `the branch must be a ticket key, its number and a short kebab-case description, e.g. PROJ-0001-short-description`. The worktree of every solution in scope is created on it (a workspace session: the same branch in each repo); a repo that has it already is 409 `branch-exists` and nothing is created. Without a worktree `branch` is not read. The worktree folders keep `../{repo}-wt-{name}`.
- **IsolateRequest** (`POST /api/solutions/{repo}/isolate`, "Move … to worktree"): the contract's `{ sessionId }` gains the required `branch`, same rule and messages. A session that already has a worktree for the repo still gets it back unchanged (200). 2026-10-14 (additive): a closed session, or one taken over to another machine (D65), is refused with 409 `closed` before anything is created.
- **Unchanged:** scheduled runs (a schedule's template carries no `branch`; one sent is dropped when it is saved) keep `session/{run name}`; teleports (`POST /api/sessions/teleport`, D25) keep `session/{name}` before the CLI checks out the remote branch.
- **Worktree.branch**, `SolutionBranch.branch`, `FileDiff.branch`, the answers block and the repo worktree note of the first message, and the "PR merged" item name the worktree's real branch (the stored one), so they show the ticket branch without new fields.

```json
NewSession     { …, "worktrees": true, "branch": "PROJ-0001-test-branch-name" }
IsolateRequest { "sessionId": "…", "branch": "PROJ-0001-test-branch-name" }
```

## Closing sessions (D33, 2026-09-28, additive)
Developer ruling D33 (`docs/decisions.md` → *Ticket branches and closing sessions*): a session can be closed out of the sidebar and the session header and reopened from History. Additive; the rows and payloads above keep their meaning. Details: `docs/supervisor.md` → *Close and reopen*, migration `0010_session_closed.sql`.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | /api/sessions | ?closed=exclude\|include | Session[]: open sessions only by default (`exclude`); `include` = every session, closed ones too · 422 `invalid` `{ errors: [{ field: "closed" }] }` for another value |
| POST | /api/sessions/{id}/close | { confirm?: boolean } (or no body) | 200 Session with `closedAt` (`sessionUpdated` is published) · 409 `close-needs-confirm` `{ message }` · 422 `invalid` `{ errors: [{ field: "confirm" }] }` · 404 `not-found` · 503 `closing` |
| POST | /api/sessions/{id}/reopen | – | 200 Session with `closedAt: null` (`sessionUpdated` is published) · 404 `not-found` · 503 `closing` |

- **Close:** a session whose process is live, or whose status is `run` / `need` (running or waiting for the developer), needs `confirm: true`; without it the answer is 409 `close-needs-confirm` with a message, and nothing changes. With it the process is stopped the way Pause stops it (the conversation stays resumable; status `paused`), then `closedAt` is set. The session's question batches that still wait (open, or stale and unanswered) are closed without answers with the label `session closed` (they become `stale` with `closedReason`), and its open permission requests go stale: both leave the Inbox (`inboxChanged`). Worktrees and branches are kept. Idempotent: closing a closed session answers 200 with it unchanged.
- **While closed:** `POST …/messages`, `/resume` and `/attach` answer 409 `closed` ("the session <title> is closed: reopen it from History first"). `GET /api/sessions/{id}` still answers. Restart recovery never resumes a closed session; scheduled runs are unaffected.
- **Reopen:** clears `closedAt`; no process starts, the session stays as it was closed (paused / idle / ended), and its next message resumes it with `--resume` as usual. Idempotent. Questions closed with the session stay closed.
- **Session / SessionDetail** (and `sessionUpdated`) gain `closedAt` (ISO, `null` while open). Optional in `src/core/api.ts` (like D22's `title`) so older fixtures type-check; the server always sends it. No new `/hub` event: close and reopen publish `sessionUpdated`, on which the sidebar reloads its (open) list.
- **Question** gains `closedReason` (`session closed` for a batch closed with its session, else `null`); answering such a batch is 409 `not-open` ("question batch <id> was closed (session closed)").
- **HistoryItem** gains `closedAt` on a stored session's row (`null` while open; absent on a terminal conversation's row): History lists closed sessions next to the others, with a "Closed" tag and Reopen; its search matches "closed".
- **SessionEvent.payload:** the lifecycle actions `closed` and `reopened`.

```json
SessionCloseInput { "confirm"?: true }
CloseRefusal      { "error": "close-needs-confirm", "message": "checkout-page-640 is running: closing it stops its process (the conversation stays resumable). Confirm to stop and close it." }
Session           { …, "closedAt": "2026-09-28T18:40:00.000Z" | null }
Question          { …, "closedReason": "session closed" | null }
HistoryItem       { …, "closedAt"?: "2026-09-28T18:40:00.000Z" | null }
```

## Guided frame-helper setup (D35, 2026-09-28, additive)
Developer ruling D35 (`docs/decisions.md` → *Frame helper: guided setup*; no Chrome Web Store): Settings → Embedded tools → Frame helper and a site tool's "needs the Switchboard frame helper" page walk the developer through loading the D28 helper unpacked; the service runs the OS openers a page cannot. Additive; the rows above keep their meaning. Details: `docs/frame-helper.md` → *Guided setup (D35)*.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | /api/frame-helper | – | 200 FrameHelperInfo |
| POST | /api/frame-helper/reveal | – (a body or query is ignored) | 204 once the OS file manager was started on the helper's folder · 502 `open-failed` `{ message }` = the opener's error · 501 `not-implemented` (`item: "D35"`) without an opener |
| POST | /api/frame-helper/open-extensions | – (a body or query is ignored) | 204 once Chrome was started on `chrome://extensions` · 502 `open-failed` `{ message }` (the UI then says to type chrome://extensions in the address bar) · 501 as above |

- **FrameHelperInfo:** `path` = the absolute path of `tools/frame-helper` in the checkout the service runs from (the OS's form), `version` = its `manifest.json` version, read on every request.
- **The commands** are fixed argv built by the service, spawned detached with `shell: false`, never from request input: reveal = macOS `open -R <path>/manifest.json`, Windows `explorer /select, <path>\manifest.json`, else `xdg-open <path>`; open-extensions = macOS `open -a "Google Chrome" chrome://extensions`, Windows each existing `chrome.exe` of the usual install paths then `cmd /c start "" chrome chrome://extensions`, else `google-chrome` then `chromium` (the next one after a failure). `SWITCHBOARD_OPEN_COMMAND` (an argv prefix) replaces them with a fake in tests.
- Behind the `sb_token` cookie and the Host/Origin guard like every route.

```json
FrameHelperInfo      { "path": "/Users/dev/switchboard/tools/frame-helper", "version": "2.0.0" }
FrameHelperOpenError { "error": "open-failed", "message": "open -a Google Chrome chrome://extensions: Unable to find application named 'Google Chrome'" }
```

## Subagent chats (D36, 2026-09-28, additive)
Developer ruling D36 (`docs/decisions.md` → *Subagent chats*): a subagent's own conversation opens from the chat. Additive; nothing above or below changes meaning. Details: `docs/chat.md` → *Subagent chats*.

- **Agent** (in `Session.agents`, `SessionDetail.agents` and `sessionUpdated`) gains `toolUseId`: the id of the Agent / Task `tool_use` that started the subagent (the main agent's call event has it as `payload.toolUseId`; the subagent's own lines carry it as `parent_tool_use_id`); `null` for the main agent and for agents no call was seen for. Optional in `src/core/api.ts` so older fixtures type-check; the server always sends it.
- **No events filter:** `GET /api/sessions/{id}/events` already returns every event of the session (it does not page), with each event's `agentId`, so the UI filters a subagent's events itself. No new route, query or `/hub` event. D95: it now pages on request, and `?agent=` reads one subagent's events (*Paged events (D95)*).
- The UI address `/sessions/{id}/agents/{agentId}` is a page of the app (the server answers it with `index.html`, like every non-file GET), not an API route.

```json
Agent { …, "toolUseId": "toolu_01E5QUrP9sKnU8eg6FiNuCbb" | null }
```

## Own answers (D39, 2026-09-29, additive)
Developer ruling D39 (`docs/decisions.md` → *Own answers*): a question can be answered with the developer's own words ("Other…"), as Claude Code's own "Other" does: the CLI receives the typed text as the answer string. Additive; the row above keeps its meaning for option answers. Details: `docs/questions.md` → *Own answers (D39)*. No migration: the stored answer label holds the text.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | /api/questions/batch/{batchId}/answers | `{ answers: [{ questionId, answerIndex } \| { questionId, text }] }` | 204 · 400 `invalid` as before (not every question has exactly one entry, an unknown question, an `answerIndex` that is not one of its options) · 422 `invalid` `{ message, errors: [{ questionId, field: "text" \| "answer", message }] }` (every refused entry: `answer` = both or neither of `answerIndex` / `text` given; `text` = not text of 1–2000 characters once trimmed) · the other answers as before |

- **An answer entry** carries exactly one of `answerIndex` (an option) and `text` (the developer's own words); a `null` value counts as not given. `text` is trimmed; inner line breaks stay.
- **What the CLI gets:** `updatedInput.answers[<question text>]` = the trimmed text, verbatim, where an option answer has the option's label. A `multiSelect` question still takes one answer (M3.1), so its own answer is its whole answer string. Two questions with the same text keep the existing join (their distinct answers, `", "`). A stale batch's answers message lists the text in place of the label.
- **Question** gains `answerText`: the own answer as sent (trimmed), with `answerIndex` `null`; `null` for an option answer and while unanswered. Optional in `src/core/api.ts` (like D24's `answeredOn`) so older fixtures type-check; the server always sends it (`/hub` `questionBatch`, `GET /api/inbox`, `SessionDetail.questions`).

```json
AnswerBatch   { "answers": [{ "questionId": "q1", "answerIndex": 2 }, { "questionId": "q2", "text": "Medium, with rounded corners" }] }
AnswerRefusal { "error": "invalid", "message": "question q2: an own answer must be text of 1–2000 characters", "errors": [{ "questionId": "q2", "field": "text", "message": "question q2: an own answer must be text of 1–2000 characters" }] }
Question      { …, "answerIndex": null, "answerText": "Medium, with rounded corners" | null }
```

## Multi-select answers (D128, 2026-10-23, additive)
Developer request D128 (`docs/decisions.md` → *Multi-select answers*): a `multiSelect` question takes one or more options, plus optionally the developer's own words alongside them. Additive; the shapes above keep their meaning, also on a multi-select question. Details: `docs/questions.md` → *Multi-select answers (D128)*. Migration `0049_question_multi_answers.sql`.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | /api/questions/batch/{batchId}/answers | `{ answers: [{ questionId, answerIndex } \| { questionId, text } \| { questionId, answerIndexes, text? }] }` | 204 · 400 `invalid` as before, and for `answerIndexes` that is not a list of option indexes of its question · 422 `invalid` as before, plus `field: "answerIndexes"` (on a single-select question; a repeated option; no choice at all: `[]` without `text`) and `field: "answer"` (`answerIndex` next to `answerIndexes`) · the other answers as before |

- **A multi-select entry** `{ questionId, answerIndexes, text? }`: unique option indexes in any order, and optionally an own `text` (D39's rule: 1–2000 characters once trimmed). At least one choice in all. A `null` `answerIndexes` / `text` counts as not given. The single shapes still answer a multi-select question (one option, or own words alone) and are stored and sent as the same multi-select answer.
- **What the CLI gets:** one string per question, as before: the picked labels in option order, then the own text, joined with `", "`, an item that contains `", "` or `"` written as a quoted JSON string (the CLI's own multi-select join; VERIFIED in the CLI 2.1.303 bundle, `docs/questions.md`). A stale batch's answers message has that string in place of the label.
- **Question** gains `answerIndexes: number[] | null`: a multi-select answer's picks, ascending (`[]` when only own words were given); `null` for a single-select question, while unanswered and for answers stored before D128. For a multi-select answer `answerIndex` is the first pick (or `null`) so older clients still show one, and `answerText` is the own words given alongside (or `null`). Optional in `src/core/api.ts`; the server always sends it.
- **Peers and devices:** same route, only the body grew; the peer API and the device allow-lists already pass it, and a paired machine's question is answered there with the body as sent. A paired machine before D128 refuses `answerIndexes` (422, both or neither); the card therefore sends the single shapes when one option alone, or own words alone, are picked.

```json
AnswerBatch   { "answers": [{ "questionId": "q1", "answerIndexes": [1, 2], "text": "the changelog" }] }
answers       { "Which parts should I update?": "Tests, Docs, the changelog" }
Question      { …, "multiSelect": true, "answerIndex": 1, "answerIndexes": [1, 2], "answerText": "the changelog" }
```

## Collapsible panes (D41, 2026-09-29, additive)
Developer ruling D41 (`docs/decisions.md` → *Collapsible panes*): the sidebar and the session view's right panel slide out and back in on request, and the choice is kept by the service, per install. Additive; no new route or `/hub` event, and the rows above keep their meaning. Details: `docs/panes.md`, `docs/settings.md`.

- **Settings** (`GET/PUT /api/settings`) gains two editable keys: `ui.sidebarHidden` and `ui.rightPanelHidden`, booleans, default `false` (both panes shown). `PUT` takes either or both like any editable key (a value that is not a boolean → 422 `invalid` on that key; nothing stored); `GET` always returns both (a stored value of the wrong type reads as `false`).
- The right panel's value applies to every session. Other open pages read the stored state on their next load (no live event).

```json
Settings { …, "ui.sidebarHidden": false, "ui.rightPanelHidden": true }
```

## Collapsible TOOLS (D101, 2026-10-14, additive)
- **Settings** (`GET/PUT /api/settings`) gains the editable key `ui.toolsCollapsed`, boolean, default `false` (the sidebar's TOOLS section expanded). Like D41's keys: a value that is not a boolean → 422 `invalid`; `GET` always returns it (a stored value of the wrong type reads as `false`). Per install; not sent to paired machines. No new route or `/hub` event.

## Collapsible SESSIONS and CHATS (D106, 2026-10-14, additive)
- **Settings** (`GET/PUT /api/settings`) gains the editable keys `ui.sessionsCollapsed` and `ui.chatsCollapsed`, booleans, default `false` (the sidebar's SESSIONS / CHATS sections expanded), exactly like D101's `ui.toolsCollapsed`: a value that is not a boolean → 422 on that field; per install, not synced with paired machines.

## Solutions chosen by the agent (D38, 2026-09-29, additive)
Developer ruling D38 (`docs/decisions.md` → *Solutions chosen by the agent*): a workspace session can start without picked solutions; the agent determines them. Additive: an empty list is now allowed; the rows and payloads above keep their meaning. Details: `docs/new-session.md` → *Solutions chosen by the agent (D38)*, `docs/worktrees.md` → *Adopted worktrees (D38)*, `docs/derivations.md` → *Session solutions (D38)*.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | /api/sessions | NewSession with `solutions: []` (or without `solutions`) for a **workspace** folder | 201 Session with `solutions: []` · the other validation is unchanged (a non-empty list: every name non-empty, not twice, never read-only, else 422 on `solutions`; a `solutions` that is not a list is 422 "solutions must be a list of solution names") |

- **NewSession.solutions** may be empty or omitted for a workspace folder (it was "not empty", 422 "choose at least one solution"). A repo folder is unchanged (its repo is the one solution). A schedule's template follows the same rule (`POST /api/schedules`).
- **No worktree up front:** with `worktrees: true` and no solutions nothing is created (the D32 `branch` is still required and validated); the first message tells the agent to create one worktree per solution it changes on that branch at `<repo>-wt-<name>` (scheduled runs: `session/{run name}`). Switchboard **adopts** each such worktree when it appears (after a main-agent `git worktree add`, and on a sweep at each turn's end): it becomes a normal `Worktree` of the session (`sessionId` set; Diff, PR checks, removal and the Solutions chips as before). No new route.
- **Session.solutions** (so also SessionDetail, `sessionUpdated`, `ConflictSession`s and the Solutions view) starts empty and **fills in** with every solution an agent of the session writes into or Switchboard adopts a worktree in, in the order they appear; each change is stored and published as `sessionUpdated` (no new `/hub` event). This applies to every workspace session, so one that picked solutions gains the others it writes into.
- The session's worktree branch is stored (`sessions.branch`, migration `0011_session_branch.sql`); it is not on the wire.

```json
NewSession { "name": "proj-38-agent-worktree", "title": "PROJ-38 Agent worktree", "task": "…", "workType": "feature", "mode": "single", "solutions": [], "phase": "ui-first", "coordination": null, "qa": null, "worktrees": true, "ultracode": false, "branch": "PROJ-38-agent-worktree" }
Session    { …, "solutions": [] }  →  sessionUpdated { …, "solutions": ["acme-web-front"] }
```

## Epic/task branching (D40, 2026-09-29, additive)
Developer ruling D40 (`docs/decisions.md` → *Epic/task branching*): the New-session form supports the epic/task branching model, created lazily. Additive: the rows and payloads above keep their meaning, except that a new session **reuses** an existing task branch instead of D32's 409 `branch-exists`. Details: `docs/new-session.md` → *Branching (D40)*, `docs/worktrees.md` → *Epic/task branching (D40)*, migration `0012_session_branching.sql`.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | /api/branching/preflight | BranchingPreflightRequest | 200 BranchingPreflight · 422 `invalid` `{ errors: [{ field: "solutions" \| "epicBranch" \| "base" \| "bases" }] }` · 422 / 409 `no-folder` / `folder-missing` for the folder, as for NewSession |
| POST | /api/sessions | NewSession / NewRepoSession (+ `branching`) | 201 Session · 422 `invalid` on `branching`, `branching.epic`, `branching.epic.key`, `branching.epic.summary`, `branching.epic.branch`, `branching.base`, `branching.dropped`, `branching.bases` · 409 `fetch-failed` / `base-missing` / `branch-checked-out` `{ message }` (nothing created) |

- **BranchingPreflightRequest:** `folder` (a saved folder's id; default when omitted), `solutions` (at most 40; a repo folder checks its repo whatever is sent; empty = `{ rows: [] }`), `epicBranch` (omitted / blank = no epic: the rows check the origin default branch), `base` (default `dev`), `taskBranch` (not checked when not a valid branch name), `bases` (solution → base). Each repo with an `origin` remote is fetched (`git fetch origin --prune`, bounded) and read; nothing is created or pushed.
- **BranchingPreflightRow:** `solution`, `repoPath` (`null` when not a git repo), `error` (`no origin remote: the worktree starts from the repo's current HEAD`, `git fetch origin failed: …`, a resolution message; `null` when checked), `base` + `baseSource` (`override` / `epic` / `default`) + `baseExists`, `epic` `{ branch, exists, behind }` (`behind` = `git rev-list --count origin/<epic>..origin/<base>`), `task` `{ branch, exists, local }`, `cutFrom` (`origin/<epic>` when on origin, else `origin/<base>` when present, else `null`). Unknown values are `null`.
- **NewSession.branching** (and NewRepoSession's), read only with `worktrees: true` under the ticket rule (never for scheduled runs, which keep `session/{name}`): `{ epic?: { key, summary?, branch? } | null, base?, bases?, dropped? }`. `key` a ticket key (`PROJ-3010`); `summary` text ≤ 255; `branch` a valid git branch name, blank = `feature/<KEY>-<Summary>` derived; `base` a valid branch name, blank = `dev` (not the epic branch itself); `dropped` solutions in scope, never all of them, never a repo folder's repo; `bases` solution in scope (not dropped) → valid branch name. Omitted or `null` = a task without an epic.
- **At Start**, per repo: `git fetch origin`, then the task worktree is cut from `origin/<epic>` when on origin, else `origin/<base>` (the override when set); without an epic from the origin default branch (`origin/HEAD`); never a local branch. An existing task branch is reused (the local one, else tracking `origin/<task>`). A repo without `origin` is cut from its HEAD as before. Dropped repos get no worktree and leave `Session.solutions`. The epic branch is never created and nothing is pushed. The branching is stored (`sessions.branching`), not on the wire.
- **Worktree.branch / base:** `base_ref` of a task worktree is `origin/<cut point>`; the first message's answers block gains the Branching lines (`docs/new-session.md` → *First-turn payload*).

```json
BranchingPreflightRequest { "folder": "f1", "solutions": ["alpha-front", "beta-front"], "epicBranch": "feature/PROJ-3010-Platform-tracking", "base": "dev", "taskBranch": "PROJ-3011-kpi-dashboard", "bases": {} }
BranchingPreflight        { "rows": [ { "solution": "alpha-front", "repoPath": "/w/microfrontends/alpha-front", "error": null, "base": "dev", "baseSource": "epic", "baseExists": true, "epic": { "branch": "feature/PROJ-3010-Platform-tracking", "exists": true, "behind": 2 }, "task": { "branch": "PROJ-3011-kpi-dashboard", "exists": false, "local": false }, "cutFrom": "origin/feature/PROJ-3010-Platform-tracking" } ] }
NewSession                { …, "worktrees": true, "branch": "PROJ-3011-kpi-dashboard", "branching": { "epic": { "key": "PROJ-3010", "summary": "Platform tracking", "branch": "feature/PROJ-3010-Platform-tracking" }, "base": "dev", "bases": { "mobile": "main" }, "dropped": ["beta-front"] } }
```

## Stacked task branches (D47, 2026-09-29, additive)
Developer ruling D47 (`docs/decisions.md` → *Stacked task branches*): a task branch can be stacked on an earlier, unmerged task branch (its **parent**). Additive: the rows and payloads above keep their meaning; a body without `parent` is D40 exactly. Details: `docs/new-session.md` → *Parent (D47)*, `docs/worktrees.md` → *Stacked task branches (D47)*, migration `0013_worktree_parent.sql`.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | /api/branching/preflight | BranchingPreflightRequest + `parent?` | 200 BranchingPreflight (rows + `parent`, `prTarget`) · 422 `invalid` also on field `parent` |
| POST | /api/sessions | NewSession / NewRepoSession with `branching.parent?` | 201 Session · 422 `invalid` also on `branching.parent` · 409 `parent-ambiguous` `{ message }` (a key naming several origin branches in a repo; nothing created) |

- **parent** (`BranchingPreflightRequest.parent`, `NewSessionBranching.parent`): a task key (`PROJ-3013`, any case) or a full branch name (a valid git branch name; a leading `origin/` is dropped); omitted, `null` or blank = the epic branch (not stacked). A key resolves per repo to the origin branch whose name starts with `<KEY>-` (the task branch left out). Refused: not a key nor a valid name, the task branch itself or its key, the epic's base. The epic branch itself = not stacked. Also read without an epic.
- **BranchingPreflightRow.parent** (`null` when not stacked or the row has an `error`): `{ typed, branch, matches, error, pr, noPr, prError }`: `branch` = the origin branch it resolves to here (`null` = not in this repo, or several matched: `error`); `pr` `{ number, state, url, baseRefName }` from `gh pr view <branch> --json number,state,url,baseRefName,headRefOid` (asked only where the parent is on origin), `noPr` when gh says there is none, `prError` when gh failed. **prTarget** (every row without `error`): where the task's PR would go: the parent, else the epic branch (even while it is not on origin), else the branch cut from; `null` when nothing can be cut. **cutFrom** is `origin/<parent>` where the parent is found. The fetch is `git fetch origin --prune`.
- **At Start**, per repo: `git fetch origin --prune`; the parent on origin → cut from `origin/<parent>` (the worktree's `base_ref`), else D40's cut point; a merged / closed parent is not refused. Nothing is created on origin or pushed. The parent is stored in `sessions.branching` (not on the wire), the per-repo parent and its PR on the worktree row.
- **Parent merged:** the PR poll also checks each stacked worktree's parent; once it is `MERGED`, the Inbox gets a system item (kind `parent-merged`, title `Parent <parent> merged — retarget and rebase <task>`, action `dismiss`, the usual `inboxChanged`), and the session (unless closed) gets a service message asking the agent to retarget its PR (`gh pr edit <task> --base <parent's base>`) and rebase (`git rebase --onto origin/<base> <old parent tip> <task>` after a squash merge, else a normal rebase), then report. Once per worktree. No new route or `/hub` event. Ruling D47-closed-parent: a parent PR that turns `CLOSED` without a merge raises an Inbox item instead (kind `parent-closed`, title `Parent <parent> closed — retarget <task> to <epic or default branch>`, `dismiss`), once per worktree, with no session message.

```json
BranchingPreflightRequest { "folder": "f1", "solutions": ["alpha-front", "gamma-front"], "epicBranch": "feature/PROJ-3010-Platform", "base": "dev", "taskBranch": "PROJ-3014-kpi-events", "parent": "PROJ-3013" }
BranchingPreflightRow     { …, "cutFrom": "origin/PROJ-3013-cookie-banner", "prTarget": "PROJ-3013-cookie-banner",
                            "parent": { "typed": "PROJ-3013", "branch": "PROJ-3013-cookie-banner", "matches": ["PROJ-3013-cookie-banner"], "error": null,
                                        "pr": { "number": 306, "state": "OPEN", "url": "https://github.com/o/r/pull/306", "baseRefName": "feature/PROJ-3010-Platform" }, "noPr": false, "prError": null } }
NewSession                { …, "branch": "PROJ-3014-kpi-events", "branching": { "epic": { "key": "PROJ-3010", "summary": "Platform" }, "base": "dev", "parent": "PROJ-3013" } }
```

## Model at session start (D42, 2026-09-29, additive)
Developer ruling D42 (`docs/decisions.md` → *Model at session start, remembered*): the New-session form picks the model and effort a session starts with, and the service remembers the last choice. Additive; the rows and payloads above keep their meaning. Details: `docs/model-effort.md` → *At session start (D42)*, `docs/new-session.md` → *Model (D42)*. No migration: both settings are rows of the existing `settings` table.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | /api/models | — | ModelSettings `{ options, last }` |
| POST | /api/sessions | NewSession with `model?` / `effort?` (also NewRepoSession and a schedule's `template`) | 201 Session (its `model.current` / `effort` set) · 422 `invalid` on `model` / `effort`: not text of at most 100 characters or null; with a reported list, a model it does not offer or an effort the chosen model does not support (a model without levels takes none); without one, not a model name / not one of `low, medium, high, xhigh, max` |

```json
NewSession    { …, "model": "opus" | "default" | null, "effort": "high" | null }
ModelSettings { "options": [ { "value": "opus", "label": "Opus 5.5", "description"?: "…", "efforts"?: ["low", "medium", "high", "xhigh", "max"] } ] | null,
                "last": { "model": "opus" | null, "effort": "high" | null } | null }
```
- **NewSession.model / effort:** omitted = the CLI's defaults, as before; `null`, blank or (model) `"default"` = the default too. The choice is stored on the session, so its first spawn (and, D31, every later one) passes `--model` / `--effort`.
- **ModelSettings.options:** the latest model list any claude process reported in its `initialize` reply (`SessionModelOption[]`, D31's shape), replaced by each later report; `null` until one did. **last:** the last model and effort the developer chose: written by a `POST /api/sessions` that names `model` or `effort`, and by every choice `PUT /api/sessions/{id}/model` stores; `null` until then. Scheduled runs never change it. Neither is in `GET /api/settings`, and `PUT /api/settings` does not take them.
- **Schedules:** `POST /api/schedules`' template carries `model` / `effort` like any other field (checked the same way); each run starts with them.

## Queued messages (D44, 2026-09-29, additive)
Developer ruling D44 (`docs/decisions.md` → *Queued messages*): the developer's own messages show a clock while the agent has not taken them up. No new route or event name, no migration: the state rides on existing payloads, and its changes go out on the existing `/hub` events. Details: `docs/derivations.md` → *Queued messages (D44)*, `docs/chat.md` → *Queued messages*.

- **SessionEvent.payload** of type `user` gains `queued: "turn" | "resume"`, present while the message waits and absent once the CLI took it up (and on every message that never waited): `turn` = written while a turn ran (or behind messages still waiting), `resume` = sent to a session with no live process, which it resumed. When it goes, the event is re-sent on `/hub` `event` (same id, the payload without `queued`), as for a merged text or a closed tool call; `delivered` still flips with the CLI's replay.
- **Question** gains `queued: "resume" | null`: `resume` while its batch's answers wait in the session's outbox (a stale batch answered while the session had no live process), `null` once they were written and for every other batch. Optional in `src/core/api.ts` so older fixtures type-check; the server always sends it (`/hub` `questionBatch`, `GET /api/inbox`, `SessionDetail.questions`). When the outbox is written, `sessionUpdated` is published for the session.

```json
Event    { …, "payload": { "type": "user", "text": "Keep it short.", "origin": "user", "delivered": false, "queued": "turn" } }
Question { …, "state": "stale", "answeredAt": "2026-09-29T10:00:00.000Z", "queued": "resume" | null }
```

## Switchboard peers (D48, 2026-09-29, additive)
Developer ruling D48 (`docs/decisions.md` → *Switchboard peers*; design and limits `docs/peers.md`). Every change is additive; no existing route, field or event changes shape.

- **Machines (Settings → Machines):** `GET /api/machines` → `{ self: { id, name }, listener: PeerListenerState, machines: Machine[] }`; `PUT /api/machines/self` `{ name }`; `PUT /api/machines/listener` `{ enabled?, address?, port? }` → PeerListenerState (422 `invalid`); `POST /api/machines/pairing-code` → `{ code, expiresAt }`; `POST /api/machines` `{ address, code }` → 201 Machine (422 `invalid`, 409 `pairing-refused`, 502 `peer-unreachable` / `pairing-failed`); `PUT /api/machines/{id}` `{ name }` → Machine; `DELETE /api/machines/{id}` → 204 (404). Types in `src/core/peers.ts`.
- **A machine's peer API through this service:** `GET/POST/PUT/DELETE /api/machines/{id}/api/<path>` → that machine's `/api/<path>` (its allow-list, `docs/peers.md` → *The peer API*), answers namespaced; 403 `peer-forbidden` for a route it does not serve, 404 `not-found` for an unknown machine, 502 `peer-unreachable` / `peer-auth-failed`.
- **Remote ids:** a paired machine's session, question batch and Inbox item ids read `r~<machine id>~<its id>`. Every existing route that takes `{id}` or `{batchId}` accepts them and is answered by that machine (same statuses and bodies; plus the 404 / 502 / 403 above).
- **Session** and **InboxItem** gain `machine: { id, name, state: "online" | "offline" | "auth-failed" | "no-address" } | null`: set on a paired machine's session or item, `null` (sessions) / absent (items) on this machine's own. `GET /api/sessions` lists this machine's sessions, then the paired machines' open ones; `GET /api/inbox` this machine's items, then the reachable machines' ones.
- **New session on a peer (P3):** `POST /api/sessions` takes an additive `machine` (a paired machine's id): the session starts there (its folder ids, its validation) and the 201 answer carries its remote id; `machine` naming this machine, or empty, starts here. The form uses `/api/machines/{id}/api/folders`, `…/models`, `…/solutions`, `…/branching/preflight` and `…/sessions`.
- **Hooked terminal sessions (P4):** `GET /api/terminal-sessions` → TerminalSession[] (502 `agents-unavailable`); `POST /api/terminal-sessions/{id}/hook` → 201 Session (a new hooked session) / 200 (it was hooked before; 404, 409 `already-in-switchboard`); `GET /api/hooks` → HooksStatus; `POST /api/hooks/install` / `POST /api/hooks/remove` → HooksStatus (409 `settings-unreadable`). **Session** gains `hooked: boolean`; for a hooked session `pause`, `resume`, `model`, `remote`, `detach`, `attach` and a message that is a slash command answer 409 `hooked-unavailable` (message = why), and `close` unhooks it. **PermissionRequest** (Inbox) gains `hook: { denyMessage: true, alwaysAllow } | null` on a hooked session's request, whose actions are `allow-once`, `always-allow` (when offered) and `deny`, which takes an optional body `{ message }` (at most 2000 characters). **Question.answeredOn** may also read `terminal`. The hook script's own endpoints `POST /hook/v1/event | permission | waiter` take only the hook token (`docs/security.md` → *Hook endpoints*) and are not part of the UI contract.
- **Unreachable machine (ruling D48-cache-persist, 2026-09-29):** its sessions stay in `GET /api/sessions` (`machine.state` other than `online`, also after a restart of this service); `GET /api/sessions/{id}` and `GET /api/sessions/{id}/events` (without `since`) answer 200 from the last known snapshot; every other request naming it answers 502 `{ error: "peer-unreachable", message: "<machine> is offline — reconnect to continue" }` without reaching the network.
- **`/hub`:** a paired machine's `sessionUpdated`, `event`, `questionBatch` and `activity` arrive with remote ids; `inboxChanged.count` counts this machine's items plus the reachable machines' ones. No new event names.

```json
Machine            { "id": "k3v7q2m9x4ab", "name": "pc-office", "address": "100.101.102.103:13002", "state": "online", "lastError": null, "lastSeenAt": "2026-09-29T12:00:00.000Z", "pairedAt": "2026-09-29T11:58:00.000Z" }
PeerListenerState  { "enabled": true, "configuredAddress": null, "port": 13002, "listening": "100.64.1.2:13002", "error": null }
Session            { "id": "r~k3v7q2m9x4ab~0b7c3e0a-…", …, "machine": { "id": "k3v7q2m9x4ab", "name": "pc-office", "state": "online" }, "hooked": false }
TerminalSession    { "id": "7b6d7a38-…", "pid": 48150, "cwd": "C:\\Users\\me\\repo", "name": "t3-0f", "status": "waiting", "waitingFor": "permission prompt", "startedAt": "2026-09-29T10:00:00.000Z", "hooked": false, "sessionId": null, "hookSeen": true, "waiter": true }
HooksStatus        { "state": "installed", "settingsPath": "C:\\Users\\me\\.claude\\settings.json", "cliVersion": "2.1.284 (Claude Code)", "rewake": "internal", "lastBackup": null, "error": null }
```

## Peer reconnects (fix, 2026-10-01, additive)
Developer report (`docs/decisions.md` → *Fix: peer reconnects*; design `docs/peers.md` → *Connection states*). Additive: a new state value, a new optional field, a new route and a new `/hub` event; no existing route or field changes shape. No migration.

- **`MachineState`** gains `"reconnecting"` (Machine, Session / InboxItem / Schedule / TerminalLoop `machine.state`): the stream dropped (or the service just started) and the 20 s grace period runs. Reads answer from the cache and the snapshots as for an unreachable machine; any other request is **held** until the machine is back (at most 10 s or the end of the grace) and then sent; still away → 502 `{ error: "peer-unreachable", message: "<machine> is still reconnecting — try again in a moment", reason, state }`. A reconnecting machine's Inbox items stay in `GET /api/inbox`.
- **502 `peer-unreachable`** (D48-cache-persist) keeps its code; its `message` now reads `"<machine> is unreachable — it retries by itself; Reconnect now tries at once"`, and the body gains `state` (the machine's state).
- **Machine** gains `connection?: { attempt, trying, nextAttemptAt, graceUntil, lastFailure: { kind, message, at } | null, hint }` (`MachineConnection`, `src/core/peers.ts`); `kind` is one of `refused`, `timeout`, `route`, `auth`, `http`, `reset`, `ended`, `stalled`, `restart`, `other`.
- **`POST /api/machines/{id}/reconnect`** → 200 `ReconnectResult` `{ outcome: MachineState, machine: Machine }` once the attempt is over (`outcome` `online` on success); joins an attempt already running (never two at once); 404 `not-found`. Not on the peer API.
- **`/hub` `machineState`**: `Machine` (plus `removed: true` once the machine was removed) on every change of a paired machine's connection (state, an attempt starting or failing, the next try scheduled), pairing, rename and removal. This machine's only: never forwarded between peers.

```json
Machine          { "id": "k3v7q2m9x4ab", "name": "studio-pc", "address": "100.64.0.7:13002", "state": "offline", "lastError": "connection refused — is Switchboard running there with its peer listener on? (…)", "lastSeenAt": "2026-10-01T09:58:12.000Z", "pairedAt": "2026-09-29T12:00:00.000Z", "connection": { "attempt": 6, "trying": false, "nextAttemptAt": "2026-10-01T10:00:08.000Z", "graceUntil": null, "lastFailure": { "kind": "refused", "message": "connection refused — is Switchboard running there with its peer listener on? (…)", "at": "2026-10-01T09:59:53.000Z" }, "hint": null } }
ReconnectResult  { "outcome": "online", "machine": { "id": "k3v7q2m9x4ab", "state": "online", …, "connection": { "attempt": 0, "trying": false, "nextAttemptAt": null, "graceUntil": null, "lastFailure": { … }, "hint": null } } }
machineState     { "id": "k3v7q2m9x4ab", "name": "studio-pc", "state": "reconnecting", …, "connection": { "attempt": 2, "trying": false, "nextAttemptAt": "2026-10-01T10:00:02.000Z", "graceUntil": "2026-10-01T10:00:15.000Z", … } }
```

## Long messages (fix, 2026-10-01, additive)
Developer report (`docs/decisions.md` → *Fix: long messages cut off*; design `docs/chat.md` → *Cut messages*, `docs/derivations.md` → *What is clipped*). Additive: one new route, one new optional payload field; no existing route or field changes shape. No migration.

- **Event payloads** `assistant` and `agent-prompt` keep their whole `text` (up to 1,000,000 characters); they gain `truncated?: boolean`: `true` = cut at that cap, `false` = restored from the transcript and whole, absent otherwise. Events stored before this fix carry no flag and were cut at 4,000 characters when longer (a text exactly 4,000 characters long reads as cut). Tool inputs / results (`inputTruncated` / `resultTruncated`) and a turn's `result.text` are still cut at 4,000.
- **`GET /api/sessions/{id}/events/{eventId}/full`** → 200 `FullEventAnswer` `{ event: Event, saved: boolean }`: the event with its whole text from the session's CLI transcript (its subagents' files too). Message text is written back into the stored event (`saved: true`, published as a `/hub` `event`); a tool call's whole `input` / `result` is only answered (`saved: false`; the database keeps it cut). An event that is not cut is answered as it is. 404 `not-found` (no such session or event), 422 `not-restorable` (an event with no text), 410 `transcript-gone` (the session has no transcript any more), 410 `not-in-transcript` (the transcript does not have that message); `message` is the sentence the chat shows. On the peer API (`PEER_API_ALLOW`); through the proxy the answer's `event` is namespaced like every event.

```json
GET /api/sessions/s1/events/42/full
200 { "event": { "id": 42, "sessionId": "s1", "agentId": "a1", "ts": "2026-10-01T09:12:03.000Z", "endTs": null, "kind": "text", "label": "Here is the full plan", "payload": { "type": "assistant", "text": "Here is the full plan … (9,214 characters)", "messageId": "msg_01", "truncated": false } }, "saved": true }
410 { "error": "transcript-gone", "message": "The session's CLI transcript is gone: the full text cannot be restored." }
```

## Context window meter (D49, 2026-09-29, additive)
Developer request D49 (`docs/decisions.md` → *Context window meter*): the composer shows how full the session's context window is. No new route or event name; migration `0015_session_context.sql`. Details: `docs/chat.md` → *Context bar*.

- **Session** gains `context: SessionContext | null` (so do `SessionDetail` and `/hub` `sessionUpdated`, which is published whenever it changes). It is `null` for a session Switchboard never ran a process for and has no reading of (the demo seed). Optional in `src/core/api.ts` so older fixtures type-check; the server always sends it.
- **SessionContext:** `tokens` (the main agent's input + cache creation + cache read tokens of its latest reply; `null` = unknown), `window`, `windowSource` (`reported` = the CLI's `modelUsage[…].contextWindow`, `model` = derived from the model name), `model`, `percent` (0–100 or `null`), `band` (`ok` < 60 ≤ `warn` < 80 ≤ `high`, `unknown`), `updatedAt`, `compaction` (`{at, trigger, preTokens, postTokens}` of the last compaction, or `null`), `compactedRecently` (from a compaction until the next turn starts). Rulings on D49 (additive): `autoCompactTokens` / `autoCompactPercent` (where the CLI will auto-compact, on the same scale as `percent`, one decimal; `null` when auto-compact is off); a session from before D49 gets its meter from its transcript once, in the background of its first `GET /api/sessions/{id}`, followed by `sessionUpdated`.

```json
Session { …, "context": { "tokens": 124000, "window": 200000, "windowSource": "reported", "model": "claude-opus-4-7", "percent": 62, "band": "warn", "updatedAt": "2026-09-29T12:05:00.000Z", "compaction": { "at": "2026-09-29T12:05:00.000Z", "trigger": "auto", "preTokens": 167000, "postTokens": 18000 }, "compactedRecently": false, "autoCompactTokens": 167000, "autoCompactPercent": 83.5 } | null }
```

## Stop the current turn (D50, 2026-09-29, additive)
Developer request D50 (`docs/decisions.md` → *Stop the current turn*): stop the running turn only; the process stays alive and the session becomes idle. One new route, no new event name, no migration. Details: `docs/supervisor.md` → *Stop the current turn (D50)*, `docs/chat.md` → *Stop (D50)*.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/sessions/{id}/interrupt | — | 200 InterruptResult · 404 `not-found` · 409 `hooked-unavailable` (D48 P4) |
| POST | /api/sessions/{id}/background/stop | StopBackgroundRequest `{ taskIds? }` (ruling, 2026-09-29) | 200 StopBackgroundResult · 422 `invalid` `{ errors: [{ field: "taskIds" }] }` · 404 `not-found` · 409 `hooked-unavailable` |

- **InterruptResult:** `session` (the Session after the Stop: `idle` once the turn stopped, unless background work keeps it working), `outcome` (`stopped` = the CLI acknowledged and the turn ended; `idle` = no turn ran, nothing was sent; `timeout` = no acknowledgement in time: an error event is recorded and nothing is killed, Pause ends the process), `withdrawn` (the texts of the messages the Stop took back, oldest first, for the composer; empty for a second Stop while the first one waits). The call returns once the Stop is over.
- **SessionEvent.payload** of type `user` gains `withdrawn: true` on a message the Stop took back (the agent never runs it); the event is re-sent on `/hub` `event` when it is set (and when a late echo shows the CLI had taken it up after all: `withdrawn` removed, `delivered: true`).
- **SessionEvent.payload** of type `result` gains `stopped: true` on the stopped turn's result (kind `text`, label `Stopped`), and a new payload type `stop` `{ outcome: "timeout", waitedMs, missing: "ack" | "result" }` (kind `error`) records a Stop the CLI did not acknowledge.
- **Question.closedReason** can be `turn stopped`: a batch whose turn was stopped while it waited (it leaves the Inbox, like D33's `session closed`). A permission request open then goes `stale`.

- **Rulings on D50 (2026-09-29):** `POST …/background/stop` stops the session's background tasks (the CLI's `stop_task` each; `taskIds` absent = every stoppable one; a wake-up is never stoppable): **StopBackgroundResult** `{ session, stopped: string[], failed: [{ id, error }] }`. Both routes are served to paired machines (D48 peer API) and answered with the session mapped to the caller's remote id; a hooked terminal session answers 409 `hooked-unavailable` with the reason.

```json
InterruptResult { "session": Session, "outcome": "stopped" | "idle" | "timeout", "withdrawn": ["Also: keep it short."] }
StopBackgroundResult { "session": Session, "stopped": ["b1f2c3d4"], "failed": [] }
Event { …, "payload": { "type": "user", "text": "Also: keep it short.", "origin": "user", "delivered": false, "withdrawn": true } }
Event { …, "kind": "text", "label": "Stopped", "payload": { "type": "result", "subtype": "error_during_execution", "isError": true, "terminalReason": "aborted_streaming", …, "stopped": true } }
```

## Workflow agents (D51, 2026-09-29, additive)
Developer report D51 (`docs/decisions.md` → *Workflow agents are visible*): a Workflow's agents show like subagents. Additive; nothing above changes meaning. One new route, no new event name, no migration (nothing is stored: the CLI's files are read). Details: `docs/derivations.md` → *Workflow agents (D51)*.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/sessions/{id}/workflow-agents/{agentId}/chat | — | 200 WorkflowAgentChat · 404 `not-found` (no such session, or no such workflow agent with a transcript) |

- **Session** gains `workflows`: the session's Workflow runs, oldest first (`WorkflowRun`: `runId`, `taskId`, `name`, `summary`, `status` (`run` / `done` / `fail` / `idle` = stopped), `phase`, `phases`, `agentCount`, `doneCount`, `failedCount`, `startedAt`, `endedAt`, and (ruling D51-resume) `resume`: `{ scriptPath, args }` for a stopped or failed run whose script is known, else `null`; the UI's Resume run sends the session's agent a message asking for `Workflow({ scriptPath, resumeFromRunId: runId, args })` through `POST /api/sessions/{id}/messages`); `[]` when none. In `GET /api/sessions`, the detail and `sessionUpdated`.
- **Session.agents** gains the runs' agents, after the stored agents, with `kind: "workflow"`: `id` = `<runId>--<index>` (else `<runId>--<agentId>`), `name` = the label, `description` = the phase, `solutionPath` = the solution of its first successful write, else of its cwd (else `null`), `branch: null`, `status` (`idle` + `statusText: "queued"` while queued), `toolUseId: null`.
- **Agent** gains `workflow`: `AgentWorkflow` for a workflow agent (`runId`, `index`, `agentId` (`null` while queued), `phase`, `model`, `startedAt`, `endedAt`, `action` (`{ tool, summary, since }` while it runs, else `null`), `cwd`, `version` (grows with its transcript; reload its chat when it changes)), `null` for every other agent. The server always sends it.
- **BackgroundTask** (`Session.activity.background`) gains `workflow` on a `workflow` task whose run is known: `{ runId, doneCount, agentCount, phase }`; absent otherwise. The UI's line then reads "Running a workflow: <summary> · 3/7 agents done · phase Review" (once `agentCount` > 0).
- **WorkflowAgentChat:** `events` (the agent's conversation in the event shapes of *Events*: `agent-prompt` (the first is its brief), `assistant`, `tool` with its result; `agentId` = the agent's id; ids local to the answer), `result` (`{ text, isError }`: its return value, a string or a JSON code block, or its error; `null` while it runs), `version`.
- **Changes** are published as `sessionUpdated` (and, for a live session, `activity`): the run's files are re-read at once on the stream's progress lines and every 1.5 s while a run runs.
- **Peers (D48):** the chat route is in the peer API's allow list; through the proxy its `events` carry the remote session id like every other event (answer kind `workflow-chat`).

```json
WorkflowRun { "runId": "wf_5bf13727-e69", "taskId": "wk2etiaas", "name": "proj-3015-gtm", "summary": "GTM + Consent Mode v2 …", "status": "run", "phase": "Review", "phases": ["Implement", "Review"], "agentCount": 14, "doneCount": 9, "failedCount": 0, "startedAt": "2026-09-29T12:12:03.000Z", "endedAt": null }
Agent { "id": "wf_5bf13727-e69--12", "kind": "workflow", "name": "review:reviews-front", "description": "Review", "solutionPath": null, "branch": null, "status": "run", "statusText": null, "toolUseId": null,
        "workflow": { "runId": "wf_5bf13727-e69", "index": 12, "agentId": "a66193aea95b903b2", "phase": "Review", "model": "claude-opus-5-5", "startedAt": "…", "endedAt": null, "action": { "tool": "Bash", "summary": "dotnet build", "since": "…" }, "cwd": "/…/workspace", "version": 457272 } }
WorkflowAgentChat { "events": [Event, …], "result": null, "version": 457272 }
```

## A peer's schedules and loops (D52, 2026-09-29, additive)
Developer request D52 (`docs/decisions.md` → *A peer's schedules and loops*): a paired machine's schedules and loops on Schedules & loops. Additive; nothing above changes meaning. Two new routes, no new event name, no migration. Details: `docs/peers.md` → *A peer's schedules and loops (D52)*, `docs/schedules.md` → *Delete (D52)*, `docs/derivations.md` → *Loop cards* → *Terminal sessions (D52)*.

| Method | Path | Body | Returns |
|---|---|---|---|
| DELETE | /api/schedules/{id} | — | 204 · 409 `{ error: "running" }` while a run is in progress · 404 |
| GET | /api/terminal-loops | — | TerminalLoop[]: this machine's un-followed terminal sessions' loops, then the paired machines' (last known) |

- **Schedule** gains `machine` (`{ id, name, state }`) on a paired machine's schedule; its `id` and its runs' `sessionId` are then remote ids (`r~<machine>~<id>`). `GET /api/schedules` lists this machine's schedules, then the paired machines' as last known.
- **ScheduleInput** (`POST /api/schedules`) may carry `machine` (a paired machine's id: the schedule is saved there; this machine's id or empty = here), or an `id` that is a peer's schedule's remote id (the Edit goes there; `machine` naming another machine → 422).
- **TerminalLoop** `{ loop: Loop, terminal: { id, name, cwd, status, pid, startedAt }, machine? }`: `loop.id` = `term:<claude session id>:<key>` (a remote id on a peer's), `loop.sessionId` = the terminal's claude session id (not a Switchboard session; hook it with `POST /api/terminal-sessions/{id}/hook`, on a peer through `/api/machines/{machine}/api/…`).
- **Peers (D48):** both routes and every schedule route are on the peer API's allow-list; `scheduleRun` is forwarded between peers with the schedule's remote id. A machine that cannot be reached keeps its schedules and terminal loops listed (tagged unreachable); every action on them answers 502 `peer-unreachable`.

```json
Schedule { "id": "r~abcdefghijkl~5c1e…", "name": "nightly", "cron": "0 2 * * *", "paused": false, "runs": [{ "ts": "…", "result": "ok", "summary": "OK", "finishedAt": "…", "sessionId": "r~abcdefghijkl~9f0a…", "triggeredBy": "cron" }], "nextRunAt": "…", "running": false, "folder": "<its folder id there>", "machine": { "id": "abcdefghijkl", "name": "pc-office", "state": "online" } }
TerminalLoop { "loop": { "id": "term:5c1e0b52-…:loop", "sessionId": "5c1e0b52-…", "kind": "/loop", "label": "/loop 5m", "iteration": 2, "nextFireAt": "…", "expiresAt": "…", "iterations": [ … ], "…": "…" }, "terminal": { "id": "5c1e0b52-…", "name": "pc-loop", "cwd": "/…/repo", "status": "idle", "pid": 4242, "startedAt": "…" } }
```

### `schedulesChanged` (D52 ruling D52-peer-edits-live, 2026-09-29, additive)
The developer approved one new `/hub` event name: `schedulesChanged` `{ scheduleId, change }`, `change` = `saved` (created or edited) · `paused` · `resumed` · `deleted` · `run` (sent with every `scheduleRun`). It is on the peer event stream: a paired machine refetches that machine's schedules, then publishes it locally with the schedule's remote id, so a schedule changed on one machine shows on the other at once (the 10 s staleness refresh stays as a fallback). Clients that do not know the name ignore it.

```json
schedulesChanged { "scheduleId": "r~abcdefghijkl~5c1e…", "change": "paused" }
```

## Live activity for hooked and peer sessions (D53, 2026-09-29, additive)
Developer request D53 (`docs/decisions.md` → *Live activity for remote and hooked sessions*). Additive; nothing above changes meaning. No new route, no new event name, no migration. Details: `docs/derivations.md` → *Live activity* → *Hooked terminal sessions (D53)*.

- **Session.activity** is also set for a **hooked** terminal session while its turn runs (derived from its transcript and hook calls; it has no live process: `live` stays `false`), and the `/hub` `activity` event is sent for it (at most one per second per session). `thinkingTokens` is always `null` and `background` always `[]` there.
- **SessionActivity** gains `quietSince` (ISO): a hooked session's newest transcript change or hook call; absent for a supervised session. Clients add "no activity for Nm" once a running turn (not `waiting`) is quiet for 3 minutes.
- **SessionActivity** in state `waiting` may carry `tool` / `summary`: a hooked session's held PermissionRequest (the UI reads "Waiting for permission: <tool>"); a supervised session's stay `null` as before.
- **Session** gains `hookStatus` on hooked sessions only (absent on every other): `{ waiter: boolean, hookSeen: boolean, delivery: "handed" | "turn" | "no-waiter" | "ended" | null }` (`null` for a closed hooked session): what an undelivered message waits on. Changes are published as `sessionUpdated`.
- **Peers (D48):** a paired machine's session carries `activity: null` while that machine is not online.

```json
SessionActivity { "turnStartedAt": "2026-09-29T10:01:00.000Z", "state": "tool", "since": "2026-09-29T10:01:04.000Z", "tool": "Bash", "summary": "npm test", "thinkingTokens": null, "agents": { "…": { "state": "tool", "…": "…" } }, "background": [], "quietSince": "2026-09-29T10:01:04.000Z" }
Session { …, "hooked": true, "hookStatus": { "waiter": false, "hookSeen": true, "delivery": "no-waiter" } }
```

## Sidebar pins and folders (D54, 2026-09-29, additive)
Developer request D54 (`docs/decisions.md` → *Pin, re-order and folders in the sidebar*). Additive; nothing above changes meaning. Six new routes, one new event name, migration 0019. Details: `docs/sidebar.md`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/sidebar | — | SidebarLayout |
| POST | /api/sidebar/folders | `{ name }` | 201 SidebarLayout (the new folder is last) · 422 |
| PUT | /api/sidebar/folders/{folderId} | `{ name?, collapsed? }` (at least one) | SidebarLayout · 404 · 422 |
| PUT | /api/sidebar/folders/{folderId}/position | `{ index }` | SidebarLayout · 404 · 422 |
| DELETE | /api/sidebar/folders/{folderId} | — | SidebarLayout (its sessions are loose again) · 404 |
| POST | /api/sidebar/place | `{ sessionId, place: "pinned" \| "folder" \| "loose", folderId?, index? }` | SidebarLayout · 404 unknown session or folder · 422 |

- **SidebarLayout** `{ pinned: string[], folders: SidebarFolder[] }`, **SidebarFolder** `{ id, name, collapsed, sessionIds: string[] }`: session ids in their manual order; a session is in one place at most; a session in none is loose (listed after the folders in `GET /api/sessions` order). Ids of closed sessions stay (Reopen restores the place) and are not shown.
- `name`: trimmed, 1–60 characters, may repeat. `index`: the final position in the target group (absent = the end; ignored for `loose`). `sessionId`: a session of this machine or a paired machine's remote id (`r~<machine>~<id>`); in the body, so it is never forwarded to the peer.
- Every write answers the whole new layout and publishes it as **`sidebarLayoutChanged`** (payload: SidebarLayout). A refused write changes nothing and publishes nothing.
- **Peers (D48):** the layout is this machine's: no sidebar route is on the peer API's allow-list, and `sidebarLayoutChanged` is not on the peer event stream.

```json
SidebarLayout { "pinned": ["5c1e0b52-…", "r~abcdefghijkl~9f0a…"], "folders": [{ "id": "7d2c…", "name": "Reviews", "collapsed": false, "sessionIds": ["a41b…"] }] }
POST /api/sidebar/place { "sessionId": "a41b…", "place": "folder", "folderId": "7d2c…", "index": 0 }
sidebarLayoutChanged { "pinned": ["5c1e0b52-…"], "folders": [{ "id": "7d2c…", "name": "Reviews", "collapsed": true, "sessionIds": ["a41b…"] }] }
```

## Updates from GitHub releases (D55, 2026-09-30, additive)
Developer request D55 (`docs/decisions.md` → *Updates from GitHub releases*). Additive; nothing above changes meaning. No migration. This machine's only: none of these routes is on the peer API and `updateChanged` is not forwarded between peers (D140 changed this: *Remote updates (D140)* below). Details: `docs/updates.md`.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/updates` | — | `UpdateStatus` |
| POST | `/api/updates/check` | — | `UpdateStatus` after a check of the GitHub releases (a failed check is in `lastCheck`, still 200) |
| POST | `/api/updates/install` | `{ version }` | `202 UpdateStatus` (the update runs in the background; progress as `updateChanged`); `409 { error: "busy" \| "checking" \| "git-checkout" \| "no-update" \| "stale-version", message }`; `422` without a version |
| POST | `/api/updates/dismiss` | `{ version }` | `UpdateStatus` (hides that version's banner) ; `422` without a version |

Without an updater (the demo, `SWITCHBOARD_UPDATES=off`) every route answers `501 { error: "not-implemented", item: "D55" }`.

- **UpdateStatus** `{ current, install: { kind: "git" | "release", dir }, restart: "service" | "manual", repo, checking, lastCheck: UpdateCheck | null, latest: ReleaseInfo | null, available, dismissed: string | null, progress: UpdateProgress, previous: { version, dir } | null, liveSessions }`
- **UpdateCheck** `{ at, ok, via: "api" | "gh" | null, error: string | null }`
- **ReleaseInfo** `{ version, tag, name, notes (Markdown), publishedAt, url }`
- **UpdateProgress** `{ phase: "idle" | "downloading" | "verifying" | "extracting" | "installing" | "switching" | "restarting" | "restart-manually" | "failed", version, message, error, dir, at }`
- **InboxItem** of kind `system` gains the label `Update available` (actions `whats-new`, `dismiss`).
- **Event** `updateChanged`: `UpdateStatus` (the whole answer of `GET /api/updates`).

```json
UpdateStatus { "current": "1.0.0", "install": { "kind": "release", "dir": "C:\\Users\\me\\switchboard-1.0.0" }, "restart": "service", "repo": "MarcinGadomski94/switchboard", "checking": false, "lastCheck": { "at": "2026-09-30T09:00:00.000Z", "ok": true, "via": "api", "error": null }, "latest": { "version": "1.1.0", "tag": "v1.1.0", "name": "Switchboard 1.1.0", "notes": "## What's new …", "publishedAt": "2026-10-01T08:00:00Z", "url": "https://github.com/MarcinGadomski94/switchboard/releases/tag/v1.1.0" }, "available": true, "dismissed": null, "progress": { "phase": "installing", "version": "1.1.0", "message": "", "error": null, "dir": null, "at": "2026-10-01T08:05:00.000Z" }, "previous": null, "liveSessions": 2 }
```

## Simple New-session form (D56, 2026-09-30, additive)
Developer request D56 (`docs/decisions.md` → *Simple New-session form*): a simple start without the router's session-start answers. Additive; a body without `simple` (or with `simple: false`) is validated exactly as before. No migration: the remembered mode is a row of the existing `settings` table. Details: `docs/new-session.md` → *Simple mode (D56)*.

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | /api/sessions | NewSimpleSession (`simple: true`) | 201 Session · 422 `invalid` (`simple` not a boolean; `name` / `title` / `task` / `model` / `effort` as for a NewSession; `solutions` not empty, a repo folder's only its repo; `worktrees: true` in a workspace folder; `branch` not a valid git branch name) · 409 as for a NewSession (folder, worktree refusals) |
| GET / PUT | /api/settings | `{ "newSession.mode": "simple" \| "full" }` | Settings; PUT → 422 on `newSession.mode` for anything but the two words |

```json
NewSimpleSession { "simple": true, "name": "tidy-readme", "task": "Tidy the README.", "folder": "<saved folder id>" | null,
                   "worktrees": true, "title": "Tidy readme", "branch": "sb/tidy-readme", "model": "opus" | null, "effort": "high" | null }
Settings         { …, "newSession.mode": "simple" }
```
- **NewSimpleSession:** `folder` omitted or `null` = the default folder; `solutions` omitted or empty (a repo folder may name its one repo); `worktrees` and `ultracode` optional (`false`); router fields, `qa` and `branching` are not read (stored `null` / none). `worktrees: true` only for a **repo** folder; its `branch` is any valid git branch name (no D32 ticket rule), omitted or blank = `sb/<name>`, and the worktree follows D40's task-only rule (cut from the origin default branch after a fetch, an existing branch reused, a repo without `origin` from its HEAD).
- **First message:** the task alone; in a workspace folder **no "Session-start answers" block** (the agent asks the router's questions itself); a repo folder's session in its worktree gets the task plus only the worktree note. An empty task starts idle with nothing in the outbox (a repo worktree's note waits there as before).
- **`newSession.mode`:** editable, default `simple` (a fresh install); a stored value other than the two words reads as `simple`. The New-session dialog writes it when the developer switches forms and opens in it.

## Attachments (D57, 2026-09-30, additive)
Developer request D57 (`docs/decisions.md` → *Paste and attach images and files*): images and files go with a message. Additive: a message or start body without `attachments` is handled exactly as before. Migration 0020 (`attachments`); the bytes live in the data folder (`docs/chat.md` → *Attachments (D57)*, `docs/security.md` → *Attachments (D57)*).

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | /api/sessions/{id}/attachments | AttachmentUpload | 201 Attachment · 404 unknown session · 413 `too-large` (over 20 MiB) · 422 `invalid` (`data` not base64, empty) |
| POST | /api/attachments | AttachmentUpload | 201 Attachment, staged for a start (its id goes in `NewSession.attachments`) · 413 · 422 |
| GET | /api/sessions/{id}/attachments/{attachmentId}[?download] | – | the file: an image / PDF with its sniffed type and `Content-Disposition: inline` (`?download`: `attachment`), anything else `application/octet-stream` + `attachment`; always `X-Content-Type-Options: nosniff` · 404 unknown, another session's, staged or cleaned up |
| POST | /api/sessions/{id}/messages | `{ text, attachments?: [ids] }` | 202 · 422 on `attachments` (not a list of distinct ids, an id not uploaded to this session, more than 20, more than 50 MiB) · 422 on `text` when both are empty |
| POST | /api/sessions | NewSession / NewRepoSession / NewSimpleSession + `attachments?: [ids]` | 201 Session · 422 on `attachments` (unknown or already used staged id, the caps, an empty `task`) |
| POST | /api/sessions/{id}/interrupt | – | InterruptResult + `withdrawnAttachments` |

```json
AttachmentUpload { "name": "Screenshot 2026-09-30.png", "data": "<base64>" }
Attachment       { "id": "<uuid>" | null, "name": "Screenshot 2026-09-30.png", "size": 48213,
                   "kind": "image" | "pdf" | "file", "mediaType": "image/png", "delivery": "inline" | "file" }
UserPayload      { "type": "user", "text": "What do you see?", …, "attachments": [Attachment],
                   "sentText": "What do you see?\n\nAttached files:\n- /…/attachments/<session>/<id>-notes.txt (23 B)" }
InterruptResult  { "session": Session, "outcome": "stopped", "withdrawn": ["…"], "withdrawnAttachments": [Attachment] }
```
- **Kinds:** sniffed from the bytes (PNG, JPEG, GIF, WebP → `image`; `%PDF-` → `pdf`; anything else, SVG and HTML included, `file`); `name` is the upload's last segment, sanitized.
- **Delivery:** images and PDFs go **inline** as stream-json content blocks (`{ "type": "image", "source": { "type": "base64", "media_type", "data" } }`, `{ "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data" }, "title" }`) before the text block; other files, and what the CLI would not take inline (an image over 3.75 MB, a PDF over 20 MiB or 100 pages, beyond 24 MiB of base64 per message), go as paths in the text (`Attached files:` + `- <absolute path> (<size>)`). A hooked terminal session gets only paths. `delivery` is set on a sent message's listing, not on an upload's answer.
- **Events:** `UserPayload.attachments` lists them (no bytes, no paths); `id: null` is an image a transcript named without its bytes (a placeholder). `sentText` is present when the text sent differs from `text`.
- **Peers (D48):** the three routes are on `PEER_API_ALLOW`; a remote session id is forwarded as for every session route (uploads with the attachments' body limit; downloads as bytes with their headers); `POST /api/machines/{id}/api/attachments` stages an upload on that machine for a start there.

## Subfolders in the sidebar (D58, 2026-09-30, additive)
Developer request D58 (`docs/decisions.md` → *Subfolders in the sidebar*): folders inside folders in the sidebar. Additive on *Sidebar pins and folders (D54)*; a D54 body means what it meant. No new route or event name; migration 0021. Details: `docs/sidebar.md` → *Subfolders (D58)*.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/sidebar/folders | `{ name, parentId? }` | 201 SidebarLayout (the new folder last among the subfolders of `parentId`; absent / `null` = the top level) · 404 unknown parent · 422 (`parentId` not a string or null; too deep) |
| PUT | /api/sidebar/folders/{folderId}/position | `{ index, parentId? }` | SidebarLayout · 404 unknown folder or parent · 422 (a loop: into itself or one of its subfolders; too deep) |
| DELETE | /api/sidebar/folders/{folderId} | — | SidebarLayout: its subfolders move up one level into its place, its sessions go to the end of its parent folder (loose when it was top level) · 404 |

- **SidebarFolder** gains `parentId: string | null` (`null` = a top-level folder; every folder from D54 is top level). **SidebarLayout.folders** is in tree order: each folder followed by its subfolders, depth first; folders with the same `parentId` are in their manual order. A client that ignores `parentId` still reads a valid D54 layout.
- `parentId` on a move: absent = the folder stays at its level (D54's re-order); `null` = the top level; a folder id = into that folder. `index` is the final position among the folders of that level. The folder moves with its subfolders and sessions.
- **Limits:** no loops; at most **5 levels** (a top-level folder is level 1), counting the moved folder's own subfolders. A refusal is `422 { error: "invalid", errors: [{ field: "parentId", message }] }` and changes nothing, publishes nothing.
- `sidebarLayoutChanged` is unchanged in name; its payload (the whole SidebarLayout) now carries the tree. The routes stay off the peer API.

```json
SidebarLayout { "pinned": [], "folders": [{ "id": "7d2c…", "name": "Work", "collapsed": false, "sessionIds": ["a41b…"], "parentId": null }, { "id": "9e10…", "name": "Reviews", "collapsed": true, "sessionIds": ["r~abcdefghijkl~9f0a…"], "parentId": "7d2c…" }] }
POST /api/sidebar/folders { "name": "Reviews", "parentId": "7d2c…" }
PUT /api/sidebar/folders/9e10…/position { "index": 0, "parentId": null }
422 { "error": "invalid", "errors": [{ "field": "parentId", "message": "a folder cannot go into itself or one of its subfolders" }] }
```

## Move to worktree on an existing branch (D60, 2026-09-30, additive)
Developer request D60 (`docs/decisions.md` → *Move to worktree on an existing branch*): the conflict card's "Move … to worktree" may put the worktree on a branch the repo already has, local or remote. Additive: a body with `branch` (D32) is handled exactly as before. No migration.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | /api/solutions/{repo}/branches?session={id}[&fetch=1] | – | 200 RepoBranches (a failed fetch is `fetched: false` + `fetchError`, still 200) · 422 `invalid` on `session` (missing) or `repo` (not a solution of the session's folder) · 404 `session-not-found` · 409 `folder-missing` |
| POST | /api/solutions/{repo}/isolate | `{ sessionId, existingBranch }` | 201 / 200 Worktree (200: the session already has a worktree of the repo, unchanged) · 409 `branch-checked-out` (checked out in the main checkout or another worktree) · 409 `branch-not-found` · 422 `invalid` on `existingBranch` (not a branch name, or sent with `branch`) · the other refusals as before (404 `session-not-found`, 409 `detached`, …); nothing is created or paused on a refusal |

```json
RepoBranches { "repo": "alpha-front", "repoPath": "/…/microfrontends/alpha-front",
               "branches": [RepoBranch], "fetched": true | false | null, "fetchError": "git fetch failed: …" | null }
RepoBranch   { "name": "origin/PROJ-5-search", "kind": "local" | "remote", "remote": "origin" | null,
               "localName": "PROJ-5-search", "upstream": "origin/PROJ-5-search" | null, "localExists": false,
               "subject": "Add search", "committedAt": "2026-09-30T09:00:00+02:00" | null,
               "checkedOutAt": "/…/alpha-front" | null }
IsolateRequest { "sessionId": "<id>", "branch": "PROJ-0001-short-description" }
             | { "sessionId": "<id>", "existingBranch": "origin/PROJ-5-search" }
```
- **List:** local branches first, then remote ones (every remote; `<remote>/HEAD` left out), each newest commit first. `fetch=1` runs `git fetch --all --prune` first (bounded, 60 s); without it nothing reaches the network (`fetched: null`, also for a repo without remotes). `checkedOutAt` is where `localName` is checked out; such a branch cannot get the worktree (409 `branch-checked-out`).
- **existingBranch** is a `RepoBranch.name`. A local branch is used as it is; a remote-only `origin/foo` gets a new local `foo` tracking it; a remote branch whose `localName` exists locally uses the local branch (`localExists: true`). The D32 ticket rule does not apply. The move message names the branch as existing and its upstream.
- **Peers (D48):** neither route is on `PEER_API_ALLOW` (the isolate route never was: the Solutions view and its conflict card are this machine's).

## Plain folders (D59, 2026-09-30, additive)
Developer request D59 (`docs/decisions.md` → *Simple mode starts in any folder*): a Simple session may start in any folder. Additive: `FolderKind` gains `plain`; nothing else changes shape.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | /api/folders/check?path= | – | FolderCheck: a folder with no `AGENTS.md` that is not a git main checkout is `kind: "plain"` (before D59: `kind: null`, `problem: "unsupported"`) |
| POST | /api/folders | `{ path, label? }` | 201 / 200 Folder, also for a plain folder · 422 `invalid` only when it is not absolute, missing, a file or a linked git worktree |
| POST | /api/sessions | NewSimpleSession, `folder` = a plain folder | 201 Session (`folderKind: "plain"`, `solutions: []`, `cwd` = the folder) · 422 on `worktrees` (`true`) or `solutions` (not empty) |
| POST | /api/sessions | NewSession / NewRepoSession, `folder` = a plain folder | 422 `{ errors: [{ field: "folder", message: "this folder has no AGENTS.md and isn't a git repository: start a Simple session there" }] }` |
| POST | /api/schedules | ScheduleInput, `template.folder` = a plain folder | 422 on `template.folder` (a run is a Full start) |

```json
FolderCheck { "path": "/Users/dev/notes", "canonicalPath": "/Users/dev/notes", "exists": true, "kind": "plain",
              "router": null, "solutionCount": 0, "repoName": null, "problem": null, "message": "" }
Folder      { "id": "<uuid>", "path": "/Users/dev/notes", "name": "notes", "kind": "plain", …, "check": FolderCheck }
Session     { …, "folderKind": "plain", "solutions": [], "cwd": "/Users/dev/notes" }
```
- **Kinds:** `FolderKind` = `"workspace" | "repo" | "plain"` wherever it appears (`Folder.kind`, `FolderCheck.kind`, `Session.folderKind`, `HistoryItem`'s folder). A client that knew two kinds should read an unknown one as "neither a workspace nor a repo".
- **First message:** a plain folder's session gets the message alone (and D57's attachment lines); no router answers, no worktree note.
- **Elsewhere:** `GET /api/solutions?folder=<plain>` answers `[]`; `GET /api/codebase-memory?folder=<plain>` an empty list; a History move of a conversation inside a saved plain folder continues there (`solutions: []`), and one outside every workspace and repo gets `409 folder-not-saved` with its start folder's `kind: "plain"` check (before D59: `422 not-in-a-folder`). Peers (D48) proxy these unchanged.

## MCP servers page (D61, 2026-09-30, additive)
The `/mcp` page (`docs/mcp.md`). Every route takes `?folder=` (a saved folder's id or path; the default folder when omitted: `409 no-folder`, `404 not-found` as for Solutions), sits behind the usual guard and cookie, and is on the peer API (`PEER_API_ALLOW`), so `/api/machines/{id}/api/mcp…` manages a paired machine's servers. No answer ever carries an env or header value; masked parts read `••••`.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | /api/mcp | | McpView |
| POST | /api/mcp/check | { name? } | McpActionResult (`claude mcp get <name>`; without a name: `mcp_status`, `claude mcp list` as fallback) |
| POST | /api/mcp/servers | McpServerInput | 201 McpActionResult (`claude mcp add-json`) |
| GET | /api/mcp/servers/{name}?scope= | | McpServerDefinition (the Edit form, no secret values) |
| PUT | /api/mcp/servers/{name}?scope= | McpServerInput | McpActionResult (remove + add-json) |
| DELETE | /api/mcp/servers/{name}?scope= | | McpActionResult (`claude mcp remove --scope`) |
| POST | /api/mcp/servers/{name}/reconnect | | McpActionResult (`mcp_reconnect`) |
| POST | /api/mcp/servers/{name}/toggle | { enabled } | McpActionResult (`mcp_toggle`) |
| POST | /api/mcp/servers/{name}/auth | { reset? } | McpAuthState (`mcp_clear_auth` when `reset`, then `mcp_authenticate`) |
| GET | /api/mcp/auth/{id} | | McpAuthState |
| POST | /api/mcp/auth/{id}/callback | { callbackUrl } | McpAuthState (`mcp_oauth_callback_url`) |
| DELETE | /api/mcp/auth/{id} | | McpAuthState (cancelled; the helper is stopped) |

Errors: `422 { error: "invalid", message, errors: [{ field, message }] }` (the CLI's rules: name, scope, transport, command / URL, env / header names; a kept value the server does not have), `422 read-only` (a plugin / claude.ai / managed server's edit or remove), `404 not-found`, `409 { error: "cli-failed", message, commands }` (the CLI's words, secrets masked).

```ts
McpView { folder: { id, path, label }, servers: McpServerView[], checkedAt: string | null, changedAt: string | null }
McpServerView { name, scope: "local" | "project" | "user" | "plugin" | "claudeai" | …, editable, transport, command: string | null, args: string[], url: string | null,
  envNames: string[], headerNames: string[], status: "connected" | "failed" | "needs-auth" | "pending" | "pending-approval" | "rejected" | "disabled" | "unchecked",
  error: string | null, tools: number | null, checkedAt: string | null, canAuthenticate, approval: "approved" | "pending" | "rejected" | null }
McpServerDefinition { name, scope, transport, command, args, url, env: [{ name, set }], headers: [{ name, set }] }
McpServerInput { name, scope: "local" | "project" | "user", transport: "stdio" | "http" | "sse" | "ws", command?, args?, url?,
  env?: [{ name, value? , keep? }], headers?: [{ name, value?, keep? }] }
McpActionResult { view: McpView, commands: string[], message: string | null }
McpAuthState { id, server, state: "waiting" | "done" | "failed" | "cancelled", authUrl: string | null, callbackExpected, error: string | null, instructions: string | null }
```

```json
POST /api/mcp/servers?folder=f1 { "name": "files", "scope": "user", "transport": "stdio", "command": "npx", "args": ["files-mcp"], "env": [{ "name": "FILES_TOKEN", "value": "…" }] }
201 { "view": { … }, "commands": ["claude mcp add-json files '{\"type\":\"stdio\",\"command\":\"npx\",\"args\":[\"files-mcp\"],\"env\":{\"FILES_TOKEN\":\"••••\"}}' --scope user"], "message": "Added stdio MCP server files to user config\nFile modified: …" }
PUT /api/mcp/servers/files?folder=f1&scope=user { "name": "files", "scope": "user", "transport": "stdio", "command": "npx", "args": ["files-mcp", "--verbose"], "env": [{ "name": "FILES_TOKEN", "keep": true }] }
POST /api/mcp/servers/docs/auth?folder=f1 {} → { "id": "…", "server": "docs", "state": "waiting", "authUrl": "https://auth.example.com/authorize?…", "callbackExpected": true, "error": null, "instructions": null }
```

## CLI providers (D62, 2026-10-01, additive)
A session runs on Claude Code (`claude`), Codex CLI (`codex`) or OpenCode (`opencode`) (`docs/providers.md`). Every field and route below is additive; a payload without `provider` is Claude Code.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | /api/clis[?refresh=1] | | CliOverview |
| PUT | /api/clis/default | { provider } | CliOverview; 422 on `provider` (unknown, or cannot be chosen now: the reason) |
| PUT | /api/clis/{provider}/command | { command: string[] \| null } | CliInfo (checked again); 422 for Claude Code (`SWITCHBOARD_CLAUDE_BIN` only) or a malformed command; 404 unknown CLI |
| POST | /api/clis/{provider}/check | | CliInfo (the checks run again; the models read from the CLI where it can list them) |
| GET | /api/models?provider= | | ModelSettings of that CLI (D42's, per CLI; default `claude`); 422 unknown CLI |
| POST | /api/sessions/{id}/provider | { provider } | 202 { session: Session, switchId }; 422 on `provider`; 404; 409 `switching` (one runs, or it already runs on that CLI) / `detached` / `closed` / `not-available` (hooked) / `cli-unavailable` |
| GET | /api/history?cli=1 | | HistoryItem[] with the Codex / OpenCode terminal conversations not in Switchboard yet (`provider`, `nativeId`, `claudeSessionId` = `<cli>:<id>`) |
| POST | /api/history/cli/{provider}/{nativeId}/continue | { name?, title?, confirm? } | 201 Session; 404; 409 `already-in-switchboard` / `terminal-open` (always without `confirm`); 422 `not-in-a-folder` / `invalid` |
| GET | /api/mcp/cli/{provider}?folder= | | CliMcpView (`codex` / `opencode`) |
| POST | /api/mcp/cli/{provider}/servers?folder= | CliMcpServerInput | 201 CliMcpView (`codex mcp add`); 409 `not-available` (OpenCode) / `cli-failed` |
| DELETE | /api/mcp/cli/{provider}/servers/{name}?folder= | | CliMcpView (`codex mcp remove`); 409 as above |

`NewSession.provider` / `NewSimpleSession.provider` (omitted = the default CLI; 422 on `provider` for an unknown CLI or one that cannot be chosen, with the reason); a schedule `template.provider` (omitted = Claude Code). `GET /api/clis`, `POST /api/sessions/{id}/provider` and the `/api/mcp/cli/…` routes are on the peer API (`PEER_API_ALLOW`).

```ts
type CliProviderId = "claude" | "codex" | "opencode";
CliOverview { default: CliProviderId, clis: CliInfo[] }
CliInfo { provider, label, command: string[], commandSource: "settings" | "env" | "default", envVar, path: string | null, installed: boolean,
  version: string | null, signedIn: boolean | null, account: string | null, supported: boolean, available: boolean, reason: string | null,
  models: SessionModelOption[] | null, checkedAt: string, install: { docs: string, commands: string[], signIn: string } }
Session.provider?: CliProviderId
Session.providerSwitch?: { id, from: CliProviderId, to: CliProviderId, step: "handover" | "export" | "stopping" | "starting", handoverBy: "outgoing" | "history" | null } | null
LifecyclePayload (action "switched"): { from, to, handoverBy: "outgoing" | "history", exportPath: string | null }   // the chat's divider
SystemInfo.cliUsage?: [{ provider, label: "Codex 5h" | "Codex week" | …, pct: number, resetsAt: string | null, key?: "session" | "week" | "model" /* D66 */ }]
HistoryItem.provider?: CliProviderId, HistoryItem.nativeId?: string
CliMcpView { provider, available, reason: string | null, servers: CliMcpServer[], canEdit, editReason: string | null, command: string }
CliMcpServer { name, transport: "stdio" | "http", target: string /* masked */, envNames: string[], enabled: boolean, status: string | null }
CliMcpServerInput { name, command?, args?: string[], env?: Record<string, string>, url? }
```

```json
POST /api/sessions { "simple": true, "name": "fix-login", "task": "Fix the login redirect.", "folder": "f1", "provider": "codex" }
201 { "id": "…", "provider": "codex", "providerSwitch": null, "resumeCommand": "codex resume 0199a6d1-…", … }
POST /api/sessions/s1/provider { "provider": "opencode" }
202 { "session": { "id": "s1", "provider": "codex", "providerSwitch": { "id": "w1", "from": "codex", "to": "opencode", "step": "handover", "handoverBy": null }, … }, "switchId": "w1" }
```

## CLI accounts (D63, 2026-10-01, additive)
Each CLI can have several account profiles; a session moves to another one when its account hits a usage limit (`docs/accounts.md`). Every field and route below is additive; a payload without `profileId` runs on its CLI's Default. All routes are on the peer allow-list (a paired machine's accounts are managed through `/api/machines/{id}/api/accounts…`).

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | /api/accounts[?refresh=1] | | AccountsOverview (each profile's status from its CLI's status command, cached 60 s; `refresh` runs them again) |
| PUT | /api/accounts/settings | partial AccountSettings | AccountSettings; 422 (`exhausted.cli` is needed with `switch-cli`) |
| POST | /api/accounts/profiles | { cli, name, shareSettings? } | 201 AccountProfile; 422 `name` / `cli`; 409 duplicate name |
| PUT | /api/accounts/profiles/{id} | { name?, enabled?, shareSettings? } | AccountProfile; 404; 409 name; 422 (the Default is what others share: no `shareSettings` on it; D67: it can be renamed) |
| DELETE | /api/accounts/profiles/{id}[?removeFiles=1] | | 204; 404; 409 `builtin` / `in-use` (a process runs on it); its sessions go back to the Default; a folder is removed only with `removeFiles` and only inside `<dataDir>/profiles/` |
| PUT | /api/accounts/order | { cli, order: string[] } | AccountsOverview; 422 (ids must be that CLI's, each once) |
| POST | /api/accounts/profiles/{id}/check | | AccountProfile (status read again) |
| POST | /api/accounts/profiles/{id}/sync-settings | | { shared: string[], mcp } (links the Default's settings again) |
| POST | /api/accounts/profiles/{id}/signin | { email?, deviceCode?, provider?, apiKey? } | AccountSignIn (`waiting` with the `url` once the CLI printed it); 404; 409 `builtin` |
| GET | /api/accounts/signin/{id} | | AccountSignIn (poll until `done` / `failed` / `timeout` / `cancelled`) |
| POST | /api/accounts/signin/{id}/paste | { value } | AccountSignIn; 422 (not a loopback redirect URL or a code); 409 `not-waiting` |
| DELETE | /api/accounts/signin/{id} | | AccountSignIn (`cancelled`) |
| POST | /api/accounts/profiles/{id}/signout | | { ok, message, profile }; 409 `builtin` |
| POST | /api/sessions/{id}/account | { profileId } | Session once the switch is over; 404; 409 `switching` (one runs, or already on it) / `detached` / `closed` / `not-available` (hooked, another CLI's or a disabled profile); 502 `switch-failed` |
| PUT | /api/sessions/{id}/profile-pin | { pinned } | Session; 422 |

`NewSession.profileId` / `NewSimpleSession.profileId` (omitted = the rule: the first account with allowance; 422 on `profileId` for an unknown profile, another CLI's or a disabled one).

```ts
AccountsOverview { profiles: AccountProfile[], settings: AccountSettings }
AccountProfile { id, cli: CliProviderId, name, dir: string | null /* null = the built-in Default */, builtin, enabled, position, shareSettings,
  signIn: "signed-in" | "signed-out" | "unknown", account: string | null, usage: ProfileUsage | null,
  exhausted: { until: string, window: "session" | "weekly" | "unknown", text: string | null } | null,
  signInCommand: string /* the terminal fallback */, sessions: number }
ProfileUsage { fiveHourPct, fiveHourResetsAt, sevenDayPct, sevenDayResetsAt, receivedAt }   // nullable fields
AccountSettings { enabled, perCli: Record<CliProviderId, boolean>, thresholds: { enabled, fiveHourPct, weeklyPct },
  afterReset: "stay" | "back-to-first", newSessions: { rule: "first-with-allowance" | "fixed", fixed: { [cli]?: profileId } } /* D138: a mirror of `choice` */,
  choice: { [cli]?: profileId } /* D138, additive */,
  exhausted: { action: "notify" | "switch-cli", cli: CliProviderId | null }, cooldownSeconds }
AccountSignIn { id, profileId, cli, state: "starting" | "waiting" | "done" | "failed" | "cancelled" | "timeout", url: string | null, code: string | null,
  instructions: string | null, error: string | null, command: string, canPasteBack: boolean, startedAt, expiresAt }
Session.profileId?: string, Session.profileName?: string, Session.profilePinned?: boolean, Session.accountSwitching?: boolean
LifecyclePayload (action "account-switched"): { fromProfile, toProfile, reason }   // the chat's divider "Switched account: A → B (session limit, resets 14:05)"
SystemInfo.accountUsage?: [{ profileId, cli, name, active: boolean, pct: number | null, exhaustedUntil: string | null, windows?: AccountUsageWindow[] }]   // only while a CLI has more than one enabled account
AccountUsageWindow { key: "session" | "week" | "model", label: string, pct: number, resetsAt: string | null, model?: string, asOf?: string }   // D66, additive
SystemInfo.activeAccounts?: [{ cli: CliProviderId, profileId, name }]   // D66, additive: each CLI's (claude, codex) active account, also with a single one
```

D66 (additive, `docs/decisions.md` → *Footer usage grid*): each `accountUsage` row lists the profile's own windows known now in `windows` (the footer grid's two bars per account and its tooltip): `session` (5 hours), `week`, and for a Claude Code profile each model's weekly limit in use (`key: "model"`, `model` = its name, `asOf` = the time of an older `get_usage` reading, as `UsageWindow`); read from that profile's own readings with the same rules as `usageWindows` (a window that has reset or is unknown is left out). A Codex profile's come from the windows its sessions reported (`resetsAt` may be `null`). `SystemInfo.activeAccounts` (D66, additive): per CLI with an enabled account (Claude Code, Codex) the one new sessions start on, sent also while it is the only one (the footer grid names a single account's line after it); omitted when there is none (demo mode). `SystemInfo.cliUsage[].key` (D66, additive): `session` for a window up to 10 hours, `week` for a longer one, `model` when the CLI did not say how long; the grid's line of a CLI with a single account.

```json
GET /api/system
200 { "cli": "claude", …, "accountUsage": [
  { "profileId": "default-claude", "cli": "claude", "name": "Work", "active": true, "pct": 62, "exhaustedUntil": null,
    "windows": [{ "key": "session", "label": "Session", "pct": 62, "resetsAt": "2026-10-04T14:05:00.000Z" }, { "key": "week", "label": "Week", "pct": 18, "resetsAt": "2026-10-07T15:00:00.000Z" }] },
  { "profileId": "8d3f…", "cli": "claude", "name": "Private", "active": false, "pct": 40, "exhaustedUntil": null,
    "windows": [{ "key": "session", "label": "Session", "pct": 10, "resetsAt": "2026-10-04T15:30:00.000Z" }, { "key": "week", "label": "Week", "pct": 40, "resetsAt": "2026-10-09T09:00:00.000Z" },
      { "key": "model", "label": "Opus", "model": "Opus", "pct": 55, "resetsAt": "2026-10-09T09:00:00.000Z" }] } ],
  "activeAccounts": [{ "cli": "claude", "profileId": "default-claude", "name": "Work" }, { "cli": "codex", "profileId": "default-codex", "name": "Default" }],
  "cliUsage": [{ "provider": "codex", "label": "Codex 5h", "pct": 35, "resetsAt": "2026-10-04T15:00:00.000Z", "key": "session" }] }
```

```json
POST /api/accounts/profiles { "cli": "claude", "name": "Private" }
201 { "id": "8d3f…", "cli": "claude", "name": "Private", "dir": "<dataDir>/profiles/claude/8d3f…", "builtin": false, "enabled": true, "position": 1, "shareSettings": true, "signIn": "unknown", … }
POST /api/accounts/profiles/8d3f…/signin { "email": "me@example.com" }
200 { "id": "c1", "state": "waiting", "url": "https://claude.ai/oauth/authorize?…", "canPasteBack": true, "command": "CLAUDE_CONFIG_DIR=<dataDir>/profiles/claude/8d3f… claude auth login --claudeai", … }
POST /api/sessions/s1/account { "profileId": "8d3f…" }
200 { "id": "s1", "profileId": "8d3f…", "profileName": "Private", "accountSwitching": false, … }
```

## Accounts shared across paired machines (D98, 2026-10-13, additive)

Developer request D98 (`docs/decisions.md` → *Accounts shared across paired machines*): the accounts of every connected paired machine (D48) show here too, and the same login on two machines is one account. Details: `docs/accounts.md` → *Shared across paired machines*. Every field is additive; nothing changes without a paired machine. **No credential, token or credential file ever travels:** each machine signs in on its own.

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | /api/accounts/shared | SharedAccountsMessage (the caller's) | SharedAccountsMessage (this machine's, after merging the caller's prefs); 422 not a message. On the peer allow-list (a paired machine's exchange: the caller's accounts are kept and its prefs merged, by the injected peer header's machine id); without that header (this machine's own UI) it only answers. Refused to devices (D73: `/api/accounts/…`). A Switchboard before D98 answers 403 `peer-forbidden`: the caller reads its `GET /api/accounts` instead and shows those accounts unmerged |

- `GET /api/accounts` (this machine's UI) merges each profile with the same account on the paired machines and adds `others`; a paired machine's request (the Machine picker) gets this machine's own facts only (no `elsewhere`, no `others`, no merged reading).
- `SystemInfo.accountUsage` rows (the footer grid) gain `machines` on every row once a paired machine's account shows (this machine's name first on its own rows) and `windowsFrom` when a row's windows are a paired machine's newer reading (the footer then shows them for the active account instead of `usageWindows`). A paired machine's account that is not here is a row of its own (`profileId` = `r~<machine id>~<its profile id>`, `active: false`), only when it is signed in there (and, for Codex, has a known window). Rows are sent also when a CLI has one enabled account here but a paired machine adds or shares one.

```ts
AccountProfile.identity?: string            // "claude:<email>" from the CLI's status; Codex / OpenCode: never set (no identity to merge by)
AccountProfile.elsewhere?: [{ machineId, machineName, profileId, name }]   // the same account on the connected paired machines
AccountProfile.usageFrom?: string           // `usage` is that paired machine's newer reading
AccountProfile.exhausted.machine?: string   // the paired machine that found it spent
AccountsOverview.others?: PeerOnlyAccount[] // the connected paired machines' accounts that are not here
PeerOnlyAccount { key: "r~<machine id>~<profile id>", cli, name, identity: string | null, account: string | null, signIn,
  machines: [{ id, name, profileId }], usage: ProfileUsage | null, exhausted: { until, window, text } | null }
AccountUsageRow.machines?: string[], AccountUsageRow.windowsFrom?: string
SharedAccountsMessage { v: 1, machine: { id, name }, accounts: SharedAccount[], prefs: AccountPrefs }
SharedAccount { profileId, cli, name, identity: string | null, account: string | null, enabled, position, signIn, usage: ProfileUsage | null,
  exhausted: { until, window, text } | null }   // this machine's own facts only
AccountPrefs { names: { [identity]: { name, at /* epoch ms */ } }, order: { [cli]?: { identities: string[], at } } }   // last writer wins
```

```json
POST /peer/v1/api/accounts/shared   (the peer API; injected as POST /api/accounts/shared)
{ "v": 1, "machine": { "id": "abcdefgh2345", "name": "Desk" },
  "accounts": [{ "profileId": "default-claude", "cli": "claude", "name": "Work", "identity": "claude:dev@example.com", "account": "dev@example.com · max",
    "enabled": true, "position": 0, "signIn": "signed-in",
    "usage": { "fiveHourPct": 62, "fiveHourResetsAt": "2026-10-13T14:05:00.000Z", "sevenDayPct": 18, "sevenDayResetsAt": "2026-10-17T09:00:00.000Z", "receivedAt": "2026-10-13T12:00:00.000Z" },
    "exhausted": null }],
  "prefs": { "names": { "claude:dev@example.com": { "name": "Work", "at": 1791892800000 } }, "order": { "claude": { "identities": ["claude:dev@example.com"], "at": 1791892800000 } } } }
200 { "v": 1, "machine": { "id": "stuv67wxyz23", "name": "Studio" }, "accounts": [ … ], "prefs": { … } }
```

## Credits per account (D103, 2026-10-14, additive)

Developer request D103 (`docs/decisions.md` → *Credits: on credits, and allowance first*): whether an account runs on credits (paid extra usage) and how much is left; the switcher prefers subscription allowance. Details: `docs/accounts.md` → *Credits (D103)*, `docs/usage.md` → *Credits (D103)*. Every field is additive; a client that ignores them sees no change.

- `ProfileUsage.credits` (so `AccountProfile.usage`, `PeerOnlyAccount.usage` and the D98 `SharedAccount.usage` carry it), `AccountUsageRow.credits` and `ActiveAccount.credits`: the account's credit state, omitted while nothing is known about its credits.
- `AccountSettings.outOfAllowance` (`PUT /api/accounts/settings`): `"use-credits"` (default) or `"pause"`.
- `POST /api/sessions/{id}/messages`, and `POST /api/sessions` with a first message, while `outOfAllowance` is `"pause"` and no enabled account of the session's CLI has allowance (or earlier messages of the session still wait): answered as usual (no refusal; there is no `credits-paused` error), but the message is **held**: a user event with `queued: "credits"` and `heldNote` ("Waiting for an account with allowance — Private back at 23:30"), not written to the CLI. A new session starts idle with its first message held. Switchboard sends held messages itself, oldest first, once an account has allowance (switching the session to it first); the event is reused, so the bubble stays where it is.
- `POST /api/sessions/{id}/events/{eventId}/withdraw` → `{ text, attachments }`: Edit / Remove of a held message (it gets `withdrawn: true` and never goes out); 404 `not-found`, 409 `not-held` (sent or withdrawn already).
- Inbox: system items of kind `account-credits` ("Work is using credits") and `account-credits-low` ("Work: credits running low"), source `accounts`, no session, dismiss-only.
- The chat divider of a move off credits: `LifecyclePayload` action `account-switched` with `reason: "moved off credits: Private has allowance again"`.

```ts
AccountCredits { onCredits: boolean, until: string | null /* when "on credits" ends: the full window's reset */, enabled: boolean | null,
  currency: string | null /* ISO 4217 */, limit: number | null, used: number | null, left: number | null /* major units: 12.4 = €12.40 */,
  resetsAt: string | null /* the credit period's reset */, limitReached: boolean, at: string | null /* the newest reading's time */ }
ProfileUsage.credits?: AccountCredits | null
AccountUsageRow.credits?: AccountCredits, ActiveAccount.credits?: AccountCredits
AccountSettings.outOfAllowance: "use-credits" | "pause"
QueuedReason: "turn" | "resume" | "credits"   // D103: held by Switchboard until an account has allowance
UserPayload.heldNote?: string                 // with queued "credits": what it waits for
```

## Choosing the account (D138, 2026-10-27, additive)

Developer request D138 (`docs/decisions.md` → *Choose the account overall and per Project*): the account every new and running session of a CLI uses (the **overall choice**), and a Project's (plan's) own account per CLI. Details: `docs/accounts.md` → *Choosing the account (D138)*. **Precedence:** a session's pin > its Project's account > the overall choice > the automatic rules. Every field and route is additive; the choice is this machine's (profile ids are per machine; D98 shares no choice).

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | /api/accounts/choice/preview | { cli, profileId: string \| null, planId? } | AccountChoicePreview: what the choice would move now (live sessions of the CLI: idle and running; pinned ones and, overall, those whose Project has its own account are skipped; with `planId`, only that Project's sessions, and `profileId: null` means the overall choice); 422 `cli` / `profileId` (unknown, another CLI's, disabled); 404 unknown plan |
| PUT | /api/accounts/choice | { cli, profileId: string \| null, move?: boolean } | AccountChoiceResult. Saves the overall choice (`null` = Automatic) and, unless `move: false`, moves the sessions the preview lists through the D63 switch, one after another in the background (each one's `sessionUpdated` shows its new account); 422 as above |

Paired devices (D73) may call both (the status pill's picker on a phone); they are not on the peer allow-list (a paired machine's choice is set through its `PUT /api/accounts/settings` `choice`, which moves nothing).

- `AccountSettings.choice: { [cli]?: profileId }` (absent = Automatic). It replaces D63's "New sessions start on": `newSessions` is now its mirror (`rule: "fixed"`, `fixed` = the choice, while any CLI has one) for older clients, and a stored `newSessions.rule: "fixed"` without `choice` (an install from before D138) reads as the choice. `PUT /api/accounts/settings` accepts `choice` (merged per CLI; `null` / `""` = Automatic; 422 `choice` for an unknown, another CLI's or a disabled account) and, from an older client, `newSessions` alone (sets the choice from its rule); neither moves sessions.
- New sessions (`POST /api/sessions` without `profileId`, chats, todo runs, takeovers) start on the choice while it has allowance (and while automatic switching is off, always); out of allowance, the automatic pick, and the choice again once it has allowance.
- `Plan.accounts?: { [cli]?: profileId }` (plans.db migration 6; absent / missing CLI = Automatic). Set with `POST /api/plans` / `PUT /api/plans/{id}` / `POST /api/plans/{id}/start` `accounts: { [cli]: profileId | null }` (merged per CLI; `null` = back to Automatic; 422 `accounts`). Every item run session starts on it (for the run's CLI, after D82 routing; the automatic pick while it is out of allowance), and a Start or a change moves the plan's live sessions (its own session and its items' run sessions, pinned ones excepted) to it, or, for Automatic, to the overall choice.
- `Session.accountChoice?: SessionAccountChoice`: where the session's account comes from (open sessions; absent = automatic).
- `/hub`: `accountChoiceChanged` `{ cli, profileId, planId, moving }` (this machine's only, never forwarded): the overall choice of `cli` changed (`planId: null`), or a Project's accounts (`cli: null`); the pickers read `GET /api/accounts` again.
- The chat divider of a move: `LifecyclePayload` action `account-switched` with `reason: "overall choice"` or `"the project's account"` ("Switched account: A → B (overall choice)"); a running turn it interrupted is continued with "Continue where you left off: the account changed because a different account was chosen, …". When the automatic rules move a session off its chosen account because it ran out, the divider's label is "B is out of usage until 14:05; switched to A" (or "B is near its limit (session at 98 %); switched to A").

```ts
AccountChoicePreview { cli, profileId: string | null, profileName: string | null, move: number, running: number,
  skipped: { pinned: number, project: number, already: number }, sessionIds: string[], confirm: string | null /* "Move 5 agents to B? 1 running turn will be interrupted." */ }
AccountChoiceResult { settings: AccountSettings, moving: number, running: number }
SessionAccountChoice { source: "pinned" | "project" | "overall" | "automatic", profileId?: string, project?: { id, title } }
AccountChoiceChanged { cli: CliProviderId | null, profileId: string | null, planId: string | null, moving: number }
```

```json
POST /api/accounts/choice/preview { "cli": "claude", "profileId": "8d3f…" }
200 { "cli": "claude", "profileId": "8d3f…", "profileName": "Private", "move": 5, "running": 1, "skipped": { "pinned": 1, "project": 2, "already": 0 }, "sessionIds": ["s1", …], "confirm": "Move 5 agents to Private? 1 running turn will be interrupted." }
PUT /api/accounts/choice { "cli": "claude", "profileId": "8d3f…" }
200 { "settings": { …, "choice": { "claude": "8d3f…" }, "newSessions": { "rule": "fixed", "fixed": { "claude": "8d3f…" } } }, "moving": 5, "running": 1 }
GET /api/sessions/s1
200 { "id": "s1", "profileId": "8d3f…", "profileName": "Private", "accountChoice": { "source": "overall", "profileId": "8d3f…" }, … }
```

## The account needs you (D139, 2026-10-27, additive)

Found on the developer's install (`docs/decisions.md` → D139): a CLI that refuses to run until the developer acts for the account (Claude Code's "[ACTION REQUIRED] … review the updated terms", a login that no longer works). Details: `docs/accounts.md` → *The account needs you (D139)*, `docs/plans.md` → *Stopped steps whose agent failed (D139)*. Every field and route is additive; no migration (the setting `accounts.blocked`).

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | /api/inbox/{id}/actions/retry-stopped | — | the closed item (as every system item's action). On an `account-needs-you` item: the account no longer waits and the sessions it stopped start again (the same sessions); 404 / 409 as every action |
| POST | /api/plans/{id}/items/{itemId}/restart | — | Plan. A step whose run session failed starts again (the same session; a session that cannot: a fresh run); 409 `not-stopped`, 409 `account` (its account still needs the developer: the reason), 409 `finished` |
| POST | /api/plans/{id}/restart-stopped | — | `{ plan: Plan, restarted: number, waiting: number }`: every stopped step starts again; those whose account still needs the developer wait (`waiting`); 409 `not-stopped` (none), 409 `finished` |

- `POST /api/plans/{id}/resume` now also restarts the stopped steps; a **running** plan with stopped steps answers 200 (before: 409 `not-paused`, which stays for a running plan without any).
- `AccountProfile.needsYou?: { kind: "terms" | "login" | "action", text, since, command: string | null, sessionIds: string[] }` (`GET /api/accounts`): the account waits for the developer. New sessions on Automatic or the overall choice skip it (like a spent account) when another can take them; a Project's own account waits instead (the plan's `held`: "the account Work needs you").
- `InboxItem.command?: string`: the terminal command an `account-needs-you` item shows, copyable (`CLAUDE_CONFIG_DIR="<dir>" claude`; `claude` for the Default; Codex / OpenCode only for a `login`). `InboxItem.systemKind: "account-needs-you"`, label "Account needs you", actions `retry-stopped` ("Retry stopped agents"), `dismiss`. One item per block of a profile; closed `resolved` when a turn on that account ends well.
- `LifecyclePayload` action `account-needs-you` (kind `text`): the stopped session's divider "Stopped: the account Work needs you — accept Anthropic's updated terms", with `message` (the CLI's words), `command`, `fromProfile` (the account's name).
- `PlanItem.stoppedBy?: "error" | "account"`: a `stopped` step whose run session failed (Restart). Such a step holds no concurrency slot and its dependents wait (it used to be `blocked`).
- Paired devices (D73) may call all three routes (Inbox actions were already allowed; the two plan routes are added to `DEVICE_ALLOWED`).

```json
GET /api/inbox
200 [{ "id": "i9", "kind": "system", "systemKind": "account-needs-you", "label": "Account needs you", "source": "accounts", "sessionId": "s4",
  "title": "Work (Claude Code) needs you: accept Anthropic's updated terms",
  "detail": "[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect on October 8, 2025. You must run `claude` to review the updated terms.\n\nRun this in a terminal, do what it asks, then choose Retry stopped agents:",
  "command": "CLAUDE_CONFIG_DIR=\"/data/profiles/claude/0aa0…\" claude",
  "actions": [{ "id": "retry-stopped", "label": "Retry stopped agents" }, { "id": "dismiss", "label": "Dismiss" }], … }]
POST /api/plans/p1/restart-stopped
200 { "plan": { …, "held": null }, "restarted": 2, "waiting": 0 }
```

## Standing instruction for agents (D64, 2026-10-02, additive)

Developer request D64 (`docs/decisions.md` → *Standing instruction for agents*): one instruction every session's agent gets. Additive; no new route, no `/hub` event, no migration (two rows of the existing `settings` table). Details: `docs/settings.md`, `docs/supervisor.md` → *Spawning*, `docs/providers.md` → *Standing instruction (D64)*.

- **Settings** (`GET/PUT /api/settings`) gains two editable keys: `agents.standingInstruction` (string, default the text below, at most 4,000 characters; an empty or blank text passes nothing) and `agents.standingInstruction.enabled` (boolean, default `true`). `PUT` takes either or both; a non-string text, a text over 4,000 characters or a non-boolean toggle → 422 `invalid` on that key, nothing stored. `GET` always returns both.
- The service reads them at every spawn (new, resumed, restarted, account switch, CLI switch), so a change applies to sessions started or resumed afterwards; running processes keep what they were started with.

```json
{ "agents.standingInstruction": "Before you ask the user a question that refers to a proposal, table, list, plan or comparison, write that content out in a message first, then ask. Never refer to content 'above' that you have not actually written in this conversation. Todo list: when asked to add to it, use the switchboard todo tools and fill a title, a short description and a handover plan from the conversation; mark items done when finished; check it when asked what's left.", "agents.standingInstruction.enabled": true }
```

## Take-over (D65, 2026-10-04, additive)

Taking a session over from a paired machine to this one, or moving this machine's session to a paired one (`docs/peers.md` → *Taking a session over (D65)*). Additive: migration 0025, two `Session` fields, two lifecycle actions, no `/hub` event (the dialog polls the run).

- **`Session.movedTo`** (`{ machineId, machineName, sessionId, at }` | `null`): set on the **source** once it was taken over; the session is closed and read-only, `POST /api/sessions/{id}/reopen` answers 409 `closed`. `sessionId` is raw on `machineId`; a link to it is `r~<machineId>~<sessionId>` (a plain id when `machineId` is this machine). **`Session.movedFrom`**: the same shape on the **new** session (where it came from). Both optional / `null` for every other session.
- **Lifecycle actions** `taken-over` (the chat's divider "Taken over from <machine>"; `machine`, `machineId`, `remoteSessionId`) and `moved-away` (the old session's note "Moved to <machine>").

Local only (a peer's request gets 403 `peer-forbidden`):

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | /api/takeover/preview | { sessionId, targetMachine?, clonePaths?, placement? } | TakeoverPreview `{ source, target, stopsTerminal, ok, blockers, placement, remembered }` (D110: `placement` absent = the remembered folders of this folder → that machine, if any; `null` = the target's saved folders); `sessionId` is a local id (needs `targetMachine`: a paired machine's id) or a peer's remote id (comes here); 404 unknown machine, 422 |
| POST | /api/takeover | { sessionId, targetMachine?, clonePaths?, placement?, confirmStopTerminal? } | 202 TakeoverRun; 409 `in-progress` (D110: a run that resumes on the target remembers `placement`) |
| POST | /api/takeover/folders | { machine?, path? } | D110: TargetDirListing of that machine (absent = this one; a paired machine through the peer API): the starting places without `path`, else that folder's subfolders; 403 `outside`, 422 `invalid`, 404 unknown machine |
| GET | /api/takeover/runs/{id} | | TakeoverRun `{ id, state: running \| done \| failed, steps[{ id, label, status, detail }], error?, rolledBack, rollbackNotes, result?, leftovers, log }`; the step ids are `checks, stop, capture, transfer, apply, resume, finish` |

On the peer allow-list (each end's operations; the initiating machine's runner calls them, locally or through the peer API; every answer is `{ result, log }` unless noted; failures are `{ error, message }`):

| Method | Path | Body | Result |
|---|---|---|---|
| POST | /api/takeover/source/inspect | { sessionId } | SourceInspect (repos, conversation files, queued messages, blockers) |
| POST | /api/takeover/source/stop | { opId, sessionId } | { wasLive, wasBusy }; 409 `in-progress` |
| POST | /api/takeover/source/capture | { opId } | { repos: CapturedRepo[] } (the WIP push; 409 `blocked`) |
| POST | /api/takeover/source/stop-terminal | { opId } | { pid, how } (a hooked session; 502 `agents-unavailable` / `stop-failed`) |
| POST | /api/takeover/source/files | { opId } | { kind, files: [{ name, size, sha256 }] } |
| POST | /api/takeover/source/chunk | { opId, name, offset } | `{ name, size, offset, length, data (base64), eof }` (no log) |
| POST | /api/takeover/source/finish | { opId, move, stillThere } | { leftovers, closeError } |
| POST | /api/takeover/source/rollback | { opId } | { notes } |
| POST | /api/takeover/target/plan | { source, clonePaths?, placement? } | TargetPlan (a resolution per repo: `use` / `clone` / `blocked`; D110: with `placement`, `placement` and `verification`) |
| POST | /api/takeover/target/folders | { path? } | D110, read-only: TargetDirListing (not wrapped in `{ result, log }`); 403 `outside` |
| POST | /api/takeover/target/verify | { source, placement, clonePaths? } | D110, read-only: `{ verification: TargetVerification, blockers }` |
| POST | /api/takeover/target/chunk | { opId, name, size, sha256, offset, data } | `{ received, done }` (no log); 422 `checksum` / `invalid`, 409 `out-of-order`, 413 over 200 MB |
| POST | /api/takeover/target/apply | { opId, source, captured, clonePaths?, placement? } | { place, changes, applied } (409 `diverged` and the like; D110: the paths of the plan with that `placement`) |
| POST | /api/takeover/target/abort | { opId } | { notes } |
| POST | /api/takeover/target/resume | { opId, source, files, from } | { sessionId, name, note } |
| POST | /api/takeover/target/close | { opId } | { ok: true } |
| GET | /api/takeover/leftovers | | Leftover[] (temporary branches this machine pushed and could not delete) |
| POST | /api/takeover/leftovers/{id}/delete | | { deleted: true }; 404; 502 `delete-failed` |

```json
{
  "id": "6d2f…",
  "state": "done",
  "steps": [{ "id": "capture", "label": "Pushing the work in progress to a temporary branch", "status": "done", "detail": "1 repo, 3 uncommitted files pushed" }],
  "error": null,
  "rolledBack": null,
  "rollbackNotes": [],
  "result": { "sessionId": "r~abcdefghijkl~0b7c3e0a-…", "machineName": "office-pc", "machineId": "abcdefghijkl", "local": false },
  "leftovers": [],
  "log": ["[office-pc] git -C /work/app push origin +17868e7…:refs/heads/switchboard/takeover/0b7c3e0a/feature/login"]
}
```

### Target folders and verification (D110, 2026-10-14, additive)

Where the session's repos are, or go, on the target is chosen in the dialog instead of assumed (`docs/peers.md` → *Target folders and verification (D110)*). Additive: new optional fields, three routes, no migration (the remembered folders are the setting `takeover.targetFolders` on the initiating machine), no `/hub` event. An older target ignores `placement` (the saved folders, as before) and answers 404 to the new routes.

- **`TargetPlacement`** `{ roots: string[], repoPaths?: { <repo key>: path } }`: folders **on the target** (at most 8), and per repo the exact checkout (a pick among several, or one outside the roots). Paths are the target's own.
- **`TargetVerification`** `{ roots (real paths), repos: RepoCheck[], problems: string[] }`; **`RepoCheck`** `{ key, name, branch, state: found | differs | missing | ambiguous, matches: [{ path, branch, dirty }], path, hints: [{ path, remote }], cloneTo, ok, note }`. `ok` = the take-over can go ahead for that repo by D65's rules; the dialog shows ✓ (`found`), ⚠ (`differs` / `missing` with a clone / `ambiguous`), ✖ (not `ok`).
- **`TargetDirListing`** `{ machine, platform, path, parent, entries: [{ name, path, repo, workspace }], places: [{ label, path, kind: workspace | repo | plain | home }] }`: folders only.
- **`TargetPlan`** adds `placement` and `verification` (both `null` without a placement); **`TakeoverPreview`** adds `placement` and `remembered`.
- Team (D100): `POST /api/team/members/{id}/move/check` and `…/move` also take `placement` and `clonePaths` (the same meaning; `placement: null` = the saved folders).

```json
{
  "roots": ["D:\\code\\acme-ws"],
  "problems": [],
  "repos": [
    { "key": "web-front", "name": "web-front", "branch": "feature/login", "state": "differs", "matches": [{ "path": "D:\\code\\acme-ws\\microfrontends\\web-front", "branch": "main", "dirty": 0 }], "path": "D:\\code\\acme-ws\\microfrontends\\web-front", "hints": [], "cloneTo": null, "ok": true, "note": "on main, not feature/login. Use D:\\code\\acme-ws\\microfrontends\\web-front; check out feature/login" },
    { "key": "api", "name": "api", "branch": "feature/login", "state": "missing", "matches": [], "path": null, "hints": [], "cloneTo": "D:\\code\\acme-ws\\microservices\\api", "ok": true, "note": "Not on this machine: clone git@git.acme.example:acme/api.git into D:\\code\\acme-ws\\microservices\\api" }
  ]
}
```

## Session todos (D68, 2026-10-04, additive)

A todo list per session: things that still need doing, kept by the developer and by the session's agent (`docs/todos.md`, `docs/decisions.md` → D68). Additive: migration 0026 (`session_todos`), one `Session` field, one `/hub` event, new routes; nothing existing changes.

- **`Session.openTodoCount`** (number): the session's open items (the sidebar row's count, the Todos nav total). Absent from an older peer = 0.
- **`SessionTodo`** `{ id, sessionId, text, state: open | done, addedBy: developer | agent, position, createdAt, updatedAt, doneAt, removeAt }`: `position` orders the session's items (0 first; open and done share it); `doneAt` is when it was ticked (`null` while open); `removeAt` = `doneAt` + 1 hour, when a done item is removed by itself (`null` while open). `text` is trimmed, 1–1,000 characters; a session keeps at most 200 items.
- **`SessionTodoList`** `{ sessionId, todos: SessionTodo[] (in order), openCount, doneCount }`: what every route under a session answers.
- **Done items** are removed automatically one hour after they were ticked (a sweep at start and a timer, from the stored `doneAt`, so a restart keeps the hour), earlier by Delete or Clear done; unticking before the hour cancels it.

The UI's routes (the `sb_token` cookie; a peer's session id `r~<machine>~<id>` is forwarded to its machine, every one of them is on the peer allow-list):

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | /api/sessions/{id}/todos | | SessionTodoList; 404 `not-found` |
| POST | /api/sessions/{id}/todos | { text } | 201 SessionTodoList (the item at the end, `addedBy: developer`); 422 `invalid`, 409 `too-many` |
| PUT | /api/sessions/{id}/todos/{todoId} | { text?, state?: open \| done } | SessionTodoList; 404 (no such item **in this session**), 422 |
| DELETE | /api/sessions/{id}/todos/{todoId} | | SessionTodoList; 404 |
| POST | /api/sessions/{id}/todos/clear-done | | SessionTodoList (the done items removed now) |
| PUT | /api/sessions/{id}/todos/order | { ids } (every item id of the session, once) | SessionTodoList; 422 when `ids` is not exactly the session's items |
| GET | /api/todos | | TodoGroup[] `{ sessionId, title, solutions, folderPath, machine, lastActivityAt, todos }`: every open session that has items (open and done), most recently active first; this machine's, then the paired machines' as last known (a peer's request gets this machine's own only) |

The agent's routes, called by the built-in `switchboard` MCP server (`src/hook/sb-mcp.ts`) every session Switchboard starts or resumes gets. Not under `/api` and never from a browser: no `Origin` (403), no cookie; only `Authorization: Bearer <agent token>` with the session named in `x-switchboard-session` (401 otherwise). The agent token is HMAC-SHA256 of the session id under the install's secret: it authorizes that one session's list and nothing else (`docs/security.md` → *Agent todo tools (D68)*). Not on the peer allow-list.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | /agent/v1/todos | | SessionTodoList |
| POST | /agent/v1/todos | { text } | 201 `{ todo, list }` (`addedBy: agent`) |
| PUT | /agent/v1/todos/{todoId} | { text?, state? } | `{ todo, list }`; 404 for an item of another session |
| DELETE | /agent/v1/todos/{todoId} | | SessionTodoList |

- **`/hub` `todosChanged`** `{ sessionId, openCount, doneCount }` after every change (the developer's, the agent's, the hour's removal), with the session's `sessionUpdated`. Forwarded between peers (a peer's with its remote session id).
- **Take-over (D65):** `SourceInspect.todos` (optional) carries the list `{ text, state, addedBy, createdAt, doneAt }[]`; the target re-creates it on the new session before the agent's first turn.

```json
{
  "sessionId": "0b7c3e0a-…",
  "todos": [
    { "id": "3f9a1c2b7d4e", "sessionId": "0b7c3e0a-…", "text": "Add a test for PROJ-12's parser", "state": "open", "addedBy": "agent", "position": 0, "createdAt": "2026-10-04T10:00:00.000Z", "updatedAt": "2026-10-04T10:00:00.000Z", "doneAt": null, "removeAt": null },
    { "id": "8b2e6f0a1c3d", "sessionId": "0b7c3e0a-…", "text": "Update the docs", "state": "done", "addedBy": "developer", "position": 1, "createdAt": "2026-10-04T10:01:00.000Z", "updatedAt": "2026-10-04T10:20:00.000Z", "doneAt": "2026-10-04T10:20:00.000Z", "removeAt": "2026-10-04T11:20:00.000Z" }
  ],
  "openCount": 1,
  "doneCount": 1
}
```

## Todo title, description and handover plan (D69, 2026-10-04, additive)

Each item of a session's todo list has three fields instead of one text (`docs/todos.md`, `docs/decisions.md` → D69). Migration 0027 renames the column `text` to `title` and adds `description` and `plan`.

- **`SessionTodo`** gains **`title`** (trimmed, 1–120 characters, one line), **`description`** (for the developer: plain, brief Markdown, at most 4,000 characters; `null` = none) and **`plan`** (the handover plan for an AI agent: context, relevant files, steps, acceptance criteria; Markdown, at most 8,000 characters; `null` = none). **`text`** stays, always equal to `title`, so a paired machine still on 1.7.0 reads the items (D48).
- **Input:** `POST …/todos` and `POST /agent/v1/todos` take `{ title, description?, plan? }`; `PUT …/todos/{todoId}` and `PUT /agent/v1/todos/{todoId}` take `{ title?, description?, plan?, state? }` (only the given fields change; `""` or `null` removes a description or plan). `text` is accepted as an alias of `title` on input (`title` wins when both come). A title over 120 characters or with a line break, a description over 4,000 or a plan over 8,000 is 422 `invalid`.
- **New agent route:** `GET /agent/v1/todos/{todoId}` → `SessionTodo` (one item in full; the `todo_get` tool); 404 for an item of another session. Same guard as the other agent routes.
- **Take-over (D65):** `SourceInspect.todos[]` items also carry `title`, `description` and `plan` (`text` = title stays for a 1.7.0 target). An item from a 1.7.0 source (`text` only) is split like migration 0027: the first line is the title (cut to 119 characters + `…`), the whole text the description when it is longer.
- **Peers (D48):** a 1.7.0 peer's items (no `title`) are read with `title` = `text` and no description or plan. The UI sends `text` with `title` on add and edit, so a 1.7.0 peer adds and renames the item (any 120-character title fits its 1,000-character text). Gap: that peer drops the description and plan (it has no columns for them), and a 1.7.0 UI can add a text over 120 characters or with a line break only to a 1.7.0 machine (this version answers 422).

```json
{ "id": "3f9a1c2b7d4e", "sessionId": "0b7c3e0a-…", "title": "Fix the login test flake", "text": "Fix the login test flake", "description": "Retries hide a race in the session cookie refresh; happens ~1 in 20 runs on CI.", "plan": "## Context\nThe flake is in `tests/login.spec.ts`…\n\n## Steps\n1. …\n\n## Done when\n- 50 runs pass", "state": "open", "addedBy": "agent", "position": 0, "createdAt": "2026-10-04T10:00:00.000Z", "updatedAt": "2026-10-04T10:00:00.000Z", "doneAt": null, "removeAt": null }
```

## Todo priority, estimate and the mandatory plan (D70, 2026-10-04, additive)

Each todo item also has a priority and an estimate, and its handover plan is mandatory (`docs/todos.md` → *Priority, estimate and the mandatory plan (D70)*, `docs/decisions.md` → D70). Migration 0028 adds `priority` and `estimate_minutes` and fills empty plans with `No plan`.

- **`SessionTodo`** gains **`priority`** (`urgent` | `high` | `medium` | `low`, type `TodoPriority`) and **`estimateMinutes`** (how long an AI agent would take, whole minutes 1–10,080; `null` = not estimated). **`plan`** is now always a non-empty string: `No plan` (or `No plan: <reason>`) when there is nothing to plan.
- **Order:** answers keep the stored order (`position`); clients show the open items by priority (urgent first) and by `position` within a level (`splitTodos`), and Move up / down (`PUT …/todos/order`) swaps only within a level. `todo_list` prints the same order.
- **Input:** `POST …/todos` and `POST /agent/v1/todos` also take `priority?` (absent: `medium`) and `estimateMinutes?` (absent: none). An absent, `null` or blank `plan` is stored as `No plan` (never 422: a 1.7.0 / 1.8.0 UI or peer, or an older agent tool, keeps adding). `PUT …/todos/{todoId}` and `PUT /agent/v1/todos/{todoId}` also take `priority?` and `estimateMinutes?` (`null` removes the estimate); a `plan` of `""`, `null` or only spaces is **422** `invalid` (a plan can change but not be emptied). A priority outside the four, or an estimate that is not a whole number from 1 to 10,080, is 422 `invalid`.
- **Agent tools:** `todo_add` requires `title`, `plan`, `priority` and `estimate_minutes` in its JSON schema (the stdio helper refuses a call without them and says what is missing; the server itself still defaults them); `todo_update` takes `priority` and `estimate_minutes` too. The helper sends `estimate_minutes` as `estimateMinutes`. Compact lines: `[3f9a1c2b7d4e] ☐ HIGH ~45m Fix the login test · has description, plan` (`~?` = no estimate; `has plan` only for a real plan, not `No plan`); `todo_get` adds `Priority:` and `Estimate:` lines.
- **Take-over (D65):** `SourceInspect.todos[]` items also carry `priority` and `estimateMinutes`; from an older source they are `medium` / none and a missing plan is `No plan`.
- **Peers (D48):** an item from a 1.7.0 / 1.8.0 peer (no `priority`, `estimateMinutes`, maybe a `null` plan) reads as `medium`, `null`, `No plan`. The UI sends `priority` and `estimateMinutes` on add and edit; an older peer ignores them (its item stays medium, not estimated).

```json
{ "id": "3f9a1c2b7d4e", "sessionId": "0b7c3e0a-…", "title": "Restore checkout for PROJ-7 customers", "text": "Restore checkout for PROJ-7 customers", "description": "Checkout fails for every customer since the last deploy.", "plan": "1. Roll back PROJ-7\n2. Check the logs", "priority": "urgent", "estimateMinutes": 45, "state": "open", "addedBy": "agent", "position": 2, "createdAt": "2026-10-04T10:00:00.000Z", "updatedAt": "2026-10-04T10:00:00.000Z", "doneAt": null, "removeAt": null }
```

## Loose order and shared sidebar layout (D71, 2026-10-05, additive)
Developer request D71 (`docs/decisions.md` → *Shared sidebar layout*): loose sessions get a manual order; the sidebar layout can be shared with paired machines (off until switched on per machine). Additive on *Sidebar pins and folders (D54)* and *Subfolders in the sidebar (D58)*; every D54 / D58 body means what it meant. Migration 0029. Details: `docs/sidebar.md` → *Loose order (D71)* and *Shared layout (D71)*.

- **SidebarLayout** gains `loose: string[]` (always sent): the loose sessions in their manual order, shown after the **unplaced** ones (the listed sessions the layout does not hold, in the service's order). Closed and unknown ids stay in it (hidden), as in `pinned` and `sessionIds`.
- `POST /api/sidebar/place` `{ sessionId, place: "loose", index }`: `index` is the final position in the whole loose list as `GET /api/sessions` lists it (the unplaced sessions first, then `loose`); the unplaced sessions before that position get their places in the same order. Without `index`, `loose` makes the session unplaced (D54's meaning).

- **Shared layout with a paired machine:** `PUT /api/machines/{id}/sidebar-sync` `{ enabled: boolean }` → Machine (404 `not-found`, 422 `invalid`); turning it on runs the first full exchange before answering. **Machine** gains `sidebarSync?: MachineSidebarSync` `{ enabled, state: off | connecting | waiting | unsupported | synced | unreachable | error, mergedAt, lastSyncAt, error }` (`src/core/peers.ts`). Off for every pairing until switched on. A merge from a paired machine publishes `sidebarLayoutChanged` like a local write; `machineState` carries the sync state's changes. Not on the peer API.
- **D113 list sync:** **Machine** gains `listSync?: MachineListSync` `{ artifacts: PeerListSync, inbox: PeerListSync }`, `PeerListSync` = `{ syncing: boolean, syncedAt: string | null }` (`src/core/peers.ts`): whether that list is being fetched from the machine now and when it last arrived. Changes go out on `machineState`. `GET /api/artifacts` and `GET /api/inbox` are unchanged (`docs/peers.md` → *List sync (D113)*).
- **Pinned crews (2.4.4, additive):** `POST /api/sidebar/place { "sessionId": "crew~<team id>", "place": "pinned" | "loose", "index"? }` pins / unpins a crew; the id then appears in `SidebarLayout.pinned` (and `sidebarLayoutChanged`). `place: "folder"` or a `loose` `index` → 422 on `place`. On the D71 wire the place's `key` is the pin id itself (a team id is shared by every paired machine). Details: `docs/sidebar.md` → *Pinned crews*.
- **Peer listener (not the UI contract):** `POST /peer/v1/sidebar` `{ v: 1, full, folders, places }` → `{ v: 1, enabled, folders?, places? }` (`docs/peers.md` → *Shared sidebar layout (D71)*).

```json
SidebarLayout { "pinned": [], "folders": [], "loose": ["a41b…", "r~abcdefghijkl~9f0a…"] }
POST /api/sidebar/place { "sessionId": "a41b…", "place": "loose", "index": 2 }
PUT /api/machines/k3v7q2m9x4ab/sidebar-sync { "enabled": true }
Machine { "id": "k3v7q2m9x4ab", "name": "pc-office", …, "sidebarSync": { "enabled": true, "state": "waiting", "mergedAt": null, "lastSyncAt": null, "error": null } }
```

## Continue a hooked session in Switchboard (D72, 2026-10-05, additive)

A hooked terminal session (D48 P4) becomes a Switchboard-run session **in place** (`docs/peers.md` → *Continuing a hooked session in Switchboard (D72)*, `docs/decisions.md` → D72). No migration: `sessions.hooked` goes to 0 and the process fields are set.

| Method | Path | Body | Answers |
|---|---|---|---|
| POST | /api/sessions/{id}/continue-in-switchboard | ContinueHookedInput `{ confirmStopTerminal?: boolean }` (empty / `{}` = not confirmed) | 200 Session (the same id, `hooked: false`, `attached: true`; a closed one is reopened first, D33) · 404 `not-found` · 409 `not-hooked` · 409 `closed` (only when it was taken over to another machine) · 409 `folder-missing` · 409 `terminal-unknown` (whether the terminal's `claude` runs cannot be told; never taken as gone) · 409 **`terminal-running`** `{ error, message, pid }` until `confirmStopTerminal: true` · 502 `stop-failed` / `agents-unavailable` (the stop failed: nothing else changed) · 422 `invalid` |

- **Terminal running + confirmed:** the D65 terminal stop (`claude agents --json` names the pid; SIGTERM, SIGKILL after 10 s; Windows `taskkill /T`, `/F` after 10 s), then a bounded wait (15 s) until the registry no longer lists it.
- **Then:** the transcript's last turns are imported; the session is resumed with `--resume <claudeSessionId>` in its cwd with the usual injections (standing instruction, the `switchboard` todo tools, the account's env), no message (idle), and the chat event `lifecycle` `action: "continued"`, label `Continued in Switchboard (was a terminal session)` (a divider). Its waiter ends (204), held PermissionRequest calls get no decision (their Inbox items go stale).
| POST | /api/sessions/{id}/events/{eventId}/resend | — | 202 (the message is queued to the session; the old event gets `withdrawn: true`) · 404 `not-found` · 409 `not-resendable` (not a message marked not sent) · 409 `hooked-unavailable` · the supervisor's refusals |

- **Messages the model never saw** (developer ruling 2026-10-05): the mailbox's `hook-message`s (never handed to a waiter) go to the new process as one user message and their old events get `withdrawn: true`; an event handed to a waiter that never reached the transcript is **not** sent again by itself: its **UserPayload** gains `notSent: true` (the bubble's "Not sent" note with **Resend** = the route above).
- **HistoryItem** gains `hooked?: true` on a hooked session's row, open or closed (it offers the action).
- **Peers (D48):** both routes are on `PEER_API_ALLOW`; called with a remote id they run on the terminal's machine and answers the Session mapped to the remote id (the long peer timeout).

```json
{ "error": "terminal-running", "message": "pc-terminal's claude is still running in its terminal (pid 4242): continuing it here stops it there first. Confirm to stop it and continue.", "pid": 4242 }
```

## Devices (D73, 2026-10-08, additive)
Developer request D73 (`docs/decisions.md` → *Devices*, `docs/devices.md`): phones and tablets paired over Tailscale, reaching a second **device listener** (127.0.0.1, published by `tailscale serve`, HTTPS) that serves the **same** API and UI behind its own guard (`docs/security.md` → *Device listener (D73)*). Types: `src/core/devices.ts`. Migration 0030. On the device listener: no `sb_token`; a device's credential is the `__Host-sb_device` cookie; the local-only routes answer 403 `local-only` to a device; an unpaired device gets 401 (page loads: 302 to `/pair`).

| Method | Path | Body | Answers |
|---|---|---|---|
| GET | /api/devices | — | 200 DevicesView `{ access: DeviceAccessState, devices: Device[] }` (local only) |
| PUT | /api/devices/access | DeviceAccessInput `{ enabled?, port?, httpsPort? }` | 200 DeviceAccessState · 422 `invalid` (port = the UI's, an HTTPS port other than 443 / 8443 / 10000) (local only) |
| POST | /api/devices/pairing | — | 200 DevicePairingCode `{ code, expiresAt, url }` (the old code stops working) · 409 `access-off` (local only) |
| DELETE | /api/devices/pairing | — | 204 (local only) |
| PUT | /api/devices/{id} | `{ name }` (1–40) | 200 Device · 404 `not-found` · 422 `invalid` (local only) |
| DELETE | /api/devices/{id} | — | 204 (revoked: its connections closed) · 404 `not-found` (local only) |
| GET | /api/device | — | 200 DeviceSelfView `{ device: Device \| null, vapidPublicKey, events, pushEndpoint }` (`device: null` on this machine's own UI; `pushEndpoint`: the endpoint of the subscription stored for this device, else `null`; additive, 2026-10-13: the page restores a lost subscription, `docs/devices.md` → *Notifications*) |
| PUT | /api/device | `{ name }` | 200 Device · 404 `not-a-device` · 422 `invalid` |
| PUT | /api/device/push | DevicePushInput `{ subscription?: { endpoint, keys: { p256dh, auth } }, events?: Partial<PushEvents> }` | 200 DeviceSelfView · 404 `not-a-device` · 409 `no-subscription` (toggles before a subscription) · 409 `push-gone` (the endpoint was answered 404 / 410 by its push service: never stored again; subscribe anew) · 422 `invalid` / `invalid-subscription` (endpoint not on a known push service) |
| DELETE | /api/device/push | — | 200 DeviceSelfView · 404 `not-a-device` |
| POST | /api/device/push/test | — | 200 `{ ok: true }` / `{ ok: false, error }` · 404 `not-a-device` · 409 `no-subscription` |
| PUT | /api/device/presence | DevicePresenceInput `{ client, visible, focused? }` (`client`: 8–64 of `A–Z a–z 0–9 _ -`) | 204 · 422 `invalid`. Additive (D87): one open page says whether it is in front (recorded for a paired device only; this machine's UI gets 204 and nothing is recorded) |
| GET | /pair | — | device listener only: 200 the pairing page (unpaired), 302 `/` (paired); 404 on the UI listener |
| POST | /device/v1/pair | `{ code, name? }` | device listener only: 201 `{ device: Device }` + `Set-Cookie: __Host-sb_device=…; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Strict` · 400 `no-code` / `expired` / `wrong-code` / `too-many-tries` · 429 `rate-limited`; 404 on the UI listener |

- **DeviceAccessState** `{ enabled, port (default 13003), httpsPort (default 8443), listening: "127.0.0.1:<port>" | null, origin: "https://<machine>.<tailnet>.ts.net:8443" | null, https: "ok" | "off" | "no-tailscale" | "no-https" | "serve-failed" | "port-busy", message, actionUrl }` (`message` says what to enable; `actionUrl` a Tailscale page the CLI named, e.g. Serve's consent).
- **Device** `{ id, name, userAgent, pairedAt, lastSeenAt, push }`: never a credential.
- **PushEvents** `{ permission, questions, turnFinished, errors, inbox }` (booleans, all on by default).
- **Push payload** (Web Push, encrypted per RFC 8291, VAPID RFC 8292; the service worker shows it): `{ title, body (≤ 140), url ("/sessions/<id>" | "/inbox" | "/settings/devices"), tag, kind, id? }` (D87: `id` = the happening's id, the same as the `/hub` `notice`'s; absent on the test notification).
- No `/hub` event of its own: Settings → Devices re-reads `GET /api/devices` while a code waits.
- **D87, additive** (`docs/devices.md` → *No notifications while Switchboard is open*): `GET /hub?client=<id>` names the page (the id of its `PUT /api/device/presence` reports); a paired device counts as **in front** while one of its pages reported `visible` within the last 75 s and its stream is open, and gets no push meanwhile (the test notification excepted; skipped happenings are not sent later). Without `client`, or on this machine's UI, `/hub` is unchanged. The `/hub` **`notice`** event (`DeviceNotice` `{ id, kind, title, body, url, tag }`, the push payload of a happening; this machine's only, never forwarded between peers) is published for every push-worthy happening; a paired device's page shows it as a toast.

```json
GET /api/devices → { "access": { "enabled": true, "port": 13003, "httpsPort": 8443, "listening": "127.0.0.1:13003", "origin": "https://devbox.example-tailnet.ts.net:8443", "https": "ok", "message": null, "actionUrl": null }, "devices": [{ "id": "k3v7q2m9x4ab", "name": "iPhone · Safari", "userAgent": "Mozilla/5.0 (iPhone; …)", "pairedAt": "2026-10-08T10:00:00.000Z", "lastSeenAt": "2026-10-08T10:05:00.000Z", "push": true }] }
POST /api/devices/pairing → { "code": "7KQ2-M9XA", "expiresAt": "2026-10-08T10:10:00.000Z", "url": "https://devbox.example-tailnet.ts.net:8443/pair#code=7KQ2-M9XA" }
PUT /api/device/push { "subscription": { "endpoint": "https://web.push.apple.com/QG…", "keys": { "p256dh": "BC…", "auth": "Tm…" } } }
```

## Todo in progress and ▶ Start that sends (D75, 2026-10-08, additive)

A todo item can be **in progress** between open and done, and ▶ Start sends the item's message to the session instead of filling the composer (`docs/todos.md` → *In progress (D75)*, `docs/decisions.md` → D75). Migration 0031 rebuilds `session_todos` (the state CHECK) and adds `started_at`, `started_by`, `reminded_at`.

| Method | Path | Body | Answers |
|---|---|---|---|
| POST | /api/sessions/{id}/todos/{todoId}/start | — | 200 SessionTodoList (the item `in_progress`, `startedBy: "start"`; its start message sent to the session as a normal user message: queued while the agent is busy, a session without a live process resumed with it, a hooked session's into its mailbox) · 404 `not-found` · 422 `invalid` (a done item: reopen it first) · the message route's refusals (409 `closed` / `detached` / …, a hooked session's `hooked-unavailable`); a refused send leaves the item as it was |

- **`TodoState`** gains **`in_progress`**: `open` → `in_progress` → `done`, and back (`in_progress` → `open`; `done` → `open` reopens). Several items may be in progress at once; they keep their place in the priority order (`splitTodos`: in progress counts as open).
- **`SessionTodo`** gains **`startedAt`** (when it went in progress; kept while done, `null` while open) and **`startedBy`** (`start` = ▶ Start, `agent` = `todo_start`, `developer` = ⋯ → Mark in progress; type `TodoStartSource`). **`SessionTodoList.openCount`** (and `todosChanged.openCount`, `Session.openTodoCount`) counts open **and** in progress (not done); **`inProgressCount`** (new) says how many of them are started.
- **`PUT …/todos/{todoId}`** takes `state: "in_progress"` (⋯ → Mark in progress; `open` = Mark not started); anything but the three states is 422 `invalid`. **`PUT /agent/v1/todos/{todoId}`** with `state: "in_progress"` is the agent's `todo_start` (`startedBy: "agent"`; on an item the developer marked in progress it becomes the agent's start).
- **Start message:** `Work on todo [<id>]: <title>`, a blank line, the plan (else the description), a blank line, `When it's finished, mark it done with todo_done [<id>]; if you stop before it's finished, say what's left.`
- **Finish reminder (setting `sessions.todoReminder`, default `true`):** when one of this machine's sessions goes from `run` to `idle` / `done` while an item started there by ▶ Start or `todo_start` is still `in_progress`, was not reminded for this start, and the agent did not change it during that turn (marking it in progress does not count), Switchboard sends the session one message per such item: `Todo [<id>] '<title>' is still in progress. If it's finished, mark it done with todo_done; if not, say what's left.` (origin `service`; a hooked session only while its waiter is held). Recorded as `reminded_at`: once per item per start (▶ Start again re-arms it).
- **Agent tools:** **`todo_start`** `{ id }` (new, seventh tool); `todo_done` `{ id, done? }` (`done: false` reopens to `open`, not started). Lines show `◐ IN PROGRESS` (`[3f9a1c2b7d4e] ◐ IN PROGRESS HIGH ~45m Fix the login test`), `todo_get` `◐ in progress`.
- **Peers (D48):** the route is on `PEER_API_ALLOW` (its answer is a `todo-list`) and on the devices' allow-list (D73). An item from a peer before D75 has no start (`startedAt` / `startedBy` `null`) and a state other than `in_progress` / `done` reads as `open`. ▶ Start on a peer before D75 (no route: 403 / 404 without `not-found`) sends the start message through `POST …/messages` and leaves the item as it was. A peer before D75 shows another machine's in-progress items as it can (its UI knows open / done only).
- **Take-over (D65):** `SourceInspect.todos[]` items may carry `state: "in_progress"`, `startedAt` and `startedBy`; an older target reads `in_progress` as open.

```json
POST /api/sessions/0b7c3e0a-…/todos/3f9a1c2b7d4e/start
{ "sessionId": "0b7c3e0a-…", "openCount": 2, "doneCount": 1, "inProgressCount": 1, "todos": [{ "id": "3f9a1c2b7d4e", "title": "Fix the login test", "state": "in_progress", "startedAt": "2026-10-08T10:00:00.000Z", "startedBy": "start", "priority": "high", "estimateMinutes": 45, "…": "…" }] }
```

## Todo run in a new session, review, board and actuals (D76, D77, D78, 2026-10-08, additive)

An item can run in a session of its own (D102: marked done it is done; the **review** state below was removed with review cards); the Todos page has a **board**; finished items record what they took (`docs/todos.md` → *Run in a new session (D76)*, *Review (D76)*, *Board (D77)*, *Actual vs. estimate (D78)*; `docs/decisions.md` → D76, D77, D78). Migration 0032 rebuilds `session_todos` (the state CHECK) and adds `sessions.todo_link` and `todo_actuals`.

| Method | Path | Body | Answers |
|---|---|---|---|
| POST | /api/sessions/{id}/todos/{todoId}/run | — | 201 `TodoRunResult` `{ session: Session, list: SessionTodoList, note: string \| null, routing?: string \| null }` (`routing`, additive, D82: the *Model by task* rule's line when one routed the run, else `null`; absent from an older peer): a new supervised session in the source session's folder on branch `todo/<slug>` (free in every repo: `-2`, `-3`, …): in a repo folder a simple start on its own worktree cut from the source session's checked-out branch (or commit); in a workspace folder one worktree per solution repo of the source (`solutions`), each cut from that repo's current branch, at the workspace root (a Full start with the source's router answers, else a simple start with a worktree note); without such a repo, or in a plain folder, in the same folder without a worktree and `note` says so; the source's CLI, model, effort and account unless a D82 rule routes it (`todoRunOptions`); title = the item's (80 characters), first message = its ▶ Start message. The item `in_progress` (`startedBy: "run"`, `runSessionId`, `runState: "active"`), the session `todoLink`. · 404 `not-found` · 422 `invalid` (done or in review) · 409 `already-running` (its run session is open and active) · 409 `no-folder` (the source's folder is no longer saved) · `POST /api/sessions`'s refusals (422 field errors, 409 worktree / folder / CLI refusals); a refused start leaves the item as it was |

- ~~**`TodoState`** gains **`review`**~~ (D102: removed; `TodoState` is `open | in_progress | done`, a stored `review` reads as `done`, `PUT` refuses it with 422). **`TodoStartSource`** gains **`run`**.
- **`SessionTodo`** gains `runSessionId` (`string | null`; kept after the run), `runState` (`"active" | "discarded" | null`), `startedFirstAt`, `actualMs`, `actualTokens` (`number | null`). **`SessionTodoList`** gained `reviewCount` (D102: removed); `openCount` (and `todosChanged.openCount`, `Session.openTodoCount`) counts `open` + `in_progress` only (review is neither open nor done). **`TodoGroup`** gains `actuals` (`TodoActualsTotal | null`: `{ count, estimated, estimateMinutes, estimatedActualMs, actualMs, tokens }` over the session's completed items, also those removed after their done hour). **`Session`** gains `todoLink` (`{ sourceSessionId, todoId } | null`; D130, additive: `sidebarFolder?: { id, name } | null`, a plan item run's sidebar subfolder).
- **`PUT …/todos/{todoId}`:** `state: "done"` is done, also for an item with `runState: "active"` (D102: no `review`, no `skipReview`).
- **Agent routes:** a run session's agent token also reaches its **one linked item** (`todoLink.todoId` in `todoLink.sourceSessionId`, while its run is active): `GET /agent/v1/todos/{todoId}`, `PUT /agent/v1/todos/{todoId}` (answer `{ todo, list, linked: true, calibration }` with the run session's **own** list); `DELETE` and every other item of the source session answer 404. `GET /agent/v1/todos` answers the list plus `linked` (`SessionTodo | null`) and `calibration`; `POST` / `PUT` answers carry `calibration` (`string | null`: the estimate-accuracy line once ≥ 3 completed items with estimates exist: this session's last 10, else its folder's).
- ~~`reviewResolved`~~ (D102: removed with review cards).
- **Result events** gain `payload.tokens` (`number | null`: the turn's `usage` input + cache creation + output tokens), which the actuals add up.
- **Peers (D48):** the run route is on `PEER_API_ALLOW` (answer kind `todo-run`: `session` and `list` namespaced) and on the devices' allow-list (D73); a peer's `runSessionId` and `todoLink.sourceSessionId` are namespaced (`r~<machine>~<id>`). A peer before D76 has no route (403 / 404) and no review state (its items read as before).
- **Take-over (D65):** (a stored `review` travels as done;) a run's start as the developer's.

```json
POST /api/sessions/0b7c3e0a-…/todos/3f9a1c2b7d4e/run
{ "session": { "id": "9d2f…", "title": "Fix the login test", "name": "fix-the-login-test", "cwd": "/repos/app-wt-fix-the-login-test", "todoLink": { "sourceSessionId": "0b7c3e0a-…", "todoId": "3f9a1c2b7d4e" }, "…": "…" }, "list": { "sessionId": "0b7c3e0a-…", "openCount": 1, "reviewCount": 0, "todos": [{ "id": "3f9a1c2b7d4e", "state": "in_progress", "startedBy": "run", "runSessionId": "9d2f…", "runState": "active", "…": "…" }] }, "note": null }
```

## Review queue (D79, 2026-10-08) — removed (D102, 2026-10-14)
Review cards were removed (`docs/decisions.md` → D102): `GET /api/reviews` and `POST /api/reviews/{id}/merge | open-pr | commit | send-back | discard | cleanup | dismiss` answer 404, `InboxItem.kind` has no `review` (`InboxItem.review` is gone), the hub events `reviewResolved` and `reviewsChanged` are gone, the settings key `sessions.reviewCards` is gone (a `PUT` with it is refused, 422), the push toggle `review` is gone (a stored one is ignored). The developer's Merge of a plan item is Plans' own step: *Plans (D99)* → *Merge step (D102)*.

## Undo a turn (D80, 2026-10-08, additive)

Before each turn of a supervised session Switchboard saves a checkpoint of every git working tree the session uses (a hidden ref `refs/switchboard/checkpoints/<session>/<turn>`, built with a throw-away index; the developer's index, HEAD, branch and files are never written); a turn can be reverted to and the revert undone (`docs/undo.md`, `docs/decisions.md` → D80). Migration 0034 adds `turn_checkpoints`; the setting `sessions.checkpoints` (default `true`) switches it off.

| Method | Path | Body | Answers |
|---|---|---|---|
| GET | /api/sessions/{id}/checkpoints | — | 200 SessionCheckpoints · 404 `not-found` |
| GET | /api/sessions/{id}/checkpoints/{turn} | — | 200 CheckpointPlan (what a revert to before `turn` changes; nothing is changed) · 404 `no-checkpoint` / `not-found` · 409 `hooked-unavailable` · 422 `invalid` (`turn` not a positive whole number) |
| POST | /api/sessions/{id}/checkpoints/{turn}/revert | `{ filesOnly?: boolean }` | 200 CheckpointPlan (`filesOnly: true` when the branch was left alone) · 409 `turn-running` · 409 `files-only-needed` (`{ error, message, plan }`: the branch cannot go back; send again with `filesOnly: true`) · 404 `no-checkpoint` · 409 `hooked-unavailable` · 422 `invalid` · 500 `revert-failed` |
| POST | /api/sessions/{id}/checkpoints/redo | — | 200 CheckpointPlan (the newest revert undone) · 409 `nothing-to-redo` (none, or a message was sent since) · 409 `turn-running` |

- **`SessionCheckpoints`:** `enabled` (the setting), `unsupported` (why this session gets none: a hooked terminal session, a folder that is no git repository, the setting off; else `null`), `turns: CheckpointTurn[]` (oldest first: `turn`, `eventId` = the user message's event, `createdAt`, `repos` = the working trees' top-level folders, `firstLine`), `latestTurn` (the session's user messages so far), `running` (a turn runs: a revert is refused), `redo: { turn, eventId } | null` (`eventId` = the newest revert's divider).
- **`CheckpointPlan`:** `turn`, `firstLine`, `latestTurn`, `repos: CheckpointRepoPlan[]` (`path`, `name`, `files: { path, change: "added" | "modified" | "deleted" }[]` — at most 200; `added` = restored, `deleted` = removed —, `fileCount`, `head: { action: "none" | "reset" | "refused", branch, commits, to, reason }`), `filesOnlyReason` (why the branch cannot go back: another branch, a rewritten history, pushed commits; `null` = it can), and in an answer `filesOnly`.
- **The turn number** is the user message's place among the session's user messages (1 = the first); the UI takes it from `turns[].eventId`, never counts itself.
- **Events:** a revert writes a lifecycle event `{ type: "lifecycle", action: "reverted", turn, latestTurn, filesOnly }` with the label `Reverted to before turn N` (the chat's divider); Redo `action: "revert-undone"`, `Undid the revert to before turn N`. Both arrive on `/hub` as `event`.
- **The agent's note:** queued in the outbox (`pending_messages.kind` `checkpoint-note`) and sent with the next message: `Switchboard reverted the files to before turn N (<first line>); changes made in turns N..M are gone. Don't rely on them.` Redo withdraws it while undelivered, else queues `Switchboard undid its revert to before turn N: …`.
- **Settings:** `sessions.checkpoints` (boolean, editable, default `true`).
- **Peers (D48) and devices (D73):** all four routes are on `PEER_API_ALLOW` (answers pass unmapped: `none`) and on the devices' allow-list. A peer before D80 answers 403 `peer-forbidden` / 404: the UI then shows no turn actions and no *Undo last turn* for its sessions.

```json
GET /api/sessions/0b7c3e0a-…/checkpoints
{ "enabled": true, "unsupported": null, "latestTurn": 3, "running": false, "redo": null,
  "turns": [{ "turn": 1, "eventId": 412, "createdAt": "2026-10-08T10:00:00.000Z", "repos": ["/Users/me/dev/shop-front"], "firstLine": "Fix the header" }] }

POST /api/sessions/0b7c3e0a-…/checkpoints/1/revert   {}
409 { "error": "files-only-needed", "message": "The branch cannot be moved: 1 of the 2 commits made on main since this turn is already pushed. Only the files can be reverted.",
      "plan": { "turn": 1, "repos": [{ "name": "shop-front", "fileCount": 3, "head": { "action": "refused", "branch": "main", "commits": 2, "to": "4be1…", "reason": "1 of the 2 commits made on main since this turn is already pushed" }, "…": "…" }], "…": "…" } }
```

## Quick capture (D81, 2026-10-08, additive)

A todo can be captured quickly: the ⌘K palette's `todo <text>` / **Add todo…**, a chat selection's **Add to todo**, and the phone's share sheet (the device origin's app is a Web Share Target). The item is saved bare and, by default, its session's agent is asked once, when it is next idle, to fill it in (`docs/todos.md` → *Quick capture (D81)*, `docs/devices.md` → *Share to Switchboard (D81)*, `docs/decisions.md` → D81). Migration 0035 adds `needs_enrichment`, `captured_from`, `enrich_asked_at` to `session_todos` (ADD COLUMN only).

| Method | Path | Body | Answers |
|---|---|---|---|
| POST | /api/sessions/{id}/todos/capture | CaptureTodoInput `{ title, note?, from: "palette" \| "selection" \| "share" }` | 201 SessionTodoList (the item: `title`, `description` = `note`, plan `No plan`, priority `medium`, no estimate, `addedBy: "developer"`, `capturedFrom` = `from`, `needsEnrichment` = the setting) · 404 `not-found` · 422 `invalid` (title as D69; `from` unknown) · 409 `too-many` |
| POST | /share-target | form `title`, `text`, `url` (`application/x-www-form-urlencoded`) | device listener only: 303 to `/share?title=…&text=…&url=…` (each field cut to 4,000 characters, empty ones left out; normally the service worker answers this itself); 404 on the UI listener |
| GET | /manifest.webmanifest | — | on the device listener the manifest gains `share_target: { action: "/share-target", method: "POST", enctype: "application/x-www-form-urlencoded", params: { title: "title", text: "text", url: "url" } }`; the UI listener's has none |

- **`SessionTodo`** gains **`needsEnrichment`** (`true` while a captured, open item waits for its agent; `false` otherwise; absent from an older peer) and **`capturedFrom`** (`TodoCaptureSource` or `null`).
- **The mark is cleared** by the agent's `PUT /agent/v1/todos/{todoId}` with any field (its `todo_update`), and by the developer's `PUT …/todos/{todoId}` that changes the description, plan, priority or estimate (not a title-only edit). Marking it in progress or done hides it (`needsEnrichment` is `false` for a non-open item).
- **The one message (setting `sessions.todoEnrich`, default `true`):** when one of this machine's sessions is idle (status `idle` / `done`: not running, not waiting on the developer; not closed, paused or detached) and has captured open items not asked yet, Switchboard sends it one message (origin `service`): `The developer added todo [<id>] '<title>' (<note if any>). Fill in its description, handover plan, priority and estimate with todo_update — don't start it.`; several items in one message (`The developer added todos [<a>] '<A>', [<b>] '<B>' (…). Fill in their description, handover plan, priority and estimate with todo_update — don't start them.`); the note is one line, cut to 200 characters. Checked on every `todosChanged` (a capture) and `sessionUpdated` of the session. Recorded as `enrich_asked_at`: at most once per item. A hooked terminal session only while its waiter is held (else nothing is recorded and a later check tries again). With the setting off, captures are stored without the mark.
- **Peers (D48):** the route is on `PEER_API_ALLOW` (its answer is a `todo-list`); the session's own machine asks its agent. A peer before D81 (403, or 404 without `not-found`): the UI adds the item through `POST …/todos` (`title`, `description` = the note), bare and unmarked.
- **Devices (D73):** the route is on the devices' allow-list (normal use). `/share` is a page (the app's index.html; a paired device's page load).

```json
POST /api/sessions/0b7c3e0a-…/todos/capture { "title": "Look at the checkout flicker", "note": "> The checkout page flickers when the cart updates.", "from": "selection" }
{ "sessionId": "0b7c3e0a-…", "openCount": 1, "doneCount": 0, "inProgressCount": 0, "todos": [{ "id": "7d2e9a01b4c3", "title": "Look at the checkout flicker", "description": "> The checkout page flickers when the cart updates.", "plan": "No plan", "priority": "medium", "estimateMinutes": null, "needsEnrichment": true, "capturedFrom": "selection", "…": "…" }] }
```

## Model by task (D82, 2026-10-08, additive)

Settings → Sessions → *Model by task* (`docs/model-routing.md`, `docs/decisions.md` → D82): ordered rules that pick the CLI, model, effort and account a todo runs with by its priority and estimate. No new route: the rules are the editable setting **`sessions.modelRules`** of `GET` / `PUT /api/settings` (default `[]` = off). No migration.

- **`ModelRule`**: `id` (1–64 characters, unique), `priority` (`any` / `urgent` / `high` / `medium` / `low`), `estimate` (`{ kind: "any" }`, `{ kind: "at-most", minutes }`, `{ kind: "more-than", minutes }` or `{ kind: "unknown" }`; minutes 1–10080), and any of `provider` (`claude` / `codex` / `opencode`), `model`, `effort`, `profileId`; at least one of them; a `model` / `effort` / `profileId` needs the `provider`. At most 50 rules; the first that matches wins.
- **`PUT /api/settings`** with `sessions.modelRules` answers 422 `invalid` with `errors[].field` = `sessions.modelRules[<i>]` / `…[<i>].<part>` for a bad shape, a model the CLI does not offer (its reported list, `GET /api/models?provider=`, else Claude Code's aliases / another CLI's `default`), an effort the model lacks, or an account that is not one of that CLI's enabled profiles. Nothing is stored on a refusal. Devices may save it (`PUT /api/settings` is on their allow-list); it is not on the peer API.

```json
PUT /api/settings
{ "sessions.modelRules": [
  { "id": "r1", "priority": "low", "estimate": { "kind": "at-most", "minutes": 30 }, "provider": "claude", "model": "sonnet" },
  { "id": "r2", "priority": "any", "estimate": { "kind": "more-than", "minutes": 120 }, "provider": "codex", "profileId": "a1b2…" }
] }
```

## Continue in a fresh session (D83, 2026-10-08, additive)

When a supervised session's context fills, it can continue in a fresh session (`docs/fresh-session.md`, `docs/decisions.md` → D83): the agent writes a handover in one turn, a new session starts in the same folder / worktree / branch on the same CLI, model, effort and account with the handover as its first message, takes the old one's sidebar place, todo list and pin, and the old one is closed. Migration 0036 adds `sessions.continued_to` / `continued_from`.

| Method | Path | Body | Answers |
|---|---|---|---|
| POST | /api/sessions/{id}/fresh | `{}` (none needed) | 202 `FreshContinueResult` `{ session }` (the old session, `freshContinue: { step: "handover" }`) once the handover was asked for; the rest runs on, its progress on `sessionUpdated` · 404 `not-found` · 409 `hooked-unavailable` (a hooked terminal session; the message says why) · 409 `turn-running` (a turn runs or waits: offered once it ends) · 409 `switching` (a CLI / account switch or a continuation runs) · 409 `closed` / `detached` · 503 `closing` |

- **`Session.continuedTo`** / **`continuedFrom`** (additive): `SessionLink` `{ sessionId, title }` — on the old (closed) session the fresh one ("Continued in <title>"), on the fresh one the old one ("Continued from <title>"); `title` is `null` once that session was deleted; `null` / absent otherwise. A paired machine's are namespaced (`r~<machine>~<id>`).
- **`Session.freshContinue`** (additive): `{ step: "handover" | "starting" }` while a continuation runs, `null` / absent otherwise. Messages to the session are refused meanwhile (409 `switching`).
- **Lifecycle events** (`LifecyclePayload.action`, additive): `continued-from` (the fresh session's first divider, label `Continued from <old title>`) and `continued-in` (the old session's, `Continued in <new title>`; kind `error` with `message` when a continuation failed: `Could not continue in a fresh session: <why>`), both with `linkedSessionId` (namespaced for a peer's) and `linkedTitle`.
- **Settings** (additive, editable): `sessions.freshOffer` (boolean, default `true`) and `sessions.freshOfferPct` (whole number 50–95, default 80; 422 otherwise).
- **`HistoryItem.continuedTo`** / **`continuedFrom`** (additive): the same links on a stored session's History row.
- **The fresh session:** name `<old name>-<n>` and title `<old title> (<n>)` (a continued session counts on), the old one's folder, cwd, branch, branching, CLI, model, effort, account and pin; a new conversation of its CLI; its todos are the old session's (moved: ids and states kept) and so are its worktrees.
- **Peers (D48):** the route is on `PEER_API_ALLOW`; its answer is mapped `wrapped`. **Devices (D73):** on `DEVICE_ALLOWED`.

```json
POST /api/sessions/0b7c3e0a-…/fresh
{}
→ 202 { "session": { "id": "0b7c3e0a-…", "status": "run", "freshContinue": { "step": "handover" }, "continuedTo": null, "…": "…" } }
sessionUpdated (later, the old session) { "id": "0b7c3e0a-…", "closedAt": "2026-10-08T10:02:00.000Z", "continuedTo": { "sessionId": "5e1f…", "title": "Fix login (2)" }, "freshContinue": null, "…": "…" }
```

## Clean-up (D84, 2026-10-08, additive)
Developer ruling D84 (`docs/decisions.md`, `docs/cleanup.md`): Settings → Clean-up lists what Switchboard created and no longer needs and removes only what the developer ticks and confirms. Types: `src/core/cleanup.ts`. No migration (the closed-session limit and the created-branches record are settings values). **This machine only:** every route answers a peer request 403 `peer-forbidden` (not on `PEER_API_ALLOW`) and a paired device 403 `local-only` (`DEVICE_REFUSED`).

| Method | Path | Body | Answers |
|---|---|---|---|
| GET | /api/cleanup | — | 200 CleanupScan `{ scannedAt, closedSessionDays, staleDays, items: CleanupItem[], notes: string[] }` (the dry run; changes nothing, no network) |
| PUT | /api/cleanup/settings | `{ closedSessionDays }` (whole number 1–3650) | 200 `{ closedSessionDays }` · 422 `invalid` |
| POST | /api/cleanup/runs | `{ items: [{ id, fingerprint, confirm? }] }` (≥ 1, distinct ids; `confirm` = `uncommitted` \| `unmerged` \| `remote`) | 202 CleanupRun · 422 `invalid` · 422 `confirmation-required` (`items`: the ids that need one; nothing runs) · 409 `busy` |
| GET | /api/cleanup/runs/{runId} | — | 200 CleanupRun · 404 `not-found` |

`CleanupItem`: `{ id, group: worktrees | localBranches | remoteBranches | sessions | data, title, subtitle, reasons: CleanupReason[], sizeBytes: number | null, sizeCapped, lastChangeAt: string | null, removes: string[], keeps: string[], warnings: [{ kind: CleanupConfirm, message, files: string[] }], confirm: CleanupConfirm | null, selected, fingerprint }`. `CleanupRun`: `{ id, startedAt, finishedAt: string | null, items: [{ id, group, title, status: pending | running | done | failed, error: string | null, sizeBytes: number | null }], summary: { done, failed, freedBytes } }`. A run re-scans; an item no longer listed or whose fingerprint changed fails alone ("changed since the preview: scan again"); every other item still runs.

```json
POST /api/cleanup/runs
{ "items": [
  { "id": "wt:5d0c…", "fingerprint": "8e1f0a2b3c4d5e6f" },
  { "id": "rb:91ab…", "fingerprint": "0a9b8c7d6e5f4a3b", "confirm": "remote" }
] }
→ 202
{ "id": "c1f2…", "startedAt": "2026-10-08T18:23:35.000Z", "finishedAt": null,
  "items": [
    { "id": "wt:5d0c…", "group": "worktrees", "title": "/Users/me/src/web-front-wt-checkout", "status": "pending", "error": null, "sizeBytes": null },
    { "id": "rb:91ab…", "group": "remoteBranches", "title": "origin/session/checkout", "status": "pending", "error": null, "sizeBytes": null }
  ],
  "summary": { "done": 0, "failed": 0, "freedBytes": 0 } }
```

## Tutorial (D85, 2026-10-08, additive)
Developer ruling D85 (`docs/decisions.md`, `docs/tutorial.md`): the interactive tutorial's state, **one per machine** (migration 0037). Types: `src/core/tutorial.ts`. A paired device may call both routes (`DEVICE_ALLOWED`); they are not on the peer API (`PEER_API_ALLOW`).

| Method | Path | Body | Answers |
|---|---|---|---|
| GET | /api/tutorial | — | 200 TutorialState. The first read after a start catches up: a new install's main tour, or the What's-new features newer than `lastVersion`, are queued (`pending`), and `lastVersion` becomes this build's version. |
| PUT | /api/tutorial/tours/{id} | `{ status: "completed" \| "skipped" }` | 200 TutorialState · 404 `not-found` (`id` is not `main` or a registry feature id) · 422 `invalid` |

`TutorialState`: `{ autoOpen, install: "new" | "existing", lastVersion, main: TourRecord, whatsNew: [{ id, title, version, status, updatedAt }] }`; `TourRecord` = `{ status: "pending" | "completed" | "skipped" | null, updatedAt: string | null }` (`null` = never queued; a replay still works). `autoOpen` is `false` in demo mode and with `SWITCHBOARD_TUTORIAL=off`. The UI opens by itself the main tour when it is `pending`, else the `pending` What's-new tours in registry order; a replay (Settings → Tutorial, ⌘K → Tutorial) sends no `PUT`.

```json
GET /api/tutorial
→ 200
{ "autoOpen": true, "install": "existing", "lastVersion": "1.13.0",
  "main": { "status": null, "updatedAt": null },
  "whatsNew": [
    { "id": "run-in-new-session", "title": "Run in new session", "version": "1.13.0", "status": "pending", "updatedAt": "2026-10-08T19:02:11.000Z" },
    { "id": "todo-board", "title": "Todos board", "version": "1.13.0", "status": "completed", "updatedAt": "2026-10-08T19:03:40.000Z" }
  ] }

PUT /api/tutorial/tours/run-in-new-session
{ "status": "skipped" }
→ 200 TutorialState
```

## Drafts (D88, 2026-10-09, additive)
Developer ruling D88 (`docs/decisions.md`, `docs/chat.md` → *Drafts*): the unsent values of a session's fields, kept on the machine that runs the session (migration 0038). Types: `src/core/drafts.ts`. A paired device may call every route (`DEVICE_ALLOWED`); they are on the peer API (`PEER_API_ALLOW`), so a paired machine's session (`r~<machine>~<id>`) is forwarded there and its drafts live on that machine.

| Method | Path | Body | Answers |
|---|---|---|---|
| GET | /api/sessions/{id}/drafts | — | 200 SessionDraft[] (by field; a composer draft's chips only while their upload exists in the session) · 404 `not-found` |
| PUT | /api/sessions/{id}/drafts/{field} | `{ value, client? }` | 200 SessionDraft · 204 when `value` is empty (the draft is cleared) · 404 `not-found` · 409 `too-many` (200 drafts) · 413 `too-large` (the value's JSON over 64 KB) · 422 `invalid` (unknown field, a value not of the field's shape) |
| DELETE | /api/sessions/{id}/drafts/{field}[?client=] | — | 204 (also when there was none) · 404 `not-found` · 422 `invalid` |
| GET | /api/drafts | — | 200 SessionDraft[] (this machine's own drafts, ruling 2026-10-09) |
| PUT | /api/drafts/{field} | `{ value, client? }` | 200 SessionDraft · 204 when `value` is empty · 409 `too-many` (20 drafts) · 413 `too-large` · 422 `invalid` |
| DELETE | /api/drafts/{field}[?client=] | — | 204 (also when there was none) · 422 `invalid` |

`field`: `composer` · `todo-add` · `question:<batchId>` · `todo-edit:<todoId>` (D102: `review:<reviewId>` and `commit:<reviewId>` were removed with review cards) (ids `[A-Za-z0-9._-]`, the session machine's own). `value` by field: composer `{ text, attachments: [{ id, name, size, kind, mediaType }] }`; question `{ picks: { <questionId>: <option index> | { text, editing } } }`; review `{ comment }`; todo-add / todo-edit `{ title, description, plan, priority, estimate }` (the estimate as typed); commit `{ message }` (the Commit message as edited; empty = the drafted one). `SessionDraft` = `{ field, value, updatedAt, updatedBy }`, `updatedBy` = `local` / `device:<id>` / `peer`, then `/<client>` when the page sent one. `client` = the page's id (`[A-Za-z0-9_-]{1,64}`), echoed in `draftChanged`. Each save or clear that changed something publishes `draftChanged`.

**Ruling 2026-10-09 (additive):**
- **Machine drafts** (`/api/drafts`, migration 0040): fields that belong to no session, kept on this machine only (not on `PEER_API_ALLOW`; allowed to paired devices). `field`: `new-session`, the New-session dialog's form, `value` = `{ form: { name, task, workType, mode, solutions, phase, coordination, stack, confluenceUrl, figmaUrls, worktrees, ultracode, folder, branch, model: { model, effort } | null, provider, profileId }, simpleBranch: string | null }` (unknown keys dropped); empty (204, cleared) while no text is typed (name, task, the QA links, branch, simpleBranch). A session field on `/api/drafts`, or `new-session` on a session's route, is 422 `invalid`. `draftChanged` then carries `sessionId: null`.
- **Orphan clean-up:** the server deletes a session's draft once its target is gone and publishes `draftChanged` with `client: null`: `question:<batchId>` when the batch is answered or closed (not one closed by the session's close), `review:` / `commit:<reviewId>` when the review is no longer `pending`, `todo-edit:<todoId>` when the item is deleted, done or in another session. Closing a session removes no draft.

```json
PUT /api/drafts/new-session
{ "value": { "form": { "task": "Checkout screen at 640", "name": "", "solutions": [], "worktrees": true }, "simpleBranch": null }, "client": "9f2c41aa07d3e5b1c8a0f6d2" }
→ 200
{ "field": "new-session", "value": { "form": { "name": "", "task": "Checkout screen at 640", "worktrees": true, "solutions": [] }, "simpleBranch": null },
  "updatedAt": "2026-10-09T10:12:40.501Z", "updatedBy": "local/9f2c41aa07d3e5b1c8a0f6d2" }

PUT /api/sessions/5b0c…/drafts/composer
{ "value": { "text": "Half a thought about the upload", "attachments": [] }, "client": "9f2c41aa07d3e5b1c8a0f6d2" }
→ 200
{ "field": "composer", "value": { "text": "Half a thought about the upload", "attachments": [] },
  "updatedAt": "2026-10-09T10:14:02.118Z", "updatedBy": "local/9f2c41aa07d3e5b1c8a0f6d2" }

GET /api/sessions/5b0c…/drafts
→ 200
[ { "field": "composer", "value": { "text": "Half a thought about the upload", "attachments": [] }, "updatedAt": "2026-10-09T10:14:02.118Z", "updatedBy": "local/9f2c41aa07d3e5b1c8a0f6d2" },
  { "field": "todo-edit:3fa81c0d22b9", "value": { "title": "Add a changelog line", "description": "", "plan": "No plan", "priority": "medium", "estimate": "" }, "updatedAt": "2026-10-09T10:15:40.003Z", "updatedBy": "device:k2m4q7x9z3ab/51d0c7e2a4b8f913" } ]

DELETE /api/sessions/5b0c…/drafts/composer?client=9f2c41aa07d3e5b1c8a0f6d2
→ 204
```

## Artifacts saved on purpose (D89, 2026-10-09, changed)
Developer request D89 (`docs/decisions.md`, `docs/artifacts.md`): artifacts are only what is **saved on purpose**: by the session's agent (the `switchboard` MCP tool `artifact_save`) or by the developer (Save as artifact on a chat message). This **replaces** the derived artifacts (gap #9): `Artifact` changes shape, `GET /api/artifacts` changes its filters, and the recorder no longer derives rows. Migration 0039. Types: `src/core/api.ts`, rules: `src/core/artifacts.ts`. A paired machine's session goes through the proxy like every session route (`PEER_API_ALLOW`; a version's bytes pass through as bytes with their headers); a paired device may call every route below (`DEVICE_ALLOWED`).

| Method | Path | Body | Answers |
|---|---|---|---|
| GET | /api/artifacts | `?kind=` (kinds separated by commas), `?session=` (a session id), `?q=` (title, kind, language, session name / title, machine) | 200 ArtifactListItem[], newest first: this machine's and the paired machines' (as last known) |
| GET | /api/sessions/{id}/artifacts | — | 200 Artifact[] (newest first) · 404 `not-found` |
| POST | /api/sessions/{id}/artifacts | ArtifactSaveInput without `path` (body up to ~6 MB) | 201 ArtifactSaveResult (saved by the developer) · 404 · 409 `too-many` · 413 `too-large` · 422 `invalid` |
| GET | /api/sessions/{id}/artifacts/{artifactId} | `?version=n` (default: the latest) | 200 ArtifactDetail · 404 `not-found` · 422 `invalid` |
| DELETE | /api/sessions/{id}/artifacts/{artifactId} | — | 204 · 404 `not-found` |
| DELETE | /api/artifacts/{artifactId} | — (D111, additive: an artifact whose session is gone; a paired machine's through `/api/machines/{id}/api/artifacts/{artifactId}`) | 204 (versions and files removed; `artifactsChanged` with `sessionId: null`) · 404 `not-found` · 409 `has-session` while its session exists (its message names the session route) |
| GET | /api/sessions/{id}/artifacts/{artifactId}/versions/{n}/raw | `?download` | 200 the version's bytes: `html` as `text/html` under the sandbox CSP, `svg` as `image/svg+xml` and images as their type under a CSP that runs nothing, D126 `pdf` as `application/pdf` under `frame-ancestors 'self'` (no sandbox), other text as `text/plain`; `nosniff`; `?download` = attachment named after the title (`docs/security.md` → *Artifacts*); ruling 2026-10-09: `?render` on a Mermaid version = an HTML page (the HTML CSP) that draws it with the inlined Mermaid bundle · 404 |
| GET | /agent/v1/artifacts | — (agent token) | 200 Artifact[] of the token's session (`artifact_list`) |
| POST | /agent/v1/artifacts | ArtifactSaveInput (`path` allowed: a file inside the session's folders, copied now) | 201 ArtifactSaveResult (saved by the agent; `artifact_save`) · the refusals above |
| GET | /agent/v1/artifacts/{artifactId} | `?version=n` | 200 ArtifactDetail (`artifact_get`) |

- `ArtifactKind`: `markdown` · `code` · `html` · `mermaid` · `svg` · `image` · `pdf` (D126) · `csv`.
- `Artifact`: `{ id, sessionId: string | null, title, kind, language: string | null, createdBy: "agent" | "developer", versions, size, createdAt, updatedAt }` (`versions` = the latest version's number, `size` its bytes). `SessionDetail.artifacts` is `Artifact[]` (its length is the header's tab count).
- `ArtifactVersionInfo`: `{ n, size, createdBy, createdAt }`. `ArtifactDetail` = `Artifact` + `versionList: ArtifactVersionInfo[]` (oldest first) + `version: ArtifactVersionInfo & { content: string | null }` (`null` for an image or a PDF).
- `ArtifactListItem` = `Artifact` + `sessionName`, `sessionTitle`, `folder`, `folderPath` (`null` without a session) + `machine?` (a paired machine's).
- `ArtifactSaveInput`: `{ title, kind, content?, path?, language?, id? }`: `content` or `path` (not both; an `image` or a `pdf` needs `path`), `id` = one of the session's artifacts (the save adds a version; the kind must stay). Limits: title one line ≤ 120 characters; text ≤ 2 MB; image ≤ 10 MB (png / jpg / gif / webp by its bytes); pdf ≤ 25 MB (starts with `%PDF-`); ≤ 100 versions per artifact; ≤ 200 artifacts per session.
- `ArtifactSaveResult`: `{ artifact: Artifact, version, created }`.
- `/hub` gains `artifactsChanged` (table below).

```json
POST /agent/v1/artifacts
{ "title": "Release plan", "kind": "markdown", "content": "# Release plan\n\n1. Ship\n", "id": "a1b2c3d4e5" }
→ 201
{ "artifact": { "id": "a1b2c3d4e5", "sessionId": "checkout-redesign", "title": "Release plan", "kind": "markdown", "language": null,
    "createdBy": "agent", "versions": 2, "size": 24, "createdAt": "2026-10-09T10:00:00.000Z", "updatedAt": "2026-10-09T10:05:00.000Z" },
  "version": 2, "created": false }
```

## Diff views (D90, 2026-10-09, additive)
Developer ruling D90 (`docs/decisions.md`; details `docs/worktrees.md` → *Diff*): the Diff tab opens on the work since the last commit. Types: `src/core/api.ts` (`DiffScope`, `DiffTargets`).

| Method | Path | Query | Answers |
|---|---|---|---|
| GET | /api/sessions/{id}/diff | `file` (as before), `scope` = `head` (default) \| `branch` \| `repo` | 200 FileDiff[] · 404 `not-found` · 422 `invalid` (`field: "scope"` for another or a repeated value) |
| GET | /api/sessions/{id}/diff/targets | — | 200 DiffTargets · 404 `not-found` |
| GET | /api/sessions/{id}/diff/count | `scope` = `head` (default) \| `branch` \| `repo` | 200 DiffCount · 404 `not-found` · 422 `invalid` (`field: "scope"`) |

- **`scope`:** `head` = uncommitted changes against HEAD (staged, unstaged, untracked; never ignored) in the session's working trees, and in a solution it works on in place only the files the session touched (its Write / Edit / MultiEdit / NotebookEdit paths and, with D80 checkpoints, what changed during its turns); `repo` = every uncommitted change against HEAD; `branch` = the behavior before D90 (a worktree against the merge-base with its base branch, in place against HEAD). **A behavior change:** a request without `scope` now gets `head`; ask `scope=branch` for the old list. `SessionDetail.files` is unchanged (the whole branch).
- **`FileDiff.lines`** now also carries each hunk's `@@ -a,b +c,d @@` header line before its body (a new untracked file: `@@ -0,0 +1,N @@`). A reader that knows only `+` / `-` / space may show it as context.
- **`DiffTargets`:** `{ worktrees: [{ solution, branch, base: string | null, commits: number }], inPlace: [{ solution, branch: string | null }] }`: the working trees the diff reads; `base` = the worktree's base ref, `commits` = commits on its branch since the merge-base with it (0 when it does not resolve). The tab offers Whole branch with a worktree and All uncommitted changes with an in-place solution.
- **`DiffCount` (ruling 2026-10-09):** `{ scope, files }`: how many files the Diff tab's view lists, for the session tab's **Diff · n** (file names only, no patches). `scope` is the view counted: the asked one when the session offers it (`branch` with a worktree, `repo` with an in-place solution), else `head`, which is what the tab shows then. `files` equals the length of `GET …/diff?scope=<that scope>`.
- **Peers (D48):** the query passes through; `GET …/diff/targets` and `GET …/diff/count` are on `PEER_API_ALLOW`. A peer before D90 answers its old diff whatever the `scope` and refuses the targets (403 `peer-forbidden`): the UI then offers only the default view. A peer before the count refuses it: the tab count then reads `SessionDetail.files` (the whole branch). **Devices (D73):** all three routes are allowed.

```json
GET /api/sessions/0b7c3e0a-…/diff?scope=head
→ 200
[{ "solution": "web-front", "path": "README.md", "branch": "PROJ-42-diff", "added": 1, "removed": 0,
   "lines": ["@@ -1 +1,2 @@", " hello", "+more"], "uncommitted": true }]

GET /api/sessions/0b7c3e0a-…/diff/targets
→ 200
{ "worktrees": [{ "solution": "web-front", "branch": "PROJ-42-diff", "base": "origin/dev", "commits": 2 }],
  "inPlace": [{ "solution": "mobile", "branch": "main" }] }

GET /api/sessions/0b7c3e0a-…/diff/count?scope=repo
→ 200
{ "scope": "repo", "files": 4 }

GET /api/sessions/0b7c3e0a-…/diff?scope=all
→ 422 { "error": "invalid", "errors": [{ "field": "scope", "message": "scope must be one of head, branch, repo" }] }
```

## Apply the standing instruction (D91, 2026-10-09, additive)
Developer ruling D91 (`docs/decisions.md`; details `docs/settings.md` → *Apply to open sessions*): the D64 standing instruction can be given to the sessions already running. Types: `src/core/standing-instruction.ts` (`InstructionApplyResult`, `InstructionReloadResult`, `InstructionReloadOutcome`); `Session.instructionOutdated` / `instructionPending` in `src/core/api.ts`.

| Method | Path | Body | Answers |
|---|---|---|---|
| POST | /api/settings/standing-instruction/apply | `{}` | 200 InstructionApplyResult |
| POST | /api/sessions/{id}/reload-instruction | `{}` | 200 `{ outcome, session }` · 404 `not-found` · 409 `not-available` (hooked), `detached`, `switching`, `closed`, `folder-missing`, `cli-unavailable` · 502 `reload-failed` · 503 `closing` |

- **`outcome`:** `restarted` (idle: the process was restarted with `--resume`, no message; the chat gets the lifecycle event `instruction-updated`, label "Standing instruction updated", a divider), `pending` (a turn runs or the session waits on the developer: restarted once idle), `current` (already on it), `not-running` (no process: its next start gets it).
- **`InstructionApplyResult`:** `{ restarted: string[], notRunning: number, pending: string[], current: number, skipped: number, failed: [{ sessionId, title, reason }] }` over this machine's open sessions; `skipped` = hooked terminal sessions and sessions continued in a terminal. A failed session is left as it was.
- **`Session.instructionOutdated`** (additive): the session's running process was started with another standing instruction than the current setting; `false` without a process. **`instructionPending`**: a reload waits for the turn's end. A `PUT /api/settings` that changes `agents.standingInstruction` or `.enabled` publishes `sessionUpdated` for the live sessions.
- **Devices (D73):** `…/reload-instruction` is allowed; `…/standing-instruction/apply` is refused (`local-only`). **Peers (D48):** neither is on `PEER_API_ALLOW`; a paired machine's sessions are applied there.

```json
POST /api/settings/standing-instruction/apply
→ 200
{ "restarted": ["0b7c3e0a-…"], "notRunning": 1, "pending": ["5f1d…"], "current": 0, "skipped": 1,
  "failed": [{ "sessionId": "9a2e…", "title": "fix-login", "reason": "the session's folder does not exist: /work/gone" }] }

POST /api/sessions/0b7c3e0a-…/reload-instruction
→ 200
{ "outcome": "restarted", "session": { "id": "0b7c3e0a-…", "instructionOutdated": false, "instructionPending": false } }
```

## Switchboard loops (D94, 2026-10-09, additive)
Developer ruling D94 (`docs/decisions.md`; details `docs/loops.md`): loops Switchboard fires itself into a session. Types in `src/core/api.ts`: `OwnedLoop`, `OwnedLoopInput`, `OwnedLoopSchedule`; `Session.ownedLoops` (additive, oldest first, ended ones included); `UserPayload.loop` (`{ id, label, run }`, additive) on a firing's message (origin `service`).

| Method | Path | Body | Answers |
|---|---|---|---|
| GET | /api/sessions/{id}/loops | — | 200 OwnedLoop[] · 404 |
| POST | /api/sessions/{id}/loops | OwnedLoopInput (`prompt` + one of `cron` / `everyMinutes` / `at`) | 201 OwnedLoop (`createdBy: developer`) · 404 · 409 `closed`, `too-many` · 422 `invalid` + `errors` |
| PUT | /api/sessions/{id}/loops/{loopId} | OwnedLoopInput (fields to change) | 200 OwnedLoop · 404 · 409 `ended` · 422 |
| POST | /api/sessions/{id}/loops/{loopId}/pause · /resume · /run | `{}` | 200 OwnedLoop · 404 · 409 `ended`, `closed`, `pending` (run: the previous firing still waits), `unavailable` |
| DELETE | /api/sessions/{id}/loops/{loopId} | — | 204 · 404 |
| GET · POST | /agent/v1/loops | (POST) as above, snake_case too (`every_minutes`, `expires_at`, `max_runs`) | the session is the agent token's |
| PUT · DELETE | /agent/v1/loops/{loopId} | | |
| POST | /agent/v1/loops/{loopId}/pause · /resume | | |

- **Peers (D48):** the `/api/sessions/{id}/loops…` routes are on `PEER_API_ALLOW`; a peer's answers map `sessionId` (kinds `owned-loops`, `owned-loop`); loop ids stay raw. **Devices (D73):** all allowed.
- No new `/hub` event: every change publishes `sessionUpdated`.

````json
POST /api/sessions/0b7c3e0a-…/loops
{ "prompt": "Check the CI run and report what failed.", "everyMinutes": 30, "label": "CI watch" }
→ 201
{ "id": "a1b2c3d4e5", "sessionId": "0b7c3e0a-…", "label": "CI watch", "title": "CI watch",
  "prompt": "Check the CI run and report what failed.", "schedule": { "kind": "every", "minutes": 30 },
  "scheduleText": "every 30 min", "expiresAt": null, "maxRuns": null, "state": "active", "endedReason": null,
  "runs": 0, "skipped": 0, "lastFiredAt": null, "lastError": null, "nextFireAt": "2026-10-09T10:30:00.000Z",
  "createdBy": "developer", "createdAt": "2026-10-09T10:00:00.000Z", "updatedAt": "2026-10-09T10:00:00.000Z" }
````

## Event hub `/hub` (Server-Sent Events)
Transport changed from SignalR to **Server-Sent Events** on 2026-09-27 (developer ruling, Node stack). Event names and payloads are unchanged and remain locked.
`GET /hub` → `Content-Type: text/event-stream`, cookie-authenticated like every API call. Each event is sent as
```
event: <name>
data: <payload as one line of camelCase JSON>

```
A `: keepalive` comment is sent at least every 15 s. All client → server traffic stays REST.

| Event | Payload |
|---|---|
| sessionUpdated | Session |
| event | { sessionId, event: Event } |
| questionBatch | { sessionId, batchId, questions: Question[] } → UI plays the sound, shows a toast and sends an OS notification |
| inboxChanged | { count } |
| worktreeRemovable | Worktree |
| scheduleRun | { scheduleId, result } |
| system | same shape as GET /api/system, every 5 s |
| activity | { sessionId, activity: SessionActivity \| null } (additive, D19: at most one per second per session; D30: `background` while background work is pending after the turn) |
| schedulesChanged | { scheduleId, change: saved \| paused \| resumed \| deleted \| run } (additive, D52: a schedule changed; forwarded between peers) |
| sidebarLayoutChanged | SidebarLayout (additive, D54: the sidebar's pins and folders changed; this machine's only, never forwarded between peers; D58: carries the folder tree, `parentId` per folder; D71: carries `loose`; also published when a merge from a paired machine changed the layout — the layout itself travels by `POST /peer/v1/sidebar`, not by this event) |
| updateChanged | UpdateStatus (additive, D55: the updater's check or update changed; this machine's only, never forwarded between peers) |
| machineState | Machine (+ `removed: true` once removed) (additive, fix · peer reconnects: a paired machine's connection changed, or it was paired, renamed or removed; this machine's only, never forwarded between peers) |
| machinePower | PowerStatus (additive, D125: this machine's power reading changed; forwarded between peers, where the receiver keeps it as `Machine.power` and never republishes it) |
| machineUpdate | MachineUpdate (additive, D140: this machine's update state in short, with every `updateChanged`; forwarded between peers, where the receiver keeps it as `Machine.update` and never republishes it) |
| todosChanged | { sessionId, openCount, doneCount } (additive, D68: a session's todo list changed, by the developer, the agent or the hour's removal; forwarded between peers; D75: `openCount` includes the items in progress) |


| draftChanged | { sessionId, field, client } (additive, D88: a session's draft was saved or cleared; `client` = the writing page's id or `null` (also the server's orphan clean-up, ruling 2026-10-09); other pages read the drafts again, never overwriting a field that has focus; forwarded between peers with the remote session id; `sessionId: null` = this machine's own draft (`/api/drafts`), not forwarded) |
| artifactsChanged | { sessionId, artifactId, change: saved \| deleted } (D111: `sessionId` is `null` for an artifact deleted after its session was gone) (additive, D89: an artifact was saved (created or a new version) or deleted, by the agent or the developer; forwarded between peers) |
| notice | DeviceNotice { id, kind: permission \| questions \| turnFinished \| errors \| inbox (D102: `review` removed), title, body, url, tag } (additive, D87: a push-worthy happening, this machine's or a paired machine's, the same payload the devices' web push carries; a paired device's open page shows it as a toast; this machine's only, never forwarded between peers) |
| ciChanged | { sessionId } (additive, D109: a session's pull-request status changed; the session header's PR chip reads `GET /api/sessions/{id}/ci` again; forwarded between peers with the remote session id) |
| accountChoiceChanged | { cli, profileId, planId, moving } (additive, D138: the overall account choice of `cli` changed (`planId: null`), or a Project's accounts (`cli: null`); `moving` sessions are being moved; the account pickers read `GET /api/accounts` again; this machine's only, never forwarded between peers) |

## Paged events (D95, 2026-10-10, additive)
`docs/performance.md` → *Paged events*. `GET /api/sessions/{id}/events` takes three more queries, each optional and combinable with `since`; without them the answer is every event, as before.
- `?limit=n` (1–999999): the newest n matching events in time order (`ts`, then id), answered oldest first. A full answer (n events) may have older ones; fewer means the start was reached.
- `?before=<eventId>`: only events older than that event in time order (its `ts`, then id). 422 `invalid` (`field: "before"`) when it is not an event of this session.
- `?agent=<agentId>`: only that agent's events plus the Agent / Task call that started it (the event whose `toolUseId` is the agent's). An unknown agent answers `[]`.
- 422 `invalid` (`field: "limit"`) for a limit that is not a whole number from 1 to 999999.
- Peers (D48): forwarded as they are; a machine before D95 ignores them and answers every event (the UI treats an answer without a new event as the start). Only a read without `since` / `before` / `agent` is kept as the session's offline snapshot.

```
GET /api/sessions/s1/events?limit=1000              → the newest 1,000
GET /api/sessions/s1/events?limit=1000&before=4711  → the 1,000 before event 4711
GET /api/sessions/s1/events?agent=a-42              → subagent a-42's events and its Agent call
```

## Agent deltas over `/hub` (D95 follow-up, 2026-10-10, additive)
`docs/performance.md` → *Agent deltas*. A `sessionUpdated` carries every agent of the session (≈125 KB with ≈430 subagents), once per status or context change. A stream may now ask for deltas:
- **`GET /hub?delta=1`** (combinable with D87's `client`; D95-q3 renamed it from `?agents=delta` before any release carried that) and the peer stream **`GET /peer/v1/events?delta=1`**. Without the query (an older tab, an older machine) every `sessionUpdated` carries the whole list, as before.
- On such a stream the **first** `sessionUpdated` of a session is whole (no `agentsDelta`). Each later one carries in `agents` only the agents added or changed since the stream's previous update of that session (a finished agent once more, with its final state; none when only other fields changed) and **`agentsDelta`**: `{ removed: string[], order?: string[] }`: the ids gone since then, and every id in the list's order when ids were added, removed or reordered (absent = same ids, same order). Every other field of the session is whole, except the heavy ones below (D95-q3).
- **Applying it:** start from the stream's previous whole list of the session, drop `removed`, put each sent agent in place of the one with its id, then order by `order` when present (new agents otherwise go last). A new stream (a reconnect) starts again with whole lists; the whole list is also always in `GET /api/sessions/{id}` (and `GET /api/sessions?include=agents`).
- **Peers (D48):** a machine with this change asks its peers for deltas and expands them before namespacing (`peerSession`), so its own bus, cache and tabs see whole lists; a peer before it ignores the query and sends whole lists, which pass as they are; an older machine asking this one gets whole lists.

```
sessionUpdated { "id": "s1", …, "agents": [ main, a1, a2, … a429 ] }                          ← first on this stream
sessionUpdated { "id": "s1", …, "agents": [ main ], "agentsDelta": { "removed": [] } }         ← main's status changed
sessionUpdated { "id": "s1", …, "agents": [ a430 ], "agentsDelta": { "removed": [], "order": [ "main", "a1", …, "a430" ] } }
```

### Heavy fields only when they change (D95-q3, 2026-10-10, additive)
- On a delta stream, after the first update of a session, **`loops`** and **`model`** are left out of a `sessionUpdated` when they equal (as JSON) what the stream last sent for that session, and named in **`unchanged`**: `("loops" | "model")[]` (absent = every field present). The reader keeps its previous value for a named field. A field the session does not carry (an older shape) is never named. A plain stream is unchanged.
- **`Session.loops[].iterations`** (REST and `/hub`, every stream) carries a loop's **newest 30** iterations (what a card's strip shows, `LOOP_WIRE_ITERATIONS`); the stored strip keeps up to 100, and `iteration` and the note are computed from all of them.

```
sessionUpdated { "id": "s1", "status": "done", …, "agents": [ main ], "agentsDelta": { "removed": [] }, "unchanged": [ "loops", "model" ] }
```

## Session list without agents (D95 follow-up 2, 2026-10-10)
- **`GET /api/sessions`** answers its items **without `agents`** (`SessionListItem` = `Session` without `agents`). **`?include=agents`** (combinable with `closed`) answers them with their agents, as before; any other `include` → 422 `invalid` (`field: "include"`). `GET /api/sessions/{id}` keeps the agents.
- **Peers (D48):** a paired machine reading this one's list (`/peer/v1/api/sessions`) always gets the agents (a machine before this change keeps and reads them); this machine lists a peer's sessions in its own UI list without them, and with them under `?include=agents`.
- The UI keeps the list in memory and patches it from `sessionUpdated` (no read per update); it reads it again after the hub stream reopens, when a paired machine's state changes, and when an update names a session it does not hold (`docs/performance.md` → *Session list in memory*). No new `/hub` event.

## Windowed Timeline (D95 follow-up, 2026-10-10, no contract change)
The Timeline tab reads the session's events through *Paged events (D95)* (`?limit=1000`, then `&before=` until it holds the last 50 turns, or 50 more after **Show earlier**). No new route, query or field.

## Search (D97, 2026-10-13, additive)
Developer decision D97 (`docs/decisions.md`; details `docs/search.md`): search across the conversations, artifacts, todos and History, here and on the paired machines. Types in `src/core/search.ts`: `SearchAnswer`, `SearchGroup`, `SearchResult`, `SearchSegment`, `SearchTarget`, `SearchScope` (`conversations` · `artifacts` · `todos` · `history`). Migration 0042 (the FTS5 index).

| Method | Path | Query | Answers |
|---|---|---|---|
| GET | /api/search | `q` (≤ 1,000 characters; words, `"phrases"`, `prefix*`; FTS syntax is searched as text), `scope` (`all` default, or a `SearchScope`), `session` (a session id; a remote id: only its machine), `machine` (`all` default, `local`, a machine id), `limit` (1–50; default 5 per group for `all`, 20 for one scope), `cursor` (a group's `nextCursor`; one scope only) | 200 `SearchAnswer` · 422 `invalid` + `errors` (`field`: `q`, `scope`, `session`, `machine`, `limit`, `cursor`) |
| GET | /api/sessions/{id}/events | `around=<eventId>` (+ `limit`, default 1,000): ⌊(limit − 1) / 2⌋ events before it in time order, the event, and up to the rest after it; a short side is not filled from the other. `after=<eventId>` (+ `limit`: the oldest n newer ones; without: every newer one), combinable like `before` | 200 `SessionEvent[]` (oldest first) · 422 `invalid` (`field: "around"` / `"after"`: not an event of this session; `around` with anything but `limit`) |

- **`SearchAnswer`**: `{ query, groups: SearchGroup[], indexing: { done, percent }, notSearched: { machine, reason }[] }`. A group: `{ scope, count, results, nextCursor }`, in the order conversations, artifacts, todos, history; `count` is every match (this machine's plus the paired machines' searched). `query` is the text as understood (`""`: nothing to search; every group empty, no error). `indexing.done` is `false` while the startup backfill runs (older history may be missing).
- **`SearchResult`**: `{ id, scope, kind, title, snippet, sessionTitle, detail, ts, score, target, machine? }`. `kind`: `message` · `note` (D96) · `prompt` (a subagent's) · `tool` · `session` · `artifact` · `todo` · `history`. `title` / `snippet`: `SearchSegment[]` (`{ text, match?: true }`; plain text, never HTML). `score`: lower is better (bm25 × recency). `target`: `{ type: "event", sessionId, eventId, agentId }` (`agentId`: a subagent's event, its chat) · `{ type: "session", sessionId }` · `{ type: "artifact", sessionId | null, artifactId }` · `{ type: "todo", sessionId, todoId }` · `{ type: "history", claudeSessionId }`.
- **Peers (D48):** `GET /api/search` is on `PEER_API_ALLOW`; a peer's request answers its own index only (never fans out). This machine asks every online paired machine at once (2.5 s each) with `machine=local`, namespaces the answers (`id`, session ids: `r~<machine>~…`), adds `machine`, merges by score and lists the machines it could not search in `notSearched` (`offline`, `reconnecting`, `did not answer in time`, `unreachable`, `refused this pairing`, `an older Switchboard without search`, `answered <status>`, `answered something unexpected`). History is not asked of peers. `around` / `after` reads pass through the proxy and are not kept as the offline snapshot.
- **Devices (D73):** `GET /api/search` is allowed.
- **UI addresses:** `/search?q=…&scope=…`, `/sessions/{id}/events/{eventId}`, `/sessions/{id}/agents/{agentId}/events/{eventId}`. No new `/hub` event.

```
GET /api/search?q=invoice%20parser&scope=conversations&limit=1
→ 200
{ "query": "invoice parser",
  "groups": [ { "scope": "conversations", "count": 3, "nextCursor": "eyJsIjoxfQ",
    "results": [ { "id": "e:4711", "scope": "conversations", "kind": "message", "detail": "Agent",
      "title": [ { "text": "Acme billing" } ], "sessionTitle": "Acme billing",
      "snippet": [ { "text": "The " }, { "text": "invoice parser", "match": true }, { "text": " now handles PROJ-123 dates." } ],
      "ts": "2026-10-13T09:12:00.000Z", "score": -7.41,
      "target": { "type": "event", "sessionId": "0b7c3e0a-…", "eventId": 4711, "agentId": null } } ] } ],
  "indexing": { "done": true, "percent": 100 }, "notSearched": [] }

GET /api/sessions/0b7c3e0a-…/events?around=4711&limit=1000   → ≤ 499 before, event 4711, ≤ 500 after
GET /api/sessions/0b7c3e0a-…/events?after=5211&limit=1000    → the 1,000 after event 5211
```

## Plans (D99, 2026-10-13, additive, experimental)
Developer decision D99 (`docs/decisions.md`; details `docs/plans.md`; removal `docs/plans-removal.md`). Types in `src/core/plans.ts` (`PlansState`, `Plan`, `PlanItem`, `PlanEdge`, `PlanAnswers`, `PlanChecks`, `PlanExternalRef`, `PlanChanged`). Data in the separate `<dataDir>/plans.db` (no migration in the main database). **Off by default** (setting `experimental.plans`, `PUT /api/settings`): while off only `GET /api/plans/state` answers; every other route below is 404 `plans-off`; with a broken `plans.db` they are 503 `plans-unavailable`. Errors are `{ error, message }` (+ `errors: [{ field, message }]` for a 422 on a field).

| Method | Path | Body | Answers |
|---|---|---|---|
| GET | /api/plans/state | | 200 `PlansState` `{ enabled, available, problem }` (always) |
| GET | /api/plans | | 200 `Plan[]` (this machine's, then the paired machines' as last known) |
| POST | /api/plans | `{ sourceSessionId, title, targetBranch? (any branch; missing / null / '' / 'none' = no target, D99 follow-up 2026-10-15), baseBranch? ('dev'), repos?, maxConcurrency? (1–16, 3), usageThreshold? (1–100, 85), answers?: { workType, mode, phase, coordination, notes }, external?: { system: 'jira', key } }` | 201 `Plan` (a draft) · 404 · 409 `closed` / `not-a-repo` / `no-folder` · 422 (D115: a workspace with a target needs no `repos`: without them the plan's repos are picked per item, `reposPerItem`) |
| GET · PUT · DELETE | /api/plans/{id} | PUT: any of the create fields but `sourceSessionId` (`targetBranch`, `repos` only in a draft) | 200 `Plan` · DELETE 204 (D117 follow-up: `DELETE …?stop=1` cancels a running or paused plan and stops its item sessions' running turns first → 200 `{ cancelled, stopped: [{ itemId, sessionId, outcome }] }`) · 404 · 409 `finished` / `started` / `running` · 422 |
| POST | /api/plans/{id}/items | `{ todoId }` or `{ todo: { title, description?, plan?, priority?, estimateMinutes? } }`, plus `key?`, `hold?`, `solutions?`, `after?: [id or key]` | 201 `{ plan, itemId }` · 409 `too-many` / `finished` · 422 |
| PUT · DELETE | /api/plans/{id}/items/{itemId} | PUT: `key?`, `solutions?` (before it starts; D115: in a plan with `reposPerItem`, writable solutions of the workspace), `hold?`; D129: `title?`, `description?` (`''` / `null` removes it), `estimateMinutes?` (`null` removes it): the item's todo, before it starts | 200 `Plan` · 409 `started` / `merged` / `no-target` · 422 `target-forbidden` (a repo joining a started plan, D115) / `invalid` on `todo` (the todo's checks, D129) |
| POST | /api/plans/{id}/items/{itemId}/retry · /done | | 200 `Plan` · 409 `not-failed` |
| POST | /api/plans/{id}/items/{itemId}/reopen (D121) | | 200 `Plan` (the item runs again, `docs/plans.md` → *Merge step*) · 409 `not-running` (the plan is not running / paused) · `not-done` |
| POST | /api/plans/{id}/items/{itemId}/merge (D102) | | 200 `Plan` (the item done, merged locally into the target) · 409 `no-merge-step` (a plan without one, 2026-10-15) / `not-ready` / `busy` / `finished` / `no-branch` / `uncommitted` / `target-dirty` / `target-missing` / `git-failed` · 409 `conflicts` `{ error, message, conflicts: [files] }` |
| POST | /api/plans/{id}/items/{itemId}/open-pr (D102) | | 200 `Plan` (`prUrl` set; still ready to merge) · 409 `no-merge-step` / `not-ready` / `busy` / `no-branch` / `no-remote` / `git-failed` / `gh-failed` |
| POST | /api/plans/{id}/items/{itemId}/send-back (D102) | `{ comment }` (1–4,000 characters) | 200 `Plan` (the item running again, its todo in progress) · 409 `not-ready` / `busy` / `send-failed` · 422 |
| POST | /api/plans/{id}/edges | `{ from, to }` (ids or keys: `to` runs after `from`) | 200 `Plan` · 409 `cycle` · 422 |
| DELETE | /api/plans/{id}/edges/{from}/{to} | | 200 `Plan` · 404 |
| POST | /api/plans/{id}/start | `{ mergeMode: agents \| agents-with-holds \| developer \| none, allowProtectedTarget?: boolean, sidebarFolder?: string \| null }` (D130: `sidebarFolder` the runs' sidebar subfolder's name, made or reused inside the source session's sidebar folder; `''` / `null` / omitted = none; 422 `invalid` field `sidebarFolder` when the source's folder is 5 levels deep or the name is over 60 characters) (`mergeMode` **required** with a target, no default; a plan without a target is `none`) | 200 `Plan` · 422 `merge-mode-required` / `target-forbidden` (an agent mode on a protected target without `allowProtectedTarget: true`; field `allowProtectedTarget`) / `target-required` (a merging mode without a target) / `empty` · 409 `started` / `paused` / `no-target` |
| POST | /api/plans/{id}/pause · /resume · /cancel | | 200 `Plan` · 409 `not-running` / `not-paused` / `finished` |
| PUT | /api/plans/{id}/mode | `{ mergeMode, allowProtectedTarget? }` | 200 `Plan` · 422 `target-forbidden` / `target-required` · 409 `started` (to or from `none` once started) |
| PUT | /api/plans/{id}/holds | `{ holds: { <itemId or key>: boolean } }` | 200 `Plan` · 409 `merged` |

- **`Plan`**: `{ id, title, sourceSessionId, targetBranch (null = no target, 2026-10-15), repos, baseBranch, mergeMode (null in a draft; `none` = no merge step), allowProtectedTarget (2026-10-15, additive), reposPerItem (D115, additive: the plan's agent picks each item's repositories; `repos` is then the union of the items' solutions; absent from older machines = false), maxConcurrency, usageThreshold, answers, state: draft | running | paused | done | cancelled, external, held (why new starts are held: usage, paused, "Plans was switched off"), pausedReason ("Plans was switched off" when Switchboard paused it, else null), items: PlanItem[], edges: [{ from, to }], criticalPath: { itemIds, minutes }, progress: { done, total, percent }, estimatedMinutesLeft, createdAt, updatedAt, startedAt, finishedAt, machine }`.
- **`PlanItem`**: `{ id, todoId, key, title, hold, solutions, state: waiting | ready | running | question | stopped (D120) | ready-to-merge | to-confirm | done | blocked, reason, note, storedState, waitingOn: merge | checks | question | conflict | confirm | null, dependsOn, runSessionId, branch, prUrl, checks: { state: pending | green | red | none, summary, sha } | null, developerMerges, developerConfirms (2026-10-15, additive), estimateMinutes, actualMinutes, onCriticalPath, position, startedAt, waitingSince, mergedAt, doneAt, spans, stoppedSince (D120, additive: since when a `stopped` item's session is idle, else `null`) }`. D120: `stopped` = its run session's turn is over and it is not working, its todo is not done, nothing else covers it, for at least 2 minutes; its `reason` is the agent's last message (cut to 300 characters); it keeps its slot and its dependents wait (`docs/plans.md` → *Stopped items (D120)*).
- **Plans for anything (D99 follow-up 2026-10-15, additive):** any target branch is accepted (also `dev`, `main`, the base itself). Agents merging into a protected target (`dev`, `develop`, `main`, `master`, the repo's default or a gh-protected branch) needs `allowProtectedTarget: true` on `start` / `mode` (the developer's acknowledgement; stored on the plan); `developer` mode needs nothing. Without a target (or with `mergeMode: none`) a plan has **no merge step**: an item is done once its todo is done and its session's turn is over; no git, PR or checks are read; Merge / Open PR answer 409 `no-merge-step`; a held item becomes `to-confirm` (`waitingOn: confirm`) until the developer's `…/done`, with an Inbox item `kind: plan-confirm` (label `Confirm done`, dismiss-only, closed when the item is done or fails); the last item raises "Plan done: <title>". A plan without a target may come from a plain folder; its runs are D76's own (cut from the source's branch, or the source folder). The Jira import still requires a target. Plans made before keep `allowProtectedTarget: false` and their mode.
- **Repositories picked per item (D115, additive):** a plan with a target branch whose source is a workspace without repos (a Jira import into a workspace without `repos`, or `POST /api/plans` from a workspace session without solutions) has `reposPerItem: true`. A pending item without `solutions` is `waiting` with the reason "Waiting for the plan's agent to pick repositories" and never starts; starting the plan is allowed. Items' solutions are checked against the workspace's writable solutions (read-only ones refused). A repository that joins a started plan gets its target branch then (the protected-target rule applies: 422 `target-forbidden` without `allowProtectedTarget`; 409 `no-target`). Stored as an empty `repos` on a plan with a target (refused before D115), so no `plans.db` migration. **Follow-ups 2026-10-20 (additive):** an item added without solutions (`POST /api/plans/{id}/items`) sends the source session the ask by itself (one message for a burst, 2 s after the last item); `POST /agent/v1/plans` and `POST /agent/v1/plans/{planId}/items` answer `solutionChoices: string[]` (the workspace's writable solutions) when the plan picks per item (for the item: when it was added without solutions), and the MCP tools' answer is then the ask (no message). 15 minutes after an ask (kept in `plans.db`, migration 4: survives a restart), or at once when it could not be sent, an Inbox system item `kind: plan-pick-repos` (source `plans`, status `need`, label `Pick repositories`, title "<n> items of "<plan>" wait for repositories", `route: /plans/<id>`) with actions `plan-ask-repos` (**Ask again**: asks again and re-arms; a refusal answers 409 `refused` with the reason), `open-plan` (a link) and `dismiss`; one open per plan, closed by Plans once every item has solutions or the plan ends or is deleted.
- **`PlanItem.spans`** (additive): the item's history for the Timeline, oldest first, at most the newest 200: `[{ kind: running | waiting-you | waiting-dependency | paused-usage | paused-plan, startedAt, endedAt (null = open) }]`. At most one span per item is open; none while the plan is a draft, and every one is closed when the plan is done or cancelled. Older machines omit it.
- **Agent routes** (the `switchboard` MCP helper, agent token; only plans whose source is the agent's session; 404 `plans-off` while off): `GET|POST /agent/v1/plans`, `GET /agent/v1/plans/{planId}`, `POST /agent/v1/plans/{planId}/items | edges | start`; D115: `POST /agent/v1/plans/{planId}/solutions` `{ items: [{ item (key or id), solutions: [names] }] }` → 200 `{ plan: Plan, set: [{ itemId, label, solutions }] }` (applied at once; every entry is checked first: an unknown item, one that started, one listed twice, no names, a name that is not a writable solution of the workspace (or, for a plan with repos of its own, not one of them) refuse the whole call with 422 on `items`, the reasons in `message`; 409 `finished`, `target-forbidden` / `no-target` for a repo joining a started plan). MCP tools, registered only while Plans is on: `plan_create` (`target_branch` optional: left out or `none` = no merge step), `plan_add_item`, `plan_add_dependency`, `plan_status`, `plan_start` (`merge_mode`: agents, agents-with-holds, developer or none, required by the server when the plan has a target; `allow_protected_target` boolean, 2026-10-15; the description tells the agent to ask the developer for both), `plan_set_solutions` (D115: `plan_id`, `items: [{ item, solutions }]`; applied at once). D129 (items already in the plan; the developer's service methods, refusals and messages): `PUT /agent/v1/plans/{planId}/items/{item}` (`item` an id or a key; unknown: 422 on `item`) `{ hold?, title?, description?, estimateMinutes? }` → 200 `Plan` (the developer's item edit as the agent: `hold` until merged, 409 `merged`; the todo fields only before the item starts, 409 `started`, the todo service's 422s); `DELETE /agent/v1/plans/{planId}/items/{item}` → 200 `Plan` (not running or done, 409 `started`; the todo stays); `DELETE /agent/v1/plans/{planId}/edges/{from}/{to}` → 200 `Plan` (404 `not-found` "no such dependency"); `PUT /agent/v1/plans/{planId}/mode` `{ mergeMode, allowProtectedTarget? }` → 200 `Plan` (as `PUT /api/plans/{id}/mode`: 409 `finished` / `started`, 422 `target-forbidden`). Tools `plan_update_item` (`plan_id`, `item`, `hold`, `title`, `description`, `estimate_minutes`), `plan_remove_item` (`plan_id`, `item`), `plan_remove_dependency` (`plan_id`, `from`, `to`), `plan_set_mode` (`plan_id`, `merge_mode`, `allow_protected_target`; the description tells the agent to ask the developer for both).
- **Additive fields:** settings key `experimental.plans` (boolean, default `false`); Inbox system items of `source: 'plans'` (`kind: plan-ready | plan-conflict`, dismiss-only; D102 `plan-ready-to-merge`, label `Ready to merge`, title "Ready to merge: <item> (<plan>)", actions `plan-merge` (**Merge**: the item's Merge, a refusal answers 409 `refused` with the reason) and `open-plan` (**Open plan**: the UI goes to `InboxItem.route`, `/plans/<id>`, without calling the server), closed by Plans when the item is merged, sent back or fails). `InboxItem.route` (additive, D102).
- **Merge step (D102):** an item the developer merges (developer mode, a hold) whose run finished (its todo done and its turn over, or every PR open with green checks) is `ready-to-merge` (`waitingOn: merge`) until it is merged (the routes above, its Inbox item, or the agent merging it itself) or sent back. `docs/plans.md` → *Merge step*.
- **The runs' sidebar subfolder (D130, additive):** `Plan.sidebarFolder` `{ id, name } | null` (absent from an older Switchboard = none): the folder chosen at Start (its id in the owning machine's sidebar layout); each item run's `Session.todoLink.sidebarFolder` carries the same, and the run is placed at the end of that folder (`docs/plans.md` → *The runs' sidebar subfolder (D130)*). `PUT …/mode` does not change it.

```
POST /api/plans/3f2a9c01b7/start { "mergeMode": "agents-with-holds", "sidebarFolder": "PROJ-100 Acme checkout" }
→ 200 { "id": "3f2a9c01b7", "state": "running", "sidebarFolder": { "id": "6f1c…", "name": "PROJ-100 Acme checkout" }, … }
POST /api/plans/3f2a9c01b7/start { "mergeMode": "none", "sidebarFolder": "PROJ-100 Acme checkout" }   (the source 5 levels deep)
→ 422 { "error": "invalid", "message": "the source session's sidebar folder cannot hold a subfolder: folders nest at most 5 levels deep",
        "errors": [ { "field": "sidebarFolder", "message": "…" } ] }
```
- **`/hub`:** `planChanged` `{ planId, state }` (`state: null` = deleted); forwarded between peers with the remote plan id.
- **Peers (D48):** on `PEER_API_ALLOW`: every route above but the agent routes (a plan id `r~<machine>~<id>` is forwarded there; item ids stay raw). A machine with Plans off answers 404: its plans are not listed.
- **Devices (D73):** every route above is allowed.

```
POST /api/plans/3f2a9c01b7/start { "mergeMode": "agents-with-holds" }
→ 200 { "id": "3f2a9c01b7", "title": "PROJ-100 Acme checkout", "state": "running", "mergeMode": "agents-with-holds",
        "targetBranch": "feature/PROJ-100-acme-checkout", "baseBranch": "dev", "held": null, "pausedReason": null,
        "items": [ { "id": "a1b2c3d4e5", "key": "PROJ-101", "state": "running", "branch": "PROJ-101-cart-api", … },
                   { "id": "b2c3d4e5f6", "key": "PROJ-102", "state": "waiting", "reason": "waiting on PROJ-101", … } ], … }

POST /api/plans/7c1d2e3f40/start { "mergeMode": "agents" }   (target dev, 2026-10-15)
→ 422 { "error": "target-forbidden", "message": "agents would merge straight into dev. Ask the developer whether agents may merge straight into it; if they agree, start again with allowProtectedTarget: true (or give the plan its own feature branch).",
        "errors": [ { "field": "allowProtectedTarget", "message": "…" } ] }
POST /api/plans/7c1d2e3f40/start { "mergeMode": "agents", "allowProtectedTarget": true }
→ 200 { "id": "7c1d2e3f40", "targetBranch": "dev", "mergeMode": "agents", "allowProtectedTarget": true, "state": "running", … }

POST /api/plans { "sourceSessionId": "…", "title": "Vendor research" }   (no target, 2026-10-15)
→ 201 { "id": "9e8d7c6b5a", "targetBranch": null, "mergeMode": null, "state": "draft", … }
POST /api/plans/9e8d7c6b5a/start {}
→ 200 { "id": "9e8d7c6b5a", "targetBranch": null, "mergeMode": "none", "state": "running", … }

POST /api/plans/3f2a9c01b7/start {}
→ 422 { "error": "merge-mode-required", "message": "choose the merge mode: agents, agents-with-holds, developer, none (there is no default: ask the developer)",
        "errors": [ { "field": "mergeMode", "message": "…" } ] }

GET /api/plans/3f2a9c01b7 (an item's history)
→ 200 { …, "items": [ { "key": "PROJ-101", "state": "running", "spans": [
          { "kind": "paused-usage", "startedAt": "2026-10-13T09:00:00.000Z", "endedAt": "2026-10-13T09:20:00.000Z" },
          { "kind": "running", "startedAt": "2026-10-13T09:20:00.000Z", "endedAt": "2026-10-13T09:45:00.000Z" },
          { "kind": "waiting-you", "startedAt": "2026-10-13T09:45:00.000Z", "endedAt": null } ], … } ] }

GET /api/plans (Plans off)
→ 404 { "error": "plans-off", "message": "Plans is off: switch it on in Settings → Experimental" }
```

## Team (D100, 2026-10-13, additive, experimental)
Developer decision D100 (`docs/decisions.md`; details `docs/team.md`; removal `docs/team-removal.md`). Types in `src/core/team.ts` (`TeamState`, `TeamView`, `TeamMember`, `TeamHandoff`, `TeamRequest`, `TeamNeedsYouItem`, `TeamActivityRecord`, `TeamChanged`), `src/core/team-templates.ts` (`TeamTemplate`), `src/core/team-sync.ts` (`TeamSyncMessage`). Data in the separate `<dataDir>/team.db` (no migration in the main database). **Off by default** (setting `experimental.team`, `PUT /api/settings`): while off only `GET /api/team/state` answers; every other route below is 404 `team-off`; with a broken `team.db` they are 503 `team-unavailable`. Errors are `{ error, message }` (+ `errors` for 422 `invalid`, + `blockers` for 409 `blocked`).

| Method | Path | Body | Answers |
|---|---|---|---|
| GET | /api/team/state | | 200 `TeamState` `{ enabled, available, problem, hiddenSessionIds, roles }` (always) |
| GET | /api/team | `?teamId=` (2026-10-14; none = the first team, `team`) | 200 `TeamView` `{ team, self, members, handoffs, activity }` (activity: newest 100; hand-offs: those of the team and to its members) · 404 (no such team) |
| PUT | /api/team | `{ name }` | 200 `TeamView` (renames the first team) · 422 · 409 `name-taken` |
| GET | /api/team/teams | | 200 `TeamSummary[]` `{ id, name, order, members, needsYou }` in the teams' order (2026-10-14); 2026-10-16 (the sidebar's member rows), additive: `roster: TeamRosterEntry[]` `{ id, name, status, sessionRef, machineName, local, current: { title, key } \| null, turnStartedAt, lastActivityAt }` in the team's order (`status` as the card shows it: `needs-you` also with open Needs-you items) and `collapsed: boolean` (folded in this install's sidebar) |
| PUT | /api/team/teams/{id}/sidebar | `{ collapsed: boolean }` (2026-10-16) | 200 `{ collapsed }` (stored per install as the `settings` row `team.sidebarCollapsed`; `teamChanged`) · 404 · 422 |
| POST | /api/team/teams | `{ name }` | 201 `TeamSummary` (empty, at the end) · 422 · 409 `name-taken` / `too-many` (20) |
| PUT | /api/team/teams/order | `{ teamIds: string[] }` (the given ids first, the rest after them) | 200 `TeamSummary[]` · 422 |
| PUT | /api/team/teams/{id} | `{ name }` | 200 `TeamView` · 404 · 422 · 409 `name-taken` |
| DELETE | /api/team/teams/{id} | | 200 `{ ok: true, returned }` (every member returned to the session list as `POST …/return`; no session deleted; the first team too, 2026-10-14 ruling) · 409 `last-team` (the only team left) · 502 `peer-unreachable` (a member's machine is offline; nothing changed) · 404 |
| PUT | /api/team/order | `{ memberIds: string[] }` (D100 follow-up 2026-10-14: the given ids first, the ones left out after them in their order) | 200 `TeamView` (members in the new order) · 422 (an unknown or repeated id) |
| GET | /api/team/templates | | 200 `TeamTemplate[]` |
| GET | /api/team/suggestions | | 200 `TeamSuggestion[]` `{ sessionId, title, folder, evidence: { repos, loops, cliLoops, events7d, edits, reads, editRatio, planning?, activeDays? }, templateId, reason, confidence?: 'high' \| 'medium' \| 'low', score, charterDraft: null }` (only sessions with ≥ 50 events whose title or evidence names a template; `confidence`: title + behaviour agree = high, one of them = medium, weak = low; `activeDays` and `confidence` are additive, absent from older machines; see `docs/team.md` → *Templates and suggestions*) |
| GET | /api/team/activity | `?before=<iso>&limit=1–500&teamId=` | 200 `TeamActivityRecord[]` (newest first) |
| GET | /api/team/needs-you | `?teamId=` (none = the first team; `all` = every team) | 200 `TeamNeedsYouItem[]` (each with `teamId`, `teamName`, additive) |
| POST | /api/team/members | adopt: `{ sessionId, teamId? (none = the first team), name, charter?, templateId?, rhythm?: { loopIds, onHandoff }, budget?: { dailyPct, profileId }, gates?, workplace?: { folders }, model?, effort?, charterDraft? }` · create: the same without `sessionId`, with `session: NewSession` | 201 `TeamMember` · 404 · 409 `hooked` / `detached` / `closed` / `already-member` (in any team: one team per session) / `too-many` · 422 (`teamId`: no such team) · 422 (create: `POST /api/sessions`' refusals in the body) |
| GET | /api/team/members/{id} | | 200 `TeamMember` · 404 |
| PUT | /api/team/members/{id} | any of the adopt fields but `sessionId` (2026-10-14: `model` / `effort` also set the member's session's model as `PUT /api/sessions/{id}/model` does, from its next turn; on a paired machine's member they are stored and that machine applies them) | 200 `TeamMember` · 404 · 422 (a model or effort the CLI does not offer; nothing changed) · 409 (the CLI refused it) |
| DELETE | /api/team/members/{id} | | 200 `{ ok: true }` (the session returns to the list, no note) · 502 `peer-unreachable` |
| POST | /api/team/members/{id}/team | `{ teamId }` (2026-10-14) | 200 `TeamMember` (at the end of that team; charter, rhythm, budget, gates, access and hand-offs kept) · 404 · 409 `too-many` · 422 |
| POST | /api/team/members/{id}/pause · /resume | | 200 `TeamMember` |
| POST | /api/team/members/{id}/return | | 200 `{ sessionId }` (how this machine addresses it) |
| POST | /api/team/members/{id}/move/check | `{ targetMachineId, placement?, clonePaths? }` (D110) | 200 `{ ok, blockers, preview }` (`preview`: the take-over's `TakeoverPreview`) · 422 |
| POST | /api/team/members/{id}/move | `{ targetMachineId, placement?, clonePaths? }` (D110) | 202 `TeamMoveRun` `{ id, memberId, state, takeoverRunId, error, targetMachineId }` · 409 `blocked` + `blockers` |
| GET | /api/team/moves/{runId} | | 200 `TeamMoveRun` (`state`: `running` · `done` · `failed`) · 404 |
| POST | /api/team/handoffs | `{ to: <role name, "Role (Team)" or member id>, brief, expected?, links?, from?: <member id>, planRef?, team?: <team name or id>, teamId?: <the team the name is looked up in, when no sender; none = the first team> }` | 201 `TeamHandoff` · 404 (no such member) · 422 |
| PUT | /api/team/handoffs/{id} | `{ state: open \| accepted \| done \| declined }` | 200 `TeamHandoff` |
| POST | /api/team/requests/{id}/approve · /decline · /dismiss | (D105, `kind: charter`: approve may carry `{ charter }`, the developer's edit of the proposal) | 200 `TeamRequest` (`note`: the approved action's result) · 409 `decided` · (D105) 409 `no-proposal` (approving an ask the agent has not answered) · 422 (an edited charter that is not one) |
| POST | /api/team/members/{id}/charter/ask | (D105, 2026-10-14) | 201 `{ asked: true, requestId }` (a message to the member's own session; a `charter` request without a proposal) · 409 `charter-open` (+ `requestId`; an ask or a proposal is open) · `paused` · `closed` · `not-sent` · 404 |
| POST | /api/team/charters/ask | `{ teamId?: <id> \| "all", templateOnly?: boolean }` (D105; none = the first team) | 200 `{ asked: [{ memberId, name }], skipped: [{ memberId, name, reason }] }` (skips open asks / proposals, paused members, offline machines; marks the one-time offer done) |
| POST | /api/team/charters/offer/dismiss | (D105) | 200 `{ ok: true }` (Not now: the offer never shows again on this install) |
| POST | /api/team/sync | `TeamSyncMessage` (from a paired machine) | 200 `TeamSyncMessage` (this machine's) · 422 |

- **`TeamMember`**: the record (`id, teamId, name, charter: { owns, produces, neverDoes }, charterDraft, templateId, machineId, sessionId, workplace, provider, model, effort, rhythm: { loops: [{ loopId, label, prompt, scheduleText }], onHandoff }, budget, gates, paused, pausedLoops, pausedBy, cliLoops, originalPlace: { place, folderId, index }, access: [{ id, name, setUpOn }], order, createdAt, updatedAt`; `order`: its place in the team, ascending, `null` from an older peer; additive 2026-10-14) plus `status` (`working` · `needs-you` · `idle` · `paused` · `offline`), `sessionRef` (this machine's id, or `r~<machine>~<id>`), `sessionTitle`, `machineName`, `local`, `cliLoopsUnmanaged`, `usedTodayPct`.
- **`gates`**: any of `outward-facing` (always on, always first), `merge-default-branch`, `external-write`, `delete-data`, `release`, `spend`.
- **`TeamNeedsYouItem`**: `{ id, source: inbox | team, kind, memberId, memberName, label ("Tracker · question"), title, detail, createdAt, sessionRef, inbox?: InboxItem, teamId?, teamName? (2026-10-14), request?: TeamRequest }`. `TeamRequest`: `{ id, teamId, memberId, kind: gate | budget | access, gate, title, detail, state: open | approved | declined | dismissed, action: { type: resume-member } | { type: external, ref } | null (D102: `review-merge` removed), note, createdAt, updatedAt }`.
- **Agent routes** (the `switchboard` MCP helper, agent token; only a member's session, only while Team is on, else 404 `not-a-member`): `GET /agent/v1/team` → `{ member: { id, name } }`, `GET /agent/v1/team/members[?team=<name or id>]` → `{ text }` (the caller's team by default, plus a line naming the other teams), `POST /agent/v1/team/handoffs` `{ to, brief, expected, links?, team? }` → 201 `TeamHandoff` (`to` in the caller's own team, or "Role (Team)", or `team`; 2026-10-14), `POST /agent/v1/team/reports` `{ text }` → 201. MCP tools: `team_handoff`, `team_members`, `team_report`.
- **Feature-tool refresh (2026-10-16, additive; any session's helper, agent token):** `POST /agent/v1/tools` `{ tools: string[] }` → 204 (the tool names of the `tools/list` answer the helper just gave its CLI; 422 `invalid`), `GET /agent/v1/tools/watch?since=N` → `{ generation, nudged }` (held up to 25 s until Switchboard wants the helper to re-probe `GET /agent/v1/team` · `/plans` · `/memory`). In memory only, not on the peer API. `docs/mcp.md` → *Tools that appear without a restart*.
- **Additive fields:** `InboxItem.teamRole` and `SearchResult.teamRole` (the role name; then also `sourceTitle` / `sessionTitle`); settings key `experimental.team` (boolean, default `false`).
- **Review cards (D79):** removed (D102); so is the `review-merge` gate. A plan's "Ready to merge" Inbox item of a member's session shows in Needs you (`source: inbox`, `kind: system`).
- **`/hub`:** `teamChanged` `{ teamId, what: string[] }` (`teamId`: the team that changed; `what` may also name `teams` and `order`).
- **Multiple teams (2026-10-14):** the first team keeps `id: "team"`; the routes without a team id act on it, so an older client keeps working; once it is deleted (allowed while another team remains) they act on the first remaining team in the teams' order. A member's `model` / `effort` also follow a `PUT /api/sessions/{id}/model` on its session (the developer's choice in the header). Teams sync like members (`TeamRecord` gains `order`; a deleted team is a tombstone); an older peer reads only the first team.
- **Archived members (2026-10-27, D137 follow-up, additive; no migration, no new route):** `TeamMember.archived` and `TeamRosterEntry.archived` (boolean; `true` while the member's session is archived, i.e. closed and not moved away, here or as last known on its paired machine; absent from an older machine = not archived) and `TeamSummary.archived` (number: its archived members; `members` still counts them, `needsYou` never does). Archived members stay in every list (flagged) so the clients hide them; `GET /api/team/needs-you` leaves their items out until they are restored. `POST /api/team/handoffs` (and the agent's `team_handoff`) and `POST /api/team/members/{id}/charter/ask` answer **409 `closed`** `"<name>'s session is archived: restore it first"` for one; `POST /api/team/charters/ask` and `POST /api/memory/draft-all` skip it with `reason: "archived"`. An archive or a restore of a member's session publishes `teamChanged` `{ teamId, what: ["members"] }`. `docs/team.md` → *Archived members*.
- **Order (2026-10-14):** `GET /api/team` lists the members in the team's order; members (and teams) carry `order` in the sync records too (an older peer's record without it keeps the receiver's order).
- **Peers (D48):** on `PEER_API_ALLOW`: `POST /api/team/sync`, `GET /api/team`, `GET /api/team/members/{id}`, `GET /api/team/moves/{id}`, `POST /api/team/members`, `POST /api/team/handoffs`, `PUT /api/team/members/{id}`, `PUT /api/team/order`, `GET` / `POST /api/team/teams`, `PUT` / `DELETE /api/team/teams/{id}` (and `/order`), `POST /api/team/members/{id}/team`, `PUT /api/team/handoffs/{id}`, `DELETE /api/team/members/{id}`, `POST /api/team/members/{id}/(pause|resume|return|move|move/check)`, `POST /api/team/requests/{id}/(approve|decline|dismiss)`. A member on a paired machine is acted on there (forwarded); a request that came through the peer API is never forwarded again (409 `not-here`). An older peer answers 403 to the sync and is left out.
- **Better charters (D105, 2026-10-14, additive):** `TeamCharter` gains the optional **`howItWorks`** (≤ 2,000; omitted when empty; synced in the member's JSON, no migration; the standing instruction adds "How it works: …"). `TeamRequest.kind` gains **`charter`** with `proposal: TeamCharter | null` (`null` while the ask waits for the agent; the agent's notes are `detail`); an ask without a proposal is not in Needs you. `TeamNeedsYouItem` (kind `charter`) gains `charter: { before, after, notes }`; `TeamMember` gains `charterRequest: { requestId, state: asked | proposed, proposal, notes, at } | null`; `TeamView` gains `charterOffer` (members, every team, with a template-only charter and no open charter request; `0` once the offer was acted on or dismissed: settings key `team.charterOffer = "done"`). Adopt (`POST /api/team/members` with `sessionId`) takes `askCharter: true` (the new member is asked right after). Agent route `POST /agent/v1/team/charter` `{ owns, produces, neverDoes, howItWorks?, notes? }` → 201 `{ requestId }` · 422 (the MCP tool `team_propose_charter`). Peers: `POST /api/team/members/{id}/charter/ask` is on `PEER_API_ALLOW`. Devices: both ask routes and the offer's dismiss are allowed (accept / dismiss are the request decisions).
- **Devices (D73):** allowed: the reads, `POST /api/team/members`, `DELETE /api/team/members/{id}`, `POST …/(pause|resume|return)`, `PUT /api/team/order`, `GET` / `POST /api/team/teams`, `PUT /api/team/teams/order`, `PUT /api/team/teams/{id}/sidebar` (2026-10-16), `DELETE /api/team/teams/{id}`, `POST /api/team/members/{id}/team`, hand-offs (create, state) and request decisions. Refused: `PUT /api/team`, `PUT /api/team/teams/{id}` (renaming), `PUT /api/team/members/{id}`, the move routes, `POST /api/team/sync`.

```
POST /api/team/members { "sessionId": "0b7c3e0a-…", "name": "Tracker",
  "charter": { "owns": "The PROJ board", "produces": "A daily status note", "neverDoes": "Merges or writes to the tracker" },
  "rhythm": { "loopIds": ["a1b2c3d4e5"], "onHandoff": true }, "budget": { "dailyPct": 20, "profileId": null } }
→ 201 { "id": "5f0c…", "name": "Tracker", "status": "idle", "sessionRef": "0b7c3e0a-…", "local": true,
        "gates": ["outward-facing", "merge-default-branch"], "originalPlace": { "place": "folder", "folderId": "f-1", "index": 1 }, … }

GET /api/team/needs-you
→ 200 [ { "id": "q-1", "source": "inbox", "kind": "questions", "memberId": "5f0c…", "memberName": "Tracker",
          "label": "Tracker · question", "title": "Which board?", "detail": "…", "createdAt": "2026-10-13T09:12:00.000Z",
          "sessionRef": "0b7c3e0a-…", "inbox": { … } } ]

POST /api/team/members/5f0c…/charter/ask
→ 201 { "asked": true, "requestId": "r-9c1…" }
POST /agent/v1/team/charter { "owns": "The PROJ-123 epic in acme-app", "produces": "Commits on its branch with tests",
  "howItWorks": "Feedback rounds with the developer and the testers", "neverDoes": "Works outside acme-app", "notes": "From 8 rounds" }
→ 201 { "requestId": "r-9c1…" }
POST /api/team/requests/r-9c1…/approve
→ 200 { "id": "r-9c1…", "kind": "charter", "state": "approved", "note": "accepted", "proposal": { … }, … }

POST /api/team/members/5f0c…/move { "targetMachineId": "m-pc-0002" }
→ 202 { "id": "7a9e…", "memberId": "5f0c…", "state": "running", "takeoverRunId": "c3d1…", "error": null, "targetMachineId": "m-pc-0002" }
```

## Team access (D100-T2, 2026-10-13, additive, experimental)
Access requests of Team members (`docs/team.md` → *Access requests*; decision D100 → *Access requests*). Types in `src/core/team-access.ts` (`TeamAccessRecord`, `TeamAccessEntryView`, `TeamAccessView`, `AccessField`, `AccessMcpServer`, `AccessKeyTest`, `AccessTestResult`) and `src/core/team-access-catalog.ts` (`AccessCatalogEntry`). Records in `team.db` (`access` table, Team migration 2); **values only in the OS keychain** of the machine they were entered on (service `Switchboard Team`, account `<memberId>/<accessId>/<FIELD>`), never in an answer, the sync or a log. Like every Team route: 404 `team-off` while Team is off, 503 `team-unavailable` with a broken `team.db`; errors `{ error, message }` (+ `errors: [{ field, message }]` for 422 `invalid`).

| Method | Path | Body | Answers |
|---|---|---|---|
| GET | /api/team/members/{id}/access | | 200 `TeamAccessView` `{ member: { id, name, machineId, machineName, local }, self: { id, name }, device, keychain: { name, available, problem }, entries: TeamAccessEntryView[] }` (newest first) · 404 |
| GET | /api/team/members/{id}/access/shareable | | 200 `[{ name, scope, transport, command, url }]`: the MCP page's servers for the member's folder (this machine's member only, else `[]`) |
| GET | /api/team/access/catalog | | 200 `AccessCatalogEntry[]` `{ id, name, summary, host, server, fields, custom, note }` |
| POST | /api/team/access/{id}/setup | `{ values: { FIELD: value }, server?: { transport: stdio, command, args } \| { transport: http, url, headers }, shared?: { name, scope }, expiresAt?: iso \| null }` | 200 `TeamAccessEntryView` (no value) · 403 `local-only` (a phone: "Set this up on a computer…", or a peer request) · 409 `closed` (denied / revoked) · 422 (`values` per field; `server` for a custom server; `shared` for a shared one, stdio only) · 503 `keychain-unavailable` |
| POST | /api/team/access/{id}/test | | 200 `AccessTestResult` `{ ok, detail, tools }` · 403 · 409 `not-set-up` (not on this machine) |
| POST | /api/team/access/{id}/revoke | | 200 `TeamAccessEntryView` (`status: revoked`) · 403 |
| PUT | /api/team/access/{id} | `{ expiresAt: iso \| null }` | 200 `TeamAccessEntryView` · 403 · 422 (past / malformed) |

- **`TeamAccessEntryView`**: `{ id, teamId, memberId, requestId, kind: mcp | api-key, source: catalog | custom | shared | null, catalogId, service, host, why, scope, fields: [{ name, label, secret, help, helpUrl, pattern }], mcp: { transport, command, args, url, headers } | null, shared: { name, scope } | null, test: { url, header } | null, warning, state: requested | approved | active | denied | deferred | revoked | expired, setUpOn: [machineId], setUpAt, secretRefs: [{ field, service, account }], expiresAt, lastUsedAt, lastUsedOn, audit: [{ at, what: asked | approved | denied | deferred | set-up | replaced | used | tested | revoked | expired, machineId, text }], createdAt, updatedAt }` plus `status` (`requested` · `ready` · `needs-setup` · `denied` · `not-now` · `revoked` · `expired`), `statusText` ("Ready on Mac", "Set up on Mac only", "Set up on Mac only: needs setup on PC"), `here`, `setUpOnNames`, `ready` (the member's machine has it, active, not expired), `canSetUp`, `delivers` (the variables, or `MCP server access-<service>-<id>`).
- **Needs you**: a request is a `TeamRequest` with `kind: access`, `action: { type: external, ref: "access:<accessId>" }`; its `TeamNeedsYouItem` carries `access: TeamAccessEntryView`. **Set up…** = the Access tab's setup (`focusAccessId`), **Deny** = `POST /api/team/requests/{id}/decline` (state `denied`), **Not now** = `…/dismiss` (`deferred`); `…/approve` alone = `approved` (waiting for setup; `note` says so). A setup settles the open request (`approved`, note "Set up on <machine>").
- **Agent routes** (agent token; the member's own session, Team on; else 404 `not-a-member`): `POST /agent/v1/team/access` (the `request_access` tool) `{ kind, service, host, why, scope, fields?, source?, catalogId?, server?, sharedServer?, testUrl?, testHeader? }` → 201 `{ text, access: { id, service, host, status } }` (the same open request is reused) · 422 `invalid` + `errors` · 429 `rate-limited` (5 new per member per hour); `GET /agent/v1/team/access/{id}/launch` (the access launcher `sb-access-mcp.ts`) → 200 `{ command, args, env }` (values read now) · 404 `not-available` (another session, not ready here, revoked, expired).
- **MCP tool**: `request_access` (with `team_handoff`, `team_members`, `team_report`; member sessions only, Team on).
- **Spawn** (no route): a member's ready API keys are environment variables of its process; its MCP accesses join its MCP config (`access-<service>-<id>`: stdio through `node src/hook/sb-access-mcp.ts --switchboard-access <port> <sessionId> <accessId>`, http with `${FIELD}` header references, Claude Code only); its recorded output masks every value as `•••• (FIELD)`.
- **Sync (D48)**: `TeamSyncMessage.snapshot.access: TeamAccessRecord[]` (an older peer sends none); last writer wins per record; never a value.
- **Peers (D48)**: on `PEER_API_ALLOW`: `GET /api/team/members/{id}/access`, `GET /api/team/access/catalog`. Setup, test, revoke and the expiry are not (a peer request to them answers 403).
- **Devices (D73)**: allowed: `GET /api/team/members/{id}/access(/shareable)`, `GET /api/team/access/catalog` (and the request decisions above). Refused: `POST /api/team/access/{id}/(setup|test|revoke)`, `PUT /api/team/access/{id}`.
- **Web (for T3)**: `src/web/team/access/index.ts` exports `AccessTab { memberId, focusAccessId?, loopLabels?, onChanged? }`, `AccessRequestActions { item, onSetUp(memberId, accessId), onDecided? }` and `accessApi`; dev mount `/team-access-dev.html?member=<id>`.

```
POST /agent/v1/team/access { "kind": "api-key", "service": "Acme Analytics", "host": "api.acme.example",
  "why": "Fetch the weekly traffic report.", "scope": "read-only, reports",
  "fields": [{ "name": "ACME_ANALYTICS_KEY", "label": "API key", "secret": true, "help": "Settings → API keys" }] }
→ 201 { "text": "Asked the developer for Acme Analytics on api.acme.example (read-only, reports). …", "access": { "id": "9c1e…", "service": "Acme Analytics", "host": "api.acme.example", "status": "requested" } }

POST /api/team/access/9c1e…/setup { "values": { "ACME_ANALYTICS_KEY": "…" } }
→ 200 { "id": "9c1e…", "status": "ready", "statusText": "Ready on Mac", "here": true, "setUpOn": ["m-mac-0001"],
        "secretRefs": [{ "field": "ACME_ANALYTICS_KEY", "service": "Switchboard Team", "account": "5f0c…/9c1e…/ACME_ANALYTICS_KEY" }], … }
```

## Plans · Jira (D99, 2026-10-13, additive, experimental)
The Jira import and the optional status sync of Plans (`docs/plans.md` → *Jira import and status sync*; decision D99 → *Follow-up · Jira*). Types in `src/core/plans-jira.ts` (`JiraPreview`, `JiraPreviewItem`, `JiraPreviewEdge`, `JiraExternalLink`, `JiraCycleLink`, `PlanJiraState`, `PlanJiraItem`, `PlanJiraActivity`, `JiraConnectionStatus`, `JiraSyncMode`, `JiraTransitionNames`). Every route answers 404 `plans-off` while Plans is off (Settings → Experimental → Plans) or `plans.db` is unavailable.

| Method | Path | Body | Answers |
|---|---|---|---|
| GET | /api/integrations/jira | | 200 `JiraConnectionStatus` `{ configured, source: settings \| env \| null, baseUrl, email, keychain }` (never the token) |
| PUT | /api/integrations/jira | `{ baseUrl, email, token }` | 200 `JiraConnectionStatus` · 409 `keychain-unavailable` · 422 on `baseUrl` (https, or http on loopback) / `email` / `token` |
| DELETE | /api/integrations/jira | | 200 `JiraConnectionStatus` (the Settings credentials removed; `ATL_*` stay) |
| POST | /api/sessions/{id}/plans/jira/preview | `{ epic }` (a key or an issue link) | 200 `JiraPreview` (nothing created) · 404 (session, epic: `jira-not-found`) · 409 `jira-not-configured` · 422 on `epic` (`invalid`, `empty-epic`) · 502 `jira-auth` / `jira-unreachable` / `jira-failed` |
| POST | /api/sessions/{id}/plans/jira/import | `{ epic, targetBranch, title?, baseBranch?, repos?, maxConcurrency?, sync?: off \| read-only \| write, transitions?: { inProgress?, inReview?, done? }, doneOnMerge?: boolean }` (D116: `doneOnMerge` omitted = `true`; `done` default "Done") | 201 `{ plan: Plan, jira: PlanJiraState, preview: JiraPreview }` (a draft) · the preview's errors · the core's `PlanError`s (422 `targetBranch`, 409 `cycle`, `too-many`, …) |
| POST | /api/plans/jira/preview | `{ epic }` (D112: no session yet) | as `POST /api/sessions/{id}/plans/jira/preview` (no session to find) |
| POST | /api/plans/jira/import | the import's body plus `{ folder?, provider?, model?, effort?, profileId?, repos?, sidebarFolderId? }` (D112: where the plan's new session runs; `folder` = a saved folder's id, omitted = the default folder; `repos` optional for a workspace since D115: given, they are the session's solutions and the plan's repos; D119: `sidebarFolderId` = the sidebar folder the plan's own subfolder goes into, `null` = the top level, omitted = no placement, the session unplaced as before) | 201 `{ plan, jira, preview, askedForOrder, askedForRepos, session: Session, sidebarFolder: { id, name, parentId } \| null }` (D119: once the import succeeded, a sidebar folder "Plan · <plan title>" (the session's title cut to 60 characters; " (2)", " (3)"… when that exact name is taken at that level) is made in `sidebarFolderId` with the session as its first item, one D71 layout write published as `sidebarLayoutChanged` and synced like a manual move; `null` when no `sidebarFolderId` was sent or the write failed, which never fails the import) · D119: 422 on `sidebarFolderId` (not a string / null, or a folder 5 levels deep that cannot hold another) · 404 `not-found` on `sidebarFolderId` (no such sidebar folder), both before anything is created (D115: `repos` is optional for a workspace; without it the plan's repos are picked per item and the new session is asked to pick them, `askedForRepos`): a new session "Plan · <plan title>" (the body's `title`, else the epic summary; name `plan-<epic key>`, `-2`… when taken) in that folder is the plan's source · 422 on `folder` / `repos` / `provider` / `model` / `profileId` and the import's fields · 409 `not-a-repo` (a plain folder), `no-folder`, `folder-missing` · the preview's errors · the core's `PlanError`s. Checked in that order, so a refusal before the session starts creates nothing; a refusal after it (the core's) closes and deletes that session again (and no sidebar folder is made: it is made only after success). **D119 on a paired machine:** `POST /api/machines/{id}/api/plans/jira/import` checks `sidebarFolderId` against **this** machine's layout, forwards the body **without** it, and, after that machine's 2xx, makes the subfolder in this machine's layout holding the session's remote id (`r~<machine>~<id>`); the answer's `sidebarFolder` is this machine's. With the D71 shared layout on, the records reach the other machine like any move. |
| GET | /api/plans/{id}/jira | | 200 `PlanJiraState` · 404 `not-jira` (not imported from Jira) / `not-found` |
| PUT | /api/plans/{id}/jira | `{ sync?, transitions?, doneOnMerge? }` (D116: `doneOnMerge` a boolean, `transitions.done` a name) | 200 `PlanJiraState` · 409 `finished` · 422 on `sync` / `transitions.*` / `doneOnMerge` |
| POST | /api/plans/{id}/jira/refresh | | 200 `PlanJiraState` (tickets read again) · 409 `sync-off` · 502 `jira-auth` / `jira-unreachable` |
| POST | /api/plans/{id}/jira/dependencies | `{ apply?, fingerprint? }` | D117: 200 `JiraRelinkDiff` `{ removed, added, unchanged, kept, cycles, fingerprint, applied }` (Re-read dependencies from Jira; `apply: true` makes the change) · 409 `not-draft` / `changed` · 404 `not-jira` · 502 `jira-auth` / `jira-unreachable` |
| GET | /api/plans/{id}/proposals | | 200 `PlanEdgeProposal[]` (oldest first, every state) |
| POST | /api/plans/{id}/proposals/ask | | 200 `{ asked: true, sessionId }` (the source session is sent the ask) · 409 `not-draft` / `not-sent` · 422 `too-few` |
| POST | /api/plans/{id}/solutions/ask (D115) | | 200 `{ asked: true, sessionId, items }` (**Ask again**: the source session is asked to pick the repositories of the items without any; any plan with `reposPerItem`; re-arms the 15-minute check and closes the plan's open `plan-pick-repos` Inbox item) · 409 `nothing-to-pick` / `not-sent` (also a line of a Jira plan's activity, and the Inbox item) / `finished` · forwarded to a paired machine's plan, allowed to phones |
| POST | /api/plans/{id}/proposals/{proposalId}/accept | | 200 `{ proposals, refused: [] }` (the dependency added) · 404 · 409 `cycle` (stays pending, `note` = the reason) / `decided` |
| POST | /api/plans/{id}/proposals/{proposalId}/reject | | 200 `{ proposals, refused: [] }` · 404 · 409 `decided` |
| POST | /api/plans/{id}/proposals/accept-all · reject-all | | 200 `{ proposals, refused: [{ id, text, reason }] }` (every pending one; a refused one stays pending) |
| POST | /agent/v1/plans/{planId}/proposals | `{ proposals: [{ from, to, reason }] }` (agent token; the plan's source session) | 201 `{ added: PlanEdgeProposal[], skipped: [{ from, to, why }] }` · 404 · 409 `finished` · 422 on `proposals` |
| GET | /agent/v1/plans/{planId}/jira/context?item=&part= | (agent token; the plan's source session or one of its item run sessions) | D118: 200 `{ planId, epicKey, item: key \| null, text }` (the full current Jira context of the item's ticket and/or the epic, read from Jira now; `item` a key or item id, default the run session's own item; `part` `item` \| `epic` \| `both`, default `both` with an item, else `epic`) · 404 `not-found` (another session's plan, an unknown item) / `not-jira` / `plans-off` · 409 `jira-not-configured` · 422 on `part` / `item` · 502 `jira-auth` / `jira-unreachable` / `jira-failed` |
| GET | /agent/v1/plans/jira/context?item=&part= | (agent token; an item run session) | D118: as above, for the run session's own plan (404 `not-found` for a session that runs no plan item) |

- **`JiraPreview`**: `{ epic: { key, summary, url }, items: JiraPreviewItem[], edges: [{ from, to, text }], externalLinks: [{ key, other, relation: waits-on | blocks, text }], cycles: [{ from, to, cycle, text }], unlinked: key[], truncated, suggestedTitle, suggestedTargetBranch, proposeAvailable: false }`. Keys are the edges' ids; "`to` waits on `from`" = the plan's "`to` after `from`". `JiraPreviewItem`: `{ key, summary, description, acceptanceCriteria, acceptanceSource: field | description | null, components, status, assignee, estimateMinutes, url, unlinked }`. D118 (additive, the preview routes only; the import's answer leaves them out): `JiraPreviewItem.counts` `{ comments, subtasks, links, attachments }` (links = remote links plus links to issues outside the epic) and `JiraPreview.epic.description`, `.acceptanceCriteria`, `.counts`.
- **`PlanJiraState`**: `{ planId, epicKey, epicUrl, sync, transitions: { inProgress, inReview, done }, doneOnMerge, lastRefreshAt, items: [{ itemId, key, url, statusAtImport, status, statusCategory, summary, refreshedAt, drift, syncNote }], activity: [{ id, at, itemId, key, kind: import | refresh | transition | comment | soft-failure | error | settings, text }] }` (activity newest first, at most 200). `drift` is `null` while the sync is off. D116 (additive): `transitions.done` (default "Done") and `doneOnMerge` (on for a plan imported since D116, off for one imported before): with the write sync, an item merged into the target (an agent's merge or the developer's Merge; not Mark done, not a `none` plan) moves its ticket through `transitions.done` after the "Merged into" comment, write event `done:<item>`; the activity line is a `transition` "Moved PROJ-12 to Done (merged into <target>)".
- **`PlanEdgeProposal`** (ruling D99-Jira-q1 (b)): `{ id, planId, fromItemId, toItemId, from, to, reason, state: pending | accepted | rejected, note, text: "PROJ-15 should wait on PROJ-14", createdAt, decidedAt }`. The import's answer carries `askedForOrder` (the source session was asked because items have no links) and, D115, `askedForRepos` (asked to pick the items' repositories with `plan_set_solutions`; both asks go in one message). `PlanJiraActivity.kind` gains `ask-repos` (D115, additive). MCP tool `plan_propose_dependencies { plan_id, proposals }` (with the plan tools, only while Plans is on). D118: MCP tool `plan_jira_context { plan_id?, item?, part? }` (read-only; with the plan tools while Plans is on; the agent routes above). An item's run's first message carries a "Jira context" block (the ticket and the shortened epic, read from Jira at the run's start; the message at most 40,000 characters), and the asks to the plan's source session end with the full epic; a todo made by the import is a short summary (`docs/plans.md` → *Jira context (D118)*). `PlanJiraActivity` gets an `error` line when a run's start could not read Jira. No new storage.
- **Hub**: no new event. A Jira write, a refresh, a settings change, new proposals or a decision publishes `planChanged` for the plan; the page reloads `GET /api/plans/{id}/jira` with the plan.
- **Peers (D48)**: on `PEER_API_ALLOW`: the preview, the import (both forms: a session's, and D112's `POST /api/plans/jira/preview | import`, reached as `/api/machines/{id}/api/plans/jira/…` and run on that machine, a long call like a start), `GET|PUT /api/plans/{id}/jira`, the refresh, the proposals' list, ask and decisions (a remote session or plan id is forwarded to its machine, which uses its own credentials). The credential routes are not (403 to a peer). A forwarded import's `plan` is namespaced like an added item's (`plan-item`); D112's import namespaces its `plan` and its `session` (`plan-import`); `PlanJiraState` and the proposals pass raw (their ids are the plan's raw item ids).
- **Devices (D73)**: allowed: the preview, the import (both forms, D112's too), `GET|PUT /api/plans/{id}/jira`, the refresh, the proposals' list, ask and decisions. Refused: `/api/integrations/jira` (all methods).
- **Web (for the Plans page)**: `src/web/plans/jira/index.ts` exports `ImportJiraDialog { sourceSessionId?, repos?, initialEpic?, onImported(plan), onClose(), onUseSession? }` (D112: without `sourceSessionId` it asks *Where it runs* and imports into a new session), `PlanJiraPanel { planId }`, `JiraCredentialsForm { onChanged? }` (mounted in Settings → Experimental → Plans while on), `PlanEdgeProposals { planId }` and `jiraApi`; the epic field carries `data-tour="plans-jira-epic"`; dev mount `/plans-jira-dev.html?session=<sessionId>` or `?plan=<planId>`.

```
POST /api/sessions/5f0c…/plans/jira/preview { "epic": "https://acme.atlassian.net/browse/PROJ-10" }
→ 200 { "epic": { "key": "PROJ-10", "summary": "Acme checkout", "url": "https://acme.atlassian.net/browse/PROJ-10" },
        "edges": [{ "from": "PROJ-11", "to": "PROJ-12", "text": "PROJ-12 waits on PROJ-11" }],
        "cycles": [{ "from": "PROJ-13", "to": "PROJ-14", "cycle": ["PROJ-13", "PROJ-14", "PROJ-13"],
                     "text": "PROJ-14 waits on PROJ-13 was left out: PROJ-13 → PROJ-14 → PROJ-13 would be a cycle (each waits on the next)" }],
        "externalLinks": [{ "key": "PROJ-15", "other": "PROJ-99", "relation": "waits-on", "text": "PROJ-15 waits on PROJ-99 (outside the epic)" }],
        "unlinked": ["PROJ-15"], "suggestedTargetBranch": "feature/PROJ-10-acme-checkout", "proposeAvailable": false, … }

POST /api/sessions/5f0c…/plans/jira/import { "epic": "PROJ-10", "targetBranch": "feature/PROJ-10-acme-checkout", "sync": "write" }
→ 201 { "plan": { "id": "a1b2c3d4e5", "state": "draft", "mergeMode": null, "external": { "system": "jira", "key": "PROJ-10" }, … },
        "jira": { "sync": "write", "transitions": { "inProgress": "In Progress", "inReview": "In Review", "done": "Done" }, "doneOnMerge": true, … }, "preview": { … } }
```

## Chats (D106, 2026-10-14, additive)

A chat is a conversation to think and plan in, started instead of a development session (`docs/chats.md`, `docs/decisions.md` → D106): its own scratch folder `<dataDir>/chats/<id>/`, its CLI's read-only / plan mode (every permission request refused by Switchboard), the switchboard MCP tools, optional folders it may read. Migration 0044 adds `sessions.kind` and `sessions.look_at`.

| Method | Path | Body | Answers |
|---|---|---|---|
| POST | /api/chats | `NewChat` `{ message, attachments?, provider?, profileId?, model?, effort?, lookAt? }` | 201 `Session` (`kind: "chat"`, `title` from the message) · 422 `invalid` (`message` empty; `provider` unknown / not available / without a read-only mode; `profileId`; `model` / `effort`; `lookAt` not absolute, missing, not a folder or more than 10; `attachments`) · 503 `closing` |
| PUT | /api/chats/{id}/look-at | `{ lookAt: string[] }` | 200 `Session` (its process restarts to read them: now when idle, after its turn when busy) · 404 `not-found` · 409 `not-a-chat` / `closed` · 422 `invalid` (as above) |
| DELETE | /api/chats/{id} | `{ confirm?: boolean }` (as Close's) | 204 (closed first, then its record, scratch folder, attachments and exports are removed) · 404 `not-found` · 409 `not-a-chat` (a session goes through Clean-up) · 409 `close-needs-confirm` |

- **`Session.kind`** (additive): `"chat"` for a chat; absent for a development session (and from a machine before D106). **`Session.lookAt`** (additive, chats only): the folders it may read (canonical absolute paths). A chat has `folder: null`, `solutions: []`, `worktrees: false`; its `cwd` is its scratch folder.
- **`NewSession.fromChat`** / `NewRepoSession.fromChat` / `NewSimpleSession.fromChat` (additive): Continue as session: the chat (this machine's id) whose conversation (Switchboard's export) starts the new session's first message, before the task; linked both ways (`continuedFrom` on the session, `continuedTo` on the chat, which stays open). 422 on field `fromChat` when it names no chat. `NewSessionPrefill.fromChatTitle` (additive): the form's note.
- **Refusals for a chat** (409 `chat`): `POST /api/sessions/{id}/detach`, `PUT /api/sessions/{id}/remote` `{ enabled: true }`, a take-over (a blocker), `POST /api/team/members` (adopt), `POST /api/plans` (as the source). Checkpoints are never taken; solution rows and conflicts leave chats out.
- **Lifecycle events** (`LifecyclePayload.action`, additive): `chat-refused` (kind `text`, label `Refused in a chat: <tool> (chats can plan but not edit)`, `message` = the tool) and `look-at-updated` (the divider `Folders to look at updated`). Continue as session uses `continued-from` (`Continued from the chat <title>`) and `continued-in` (`Continued as <session>`) with `linkedSessionId` / `linkedTitle`. A turn that left plan mode records a `mode-mismatch` text line with `fallback: "plan"`.
- **`SearchResult.chat`** (additive): `true` when the result's session is a chat.
- **Peers (D48):** the three routes are on `PEER_API_ALLOW` (`POST /api/chats` and the look-at answer are mapped as a `session`). **Devices (D73):** on `DEVICE_ALLOWED`.

```json
POST /api/chats
{ "message": "How should we split the billing module?", "provider": "claude", "lookAt": ["/Users/dev/acme/billing"] }
→ 201 { "id": "7cf6…", "kind": "chat", "title": "How should we split the billing module?", "cwd": "<dataDir>/chats/7cf6…", "folder": null, "lookAt": ["/Users/dev/acme/billing"], "status": "run", "…": "…" }

POST /api/sessions
{ "simple": true, "name": "billing-split", "title": "Billing split", "task": "Implement the plan.", "folder": "f1", "fromChat": "7cf6…" }
→ 201 { "id": "9a2b…", "continuedFrom": { "sessionId": "7cf6…", "title": "How should we split the billing module?" }, "…": "…" }
```

## Project memory (D107, 2026-10-14, additive, experimental)
Developer decision D107 (`docs/decisions.md`; details `docs/memory.md`; removal `docs/memory-removal.md`). Types in `src/core/memory.ts` (`MemoryState`, `MemoryEntry`, `MemoryScope`, `MemorySettings`, `MemoryChanged`). Data in the separate `<dataDir>/memory.db` (no migration in the main database). **Off by default** (setting `experimental.memory`, `PUT /api/settings`): while off only `GET /api/memory/state` answers; every other route below is 404 `memory-off`; with a broken `memory.db` they are 503 `memory-unavailable`. Errors are `{ error, message }` (+ `errors: [{ field, message }]` for a 422 on a field).

| Method | Path | Body | Answers |
|---|---|---|---|
| GET | /api/memory/state | | 200 `MemoryState` `{ enabled, available, problem }` (always) |
| GET | /api/memory/scopes | | 200 `MemoryScope[]` `{ scope, label, saved, approved, proposed }` (the saved folders, then other folders with entries) |
| GET | /api/memory/entries | `?scope=` (a folder; none = all), `?status=` (`proposed` \| `approved` \| `rejected`) | 200 `MemoryEntry[]` (approved in block order, then proposed oldest first, then rejected newest first) |
| POST | /api/memory/entries | `{ scope, title, text, tags?, pinned? }` | 201 `MemoryEntry` (the developer's: `approved`) · 422 |
| PUT | /api/memory/entries/{id} | any of `{ title, text, tags, pinned }` | 200 `MemoryEntry` (a proposal stays proposed) · 404 · 422 |
| DELETE | /api/memory/entries/{id} | | 204 · 404 |
| POST | /api/memory/entries/{id}/approve | any of `{ title, text, tags, pinned }` (the edit is what is approved) | 200 `MemoryEntry` · 404 · 409 `not-proposed` (already approved) · 422 |
| POST | /api/memory/entries/{id}/reject | | 200 `MemoryEntry` · 404 · 409 `not-proposed` |
| GET · PUT | /api/memory/settings | PUT `{ cap }` (500–20,000) | 200 `MemorySettings` `{ cap }` (default 4,000) · 422 |

- **`MemoryEntry`**: `{ id, scope, title, text, tags, authorKind: agent | developer, authorSessionId, authorLabel, status: proposed | approved | rejected, pinned, createdAt, updatedAt, decidedAt, decidedBy: 'developer' | null, proposedTitle, proposedText }` (`proposed*`: the agent's own words when the developer changed them, else `null`).
- **Agent routes** (the `switchboard` MCP helper, agent token; the caller session's folder; 404 `memory-off` while off, 404 `no-folder` for a chat or a session without a folder): `GET /agent/v1/memory` → `{ scope, label, entries: MemoryEntry[] }` (**approved only**; also the helper's probe), `POST /agent/v1/memory` `{ title, text, tags? }` → 201 `MemoryEntry` (**always `proposed`**) · 409 `duplicate` (a near-identical title in the folder) · 429 `rate-limited` (10 per session per hour) · 422. MCP tools, registered only while on: `memory_propose`, `memory_list`.
- **Injection:** a session's instruction (D64; `--append-system-prompt` / `developerInstructions` / `system`) ends with its folder's approved entries between `=== Project memory (approved by the developer) ===` and `=== End of project memory ===`; D91's `Session.instructionOutdated` includes it. Ruling 2026-10-14: a change of the approved set only flags open sessions (`instructionOutdated: true`, `sessionUpdated`); nothing is restarted until the developer applies or reloads (D91).
- **Duplicates (ruling 2026-10-14):** 409 `duplicate` for a title near-identical to a proposed or approved entry of the folder, or one rejected in the last 30 days.
- **Approval presence:** none beyond the developer routes' own authentication (researched, not built: `docs/security.md` → *Project memory approval presence (D107)*).
- **Additive fields:** settings key `experimental.memory` (boolean, default `false`); Inbox system items of `source: 'memory'` (`kind: memory-proposals`, label `Memory`, title "N memory proposals for <folder>", actions `open-memory` (**Review**: the UI goes to `InboxItem.route`, `/memory?scope=<folder>`, without calling the server) and `dismiss`), closed `resolved` once the folder has no proposals.
- **`/hub`:** `memoryChanged` `{ scope }` (`null`: the switch or the cap).
- **Peers (D48):** every `/api/memory` route is on `PEER_API_ALLOW` (a paired machine's memory through `/api/machines/{id}/api/memory/…`). **Devices (D73):** the reads, `PUT /api/memory/entries/{id}`, `…/approve` and `…/reject` are allowed; `POST /api/memory/entries`, `DELETE /api/memory/entries/{id}` and `PUT /api/memory/settings` are refused.

```
POST /agent/v1/memory { "title": "Run the tests with the test ports", "text": "SWITCHBOARD_TEST_PORTS=4900-4909 npx vitest run <file>" }
→ 201 { "id": "4be1c09d2a", "scope": "/Users/dev/acme", "status": "proposed", "authorKind": "agent", "authorSessionId": "6f1e…", … }

POST /api/memory/entries/4be1c09d2a/approve { "text": "SWITCHBOARD_TEST_PORTS=4900-4909, port-hungry files one by one." }
→ 200 { "id": "4be1c09d2a", "status": "approved", "text": "SWITCHBOARD_TEST_PORTS=4900-4909, port-hungry files one by one.",
        "decidedBy": "developer", "proposedText": "SWITCHBOARD_TEST_PORTS=4900-4909 npx vitest run <file>", … }

GET /api/memory/entries (Project memory off)
→ 404 { "error": "memory-off", "message": "Project memory is off: switch it on in Settings → Experimental" }
```

### Scopes and draft asks (D107 follow-up, 2026-10-15, additive)
Decision: `docs/decisions.md` → *D107 follow-up · scopes*; details `docs/memory.md` → *Scopes*, *Draft memory from a session*. New types in `src/core/memory.ts`: `MemoryScopeKind` (`member` \| `repo` \| `workspace`), `MemoryScopeOption` `{ kind, key, label }`, `MemorySessionCount`, `MemoryDraftAnswer`, `MemoryDraftAllAnswer`. `memory.db` migration 2 (`memory_scopes`); migration 1 is unchanged.

- **`MemoryEntry`** gains `scopeKind`, `scopeKey` (`repo`: the repository's normalized remote key, else its main checkout's path; `member`: the member id; `null` for `workspace`) and `scopeLabel` (the repository's name / the role name). Entries made before are `workspace` (`scope` keeps meaning the folder). A reader that ignores the new fields sees what it saw before. **`MemoryState`** gains `members` (Team members, 0 while Team is off).
- **Visibility:** a session sees its folder's `workspace` entries, the `repo` entries of the repositories it works in (any folder; a linked worktree is its repository) and its member's `member` entries (any folder).

| Method | Path | Query / body | Answers |
|---|---|---|---|
| GET | /api/memory/entries | `?kind=member\|repo\|workspace` (additive filter) | as before |
| GET | /api/memory/scope-options | `?scope=<folder>` `&entry=<id>` (optional) | 200 `MemoryScopeOption[]`: Workspace, the repositories of the proposing session, of the folder's open sessions and of the folder's repo entries, the Team members |
| POST · PUT | /api/memory/entries, /api/memory/entries/{id}, …/approve | additive `{ scopeKind?, scopeKey? }` (a repo or member scope must be one of the options) | as before · 422 `invalid` (`field`: `scopeKind` / `scopeKey`) |
| GET | /api/memory/sessions/{id} | | 200 `MemorySessionCount` `{ count, member, repo, workspace, overflow, proposed, folder }` (what the session receives) · 404 |
| POST | /api/memory/draft | `{ sessionId }` or `{ memberId }` | 200 `MemoryDraftAnswer` `{ asked, reason, askedAt }` (`reason`: `asked-recently` within 24 h, `no-folder`, `closed`, `not-sent: …`, or the paired machine's) · 404 · 422 |
| POST | /api/memory/draft-all | `{ teamId? }` (none or `all`: every team) | 200 `MemoryDraftAllAnswer` `{ asked: [{ memberId, name }], skipped: [{ memberId, name, reason }] }` |
| POST | /api/memory/import | `{ sessionId, memberId, entries: MemoryEntry[] }` (a paired machine, after a member moved here) | 200 `{ imported }` · 422 |
| POST | /api/inbox/{id}/actions/memory-copy-retry · …/memory-copy-keep | (2026-10-16) the `memory-copy` item's **Retry** / **Keep on this PC** | as every system item action; Retry while the copy still fails: 409 `refused` with the reason (the item stays open) |

- **Agent routes:** `POST /agent/v1/memory` takes `{ title, text, tags?, scope?, repo? }` (`scope`: `member`, `repo` or `workspace`); without `scope`: `member` for a Team member, `repo` when the session works in exactly one repository, else `workspace`; 422 `invalid` for `member` from a non-member, `repo` without a repository, or several repositories and no (known) `repo`. `GET /agent/v1/memory`'s `entries` are the visible ones, member first, then repo, then workspace (each in block order), each with its scope fields.
- **Injection:** the block is ordered member, repo, workspace (pinned, then newest within each) under separate budgets of the cap (50 / 30 / 20 %; without a member 60 / 40 % for repo / workspace); unused budget passes on and back; the entries that did not fit are named on the overflow line. A block with workspace entries only is as before. The Team charter is not counted against the cap.
- **A moved member's memory not taken (rulings 2026-10-16):** kept on the old machine as a pending copy (`memory.db` migration 3), retried with backoff (1, 5, 30 min, then hourly), on the other machine's `machineState` online and on its `memoryChanged`; after 3 failures or an hour an Inbox system item of `source: 'memory'`, `kind: memory-copy` (label `Memory`), title "<member> is missing its memory on <PC>", payload `{ memberId, machineId }`, actions `memory-copy-retry` (**Retry**) and `memory-copy-keep` (**Keep on this PC**); closed `resolved` once the copy succeeds. **`/hub` between peers:** `memoryChanged` is now on the peer stream (`PEER_HUB_EVENTS`); the receiving machine never republishes it.
- **Peers (D48):** the new routes are on `PEER_API_ALLOW`. **Devices (D73):** `GET /api/memory/sessions/{id}` and `GET /api/memory/scope-options` are allowed; `POST /api/memory/draft`, `…/draft-all` and `…/import` are refused.

```
POST /agent/v1/memory { "title": "Builder release steps", "text": "Tag, then publish." }   (a Team member's session)
→ 201 { "id": "7c0d…", "status": "proposed", "scopeKind": "member", "scopeKey": "m-41f…", "scopeLabel": "Builder", … }

POST /api/memory/entries/7c0d…/approve { "scopeKind": "repo", "scopeKey": "github.com/acme/acme-app" }
→ 200 { "id": "7c0d…", "status": "approved", "scopeKind": "repo", "scopeKey": "github.com/acme/acme-app", "scopeLabel": "acme-app", … }

POST /api/memory/draft { "memberId": "m-41f…" }
→ 200 { "asked": true, "reason": null, "askedAt": "2026-10-15T10:00:00.000Z" }
POST /api/memory/draft { "memberId": "m-41f…" }   (again, the same day)
→ 200 { "asked": false, "reason": "asked-recently", "askedAt": "2026-10-15T10:00:00.000Z" }
```

**D135 · changing approved entries** (`docs/memory.md` → *Changing approved entries (D135)*; `memory.db` migration 4 `memory_changes`). `MemoryEntry` gains `changeKind?` (`add` \| `edit` \| `retract`; absent = `add`), `targetId?`, `reason?`, `targetTitle?`, `targetText?` and, in `GET /api/memory/entries` only, `target?: MemoryEntry | null` (the approved entry a change is about, as it is now).

- **Agent routes:** `POST /agent/v1/memory/edit` `{ entry, title?, text?, reason? }` and `POST /agent/v1/memory/retract` `{ entry, reason }` → 201 `MemoryEntry` (`status: proposed`, `changeKind: edit | retract`) · 404 `not-found` (no approved entry with that id) · 403 `out-of-scope` (not one the session sees) · 422 `invalid` / `no-change` · 409 `duplicate` (this session's pending change of that kind for that entry) · 429 `rate-limited` (shared with `POST /agent/v1/memory`). MCP tools `memory_propose_edit`, `memory_propose_retract`; `memory_list` adds each entry's id and last update.
- **UI routes (unchanged paths):** `POST /api/memory/entries/{id}/approve` `{ title?, text? }` on a change proposal applies it (an edit replaces the target's title / text and answers the target, same id; a retract deletes the target and answers it as it was) · 409 `target-gone`; `POST …/reject` keeps the target; `PUT /api/memory/entries/{id}` `{ title?, text? }` edits an edit proposal's new wording (409 `not-editable` for a retract); `DELETE` of an entry also deletes the proposals about it.

```
POST /agent/v1/memory/edit { "entry": "0a1b2c3d4e", "text": "npm run test:unit", "reason": "The script was renamed." }
→ 201 { "id": "5f6e7d8c9b", "status": "proposed", "changeKind": "edit", "targetId": "0a1b2c3d4e", "reason": "The script was renamed.", "target": { "id": "0a1b2c3d4e", "text": "npm test", … }, … }
```

**D136 · memory checks** (`docs/memory.md` → *Checking notes (D136)*; `memory.db` migration 5 `memory_checks`; main migration 0051 `insight_background_turns`). Types in `src/core/memory-check.ts`. `MemoryEntry` gains, in `GET /api/memory/entries` only, `check?: MemoryProposalCheck | null` on a proposed note the proposal check flagged (`{ verdict: duplicate | conflict, targetId, targetTitle, reason, checkedAt }`).

| Method | Path | Body / query | Answers |
|---|---|---|---|
| POST | /api/memory/entries/{id}/approve | `{ …, removeConflicting: true }` | as before; also moves the flagged approved note to the removed list |
| GET | /api/memory/removed | `scope` (a folder; absent = every folder) | 200 `MemoryRemovedEntry[]` (`{ id, scope, entry, reason, removedBy: check \| approval, removedAt, purgeAt }`), newest first |
| POST | /api/memory/removed/{id}/restore | — | 200 `MemoryEntry` (approved again, same id) · 404 `not-found` |
| GET | /api/memory/check | `scope` | 200 `MemoryCheckStatus` (`{ folder, enabled, settings, lastRunAt, lastResult, nextDueAt, running, notes }`) · 422 without `scope` |
| PUT | /api/memory/check | `{ scope, enabled }` | 200 `MemoryCheckStatus` (the folder's switch) |
| POST | /api/memory/check/run | `{ scope }` | 202 `MemoryCheckStatus` (Check now; runs in the background) · 409 `no-notes` |
| GET / PUT | /api/memory/check/settings | `{ enabled?, frequencyDays? }` (1, 3, 7, 14, 30) | 200 `MemoryCheckSettings` · 422 `invalid` |

Every check route answers 404 `checks-off` where checks do not run (demo mode). Phones: the GETs and Restore (`DEVICE_ALLOWED`); the PUTs and `check/run` are refused (`DEVICE_REFUSED`). Paired machines: all (`PEER_API_ALLOW`). No hub event of its own: `memoryChanged { scope }` when a run starts, ends or changes notes. Insights → Usage: a memory check's turns are rows of kind `memory` (`UsageKind`), session id `memory-check~<folder>` (nothing to open, `sessionId: null` on its ranked row).

```
POST /api/memory/check/run { "scope": "/work/acme-app" }
→ 202 { "folder": "/work/acme-app", "running": true, "lastResult": null, … }
GET /api/memory/check?scope=%2Fwork%2Facme-app
→ 200 { "lastResult": { "outcome": "done", "trigger": "manual", "checked": 12, "removed": 1, "edits": 2, "retracts": 0, … }, … }
POST /api/memory/removed/0a1b2c3d4e/restore
→ 200 { "id": "0a1b2c3d4e", "status": "approved", … }
```

## Insights (D108, 2026-10-14, additive)

The Insights page in one answer (`docs/insights.md`, `docs/decisions.md` → D108): time and tokens, estimate accuracy, outcomes and rework, cost per todo run, the usage-limit forecast and suggested routing rules, from **this machine's** data. Types in `src/core/insights.ts`: `InsightsAnswer`, `InsightsQuery`, `TimeTokensRow`, `TrendPoint`, `AccuracyDistribution`, `AccuracyGroup`, `OutcomeRow`, `CostSection`, `TodoCost`, `AccountForecast`, `WindowForecast`, `RoutingSuggestion`, `PriceTable`, `ModelPrice`. Migration 0045 (the daily rollup, `todo_actuals`' new columns, `todo_reopens`, an index on `usage_readings`).

| Method | Path | Query | Answers |
|---|---|---|---|
| GET | /api/insights | `period` (`7d` · `30d` default · `90d` · `custom`), `from` / `to` (`YYYY-MM-DD`, UTC days, both included; `custom` only, at most 366 days), `folder` (a folder key: a session root, a paired machine's `<path>@@<machine>`; `none` = no folder), `cli`, `model` (a model key; `none` = the CLI's default), `account` (a profile id); each filter absent or `all` = everything; `machine` (`all` default: merged with the paired machines · `local`), `peers` (`cached` default: never waits for a paired machine · `wait`: up to 2.5 s each) | 200 `InsightsAnswer` · 422 `invalid` + `errors` (`field`: `period`, `from`, `to`, `folder`, `cli`, `model`, `account`, `machine`, `peers`) |
| GET | /api/insights/rows | `from`, `to` (as above) | 200 `InsightsRows` `{ turns, todos, plans, mergeDecisions, readings, accounts (with `identity`), sessionTitles, accountNames }`: this machine's rows of those days (what a paired machine merges) · 422 `invalid` |

- **`InsightsAnswer`**: `{ generatedAt, query, options: { folders, clis, models, accounts: { id, name }[], folderLabels }, backfill: { done, percent }, machines, time, estimates, outcomes, cost, forecast, suggestions }`. **`machines`** (ruling 2026-10-14): `{ scope: "all" | "local", included: { id (null = this machine), name }[], pending: { id, name }[] (ask again with `peers=wait`), missing: { id, name, reason }[] }`. `options.folderLabels`: a folder key → its label where it is not the path's last segment (`acme · Studio`). `options` lists the values found in the period (before the filters). `backfill.done` is `false` while the rollup still adds the events from before 0045 (the numbers are then partial).
- **`time`**: `{ totals: { turns, tokens, durationMs, tokensPerTurn, sessions }, byFolder, bySession (top 20 by tokens), byModel: TimeTokensRow[], trend: TrendPoint[] (one per day of the period), chats: { turns, tokens, durationMs } }`. `TimeTokensRow`: `{ key, label, turns, tokens, durationMs, tokensPerTurn }`; `TrendPoint`: `{ day, turns, tokens, tokensPerTurn }` (`null` without turns). Chats (D106) are only in `chats`.
- **`estimates`**: `{ count, median, buckets: { key, label, count }[], byModel, byFolder: AccuracyGroup[] }`; buckets `under-half` (< 0.5×), `half-to-one` ([0.5, 1)), `one-to-two` ([1, 2)), `over-two` (≥ 2) of actual ÷ estimate.
- **`outcomes`**: `{ plansOn, byModel: OutcomeRow[] }`; `OutcomeRow`: `{ model, label, todos: { done, reopened, reopenRate }, plans: { merged, failed, blocked, mergeRate, decisions: { merged, sentBack, failed }, sendBackRate } | null, reverts: { turns, reverts, redos, per100Turns } }` (`plans` is `null` while Plans is off).
- **`cost`**: `{ currency, example, todos, priced, total, average, median, lowerBound, byModel: { model, label, todos, priced, total, median }[], top: TodoCost[] (≤ 10), period: PeriodCost }`; **`PeriodCost`** (ruling 2026-10-14, every turn of the period): `{ total, lowerBound, unpricedTokens, byFolder, byModel: { key, label, cost (null: no price row), lowerBound, unpricedTokens }[], chats }`; `TodoCost`: `{ todoId, title, sessionId, runSessionId, model, modelLabel, tokens, actualMs, cost (null: no price row), lowerBound, completedAt }`. `example: true` while the prices are Switchboard's examples.
- **`forecast`**: `AccountForecast[]` (Claude Code accounts; the `account` / `cli` filters apply, the period does not): `{ profileId, name, cli, windows: WindowForecast[] (five_hour, seven_day), credits (D103 text or null), onCredits }`; `WindowForecast`: `{ window, pct, resetsAt, pctPerHour, readings, verdict: "full" | "fills" | "holds" | "flat" | "unknown", fullAt, atReset }`.
- **`suggestions`**: `RoutingSuggestion[]`: `{ id, text, evidence: { cheap, expensive: { model, todos, reopened, medianCost }, currency }, rule }`; `rule` is a D82 `ModelRule` without its `id`. Never applied by the server; the page opens `/settings/sessions?suggestRule=<JSON of rule>`, which adds it to the Model by task editor unsaved.
- **Settings:** `insights.prices` (editable, `PriceTable`: `{ currency (1–8 characters), example, models: { match, input, output, cacheWrite, cacheRead }[] (≤ 40; prices 0–100,000 per 1M tokens) }`; default `EXAMPLE_PRICES`, `example: true`); 422 `invalid` with `field` `insights.prices…` for a bad table.
- **Result events** (additive payload fields, D108): a turn's `result` payload carries `usage: { input, output, cacheWrite, cacheRead }` and `model` (the model the CLI reported) when the CLI line has them.
- **Peers (D48):** `GET /api/insights` and `GET /api/insights/rows` are on `PEER_API_ALLOW`; a paired machine's request answers its own data (never fans out). The merged view pulls each online paired machine's rows (`/api/insights/rows`) when asked, cached 60 s; an offline, slow or older machine is listed in `machines.missing`. A single paired machine's own view: `/api/machines/{id}/api/insights?…&machine=local`. **Devices (D73):** both allowed (reads). No new `/hub` event.
- **UI address:** `/insights?period=…&from=…&to=…&folder=…&cli=…&model=…&account=…&machine=…` (`machine` absent = All machines, `local`, or a paired machine's id).

```
GET /api/insights?period=7d&model=claude-haiku-4-5
→ 200
{ "generatedAt": "2026-10-14T12:00:00.000Z",
  "query": { "period": "7d", "from": "2026-10-08", "to": "2026-10-14", "folder": null, "cli": null, "model": "claude-haiku-4-5", "account": null },
  "options": { "folders": ["/work/acme", "/work/docs"], "clis": ["claude"], "models": ["claude-haiku-4-5", "claude-opus-5-5"], "accounts": [{ "id": "default-claude", "name": "Work" }] },
  "backfill": { "done": true, "percent": 100 },
  "time": { "totals": { "turns": 6, "tokens": 12000, "durationMs": 120000, "tokensPerTurn": 2000, "sessions": 1 }, "byFolder": [ … ], "bySession": [ … ], "byModel": [ … ], "trend": [ { "day": "2026-10-08", "turns": 0, "tokens": 0, "tokensPerTurn": null }, … ], "chats": { "turns": 0, "tokens": 0, "durationMs": 0 } },
  "estimates": { "count": 3, "median": 0.6, "buckets": [ { "key": "under-half", "label": "< 0.5×", "count": 1 }, … ], "byModel": [ … ], "byFolder": [ … ] },
  "outcomes": { "plansOn": false, "byModel": [ { "model": "claude-haiku-4-5", "label": "claude-haiku-4-5", "todos": { "done": 3, "reopened": 0, "reopenRate": 0 }, "plans": null, "reverts": { "turns": 6, "reverts": 0, "redos": 0, "per100Turns": 0 } } ] },
  "cost": { "currency": "USD", "example": true, "todos": 3, "priced": 3, "total": 0.0288, "average": 0.0096, "median": 0.0096, "lowerBound": false, "byModel": [ … ], "top": [ … ] },
  "forecast": [ { "profileId": "default-claude", "name": "Work", "cli": "claude", "credits": null, "onCredits": false,
    "windows": [ { "window": "five_hour", "pct": 40, "resetsAt": "2026-10-14T14:00:00.000Z", "pctPerHour": 20, "readings": 3, "verdict": "holds", "fullAt": null, "atReset": 80 }, … ] } ],
  "suggestions": [] }
```

## Insights › Usage breakdown (D134, 2026-10-26, additive)

"Where your usage went" (`docs/insights.md` → *Usage breakdown (D134)*, `docs/decisions.md` → D134). Types in `src/core/usage-breakdown.ts`. Migration 0050 (`insight_turns`, one row per turn).

| Method | Path | Query | Answers |
|---|---|---|---|
| GET | /api/insights/usage | `period` (`5h` default · `week` · `today` · `7d`), `account` (a profile id; absent = all, each in its own window), `groupBy` (`session` default · `folder` · `model` · `account` · `kind`), `from` (`today` only: the browser's midnight, ISO, within 26 h), `group` (the log shows only this group key), `page` (0-based), `pageSize` (1–200, default 50), `machine` (`all` default · `local`), `peers` (`cached` default · `wait`), `format` (`json` default · `csv`: the whole log, `text/csv` attachment) | 200 `UsageAnswer`; 422 `invalid` with `errors` |
| GET | /api/insights/usage/rows | `from`, `to` (ISO times, ≤ 8 days apart) | 200 `UsageRows` `{ turns: UsageTurnRow[], accounts: UsageAccountRow[] (windows, `identity`), sessionTitles, sessionKinds, accountNames }`: this machine's rows (the merged view's pull); 422 |

- **`UsageAnswer`**: `{ query, generatedAt, spans: { accountId, name, start, end, pct, resetsAt, sinceReset }[], unknownWindows: string[], totals: { input, output, cacheWrite, cacheRead, unsplit, tokens, agentTokens, turns, sessions, cost, costPartial }, rows: UsageRow[] (≤ 100), more: { count, tokens } | null, chart: { buckets, bucketMs, start, end, series: { key, label, values, other }[] }, log: { rows: UsageLogRow[], page, pageSize, total }, shareOf: 'account' | 'all', estimate: { available, window, pct }, currency, examplePrices, accounts: { id, name, cli }[], machines, backfill }`.
- **`UsageRow`**: `{ key, label, total, agents (both `{ input, output, cacheWrite, cacheRead, unsplit, tokens }`), agentModels: { model, tokens, cacheRead }[], share (0–1), estimate: { pct, window } | null, turns, models, cost | null, costPartial, sessionId | null, kind | null, machine: { id | null, name } | null, lastAt }`. `tokens` = input + output + cache writes + unsplit (cache reads apart); `estimate` only for one account in its own 5-hour / weekly window.
- **`UsageLogRow`**: `{ id, at, sessionId, title, kind, models, total, agentTokens, accountId, accountName, machine, folder }`.
- **Result events** (additive payload field, D134): `modelTotals: { [model]: { input, output, cacheWrite, cacheRead } }`, the CLI's cumulative `modelUsage` counts, when it reports them.
- **Peers / devices:** both routes are on `PEER_API_ALLOW` and the device allow-list; a paired machine's request answers its own rows (never fans out).
- **UI address:** v2 `/insights?view=usage&period=…&account=…&groupBy=…&group=…&page=…&computer=…`; classic `/insights?view=usage` scrolls to the section.

## CI and pull requests (D109, 2026-10-14, additive)

The shared PR watcher follows the pull request of every live worktree whose PR is open (`docs/ci.md`, `docs/decisions.md` → D109): a red check sends the failing job's log tail to the session as a normal message (one per red head, at most `ci.maxAttempts` per PR; the same failure twice in a row stops it), then raises "CI keeps failing on PR #n …"; green and approved (or approval not required) raises "PR #n ready to merge" with **Merge PR**. Plans (D99) reads its items' PRs through the same watcher. Issues of a GitHub repository or of Jira become todo items (`docs/todos.md` → *Import issues (D109)*). Migration 0046 adds `pr_watch` and `todo_imports`.

| Method | Path | Body | Answers |
|---|---|---|---|
| GET | /api/sessions/{id}/ci | — | 200 `SessionCi` `{ prs: SessionPr[] }` (newest first; `[]` without a watched PR) · 404 `not-found` |
| GET | /api/sessions/{id}/todos/import/sources | — | 200 `IssueImportSources` `{ github: { available, repos, problem }, jira: { available, problem } }` · 404 `not-found` |
| POST | /api/sessions/{id}/todos/import/preview | `IssueImportQuery`: `{ source: "github", repo, label?, mine? }` or `{ source: "jira", jql? , project? }` | 200 `IssueImportPreview` `{ issues: ImportableIssue[], truncated }` · 404 `not-found` · 422 `invalid` (+ `field`) · 409 `jira-unavailable` · 502 `source-failed` (gh's or Jira's message; never a credential) |
| POST | /api/sessions/{id}/todos/import | `IssueImportInput` `{ query: IssueImportQuery, keys: string[] }` (1–100) | 201 `SessionTodoList` (the ticked issues not imported before, in the preview's order) · 404 · 409 `jira-unavailable` / `too-many` · 422 `invalid` · 502 `source-failed` |

- **`SessionPr`**: `{ worktreeId, repo, branch, number, url, state: "OPEN" | "MERGED" | "CLOSED", checks: "pending" | "green" | "red" | "none", summary, review: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null, ready, attempts, maxAttempts, stopped: "cap" | "same-failure" | null, checkedAt }`.
- **`ImportableIssue`**: `{ key, title, url, body, labels, imported }`; `key` is `owner/repo#12` (GitHub) or `PROJ-12` (Jira), recorded per session so a re-import skips it, also after its todo was removed. An imported todo: title `#12 <title>` / `PROJ-12 <title>`, description = the body (cut to 1,500 characters) and a last line `GitHub: <url>` / `Jira: <url>`, plan `No plan: imported from GitHub (owner/repo#12)`, added by the developer.
- **Inbox items** (system, source `ci`): kind `ci-failing` (label "CI keeps failing", status `fail`; actions `open-pr`, `open-session`, `try-again`, `dismiss`) and kind `ci-ready` (label "Ready to merge", status `need`; actions `merge-pr`, `open-pr`, `dismiss`), through `POST /api/inbox/{id}/actions/{action}`. `merge-pr` runs `gh pr merge <n> --squash | --merge | --rebase` after reading the PR again (409 `refused` with the reason when it is no longer ready, or gh's failure); `try-again` resets the PR's attempts and sends the current failure. `open-pr` and `open-session` are links (the API answers 409 `refused`). **`InboxItem.url`** (additive): the PR an item is about (`https://` only).
- **`/hub` `ciChanged`** `{ sessionId }` (additive): a session's PR status changed; forwarded between peers with the remote session id.
- **Settings** (additive, editable): `ci.sendFailures` (default `true`), `ci.pendingPollMinutes` (1–30, default 2), `ci.idlePollMinutes` (2–120, default 10), `ci.maxAttempts` (1–10, default 3), `ci.logTailLines` (20–1000, default 150), `ci.mergeMethod` (`repo` | `squash` | `merge` | `rebase`, default `repo`: the repository's default merge method as gh reports it, else squash).
- **Peers (D48):** the four routes are on `PEER_API_ALLOW` (the import's answer is mapped as a `todo-list`; the others carry no ids). **Devices (D73):** on `DEVICE_ALLOWED` (Merge PR is the Inbox action, an explicit click, allowed on phones).

```json
GET /api/sessions/5d1e…/ci
→ 200 { "prs": [{ "worktreeId": "a91c…", "repo": "web-front", "branch": "PROJ-7-checkout", "number": 7, "url": "https://github.com/acme/web-front/pull/7", "state": "OPEN", "checks": "red", "summary": "failed: build", "review": null, "ready": false, "attempts": 1, "maxAttempts": 3, "stopped": null, "checkedAt": "2026-10-14T10:02:00.000Z" }] }

POST /api/sessions/5d1e…/todos/import
{ "query": { "source": "github", "repo": "acme/web-front", "label": "bug", "mine": true }, "keys": ["acme/web-front#21"] }
→ 201 { "sessionId": "5d1e…", "todos": [{ "title": "#21 Checkout button overlaps the footer", "description": "On 360 px the button sits on the footer.\n\nGitHub: https://github.com/acme/web-front/issues/21", "…": "…" }], "…": "…" }
```

## Turn status: waiting for you at a turn's end (D124, 2026-10-21, additive)
Developer request D124 (`docs/decisions.md`; details `docs/derivations.md` → *Session status* → *Waiting for you at a turn's end*): a session whose turn is over and not working, and whose last turn waits for the developer (the agent's `turn_status`, else the text check of its last message), reads `need` with an ask. Types in `src/core/api.ts`: `TurnWait`, `TurnStatus`.

| Method | Path | Body | Answers |
|---|---|---|---|
| POST | /agent/v1/turn-status | `{ status: "done" \| "waiting_for_you" \| "blocked", ask? }` (`ask` ≤ 300 characters, one line; required for the last two) | 200 `TurnWait` · 401 (another session's agent token) · 404 `not-found` · 409 `closed` · 422 `invalid` |
| POST | /api/sessions/{id}/not-waiting | `{ at? }` (the episode's `turnWait.at`; absent = the current one) | 200 Session (`sessionUpdated` is published) · 404 `not-found` |

- **`Session.turnWait`** (additive): `TurnWait` `{ status, ask, source: "declared" | "detected", at }` or `null` / absent. **`Session.status`** is the read status: `need` when the stored status is `done` / `idle` / `paused` and `turnWait.status` is `waiting_for_you` / `blocked` (the session is not closed); the stored status (`sessions.status`) is unchanged. Cleared when a new turn starts, by Not waiting and by a Dismiss of its Inbox item.
- **Inbox** (system, source the session's title): kind `turn-waiting`, label "Waiting for you" ("Waiting for you · detected" for a text-check one), status `need`, the ask as `detail`, actions `open-session` (a link: the API answers 409 `refused`) and `dismiss` (also clears the session's wait for that turn). **`InboxItem.systemKind`** (additive): `turn-waiting` on such an item only.
- **Plans:** `PlanItemState` gains `needs-you` (additive): its run session's turn waits for the developer; `reason` = the ask.
- **MCP:** the `switchboard` server's tool `turn_status` (`docs/mcp.md`).
- **Peers (D48):** `POST /api/sessions/{id}/not-waiting` is on `PEER_API_ALLOW` (answers mapped as a `session`); the item's Dismiss is an Inbox action as before. **Devices (D73):** on `DEVICE_ALLOWED`.
- No new `/hub` event: a change publishes `sessionUpdated` (and `inboxChanged` for the item).

```json
POST /agent/v1/turn-status   (x-switchboard-session: 0b7c…, Authorization: Bearer <agent token>)
{ "status": "waiting_for_you", "ask": "Pick the region for the Acme tenant: EU or US" }
→ 200 { "status": "waiting_for_you", "ask": "Pick the region for the Acme tenant: EU or US", "source": "declared", "at": "2026-10-21T10:00:00.000Z" }

GET /api/sessions/0b7c…
→ 200 { "id": "0b7c…", "status": "need", "turnWait": { "status": "waiting_for_you", "ask": "Pick the region for the Acme tenant: EU or US", "source": "declared", "at": "2026-10-21T10:00:00.000Z" }, "…": "…" }
```

## Machine power (D125, 2026-10-21, additive)
Developer request D125 (`docs/decisions.md`; details `docs/power.md`): each Switchboard host reports its own power, a laptop its battery and a machine without one an estimated total, and shares it with its paired machines. Types in `src/core/power.ts`: `PowerStatus`, `PowerParts`, `PowerEstimateSettings`.

- **`SystemInfo.power`** (additive, `GET /api/system` and the `system` event): `PowerStatus` `{ kind: "battery" | "estimated" | "none", percent?, charging?, pluggedIn?, minutesLeft?, minutesToFull?, watts?, adapterWatts?, parts?: { gpu?, gpuCount?, cpu?, cpuPct?, cpuMeasured?, base? }, at }`. Omitted before the first sample (at most every 30 s, on demand) and in the demo. `estimated` is always an estimate (GPU measured where possible + CPU from its use + a fixed base).
- **`Machine.power`** (additive, `GET /api/machines` and `machineState`): the paired machine's own reading, only while it is `online` or `reconnecting`; absent from older machines. Phones (devices) report none.
- **`/hub` `machinePower`** (additive): `PowerStatus`, this machine's reading when it says something new. On the peer stream (`PEER_HUB_EVENTS`): sent once when the stream opens and on each change; the receiver never republishes it.
- **Settings** (additive): `power.estimate` (editable) `{ cpuIdleW, cpuMaxW, baseW }`, each a number of watts 0–2000 or `null` (this machine's default), `cpuIdleW` ≤ `cpuMaxW` when both are set (else 422); `power.estimateDefaults` (read-only) `{ cpuIdleW, cpuMaxW, baseW }`, this machine's defaults.
- **Tests only:** `SWITCHBOARD_POWER_TEST_FILE` (a JSON `PowerStatus` reported instead of reading the machine, read again each sample), `SWITCHBOARD_POWER_SAMPLE_MS` (the sample gap, 100–600000).

```json
GET /api/system
→ 200 { "cli": "…", "cpu": 12, "ramUsed": 1, "ramTotal": 2, "processes": 0, "power": { "kind": "battery", "percent": 64, "charging": false, "pluggedIn": false, "minutesLeft": 130, "watts": 9.5, "at": "2026-10-21T10:00:00.000Z" }, "…": "…" }

GET /api/machines
→ 200 { "self": { "…": "…" }, "machines": [{ "id": "k3v7q2m9x4ab", "name": "acme-desktop", "state": "online", "power": { "kind": "estimated", "watts": 210, "parts": { "gpu": 120, "gpuCount": 1, "cpu": 50, "cpuPct": 35, "base": 40 }, "at": "2026-10-21T10:00:00.000Z" }, "…": "…" }], "…": "…" }
```

## Session processes (D127, 2026-10-22, additive)
Developer request D127 (`docs/decisions.md`; details `docs/processes.md`): the processes a session's agent leaves running (build servers, test hosts, dev servers) are tracked per session, listed, stopped by the developer, kept, and stopped automatically when the session is closed or idle. Types in `src/core/api.ts`: `SessionProcess`, `SessionProcessKind`, `SessionProcesses`, `ProcessTracking`, `ProcessesOverview`, `ProcessKeepInput`, `TrackedProcessTotals`.

| Method | Path | Body | Answers |
|---|---|---|---|
| GET | /api/processes[?fresh=1] | — | 200 `ProcessesOverview`: this machine's sessions with processes and (not for a peer's own request) each online paired machine's, their ids namespaced (`r~<machine>~<id>`) with `machine`; `unavailable` names a machine that could not be asked |
| GET | /api/sessions/{id}/processes[?fresh=1] | — | 200 `SessionProcesses` · 404 `not-found` |
| POST | /api/sessions/{id}/processes/{pid}/stop | — | 200 `SessionProcesses` (after the stop: the process and what runs under it; noted on the timeline) · 404 `not-found` (not one of the session's processes now) · 422 `invalid` (not a pid) · 503 `unavailable` (the processes could not be listed) |
| PUT | /api/sessions/{id}/processes/{pid}/keep | `ProcessKeepInput` `{ keep: boolean, reason? }` (reason ≤ 200 characters) | 200 `SessionProcesses` · 404 `not-found` · 422 `invalid` |
| POST | /agent/v1/processes/keep | `{ pid? , match?, keep: boolean, reason? }` (pid or match) | 200 `{ processes: SessionProcess[], keep }` (the ones changed) · 401 (another session's agent token) · 404 `not-found` (nothing of this session matched; the message lists its processes) · 422 `invalid` |

- `?fresh=1` samples first when the last sample is older than 2 s; otherwise the last sample (every 30 s) answers.
- **`SessionProcess`**: `{ pid, ppid, name, kind: "build-server" | "test-host" | "dev-server" | "other", rssBytes, startedAt, cpuPct (null on Windows), command (home as ~, ≤ 300 characters), keep, keptBy: "developer" | "agent" | null, keepReason }`.
- **`SessionProcesses`**: `{ sessionId, title, processes (most memory first), rssBytes, tracking: "marker" | "tree" | "none", working, closed, stopsAt (ISO, when the idle stop takes the processes not kept; null while working, with the delay off, or nothing to stop), sampledAt, machine? }`.
- **`ProcessesOverview`**: `{ sessions, count, rssBytes, idleStopMinutes, sampledAt, unavailable? }`.
- **`SystemInfo.trackedProcesses`** (additive, `GET /api/system` and the `system` event): `{ count, rssBytes }`, this machine's tracked processes (the sidebar footer); omitted before the first sample.
- **Settings** (additive): `processes.idleStopMinutes` (editable), a whole number 0–1440, default 10; 0 = never for being idle.
- **Events:** a stop records a lifecycle event (kind `text`), `{ type: "lifecycle", action: "processes-stopped", message, reason: "idle" | "closed" | "developer", stoppedProcesses: [{ pid, name, kind, rssBytes }] }`, label e.g. "Stopped 6 build servers (1.9 GB) after 10 min idle". `LifecycleAction` gains `processes-stopped` (additive).
- **Peers (D48):** the four `/api` routes are on `PEER_API_ALLOW` (a session route with a remote id is forwarded: listed, stopped and kept on that machine; answers are not mapped). **Devices (D73):** on `DEVICE_ALLOWED`.
- **MCP:** the `switchboard` server's tool `process_keep` (`docs/mcp.md`).
- **Spawned CLIs** (additive): every CLI Switchboard spawns gets `SWITCHBOARD_SESSION=<session id>`, `MSBUILDDISABLENODEREUSE=1`, `DOTNET_CLI_USE_MSBUILD_SERVER=0` and `UseSharedCompilation=false` in its environment.
- No new `/hub` event: the views read again (every 15 s while open, and after Stop / Keep); the timeline note arrives as an `event`.

```json
GET /api/sessions/0b7c…/processes
→ 200 { "sessionId": "0b7c…", "title": "Acme checkout", "processes": [
         { "pid": 4242, "ppid": 1, "name": "MSBuild node", "kind": "build-server", "rssBytes": 262144000, "startedAt": "2026-10-22T09:40:00.000Z", "cpuPct": 0, "command": "/usr/local/share/dotnet/dotnet /usr/local/share/dotnet/sdk/9.0.305/MSBuild.dll /nologo /nodemode:1 /nodeReuse:true", "keep": false, "keptBy": null, "keepReason": null }
       ], "rssBytes": 262144000, "tracking": "marker", "working": false, "closed": false, "stopsAt": "2026-10-22T10:10:00.000Z", "sampledAt": "2026-10-22T10:00:00.000Z" }

POST /agent/v1/processes/keep   (x-switchboard-session: 0b7c…, Authorization: Bearer <agent token>)
{ "match": "vite", "keep": true, "reason": "dev server for the review at http://localhost:5173" }
→ 200 { "keep": true, "processes": [{ "pid": 5150, "name": "node vite", "kind": "dev-server", "keep": true, "keptBy": "agent", "keepReason": "dev server for the review at http://localhost:5173", "…": "…" }] }
```

## The archive (D137, 2026-10-26, additive)

**D137 · the archive** (`docs/cleanup.md` → *The archive (D137)*; types in `src/core/session-archive.ts`; no migration, no new route, no hub event). Closing a session archives it (the UI says Archive / Archived / Restore; the routes stay `POST /api/sessions/{id}/close` / `reopen`, which phones and paired machines already use); an archived session is deleted by the server itself once its period is over, unless something keeps it.

- **Session / SessionDetail / `sessionUpdated`** gain, on a closed session only (absent while open, and from a server before D137): `deletesAt: string | null` (ISO: when the sweep deletes it; `null` while it is kept or the period is Never) and `keptReason: "running" | "crew" | "plan" | "plan-step" | "routine" | "cli-schedule" | "pinned" | null`. Each computer computes its own sessions' (a paired computer's session carries its computer's values).
- **HistoryItem** gains the same two fields on a closed stored session's row (absent otherwise).
- **Settings** (additive): `sessions.archiveDays` (editable), a whole number 0–3650, default 14; `0` = Never. `sessions.archiveSweep` (read-only) `{ lastRunAt: string | null, lastDeleted: { at, sessions, worktrees, keptWorktrees: [{ path, reason }] } | null }`. The server also stores `sessions.archiveSince` (the grace start: the upgrade, then a change from Never or to a shorter period), which `GET` does not return.
- **CleanupScan** gains `archiveDays?: number | null` (the period while the archive has one, `null` when it is Never); the `sessions` group then lists the archived sessions past it with the new reason `archive-due` (a kept one unticked, its reason in `keeps`).

```
GET /api/sessions?closed=include
→ 200 [{ "id": "0b7c…", "closedAt": "2026-10-20T09:00:00.000Z", "deletesAt": "2026-11-03T09:00:00.000Z", "keptReason": null, "…": "…" },
       { "id": "5e1f…", "closedAt": "2026-09-01T09:00:00.000Z", "deletesAt": null, "keptReason": "pinned", "…": "…" }]
PUT /api/settings { "sessions.archiveDays": 30 }
→ 200 { "sessions.archiveDays": 30, "sessions.archiveSweep": { "lastRunAt": "2026-10-26T13:02:00.000Z", "lastDeleted": { "at": "2026-10-26T13:02:00.000Z", "sessions": 3, "worktrees": 2, "keptWorktrees": [] } }, "…": "…" }
```

**D137 follow-up 2026-10-26 (additive; no migration):**

- **A change of the period:** `PUT /api/settings` with `sessions.archiveDays` going from `0` (Never) to days, or to fewer days than stored, also stores `sessions.archiveSince` = now (same transaction), so nothing becomes due at once: each archived session's `deletesAt` is at least now + the new period. More days (or the same, or `0`) leave it.
- **`GET /api/sessions?closed=only`**: the closed (archived) sessions only (`?closed=` now accepts `exclude` | `include` | `only`; anything else 422 `invalid`, field `closed`). From the UI it lists this computer's and the paired computers' archived sessions; from a paired computer (the peer API) only this computer's, the newest `200` by `closedAt`, without `agents`.
- **The paired computers' archived sessions** follow in `?closed=include` / `?closed=only` (never in the default open list) and in `GET /api/history`, namespaced (`r~<machine>~<id>`) with `machine: { id, name, state }` and their own computer's `deletesAt` / `keptReason`, as last known (an unreachable computer's stay listed with its state). Restore = `POST /api/sessions/{remote id}/reopen` (forwarded; 502 `peer-unreachable` while it is away).
- **HistoryItem** gains `machine?: { id, name, state } | null`: that computer, on a paired computer's archived session's row (absent / `null` on this computer's rows).

```
GET /api/sessions?closed=only
→ 200 [{ "id": "r~abcd2345efgh~5e1f…", "closedAt": "2026-10-25T09:00:00.000Z", "deletesAt": "2026-11-01T09:00:00.000Z", "keptReason": null, "machine": { "id": "abcd2345efgh", "name": "studio-pc", "state": "online" }, "…": "…" }]
```

## Helper times (2026-10-27, additive; no migration)
The v2 agent view folds helpers that ended more than ten minutes ago (`docs/v2.md` → *Helpers fold*). Additive; nothing above changes meaning.

- **Agent** (in `Session.agents`, `SessionDetail.agents` and `sessionUpdated`) gains `startedAt`, `updatedAt` and `endedAt` (ISO): when the agent's row was recorded, last changed and ended (the `agents` table's `created_at` / `updated_at` / `ended_at`; `endedAt` is `null` while it has not ended). A Workflow's agents (`kind: "workflow"`, not stored) repeat `workflow.startedAt` / `workflow.endedAt` and send `updatedAt: null`. Optional in `src/core/api.ts` so older payloads (a paired computer on an older version) type-check.

```json
Agent { …, "startedAt": "2026-10-27T09:00:00.000Z", "updatedAt": "2026-10-27T09:04:10.000Z", "endedAt": "2026-10-27T09:04:10.000Z" | null }
```

## Remote updates (D140, 2026-10-27, additive; no migration)
Developer request D140 (`docs/decisions.md`; details `docs/updates.md` → *Remote updates*): a paired phone or a paired computer can check for and install an update of Switchboard. Additive; nothing above changes meaning. Types in `src/core/updates.ts`.

- **Who may call:** a paired device: `GET /api/updates`, `POST /api/updates/check`, `POST /api/updates/install`, `POST /api/updates/dismiss` (any other `/api/updates/…` write stays `403 local-only`). The peer API (`/peer/v1/api/…`, so also `/api/machines/{id}/api/…` from a computer or a phone): `GET /api/updates`, `POST /api/updates/check`, `POST /api/updates/install` (dismiss and anything else `403 peer-forbidden`).
- **`POST /api/updates/install`** from a device or a peer additionally answers `409 { error: "git-checkout", message }` (a git checkout) and `409 { error: "manual-restart", message }` (not running as its login service), both "Can't update itself here: … restart it by hand."; and `429 { error: "rate-limited", message }` for a second remote install within 10 minutes. This machine's own UI is not limited and still updates a by-hand install.
- **UpdateStatus** gains `remote?: { allowed, reason: "git-checkout" | "manual-restart" | null, message: string | null }` and `lastRemote?: RemoteUpdateRecord | null`.
- **RemoteUpdateRecord** `{ version, from, by: { kind: "device" | "peer", id, name }, at, outcome: "started" | "updated" | "failed", error: string | null }`.
- **MachineUpdate** `{ current, kind, restart, remote, checking, latest: { version, tag, url } | null, available, lastCheck, progress: UpdateProgress without dir, liveSessions, lastRemote }`.
- **Machine** (`GET /api/machines`, `machineState`) gains `update?: MachineUpdate`: as the machine last reported it; while online or reconnecting, and while away after an update made it restart.
- **`/hub` `machineUpdate`** (additive): `MachineUpdate`, published with every `updateChanged`. On the peer stream (`PEER_HUB_EVENTS`): sent once when the stream opens and on each change; the receiver never republishes it.
- **InboxItem** of kind `system` gains `Updated to <v> from …` / `Update to <v> from … failed` (system item kind `update-remote`, action `dismiss`).

```
POST /api/machines/abcd2345efgh/api/updates/install { "version": "2.4.3" }
→ 202 { "current": "2.4.2", …, "progress": { "phase": "downloading", "version": "2.4.3", … }, "remote": { "allowed": true, "reason": null, "message": null },
        "lastRemote": { "version": "2.4.3", "from": "2.4.2", "by": { "kind": "peer", "id": "q7r2…", "name": "Marcins-Mac" }, "at": "2026-10-27T10:00:00.000Z", "outcome": "started", "error": null } }
→ 409 { "error": "manual-restart", "message": "Can't update itself here: it doesn't run as its login service (Start at login). Update it there and restart it by hand." }
→ 429 { "error": "rate-limited", "message": "An update was asked for from a phone or another computer less than 10 minutes ago; try again in 6 min." }
```

## Delete a folder and archive its agents (D141, 2026-10-28, additive; no migration)
Developer request D141 (`docs/decisions.md`; details `docs/sidebar.md` → *Delete a folder and archive its agents (D141)*). Types in `src/core/sidebar-folder-archive.ts`. Additive; without the new query nothing changes meaning.

- **`DELETE /api/sidebar/folders/{folderId}?archive=1`** (also `true`; `0` / `false` / absent = the D54 / D58 delete, answering `SidebarLayout` as before; anything else `422 { error: "invalid", errors: [{ field: "archive" }] }`; an unknown folder `404` before anything is archived). Archives every open session placed in the folder or its subfolders (any depth) through the close path (`confirm: true`; a paired computer's on that computer through the peer proxy), except the held-back ones, then deletes the folder and all its subfolders; every session placed in them goes to the end of the folder's parent (unplaced for a top-level folder). Publishes `sidebarLayoutChanged` once, plus each archived session's `sessionUpdated`.
- **Answer** `SidebarFolderArchiveResult` `{ layout: SidebarLayout, archived: [{ sessionId, name, machine: string | null }], kept: [{ sessionId, name, machine, reason: "pinned" | "crew" | "plan" | "plan-step" | "offline" | "failed", message? }] }` (`machine` = the paired computer's name, `null` here; `message` on `failed`).
- Allowed from a paired device like the plain delete; not on the peer API (as every sidebar route).

```
DELETE /api/sidebar/folders/6f1c…?archive=1
→ 200 { "layout": { "pinned": [], "folders": […], "loose": […] },
        "archived": [{ "sessionId": "0b7c…", "name": "Checkout fix", "machine": null }],
        "kept": [{ "sessionId": "r~abcd2345efgh~5e1f…", "name": "Pricing", "machine": "studio-pc", "reason": "offline" }] }
```

## Accounts hint (D142, 2026-10-28, additive; no migration)
Found on the developer's machines (`docs/decisions.md` → D142; details `docs/accounts.md` → *One account here, more on a paired machine (D142)*): a machine with a single usable account of a CLI (Claude Code in practice: only it has an identity) while a paired machine has another one. Types in `src/core/account-hint.ts`. Every field is additive.

- **New system item kind `account-hint`** (`GET /api/inbox`): one per CLI on the machine that lacks the account (a paired machine's merged Inbox shows it with `machine` like every system item). `systemKind: "account-hint"`, `label: "Accounts"`, `source: "accounts"`, `status: "idle"` (informational), `sessionId: null`, actions `add-account` ("Add it there", a **link**: the UI navigates, the item stays open; `POST …/actions/add-account` answers 409 `refused`) and `dismiss`. Updated in place while open; closed `resolved` by the service when it no longer holds.
- **`InboxItem.addAccount?: { cli: CliProviderId, name: string }`**: what Add it there prefills: Settings › Accounts on the item's machine (`machine.id`, absent = this one) with the Add form of `cli` prefilled with `name`. The UI's addresses: classic `/settings/accounts?machine=<id>&add=<cli>&name=<name>`, v2 `/settings/advanced/accounts?…` (`machine` omitted for this machine).
- **`AccountsOverview.hints?: AccountHintView[]`** (`GET /api/accounts`): `{ cli, text, add: { cli, name }, missing: [{ name, account: string | null, machines: string[] }] }` per CLI where the hint holds; omitted when none. Also in the answer to a paired machine (`GET /api/machines/{id}/api/accounts`): it is that machine's own fact.
- The "Every … account is out of usage" / "Could not switch …" items' `detail` ends with "N more account(s) … signed in on <machine> — add it here." when the hint holds; on a CLI with a single enabled account a limit error raises the out-of-usage item only then.

```json
GET /api/inbox   (on the Mac; the item is the PC's)
200 [{ "id": "r~m-pc~5d1…", "kind": "system", "systemKind": "account-hint", "label": "Accounts", "source": "accounts", "status": "idle", "sessionId": null,
       "title": "Marcins-PC can't switch Claude Code accounts",
       "detail": "It has only one account signed in (Work). 1 more is signed in on Marcins-MacBook-Pro (Personal). Add it on Marcins-PC so agents there switch when one runs out.",
       "actions": [{ "id": "add-account", "label": "Add it there" }, { "id": "dismiss", "label": "Dismiss" }],
       "addAccount": { "cli": "claude", "name": "Personal" },
       "machine": { "id": "m-pc", "name": "Marcins-PC", "state": "online" }, "branches": [], "createdAt": "2026-10-28T10:00:00.000Z" }]
```

## Automatic clean-up of merged worktrees (D145, additive; no migration)
`docs/cleanup.md` → *Automatic clean-up of merged worktrees (D145)*. Nothing above changes meaning.

- **Settings** (additive): `worktrees.autoClean` (editable, boolean, default `true`), `worktrees.autoCleanRemote` (editable, boolean, default `true`), `worktrees.autoCleanRecord` (read-only) `{ cleaned: number, lastCleanedAt: string | null, recent: [{ at, path, text }] (at most 20), kept: [{ path, reason }] (at most 50) }`. The server also stores `worktrees.agentMadeScannedTo` (an event id), which `GET` does not return.
- **Events:** a clean-up records a lifecycle event (kind `text`) in the owning session, `{ type: "lifecycle", action: "worktree-cleaned", message }`, label = message, e.g. "Cleaned up worktree x: merged into dev; removed the folder, the local branch and origin/worktree-x". `LifecycleAction` gains `worktree-cleaned` (additive); the chat shows it as a divider.
- **Worktrees:** a row the clean-up removed reads like one removed by hand (`removedAt` set). Rows are also created for worktrees a session's agent made itself (adopted, as D38's).
- **Inbox:** the worktree's open "PR merged" system item closes with `closedAction: "resolved"`.

```
PUT /api/settings { "worktrees.autoCleanRemote": false }
→ 200 { "worktrees.autoClean": true, "worktrees.autoCleanRemote": false, "worktrees.autoCleanRecord": { "cleaned": 3, "lastCleanedAt": "2026-10-28T13:02:00.000Z", "recent": [], "kept": [] }, "…": "…" }
```
