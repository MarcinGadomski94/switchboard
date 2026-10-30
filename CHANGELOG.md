# Changelog

## 2.4.11 (2026-10-30)

### Tasks
- **Estimates measured on the agent's working time:** a task's "took" now counts only the time its agent was actually working. It pauses while the agent waits for your answer, a GitHub check or a wake-up it scheduled, and while it is idle or done; tasks in progress together split the time. Cards and totals show both numbers, e.g. `est ~45m · took 12m (open 51h 3m)`, and a task in progress shows its working time so far. v2's amber "over estimate" warning uses working time. See `docs/todos.md` (D147).
- **Better calibration for agents:** instead of one "too low / too high" factor, agents see how their estimates turned out per size, e.g. `≤1 h estimates took 0.6× · 1–4 h took 1.3×`, from working-time data only. Tasks finished before this release are kept as open time: Insights still shows them, labelled, but they no longer steer the agents.

### Fixes
- Two Switchboard processes starting at the same moment could each create a different login token; the token file is now written whole and put in place in one step.
- Insights: the classic page's test matches the Outcomes table with the Plans columns.

## 2.4.10 (2026-10-29)

### Teams
- **Keys reach the computer the teammate runs on:** when an agent asks for an API key and its teammate runs on another paired computer, Add key, Test connection and Revoke from this computer now act there. The key is sent once over the paired connection, stored only in that computer's keychain, and the teammate restarts with it; this computer keeps no copy unless you choose "Set up here too". The card and the Access tab say which computer, and the audit reads "Set up on <computer> from <computer>". If that computer is offline, nothing is stored. See `docs/team.md` and `docs/security.md` (D146).
- **Crew counts stay right:** a pinned crew no longer keeps showing "1 needs you" after you answered. The pinned crews, the Crews page, the classic sidebar and the classic team header count by one rule and refresh when a teammate starts or stops waiting.

### v2 theme
- **Access requests:** **Not now** defers a request instead of denying it, **Deny** is its own button, **Add key** opens the access you clicked, and the form no longer reopens after Save. A request you pressed "Not now" on before this release was recorded as denied: set it up from the teammate's Access tab if you still want it.
- **Review notes** opens a paired computer's notes at the right folder.

### Sessions
- **OpenCode:** a short turn whose events arrive before OpenCode confirms the prompt now ends instead of staying "working". OpenCode sessions record their server's process, so they show as live and a restart leaves a still-running OpenCode alone instead of starting a second one.
- **Account hint:** no `claude auth status` check every 30 s on a computer without paired computers.

### Development
- The server test suite is reliable (a port range per test worker, fixed races) and is now a required CI check.
- README links the dev.to article.

## 2.4.9 (2026-10-29)

### Fixes
- **No typing lag in long chats:** typing no longer redraws the whole conversation. Chat rows that didn't change are reused, the agent page skips the shell's periodic redraws, the message clock reuses its formatters and the v2 message box resizes only when needed. In a 3,000-event chat while the agent works, the slowest keystrokes went from 389 ms to 72 ms on a 10× slower CPU. Both themes. See `docs/performance.md`.
- README screenshots show the current v2 (the live Project graph, Tasks in the rail, the model picker).

## 2.4.8 (2026-10-28)

### Sessions
- **Big folders stay fast:** an agent working in a large multi-repo folder with many worktrees no longer takes seconds to minutes to open, count its changes or send to. Its change count and file list are cached and refreshed in the background (one computation at a time), worktrees are read in parallel, and the agent view never restarts a slow load, so it settles on a phone too; the count shows "…" while it refreshes. See `docs/worktrees.md` (D144).
- **Merged worktrees clean up after themselves:** when a worktree's branch is merged (or its PR is), it has nothing uncommitted or only local, nothing runs in it and its agent is idle, Switchboard removes the folder, the local branch and the branch on the remote, with a line in the agent's chat. It covers worktrees its agents made themselves (e.g. `.claude/worktrees`). Never `--force` or `-D`, never `git worktree prune`, and never main / master / dev / develop / release / `feature/*` / the default branch. Settings › Sessions & worktrees: on by default, with a switch for the remote branch. See `docs/cleanup.md` (D145).

### Docs
- A new social preview and README demo animation from the current v2 theme.

## 2.4.7 (2026-10-28)

