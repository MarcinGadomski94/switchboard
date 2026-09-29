# Switchboard

Switchboard is a local web app for running many Claude Code sessions at once. From one window you can:

- start sessions in your workspace or repos, each in its own git worktree if you want;
- watch every agent work live, subagents included;
- answer their questions from a single Inbox;
- move sessions between Switchboard and a terminal, and back.

It runs on your machine only (`127.0.0.1`). It drives the unmodified `claude` CLI with your own login.

- [Requirements](#requirements)
- [Install and run](#install-and-run)
- [Updating](#updating)
- [Start at login](#start-at-login)
- [Configuration](#configuration)
- [Features](#features)
- [Security model](#security-model)
- [For developers](#for-developers)
- [Troubleshooting](#troubleshooting)

---

## Requirements

| What | Why |
|---|---|
| **Node.js ≥ 24** on `PATH` | The server runs its TypeScript directly (type stripping). |
| **git** | Worktrees, branches, diffs. |
| **Claude Code CLI** (`claude`), signed in with your claude.ai subscription | Every session is a supervised `claude` process. Check with `claude auth status`; an API key is not enough for Remote Control. |
| **GitHub CLI** (`gh`), signed in (optional) | Detects merged pull requests of session worktrees. |
| **Chrome** (recommended) or Safari | Signed-in sites such as Jira can only be embedded in Chrome ([Embedded tools](#embedded-tools)). |

macOS is the primary platform. Linux and Windows are supported for the service, paths and "Start at login".

## Install and run

```sh
cd ~/RiderProjects/Personal/switchboard   # this repo
npm ci          # exact, pinned dependencies
npm run build   # builds the UI into dist/web
npm start       # serves http://127.0.0.1:13001
```

Open **http://127.0.0.1:13001** by typing it or from a bookmark. That first page load gives your browser its access cookie ([Security model](#security-model)).

The first time, a **setup wizard** opens:
1. It checks the `claude` CLI and its login (plus `gh`).
2. It adds your first **folder**: a workspace (a folder with a router `AGENTS.md`) or a git repository.
3. It scans that folder's solutions.
4. It sets up notifications.

You can skip it and do all of this later in Settings.

## Updating

After pulling new code:

```sh
npm ci           # only when package-lock.json changed
npm run build    # the UI is served from dist/web, so rebuild it
# then restart Switchboard (stop npm start / the service and start it again)
```

Database migrations run by themselves on start. Sessions that were live when Switchboard stopped are resumed after the restart.

## Start at login

**Settings → Claude Code → Start at login**, or from a terminal:

```sh
npm run service:install -- --dry-run   # shows every file and command, changes nothing
npm run service:install                # launchd (macOS) / systemd --user (Linux) / Task Scheduler (Windows)
npm run service:uninstall
```

The service is the same process as `npm start`, so build first (`npm run build`). Details: [`docs/service.md`](docs/service.md).

## Configuration

Settings are environment variables, read at start. An invalid value makes `npm start` exit with a message.

| Variable | Default | What |
|---|---|---|
| `SWITCHBOARD_PORT` | `13001` | The port; the address is always `127.0.0.1`. |
| `SWITCHBOARD_DATA_DIR` | per-user app data (`~/Library/Application Support/Switchboard` on macOS) | The database (`switchboard.db`) and the access token (`sb_token`). |
| `SWITCHBOARD_CLAUDE_BIN` | `claude` | The Claude Code CLI; a JSON array is used as an argv prefix. |
| `SWITCHBOARD_GH_BIN` | `gh` | The GitHub CLI. |
| `SWITCHBOARD_SETUP_WIZARD` | on | `off` stops the wizard from opening by itself. |
| `SWITCHBOARD_CLAUDE_EXTRA_ARGS` | none | Dev only: a JSON array of extra flags for every `claude` spawn. |
| `SWITCHBOARD_TAILSCALE_BIN` | `tailscale` | The Tailscale CLI; `tailscale ip -4` gives the address of the optional peer listener (Machines). |

Everything else, such as saved folders, tools, notification and usage settings, lives in the database and is edited in **Settings**. The full list, with test-only variables, is in [`docs/configuration.md`](docs/configuration.md).

---

## Features

### Folders
There is no single workspace root. You save **folders** in **Settings → Folders**, and each session, scan and schedule names the one it works in:
- A **workspace** (router `AGENTS.md`) gets the router's session-start questions answered up front in the New-session form.
- A **git repo** is a single solution.

A folder can have a custom name. [`docs/folders.md`](docs/folders.md)

### New session
- **Title:** free text, e.g. "JIRA Ticket handling". A kebab-case short name is derived from it for the branch and worktree folder.
- **Task:** what the agent should do.
- **Session-start answers:** work type, mode, solutions in scope, phase, mobile coordination, ultracode.
- **No solutions picked:** you can leave the solutions empty and let the agent decide. It creates the worktrees it needs, Switchboard adopts them, and the session's solutions fill in from what the agent touches.
- **Model and effort:** chosen in the form; the next session starts on your last choice.
- **Worktrees:** each session can work in its own git worktree. The **branch must be named after its ticket**, e.g. `PROJ-0001-short-description`, and it is pre-filled when the title starts with a ticket key.
- **Continuing existing work:**
  - **pick a terminal conversation** to move it into Switchboard;
  - **"From a remote session"**: paste a claude.ai/code session URL to continue a cloud or Remote Control session as a local copy.
- **Branching:** with an epic (key + summary), task branches are cut from `feature/<EPIC-KEY>-<Summary>`, which is itself cut from `origin/dev`. Without an epic (bug fixes), they are cut from `origin/master` after a fetch. Branches are created and pushed lazily, only in the repos the agent changes. A preflight table shows, per repo, the base, the epic, the task branch and the cut point before you start. An existing task branch is reused.

[`docs/new-session.md`](docs/new-session.md) · [`docs/worktrees.md`](docs/worktrees.md)

### The session view
**Chat**
- **Formatting:** agent and developer messages render as Markdown, with syntax colors and clickable links.
- **Composer:** **Enter** sends, **Shift+Enter** adds a line.
- **Live activity:** "Pondering… 1m 23s", "● Bash: npm test 0:42".
- **Background waits:** a GitHub Actions run, a build, a subagent, a timer, a background workflow or any other task the CLI reports shows as working ("⏳ Waiting for GitHub Actions: …", "⏳ Running a workflow: …") instead of looking idle.
- **Queued messages:** a message you send while the agent is busy shows a clock until the agent takes it up. A message to a paused session resumes it.
- **Context bar:** a thin bar above the quick replies shows how full the session's context window is (`Context 62% · 124k / 200k`), green, then yellow from 60 % and red from 80 %. After the CLI compacts the conversation it resets and reads "compacted 14:05" until the next turn.
- **Questions:** the agent's questions appear as cards in the chat. Besides the offered answers, **Other…** lets you answer in your own words.

**Header**
- **Rename:** click the title.
- **Model and effort picker:** changes the running session from its next turn.
- **Close:** the session leaves the sidebar and can be reopened from History.
- **Remote:** makes the session reachable from your phone or claude.ai.
- **Pause / Resume.**
- **Continue in terminal:** hands the session over to a terminal; **Attach here** takes it back.

**Right panel**
- **Agent overview:** a table of Agent · Description · Solution · Status for every agent. The newest status table the agent printed appears under it as a readable table ("as printed" shows the original).
- **Agent cards** with each agent's current action. Finished subagents fold into a "✓ N finished" line, which you click to show them again.
- **The terminal tail** and the **handoff** command.

**Subagent chats**
- **Open one:** click a subagent's **Agent** step in the chat, its card, or its overview row. You see its own conversation: the brief from the main agent, its messages and tool steps, and its result.
- **Get back:** **← Main chat**, **Esc** or the browser's Back returns you to the same spot.
- **No composer:** subagents take no messages; reply in the main chat.

**Tabs:** Timeline, Diff (per worktree), Artifacts.

**Switching sessions:** a session you visited recently opens instantly; one still loading shows placeholders instead of a blank or stale view.

**More room:** slide the sidebar (**⌘B**) or the right panel (**⌥⌘B**) out with its small hide button; a slim handle at the window's edge brings it back. The choice is remembered across reloads and restarts.

[`docs/chat.md`](docs/chat.md) · [`docs/session-panel.md`](docs/session-panel.md) · [`docs/model-effort.md`](docs/model-effort.md) · [`docs/panes.md`](docs/panes.md)

### Inbox and notifications
- Every question batch and permission request from every session lands in the **Inbox**. Answer it there or in the session's chat.
- A new question also raises a **toast**, a chime and an OS notification (when allowed).
- A notification closes by itself once you open that session or the question is answered.
- **System items** also appear there: a pull request was merged and its worktree can be removed; a scheduled run failed.

[`docs/inbox.md`](docs/inbox.md) · [`docs/notifications.md`](docs/notifications.md)

### Solutions
- Every solution of a folder, grouped the way the router groups them.
- Each one's live branches and worktrees, phase ledger and artifacts.
- A **conflict card** when two sessions work in the same checkout. **Move … to worktree** isolates one of them onto a ticket branch.

[`docs/solutions.md`](docs/solutions.md)

### Schedules and loops
- **Cron schedules:** start sessions from templates.
- **Loop cards:** show observed `/loop`, `ScheduleWakeup`, `CronCreate` and Workflow runs: iteration, next firing, expiry.

[`docs/schedules.md`](docs/schedules.md)

### History
- Every session, and every **terminal conversation** from `~/.claude/projects`.
- **Continue in Switchboard:** moves a terminal conversation in as the same conversation.
- **Closed** sessions can be **reopened**.
- Local copies of remote sessions are tagged.

### Remote
- **Remote** (header toggle): puts a Switchboard session on claude.ai and the Claude mobile app through Claude's Remote Control. It shows a link and a QR code, and the link stays the same across pause and resume. Questions answered on the phone close in Switchboard.
- **From a remote session** (New session): pulls a cloud or other-machine session into a fresh worktree as a **one-way local copy**.
- **Not possible yet:** listing your cloud sessions, or attaching live to one. The CLI keeps that switched off for accounts today.

[`docs/remote-control.md`](docs/remote-control.md) · [`docs/spike-remote.md`](docs/spike-remote.md)

### Machines (peers)
Pair Switchboards on your tailnet (a Mac and Windows PCs), in **Settings → Machines**:
- **Peer listener** (off by default): lets paired machines reach this one on its **Tailscale address** only (port 13002). The UI itself stays on 127.0.0.1.
- **Allow a new peer** shows a one-time code (10 minutes, single use); on the other machine, **Add machine** with this machine's Tailscale address and the code. One pairing works both ways; each machine shows the other as online / offline / auth failed / no address, reconnects by itself, and can be renamed or removed (which revokes it on both sides).
- **Remote sessions:** a paired machine's sessions appear in the sidebar with a **machine tag** and open in the normal session view: chat, question cards, queued messages, pause / resume, model and effort, close / reopen, Diff, Artifacts, Timeline, subagent chats. Its questions and permission requests land in your **Inbox** (tagged; toasts and notifications too), and answering here answers there. When the machine is offline its sessions stay listed as **unreachable**; it keeps running them.
- **Start a session on a peer:** the New-session form's **Machine** row picks the machine; its folders, models and the branching check come from there, and the session runs there.

[`docs/peers.md`](docs/peers.md)

### Embedded tools
Local web tools open inside Switchboard from the sidebar (**TOOLS**); add them in Settings → Embedded tools. Codebase Memory is built in, including its "reindex n now" strip.

- **Local tools:** go through a small local proxy, so tools that refuse to be framed still open.
- **Signed-in sites** such as Jira: need the **frame helper** browser extension (`tools/frame-helper`), loaded in **Chrome**. It lifts the framing headers only for your saved site tools, and only in Switchboard's tab.
  - **Setting it up:** Settings → Embedded tools → **Frame helper → Set up** (or **Set up frame helper** on the site's page) walks you through it. It opens Chrome's extensions page, reveals the folder in Finder, copies its path, then asks you to reload the tab. The one click only you can make is **Load unpacked**.
- **Safari:** can't do this; those tools open in a new tab.

[`docs/tools.md`](docs/tools.md) · [`docs/frame-helper.md`](docs/frame-helper.md)

### Usage and footer
The sidebar footer shows RAM in use and two **Max usage** bars:
- **Session.** It is colored by pace, updated every minute: green while you're under the elapsed share of the 5-hour window, yellow once you're ahead of it.
- **Week.** It is colored by pace: green while you're under the day's share of the week (14.29% per day from your reset hour), yellow once you're ahead of it.

[`docs/usage.md`](docs/usage.md)

### Restarts and recovery
When Switchboard starts, sessions that were live are resumed with `claude --resume` and told "Switchboard restarted. Continue." Closed sessions stay closed. [`docs/supervisor.md`](docs/supervisor.md)

### Install as an app
Switchboard can run in its own app window with a Dock icon (a PWA):
- **Chrome:** Settings → Claude Code → **Install as app**, or the install icon in the address bar.
- **Safari:** **File → Add to Dock…**.

If the service isn't running, the app window shows "Switchboard isn't running" with **Retry**. Nothing else is cached, so after an update just reload the app.

Opening `localhost:13001` takes you to `127.0.0.1:13001`, so there is one app and one login whichever you type. [`docs/install-app.md`](docs/install-app.md)


---

## Security model
- The server listens on **127.0.0.1 only**. Every request must name `127.0.0.1:<port>` or `localhost:<port>` as its Host (this stops DNS rebinding). A browser Origin must be exactly Switchboard's own.
- Every API call needs the **`sb_token` cookie**. It is `HttpOnly`, `SameSite=Strict`, and only set when you open the page yourself (typed URL, bookmark, reload), never from another site.
- The optional **peer listener** (Machines) is a second socket bound only to the Tailscale address. It serves only the peer API, and every call needs that machine's own pairing token (stored hashed); no page, no settings, no folders, no tools.
- Child processes are spawned with argument arrays, never through a shell.
- Switchboard never reads or passes on your claude.ai credentials. It only runs the `claude` CLI you signed in to.

[`docs/security.md`](docs/security.md)

---

## For developers

### Stack
- One Node.js project: TypeScript strict, **Fastify**, React + **Vite**.
- Server-Sent Events on `/hub` for live updates.
- Built-in **`node:sqlite`** with plain SQL migrations (`src/server/db/migrations/`).
- Node runs the TypeScript directly, so use erasable syntax only: no `enum`, no `namespace`, no parameter properties.

### Layout
```
src/core/     shared types (api.ts = the API contract), pure derivations and rules
src/server/   Fastify app, supervisor (the claude processes), stores, services, routes
src/web/      React UI (views, shell, modals, chat, right panel)
tools/        fake-claude, fake-gh, fake service manager, the frame helper, dev scripts
tests/        unit and integration (Vitest), e2e + visual oracle (Playwright)
docs/         one doc per area, the decisions log, the handoff spec
.loop/        progress.md (what was built, with test counts), questions.md (assumptions, rulings, known flaky tests)
```

### Scripts
| Script | What |
|---|---|
| `npm run dev` | Rebuilds the UI on change and restarts the server (`node --watch`). No HMR: reload the browser. |
| `npm run typecheck` | `tsc` over the server, web, e2e and service-worker configs. |
| `npm test` | Vitest: unit and integration. |
| `npm run e2e` | Playwright (Chromium, 1440×900) on the real code path, including the visual oracle. |
| `npm run icons` | Re-renders the app icons (`src/web/public/icons/`) from their SVGs with Playwright's Chromium. |

### Tests never call the real `claude` or `gh`
- **`tools/fake-claude`** replays recorded stream-json turns and scenarios. Tokens in a prompt drive it, e.g. `[fake:ask-2q]`, `[fake:say "…"]`, `[fake:background …]`. See [`docs/fake-claude.md`](docs/fake-claude.md).
- **`tools/fake-gh`** stands in for the GitHub CLI.
- Tests start their own server on a **test port** (`SWITCHBOARD_TEST_PORTS`, default 4871–4879; 13001 is refused) with a temporary data folder. The E2E UI is built into `.e2e-dist/web`, so a test run never changes the UI you're running from the same checkout.
- The only real-CLI checks are manual and bounded: Haiku, `--max-turns` ≤ 3, in a gitignored sandbox ([`docs/smoke-real-cli.md`](docs/smoke-real-cli.md)).

### Visual oracle
- Every view is compared with the handoff prototype (`docs/handoff/`) on computed SPEC tokens, box positions (±2 px) and exact copy.
- The pixel diffs are advisory. `SWITCHBOARD_VISUAL_REPORT=1 npm run e2e` writes side-by-sides into `docs/visual/`.
- Deliberate deviations are recorded as developer rulings.

[`docs/visual/README.md`](docs/visual/README.md)

### Demo mode
`SWITCHBOARD_DEMO=1 SWITCHBOARD_DATA_DIR="$(mktemp -d)" SWITCHBOARD_PORT=4871 npm start` loads the prototype's data through the normal API, for screenshots and the visual oracle. [`docs/demo.md`](docs/demo.md)

### How changes are made
- **The spec:** the handoff (`docs/handoff/`) plus [`docs/decisions.md`](docs/decisions.md) (D1…D49). The developer's rulings win where the two differ.
- **The contract:** API changes are additive and noted in `docs/handoff/contracts/local-api.md`.
- **Parallel work:** features are built in git worktrees under `.worktrees/`, each on its own test ports, then merged into `main` with the full suites green.
- **Definition of done:** `npm run typecheck`, `npm test` and `npm run e2e` all green, with docs and the `.loop` notes updated.
- **Commits** stay local; nothing is pushed without the developer's say.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| The UI looks old after an update | `npm run build`, then restart Switchboard. |
| `401 unauthorized` / blank data | Open `http://127.0.0.1:13001` by typing it (or a bookmark). Links from other sites don't get the cookie. |
| `listen EADDRINUSE … 127.0.0.1:13001` on start | Another Switchboard (or another app) holds the port: stop it, or set `SWITCHBOARD_PORT`. |
| Setup wizard says "Not signed in" | Run `claude` in a terminal and sign in; check `claude auth status`. |
| Remote toggle is disabled | Its tooltip says why. Usually the process isn't live yet, or the CLI isn't signed in with a claude.ai subscription (no `ANTHROPIC_API_KEY` in Switchboard's environment). |
| Jira shows "needs the Switchboard frame helper" | Click **Set up frame helper** and follow the steps ([`docs/frame-helper.md`](docs/frame-helper.md)); after an update press reload on it in `chrome://extensions`. |
| A tool "refuses to load in a frame" in Safari | Expected: Safari can't lift framing headers. Use Open in new tab, or Chrome. |
| A session looks stuck | The chat line shows what it's doing. "⏳ Waiting for …" means a background task is still running. |
