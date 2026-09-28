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
