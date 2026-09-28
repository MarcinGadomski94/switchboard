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
| GET | /api/sessions/{id}/diff | ?file= | FileDiff[] |
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
Validation: name unique and kebab-case; solutions not empty; read-only paths are rejected (422); `qa` is required when workType = qa.

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
| POST | /api/solutions/{repo}/isolate | IsolateRequest `{ sessionId, branch }` | 201 / 200 Worktree · 422 `invalid` `{ errors: [{ field: "sessionId" \| "branch" }] }` · 409 `branch-exists` (nothing is created or paused) · the other refusals as before |

- **NewSession** (and the repo folder's `NewRepoSession`) gains `branch`: **required with `worktrees: true`**, a ticket branch once trimmed (never tidied by the server); the 422 messages: `name the branch after its ticket: the key, its number and a short description, e.g. PROJ-0001-short-description` (missing or blank) and `the branch must be a ticket key, its number and a short kebab-case description, e.g. PROJ-0001-short-description`. The worktree of every solution in scope is created on it (a workspace session: the same branch in each repo); a repo that has it already is 409 `branch-exists` and nothing is created. Without a worktree `branch` is not read. The worktree folders keep `../{repo}-wt-{name}`.
- **IsolateRequest** (`POST /api/solutions/{repo}/isolate`, "Move … to worktree"): the contract's `{ sessionId }` gains the required `branch`, same rule and messages. A session that already has a worktree for the repo still gets it back unchanged (200).
- **Unchanged:** scheduled runs (a schedule's template carries no `branch`; one sent is dropped when it is saved) keep `session/{run name}`; teleports (`POST /api/sessions/teleport`, D25) keep `session/{name}` before the CLI checks out the remote branch.
- **Worktree.branch**, `SolutionBranch.branch`, `FileDiff.branch`, the answers block and the repo worktree note of the first message, and the "PR merged" item name the worktree's real branch (the stored one), so they show the ticket branch without new fields.

```json
NewSession     { …, "worktrees": true, "branch": "PROJ-0001-test-branch-name" }
IsolateRequest { "sessionId": "…", "branch": "PROJ-0001-test-branch-name" }

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

## Subagent chats (D36, 2026-09-28, additive)
Developer ruling D36 (`docs/decisions.md` → *Subagent chats*): a subagent's own conversation opens from the chat. Additive; nothing above or below changes meaning. Details: `docs/chat.md` → *Subagent chats*.

- **Agent** (in `Session.agents`, `SessionDetail.agents` and `sessionUpdated`) gains `toolUseId`: the id of the Agent / Task `tool_use` that started the subagent (the main agent's call event has it as `payload.toolUseId`; the subagent's own lines carry it as `parent_tool_use_id`); `null` for the main agent and for agents no call was seen for. Optional in `src/core/api.ts` so older fixtures type-check; the server always sends it.
- **No events filter:** `GET /api/sessions/{id}/events` already returns every event of the session (it does not page), with each event's `agentId`, so the UI filters a subagent's events itself. No new route, query or `/hub` event.
- The UI address `/sessions/{id}/agents/{agentId}` is a page of the app (the server answers it with `index.html`, like every non-file GET), not an API route.

```json
Agent { …, "toolUseId": "toolu_01E5QUrP9sKnU8eg6FiNuCbb" | null }
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
