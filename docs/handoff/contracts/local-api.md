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
| GET | /api/sessions/{id}/events | ?since=ts | Event[] |
| GET | /api/sessions/{id}/diff | ?file= · ?scope=head\|branch\|repo (D90, default head) | FileDiff[] |
| GET | /api/sessions/{id}/diff/targets | — (D90) | DiffTargets |
| GET | /api/inbox | — | InboxItem[] |
| POST | /api/questions/batch/{batchId}/answers | { answers: [{questionId, answerIndex}] } | 204 (400 unless all are answered) |
| POST | /api/inbox/{id}/actions/{action} | — | 204 |
| GET | /api/solutions | — | SolutionGroup[] |
| POST | /api/solutions/{repo}/isolate | { sessionId } | Worktree |
| GET/POST | /api/schedules, /api/schedules/{id}/run, /pause, /resume | — | Schedule |
| GET | /api/artifacts | ?type=&q= | Artifact[] |
| GET | /api/history | ?q= | HistoryItem[] |
| GET/PUT | /api/settings | Settings | Settings |
| GET/PUT | /api/tools | Tool[] | Tool[] |
| POST | /api/tools/{id}/probe | — | { state: up\|down } |
| GET | /api/system | — | { cli, cliVersion, signedIn, ghSignedIn, cpu, ramUsed, ramTotal, processes, usagePct? } |