### v2 theme
- **Choose the model and effort again:** Smart / Fast and "Thinking depth" are replaced by a **Model** list per engine (the CLI's own models) and the CLI's **Effort** levels, in Home, + New, the agent's How it works and the teammate dialog. Agents started with Smart / Fast keep their model.
- **Continue with a clean slate works:** the button was disabled whenever an agent had left a background app running, with its reason hidden in a tooltip. It now works, says why when it can't, shows its progress and opens the fresh agent; also in the agent's ⋯ menu.
- **Multi-select answers** get room for their text instead of one word per line (one column on a phone).

### Sessions
- **Background apps don't keep an agent "working":** after its turn, an agent that left a dev server, script or watcher running reads Done / Idle · 1 background app. Helper agents it waits on still count as working. See `docs/processes.md` (D143).
- **Chats can save artifacts:** a chat's instructions now allow Switchboard's own tools (artifacts, todos) in plan mode, and their permission asks are approved; images and PDFs can come from its attachments or the folders it reads.

### Accounts
- **A paired computer that can't switch accounts says so:** when it has only one Claude Code account and another computer has more, Needs you shows "… can't switch Claude Code accounts" with **Add it there**, and Settings › Accounts shows the same (D142). Logins still never travel between computers.

## 2.4.6 (2026-10-28)

### Fixes
- **v2 rail:** a pinned crew's teammates show their live status (working, idle, done, needs you) instead of the status they had when the page loaded; the crew row's "N working" count follows too.

## 2.4.5 (2026-10-28)

### Sessions
- **Deleting a folder can archive its agents:** the confirmation asks "Delete “X” and archive its N agents?" with **Also archive the agents in it** ticked by default; it counts subfolders, names the ones that are working and will be stopped, and keeps crew members, a project's agents, pinned agents and an offline computer's agents (moved out, with the reason in the toast). Undo brings the agents and the folder back. Both themes. See `docs/sidebar.md` (D141).

### v2 theme
- **Open a teammate's chat straight from the crew view:** click the teammate's card (name, avatar or summary) or its new **Open chat** button; in the Crews list, click a teammate's avatar.

## 2.4.4 (2026-10-28)

### v2 theme
- **Bring in a terminal conversation:** + New › From a terminal (also ⌘K and Agents › Also) lists this computer's Claude Code conversations that never ran in Switchboard, newest first, searchable by folder, first message, name or id. Continue in Switchboard imports the chat and resumes the same conversation, waiting for you; it warns if the terminal may still have it open. Codex and OpenCode conversations behind the same switch as classic History.
- **Compact crew cards:** teammates in a denser grid (four per row on a wide screen); the long job description scrolls in a three-line box.
- **Pin a crew to the sidebar:** a crew's ⋯ › Pin to sidebar puts it under Pinned in the rail with its working and needs-you counts; the arrow expands it to its teammates. Pins sync to paired computers.

### Fixes
- The test helper for the fake Claude CLI no longer throws on multi-line JSON output, so CI reports green when every test passes.

## 2.4.3 (2026-10-27)

### Updates
- **Update Switchboard remotely:** from a paired phone or another paired computer. Settings › Computers shows each computer's version with **Update** and **Check for updates**, the progress and the restart; a phone can update the computer it is paired with (Settings › Updates). It asks first, installs only the checksum-verified GitHub release as before, allows one remote update per 10 minutes per computer and records who asked ("Updated to 2.4.3 from your phone"). Rollback and the updater's settings stay local. See `docs/updates.md` (D140).

### v2 theme
- **The Project graph in full screen:** a Full screen button (or the page `/projects/<id>/graph`, "Open in a new window" for a second monitor) with a compact top bar; **Follow** keeps the graph fitted or centred on the working steps as the project moves, a Fit pill brings it back after you zoom or pan, and the tab title shows "▶ 45% · Project". On a phone it opens on the working step.
- **Steps, Board and Timeline in the graph's look:** the same progress header on every tab; Steps rows with progress rings, repository chips, "Working · 25m" and estimate bars, grouped by state (or by repository); Board cards like the graph's; Timeline bars in repository lanes with the graph's arrows, the critical path and hover highlighting.
- The graph's step icons sit in the middle of their rings again.

## 2.4.2 (2026-10-27)

### v2 theme
- **The Project graph, redrawn:** steps in repository lanes left to right with fewer crossing arrows; each step has a progress ring with its state icon, "Working · 25m" with the model and a time-against-estimate bar, and what it waits on. Dots travel into steps being worked on, the critical path (the longest chain still to do) glows and can be switched off, hovering a step lights up what it waits on and what waits on it, and a header ring and bar show the whole project's progress. Zoom, pan and Fit, a minimap when the project doesn't fit, and every animation off with reduced motion.
- **Graph on phones:** pinch to zoom, double-tap to zoom in, long-press a step for its menu; it opens on the step being worked on, with a Map button for the overview.
- **Finished helpers fold away:** in long sessions the Helpers list, tab, peek and Timeline show only helpers that are working or finished in the last 10 minutes; older ones fold under "Show N helpers finished earlier", and badges count active helpers only.

## 2.4.1 (2026-10-27)

### Fixes
- **An account that needs you no longer stalls your work:** when Claude Code refuses to run on an account until you accept Anthropic's updated terms or sign in again (Codex too), Switchboard says so in Needs you ("Work (Claude Code) needs you: accept Anthropic's updated terms") with the exact command to run and **Retry stopped agents**. Steps of a Project set to that account wait instead of failing one after another; agents on Automatic or your overall choice use another account meanwhile. See `docs/accounts.md` (D139).
- **Stopped Project steps restart:** a per-step **Restart**, "Restart stopped steps (N)" and the Project's Resume bring them back (a conversation that was never saved starts fresh), and dead steps no longer hold the Project's running slots.
- **v2 Projects:** clicking a stopped or failed step in any view opens its details with Try again / Restart; Graph and Timeline steps have the ⋯ menu.

## 2.4.0 (2026-10-27)

### Accounts
- **Choose the account:** pick the account per engine from the v2 top bar's usage pill (or Settings → Usage & accounts): new agents start on it, and running and idle agents move to it after you confirm ("Move 5 agents to B? 1 running turn will be interrupted."). Pinned agents keep theirs. It replaces "New sessions start on: a fixed account" (your setting carries over).
- **An account per Project:** set it in the Project's Start dialog or ⋯ → Account…; every step's agent uses it. Order: an agent's pin, then its Project's account, then your overall choice, then automatic switching.
- When the chosen account runs out, agents switch automatically with a note in the chat ("B is out of usage until 14:05; switched to A"); new agents prefer your choice again once it has usage. The agent header shows where its account comes from. See `docs/accounts.md` (D138).

### v2 theme
- **Search in Settings:** find any single setting by its name, help text or a common word ("archive", "sound", "port"); the result opens its page and highlights it. ⌘K finds settings too.
- **Settings in a better order:** Advanced is grouped under Agents, Projects & code, Accounts & devices, Notifications and App; the everyday sections come first.
- **Archived crew members leave the crew view** and come back with their role on Restore; they get no new work while archived.

## 2.3.0 (2026-10-26)

### Project memory
- **Notes are checked by themselves:** once a week (adjustable, on by default) Switchboard checks each folder's approved notes against the code and its git history in a short background run (no session, read-only: `--restricted`, no shell). Notes that no longer hold are removed to a "Removed by memory check" list with the reason and **Restore** (kept 30 days; at most 5 per run, never a folder's only note); suggested rewrites arrive as "Note edit" for your approval. A new proposal is compared with the approved notes: a duplicate or contradiction shows on its card, with **Approve and remove the old note**. Tokens show in Insights → Usage as "Memory check". Settings: the switch, how often, and per folder; "Check now" on the Notes / Memory page. See `docs/memory.md` (D136).

### Sessions
- **Archive instead of Close:** archived agents are deleted after 14 days (Settings: any number of days, or Never), with "Deletes in N days" and **Restore** in the Archived list (v2) and History (Classic). Kept while running, pinned, a crew member, part of an unfinished plan or with a routine. Its worktree goes with it only when clean and merged; branches are never deleted. Nothing is deleted on upgrade day, and changing the period never makes agents due at once. Paired computers' archived agents show too, with their own countdown. See `docs/cleanup.md` (D137).

### v2 theme
- **Tasks in the rail:** the board of every session's tasks is a main item, with a count of unfinished tasks; ⌘K finds it as "board" too.

## 2.2.0 (2026-10-26)

### Project memory
- **Agents can propose changing or removing an approved note:** `memory_propose_edit` and `memory_propose_retract` create a proposal that waits for your review, like a new note; `memory_list` now shows each entry's id. You review an edit as a side-by-side diff in Classic Memory, v2 Notes and Needs you ("Note edit" / "Note removal"); approving a removal deletes the note. See `docs/memory.md`.

