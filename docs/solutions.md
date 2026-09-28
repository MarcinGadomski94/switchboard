# Solutions: the workspace scanner (M6.1) and the Solutions view (M6.2)

How Switchboard finds the workspace's solutions and decides which ones sessions may write to. The pure rules are in `src/core/workspace-rules.ts`; the file-system walk is `WorkspaceScanner` in `src/server/solutions/scanner.ts`, the real `SolutionsProvider` (`docs/lanes.md`), wired in `src/server/main.ts`. It serves `GET /api/solutions` and the read-only check of `POST /api/sessions`. M6.2 fills the live fields of each row (`LiveSolutions`, *Live fields* below) and renders the view (*The view* below); M6.3 adds conflicts.

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
- Each solution: `name` = its folder name, `path` = its absolute path in the current OS's form (gap #17; the detail panel shows it), `relativePath` = its path from the root, `/`-separated (M6.2; the view derives the header's root from it), `type` = the folder's pill, `rule` = the folder's rule. The scan alone (`toSolutionGroups`) leaves the live fields neutral: `status: "idle"`, `phase: "—"`, `changes: "—"` (`"locked"` for read-only, the prototype's copy), `flag: ""`, `conflict: false`, `branches: []`, `ledger: null`, `artifacts: []`, `codebaseMemory: "unknown"`; `LiveSolutions` fills them (below).
- `409 {error:"workspace-not-configured"}` without `SWITCHBOARD_WORKSPACE_ROOT`, `409 {error:"workspace-missing"}` when it is not a folder (the worktree manager's codes). Without a passed `providers.solutions` (tests), the route builds `LiveSolutions` over the configured root, the store and the session diff itself; demo mode serves the demo provider.

The scan runs on every request (a workspace has a few dozen folders); nothing is cached.

## Live fields (M6.2)
`LiveSolutions` (`src/server/solutions/live.ts`, the real `SolutionsProvider` wired in `main.ts`) runs the scan, then fills each row from the database and the solution folders. The pure rules are in `src/core/solutions-live.ts`. It reads only: the database, `<solution>/.git/HEAD`, `<solution>/phase-ledger.md`, `<solution>/mobile-followups/`, `<root>/.claude/.codebase-memory-dirty`; git runs only through the session diff (the worktree manager, gap #10). Nothing is cached; a file that cannot be read leaves its field neutral and is reported through `onError`.

- **Which sessions work on a row.** A live worktree belongs to the row whose canonical path is the worktree's `repoPath` (worktree rows store canonical paths). A session works **in place** on a row when it is open (`endedAt` is null: live, paused or detached), lists a solution that resolves to that row the way the worktree manager resolves it (`solutionCandidates`: `<root>/<name>` or `<root>/<group>/<name>`; exactly one git checkout among the writable rows, else no row), and has no worktree for it. Read-only rows never get sessions.
- **`branches`** (chips and branch cards), in this order: each live worktree (`branch`, `worktree` = its path, given in the configured root's form when it sits next to the repo so the UI can print `../<folder>`, `owner` = its session's name, `status` = the session's status; a worktree whose session is gone: owner `—`, `idle`), then each in-place session (`branch` = the checkout's branch, `worktree: null`, the session's name and status). A row nobody works on shows its checkout's branch with owner `idle` (the prototype's `⎇ main · idle`); a folder without git shows no chip. The checkout's branch comes from `.git/HEAD` (`ref: refs/heads/<branch>`, or the first 7 characters of a detached commit), not from a git process.
- **`status`** (the row's dot): the most urgent status among the sessions on its branches, `need` > `fail` > `run` > `paused` > `done` > `idle`; `idle` without sessions and for read-only rows. The header's "n active" counts rows whose status is not `idle`.
- **`phase`**: the phase ledger's phase (`mixed` when its entries differ), else the open sessions' phases (`UI-first` / `integration` / `mixed`), else `—`; `—` for read-only rows.
- **`changes`**: the lines the sessions' diffs add to the row (gap #10: each worktree against the merge-base with its base branch, in-place solutions against HEAD, untracked files included), summed over the sessions that have a worktree in the repo or work in place on it: `+<added>`; `−<removed>` when lines are only removed; `—` without changes; `locked` for read-only rows. A diff that fails counts nothing.
- **`ledger`** (gap #12): `<solution>/phase-ledger.md` parsed leniently, `null` without the file. Table rows: the phase cell holds only `UI-first` / `integration` (any case, `ui first` too), the interface is the first non-empty cell before it, the seam the non-empty cells after it joined with ` · `; header and separator rows are skipped. List items: the interface is the text before the first phase word, the seam the text after it, separators (`→`, `->`, `=>`, `:`, dashes, `|`, `,`, `·`) trimmed. Backticks and bold marks are removed; headings, prose, items without a phase word or without an interface and fenced code are skipped.
- **`artifacts`** ("Artifacts & follow-ups"): the sessions' artifacts whose `solution` is the row's name (gap #9, every type, newest first, one per type + name), then the row's `mobile-followups/*.md` files that are not listed yet (type `FOLLOWUP`, no meta, no session). The follow-up files' format is not specified, so no "n pending" is derived.
- **`codebaseMemory`**: `dirty` when `<root>/.claude/.codebase-memory-dirty` lists the row's codebase-memory project id, else `fresh`; `unknown` when the file exists but cannot be read (a missing file means nothing is dirty). The id follows the workspace's dirty-tracker hook: the absolute path with `\` turned into `/`, runs of `:` `/` `\` turned into one `-`, leading and trailing `-` removed (`/ws/microfrontends/web-front` → `ws-microfrontends-web-front`); lines match case-insensitively. For a row that is a whole top-level folder (`mobile/`, `infrastructure/`), a line `<id>-<anything>` also counts, because the hook records edits under `mobile/` as `<root>-mobile-<first subfolder>`. M6.4 owns this rule's refinements (the Tools strip, reindexing).
- `conflict` / `flag` stay neutral here: M6.3 detects two sessions writing one working tree.

Demo mode serves the same fields from `src/server/demo/data/solutions.json` (the prototype's `SG`, `LED`, `ARTS` and dirty list, paths under its root `D:\acme`, `docs/demo.md`).

## The view (M6.2)
`src/web/views/SolutionsView.tsx` + `solutions.css` (SPEC → Solutions; the prototype's inline styles as classes over the SPEC tokens), with the pure view logic in `solutions-format.ts`:
- Header: "Solutions" + `<root> · <n> solutions · <n> active` (the root is the first row's `path` minus its `relativePath` segments; nothing while the list is not loaded). Filter pills All, Web, Mobile, NuGet, Backend, Read-only; `other/` rows (pill Other) show under All only (gap #15).
- Groups by folder (the note in `#5a5955`), the read-only group at 60% opacity. Row grid `minmax(130px,190px) minmax(240px,1fr) 80px 54px`: status dot + name (flag on a second line, amber for a conflict), branch chips `⎇ branch · worktree folder · dot · owner` (ellipsized), phase, changes. Rows are buttons (click, Enter, Space).
- Detail panel of the selected row (default: the first row; the selection survives filtering): path, name, "Branches & worktrees" cards (branch, `../<worktree folder>` next to the repo / the full path elsewhere / `in place`, owner with its status dot), "Phase ledger" (phase in amber for UI-first, blue for integration; without a ledger one row `— · <row phase> · no phase-ledger.md` (gap #12), with an empty one `phase-ledger.md has no entries`), "Artifacts & follow-ups" (type tag, name, meta; none → `INFO · No artifacts`), and the freshness line: `codebase-memory · edited by agents since last index` (amber) / `codebase-memory · indexed · fresh` (green) / `codebase-memory · freshness unknown` + "open Codebase Memory ›", which opens the tool named Codebase Memory, or Settings → Embedded tools while none is configured.
- Live: `sessionUpdated` reloads the list (at most once a second), `worktreeRemovable` reloads it at once. A 409 shows "No workspace root is configured (SWITCHBOARD_WORKSPACE_ROOT)." or the server's message; an empty workspace "No solutions found in the workspace."
- The conflict card with "Move … to worktree" is M6.3.

## Read-only sessions (`POST /api/sessions`, 422)
The validation always applies the static layout check (`isReadOnlyByLayout`: `deprecated/…`, `infrastructure`). With the scanner it also asks `SolutionsProvider.isReadOnly(solution)` (`readOnlyCheck` in core):
- a solution whose own path starts in a read-only folder is refused (`archive/old-repo` when the router marks `archive/` read-only);
- a bare name is refused when a folder it can resolve to under the router layout (`solutionCandidates`, the worktree manager's resolution: `<root>/<name>` or `<root>/<group>/<name>`) lies in a read-only folder **and exists**.

So a live `mobile` is never refused because the archive holds a `deprecated/mobile/`: a bare name cannot resolve into `deprecated/`. (A provider without `isReadOnly`, like the demo's, is matched by row name as before.)

## Tests
- `tests/core/workspace-rules.test.ts`: the parser on the real router phrasing (`tests/fixtures/workspace/router-AGENTS.md`, the folder-rule parts of the router verbatim) and on edge cases, the merge, `readOnlyCheck`, the grouping.
- `tests/server/solutions/scanner.test.ts` (M6.1 oracle): a fixture workspace in a temp folder with every folder kind, worktree folders, strays, symlinks, a router that adds and tightens folders, no router, a missing root; a real-git case (`git worktree add` folders skipped, every writable name resolves through the worktree manager to the listed path); the scan writes nothing.
- `tests/server/api/solutions.test.ts`: the route through the guard, the 409s, and `POST /api/sessions` refusing a router-read-only folder while a live `mobile` next to `deprecated/mobile/` starts a fake-claude session.
- M6.2: `tests/core/solutions-live.test.ts` (ledger parser, summaries, `.git/HEAD`, project ids and freshness), `tests/web/solutions-format.test.ts` (view logic), `tests/server/solutions/live.test.ts` (real git repos, sessions started through `POST /api/sessions` with fake-claude writing through `[fake:write]`, a worktree and an in-place session, diffs, ledgers, follow-ups, dirty list), `tests/e2e/solutions.spec.ts` (the view on the real code path: live updates through `/hub`, filters, selection, detail panel, the no-root message) and `tests/e2e/visual/solutions.spec.ts` (the visual oracle, `docs/visual/solutions.md`).