### NewSession
```json
{ "name": "free-talk-640", "task": "…", "workType": "feature|qa", "mode": "single|orchestrator",
  "solutions": ["acme-app-front","mobile"], "phase": "ui-first|integration",
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
- **IsolateRequest** (`POST /api/solutions/{repo}/isolate`, "Move … to worktree"): the contract's `{ sessionId }` gains the required `branch`, same rule and messages. A session that already has a worktree for the repo still gets it back unchanged (200).
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
CloseRefusal      { "error": "close-needs-confirm", "message": "free-talk-640 is running: closing it stops its process (the conversation stays resumable). Confirm to stop and close it." }
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
- **No events filter:** `GET /api/sessions/{id}/events` already returns every event of the session (it does not page), with each event's `agentId`, so the UI filters a subagent's events itself. No new route, query or `/hub` event.
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

## Collapsible panes (D41, 2026-09-29, additive)
Developer ruling D41 (`docs/decisions.md` → *Collapsible panes*): the sidebar and the session view's right panel slide out and back in on request, and the choice is kept by the service, per install. Additive; no new route or `/hub` event, and the rows above keep their meaning. Details: `docs/panes.md`, `docs/settings.md`.

- **Settings** (`GET/PUT /api/settings`) gains two editable keys: `ui.sidebarHidden` and `ui.rightPanelHidden`, booleans, default `false` (both panes shown). `PUT` takes either or both like any editable key (a value that is not a boolean → 422 `invalid` on that key; nothing stored); `GET` always returns both (a stored value of the wrong type reads as `false`).
- The right panel's value applies to every session. Other open pages read the stored state on their next load (no live event).

```json
Settings { …, "ui.sidebarHidden": false, "ui.rightPanelHidden": true }
```

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
Session    { …, "solutions": [] }  →  sessionUpdated { …, "solutions": ["acme-app-front"] }
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
Agent { "id": "wf_5bf13727-e69--12", "kind": "workflow", "name": "review:quizzes-front", "description": "Review", "solutionPath": null, "branch": null, "status": "run", "statusText": null, "toolUseId": null,
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
Developer request D55 (`docs/decisions.md` → *Updates from GitHub releases*). Additive; nothing above changes meaning. No migration. This machine's only: none of these routes is on the peer API and `updateChanged` is not forwarded between peers. Details: `docs/updates.md`.

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
  afterReset: "stay" | "back-to-first", newSessions: { rule: "first-with-allowance" | "fixed", fixed: { [cli]?: profileId } },
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
| POST | /api/takeover/preview | { sessionId, targetMachine?, clonePaths? } | TakeoverPreview `{ source, target, stopsTerminal, ok, blockers }`; `sessionId` is a local id (needs `targetMachine`: a paired machine's id) or a peer's remote id (comes here); 404 unknown machine, 422 |
| POST | /api/takeover | { sessionId, targetMachine?, clonePaths?, confirmStopTerminal? } | 202 TakeoverRun; 409 `in-progress` |
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
| POST | /api/takeover/target/plan | { source, clonePaths? } | TargetPlan (a resolution per repo: `use` / `clone` / `blocked`) |
| POST | /api/takeover/target/chunk | { opId, name, size, sha256, offset, data } | `{ received, done }` (no log); 422 `checksum` / `invalid`, 409 `out-of-order`, 413 over 200 MB |
| POST | /api/takeover/target/apply | { opId, source, captured, clonePaths? } | { place, changes, applied } (409 `diverged` and the like) |
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
| GET | /api/device | — | 200 DeviceSelfView `{ device: Device \| null, vapidPublicKey, events }` (`device: null` on this machine's own UI) |
| PUT | /api/device | `{ name }` | 200 Device · 404 `not-a-device` · 422 `invalid` |
| PUT | /api/device/push | DevicePushInput `{ subscription?: { endpoint, keys: { p256dh, auth } }, events?: Partial<PushEvents> }` | 200 DeviceSelfView · 404 `not-a-device` · 409 `no-subscription` (toggles before a subscription) · 422 `invalid` / `invalid-subscription` (endpoint not on a known push service) |
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

An item can run in a session of its own; its run's work waits in a **review** state; the Todos page has a **board**; finished items record what they took (`docs/todos.md` → *Run in a new session (D76)*, *Review (D76)*, *Board (D77)*, *Actual vs. estimate (D78)*; `docs/decisions.md` → D76, D77, D78). Migration 0032 rebuilds `session_todos` (the state CHECK) and adds `sessions.todo_link` and `todo_actuals`.

| Method | Path | Body | Answers |
|---|---|---|---|
| POST | /api/sessions/{id}/todos/{todoId}/run | — | 201 `TodoRunResult` `{ session: Session, list: SessionTodoList, note: string \| null, routing?: string \| null }` (`routing`, additive, D82: the *Model by task* rule's line when one routed the run, else `null`; absent from an older peer): a new supervised session in the source session's folder on branch `todo/<slug>` (free in every repo: `-2`, `-3`, …): in a repo folder a simple start on its own worktree cut from the source session's checked-out branch (or commit); in a workspace folder one worktree per solution repo of the source (`solutions`), each cut from that repo's current branch, at the workspace root (a Full start with the source's router answers, else a simple start with a worktree note); without such a repo, or in a plain folder, in the same folder without a worktree and `note` says so; the source's CLI, model, effort and account unless a D82 rule routes it (`todoRunOptions`); title = the item's (80 characters), first message = its ▶ Start message. The item `in_progress` (`startedBy: "run"`, `runSessionId`, `runState: "active"`), the session `todoLink`. · 404 `not-found` · 422 `invalid` (done or in review) · 409 `already-running` (its run session is open and active) · 409 `no-folder` (the source's folder is no longer saved) · `POST /api/sessions`'s refusals (422 field errors, 409 worktree / folder / CLI refusals); a refused start leaves the item as it was |

- **`TodoState`** gains **`review`**: in progress → review → done; review → in progress / open (the review queue's outcomes, the board). **`TodoStartSource`** gains **`run`**.
- **`SessionTodo`** gains `runSessionId` (`string | null`; kept after the run), `runState` (`"active" | "discarded" | null`), `startedFirstAt`, `actualMs`, `actualTokens` (`number | null`). **`SessionTodoList`** gains `reviewCount`; `openCount` (and `todosChanged.openCount`, `Session.openTodoCount`) counts `open` + `in_progress` only (review is neither open nor done). **`TodoGroup`** gains `actuals` (`TodoActualsTotal | null`: `{ count, estimated, estimateMinutes, estimatedActualMs, actualMs, tokens }` over the session's completed items, also those removed after their done hour). **`Session`** gains `todoLink` (`{ sourceSessionId, todoId } | null`).
- **`PUT …/todos/{todoId}`:** `state: "done"` of an item with `runState: "active"` (not already in review) stores **`review`**, unless **`skipReview: true`** (the board's drag to Done); `state: "review"` only for an item with a `runSessionId` (else 422 `invalid`); review → done is done.
- **Agent routes:** a run session's agent token also reaches its **one linked item** (`todoLink.todoId` in `todoLink.sourceSessionId`, while its run is active): `GET /agent/v1/todos/{todoId}`, `PUT /agent/v1/todos/{todoId}` (answer `{ todo, list, linked: true, calibration }` with the run session's **own** list); `DELETE` and every other item of the source session answer 404. `GET /agent/v1/todos` answers the list plus `linked` (`SessionTodo | null`) and `calibration`; `POST` / `PUT` answers carry `calibration` (`string | null`: the estimate-accuracy line once ≥ 3 completed items with estimates exist: this session's last 10, else its folder's).
- **`reviewResolved`** (bus / hub event, see the table below): merged / committed / dismissed → `done`; discarded → `open` with `runState: "discarded"` (the link kept); sent-back → `in_progress` (`startedBy: "run"`).
- **Result events** gain `payload.tokens` (`number | null`: the turn's `usage` input + cache creation + output tokens), which the actuals add up.
- **Peers (D48):** the run route is on `PEER_API_ALLOW` (answer kind `todo-run`: `session` and `list` namespaced) and on the devices' allow-list (D73); a peer's `runSessionId` and `todoLink.sourceSessionId` are namespaced (`r~<machine>~<id>`). A peer before D76 has no route (403 / 404) and no review state (its items read as before).
- **Take-over (D65):** an item in review travels as done (its run session stays behind); a run's start as the developer's.

```json
POST /api/sessions/0b7c3e0a-…/todos/3f9a1c2b7d4e/run
{ "session": { "id": "9d2f…", "title": "Fix the login test", "name": "fix-the-login-test", "cwd": "/repos/app-wt-fix-the-login-test", "todoLink": { "sourceSessionId": "0b7c3e0a-…", "todoId": "3f9a1c2b7d4e" }, "…": "…" }, "list": { "sessionId": "0b7c3e0a-…", "openCount": 1, "reviewCount": 0, "todos": [{ "id": "3f9a1c2b7d4e", "state": "in_progress", "startedBy": "run", "runSessionId": "9d2f…", "runState": "active", "…": "…" }] }, "note": null }
```

## Review queue (D79, 2026-10-08, additive)
When one of this machine's sessions with changes goes idle (`run` → `idle` / `done`) it gets a Review card, once per change set (setting `sessions.reviewCards`, default `true`). Advisory: nothing waits on it. Details: `docs/reviews.md`.

- **`GET /api/reviews`** → `Review[]`: the open cards (`state` `pending`, then `cleanup`), oldest first, each read from git again (a pending card whose changes are gone comes back `resolved` / `dismissed` with `handledByAgent: true`: shown as *Handled by the agent*, it counts as done), then the 20 newest resolved ones; then the paired machines' (remote ids `r~<machine>~<id>`, `machine` set). A peer asking gets this machine's only.
- **`POST /api/reviews/{id}/merge | open-pr | commit | send-back | discard | cleanup | dismiss`** → `Review` (the card afterwards). Bodies: `commit` `{ message }` (1–4,000 characters), `send-back` `{ comment }` (1–4,000), `discard` / `cleanup` `{ confirm: true }`. Refusals `{ error, message }`: 404 `not-found`, 409 `not-offered` / `gone` / `busy` / `send-failed` / `conflicts` (+ `conflicts: string[]`) / `uncommitted` / `base-missing` / `base-dirty` / `no-branch` / `no-remote` / `not-merged` / `git-failed` / `gh-failed`, 422 `invalid`. An unknown action is no route (404). A remote id is forwarded to its machine (D48).
- **`POST /api/inbox/{id}/actions/{action}`** also takes a review's id and action (204; the same refusals).
- **`InboxItem.kind`** gains `review`; **`InboxItem.review`** (`Review`) carries the card. `inboxChanged.count` counts the open cards.
- **`Review`** `{ id, sessionId, sessionTitle, folderPath, mode: "branch" | "folder", state: "pending" | "cleanup" | "resolved", outcome: null | "merged" | "committed" | "discarded" | "sent-back" | "dismissed", createdAt, updatedAt, resolvedAt, repos: ReviewRepo[], fileCount, added, removed, uncommitted, commitCount, summary, tests: { status: "passed" | "failed" | "not-reported", command, exitCode }, actions: ReviewActionId[], commitMessage, note, conflicts, handledByAgent, machine? }`; **`ReviewRepo`** `{ repo, dir, worktreeId, branch, base, baseSource: "local" | "origin" | "default" | null, files: { repo, path, added, removed, binary, uncommitted }[], added, removed, uncommitted, commits: { sha, subject }[], prUrl }`.
- **Hub:** `reviewResolved` `{ sessionId, outcome }` (exactly; the shared contract with the todo lane, `ReviewResolvedEvent` in `src/core/reviews.ts`; this machine's only) once per resolution; `reviewsChanged` `{ sessionId }` (raised, refreshed, acted on; forwarded between peers with the remote session id).
- **Peers:** `GET /api/reviews` and every action are on `PEER_API_ALLOW`. **Devices (D73):** `GET /api/reviews` and `merge`, `open-pr`, `commit`, `send-back`, `dismiss` are allowed; `discard` and `cleanup` are desktop-only (403 `local-only`). **Push:** a new toggle `review` ("Ready for review", default on) in `PushEvents`.

```json
POST /api/reviews/3f9a1c2b7d4e/merge
→ 409 { "error": "conflicts", "message": "web-front: PROJ-79-release-notes conflicts with main", "conflicts": ["src/app.txt"] }

