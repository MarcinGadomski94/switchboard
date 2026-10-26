# @marcingadomski94/switchboard

Installs [Switchboard](https://github.com/MarcinGadomski94/switchboard), a local web app to run, supervise and switch many Claude Code, Codex CLI and OpenCode sessions at once.

```sh
npx @marcingadomski94/switchboard
```

This package is only the installer. It downloads the latest GitHub release of Switchboard and verifies its SHA-256 checksum. It unpacks the release into `~/Applications/Switchboard` (macOS), `~/.local/opt/switchboard` (Linux) or `%LOCALAPPDATA%\Programs\Switchboard` (Windows) and runs `npm ci --omit=dev`. It can register the login service, then starts Switchboard on http://127.0.0.1:13001. After that, Switchboard updates itself from Settings → Updates.

Options: `--dir <folder>`, `--version <x.y.z>`, `--service` / `--no-service`, `--no-start`, `--uninstall` (keeps your data), `--uninstall --purge` and `--help`. Running it again upgrades or repairs the install. It needs Node.js 24 or newer, never uses sudo, never edits shell profiles and sends no telemetry.

The same installer as a shell one-liner, and the manual steps, are in the [setup guide](https://github.com/MarcinGadomski94/switchboard/blob/master/docs/setup.md).
