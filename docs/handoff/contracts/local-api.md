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
| activity | { sessionId, activity: SessionActivity \| null } (additive, D19: at most one per second per session) |