GET /api/reviews
[{ "id": "3f9a1c2b7d4e", "sessionId": "0b7c3e0a-…", "sessionTitle": "Add the release notes", "mode": "branch", "state": "pending", "outcome": null,
   "repos": [{ "repo": "web-front", "branch": "PROJ-79-release-notes", "base": "main", "baseSource": "local", "files": [{ "path": "notes/release.md", "added": 1, "removed": 0, "binary": false, "uncommitted": false, "repo": "web-front" }], "commits": [{ "sha": "9c1…", "subject": "Release notes" }], "prUrl": null, "…": "…" }],
   "fileCount": 1, "added": 1, "removed": 0, "uncommitted": 0, "commitCount": 1, "summary": "Added the release notes.", "tests": { "status": "not-reported", "command": null, "exitCode": null },
   "actions": ["merge", "open-pr", "send-back", "discard", "dismiss"], "commitMessage": "Added the release notes.", "note": null, "conflicts": [], "…": "…" }]
```

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
    { "id": "wt:5d0c…", "group": "worktrees", "title": "/Users/me/src/web-front-wt-free-talk", "status": "pending", "error": null, "sizeBytes": null },
    { "id": "rb:91ab…", "group": "remoteBranches", "title": "origin/session/free-talk", "status": "pending", "error": null, "sizeBytes": null }
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

## Diff views (D90, 2026-10-09, additive)
Developer ruling D90 (`docs/decisions.md`; details `docs/worktrees.md` → *Diff*): the Diff tab opens on the work since the last commit. Types: `src/core/api.ts` (`DiffScope`, `DiffTargets`).

| Method | Path | Query | Answers |
|---|---|---|---|
| GET | /api/sessions/{id}/diff | `file` (as before), `scope` = `head` (default) \| `branch` \| `repo` | 200 FileDiff[] · 404 `not-found` · 422 `invalid` (`field: "scope"` for another or a repeated value) |
| GET | /api/sessions/{id}/diff/targets | — | 200 DiffTargets · 404 `not-found` |

- **`scope`:** `head` = uncommitted changes against HEAD (staged, unstaged, untracked; never ignored) in the session's working trees, and in a solution it works on in place only the files the session touched (its Write / Edit / MultiEdit / NotebookEdit paths and, with D80 checkpoints, what changed during its turns); `repo` = every uncommitted change against HEAD; `branch` = the behavior before D90 (a worktree against the merge-base with its base branch, in place against HEAD). **A behavior change:** a request without `scope` now gets `head`; ask `scope=branch` for the old list. `SessionDetail.files` is unchanged (the whole branch).
- **`FileDiff.lines`** now also carries each hunk's `@@ -a,b +c,d @@` header line before its body (a new untracked file: `@@ -0,0 +1,N @@`). A reader that knows only `+` / `-` / space may show it as context.
- **`DiffTargets`:** `{ worktrees: [{ solution, branch, base: string | null, commits: number }], inPlace: [{ solution, branch: string | null }] }`: the working trees the diff reads; `base` = the worktree's base ref, `commits` = commits on its branch since the merge-base with it (0 when it does not resolve). The tab offers Whole branch with a worktree and All uncommitted changes with an in-place solution.
- **Peers (D48):** the query passes through; `GET …/diff/targets` is on `PEER_API_ALLOW`. A peer before D90 answers its old diff whatever the `scope` and refuses the targets (403 `peer-forbidden`): the UI then offers only the default view. **Devices (D73):** both routes are allowed.

```json
GET /api/sessions/0b7c3e0a-…/diff?scope=head
→ 200
[{ "solution": "web-front", "path": "README.md", "branch": "PROJ-42-diff", "added": 1, "removed": 0,
   "lines": ["@@ -1 +1,2 @@", " hello", "+more"], "uncommitted": true }]

