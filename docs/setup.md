# First-run setup wizard (M5.3)

The five-step wizard of SPEC → Modals → Setup wizard (prototype `mWizard` with `WZ`, `wzSteps`, `wzChecks`, `scan`, `notif`, `askNotif`, `wzNext`). Code:
- UI: `src/web/modals/SetupWizard.tsx` (the component), `src/web/modals/setup-wizard.ts` (pure rules and copy), `src/web/modals/setup-wizard.css` (the prototype's inline styles as classes), `src/web/modals/FirstRunGate.tsx` (opens it on a first run; mounted in `Shell.tsx`).
- Server: `src/server/setup/service.ts` (`SetupService`), `src/server/api/setup.ts` (routes), `src/server/system/probe.ts` (`SystemProbe`, the real `GET /api/system`), `src/core/setup.ts` (shared rules: settings keys, router title, line count, threshold).

## When it opens
- **By itself** once per page load while the setup is not finished (`GET /api/setup` → `autoOpen`: no `setup.completedAt` and `SWITCHBOARD_SETUP_WIZARD` is not `off`) and no other modal is open.
- **Skip**, **Esc** (the global modal close) or any other close without Finish: the setup stays unfinished, and the tab remembers it (`sessionStorage` `switchboard.setupSkipped`), so it does not open by itself again in that tab. A new tab or window opens it again until it is finished. The prototype only stores "done" on Finish (`localStorage switchboard.setupDone`); Switchboard stores it in the service (settings table) instead, so it is per install, not per browser.
- **On demand**: `useModals().open('setup-wizard')` (Settings → Claude Code → "Run setup again", M8.2).
- No click outside closes it (as in the prototype).

## The steps
Header per step: `Step n of 5`, the title and the text, verbatim from the prototype's `WZ`. The rail marks the steps before the current one with ✓ (green dot) and the current one with its number on a light dot, as the prototype does (by position, not by what was done); any rail item can be clicked. Back / Skip / Continue (→ Finish on step 5).

1. **Claude Code CLI + login** — `GET /api/system?fresh=1` (the checks run again each time the step is shown):
   | Check | Passing row (prototype) | Failing row |
   |---|---|---|
   | `<claude bin> --version` exits 0 | ✓ Claude Code CLI found · `<cli>` (the command, see *System*) | ✕ Claude Code CLI not found · install Claude Code or set SWITCHBOARD_CLAUDE_BIN |
   | `<claude bin> auth status` exits 0 | ✓ Signed in · claude auth status · the login stays with Claude Code | ✕ Not signed in · claude auth status · run claude in a terminal to sign in (without the CLI: … needs the CLI) |
   | `<gh bin> auth status` exits 0 | ✓ GitHub CLI signed in · gh auth status · used to detect merged PRs | ✕ GitHub CLI not signed in · gh auth status failed · merged PRs are not detected |

   The prototype's login row reads "Signed in · Max plan / subscription auth · no API key". Switchboard reads only the exit code of `auth status` (M1.2: the real output was never captured), so it does not name a plan (never invented). ✓ is `oklch(0.76 0.13 150)`, ✕ the fail color. Nothing blocks Continue: a failing check is information.
2. **Add your first folder** (D14; the M5.3 "Workspace root" step; skippable) — rail label and title `Add your first folder`, text "A workspace (the folder that holds your router AGENTS.md) or a git repository. Each session picks its folder when it starts. You can skip this and add folders later in Settings → Folders." A Geist Mono field and **Browse…**: the shared folder picker (`useFolderPicker`, `docs/folders.md` → *UI*). The field starts with the default saved folder, else empty. Typing checks the folder after 250 ms (`GET /api/folders/check?path=`) and shows the D14 check line: a workspace `✓ AGENTS.md (Workspace Router) · <n> solutions` (the router's first `# ` heading; one that does not start with `AGENTS.md` is shown as `AGENTS.md (<heading>)`, none as `AGENTS.md`; then how many solutions its scan lists), a git repo `✓ git repo · single solution`, else `✕ <the server's message>` (`folder not found`, `enter an absolute path`, `no AGENTS.md here and not a git repository`, …). `~` means the home folder. **Browse…** lists the subfolders of the typed folder (else the default folder, else the home folder; `GET /api/setup/folders`): the path, `../`, then each folder; a click moves there and puts that folder in the field. Browse… again hides the list. **Continue** (or Enter) adds a non-empty field that is not saved yet (`POST /api/folders`; the first saved folder becomes the default); a refusal stays on the step as `Not added: <reason>` and nothing is saved. An empty field or a saved folder just moves on. D18: under the check line an optional **Name** (the folder's custom name, sent as `label`; its placeholder is the folder's own name once a path is typed, `optional` before; the form's mono section label); a taken or too long name is refused like a folder (`Not added: <the server's message>`); a folder saved already moves on unless a name was typed for it, which renames it.
3. **Scan solutions** — `GET /api/solutions` (the real scanner of the default folder, M6.1; a repo folder is its one solution) each time the step is shown, as the prototype's table: one row per top-level folder, in scan order (the API's single read-only group is split back into `deprecated/`, `infrastructure/` in the order its note names them), the solution count, the first three names (`, …` when there are more; the column ellipsizes), and the strictest rule (`editable` #8d8c87, `on request only` / `read-only` oklch(0.72 0.1 70)). Without a saved folder (409 `no-folder`): `No folder yet. Add one in step 2.`; an empty scan: `No solutions found in this workspace.`
4. **Notifications** — "Allow notifications" asks the browser (`Notification.requestPermission()`); granted → an OS notification "Switchboard / Notifications are on." (prototype `askNotif`, through M3.4's `notifyOs`). The state next to it: `✓ allowed` (done color), `✕ blocked in browser settings` (fail color), `not asked yet`, `not supported here` (#8d8c87). The permission belongs to the browser, so nothing is stored.
5. **Usage warnings** — `Warn at <n>%`, a 6 px amber bar at n %, `near limit → just warn`. n is the stored `usage.warnAtPct` (M8.2's key; a whole number 1–100, else 90). The wizard shows it; Settings → Notifications & usage changes it. **Finish** marks the setup done (`POST /api/setup/complete`) and closes; a refusal shows `Not finished: <reason>`.

## Folders instead of a workspace root (D14)
There is no workspace root to configure and no workspace environment variable: every session picks a saved folder (`docs/folders.md`). The wizard's second step only offers to add the first folder, and it can be skipped; without a saved folder the scan step, the Solutions view and `POST /api/sessions` answer `409 no-folder`. Sessions keep the folder they started in (`root`, `cwd`), whatever happens to the saved list later. A root the M5.3 wizard saved before D14 (`setup.workspaceRoot`) was migrated into the saved list as the default (`0003_folders.sql`).

## API (additive to the contract; behind the Host/Origin guard and the `sb_token` cookie)
| Method | Path | Returns |
|---|---|---|
| GET | `/api/setup` | `SetupState { completedAt, autoOpen, folders: Folder[], warnAtPct }` (D14: the saved folders, the default first) |
| GET | `/api/setup/folders?path=` | `FolderListing { path, parent, folders: [{ name, path }] }` (Browse…: the wizard, Settings → Folders → Add…, the New-session form): real subfolders only (no files, no hidden folders, no symlinks), sorted, at most 500; starts in the default folder, else the home folder; 404 `not-found`, 422 `invalid` |
| POST | `/api/setup/complete` | `SetupState` (stores `setup.completedAt`) |

Types live in `src/core/api.ts`. The folder check and the saved list are the `/api/folders` routes (`docs/folders.md`); the M5.3 routes `GET/PUT /api/setup/root` are gone (D14). Nothing here writes outside the settings table, and nothing is read below a listed folder.

## System (`GET /api/system`, contract)
`SystemProbe` is the real `SystemProvider` (main.ts; demo mode keeps the demo provider):
- `cli`: when `<SWITCHBOARD_CLAUDE_BIN> --version` exits 0, the command: for a one-word command its `PATH` location (like the shell; `PATHEXT` on Windows), for an argv prefix (the JSON-array form, e.g. the fake) the whole prefix joined with spaces; else `null`. `cliVersion`: the version word of the first line (`2.1.283 (Claude Code)` → `2.1.283`).
- `signedIn`: the CLI was found and `<claude bin> auth status` exits 0. `ghSignedIn`: `<SWITCHBOARD_GH_BIN> auth status` exits 0.
- The three commands run with `shell: false` in the app-data folder, the claude ones with the supervisor's scrubbed child env (`CLAUDE_CONFIG_DIR` kept), 15 s timeout each, no model call. Their result is reused for 30 s (the `/hub` `system` event asks every 5 s while a client is connected); concurrent callers share one run; `?fresh=1` (additive) checks again.
- `cpu`: machine-wide busy share of all cores since the previous reading (`os.cpus()` times), rounded to a whole percent; the last value is kept when no time passed. `ramTotal`: `os.totalmem()` in bytes. `processes`: live supervised `claude` processes (gap #11, `SessionSupervisor.liveCount`).
- `ramUsed` (D17, `src/server/system/memory.ts`): the memory **actually in use**, in bytes, not `total − free` (on macOS `freemem` leaves out reclaimable file cache, so that read 88–93 of 96 GB on the developer's Mac).
  - **macOS:** Activity Monitor's *Memory Used* = app memory + wired + compressed, from `/usr/bin/vm_stat` (argv, `shell: false`, 5 s timeout): (`Anonymous pages` − `Pages purgeable`) + `Pages wired down` + `Pages occupied by compressor`, × the page size of its header line (`page size of 16384 bytes`). The developer's sample (anonymous 4206892, purgeable 136138, wired 292409, compressor 184332) is 74.5 GB decimal = 69.4 GiB; the footer counts GiB like its total (`69.4/96 GB`), as Activity Monitor does.
  - **Linux:** `MemTotal − MemAvailable` from `/proc/meminfo` (read asynchronously).
  - **Windows** (and any other OS): `os.totalmem() − os.freemem()`.
  - **Fallback:** when the read fails (no `vm_stat`, it exits non-zero or times out, `/proc/meminfo` unreadable, a counter or the page size missing, `MemAvailable` absent on kernels before 3.14) `ramUsed` is `total − free` again, until a later read succeeds. Nothing is logged.
  - **Cadence:** the read runs in the background and never blocks a request: the probe starts one when it is created, and a `system()` call starts the next one when the last started ≥ 2 s ago (`MEMORY_READ_INTERVAL_MS`), answering from the last finished read (the one after the previous 5 s `system` tick). The route and the hub share reads. The value is capped at `ramTotal`.
- Usage (`usagePct`, `usageResetsAt`, `usageWindows`, `usageWarnings`) is added by the meter in normal runs (`docs/usage.md`, M9.2 / D17); the probe itself reports none.
- An app built without a system provider answers `503 system-unavailable`; the route never runs a CLI of its own.

## Configuration
- `SWITCHBOARD_SETUP_WIZARD=off` stops the automatic opening (Run setup again still works). Any other value, or none, keeps it.
- Test servers (`tests/helpers/server-process.ts` → `testServerDefaults()`) default to the fake CLIs (`SWITCHBOARD_CLAUDE_BIN`, `SWITCHBOARD_GH_BIN`) and `SWITCHBOARD_SETUP_WIZARD=off`, so `/api/system` never runs the real `claude` or `gh` and the wizard does not cover the pages other specs drive. A spec can override each.

## Tests
- `tests/e2e/setup-wizard.spec.ts` (oracle, real path: fake-claude, fake gh, fixture workspace, no demo): the first run opens by itself and walks all five steps (checks, a refused folder, Browse… to the workspace, the folder added, the real scan, the mocked `Notification` asked and confirmed, the threshold, Back and the rail, Finish); the folder is used at once (a session's process runs there) and after a restart; signed-out rows with a folder saved already, Skip / Esc close it for the tab and a new tab opens it again.
- `tests/server/setup/setup.test.ts`: the service (state with the saved folders, Browse…, complete, `SWITCHBOARD_SETUP_WIZARD`), the routes behind the guard (the workspace-root routes gone), the first folder added through `POST /api/folders` reaching new sessions at once, `/api/system` with and without a provider. The folder kinds and routes: `tests/server/folders/folders.test.ts`.
- `tests/server/system/probe.test.ts`: the probe over the fakes (signed in / out, missing CLIs, cache + fresh + shared run, CPU, processes).
- `tests/web/setup-wizard.test.ts`: steps and texts against the prototype's `WZ`, rail, rows, the folder line (from a `FolderCheck`), scan rows, notification copy.
- `tests/e2e/visual/setup-wizard.spec.ts`: D10 on all five steps (`docs/visual/setup-wizard.md`).
