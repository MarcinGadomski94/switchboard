# Changelog

## 1.11.0 (2026-10-08)

### Phones and tablets
- **Responsive layout:** every page and dialog adapts to phones and tablets (360 to 1279 px wide); the desktop layout (1280 px and up) is unchanged. A top bar with ☰, the page title and the Inbox count; the sidebar as a drawer; on phones the session's header actions in a ⋯ menu, tabs and quick replies scrolling on one line, the right panel as a bottom sheet, the message box pinned above the keyboard, dialogs as full-screen sheets, tables as cards, and Inbox / Solutions / Settings as a list, then the item.
- **Touch:** tap targets of at least 44 px, ⋯ menus always visible, a long press shows a control's tooltip, and **long-press drag** (hold 0.4 s) moves sessions into folders and re-orders them; a swipe still scrolls.
- **Devices (Settings → Devices, off by default):** reach Switchboard from your phone or tablet over Tailscale, with HTTPS through `tailscale serve` (port 8443 on your machine's `*.ts.net` name; needs MagicDNS and HTTPS certificates on in your tailnet). Pair each device with a QR code and a one-time code; each gets its own credential, revocable at once. Unpaired devices only see the pairing page. Machine-level actions (pairing, hooks, MCP servers, accounts, updates, folders, take-over…) stay on the computer: devices can only use what is explicitly allowed for them. `127.0.0.1` works exactly as before.
- **Notifications on paired devices:** permission requests, questions, finished turns and errors, per device and per kind, also for a paired machine's sessions. Encrypted end to end (Web Push); on iPhone and iPad add Switchboard to the Home Screen first. Install it as an app on iOS and Android from the same address.
- Not yet tried on a real phone or with real push services: `docs/devices.md` has a checklist.

### Fixed
- Tests: spawn expectations updated for the switchboard MCP flags added in 1.7.0.

### Database
- Migration 0030 (devices, pairing codes, push subscriptions) runs by itself on first start.

## 1.10.1 (2026-10-05)

### Changed
- The built-in `switchboard` MCP server (the todo tools) is now built on the official MCP TypeScript SDK (`McpServer.registerTool` with typed input schemas). Agents see the same six tools, fields, required fields, annotations and messages; a value of the wrong type (e.g. priority `asap`) now gets the SDK's "Input validation error". New runtime dependencies: `@modelcontextprotocol/sdk` and `zod` (downloaded once by the update).

### Fixed
- A todo card's ⋯ menu no longer loses keyboard focus in the Priority submenu when the session refreshes in the background.

## 1.10.0 (2026-10-05)

### Shared sidebar between paired machines
- **Share sidebar layout** (Settings → Machines, per machine, off by default): paired machines show the same pins, folders, subfolders and order. A session is the same item on both sides. Changes travel live, the later change wins when two collide, and a machine that was offline catches up when it reconnects. Sharing starts once both machines have it on; the first time, the two layouts are merged (same-named folders at the same level are combined). Collapsed folders stay per machine. A paired machine on an older version shows "Update <machine> to sync folders".
- **Sessions outside folders can be re-ordered** by drag or ⋯ Move up / down. Sessions you haven't placed yet stay at the top, newest first.

### Continue a terminal session in Switchboard
- A hooked terminal session (one you started in a terminal and hooked into) can now become a normal Switchboard session: **Continue in Switchboard** in its header, its sidebar ⋯ menu and its History row, also for a closed one and for a paired machine's (it runs on that machine). It keeps its id, title, sidebar place, todo list, chat and account, and resumes the same conversation with Switchboard's tools.
- If its `claude` is still running in the terminal, you confirm first and Switchboard stops it (also on Windows); if that fails, nothing changes. A message the terminal took but never acted on shows as **Not sent** with a one-click **Resend**.

### Fixed
- Dragging a paired machine's session to a folder out of view: the session list now scrolls itself while you drag near its edge, in every browser (Safari didn't).
- A paired machine's sessions no longer jump around in the sidebar on every update.

### Other
- The `switchboard` MCP todo tools declare their behavior hints (read-only, destructive, idempotent, open-world).
- A privacy policy (`PRIVACY.md`): Switchboard has no telemetry; the only network calls it makes itself are GitHub update checks.

### Database
- Migration 0029 (the sidebar layout as synced records) runs by itself on first start; existing pins, folders and order are kept.

