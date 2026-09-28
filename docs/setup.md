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
2. **Workspace root** — a Geist Mono field and **Browse…**. The field starts with the root in effect. Typing checks the folder after 250 ms (`GET /api/setup/root?path=`): `✓ AGENTS.md (Workspace Router) found · 640 lines` (the router's first `# ` heading and its line count; a heading that does not start with `AGENTS.md` is shown as `AGENTS.md (<heading>)`, none as `AGENTS.md`), or `✕ no AGENTS.md in this folder`, `✕ folder not found`, `✕ enter an absolute path`. `~` means the home folder. **Browse…** lists the subfolders of the typed folder (else the root, else the home folder; `GET /api/setup/folders`): the path, `../`, then each folder; a click moves there and puts that folder in the field. Browse… again hides the list. **Continue** (or Enter) saves a changed, non-empty field (`PUT /api/setup/root`); a refusal stays on the step as `Not saved: <reason>`. An empty or unchanged field just moves on. When `SWITCHBOARD_WORKSPACE_ROOT` is set, the field shows it read-only, Browse… is hidden and a muted line says `set by SWITCHBOARD_WORKSPACE_ROOT · change it there`.
3. **Scan solutions** — `GET /api/solutions` (the real scanner of the root in effect, M6.1) each time the step is shown, as the prototype's table: one row per top-level folder, in scan order (the API's single read-only group is split back into `deprecated/`, `infrastructure/` in the order its note names them), the solution count, the first three names (`, …` when there are more; the column ellipsizes), and the strictest rule (`editable` #8d8c87, `on request only` / `read-only` oklch(0.72 0.1 70)). Without a root: `No workspace root yet. Choose one in step 2.`; an empty scan: `No solutions found in this workspace.`
4. **Notifications** — "Allow notifications" asks the browser (`Notification.requestPermission()`); granted → an OS notification "Switchboard / Notifications are on." (prototype `askNotif`, through M3.4's `notifyOs`). The state next to it: `✓ allowed` (done color), `✕ blocked in browser settings` (fail color), `not asked yet`, `not supported here` (#8d8c87). The permission belongs to the browser, so nothing is stored.
5. **Usage warnings** — `Warn at <n>%`, a 6 px amber bar at n %, `near limit → just warn`. n is the stored `usage.warnAtPct` (M8.2's key; a whole number 1–100, else 90). The wizard shows it; Settings → Notifications & usage changes it. **Finish** marks the setup done (`POST /api/setup/complete`) and closes; a refusal shows `Not finished: <reason>`.

## Workspace root
The root sessions start in is `SWITCHBOARD_WORKSPACE_ROOT` when it is set, else the one saved by the wizard (settings key `setup.workspaceRoot`, an absolute path), else none. `SetupService.open()` loads it before main.ts creates the services, and `liveConfig()` gives them a configuration whose `workspaceRoot` reads the service on every access (per-request readers: the M5.2 first-turn payload, the solutions route's fallback scanner, M8.2's `workspace.root` row). A root saved later reaches the long-lived services at once through `onRootChange`: `SessionSupervisor.setWorkspaceRoot`, `WorktreeManager.setWorkspaceRoot` (wired in `buildApp`) and `WorkspaceScanner.setWorkspaceRoot` (main.ts). No restart is needed.

Saving (`PUT /api/setup/root { path }`) is refused:
- `409 root-from-env` while `SWITCHBOARD_WORKSPACE_ROOT` is set (the environment wins; change it there);
- `422 invalid` (+ `check`) for anything but an existing folder with an `AGENTS.md` (the router is what makes sessions follow the workspace rules);
- `409 sessions-live` when it would change the root while supervised `claude` processes run. Sessions keep the folder they started in anyway (their stored `cwd` is used on resume); only new sessions, scans and worktrees use the new root.

## API (additive to the contract; behind the Host/Origin guard and the `sb_token` cookie)
| Method | Path | Returns |
|---|---|---|
| GET | `/api/setup` | `SetupState { completedAt, autoOpen, workspaceRoot: { path, source: env\|setup\|null, check }, warnAtPct }` |
| GET | `/api/setup/root?path=` | `WorkspaceRootCheck { path, state: ok\|no-router\|missing\|not-absolute, router: { title, lines } \| null }`; 400 without `path` |
| PUT | `/api/setup/root` | `{ path }` → `SetupState`; 409 / 422 as above (`{ error, message, check? }`) |
| GET | `/api/setup/folders?path=` | `FolderListing { path, parent, folders: [{ name, path }] }`: real subfolders only (no files, no hidden folders, no symlinks), sorted, at most 500; 404 `not-found`, 422 `invalid` |
| POST | `/api/setup/complete` | `SetupState` (stores `setup.completedAt`) |

Types live in `src/core/api.ts`. Nothing here writes outside the settings table, and nothing is read below a listed folder.

## System (`GET /api/system`, contract)
`SystemProbe` is the real `SystemProvider` (main.ts; demo mode keeps the demo provider):
- `cli`: when `<SWITCHBOARD_CLAUDE_BIN> --version` exits 0, the command: for a one-word command its `PATH` location (like the shell; `PATHEXT` on Windows), for an argv prefix (the JSON-array form, e.g. the fake) the whole prefix joined with spaces; else `null`. `cliVersion`: the version word of the first line (`2.1.283 (Claude Code)` → `2.1.283`).
- `signedIn`: the CLI was found and `<claude bin> auth status` exits 0. `ghSignedIn`: `<SWITCHBOARD_GH_BIN> auth status` exits 0.
- The three commands run with `shell: false` in the app-data folder, the claude ones with the supervisor's scrubbed child env (`CLAUDE_CONFIG_DIR` kept), 15 s timeout each, no model call. Their result is reused for 30 s (the `/hub` `system` event asks every 5 s while a client is connected); concurrent callers share one run; `?fresh=1` (additive) checks again.
- `cpu`: machine-wide busy share of all cores since the previous reading (`os.cpus()` times), rounded to a whole percent; the last value is kept when no time passed. `ramUsed` / `ramTotal`: `os.totalmem() − os.freemem()` / `os.totalmem()` in bytes (on macOS `freemem` leaves out reclaimable cache, so "used" reads high). `processes`: live supervised `claude` processes (gap #11, `SessionSupervisor.liveCount`).
- `usagePct` / `usageResetsAt` are left out (the footer shows "unknown") until M9.2.
- An app built without a system provider answers `503 system-unavailable`; the route never runs a CLI of its own.

## Configuration
- `SWITCHBOARD_SETUP_WIZARD=off` stops the automatic opening (Run setup again still works). Any other value, or none, keeps it.
- Test servers (`tests/helpers/server-process.ts` → `testServerDefaults()`) default to the fake CLIs (`SWITCHBOARD_CLAUDE_BIN`, `SWITCHBOARD_GH_BIN`) and `SWITCHBOARD_SETUP_WIZARD=off`, so `/api/system` never runs the real `claude` or `gh` and the wizard does not cover the pages other specs drive. A spec can override each.

## Tests
- `tests/e2e/setup-wizard.spec.ts` (oracle, real path: fake-claude, fake gh, fixture workspace, no demo): the first run opens by itself and walks all five steps (checks, a refused folder, Browse… to the workspace, the saved root, the real scan, the mocked `Notification` asked and confirmed, the threshold, Back and the rail, Finish); the root is used at once (a session's process runs there) and after a restart; signed-out rows, the root read-only from the environment (409 on save), Skip / Esc close it for the tab and a new tab opens it again.
- `tests/server/setup/setup.test.ts`: the service (state, checks, save + refusals + persistence, Browse…, complete, `SWITCHBOARD_SETUP_WIZARD`), the routes behind the guard, a root saved through the API reaching the supervisor at once, `/api/system` with and without a provider.
- `tests/server/system/probe.test.ts`: the probe over the fakes (signed in / out, missing CLIs, cache + fresh + shared run, CPU, processes).
- `tests/web/setup-wizard.test.ts`: steps and texts against the prototype's `WZ`, rail, rows, root line, scan rows, notification copy.
- `tests/e2e/visual/setup-wizard.spec.ts`: D10 on all five steps (`docs/visual/setup-wizard.md`).
