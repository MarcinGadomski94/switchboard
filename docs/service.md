# Per-user background service (M9.1)

Switchboard runs as **this user's** background service, started at sign-in, on macOS (launchd agent), Linux (systemd `--user` unit) and Windows (Task Scheduler logon task). The service is `node <repo>/src/server/main.ts` with the repo as its working folder: the same process as `npm start`, so `dist/web` must be built (`npm run build`). It needs **Node.js ≥ 24 on PATH** (type stripping); the absolute path of that `node` goes into the definition.

Two ways to set it up, same files:
- **Settings → Claude Code → Start at login** (the toggle, below).
- **`npm run service:install` / `npm run service:uninstall`** from a terminal, with `--dry-run` to see everything first.

Per D12, nothing was installed on the development machine: the files are verified by unit tests and dry runs, every test that "installs" writes to a temp home and talks to a fake service manager, and the CI workflow is written but not run.

## The files (`src/core/service-files.ts`, pure)
| OS | Manager | Definition | Registered by | Output |
|---|---|---|---|---|
| macOS | launchd | `~/Library/LaunchAgents/local.switchboard.plist` | the file itself (launchd loads `~/Library/LaunchAgents` at login) | `<dataDir>/logs/service.log` (stdout + stderr) |
| Linux | systemd `--user` | `$XDG_CONFIG_HOME/systemd/user/switchboard.service` (default `~/.config/…`) | `systemctl --user daemon-reload` + `enable switchboard.service` | the journal (`journalctl --user -u switchboard`) |
| Windows | Task Scheduler | `<dataDir>\service\switchboard-task.xml` (UTF-16 LE + BOM, what `schtasks /XML` expects) + `<dataDir>\service\switchboard.env` | `schtasks /Create /TN Switchboard /XML <xml> /F` | none |

`<dataDir>` is the service's data folder (`docs/configuration.md`: `~/Library/Application Support/Switchboard`, `%LOCALAPPDATA%\Switchboard`, …). A definition file existing = "Start at login" is on.