## 1.9.0 (2026-10-04)

### Todo priority, estimates and a required plan
- **Priority:** every todo item is Urgent, High, Medium or Low. Open cards get a colored left edge, a very faint tint and a small label (red, amber, neutral, blue-grey), and are sorted by priority, with your ↑↓ order applying within a level. Change it with one click from **⋯ → Priority** (keyboard too) or in the edit form.
- **Estimate:** how long an AI agent would take to do the item, in minutes, shown as "~45m" / "~1h 30m". The strip header shows the open total ("4 open · ~3h · 1 done"; a "+" when some items have none), and the Todos page shows each session's total. The edit field accepts 45, 45m, 2h, 1h 30m or 1.5h.
- **The handover plan is required:** when there's nothing to plan, it says "No plan" (an agent adds a short reason). A "No plan" item shows no plan section, and ▶ Start sends its description. The add form starts with "No plan", Medium and no estimate.
- Agents are told to give a plan, a priority and an estimate with every new item (the tools refuse one without them) and to revise priority and estimate as they learn more.
- Existing items become Medium, with no estimate; an empty plan becomes "No plan". A paired machine on an older version keeps working, with the same defaults.

### Database
- Migration 0028 (todo priority and estimate) runs by itself on first start.

## 1.8.0 (2026-10-04)

### Todo items get a title, a description and a handover plan
- Every todo item now has a **title**, an optional **description** (for you, Markdown) and an optional **handover plan** (for an AI agent picking it up later: context, files, steps, acceptance criteria). Existing items keep their text as the title; a long or multi-line text also becomes the description, so nothing is lost.
- Agents are told what each field is for (tool descriptions, the `switchboard` server's instruction and the standing instruction) and fill all three from the conversation when you ask them to add something. `todo_list` is now compact; the new `todo_get` returns an item's full description and plan.
- **Cards** in the strip above the message box and on the Todos page: bold title, a two-line description, who added it and when, a ⋯ menu (Edit, Move up / down, Delete), a progress bar in the header. Click a card to read everything; **Edit** opens a form with the three fields (Esc cancels, ⌘/Ctrl+Enter saves). **+ Add** stays open after saving, for adding several in a row.
- **▶ Start** puts "Work on todo: <title>" and the handover plan into the message box (nothing is sent; a draft you typed is kept, the text goes after it). On the Todos page it opens the session first.
- A paired machine still on 1.7.0 keeps working but doesn't see descriptions or plans until it's updated.

### Database
- Migration 0027 (todo title, description, plan) runs by itself on first start.

## 1.7.0 (2026-10-04)

### Todo lists per session
- Each session has a todo list for things that still need doing. Ask the agent to "add that to the todo list" and it does, through Switchboard's built-in `switchboard` MCP tools (`todo_list`, `todo_add`, `todo_update`, `todo_done`, `todo_remove`). Every session Switchboard starts or resumes gets them automatically; nothing to configure, and nothing is written to your CLI config. Each session can only see and change its own list.
- The standing instruction's default now tells agents to use the list (an edited instruction is left as you wrote it; **Reset to default** adds it).
- A **Todo** strip above the message box: add, edit, reorder, tick and delete items yourself. Done items stay struck through and are removed an hour after they're ticked, or at once with **Clear done**.
- The sidebar shows each session's open count; a new **Todos** page lists every session's open items, grouped by session.
- Lists of a paired machine's sessions can be seen and edited, and a list travels with a session when it's taken over.
- Hand-started terminal sessions (hooks) keep a list too, edited from the UI only.
- The Codex and OpenCode tool setup has not been tried against the real CLIs yet.

### Changed
- Every account can be renamed in **Settings → Accounts**, including the built-in **Default**; texts that mention it use its current name.

### Database
- Migration 0026 (session todos) runs by itself on first start.

## 1.6.1 (2026-10-04)

### Changed
- **Compact usage grid in the sidebar.** The footer's usage bars are now one line per account, each with a 5h and a Week mini-bar: every Claude Code account and every Codex account at a glance, instead of a growing stack of full-width rows. Lines are named after the account (e.g. "Default"), ● marks the account new sessions start on, and a spent account shows "out until 14:05". Hover a line for reset times, pace and model-specific weekly limits (e.g. Opus); click it to open Settings → Accounts.
- Accounts you aren't using now show both their 5-hour and weekly usage, not only the higher of the two.

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
