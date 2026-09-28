# Solutions: the workspace scanner (M6.1)

How Switchboard finds the workspace's solutions and decides which ones sessions may write to. The pure rules are in `src/core/workspace-rules.ts`; the file-system walk is `WorkspaceScanner` in `src/server/solutions/scanner.ts`, the real `SolutionsProvider` (`docs/lanes.md`), wired in `src/server/main.ts`. It serves `GET /api/solutions` and the read-only check of `POST /api/sessions`. M6.2 fills the live fields of each row (sessions, worktrees, phase ledger, changes, conflicts).

The scanner is read-only: it reads `<root>/AGENTS.md` and lists folders. It writes nothing, runs no process and never follows a symlink. Tests build fixture workspaces in temp folders and never scan the real workspace.

## Folder rules
The rules come from two sources, merged per top-level folder.

**Baseline.** The layout the handoff documents (ARCHITECTURE → *Workspace rules*, "from the router AGENTS.md"):

| Folder | Rule | Solutions are | Filter pill |
|---|---|---|---|
| `microfrontends/` | editable | each child | Web |
| `mobile/` | editable | the folder itself | Mobile |
| `nugets/` | editable | each child | NuGet |
| `microservices/` | editable | each child | Backend |
| `functions/` | editable | each child | Backend |
| `other/` | on request (gap #15) | each child | Other |
| `deprecated/` | read-only | each grandchild (`deprecated/<type>/<repo>/`) | Read-only |
| `infrastructure/` | read-only | the folder itself | Read-only |

**The router `AGENTS.md`** at the workspace root. Every list item whose first token is a backticked folder ending in `/` is a folder rule: `` - `mobile/` — … ``, `` - `microfrontends/<repo-name>-front/` — … ``, `` - `deprecated/<type-group>/<repo-name>/` — … `` and the bold form `` - **`other/` is non-product, edit-on-request.** … ``. Items that start with anything else, files (`` `mobile/AGENTS.md` ``), hidden folders, table rows, numbered items and fenced code are ignored.
- **Rule** from the item's words (its line plus indented continuation lines): "read-only" / "read only" or "never modify / never edited" → read-only; else "on request", "on explicit developer request", "edit-on-request", "explicitly directs" or "only when the developer …" → on request; else editable. Read-only words win over on-request words in one item.
- **Depth** from the segments after the folder: `mobile/` = 0, `microfrontends/<repo-name>-front/` = 1, `deprecated/<type-group>/<repo-name>/` = 2 (capped at 3).
- Several items for one folder merge: the strictest rule, the deepest depth. The real router has three for `deprecated/` (Layout, Naming convention, Cross-cutting rules).

**Merge.** Baseline folders keep their order. The router can make one stricter (read-only > on request > editable) or deeper, never looser: a router that stopped saying `other/` is on request would still leave it on request. Folders only the router names are added after them, in the router's order, with its rule and depth and the pill Other (Read-only when read-only). Without an `AGENTS.md` the baseline alone applies (`router.found` = false in the scan).

## Walking the folders
For each folder at its depth:
- Only real directories count: files, symlinks and hidden entries (`.git`, `.idea`, `.claude`, `.worktrees`) are skipped. A top-level folder that is a symlink counts as absent.
- **Gap #16:** a folder whose `.git` is a **file** (a git worktree such as `web-front-wt-free-talk`, or a submodule) is skipped, at every level, the single-solution folders included.
- A folder whose `.git` is a directory (a main checkout) is a solution wherever it sits. So `deprecated/mobile/`, which the router lists as a repo directly under the type level, is one solution, not a type group.
- Any other folder is a solution at the last level (`git: false` in the scan, a slot the router defines that is not cloned yet) and a grouping folder above it.
- Nothing below a solution is scanned (e.g. `other/switchboard/.worktrees/`).

`WorkspaceScanner.scan()` returns the whole scan (`WorkspaceScan`: the router file with its line count for the setup wizard, then every folder with `exists`, `inRouter` and its solutions with `name`, `relativePath`, absolute `path`, `git`) for later items (M5.3 wizard, M8.2 Settings scan table).

## `GET /api/solutions`
`SolutionGroup[]` (`src/core/api.ts`):
- One group per writable folder that has solutions, `folder` = `microfrontends/`, `mobile/`, …; `note` empty, or **"on request only"** for an on-request folder (`other/`, gap #15; visible under the All filter since its pill is Other).
- Then **one** group `folder: "read-only"` with every read-only folder's solutions and the note built from the folders that have solutions: `deprecated/ · infrastructure/ · never edited` (the prototype's copy).
- Groups without solutions are left out. Solutions are sorted by name (case-insensitive).
- Each solution: `name` = its folder name, `path` = its absolute path in the current OS's form (gap #17; the detail panel shows it), `type` = the folder's pill, `rule` = the folder's rule. The live fields are neutral until M6.2 fills them: `status: "idle"`, `phase: "—"`, `changes: "—"` (`"locked"` for read-only, the prototype's copy), `flag: ""`, `conflict: false`, `branches: []`.
- `409 {error:"workspace-not-configured"}` without `SWITCHBOARD_WORKSPACE_ROOT`, `409 {error:"workspace-missing"}` when it is not a folder (the worktree manager's codes). Without a passed `providers.solutions` (tests), the route scans the configured root itself; demo mode serves the demo provider.

The scan runs on every request (a workspace has a few dozen folders); nothing is cached.

## Read-only sessions (`POST /api/sessions`, 422)
The validation always applies the static layout check (`isReadOnlyByLayout`: `deprecated/…`, `infrastructure`). With the scanner it also asks `SolutionsProvider.isReadOnly(solution)` (`readOnlyCheck` in core):
- a solution whose own path starts in a read-only folder is refused (`archive/old-repo` when the router marks `archive/` read-only);
- a bare name is refused when a folder it can resolve to under the router layout (`solutionCandidates`, the worktree manager's resolution: `<root>/<name>` or `<root>/<group>/<name>`) lies in a read-only folder **and exists**.

So a live `mobile` is never refused because the archive holds a `deprecated/mobile/`: a bare name cannot resolve into `deprecated/`. (A provider without `isReadOnly`, like the demo's, is matched by row name as before.)

## Tests
- `tests/core/workspace-rules.test.ts`: the parser on the real router phrasing (`tests/fixtures/workspace/router-AGENTS.md`, the folder-rule parts of the router verbatim) and on edge cases, the merge, `readOnlyCheck`, the grouping.
- `tests/server/solutions/scanner.test.ts` (M6.1 oracle): a fixture workspace in a temp folder with every folder kind, worktree folders, strays, symlinks, a router that adds and tightens folders, no router, a missing root; a real-git case (`git worktree add` folders skipped, every writable name resolves through the worktree manager to the listed path); the scan writes nothing.
- `tests/server/api/solutions.test.ts`: the route through the guard, the 409s, and `POST /api/sessions` refusing a router-read-only folder while a live `mobile` next to `deprecated/mobile/` starts a fake-claude session.
