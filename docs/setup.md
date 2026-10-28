# Setup

How to install the requirements, install Switchboard with the one-line installer or by hand, run it in other ways, start it at login, and fix common problems. The first-run setup wizard is described at the end of this page.

Copyable command blocks on this page have no comments, so they paste safely into macOS zsh, Linux bash and Windows PowerShell; the explanations are in the text around them.

## Requirements

| What | Needed for | Check |
|---|---|---|
| **Node.js 24 or newer** (with npm), on `PATH` | Switchboard runs its TypeScript directly on Node (type stripping). | `node --version` |
| **git** | Worktrees, branches and diffs. On Windows, Git for Windows is also what Claude Code needs. | `git --version` |
| **At least one agent CLI**, signed in: Claude Code, Codex CLI or OpenCode (the next two rows) | Switchboard runs no model itself; every agent is one of these CLIs. | |
| **Claude Code CLI** (`claude`), signed in with your claude.ai subscription | Every Claude Code session is a real `claude` process, and new sessions start on it unless Settings → CLIs sets another default CLI. Remote Control, workflow agents, background tasks and hooked terminal sessions exist only on Claude Code (`docs/providers.md` → *Capability matrix*). An API key alone is not enough for Remote Control. | `claude --version`, `claude auth status` |
| **Codex CLI** (`codex`) and / or **OpenCode** (`opencode`), signed in | Sessions on those CLIs (`docs/providers.md`). Without them, they just can't be chosen. | `codex login status`, `opencode auth list` |
| **A browser**: Chrome (recommended), Edge, Firefox or Safari | The UI. Embedding signed-in sites such as Jira needs Chrome (`docs/frame-helper.md`). | |
| **GitHub CLI** (`gh`), signed in (optional) | Merged pull requests of session worktrees, and the CI loop (`docs/ci.md`). | `gh auth status` |
| **Jira Cloud** API token (optional) | Importing a Jira epic into a plan, and its status sync (`docs/plans.md`). | |
| **Tailscale** (optional) | Paired machines (`docs/peers.md`) and phones / tablets (`docs/devices.md`). | `tailscale status` |

### macOS

