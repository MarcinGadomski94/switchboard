# Changelog

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
