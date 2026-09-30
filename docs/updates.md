# Updates from GitHub releases (D55)

Switchboard checks the GitHub releases of its repository, tells the developer when a newer version exists and, for a **release install**, updates itself: download, SHA-256 check, unpack, `npm ci --omit=dev`, switch, restart. A **git checkout** is only told (with the git commands). Ruling: `docs/decisions.md` → D55. Code: `src/server/updates/*`, `src/core/updates.ts`, `src/core/semver.ts`, `src/core/release.ts`, `src/web/updates/*`.

## Install kinds
| Kind | How it is recognised | What the updater does |
|---|---|---|
| **git checkout** | the install folder holds `.git` (a folder, or the file of a worktree) | checks and notifies only: the banner, the Inbox item, Settings → Updates with the release notes and the commands (`git fetch --tags origin`, `git merge --ff-only v<version>` or `git pull --ff-only`, `npm ci`, `npm run build`, then restart). No Update button. |
| **release install** | no `.git`: unpacked from a release tarball | the full update below. |

The install folder is the folder of the running code (`APP_DIR`, the service's working folder). The developer's Mac runs from a git checkout, so it only gets notices.

## Checking
- **When:** once right after start (after the port is bound), then **every hour**, and on **Check for updates** (Settings → Updates). Checks never overlap; the hourly one is skipped while an update runs.
- **Where:** the repository in `RELEASE_REPO` (`src/core/release.ts`, `MarcinGadomski94/switchboard`), overridable with `SWITCHBOARD_UPDATE_REPO` (forks).
  1. The **public REST API, unauthenticated**: `GET https://api.github.com/repos/<repo>/releases/latest` with `Accept: application/vnd.github+json`, a `User-Agent: switchboard/<version>` and no credential of any kind. This is the primary path (the repository is public). `releases/latest` never returns drafts or pre-releases; a draft, a pre-release or a tag with a pre-release part is ignored anyway.
  2. When the API answers **401, 403, 404 or 429** (a private repository, a rate limit: 60 unauthenticated requests an hour per IP), **`gh`** is asked instead (`SWITCHBOARD_GH_BIN`): `gh release view --repo <repo> --json tagName,name,body,assets,publishedAt,isDraft,isPrerelease,url`. gh uses its own sign-in; Switchboard never reads or passes a token. "release not found" = no release yet.
  3. Otherwise the check fails with a line the UI shows as it is: `Can't reach releases: GitHub answered HTTP 500.`, `Can't reach releases: GitHub answered 404 (a private repository, or no release yet), and gh is not installed.`, `… and gh failed: <gh's text>.`, `Can't reach releases: <network error>.` The last good release stays known.
- **Compare:** the tag (`v1.1.0` or `1.1.0`) is parsed as semver (`src/core/semver.ts`) and compared with `package.json`'s version of the running install; only a newer **release** (no pre-release part) is an update. A tag that is not a version is an error.
- **Stored:** the settings key `updates.state` holds the last check (time, ok, via `api` / `gh`, the error), the latest release (version, tag, name, notes, published time, page) and the version whose banner was dismissed. It is not a known setting (`GET /api/settings` does not show it). No migration.

## The UI
- **Banner** (`src/web/updates/UpdateBanner.tsx`): a slim bar at the top center: "Switchboard 1.1.0 is available" · **What's new** · **Update** (release installs) · ×. × hides that version's banner on every tab and after restarts (`POST /api/updates/dismiss`); a newer release shows again. While an update runs the bar shows its step ("Installing dependencies (npm ci --omit=dev)…"), then "Restarting into 1.1.0…"; after the restart a page loaded before it reads "Switchboard was updated to 1.1.0" · **Reload**. A failed update shows its reason (× hides it on this page).
- **What's new** (`UpdateDialog.tsx`, the `update` modal): the release title, "You run 1.0.0 · release install", the notes as GitHub-flavored Markdown (the chat's renderer, D20: no raw HTML, no images, http(s) / mailto links only, new tab), a link to the release page; for a git checkout the commands; for a release install **Update to 1.1.0** → the confirmation: "Switchboard downloads 1.1.0, checks its SHA-256 checksum, installs its dependencies and switches to it; this install stays for a rollback. Then it restarts through its login service." plus "N sessions will be resumed after the restart." (the sessions with a live process now); without the login service the text says the developer restarts it. **Update and restart** starts it; the dialog then shows the progress and cannot be closed until the update ends.
- **Inbox item** (`update-available`, `src/server/inbox/system-items.ts`): "Switchboard 1.1.0 is available", source `switchboard`, a detail that says what happens for this install kind, actions **What's new** (closes it and opens Settings → Updates) and **Dismiss**. One item per version (a dismissed one never comes back); a newer release closes the older item (`superseded`); a start on that version or a newer one closes it (`updated`). A paired machine's item shows in the proxied Inbox too; its What's new only closes it (its updates are that machine's).
- **Settings → Updates** (`UpdatesSection.tsx`, `/settings/updates`): Version, Install (kind + folder), Last check (time + "GitHub API" / "through gh" / "failed"), Latest release, Restart (automatic / by hand and why), Previous version (the rollback folder, once there is one); **Check for updates**, **Update to 1.1.0…** (release installs), the git commands (git checkouts), the release notes, and an error line for a failed check or update. With the updater off (the demo, `SWITCHBOARD_UPDATES=off`): "Updates are off here".
- **Live:** `updateChanged` (additive `/hub` event, the whole `UpdateStatus`) on every change; a tab also reloads the status whenever its `/hub` stream (re)opens. Not forwarded to peers.