With [Homebrew](https://brew.sh), install Node.js and git (check that `node --version` is 24 or newer; nvm or fnm work too), the optional GitHub CLI, and Claude Code with its native installer:

```sh
brew install node git
brew install gh
curl -fsSL https://claude.ai/install.sh | bash
```

Then run `claude` once and sign in with your claude.ai account.

### Linux

Distribution packages of Node.js are often older than 24, so install it with [nvm](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
```

Open a new terminal, then install Node.js 24, git (Debian / Ubuntu shown; use your distribution's package manager otherwise) and Claude Code:

```bash
nvm install 24
sudo apt install git
curl -fsSL https://claude.ai/install.sh | bash
```

Run `claude` once and sign in. The GitHub CLI is optional: see [its Linux install guide](https://github.com/cli/cli/blob/trunk/docs/install_linux.md). Start at login uses a **systemd user service** (most desktop distributions).

### Windows 10 / 11

In PowerShell, install Node.js (check that `node --version` is 24 or newer), Git for Windows, the optional GitHub CLI, and Claude Code with its native installer:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install GitHub.cli
irm https://claude.ai/install.ps1 | iex
```

Open a **new** terminal so the updated `PATH` is picked up, then run `claude` once and sign in. Use the native installer for Claude Code: an npm install creates `claude.cmd`, which Switchboard can't start without a shell (then set `SWITCHBOARD_CLAUDE_BIN`, `docs/configuration.md`). `tar` and `curl` come with Windows 10 and 11.

## One-line install

The README's one-liners run [`install.sh`](../install.sh) (macOS, Linux; POSIX `sh`) or [`install.ps1`](../install.ps1) (Windows PowerShell 5.1 and PowerShell 7) from the repository's `master` branch. Read them first if you like; they are short. Each one:

1. checks for Node.js 24 or newer with npm, and without them prints how to install them and stops before installing anything;
2. finds the latest release through the GitHub API (or the `releases/latest` redirect when the API is rate limited), or takes `--version`;
3. downloads `switchboard-<version>.tar.gz` and its `.sha256`, and verifies the checksum (`sha256sum` / `shasum -a 256`, `Get-FileHash` on Windows); a mismatch stops it before anything is unpacked;
4. unpacks it into `<dir>/switchboard-<version>` after checking every entry stays inside that folder, and runs `npm ci --omit=dev` there;
5. registers the login service (`tools/service/install.ts`, the same as `npm run service:install`) when you pass `--service`, or when you answer yes. It asks only in an interactive terminal; without one the default is no. A login service that already starts this install is kept and pointed at the new version;
6. starts Switchboard (through the login service, else in the background with its output in `<dir>/switchboard.log`) and prints `http://127.0.0.1:13001`.

It never uses sudo or administrator rights, never edits shell profiles and sends no telemetry. The only downloads are the release from GitHub and the dependencies from the npm registry.

**Running it again** upgrades to the latest release or, on the same version, repairs it: a fresh download replaces the folder, and a Switchboard it started is stopped and started again. It keeps the version it replaced (for a rollback) and removes older `switchboard-*` folders, unless the login service points at one. If something else already answers on the port (another Switchboard), it installs but does not start a second one.

**Options** (`install.ps1` takes them as `-Dir`, `-Version`, `-Service`, `-NoService`, `-NoStart`, `-Uninstall`, `-Purge`):

| Option | What |
|---|---|
| `--dir <folder>` | Install folder. Default `~/Applications/Switchboard` (macOS), `~/.local/opt/switchboard` (Linux), `%LOCALAPPDATA%\Programs\Switchboard` (Windows). |
| `--version <x.y.z>` | That release instead of the latest (also `SWITCHBOARD_VERSION`). |
| `--service` / `--no-service` | Register the login service, or don't (no question asked). |
| `--no-start` | Install only. |
| `--uninstall` | Stops the Switchboard it started and removes the login service when it points at this install. Removes the install folder and the versions the in-app updater put in the data folder (`versions/`, `updates/`). **Keeps your data**: the database, the token, attachments and logs. It refuses to delete a folder that holds files it did not make. |
| `--purge` | With `--uninstall`: also removes the data folder. |

`SWITCHBOARD_PORT`, `SWITCHBOARD_DATA_DIR` and the other settings (`docs/configuration.md`) are passed on to Switchboard and to the login service. `SWITCHBOARD_UPDATE_REPO` (`owner/name`) installs from a fork. `SWITCHBOARD_INSTALL_SOURCE` is **for tests**: a folder URL such as `file:///tmp/release` that holds `switchboard-<version>.tar.gz` and its `.sha256`, used instead of GitHub (the newest one there unless `--version`).

To pass options through the one-liner on macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/MarcinGadomski94/switchboard/master/install.sh | sh -s -- --service
```

On Windows:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/MarcinGadomski94/switchboard/master/install.ps1))) -Service
```

To uninstall on macOS or Linux (add `--purge` to remove your data as well):

```sh
curl -fsSL https://raw.githubusercontent.com/MarcinGadomski94/switchboard/master/install.sh | sh -s -- --uninstall
```

On Windows:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/MarcinGadomski94/switchboard/master/install.ps1))) -Uninstall
```

**With npm.** `npx @marcingadomski94/switchboard` (once published, `docs/publishing.md`) does the same in Node, with the same options (`--help` lists them). The package is only the installer, so it works the same on every OS.

**And the in-app updater.** The installer makes the layout of the manual install: the release unpacked into a folder of its own, outside the data folder. The updater recognises it as a **release install** and takes over from there: it puts later versions into `<data folder>/versions/<version>` and points the login service at them (`docs/updates.md` → *Install layout*). Running the installer again later works too. It installs the newest release into its own folder again and points the login service back there.

**Tests:** `tests/tools/installer.test.ts` runs `install.sh` (under `sh`, and under `dash` where it exists) and the npx launcher against local fake releases in a temp HOME on a test port (4700-4799). It covers install and start (`/` answers 200), repair, a checksum mismatch, the login service through the test redirect (`SWITCHBOARD_SERVICE_HOME`), upgrade, uninstall, purge and a refused folder. It also unit-tests the launcher's version resolution and checksum parsing. `install.ps1` has no automated test: no PowerShell on the development Mac.

## Manual install

The same steps by hand. Replace `2.4.5` with the [latest release](https://github.com/MarcinGadomski94/switchboard/releases/latest) if a newer one exists. Each block downloads a release, extracts it only when its checksum matches, installs it, and starts Switchboard now and at every sign-in. Paste a block as a whole.

**macOS:**

```sh
V=2.4.5
DIR=~/Applications/Switchboard
mkdir -p "$DIR"
cd "$DIR"
curl -LO https://github.com/MarcinGadomski94/switchboard/releases/download/v$V/switchboard-$V.tar.gz
curl -LO https://github.com/MarcinGadomski94/switchboard/releases/download/v$V/switchboard-$V.tar.gz.sha256
shasum -a 256 -c switchboard-$V.tar.gz.sha256 && tar -xzf switchboard-$V.tar.gz
cd switchboard-$V
npm ci --omit=dev
npm run service:install -- --start
```

**Linux:**

```bash
V=2.4.5
DIR=~/.local/opt/switchboard
mkdir -p "$DIR"
cd "$DIR"
curl -LO https://github.com/MarcinGadomski94/switchboard/releases/download/v$V/switchboard-$V.tar.gz
curl -LO https://github.com/MarcinGadomski94/switchboard/releases/download/v$V/switchboard-$V.tar.gz.sha256
sha256sum -c switchboard-$V.tar.gz.sha256 && tar -xzf switchboard-$V.tar.gz
cd switchboard-$V
npm ci --omit=dev
npm run service:install -- --start
```

**Windows** (PowerShell; closing the console window the task opens stops Switchboard, so minimise it):

```powershell
$V = "2.4.5"
$Dir = "$env:LOCALAPPDATA\Programs\Switchboard"
New-Item -ItemType Directory -Force $Dir | Out-Null
Set-Location $Dir
curl.exe -LO "https://github.com/MarcinGadomski94/switchboard/releases/download/v$V/switchboard-$V.tar.gz"
curl.exe -LO "https://github.com/MarcinGadomski94/switchboard/releases/download/v$V/switchboard-$V.tar.gz.sha256"
$Expected = (Get-Content "switchboard-$V.tar.gz.sha256").Split(" ")[0]
$Actual = (Get-FileHash "switchboard-$V.tar.gz" -Algorithm SHA256).Hash.ToLower()
if ($Actual -eq $Expected) { tar -xzf "switchboard-$V.tar.gz" } else { Write-Error "Checksum mismatch: do not install this download." }
Set-Location "switchboard-$V"
npm ci --omit=dev
npm run service:install -- --start
```

The version in these blocks follows `package.json`: `npm version` rewrites it (`tools/release/server-json.ts`), and `tests/docs/server-json.test.ts` fails when they drift.

## Install notes

- **The release install** (the installer or the manual steps above) downloads a release and its `.sha256`, extracts it only when the checksum matches, runs `npm ci --omit=dev` (runtime dependencies only) and registers the login service with `npm run service:install -- --start`.
- **Folders used:** `~/Applications/Switchboard` (macOS), `~/.local/opt/switchboard` (Linux) and `%LOCALAPPDATA%\Programs\Switchboard` (Windows). Any folder works.
- **Without the login service:** leave out the last command and run `npm start` in the `switchboard-<version>` folder instead, keeping the terminal open.
- **Windows:** the Task Scheduler task runs `node.exe` in a console window; **closing that window stops Switchboard** (minimise it instead).
- **Your data** (the database, the access token, attachments, logs, updated versions) lives in the per-user data folder: `~/Library/Application Support/Switchboard` (macOS), `~/.local/share/switchboard` (Linux), `%LOCALAPPDATA%\Switchboard` (Windows). `SWITCHBOARD_DATA_DIR` moves it.

## Open it
Open **http://127.0.0.1:13001** by typing it or from a bookmark. That first page load gives your browser its access cookie (`docs/security.md`). The first time, the setup wizard (below) opens; you can skip it and do everything later in Settings. To install Switchboard as an app window, see `docs/install-app.md`.

## From source
A git checkout builds the UI itself and is only **told** about new releases, not updated (`docs/updates.md`). `npm ci` installs the exact, pinned dependencies including the build tools, and `npm run build` builds the UI into `dist/web`:

```sh
git clone https://github.com/MarcinGadomski94/switchboard.git
cd switchboard
npm ci
npm run build
npm start
```

To run it on another port next to a release install, on macOS or Linux:

```sh
SWITCHBOARD_PORT=13005 npm start
```

On Windows (PowerShell):

```powershell
$env:SWITCHBOARD_PORT = "13005"
npm start
```

**Updating a git checkout:** pull, reinstall the dependencies (needed only when `package-lock.json` changed), rebuild the UI (it is served from `dist/web`), then restart Switchboard (stop `npm start` or the service and start it again). Database migrations run by themselves on start, and sessions that were live are resumed.

```sh
git pull
npm ci
npm run build
```

## Start at login
**Settings → Claude Code → Start at login**, or the commands below in the folder you start Switchboard from (launchd on macOS, a systemd user service on Linux, Task Scheduler on Windows). The service starts `node src/server/main.ts` there with the `SWITCHBOARD_*` settings of the shell you install from. A release install is ready as it is; a git checkout needs `npm run build` first. It is not restarted after a crash. Details: `docs/service.md`.

To see every file and command it would use, without changing anything:

```sh
npm run service:install -- --dry-run
```

To install it and start Switchboard now:

```sh
npm run service:install -- --start
```

To remove it:

```sh
npm run service:uninstall
```

## Developing
- **Stack:** one Node.js project, TypeScript strict, **Fastify**, React + **Vite**, Server-Sent Events on `/hub`, the built-in **`node:sqlite`** with plain SQL migrations. Node runs the TypeScript directly, so only erasable syntax: no `enum`, no `namespace`, no parameter properties.
- **Layout:** `src/core/` shared types (`api.ts` is the API contract) and pure rules; `src/server/` the Fastify app, the CLI supervisor, stores, services and routes; `src/web/` the React UI; `tools/` fake CLIs, the frame helper, release / service / screenshot scripts; `tests/` Vitest unit and integration, Playwright e2e and visual oracle; `docs/` one doc per area, the decisions log, the handoff spec.
- **Scripts:** `npm run dev` rebuilds the UI on change and restarts the server (no HMR: reload the browser); `npm run typecheck`, `npm test`, `npm run e2e`; `npm run screenshots`, `npm run icons`, `npm run release:package`. The full list: `docs/configuration.md` → *npm scripts*.
- **Fakes:** tests never call the real `claude`, `codex`, `opencode`, `gh` or `tailscale`; `tools/fake-*` stand in for them (`docs/fake-claude.md`, `docs/providers.md`). Tests start their own server on a test port (`SWITCHBOARD_TEST_PORTS`, default 4871–4879; 13001 is refused) with a temporary data folder, and build the E2E UI into `.e2e-dist/web`. The only real-CLI checks are manual and bounded (`docs/smoke-real-cli.md`).
- **Visual oracle:** every view is compared with the handoff prototype (`docs/handoff/`) on SPEC tokens, box positions and exact copy (`docs/visual/README.md`). Demo mode seeds data for screenshots (`docs/demo.md`).
- **How changes are made:** the spec is the handoff plus `docs/decisions.md`; API changes are additive and noted in `docs/handoff/contracts/local-api.md`; features are built in git worktrees under `.worktrees/`; done means `npm run typecheck`, `npm test` and `npm run e2e` green with docs updated.

## Troubleshooting

| Symptom | Fix |
|---|---|
| A pasted command fails with `command not found: #` | An older copy of the instructions had comments, which macOS zsh doesn't accept by default. Copy the blocks from the README or this page again. |
| The UI looks old after an update | Release installs ship the built UI: reload the page. A git checkout: `npm run build`, then restart Switchboard. |
| `401 unauthorized` / blank data | Open `http://127.0.0.1:13001` by typing it (or a bookmark). Links from other sites don't get the cookie. |
| `listen EADDRINUSE … 127.0.0.1:13001` on start | Another Switchboard (or another app) holds the port: stop it, or set `SWITCHBOARD_PORT`. |
| Setup wizard says "Not signed in" | Run `claude` in a terminal and sign in; check `claude auth status`. |
| Remote toggle is disabled | Its tooltip says why. Usually the process isn't live yet, or the CLI isn't signed in with a claude.ai subscription (no `ANTHROPIC_API_KEY` in Switchboard's environment). |
| An embedded site "needs the Switchboard frame helper" | Click **Set up frame helper** and follow the steps (`docs/frame-helper.md`); after an update press reload on it in `chrome://extensions`. |
| A tool "refuses to load in a frame" in Safari | Expected: Safari can't lift framing headers. Use Open in new tab, or Chrome. |
| A session looks stuck | The chat line shows what it's doing. "⏳ Waiting for …" means a background task is still running. |
| A paired machine shows "unreachable" | It retries by itself every 15 s; **Reconnect now** tries at once. Check that the machine is awake and on Tailscale (`tailscale ping <machine>` says whether the path is direct or relayed). |
| A Codex / OpenCode session can't be chosen | **Settings → CLIs** says why (not installed, signed out). Install it, sign in, press **Check**. |
| An account isn't switched to | **Settings → Accounts**: it must be enabled, signed in and not marked spent; a pinned session never switches by itself. |
| A long message ends abruptly | Click **Show full message** under it (messages from before 1.3.2 were stored cut). |

## First-run setup wizard (M5.3)

The five-step wizard of SPEC → Modals → Setup wizard (prototype `mWizard` with `WZ`, `wzSteps`, `wzChecks`, `scan`, `notif`, `askNotif`, `wzNext`). Code:
- UI: `src/web/modals/SetupWizard.tsx` (the component), `src/web/modals/setup-wizard.ts` (pure rules and copy), `src/web/modals/setup-wizard.css` (the prototype's inline styles as classes), `src/web/modals/FirstRunGate.tsx` (opens it on a first run; mounted in `Shell.tsx`).
- Server: `src/server/setup/service.ts` (`SetupService`), `src/server/api/setup.ts` (routes), `src/server/system/probe.ts` (`SystemProbe`, the real `GET /api/system`), `src/core/setup.ts` (shared rules: settings keys, router title, line count, threshold).

### When it opens
- **By itself** once per page load while the setup is not finished (`GET /api/setup` → `autoOpen`: no `setup.completedAt` and `SWITCHBOARD_SETUP_WIZARD` is not `off`) and no other modal is open.
- **Skip**, **Esc** (the global modal close) or any other close without Finish: the setup stays unfinished, and the tab remembers it (`sessionStorage` `switchboard.setupSkipped`), so it does not open by itself again in that tab. A new tab or window opens it again until it is finished. The prototype only stores "done" on Finish (`localStorage switchboard.setupDone`); Switchboard stores it in the service (settings table) instead, so it is per install, not per browser.
- **On demand**: `useModals().open('setup-wizard')` (Settings → Claude Code → "Run setup again", M8.2).
- No click outside closes it (as in the prototype).

### The steps
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

### Folders instead of a workspace root (D14)
There is no workspace root to configure and no workspace environment variable: every session picks a saved folder (`docs/folders.md`). The wizard's second step only offers to add the first folder, and it can be skipped; without a saved folder the scan step, the Solutions view and `POST /api/sessions` answer `409 no-folder`. Sessions keep the folder they started in (`root`, `cwd`), whatever happens to the saved list later. A root the M5.3 wizard saved before D14 (`setup.workspaceRoot`) was migrated into the saved list as the default (`0003_folders.sql`).

### API (additive to the contract; behind the Host/Origin guard and the `sb_token` cookie)
| Method | Path | Returns |
|---|---|---|
| GET | `/api/setup` | `SetupState { completedAt, autoOpen, folders: Folder[], warnAtPct }` (D14: the saved folders, the default first) |
| GET | `/api/setup/folders?path=` | `FolderListing { path, parent, folders: [{ name, path }] }` (Browse…: the wizard, Settings → Folders → Add…, the New-session form): real subfolders only (no files, no hidden folders, no symlinks), sorted, at most 500; starts in the default folder, else the home folder; 404 `not-found`, 422 `invalid` |
| POST | `/api/setup/complete` | `SetupState` (stores `setup.completedAt`) |

Types live in `src/core/api.ts`. The folder check and the saved list are the `/api/folders` routes (`docs/folders.md`); the M5.3 routes `GET/PUT /api/setup/root` are gone (D14). Nothing here writes outside the settings table, and nothing is read below a listed folder.

### System (`GET /api/system`, contract)
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
- `power` (D125, `src/server/system/power.ts`): the power sampler's last reading (a laptop's battery, or an estimated total without one), omitted before the first sample; `docs/power.md`.
- Usage (`usagePct`, `usageResetsAt`, `usageWindows`, `usageWarnings`) is added by the meter in normal runs (`docs/usage.md`, M9.2 / D17); the probe itself reports none.
- An app built without a system provider answers `503 system-unavailable`; the route never runs a CLI of its own.

### Configuration
- `SWITCHBOARD_SETUP_WIZARD=off` stops the automatic opening (Run setup again still works). Any other value, or none, keeps it.
- Test servers (`tests/helpers/server-process.ts` → `testServerDefaults()`) default to the fake CLIs (`SWITCHBOARD_CLAUDE_BIN`, `SWITCHBOARD_GH_BIN`) and `SWITCHBOARD_SETUP_WIZARD=off`, so `/api/system` never runs the real `claude` or `gh` and the wizard does not cover the pages other specs drive. A spec can override each.

### Tests
- `tests/e2e/setup-wizard.spec.ts` (oracle, real path: fake-claude, fake gh, fixture workspace, no demo): the first run opens by itself and walks all five steps (checks, a refused folder, Browse… to the workspace, the folder added, the real scan, the mocked `Notification` asked and confirmed, the threshold, Back and the rail, Finish); the folder is used at once (a session's process runs there) and after a restart; signed-out rows with a folder saved already, Skip / Esc close it for the tab and a new tab opens it again.
- `tests/server/setup/setup.test.ts`: the service (state with the saved folders, Browse…, complete, `SWITCHBOARD_SETUP_WIZARD`), the routes behind the guard (the workspace-root routes gone), the first folder added through `POST /api/folders` reaching new sessions at once, `/api/system` with and without a provider. The folder kinds and routes: `tests/server/folders/folders.test.ts`.
- `tests/server/system/probe.test.ts`: the probe over the fakes (signed in / out, missing CLIs, cache + fresh + shared run, CPU, processes).
- `tests/web/setup-wizard.test.ts`: steps and texts against the prototype's `WZ`, rail, rows, the folder line (from a `FolderCheck`), scan rows, notification copy.
- `tests/e2e/visual/setup-wizard.spec.ts`: D10 on all five steps (`docs/visual/setup-wizard.md`).