What each one says:
- **launchd:** `ProgramArguments` = [node, main.ts], `WorkingDirectory` = the repo, `EnvironmentVariables` = PATH + the carried variables, `RunAtLoad` true, `KeepAlive` false, both output paths → the log file.
- **systemd:** `Type=simple`, `WorkingDirectory`, one `Environment="KEY=value"` per variable, `ExecStart=<node> <main.ts>`, `KillMode=mixed` (SIGTERM to the service only, so it pauses its `claude` children itself per D7 before anything left is killed), `Restart=no`, `WantedBy=default.target` (starts with the user's session). Values are escaped for systemd: `%` → `%%`, `$` → `$$` in `ExecStart`, quotes with `\\` / `\"` where needed; a newline in a value is refused.
- **Task Scheduler:** a `LogonTrigger` for `USERDOMAIN\USERNAME`, principal = that user's `InteractiveToken` at `LeastPrivilege`, one instance (`IgnoreNew`), no time limit (`PT0S`), runs on battery, `node.exe --env-file=<…\switchboard.env> <main.ts>` with the arguments quoted the way `CommandLineToArgvW` splits them. Task Scheduler cannot set environment variables, so the `SWITCHBOARD_*` values go through Node's `--env-file` (each value in the first quote Node takes literally: `'`, `` ` ``, then `"`); the user's own PATH applies at logon.

**Not restarted automatically** on any OS (`KeepAlive` false, `Restart=no`, no `RestartOnFailure`): every service start resumes the sessions that were live and sends them "Switchboard restarted. Continue." (M2.4), so a crash loop would do that over and over. It starts once per sign-in.

**Windows console window:** the logon task runs `node.exe` under the user's interactive token, so Windows shows its console window; closing it stops the service. Hiding it would need a launcher outside this project (a Windows Service or a hidden-window wrapper) and is left for later (`.loop/questions.md`).

### Environment (`carriedEnvironment`, `src/server/service/target.ts`)
The service starts with the configuration it was installed from: `SWITCHBOARD_PORT`, `SWITCHBOARD_DATA_DIR`, `SWITCHBOARD_CLAUDE_BIN` and `SWITCHBOARD_GH_BIN` when they differ from the defaults. There is no workspace variable (D14): the saved folders are in the database of that data folder (`docs/folders.md`). Never the dev-only `SWITCHBOARD_CLAUDE_EXTRA_ARGS`, `SWITCHBOARD_DEMO` or the test redirects. launchd and systemd do not give a service the login shell's PATH, so the PATH of the installing process is written in as well (the service finds `claude`, `git` and `gh` there), cleaned by `cleanSearchPath`: absolute folders only, each once, and without the folders npm prepends while it runs a script (every `node_modules/.bin` up the tree and npm's `node-gyp-bin`), since the service is usually installed from `npm start` or `npm run service:install`. `node` is looked up on that same cleaned PATH. To change any of it, change the environment and turn "Start at login" on again (or run the install script again): the files are rewritten.

## The toggle (`GET/PUT /api/service`, `LoginService`)
Additive to the contract: the setting's effect is an OS service definition with refusals of its own, so it has its own route next to the contract's (`src/server/api/service.ts`, `src/core/login-service.ts`):
- `GET /api/service` → `{ manager: "launchd" | "systemd" | "task-scheduler" | null, startAtLogin, file }` (`manager: null` = unsupported OS).
- `PUT /api/service { startAtLogin: boolean }` → the new status; a body without a boolean → `422 {error:"invalid", errors:[{field:"startAtLogin", …}]}`; a refusal → `409 { error, message }` with `error` = `unsupported`, `node-missing`, `node-too-old`, `command-failed` or `file-failed`.
- Without a `loginService` provider both answer `501 {error:"not-implemented", item:"M9.1"}`, so an app built bare in a test can never touch the OS.

`LoginService` (`src/server/service/login-service.ts`, `providers.loginService`, wired in `main.ts`):
- **On:** checks `node` on PATH (first executable match; `PATHEXT` on Windows; `<node> --version` ≥ 24), writes the files and registers them **for the next sign-in**. It never starts a second instance now: the service answering the toggle is already running and holds the port.
- **Off:** unregisters and removes the files (`systemctl --user disable`, `schtasks /Delete` when `/Query` finds the task). It never stops the running service, which may be the one answering. Off when nothing is registered runs nothing.
- The state is the definition file's existence; after every change it is mirrored into the settings key `service.startAtLogin` (read by M8.2's `GET /api/settings`). Changes run one at a time. When a manager command fails, the files written by that change are put back as they were (`executePlan`, `src/server/service/executor.ts`), so a failed "on" leaves it off.
- **Demo** (`SWITCHBOARD_DEMO=1`): `src/server/demo/login-service.ts`, an in-memory flag that starts **on** (the prototype's "Start at login · on") and never touches the OS.

The UI (`src/web/views/settings/StartAtLogin.tsx`, `start-at-login.ts`, `start-at-login.css`): `StartAtLoginToggle` is the value, `on` / `off` in the prototype's value style (Geist Mono 12px, #c9c8c3), a `role="switch"` button that flips it (`PUT`); while the status loads it reads `…`, and `unavailable` (501), `unknown` (other load error) or `not supported` cannot be clicked. A refusal shows the service's message in red under the value; the value stays as it was. The hover title names the registered file. `StartAtLoginRow` is the whole prototype row (label "Start at login", description "Launch the service when you sign in (Windows / macOS)", verbatim). Until M8.2's Settings view is merged, the M1.4 placeholder `SettingsView` shows only this row on the Claude Code section (`/settings`, `/settings/claude`). **At the M8.2 merge:** take the lane's `SettingsView.tsx`, and in its `ClaudeSection` (`views/settings/sections.tsx`) replace the `start-at-login` row's `<Value>{onOff(settings['service.startAtLogin'])}</Value>` with `<StartAtLoginToggle />`; the lane's `service.startAtLogin` stays read-only in `PUT /api/settings` (this route writes it).

## Install scripts (`tools/service/*.ts`)
```
npm run service:install   -- [--dry-run] [--start] [--platform darwin|linux|win32]
npm run service:uninstall -- [--dry-run] [--platform darwin|linux|win32]
```
They read the same `SWITCHBOARD_*` variables as `npm start` (`loadConfig`), so the service gets the configuration of the shell you install from. `install` checks Node ≥ 24 on PATH, warns when `dist/web` is not built, writes and registers the files; `--start` also starts it now (launchd: `bootout` if loaded, then `bootstrap gui/<uid> <plist>`; systemd: `restart`; Windows: `schtasks /Run`). `uninstall` stops a service its manager runs (`launchctl bootout` when `print` finds the job, `systemctl --user disable --now`, `schtasks /End` when `/Query` finds the task), then unregisters and removes the files; "Nothing to do." when nothing is installed.

`--dry-run` prints the manager, the `node` found, the definition path and whether it is installed, then every step, with each file in full (`| ` lines) and each command as it would run; it writes, creates and runs nothing (only `node --version`). `--platform` previews another OS's files and steps with this machine's paths (`--dry-run` only). Exit codes: 0 done, 1 refused or failed, 2 bad usage.

## Test redirects and the fake manager
Two variables, **tests / development only**, read by `loadServiceRedirect` (`src/server/service/target.ts`) in `main.ts` and the scripts:

| Variable | Effect |
|---|---|
| `SWITCHBOARD_SERVICE_HOME` | Absolute folder used instead of the real home for the service files (`XDG_CONFIG_HOME` is then ignored). |
| `SWITCHBOARD_SERVICE_CTL` | The service manager as an argv prefix (JSON array like `SWITCHBOARD_GH_BIN`), replacing launchctl / systemctl / schtasks. |

They must be set **together** (else startup / the script exits 1 with a message), so a test can never write fake files and register them with the real manager, or the other way round. `tools/fake-servicectl` is that manager: exit 0 for everything, `FAKE_SERVICECTL_FAIL=<text>` fails every call whose arguments contain the text, `FAKE_SERVICECTL_LOG=<file>` logs `{"argv":[…]}` per call (`fakeServiceCtlEnv()` in `tools/fake-servicectl/command.ts`).

## Tests (the M9.1 oracle)
- `tests/core/service-files.test.ts`: the exact plist and unit, the task XML (logon trigger, principal, settings, command + quoted arguments, CRLF, UTF-16 BOM bytes), paths per OS, escaping round trips (systemd words, Windows argv against a `CommandLineToArgvW` splitter), env-file quoting, every plan's steps, the dry-run text. Read back by the platform's own parsers where this machine has them: `plutil -lint` + `plutil -convert json` (macOS), `xmllint` on the UTF-16 task XML, and `node --env-file` on the env file.
- `tests/server/service/*.test.ts`: `findOnPath` / `checkNode` (a real `node --version` too), `LoginService` on all three platforms against a temp home with the fake manager (files, commands, rollback on a failed `/Create`, `/Query` skip, node missing, unsupported, one change at a time), `carriedEnvironment`, the redirect rules, `createLoginService`, the demo flag.
- `tests/server/api/service.test.ts`: the routes (200 / 422 / 409 / 501 / guard) through the real `LoginService`.
- `tests/tools/service-cli.test.ts`: `--dry-run` of install (with `--start`) and uninstall for every platform leaves the temp folders empty; real runs against the temp home and the fake (install, `--start`, uninstall, "Nothing to do."), Node missing, usage errors.
- `tests/web/start-at-login.test.ts`: the value's states and copy.
- `tests/e2e/start-at-login.spec.ts` (real path, D13): the toggle on → file in the temp home → reload still on → off → file gone; the refusal line with no `node` on the server's PATH. `tests/e2e/visual/start-at-login.spec.ts`: the row against the prototype (`docs/visual/start-at-login.md`).

## CI (`.github/workflows/service.yml`, not run)
A matrix over `macos-latest`, `ubuntu-latest`, `windows-latest` on Node 24: `npm ci`, typecheck, the service unit tests, both dry runs on the runner's real home, then install into a temp home with the fake manager and check the file with the OS's own tool: `plutil -lint` (macOS), `systemd-analyze verify` (Linux); on Windows the task XML is registered, read back and deleted under the CI-only name `SwitchboardCI` on the throwaway runner.
