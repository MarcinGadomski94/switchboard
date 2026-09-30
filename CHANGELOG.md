# Changelog

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