### v2 theme
- **The "You replied …" line leaves:** after you answer an ask or approval in an agent's chat, the line goes once the 5-second Undo window ends instead of staying pinned at the bottom of the chat.

## 2.1.0 (2026-10-27)

### Insights
- **Where your usage went:** Insights → Usage ranks the agents, conversations, teammates, plan steps and routines by the tokens they used in each account's current 5-hour or weekly window (or today / last 7 days), groupable by folder, model, account or kind, with a stacked chart, a usage log with CSV export and a "See what used it" link per account in the status pill. Helper and workflow-agent tokens are now recorded and counted towards the agent that started them. Classic Insights has the ranked table too.

### v2 theme
- **Loops and schedules in the agent view:** "⏰ Next: … · n routines" in the status row lists every loop, CLI schedule and wake-up of the agent with Pause, Run now, Edit and Cancel; creating one shows in the chat.
- **Tasks as cards** in Classic's format: a strip above the message box (collapsed by default), the side panel, the peek, the phone and the Tasks page.
- **Markdown in question cards:** bold, code, lists, links and code blocks render in questions, asks and alerts; long ones fold behind Show more.

### Install
- **One-line install:** `curl -fsSL https://raw.githubusercontent.com/MarcinGadomski94/switchboard/master/install.sh | sh` on macOS and Linux, `irm https://raw.githubusercontent.com/MarcinGadomski94/switchboard/master/install.ps1 | iex` on Windows. Checksum-verified, no sudo, re-runnable to upgrade, with `--uninstall`.
- Release downloads are smaller (screenshots left out).

### Docs
- A FAQ, CONTRIBUTING, SECURITY, a code of conduct and issue templates; the requirements now say any one of Claude Code, Codex or OpenCode is enough.

## 2.0.2 (2026-10-26)

### Security
- **Dependencies patched; `npm audit` reports 0 vulnerabilities:** zod 4.6.7 (GHSA-mrhx-c7xc-m3w5, high), fastify 5.12.7 (GHSA-389g-gv7q-r4x8), vite 8.3.5 with its launch-editor (five advisories, development only), mermaid 12.2.0 bringing dompurify 3.4.17 (critical) and katex 0.18.10, body-parser 2.4.0 (high), fast-uri, ip-address and vitest 5.0.5. The built-in MCP helpers ship with the patched zod. See `docs/security.md`.

### v2 theme
- **Usage warnings:** when an account reaches your "Warn at" level, v2 shows a toast and a "Usage warning" in Needs you, and the status pill turns amber at your level; "Warn at" is in Settings → Usage & accounts.
- **Unsent text is kept** when you leave an agent and come back, also after a reload and without an empty box first (both themes: a save still on its way was overwritten by an older read).
- **Your message shows at once** when you press Enter, with "Queued", "sends when the agent starts again" or "Paused — waiting for usage" under it, whatever the agent is doing.
- **Answer cards match Classic:** an agent's plain-text ask shows its question, a reply box and Not waiting (no made-up "Go ahead"); multi-select answers are sent exactly as Classic sends them; option descriptions show on the whole option.

### Agents
- **Choices come as question cards:** the built-in instructions ask agents to offer choices with AskUserQuestion instead of a list in their message, so you get buttons to pick from.

## 2.0.1 (2026-10-26)

### v2 theme
- **Crew members live only in Crews:** an agent made a teammate leaves every Agents view, the folder tree and the Agents badge; its chat still opens from Crews, Needs you, search or a link, and Return to agents brings it back.
- **Teammates go by their teammate name** (with their crew) in the agent view, the peek, the browser tab, Needs you, Home, search, ⌘K and Recent; renaming one in the header renames the teammate.
- **More room for the chat:** a one-row header (details behind ⓘ), one compact status row above the message box ("Working 0:42 · Tasks 1/3 · Memory 64% · 2 queued"), a message box that grows to about a fifth of the screen and then scrolls, and long messages of yours folded after 12 lines.
- **Copy and Save as result** sit in a strip above a code block instead of covering it.
- **Recent** in the left rail: your last five agents and conversations under Pinned.

### Docs
- The README describes Switchboard 2 and shows the v2 theme; the demo data uses neutral Acme names throughout.

## 2.0.0 (2026-10-26)

**Switchboard 2.** A new design, built so that anyone can run AI agents comfortably, plus three features leaving experimental. The design of Switchboard 1 stays available as the **Classic** theme.

### The v2 theme (the new default)
- **Home:** start an agent by writing what it should do; see what **Needs you**, what's **Working now** and what's **Done today**.
- **One Needs-you queue** for every question (single and multi-select), approval, ask, stopped step, ready-for-approval change, crew request, note and alert, answerable in one click with Undo, on every page, in the agent's chat and on your phone.
- **Six places, all labelled:** Home · Agents · Projects · Crews · Results · Settings, with search (⌘⇧F), ⌘K and a status pill for usage, computers, power and background apps.
- **Agents** as a List, a Chats list or a Board (Needs you · Working · Ready for approval · Done), with the folder tree (pins, subfolders, drag, Move to folder with **M**) shared with Classic and your other computers; Drafts, Closed, Tasks, Notes and Routines.
- **The agent view:** roomier chat (document-style replies, folded tool activity, answer cards in the chat, a ⋯ on every reply), a composer with attachments, drafts, queued and paused messages, a side panel you can hide (**⌘.**), Changes, Results, Timeline and Helpers, and a peek you can open from anywhere.
- **Projects** (Steps, Board, Graph, Timeline) and **Crews** (several, in order; teammates, job descriptions, access keys, budgets, moves between crews and computers).
- **Results, Search, Insights, + New** (agent, conversation, task, project, routine, teammate, crew) and **Settings** (usage and account switching, computers, phones, rules for every agent, appearance, and every Classic section under Advanced).
- **Plain language** throughout (agents, replies, combine, change requests, automatic tests, computers), light and dark, phone and tablet layouts, and a short **"Welcome to Switchboard 2"** tour.

### Classic theme
- The Switchboard 1 design, unchanged, under **Settings → Appearance → Theme: Classic** (in either theme, or ⌘K "Switch to the classic theme"). The choice is per browser; both themes share the same agents, folders and data.

### Out of experimental
- **Team (Crews), Plans (Projects) and Project memory (Notes)** are always on; the Experimental switches are gone. Nothing changes for a feature you have not used. The Jira connection moved to **Settings → Jira**.

### Fixed
- An agent could keep showing "Working" after it finished, when two status updates overlapped.
- Answers given just before a tab closes are no longer lost.