## The update (release installs)
One update at a time (a second **Update** answers 409 `busy`); refused while a check runs (`checking`), for a git checkout (`git-checkout`), without a newer release (`no-update`) or for another version than the latest (`stale-version`). Every step before the switch leaves the running install exactly as it was; a failure is shown with its reason and can be retried.

1. **Download** (`github.ts`) into `<dataDir>/updates/downloads/<v>-<id>/`: the checksum asset `switchboard-<v>.tar.gz.sha256` **must exist** (else refused: no unverified package is installed), then `switchboard-<v>.tar.gz`. Through the API path: only the asset's `browser_download_url`, which must be exactly `https://github.com/<repo>/releases/download/<tag>/<name>`; redirects are followed by hand (at most 5) and only to GitHub's asset hosts (`github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `github-releases.githubusercontent.com`) over HTTPS; the size is limited (tarball 200 MiB, checksum 4 KiB) by the listed size, `Content-Length` and while streaming. Through gh (when the check went through gh): `gh release download <tag> --repo <repo> --pattern <name> --dir <dir> --clobber`, with the same size limits checked before and after.
2. **Verify:** the `.sha256` must be one line `<64 hex>  switchboard-<v>.tar.gz` (the `sha256sum` format; `*` binary marker accepted) naming exactly the tarball; the tarball's SHA-256 must match. A mismatch is refused before anything is unpacked.
3. **Unpack** (`extract.ts`, `tar.ts`) into a fresh `<dataDir>/updates/staging/<v>-<id>/`, with Node's own zlib and a small pure tar reader (no system `tar`, so it works on Windows). Every entry must be under `switchboard-<v>/`; refused: absolute paths, drive letters, `..`, backslashes, colons, NULs, Windows device names and trailing dots / spaces, any **link** (symbolic or hard: a release has none, and links are how archives escape their folder), special files, duplicates (files are created with `wx`); at most 512 MiB and 50 000 entries; header checksums are verified. The executable bit is kept on macOS / Linux. Then the package must say `version` = `<v>` and hold `src/server/main.ts` and `dist/web/index.html`.
4. **Install:** `npm ci --omit=dev --no-audit --no-fund` in the staged folder (`npm.ts`): npm runs as `node <npm-cli.js>` (found through `npm_execpath`, next to `node`: `<node dir>\node_modules\npm\bin\npm-cli.js` on Windows, `<prefix>/lib/node_modules/npm/bin/npm-cli.js` elsewhere; plain `npm` as a last resort on macOS / Linux; `SWITCHBOARD_NPM_BIN` overrides), because Windows' `npm.cmd` cannot be spawned without a shell. The parent `npm start`'s `npm_*` variables are not passed on. 15-minute limit. A failure (network, registry) removes the staging folder; nothing else changed.
5. **Switch:** the staged `switchboard-<v>` folder is renamed to `<dataDir>/versions/<v>` (same volume: one rename; retried on Windows' transient EPERM / EBUSY), then the **login service's definition is registered again for that folder** (`LoginService.pointTo`: the plist / unit / task with `WorkingDirectory` and `<versions>/<v>/src/server/main.ts`; systemd `daemon-reload` + `enable`, Task Scheduler `/Create … /F`), when this process runs as the login service or "Start at login" is on. A refused registration puts the files back (as M9.1's toggle does) and fails the update. `<dataDir>/updates/installs.json` records `current` (the new version) and `previous` (the running one, e.g. the folder the first release was unpacked into).
6. **Restart** (below), or "Switchboard 1.1.0 is installed. Restart Switchboard to use it." with `cd "<dataDir>/versions/1.1.0" && npm start` when it does not run as the login service.

**Never touched:** the database and everything else in the data folder (migrations run on the new version's start, as on every start), and the running install's folder. Nothing from the package is executed but `npm ci --omit=dev` (its dependencies' own install scripts, as for a manual install) and the new server when the login service starts it.

## Install layout (ASSUMED D55-layout)
```
<dataDir>/
  switchboard.db, sb_token, …          untouched
  versions/<v>/                        one folder per updated-to version (the service points at one)
  updates/installs.json                { current: {version, dir}, previous: {version, dir} }
  updates/downloads/, updates/staging/ only during an update (cleared at start)
  logs/update.log                      the restart helper's log
```
Versions live side by side and the **login service's definition is the stable pointer**: it names the folder the next start uses, so the switch is one re-registration and a rollback is another. At every start the updater removes leftovers of an interrupted update and every `versions/*` folder that is neither the running one nor `previous` (only when the running install is itself one of `versions/*`; the folder the first release was unpacked into is never removed).

## Restarting
None of the login services restarts Switchboard when it exits (M9.1: `KeepAlive` false, `Restart=no`, no `RestartOnFailure`, so a crash loop cannot resume the sessions over and over; `docs/service.md` → *Restart after an update*). So the updater asks the manager for exactly one start of the new definition (`restart.ts`):

| OS | Is this process the service's? | Restart |
|---|---|---|
| macOS (launchd) | launchd set `XPC_SERVICE_NAME=local.switchboard` | launchd keeps the definition it loaded, so a **detached helper** (`relaunch.ts`, from the running install, in its own session) waits for this process to exit, then `launchctl bootout gui/<uid>/local.switchboard` and `launchctl bootstrap gui/<uid> <plist>` (RunAtLoad starts the new version); this process then shuts down the normal way (like SIGTERM: sessions paused for recovery) and exits 0. |
| Linux (systemd `--user`) | `INVOCATION_ID` is set and the unit's `MainPID` is this process | `systemctl --user restart --no-block switchboard.service`: systemd stops this process (SIGTERM, the normal shutdown) and starts the new unit. If nothing happens within 60 s the update reports it. |
| Windows (Task Scheduler) | started with the task's `--env-file=<dataDir>\service\switchboard.env` | the task was re-created for the new folder; a **detached helper** (hidden window) waits for this process to exit, then `schtasks /Run /TN Switchboard` (one instance at a time, so it starts only once this one ended); this process shuts down the normal way and exits. |
| `npm start` by hand (any OS) | none of the above | never exits: "restart Switchboard yourself", with the command for the new folder. |

The helper retries its last command 5 times (2 s apart) and logs to `<dataDir>/logs/update.log`. Live sessions resume through the existing restart recovery (`docs/supervisor.md` → *Restart recovery*: sessions that were running get "Switchboard restarted. Continue.").

## Rollback
The previous install stays (Settings → Updates → Previous version shows its folder). To go back:
```sh
cd "<previous folder>"          # e.g. ~/Library/Application Support/Switchboard/versions/1.1.0, or where 1.0.0 was unpacked
npm run service:install -- --start   # points Start at login at this folder and starts it (launchd / systemd / schtasks)
# or, without the login service: stop Switchboard, then  npm start  in that folder
```
A rollback over a version that added a **database migration** is refused at start ("the database has migration … which this build does not know; it was made by a newer Switchboard", M1.3): check `docs/database.md` of the newer version; going back then needs the database of before the update (Switchboard keeps no copy of it; ASSUMED D55-no-db-backup).

## Release packages
The updater accepts exactly the layout of 1.0.0 (`src/core/release.ts`): assets `switchboard-<v>.tar.gz` and `switchboard-<v>.tar.gz.sha256` (`<sha256>  switchboard-<v>.tar.gz`), the tarball a ustar archive whose every entry sits under `switchboard-<v>/`: the `git archive` of the release commit **without** `tests/`, `.loop/`, `docs/visual/`, `playwright.config.ts`, `vitest.config.ts`, `tsconfig.e2e.json`, **plus** the built UI in `dist/web`. Installs run `npm ci --omit=dev && npm start`.

`npm run release:package -- [--ref <ref>] [--out <folder>] [--skip-build] [--allow-dirty]` (`tools/release/package.ts`) writes both files into `dist/release/`: it refuses a dirty tree (unless `--allow-dirty`), builds the UI (`vite build`, unless `--skip-build`), reads `git archive --format=tar <ref>` (default `HEAD`) with the same tar reader, drops the excluded paths, adds `dist/web`, writes the gzip'd tar with the same writer (long paths through ustar's prefix or a pax header) and the checksum; the version is `package.json`'s. It warns when the tag `v<version>` is missing or not the ref. Then publish:
```sh
npm version <x.y.z> --no-git-tag-version   # bump package.json + lock, add the CHANGELOG entry, commit, push
npm run release:package
gh release create v<x.y.z> dist/release/switchboard-<x.y.z>.tar.gz dist/release/switchboard-<x.y.z>.tar.gz.sha256 \
  --title "Switchboard <x.y.z>" --notes-file <notes.md>
```
The release notes (the body) are what "What's new" shows. Never mark an installable release as a pre-release or draft: the updater ignores those.

## Configuration
| Variable | Default | What |
|---|---|---|
| `SWITCHBOARD_UPDATES` | `on` | `off` switches checking and updating off (the routes answer 501; no banner). |
| `SWITCHBOARD_UPDATE_REPO` | `MarcinGadomski94/switchboard` | `owner/name` of the releases (forks). |
| `SWITCHBOARD_NPM_BIN` | npm next to node | The npm of `npm ci` as an argv prefix (like `SWITCHBOARD_GH_BIN`). |
| `SWITCHBOARD_UPDATE_API` | none | **Tests only:** `http://127.0.0.1:<port>` of a fake GitHub; the API and every download must then come from that origin. |
| `SWITCHBOARD_UPDATE_TEST_INSTALL` | none | **Tests only**, needs `SWITCHBOARD_UPDATE_API`: `release` / `git` instead of looking for `.git`. |
| `SWITCHBOARD_UPDATE_TEST_UNDER_SERVICE` | none | **Tests only**, needs `SWITCHBOARD_UPDATE_API` and the service redirect (`SWITCHBOARD_SERVICE_HOME` + `SWITCHBOARD_SERVICE_CTL`): `1` acts as if this process were the login service's. |

Demo mode never runs the updater. Every test server gets `SWITCHBOARD_UPDATES=off` (`testServerDefaults()`), so no test ever asks the real GitHub.

## API (additive)
`GET /api/updates` → `UpdateStatus`; `POST /api/updates/check` → `UpdateStatus`; `POST /api/updates/install { version }` → `202 UpdateStatus` (409 `busy` / `checking` / `git-checkout` / `no-update` / `stale-version`, 422 without a version); `POST /api/updates/dismiss { version }` → `UpdateStatus`. 501 `{ error: "not-implemented", item: "D55" }` without an updater. `/hub` `updateChanged`. Not on the peer API. Contract note: `docs/handoff/contracts/local-api.md` → *Updates from GitHub releases (D55)*.

## Tests
- Unit: `tests/core/semver.test.ts`, `tests/core/release.test.ts`, `tests/server/updates/tar.test.ts` (round trips, ustar prefix, pax, GNU long names, bad checksums, truncation), `tests/server/updates/extract.test.ts` (traversal, absolute paths, other prefixes, symlinks and hard links, duplicates, FIFOs, limits, not-gzip), `tests/server/updates/setup.test.ts` (configuration, install kind, ledger, npm resolution and environment, `LoginService.pointTo`), `tests/web/updates.test.ts` (banner, copy, Settings rows, the Inbox route).
- Against a fake GitHub (`tests/helpers/fake-github.ts`: a loopback server for `releases/latest` and the assets, with a CDN-like redirect) and `tools/fake-gh` (`release view` / `release download` from `FAKE_GH_RELEASE` / `FAKE_GH_RELEASE_DIR`): `tests/server/updates/github.test.ts` (API, drafts / pre-releases, 401 / 403 / 404 / 429 → gh, missing gh, redirects, foreign asset URLs, size limits, gh downloads) and `tests/server/updates/service.test.ts` (newer / older / same, the Inbox item once, superseded, closed at start, a failed check, the full update with `tools/fake-npm`, manual restart, checksum mismatch, missing checksum, wrong version, no UI, traversal, npm ci failure, a refused service registration: the running install untouched; refusals; pruning).
- `tests/server/updates/restart.test.ts`: the service detection per OS, the manager commands, and the real helper waiting for a process and running `tools/fake-servicectl`.
- `tests/server/api/updates.test.ts`: the routes (200 / 202 / 409 / 422 / 501 / guard).
- `tests/tools/release-package.test.ts`: `packageRelease` on a temp git repo, read back with the updater's extraction and checksum parser.
- E2E `tests/e2e/updates.spec.ts`: a release install (banner → What's new with Markdown notes → Update → confirmation → the server exits 0; `versions/1.1.0` with the fake npm's marker, the ledger, the checksum downloaded first through the redirect, the plist / unit pointing at it, launchd's bootout + bootstrap by the helper), and a git checkout (no Update, the commands, the Inbox item → Settings → Updates, a failed check's error line, × remembered across a reload).
- `tools/fake-npm`: `npm ci` writes `node_modules/.fake-npm-ci`; `FAKE_NPM_FAIL`, `FAKE_NPM_LOG`.

**Unverified on Windows** (no Windows machine here): the extraction and paths are covered by unit tests with Windows rules, but the Task Scheduler re-registration while the task runs, the detached helper surviving the task's end and `schtasks /Run` after it, and npm through `npm-cli.js` next to `node.exe` were not run on Windows (`.loop/questions.md` → *D55*).