GET /api/sessions/0b7c3e0a-…/diff/targets
→ 200
{ "worktrees": [{ "solution": "web-front", "branch": "PROJ-42-diff", "base": "origin/dev", "commits": 2 }],
  "inPlace": [{ "solution": "mobile", "branch": "main" }] }

GET /api/sessions/0b7c3e0a-…/diff?scope=all
→ 422 { "error": "invalid", "errors": [{ "field": "scope", "message": "scope must be one of head, branch, repo" }] }
```

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
| todosChanged | { sessionId, openCount, doneCount } (additive, D68: a session's todo list changed, by the developer, the agent or the hour's removal; forwarded between peers; D75: `openCount` includes the items in progress) |
| reviewResolved | { sessionId, outcome: merged \| committed \| discarded \| sent-back \| dismissed } (additive, D79: a review card was resolved; exactly this shape (`ReviewResolvedEvent`, `src/core/reviews.ts`); D76: the todos whose run session it is leave `review`; this machine's only, never forwarded between peers) |
| reviewsChanged | { sessionId } (additive, D79: a session's review card was raised, refreshed or acted on; forwarded between peers) |
| notice | DeviceNotice { id, kind: permission \| questions \| turnFinished \| errors \| inbox \| review, title, body, url, tag } (additive, D87: a push-worthy happening, this machine's or a paired machine's, the same payload the devices' web push carries; a paired device's open page shows it as a toast; this machine's only, never forwarded between peers) |