## 1.35.0 (2026-10-23)

### Questions
- **Pick several answers:** an agent's multi-select question now shows checkboxes ("Choose any"); tick any options and add your own words alongside, and the agent gets them all (in the Inbox, the chat and on phones).

### Plans
- **Agents can edit items already in their plan:** `plan_update_item` (set or clear a hold; a pending item's title, description and estimate), `plan_remove_item`, `plan_remove_dependency`, and `plan_set_mode` (after asking you).
- **A named sidebar subfolder for a plan's runs:** Start asks for it (prefilled with the plan's title); the runs are collected there inside the source session's folder, and a folder with the same name is reused. `plan_start` takes `sidebar_folder` too.

## 1.34.0 (2026-10-22)

### Sessions
- **Control over the processes agents leave running:** Switchboard tracks the build servers, test hosts and dev servers each session starts (even after they detach), lists them in the session's Processes section and in Settings → Processes (also a paired machine's), with Stop and Keep, and a "procs" total in the sidebar footer. A session's leftovers are stopped when it is closed or has been idle for 10 minutes (adjustable), never while it works and never a kept one; agents can keep a dev server for you with the new `process_keep` tool. Agents' .NET builds no longer leave MSBuild nodes or the compiler server behind (`MSBUILDDISABLENODEREUSE`, `DOTNET_CLI_USE_MSBUILD_SERVER=0`, `UseSharedCompilation=false`, for Switchboard's own agents only).
- **Rename chats** from their sidebar row (⋯ → Rename…, or double-click) or their header.

### Docs
- **A shorter, current README** with install commands that paste cleanly (no comments: macOS zsh ran them as commands); the longer setup and development notes moved to docs/setup.md.

## 1.33.0 (2026-10-22)

### Artifacts
- **PDF artifacts:** agents save a PDF as it is (`artifact_save` kind `pdf` with the file's path, up to 25 MB) instead of converting it to HTML. It opens in the browser's own PDF viewer with Download and Open in new tab; phones and touch screens get an Open PDF button. The Artifacts page has a PDFs filter, versions work like images, and a paired machine's PDFs open the same way.

## 1.32.0 (2026-10-21)

### Machines
- **Battery and power draw:** the sidebar footer shows a laptop's battery (🔋64% · 2h10 left, ⚡81% · 35m to full, 🔌 on AC) and its current draw, and a desktop's estimated total ("~210 W": the graphics card measured with nvidia-smi where available, the CPU estimated from its load, plus a baseline; adjustable in Settings → Machines → Power estimate). Paired machines share it: it shows in Settings → Machines and on their machine tags. Phones report nothing. Read-only system queries only, at most every 30 seconds, never admin or sudo.

## 1.31.0 (2026-10-21)

### Sessions
- **Sessions say when they're waiting for you.** Agents end each turn with the new `turn_status` tool (done, waiting for you, or blocked, with a one-line ask); a turn that ends without it is read from its last message (a final question, "shall I…", open questions, a "You: …" item). Such a session shows **Needs you** with its ask in the sidebar and header (with **Not waiting** for a wrong guess), raises an Inbox item and a push, counts as needs-you in Team, and shows amber "Needs you" on its plan item instead of the red Stopped. It clears when the next turn starts.

### Fixed
- **Reopen on a plan item** now works from a phone and from a paired machine.

## 1.30.0 (2026-10-20)

### Fixed
- **Plans no longer mark a freshly started item as merged.** An item counts as merged only when its PR into the plan's target is merged, or its branch has commits of its own that are in the target (locally or on `origin`). Items that were marked "merged … without your Merge" by mistake are **reopened automatically** (back to running, or Stopped when their session is gone; their todo reopened), with an Inbox item that also lists dependents that started too early and Jira tickets that were told "merged/Done". A real later merge still comments and moves the ticket to Done. Done items have a **Reopen** action.
- **Plan PRs, branches and commits name only their own ticket:** the agents are told never to mention other ticket keys (tracker automation acts on them), and Switchboard's own merge commit and PR text no longer include the epic key.
- **A SendMessage to an agent that was stopped** no longer leaves the session "waiting on subagents" for 2 hours.

### Plans
- **Stopped — needs you:** an item whose agent ended its turn without finishing turns red after 2 minutes, with the agent's last message, a "■ N stopped" count and an Inbox item with Open session; it goes back to running when the session works again.
- **One click to an item's session:** clicking a plan item opens its session (also on a paired machine); its details are behind ⓘ.
- **Imported plans land in the sidebar:** Import from Jira asks which sidebar folder the plan goes in (prefilled from where that folder's sessions live) and puts the plan's session and its runs in their own "Plan · …" subfolder there.

## 1.29.0 (2026-10-20)

### Plans
- **Agents get everything Jira has on their work:** when an item of a Jira plan starts, its agent gets its ticket in full (description, acceptance criteria, sub-tasks, all comments, linked pages, attachment names, and linked tickets outside the epic with their status) plus a shortened epic context, all read fresh from Jira at that moment. The plan's agent gets the full epic when it orders the items or picks repositories, and any of them can read the current text with the new read-only `plan_jira_context` tool. Plans imported before this version get it too. Switchboard's own sync comments are left out.
- **The import preview shows what the agents will get:** per ticket "2 comments · 2 sub-tasks · 3 links", and the epic's description and acceptance criteria.

## 1.28.1 (2026-10-20)

### Fixed
- **Jira "Blocks" links are imported in the right direction.** Plans imported before read every dependency backwards (the last tickets of a chain came first). A draft plan has **Re-read dependencies from Jira** in its Jira section: it shows the dependencies it removes, adds and keeps, and applies them after you confirm.

### Plans
- **Delete a plan from the UI:** **Delete plan…** on the plan page and in each Plans list row's ⋯ menu. A running or paused plan is cancelled first and its working item sessions are stopped (they stay in the sidebar with their worktrees); the items' todos stay.

## 1.28.0 (2026-10-20)

### Plans
- **Jira tickets move to Done once their work is merged into the feature branch:** with write sync, an item merged into the plan's target (by its agent, or by your Merge) gets the "Merged into <target>." comment and then the Done transition. It's on by default for new plans ("Move to Done when merged into the feature branch", transition name editable) and off for existing ones (turn it on in the plan's Jira section). Mark done never moves a ticket.

### Fixed
- **A delayed In Review retry can no longer move a ticket back out of Done.**
- **A plan without a merge step no longer comments "Merged into <target>."** on a ticket when its item finishes.

## 1.27.0 (2026-10-20)

### Plans
- **The plan's agent picks the repositories:** importing a Jira epic into a workspace (and a New plan there) no longer asks you to pick repositories. The plan's session is asked to set each item's repositories with the new `plan_set_solutions` tool; its choice applies at once, and an item starts as soon as it has them ("Waiting for the plan's agent to pick repositories" until then). "Limit to repositories…" is still there if you want to choose yourself.
- **It never stalls silently:** the ask goes out by itself (one message for items added together; an agent creating a plan gets it in the tool's answer). If the repositories aren't picked within 15 minutes, or the session couldn't be asked, the Inbox shows "Pick repositories" with Ask again and Open plan; the check survives a restart.

## 1.26.0 (2026-10-20)

### Plans
- **Import from Jira no longer asks you to pick a session:** choose where it runs (machine, folder, CLI, model, and the repositories of a workspace; remembered for next time), and Create plan starts a new "Plan · <plan title>" session there that owns the plan and proposes the missing order. "Use an existing session instead" keeps the old way, and a session's Plan strip works as before. Nothing is left behind when an import is cancelled or fails.

### Artifacts and Inbox
- **Loading and syncing states:** the Artifacts page, the Inbox and a session's Artifacts tab show placeholders while they load (with Try again if loading fails), "Syncing with <machine>…" while a paired computer's copy is on its way, and a note when that computer is offline. Its items merge in on their own when they arrive.

### Fixed
- **Messages you send while the agent is working** clear from the message box and show as queued right away, and no longer come back into the box after you leave and return to the session. A refused message is put back with the reason.
- **Create plan after Import from Jira no longer does nothing:** a session without repositories asks you to pick them, and any reason the plan can't be created is shown next to the button.
- **After a paired computer reconnects,** the Inbox count is updated again once its items arrive.

## 1.25.0 (2026-10-19)

### Artifacts
- **Delete artifacts straight from the lists:** every row on the Artifacts page and in a session's Artifacts tab has a ⋯ menu with Delete…, and on the Artifacts page you can tick several rows (or Select all) and delete them at once. Artifacts whose session is gone can now be deleted too, also on a paired machine. Rows on a machine that can't be reached can't be deleted, with the reason shown.

### Performance
- **Much less memory on long runs:** each agent's built-in switchboard helper now runs prebuilt and takes about 70 MB instead of about 120 MB, and the server no longer keeps whole tool inputs and transcript events for days or re-reads every open session twice a second while idle (idle CPU roughly halved in our soak test). `npm run perf:guard` checks it.

### Fixed
- **Every tool of the built-in switchboard MCP server declares all four behaviour hints** (read-only, destructive, idempotent, open-world) as explicit booleans with a title, so MCP directories accept it; `plan_start` is now marked open-world.

## 1.24.1 (2026-10-19)

### Changed
- **Sessions that a plan or a todo's Run starts now appear in their source session's sidebar folder**, right after it (and after its earlier runs), instead of at the top of SESSIONS. A run you move yourself stays where you put it, and the update doesn't rearrange your existing sidebar.

## 1.24.0 (2026-10-16)

### Team
- **Fold the Team page's left column** (Needs you and Activity) into a slim strip with **‹** or the **[** key, giving the member's chat the full width. The strip keeps the needs-you badge (a click opens straight at Needs you), shows a dot for new activity, and pulses once when something new needs you without opening by itself. Your choice is remembered.

## 1.23.1 (2026-10-16)

### Fixed
- **Sessions waiting on background work read as working, not idle:** waiting on GitHub Actions (`gh pr checks --watch`, `gh run watch`, …) shows "⏳ GitHub Actions · 12m", other background tasks the agent waits on count for up to 30 minutes without output, and a scheduled wake-up shows "⏰ waking up at 18:40". Dev servers and watchers left running don't count.
- **Team, Project memory and Plans tools appear without a restart** when a session is adopted into a team or a switch is turned on. Before a charter or memory-draft ask, Switchboard makes sure the agent has the tool it needs, restarting it once between turns if its CLI can't refresh its tools live.

## 1.23.0 (2026-10-16)

### Team
- **Teams fold open in the sidebar** and list their members with what they're doing: ● working, ◐ waiting on subagents, ? needs you, ○ idle, ⏸ paused, ⌁ offline — with a short line such as "PROJ-14 · 40m", "3 subagents · 25m" or "idle · 2h". A folded team shows a summary ("2 working · 1 idle"); clicking a member opens it. Your choice of folded teams is remembered.

### Fixed
- **A session waiting on its subagents now shows as working, not idle** — background `Agent` runs, workflows, and agents resumed with `SendMessage` (each resumed run is tracked on its own). It goes idle only when the main turn and every subagent run are finished; runs that never report back stop counting after 2 hours. The finish reminder and Plans wait for subagents too; messages still reach the main agent at once.

## 1.22.0 (2026-10-16)

### Plans for anything
- **Any target branch**, including dev, main or master: with "I merge each one" there is no restriction; agents merging straight into a protected branch needs your explicit tick (and an agent must ask you first).
- **No merge step:** leave the target empty (or pick "No merging") for work that isn't a git merge flow — items run in order and are done when their agent marks them done; held items wait for your ✔ Done.

### Project memory (experimental)
- **Scopes:** each entry is for the whole folder, one repository, or one Team member. Every session gets only what applies to it, and a member's own memory comes first in its own share of the space, so shared notes never crowd out what a feature-focused member knows. Agents suggest the scope; you confirm it when approving.
- **Draft memory from this session** (and **for all members**) asks agents to propose what they've learned; nothing is used until you approve it.
- A member's memory moves with it to your other machine; if that machine can't take it yet, Switchboard retries and tells you in the Inbox if it keeps failing.

## 1.21.0 (2026-10-15)

### Moving sessions and team members
- **Choose the folders on the other machine** when you move a session or a Team member: its saved folders, its home folder, a path you type, or by browsing its folders (folders only, never file contents). Switchboard then checks, by git remote rather than folder name, that every repository is there — ✓ found, ⚠ another branch / uncommitted changes / to be cloned / several to pick from, ✖ blocked — and enables **Move** only when all of them are found or will be cloned. It looks up to three levels below each chosen folder; your choice is remembered for the next move.
- Repositories now match across machines whatever the URL form or letter case, including Azure DevOps URLs. **Update both machines:** with one on an older version, a repository whose owner or name has capital letters may not match.

### Fixed
- **Solutions no longer shows stale sessions or false conflicts.** Closed, moved and continued sessions stop counting; sessions in their own worktree (agent-made ones included) count as isolated; a session counts as working in a main checkout only while it has uncommitted edits there; worktrees removed outside Switchboard disappear. Names on a conflict card open the session — Team members included — and the page has a **↻ Refresh** button.

## 1.20.0 (2026-10-14)

### Insights
- **One page showing where your agents' time and tokens went**, across all your paired machines: tokens and agent time per folder, session and model, how close the estimates were, what came back for rework (reopened todos, Plans items sent back, reverted turns), the cost of every turn and every todo run at your own prices (example prices — edit them in Settings), and when each account's 5-hour and weekly limits will fill.
- Filter by period, folder, CLI, model, account and machine. Suggested routing rules open Model by task pre-filled and are never applied on their own.

### CI and pull requests
- **A failing check goes back to the agent:** Switchboard sends the end of the failing job's log to the session (up to 3 times per PR, then asks you in the Inbox). A green, approved PR gets **Merge PR** — only on your click — and a status chip in the session header. Settings → CI & pull requests.
- **Import issues…** turns GitHub or Jira issues into a session's todos, with a preview and a link back, never twice.

### Project memory (experimental)
- **Agents propose durable facts about a project** (build commands, gotchas, conventions); you approve, edit or reject them on the new Memory page. Only approved entries reach sessions in that folder, next to the standing instruction; open sessions are flagged so you apply it when you choose. Off by default: Settings → Experimental → Project memory.

### Docs
- A design proposal for using one Switchboard with several developers (`docs/design/team-mode.md`); nothing is built yet.

## 1.19.0 (2026-10-14)

### Chats
- **Start a chat instead of a session** to think and plan with an agent. A chat reads files, searches and browses the web, reads pasted screenshots and files, and can save artifacts, todos and plans, but it never edits files or runs commands: Claude Code runs it in a locked plan mode without shell tools, Codex read-only with its shell switched off, OpenCode with its plan agent. It runs in its own scratch folder, without workspace rules or start-up questions; you can let it read folders you choose.
- **A CHATS section** above SESSIONS with "+ New chat" (and ⌘K → New chat / Chats); both sections now fold, remembered. Search finds chats; chats stay out of Team, Plans and Solutions. Delete a chat from its ⋯ menu.
- **Continue as session…** carries the whole conversation into a new development session when it's time to code; the chat and the session link to each other.

## 1.18.2 (2026-10-14)

### Changed
- **Team: move members between teams by dragging** a member's card onto another team's tab (long press on touch), or pick its team in Settings → Team; every move shows a toast with **Undo**, which puts the member back in its place. The member's ⋯ menu now opens with Enter / Space and can be used with the arrow keys.
- The README has new screenshots and sections for Search, Plans, Team and credits, and the demo data uses fictional Acme names throughout.

## 1.18.1 (2026-10-14)

### Changed
- **Team: a calmer left column.** Activity entries are two lines (icon, member and time, then the text without repeating the member's name), runs of the same event are grouped into one row you can expand ("✓ 4 new charters accepted"), and long histories show "Show more". Activity and Needs you can be collapsed (remembered); an empty Needs you is a single line, and it opens by itself when something new arrives.

## 1.18.0 (2026-10-14)

### Credits
- **See when an account is paying from credits.** An account that keeps working past its 5-hour or weekly limit shows an amber "€ on credits" row in the usage footer, with what is left of your monthly credit limit (e.g. "€12.40 left of €50") and when credits reset. You get one Inbox notice when an account starts using credits, and one when less than 20 % is left.
- **Plan allowance first.** New sessions and automatic switches prefer an account that still has allowance; sessions running on credits move back between turns as soon as an account resets ("moved off credits: … has allowance again").
- **When every account is out:** Settings → Accounts lets you keep using credits (default) or pause new turns. Paused messages wait in the session (editable, removable) and go out by themselves, in order, when an account has allowance again.

### Team (experimental)
- **Better charters:** each member's own agent can draft a specific charter from its session: what it owns, what it produces, how it works today and what it never does. You accept, edit or dismiss each one in Needs you. Use "Draft better charters" for all members, or ⋯ → Redraft charter; newly adopted members are asked automatically. Charters gain a "How it works" field.
- **Several teams:** create, rename, reorder and delete teams, each with its own members, Needs you and activity, plus an All teams view. Move a member to another team from its ⋯ menu.
- **Reorder members** by dragging their cards (long press on touch, ⋯ → Move left/right, or Alt+arrows); the cards sit in one row that scrolls sideways.
- **Choose a member's model and effort from a dropdown**; a model picked in the session header is kept for the member too.

### Changed
- **The sidebar navigation is a compact grid of icons** (names on hover, badges kept), so more room is left for your sessions. The Tools section can be collapsed.
- **The session title stays on one line**, and long rows of repository chips fold to one line with "+N more".

### Removed
- **Review cards** (Inbox, session header, the "Raise review cards" setting and the "Ready for review" phone notification). A finished todo run is now simply done. Plans have their own Merge step instead: items you merge yourself wait as "Ready to merge" with Merge, Open PR, Send back and Open diff, and appear in the Inbox.

### Fixed
- Phones can withdraw a message that is waiting for an account.

## 1.17.0 (2026-10-14)

### Team (experimental)
- **Run a set of role agents from one page.** Settings → Experimental → Team (off by default). A member is one of your sessions with a role, a charter, a rhythm, a budget and the things it needs you for; it leaves your session list and lives on the Team page, with its history, worktrees, todos and loops. ↩ Return to sessions puts it back where it was; switching Team off returns every member.
- **Suggestions and templates:** Switchboard suggests sessions that look like team members (from their titles, loops and how they work) and drafts a charter for each; or start a member from a template (Planner, Developer, Reviewer / QA, Release manager, On-call, Delivery tracking, Marketing monitoring).
- **One page:** member cards by status, Needs you answered in place (questions, reviews, approvals), the activity feed, and each member's chat, settings, pause, tasks and hand-offs. The team is shared between your paired machines, and a member can move from one machine to the other.
- **Access requests:** a member can ask for an MCP server or an API key it needs. You approve it in Needs you and fill it in on the member's Access tab; keys are kept in your system keychain, given only to that member, masked in what Switchboard records, and never synced between machines.

### Plans (experimental)
- **Run a set of todos in dependency order.** Settings → Experimental → Plans (off by default). A plan's items start by themselves as soon as what they wait on is done, within a limit of how many run at once and your usage allowance.
- **You choose how work is merged** into the epic branch when a plan starts: agents merge, agents merge with hold points you merge yourself, or you merge each one. Agents never merge into dev or main, checks must be green, and a failed item holds only what depends on it.
- **Graph, Timeline and List views** with the critical path, each item's state and history (working, waiting on you, waiting on another item, paused), and answers, merges and pauses right on the page.
- **Import from Jira:** paste an epic; its tickets and their "blocks" links become a draft plan. The session's agent can propose the missing order for you to tick. Optional status sync per plan (off, read-only, or moving tickets to In Progress / In Review with comments).
- A plan follows its session when you continue in a fresh session.

### Accounts across paired machines
- **The same account is shown once:** usage, names and order of your Claude accounts are shared between your paired machines, and an account that runs out on one machine is skipped on the other.

### Fixed
- **Review cards and Undo now see all your work.** Sessions working in worktrees the agent made, or editing repositories outside their folder, got no review cards and no per-turn snapshots; they now do. Review cards whose changes are gone close by themselves.
- **Phone notifications come back after re-pairing** without touching the switch, and an address the push service rejected is never reused.

## 1.16.0 (2026-10-13)

### Search across everything
- **One search for everything:** conversations (your messages and the agents'), artifacts, todos and History, on this machine and your paired machine. Open it with ⌘⇧F / Ctrl+Shift+F, the search button in the top bar on tablets and phones, or by typing `?` and your text in ⌘K. Filter by type; results are grouped by type and machine, with the matching words highlighted.
- **A result opens the exact message:** the chat loads the part of the conversation around it, even far back in a long session, scrolls to it and highlights it, with "Show later messages" and "Jump to latest" below.
- Fast on large histories (about 40–55 ms on a 32,000-message test setup). Existing history is indexed in the background after the update, without slowing Switchboard down. A paired machine that doesn't answer within 2.5 s is shown as "not searched".
- What's new has a short tour of it.

### Fixed
- **Paired phones no longer drop back to the pairing page.** Opening Switchboard from a notification, from a link in another app, or from the installed app's icon could land on the pairing page although the phone was still paired. You don't need to pair again: the phone picks up the fix the next time it opens Switchboard.

## 1.15.5 (2026-10-13)

### Changed
- **Permission requests show the agent's message too.** In the Inbox, a permission request now shows the agent's message right above it as context, above the tool's description and the request.

### Fixed
- Questions from hooked terminal sessions got no context in 1.15.4 (the hook doesn't say which call it belongs to); Switchboard now matches the open call and syncs the transcript first, so their questions and permission requests show the agent's message.

## 1.15.4 (2026-10-13)

### Fixed
- **The agent's message before a question no longer disappears.** On the newest models (Opus 5.5, Sonnet 5.5, Fable 5.1) the text an agent writes between tool calls arrives as a progress note, which Switchboard dropped, so a message followed by a question showed only the question card. Notes now show as normal agent messages (directly above the question card when one follows), in sessions Switchboard runs, hooked terminal sessions and a paired machine's sessions; each note shows once. A question's Inbox card shows that message as its context. The activity line, History summaries and review-card summaries use the notes too. Messages lost before this update can't be recovered.

## 1.15.3 (2026-10-13)

### Fixed
- **Loops wait for your answer.** A Switchboard loop no longer fires while its session is waiting for you (an open question or permission request): that due time is skipped and counted ("the session is waiting for your answer"), Run now is refused, and the next due time after you answered fires as usual. Loops the CLI runs itself (`/loop`, `CronCreate`) aren't affected; create the loop with `loop_create` or + New loop to get this.

## 1.15.2 (2026-10-10)

### Faster while sessions are working
- **Live updates send only what changed:** a session update carries only the agents that changed, and the session's loops and model list only when they change. On a session with ~430 subagents: 27 MB of live-update traffic per 100 short turns is now 0.8 MB.
- **The session list is no longer reloaded on every update:** the sidebar, ⌘K and the other views share one copy that live updates patch, and the list leaves out each session's agents (10.9 KB instead of ~280 KB). While a session worked through 100 turns, the Inbox page went from 194 requests and 62 MB to 3 requests and 2 KB.
- **The Timeline shows the last 50 turns,** with "Show earlier", and lanes only for agents active in them: on a long session it opens in 0.8 s instead of up to 1.8 s.
- Paired machines on an older version keep working (they get and send full updates).

## 1.15.1 (2026-10-10)

### Faster with long sessions and long use
- **Long chats load in pages:** a session opens with its newest messages; older ones load as you scroll up (or with "Show earlier messages"), and the message you're reading stays in place. On a 13,000-event session: opening went from 8.7 s to 1.7 s, the tab's memory from 143 MB to 24 MB.
- **A memory leak is fixed:** leaving a session while its message box had focus kept the whole previous chat in memory, so a tab got slower the longer it was used. After hours of streaming and switching, the tab now returns to its baseline.
- Messages are no longer re-rendered as Markdown on every live update; typing in a long chat costs less than half as much.
- The server no longer re-reads a session's whole history for loop cards and other derived views on every event (half the work per event on a large session), caches hot results, and tidies its database when idle.
- Note: the browser's ⌘F finds only messages that are loaded.

## 1.15.0 (2026-10-10)

### Loops run by Switchboard
- Agents create recurring or scheduled work through the `switchboard` MCP tools instead of the CLI's own cron: `loop_create` (a cron expression, every N minutes, or once at a time; optional expiry and run limit), `loop_list`, `loop_update`, `loop_pause` / `loop_resume`, `loop_cancel`. Switchboard fires the prompt into the session as a normal message ("⟳ label · run n"): queued behind a running turn, never stacked (a firing still waiting skips the next one, counted), no catch-up burst after downtime, no expiry unless you set one. Loops survive process restarts, continuing a terminal session in Switchboard, fresh-session continuations and take-overs.
- Schedules & loops and the session show them with the exact next run, expiry, runs and skips, and **Pause / Resume**, **Run now**, **Edit**, **Cancel**; create your own with **+ New loop** or the session's ⋯ → New loop…. The default standing instruction tells agents to use them.
- Loops the CLI manages itself (`/loop`, `CronCreate`) keep their cards, tagged "Managed by the CLI".

### Unlisted schedules
- Turns the CLI starts by itself with no visible job (e.g. a cron job carried into a resumed process) now get an "Unlisted schedule in the CLI" card: how often (estimated), the last run, the count and an expected next time; it disappears when the series stops or the process ends.

### Database
- Migration 0041 runs by itself on first start.

## 1.14.1 (2026-10-09)

### Fixed
- **Schedules & loops showed loops that no longer exist.** A cron job cancelled with `CronDelete` ("Cancelled job <id>") now disappears; recurring jobs past their 7-day auto-expiry and jobs that died with an earlier process of the session (e.g. after continuing a terminal session in Switchboard, a resume or a restart) are no longer listed; a one-shot disappears once it fired. Events are read in time order, so a cancel is never applied before the job it cancels. A "No scheduled job" answer no longer ends an unrelated job. Stale cards are removed on the first start after the update (update every paired machine: each derives its own sessions' loops).

## 1.14.0 (2026-10-09)

### Drafts follow you
- Unsent text is kept per session on the server: the message box (with uploaded attachments), question cards' picks and "Other…" answers, the review card's Send-back comment and Commit message, the todo + Add and Edit forms, and (per machine) the New-session form. It survives switching sessions and reloads, and shows on your other devices; a field you're typing in is never overwritten by another device. Sending, saving or Clear removes a draft, and drafts whose question, review or todo is resolved elsewhere are cleaned up at once.

### Artifacts are saved on purpose
- Like artifacts in claude.ai: agents save deliverables with the new `artifact_save` tool (Markdown, code, HTML, Mermaid, SVG, images, CSV), with versions; `artifact_list` / `artifact_get` read them. You can save an agent message or a code block yourself (⋯ → Save as artifact).
- The session's Artifacts tab and the Artifacts page show only these: rendered or source, a diff between versions, Copy, Download, Full screen, Delete. HTML and Mermaid diagrams render in a sandboxed frame that can't reach your login. A solution's page lists its sessions' artifacts, and Clean-up offers artifacts whose session is gone.
- The automatic rows (every diff, branch, PR and written file) are gone.

### Diff since the last commit
- The Diff tab shows the session's uncommitted changes since the last commit by default; for a session working directly in a folder, only the files that session touched (someone else's edits are left out). **Whole branch** and **All uncommitted changes in this repo** are a click away, remembered per session; the tab count follows the view, and hunks are separated.

### More
- **Apply to open sessions** (Settings → Sessions & worktrees → Standing instruction): a changed standing instruction reaches the sessions already open — idle ones restart their CLI with the same conversation, busy ones right after their turn. Per session: ⋯ → Reload instruction.
- **Copy** on every code block in the chat.

### Database
- Migrations 0038–0040 run by themselves on first start.

## 1.13.0 (2026-10-09)

### Work queue: run todos, review, undo
- **Run a todo in its own session** (▸ Run in new session, or several at once): a fresh session in its own `todo/<slug>` worktree, cut from the source session's branch (in a workspace, one worktree per solution repo), with the item's handover plan as its first message. Its agent can only touch that one item. Same CLI, model and account as the source, unless a **Model by task** rule says otherwise.
- **Review cards:** when a session with changes goes idle, a Review card appears in the Inbox and on the session header: the files changed, unmerged commits, the agent's summary and whether tests ran. **Merge** (locally), **Open PR**, **Commit** (for sessions working directly in a folder), **Send back** with a comment, **Discard**, **Clean up** the worktree. Agents are never blocked from committing themselves; a card whose changes the agent handled itself closes as "Handled by the agent". A todo run in its own session goes to **Review** when it's marked done and follows the card's outcome.
- **Undo a turn:** a checkpoint of the working tree is saved before each message (hidden git refs; your index, branch and files are never touched). **Revert to before this turn** on any of your messages (or ⋯ → Undo last turn) puts the files back, also moving the branch back when the agent committed and nothing was pushed; **Redo** undoes the revert. The agent is told. Kept 7 days / 100 turns.
- **Todos board:** Open · In progress · Review · Done across all sessions, with filters and search; drag to change a state (swipe between columns on phones).
- **Estimates vs actuals:** each item records how long it really took and the tokens used ("est ~45m · took 32m · 58k tokens"); agents see their recent estimate accuracy.

### Faster, cleaner
- **Quick capture:** `todo …` in ⌘K, **Add to todo** on text selected in the chat, and the Android share sheet (paired devices). The session's agent fills in the description, plan, priority and estimate at its next idle moment.
- **Model by task:** rules in Settings → Sessions pick the CLI, model, effort and account for todo runs by priority and estimate ("low ≤30 min → Sonnet").
- **Fresh session when the context fills:** at 80% (adjustable) an offer to continue in a fresh session: the agent writes a handover, a new session takes over the folder, branch, sidebar place and todos, and the old one closes, linked.
- **Clean-up** (Settings → Clean-up): merged or stale worktrees, Switchboard's own branches, closed sessions older than 30 days and old data files, with a preview first; remote branches only when ticked one by one.
- **Quick replies are gone;** 📎 sits next to Send, and the chat gets the room.

### Tutorial
- A spotlight **tour** of Switchboard on first start, and short **What's new** tours for features you haven't seen after an update. Replay from Settings → Tutorial or ⌘K.

### Fixed
- The session header no longer runs under the right panel in narrow windows: actions that don't fit move into a ⋯ menu ("Move to <machine> ▸" shortens to "Move ▸" first).
- No system notifications on a phone or tablet while Switchboard is open on it; they show as in-app toasts instead (also for permission requests, finished turns, errors and review cards).
- Typing in a long conversation is much faster on phones.
- "+ Add" in the todo strip: an item typed while the previous one was saving no longer loses repeated fields (e.g. its estimate).
- On touch screens the message field is the intended 44 px tall.

### Database
- Migrations 0032–0037 run by themselves on first start.

## 1.12.0 (2026-10-08)

### Todo items in progress
- **▶ Start sends the task right away** (queued if the agent is busy) instead of filling the message box, and marks the item **in progress**; a draft you typed is left alone. On the Todos page it sends without leaving the page (a toast offers **Open**).
- **In progress** is a new state between open and done: a ◐ half-filled box, an **IN PROGRESS** label next to the priority, and an edge that pulses while the session works. Set it with ▶ Start, from the card's ⋯ menu (**Mark in progress** / **Mark not started**), or by the agent with the new `todo_start` tool. Several items can be in progress; the list keeps its priority order.
- Agents must mark a started item done: the start message, the tool descriptions and the standing instruction say so, and when a turn ends with a started item still in progress and untouched, Switchboard sends the agent **one** reminder for it (Settings → Sessions → "Remind the agent to finish started todos", on by default).
- Counts: "1 in progress · 2 open · ~2h · 0 done"; the sidebar count and the estimate total include items in progress.

### Fixed
- Esc in a todo card's ⋯ menu only closes the menu; it no longer also stops the running turn.

### Database
- Migration 0031 (todo in-progress state) runs by itself on first start; existing items keep their state.

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
