# Privacy policy

Switchboard is a local app. It runs on your own machine, has no servers, no accounts and no telemetry, and its author receives no data from it.

## What it stores
Everything Switchboard keeps stays in its data folder on your machine: `~/Library/Application Support/Switchboard` (macOS), `~/.local/share/switchboard` (Linux), `%LOCALAPPDATA%\Switchboard` (Windows). That is its database (sessions, chat, todo lists, settings, usage readings), the access token for its own UI, attachments you add (kept 30 days), logs and downloaded updates. Deleting the folder removes all of it.

Switchboard never reads or stores your CLI logins: Claude Code, Codex CLI and OpenCode keep their own credentials, and Switchboard only starts the unmodified CLIs.

## What leaves your machine
- **GitHub, for updates.** Switchboard asks `api.github.com` for the latest release of `MarcinGadomski94/switchboard` and downloads release packages from GitHub (with the user agent `switchboard/<version>`). GitHub's own privacy statement applies. Turn this off with `SWITCHBOARD_UPDATES=off`.
- **The coding agents you run.** Claude Code, Codex CLI and OpenCode talk to their providers (Anthropic, OpenAI, or the provider you configure) under your own accounts, exactly as when you run them in a terminal. What they send is governed by those providers' terms and privacy policies.
- **Paired machines.** If you pair Switchboards (Settings → Machines), they talk to each other directly over your Tailscale network: session lists, chats, todo lists, the sidebar layout (when you turn on sharing) and taken-over conversations. Nothing goes through a third party other than Tailscale's network.
- **Tools you add.** Embedded tools and MCP servers you configure are contacted at the addresses you give them.

Switchboard's UI listens on `127.0.0.1` only. Its built-in `switchboard` MCP server (the todo tools) runs inside the sessions it starts and only talks to the local Switchboard.

## Contact
Questions: open an issue at https://github.com/MarcinGadomski94/switchboard/issues.
