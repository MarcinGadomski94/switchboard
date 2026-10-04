# Changelog

## 1.6.0 (2026-10-04)

### Take over a session from another machine
- With paired Switchboards (Tailscale), a session can move between machines: **Take over to this machine** on a paired machine's session, or **Move to <machine> ▸** on a local one (session header or the sidebar row's ⋯ menu).
- The session stops on the source machine; its work travels through git (a temporary WIP branch pushed to the repo's remote, built without touching your branch, index or files) and is restored on the target exactly as uncommitted changes, on the same branch (worktrees are recreated). A repo the target doesn't have can be cloned from the dialog.
- The conversation is copied and resumed with its full context (Claude Code `--resume`; Codex its session file where possible; OpenCode a handover summary). The chat shows "Taken over from <machine>"; the source session becomes read-only with **Moved to <machine>**.
- Hooked terminal sessions can be taken over too, after confirming that the terminal's `claude` is stopped.
- Anything failing before the resume is rolled back on both machines; a temporary branch that couldn't be deleted is listed with a one-click delete.
- Both machines need 1.6.0.

### Fixed
- Accounts: the "resets 14:05" time in an account switch was formatted against the wall clock instead of the decision's time.

### Database
- Migration 0025 (where a session moved to / from) runs by itself on first start.

## 1.5.3 (2026-10-02)

### Added
- **Standing instruction for agents** (Settings → Sessions & worktrees): a short instruction Switchboard gives every session it starts or resumes, on by default. The default asks agents to write out a proposal, table, list or plan before asking a question about it, and never to refer to content "above" that they haven't written. Editable, can be switched off, and resettable. Claude Code receives it through `--append-system-prompt`; Codex and OpenCode through their own instruction fields (not yet tried against the real CLIs).

## 1.5.2 (2026-10-02)

### Changed
- **Question cards are compact again.** 1.5.1's change that listed each option's description under it (and option previews) is rolled back; descriptions are shown on hover, as before.

## 1.5.1 (2026-10-02)

### Fixed
- **Hooked terminal sessions stopped listening after ~10 minutes idle.** The waiting hook had no timeout, so Claude Code ended it after its 10-minute default and messages from the other machine waited until something was typed in the terminal. It now has a 7-day timeout and keeps retrying while Switchboard on that machine restarts. Existing hooks show as **outdated** in Settings → Machines: click **Update hooks** once per machine.
- **Question cards hid the agent's clarifications.** Each option's description was only a hover tooltip; it is now shown under the option, and an option's preview is shown too (chat and Inbox).
- Settings → Accounts: plain wording instead of an internal reference.

### Docs
- New README screenshots (Simple form, subfolders, MCP page, Accounts) and an Artifacts section.
- Switchboard is now **MIT licensed**.

## 1.5.0 (2026-10-01)

### Accounts and automatic switching
- **Settings → Accounts:** add more accounts (profiles) for Claude Code, Codex CLI and OpenCode, put them in priority order, and **sign in / sign out from the UI** (the sign-in opens in a new tab; device code for Codex, API keys for OpenCode providers that use them; paste-back for a paired machine). Each account can share the Default's settings, instructions and MCP servers; logins and conversations stay separate.
- **Automatic switching** when an account hits its session (5-hour) or weekly limit, or earlier at a threshold you set (98 % by default). Claude Code continues the **same conversation** on the next account; Codex the same where possible; OpenCode with a handover. After the reset: switch back or stay. When every account is spent: stop and notify, or hand over to another CLI.
- **Per session:** choose the account in both New-session forms; **Switch account** and **Pin** (never switch automatically) in the session header. The chat shows "Switched account: A → B (session limit, resets 14:05)".
- The footer shows the active account's bars and a compact line with every account's usage.
- Signing in runs each CLI's own login; Switchboard never sees or stores your tokens.

### Database
- Migration 0024 (accounts) runs by itself on first start; existing sessions stay on the Default account.

## 1.4.0 (2026-10-01)

### Codex CLI and OpenCode
- Sessions can run on **Claude Code**, **Codex CLI** or **OpenCode**. Settings → **CLIs** shows each one's command, version, sign-in and models (or how to install it); nothing needs to be installed until you choose it.
- Both New-session forms have a **CLI** choice; the model list follows it. Schedules remember their CLI.
- **Switch CLI mid-session** from the session header: the outgoing agent writes a handover when it still has capacity, otherwise the incoming agent reads the exported chat; the chat shows a divider. Switching back reopens that CLI's own earlier conversation.
- The sidebar footer's CLI menu sets the default for new sessions and **switches running sessions** in one go (pick which). Session rows show a CLI badge.
- Chat, tool steps, permissions (with the CLI's own "always" option), questions, Stop, pause/resume, models and effort, the context bar, subagents, worktrees, attachments, schedules and peers work for all three. Claude-only features (Workflow agents, Remote Control, teleport, hooks into terminal sessions, background tasks) are shown as not available, with the reason. The full matrix is in `docs/providers.md`.
- Built from the CLIs' documented protocols (Codex `rust-v0.159.3`, OpenCode `v1.18.34`) and not yet tried against the real tools: `docs/spike-providers.md` lists the checks to run once you install them.

### Fixed
- A paired machine that restarts its listener no longer stays "unreachable" for ~20 s (open connections are dropped at once).
- An OpenCode server is stopped even if Switchboard itself is killed.

### Database
- Migration 0023 (the session's CLI) runs by itself on first start; existing sessions stay on Claude Code.

## 1.3.2 (2026-10-01)

### Fixed
- **Long messages were cut off in the chat.** Agent messages, subagent briefs and workflow-agent chats were stored cut at 4,000 characters. They are now stored whole (up to a 1,000,000-character safety cap); tool inputs and outputs stay limited to 4,000. Messages already stored cut show **Show full message**, which restores them from Claude Code's transcript for good (a cut tool output offers **Show full output**).
- **Remote machines dropping offline.** A dropped connection to a paired machine now shows **Reconnecting…** (with the attempt and a countdown) for 20 seconds before it counts as unreachable; reads keep working and actions are held until it's back. Retries start at once and run at most 15 seconds apart (was 60); a stalled connection is detected and reconnected. **Reconnect now** in the session and in Settings → Machines tries at once; the status updates live; connection changes are written to the service log.

## 1.3.1 (2026-09-30)

### Fixed
- **Sidebar scrolling:** only the Sessions list scrolls now. The top (New session, navigation, Tools), the SESSIONS header and the bottom (Settings, usage footer) stay in place. Opening a session from anywhere scrolls its row into view; row menus near the bottom open upwards; dragging near the list's edge scrolls it; a long Tools list scrolls on its own.

## 1.3.0 (2026-09-30)

### Attachments
- Paste (⌘V / Ctrl+V), drag and drop, or 📎 attach images and files in the chat and in both New-session forms. Images (PNG, JPEG, GIF, WebP) and PDFs go into the message so the model sees them; other files are saved and the agent is given their paths. Thumbnails and file chips show in your messages and survive a reload; Stop returns them to the composer.
- Stored under `<data folder>/attachments/<session>/`, never in your repos, and cleaned up after 30 days. Limits: 20 MB per file, 50 MB / 20 files per message.

### MCP servers page
- A new **MCP** page lists the servers Claude Code loads for each saved folder (local, project and user scope), with status, tools and last check. **Check**, **Reconnect**, **Authenticate** (the sign-in opens in a new tab), **Enable/Disable**, and **Add / Edit / Remove** through the `claude mcp` commands. Secrets are never sent to the browser. Also for a paired machine's folders.

### Sidebar
- **Subfolders:** folders can hold folders, up to 5 levels, by drag and drop or the menus (**New subfolder**, **Move to folder ▸**).

### Sessions and folders
- **Simple mode starts in any folder**, including one that is neither a git repository nor has an `AGENTS.md`; such folders can be saved too.
- **Move to worktree on an existing branch:** the Solutions conflict card can put a session's worktree on an existing local or remote branch, not only a new one.

### Fixed
- Test servers no longer read the machine's real login-service files.

### Database
- Migrations 0020 (attachments), 0021 (subfolders) and 0022 (plain folders) run by themselves on the first start.

## 1.2.0 (2026-09-30)

### Simple New-session form
- **New session** opens a short form by default: folder, message, optional title, model and effort, and for a git repo an **own worktree** checkbox (the branch is a plain slug of the title, e.g. `sb/tidy-readme`, editable). **⌘↩ / Ctrl+↩** starts the session.
- A **Simple / Full** switch at the top of the dialog brings back the full form (workspace session-start answers, solutions, epic/task branching, schedules, moving in existing conversations). The last mode is remembered, and what you typed carries over.
- In a workspace folder, Simple sends only your message: the agent asks what the workspace needs.
- API: `POST /api/sessions` also accepts a simple start (`simple: true`).

### Docs
- The README lists the requirements and the install steps for macOS, Linux and Windows.

## 1.1.1 (2026-09-30)

### Fixed
- **1.1.0 did not start on an existing database** ("migration 2 (default_tools) was changed after it was applied"). A wording change in an old migration made its checksum differ from the one existing databases recorded. Switchboard now accepts that known earlier checksum; any other change to an applied migration is still refused. If 1.1.0 would not start for you, install 1.1.1 the same way (the updater can't reach it from a 1.1.0 that doesn't start).
- The Start-at-login preview of the macOS steps (`service:install` / `service:uninstall` with `--dry-run --platform darwin`) no longer crashes on a machine without a numeric user id (Windows); it shows `gui/<uid>`.
- The service tests pass on Windows.

## 1.1.0 (2026-09-30)

### Updates from GitHub releases
- Switchboard checks this repository's releases on start and every hour (Settings → Updates also has **Check for updates**). When a newer version exists, a banner and an Inbox item show **What's new** (the release notes) and **Update**.
- **Update** downloads the package, verifies its SHA-256 checksum, unpacks it safely next to the current version, installs its runtime dependencies (`npm ci --omit=dev`), points the login service at it and restarts. Live sessions resume after the restart, and the previous version is kept for a rollback. Details: [`docs/updates.md`](docs/updates.md).
- A git checkout is only told about the new release, with the commands to update it.
- `npm run release:package` builds a release package in the same layout for maintainers.

### README
- Screenshots of the app (taken from demo mode with `npm run screenshots`).
- A "Buy me a coffee" button.

### Other
- Example names in the demo data, prototype, docs and tests are neutral ("Acme", `PROJ-…` tickets); the prototype screenshots were retaken.

### Upgrading from 1.0.0
1.0.0 has no updater, so move to 1.1.0 once by hand: download `switchboard-1.1.0.tar.gz`, unpack it, run `npm ci --omit=dev` in it, and start it (or run `npm run service:install` there for Start at login). From 1.1.0 on, Switchboard updates itself.

## 1.0.0 (2026-09-30)

The first release. Switchboard is a local web app that runs and supervises your Claude Code sessions: every session is a real `claude` process, and Switchboard gives you one place to start, follow, answer and manage them. The design decisions behind each feature are in [`docs/decisions.md`](docs/decisions.md) (D1–D54).

### Sessions
- **New session form:** title, task, the workspace router's session-start answers, model and effort (the last choice is remembered), and optional worktrees with ticket branch names. You can leave the solutions empty and let the agent pick them.
- **Branching:** the epic/task model (`feature/<EPIC>-<Summary>` from `origin/dev`, task branches from the epic, bug fixes from `origin/master`), created and pushed lazily, with a per-repo preflight table. **Stacked tasks** cut a task from an unmerged parent task branch; the Inbox tells you when the parent PR merges or closes.
- **Continuing existing work:** move a terminal conversation in, attach to or hand off to a terminal, or pull a claude.ai/code session in as a local copy.
- **Chat:** Markdown, live activity ("Pondering… 1m 23s", "● Bash: npm test 0:42"), background work shown as working, question cards with your own answers, queued messages with a clock, **Stop** (■ / Esc) for the current turn and **Stop background tasks**.
- **Context bar** above the quick replies: fill level, compaction reset, auto-compact tick, the model's real window.
- **Right panel:** agent overview, agent cards, subagent chats, and **workflow agents** (orchestrator mode) with their own chats and **Resume run**.
- Tabs: Timeline, Diff, Artifacts. Loading placeholders and instant revisits when switching sessions.

### Organising
- Sidebar with **pinned sessions**, **folders** (drag and drop, collapsible) and loose sessions; the layout is saved and live across tabs.
- Collapsible sidebar and right panel (⌘B / ⌥⌘B), remembered.
- Inbox for every question, permission request and system item, with toasts and OS notifications.
- Solutions page, History, closing and reopening sessions, command palette (⌘K).

### Schedules and loops
- Cron schedules that start sessions from templates; observed `/loop`, `ScheduleWakeup`, `CronCreate` and Workflow runs, including loops in terminal sessions.

### Machines (peers)
- Pair Switchboards over Tailscale (a peer listener on the Tailscale IP only, per-pair tokens). A peer's sessions, Inbox, schedules and loops appear on your machine with full control, and you can start sessions and schedules on it.
- **Hook into** hand-started terminal sessions on any paired machine: live chat and activity, permission prompts (Allow once / Always allow / Deny with a message, plan approval, question cards) and replies from the other machine.
- Offline machines stay listed from a snapshot, read-only until they reconnect.

### Around the app
- Usage footer: RAM, the 5-hour Session and the Week bars, both paced by the minute.
- Embedded tools (local tools through a proxy; signed-in sites such as Jira through the Chrome frame helper).
- Remote Control: make a session reachable from claude.ai and the Claude mobile app.
- Restart recovery, "Start at login" service (launchd / systemd / Task Scheduler), installable as an app.

### Install
Download `switchboard-1.0.0.tar.gz` from the release, then:

```sh
tar -xzf switchboard-1.0.0.tar.gz
cd switchboard-1.0.0
npm ci --omit=dev   # runtime dependencies only; the UI is already built
npm start           # http://127.0.0.1:13001
```

Requirements: Node.js ≥ 24, git, the Claude Code CLI signed in with your claude.ai subscription; `gh` and Tailscale are optional. See the README.
