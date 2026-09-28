# Folders (D14)

There is no single workspace root and no workspace environment variable. The developer saves **folders**, and every session, scan, schedule and Codebase Memory view names the folder it works in (`docs/decisions.md` → D14). This page is the server side; the UI (Settings → Folders, the New-session form's Folder row, the folder switcher of Solutions and the Codebase Memory strip) follows in its own stage.

Code: `src/server/folders/` (`inspect.ts` the kinds, `service.ts` the `FolderService`, `ref.ts` the `FolderRef` every service takes), `src/server/db/repos/folders.ts` (the `folders` table), `src/server/api/folders.ts` (routes), `src/server/db/migrations/0003_folders.sql`.

## Kinds
`inspectFolder(path)` (read-only, async) says what a folder is, in this order:
1. **repo**: a git main checkout (`<path>/.git` is a folder, `isMainCheckout` in `src/server/solutions/checkout.ts`), even when it has its own `AGENTS.md`: a repo's rules do not make it a workspace. One solution, named after the folder.
2. **refused, `git-worktree`**: `.git` is a file (a linked worktree or a submodule, gap #16). Its main checkout is the repo to add.
3. **workspace**: a folder with an `AGENTS.md` (the router). The check reports the router's first `# ` heading and line count and how many solutions the workspace scanner (M6.1, the router parsing in `src/core/workspace-rules.ts`) finds: every row `GET /api/solutions` would list.
4. **refused** otherwise: `not-absolute`, `missing`, `not-a-folder`, `unsupported` (no `AGENTS.md` and not a git repository).

`~` is the home folder. The canonical path is the realpath; it is a folder's identity (adding a symlink to a saved folder returns that folder).

The result is a `FolderCheck` (`src/core/api.ts`): `path`, `canonicalPath`, `exists`, `kind` (`null` when refused), `router`, `solutionCount`, `repoName`, `problem`, `message`. The UI builds the check line from it: `✓ AGENTS.md (Workspace Router) · 38 solutions`, `✓ git repo · single solution`, or `✕ <message>`.

## The saved list (`folders` table)
`id`, `path` (as given, `~` expanded), `canonical_path` (unique), `kind` (what it was when added), `is_default` (at most one: a partial unique index), `added_at`, `last_used_at` (a session started there). Order everywhere: the default, then most recently used, then the order they were added.

`FolderService`:
- **add** (`POST /api/folders`): refused (422 `invalid` + the check) unless the folder is a workspace or a repo; the same canonical path again returns the saved folder (200); the first saved folder becomes the default. Sessions without a saved folder whose root is this folder are linked to it (a folder removed and added back).
- **remove** (`DELETE /api/folders/{id}`): refused (409 `folder-in-use`, with the schedules' names) while a schedule starts its runs there; otherwise the folder leaves the list, its sessions keep their `root` / `root_kind` (their folder id becomes `null`), and the default moves to the most recently used folder left.
- **setDefault** (`PUT /api/folders/{id}/default`).
- **open / reconcile** (main.ts at start): refreshes a canonical path that no longer matches the disk (the 0003 migration copies the wizard's root as it was typed), links sessions to saved folders by root, and gives a list without a default one (the most recently used).
- **resolveForView(param)** (`?folder=` of `GET /api/solutions`, `GET /api/codebase-memory`, `POST /api/codebase-memory/reindex`): omitted = the default (409 `no-folder` when nothing is saved); a saved folder's id; or an absolute path that is a saved folder's path or a session's folder (D14's switcher also offers folders open sessions use, which may have left the list); else 404 `not-found`. No disk access: the views report a missing folder themselves (409 `folder-missing`).
- **resolveForSession(id)** (NewSession `folder`, schedule templates): a saved folder's id, or the default when omitted. The folder must still be a folder on disk (409 `folder-missing`); its realpath is taken then. The kind is the one it was saved with.

A saved `setup.workspaceRoot` (the M5.3 wizard) is migrated into the list as the default workspace by `0003_folders.sql`; the setting stays in the table, unread. Sessions started before D14 get `root` = their `cwd` and `root_kind` = `workspace` (they all ran at the one root), and the default folder's id when that root is the migrated one. Schedules get the default folder.

## Sessions
A session stores its folder: `folder_id` (the saved folder), `root` (its canonical path) and `root_kind`, next to `cwd`, the process's working folder. On the wire: `Session.folder`, `folderPath`, `folderKind`, `cwd`.

| Folder | cwd | Solutions | First message |
|---|---|---|---|
| workspace | the folder (the router applies) | the NewSession's, validated by the folder's scan (read-only rules) | task + the session-start answers block (M5.2) |
| repo | the repo; with Worktree on, its worktree `../{repo}-wt-{name}` (gap #1) | exactly the repo (`[<repo name>]`; empty or omitted means the same; any other name 422) | the task, plus only the worktree note when it runs in a worktree (`repoWorktreeNote`); no router answers |

For a repo folder the router-only NewSession fields (`workType`, `mode`, `phase`, `coordination`, `qa`) are not read and are stored `null`.

Everything else follows the session's own folder, never a global root:
- **resume, attach, pause**: the stored `cwd` (`SessionSupervisor.#spawn`); `claude agents --json` (the Attach warning) runs in the session's cwd;
- **restart recovery**: `claude agents --json` is read once per session cwd (`recoverSessions`);
- **worktrees**: `WorktreeManager.resolveRepo(solution, folder)`, `createForSession(name, solutions, folder)`, `isolate` and the diff resolve solutions in the session's folder (a repo folder: the repo); PR checks work on the registered worktrees;
- **artifacts**: a workspace session's files map with the router layout, a repo session's files all belong to its one solution, in its worktree or the main checkout (`locateSessionFile` in `src/core/derive/artifacts.ts`);
- **loops**: `.loop/progress.md` is looked for in the session's worktrees, its solutions under its own root (workspace) or its repo, and its cwd; the shown path is relative to its folder;
- **schedules**: the template stores the folder (`template.folder` + the `schedules.folder_id` column); runs start there; "Open fix session" of a failed run pre-fills it;
- **History**: transcripts under every saved folder, every session's folder and every session's cwd (a repo worktree); a terminal session belongs to the most specific folder its start cwd is in (a repo saved inside a saved workspace wins); every row carries `folder` / `folderPath`;
- **Solutions**: one folder at a time, a scanner per workspace folder; a repo folder is one group (`<repo>/`) with its one solution (type `Repo`, `relativePath` empty, `codebaseMemory` `unknown`). A session's solutions resolve in the session's own folder, so a workspace session working in place in `other/switchboard` shows on the repo folder `switchboard` too;
- **Codebase Memory**: the folder's `.claude/.codebase-memory-dirty`; a repo folder has none (empty list); the reindex session runs at the folder's root.

## API (additive; `docs/handoff/contracts/local-api.md` → D14)
| Method | Path | Returns |
|---|---|---|
| GET | `/api/folders` | `Folder[]` with a live `check` each |
| GET | `/api/folders/check?path=` | `FolderCheck`; 400 without `path` |
| POST | `/api/folders` `{ path }` | `201 Folder` (added) / `200 Folder` (already saved); `422 { error: "invalid", message, check }` |
| DELETE | `/api/folders/{id}` | `200 Folder[]` (the list left); 404; `409 FolderInUse` |
| PUT | `/api/folders/{id}/default` | `200 Folder[]`; 404 |

`GET /api/solutions?folder=`, `GET /api/codebase-memory?folder=`, `POST /api/codebase-memory/reindex?folder=` take a folder as above. NewSession, Session / SessionDetail, Schedule (+ its template) and HistoryItem carry the folder. `GET /api/setup` lists the saved folders (the wizard's "Add your first folder", skippable); `GET /api/setup/folders` (Browse…) starts in the default folder, else the home folder. The M5.3 routes `GET/PUT /api/setup/root` are gone.

## Tests
`tests/server/folders/folders.test.ts` (kinds, the service, the routes and their codes, repo-folder sessions with fake-claude and real git: cwd with and without a worktree, the first message, the one solution, per-folder Solutions and Codebase Memory), `tests/server/db/migrate.test.ts` → *0003 folders*, `tests/server/api/history.test.ts` → *History across folders*, `tests/server/schedules/scheduler.test.ts` → *folders*, `tests/server/supervisor/recovery.test.ts` (per cwd), `tests/core/first-turn.test.ts` (repo note), `tests/core/derive.test.ts` (repo artifacts). Tests save folders through the store (`tests/helpers/folders.ts`: `seedFolder`, `seedFolderInDataDir` before a server process starts) or through `POST /api/folders`.
