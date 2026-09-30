# Developer decisions (2026-09-27)

Rulings made by the developer at kickoff, on top of `docs/handoff/`. **Where this file and the handoff differ, this file wins.** Agents cite these by number in `.loop/questions.md` and commit messages when relevant.

## Run
- **D1 Scope & gates.** One unattended run over M0–M9. The M0 review stop and per-milestone review stops are waived; the developer reviews everything in the morning. Local commits per green item; never push, open PRs or merge.
- **D2 Escalation: assume, flag, continue.** On ambiguity pick the most conservative reversible option, log it in `.loop/questions.md` as `ASSUMED (item, decision, why, how to revert)`, keep going. An item red after 5 attempts is `BLOCKED` and skipped with its dependents. The run stops after 3 consecutive BLOCKED items. Hard stop for anything touching the machine outside the repo beyond D12.
- **D3 Execution shape.** M0–M2 run one item at a time. M3–M8 run in parallel worktree lanes merged back to `main` after each wave. M9 runs last on the merged result.

## Stack
- **D4 Node.js, one project.** TypeScript (strict) + React/Vite + Fastify, one `package.json`, one process on 127.0.0.1:4870. Built-in `node:sqlite`. Vitest + `@playwright/test`. No .NET, no microservices, no code outside this repo.
- **D5 `/hub` = Server-Sent Events.** Same event names and payloads as the contract; client → server stays REST. (`contracts/local-api.md` updated.)

## Runtime behavior
- **D6 Permissions.** Sessions start in the auto permission mode the developer uses interactively if M0 proves it works headless, otherwise `acceptEdits`. Remaining permission requests appear in the Inbox as *Allow once / Deny* with tool + input verbatim. Hooks, if needed, are passed per session via `--settings <Switchboard-owned file>`; workspace/user settings files are never edited.
- **D7 Pause & restart.** Pause interrupts the current turn and stops the process (status paused). Resume = `--resume <id>` + "Continue.". On service restart, sessions that were running are resumed automatically with a note that Switchboard restarted.
- **D8 New scheduled run.** "+ New scheduled run" opens the New-session modal with a 7th *Schedule* section: cron field, readable preview ("02:00 daily"), next 3 run times; button "Save schedule"; stored as a template; Edit reopens it prefilled.
- **D9 Loop cards.** Iteration / next firing / expiry from observed `/loop`, ScheduleWakeup, CronCreate and Workflow events. Cap + breaker from `.loop/progress.md` in the session's working folders if present (LOOP.md format), else "—". Never invented.

## Verification
- **D10 Visual oracle.** Gate = SPEC token computed-style checks + key box sizes/positions within ±2px + exact copy + an agent's side-by-side review. Pixel-diff % recorded in `docs/visual/`, advisory only.
- **D11 Real CLI in M0.** `claude -p` probes only with `--model haiku`, `--max-turns` ≤ 3, cwd = gitignored `.spike/sandbox/`. Hooks tested via `--settings <repo file>`. (These write transcripts to `~/.claude/projects/` — accepted.)
- **D12 Allowed outside the repo.** npm cache / `node_modules`; Playwright Chromium in `~/Library/Caches/ms-playwright` if the cached one doesn't match; the D11 probes; one final **read-only** smoke run that scans the real workspace (no sessions started, nothing written there). M9 service files are generated and dry-run tested, never installed.

## Full implementation (added after launch, same night)
- **D13 Full implementation, not a UI over demo data.** The developer wants the whole product working. **This ruling overrides any item-brief wording that suggests rendering from demo data or leaving wiring for later.**
  - In normal runs every view and action goes through the real services and the real API: real `claude` processes via the SessionSupervisor, real git/gh via the WorktreeManager, real workspace scanning, real transcripts, the real scheduler, real system metrics, and `/hub` events emitted from real state changes.
  - The demo seed (gap #21) is data only. It loads into the same DB, or feeds alternate implementations of the same provider interfaces, selected only when `SWITCHBOARD_DEMO=1`. Normal code paths never read demo data. Nothing from the prototype's mock data (session names like `free-talk-feature`, fixed counts, badges, timestamps) is hard-coded in `src/` outside `src/server/demo/`.
  - Every item's oracle includes at least one **non-demo** test that drives the real code path end to end: fake-claude as the CLI binary, temp git repos with a fake `gh`, and a fixture workspace in a temp dir. A screen that passes only with demo data is not green.
  - A lane that needs an endpoint another lane builds in the same wave codes against the contract and leaves a test that fails until the merge. The merge step must wire it for real, with no demo fallback, and make that test pass; otherwise the item goes into brokenItems.
  - **Final verify** adds three checks:
    1. A **real-path E2E scenario** with no demo seed and fake-claude: create a session from the New-session modal (with a worktree in a temp repo) → the chat shows streamed events → a question batch reaches the Inbox with a toast → answering it continues the process → Pause / Resume → Detach shows the resume command → Attach → the Diff tab shows the worktree change → a schedule's "Run now" starts a session → History lists it.
    2. A **real-CLI smoke** within D11. The built app runs with `SWITCHBOARD_WORKSPACE_ROOT` set to a fixture workspace under `.spike/sandbox/`, and uses the real `claude` on Haiku with `--max-turns` ≤ 3, passed through a dev-only extra-args env var. It starts one session with a harmless prompt that makes it ask one AskUserQuestion, and answers it through the Inbox UI. The result is recorded in the delivery report.
    3. A grep audit confirming no prototype mock strings in `src/` outside `src/server/demo/`.

## Folders per session (added 2026-09-28)
- **D14 Every session picks its folder; no env var.** There is no single workspace root and no `SWITCHBOARD_WORKSPACE_ROOT` any more (remove it from config, docs, the service files and every test helper; a test sets its folders through the database or the API like a user would). **This ruling overrides earlier wording that assumes one configured workspace root** (ARCHITECTURE, M5.3 wizard, M6.x, M7.4, M8.1, M8.2, gap #18's "workspace root" setting).
  - **A folder is a workspace or a git repo.** *Workspace* = a folder with a router `AGENTS.md` that is not itself a git main checkout (today's Acme workspace): many solutions, router folder rules. *Repo* = a git main checkout (a single solution; a repo's own `AGENTS.md` does not make it a workspace). Anything else is refused with a clear message (422 on the API).
  - **Saved folders (Settings).** Settings → *Workspace & solutions* becomes *Folders*: the saved list (path, kind, check line such as "✓ AGENTS.md (Workspace Router) · 38 solutions" or "✓ git repo · single solution", or what is wrong), **Add…** (Browse…, the setup wizard's folder picker), **Remove**, and one marked **default**. Stored in SQLite. A previously saved `setup.workspaceRoot` is migrated into the list as the default. The first-run wizard's root step becomes "Add your first folder" (skippable).
  - **New-session form (and "New scheduled run", same form).** A **Folder** row at the top of the form: a dropdown of the saved folders (the default preselected, then most recently used) + **Browse…** (a new folder is added to the saved list) + the check line. Changing the folder re-reads its solutions, so the chips always belong to it. **Workspace folder:** the form as today (router session-start sections), the session runs at the folder root so the router applies. **Repo folder:** the form keeps Task, Worktree and Ultracode, hides work type / mode / phase / coordination / QA (router-only) and shows the repo as the one locked solution; the session runs in the repo, or in its worktree (`../{repo}-wt-{name}`) when Worktree is on; the first message carries only the worktree note (no router answers). The live summary shows the folder and the cwd.
  - **Sessions remember their folder** (and cwd); resume, restart recovery, terminal handoff, worktrees, diffs, artifacts, loops (`.loop/progress.md`), the first-turn payload and schedules (the template stores the folder) all use the session's own folder, never a global root.
  - **Views across folders.** Solutions and the Codebase Memory strip show **one folder at a time with a folder switcher** in the header (the default first, then the other saved folders and any folder an open session uses). A repo folder shows as one solution. The sidebar, Inbox, History, Artifacts and Schedules list sessions from every folder, each tagged with its folder. History reads the transcripts under every saved folder and every session's folder.
  - The contract gains additive fields/routes for this (record them in `contracts/local-api.md` as additive): folder routes, `folder` on NewSession / Session / schedule templates, and `?folder=` on `GET /api/solutions` (default folder when omitted).

## Embedded tools and terminal conversations (added 2026-09-28)
- **D15 Embedded tools through a local framing proxy.** Some tools refuse to be framed (the Codebase Memory UI sends `Content-Security-Policy: … frame-ancestors 'none'`), so the iframe stays blank. Switchboard serves each configured tool through its own **loopback-only reverse proxy on its own port** (127.0.0.1, OS-assigned, one per tool, restarted when the tool's URL changes) and the iframe loads the proxy (`frameUrl`, additive on `Tool`). The proxy forwards method, path, query, body and headers unchanged (WebSocket upgrades too), with these exceptions only: the response's `X-Frame-Options` is dropped and its CSP `frame-ancestors` is replaced by Switchboard's own origins; `Location` headers pointing at the tool are rewritten to the proxy; the request's `Host` is the tool's; **Switchboard's `sb_token` cookie is stripped** before forwarding (cookies ignore ports); requests with a foreign `Host` are refused (DNS rebinding). *Amendment 2026-09-28:* an `Origin` / `Referer` naming the proxy itself is rewritten to the tool's origin, because the real Codebase Memory UI answers 403 to any foreign `Origin`, even on its own module scripts; any other `Origin` passes unchanged. It only ever forwards to the configured tool URL. Because it runs on its own port, the framed tool is a different origin and cannot use Switchboard's API (the Origin guard refuses it). "New tab" still opens the tool's own URL. If framing fails anyway, the overlay says so and offers New tab (the prototype's copy).
- **D16 Move terminal conversations into Switchboard.** A conversation started in a terminal (History lists it from the transcripts) can **continue in Switchboard as the same conversation**: Switchboard creates a session bound to the transcript's Claude session id, imports its history into the chat (the Attach-here import), and spawns `claude --resume <id>` under supervision with no new message (idle, waiting for you). `claude --resume <id>` keeps working later. While the terminal may still have it open (transcript changed < 2 min ago, or `claude agents --json` lists it live) the move warns and needs a confirm (two live processes on one id split the transcript, M0.4).
  - **Where:** History rows of terminal conversations get **Continue in Switchboard**, with checkboxes and **Move selected (n)** for several at once; the New-session form gets a **Resume a terminal conversation** option listing the chosen folder's terminal conversations not in Switchboard yet (picking one replaces the task; Start moves it).
  - **Folder:** the session's folder is the saved folder that holds the conversation's start folder. If none does, the move offers to **add** the workspace or repo it sits in (D14 rules) and continues; otherwise it is refused with the reason.
  - **Name:** from the conversation's title (else first prompt), kebab-case, made unique. Moved sessions have no session-start answers (work type / mode / phase stay empty) and get no first message.

## Footer meters (added 2026-09-28)
- **D17 RAM as Activity Monitor counts it; Session + Week usage bars.** `ramUsed` = memory actually in use, not `total − free`. On macOS: app memory + wired + compressed from `vm_stat` (anonymous − purgeable pages, wired, pages occupied by the compressor, × the page size), the way Activity Monitor's *Memory Used* counts it; on Linux `MemTotal − MemAvailable` from `/proc/meminfo`; on Windows `totalmem − freemem`. Read asynchronously and cached between `system` ticks; if the read fails, fall back to `total − free` and say so in the docs. The footer's single "Max" bar becomes **two rows**: **Session** (the 5-hour window) and **Week** (all models), each with its bar, % and the time until it resets. A model-specific weekly limit (e.g. Fable) gets a third row only while it is in use (above 0% or active). The 90% warning applies to each window. `/api/system` keeps `usagePct` (the higher window, M9.2) and gains additive per-window fields. Unknown stays unknown (never guessed).

## Folder names (added 2026-09-28)
- **D18 A saved folder can have a name of its own.** Optional, set when adding a folder (a Name field in the add panel: Settings → Folders → Add…, the form's Browse…, the wizard) and changed later with **Rename** in Settings → Folders. Trimmed, at most 40 characters, unique among saved folders (case-insensitive; a taken name is refused with a clear message); an empty name resets it to the folder's own name. The folder's own name (its last path segment) is unchanged underneath, since worktrees are named after it (`<repo>-wt-<session>`); the custom name is a label (`Folder.label`, plus `displayName` = label, else the folder's name). It is shown wherever a folder is shown: the New-session form's Folder dropdown, Settings → Folders (with the path under it), the Solutions and Codebase Memory folder switchers, and the folder tags on sessions (sidebar, Inbox, History, Artifacts, Schedules). The path stays visible next to it (second line or tooltip) so two folders are never confused.

## Live activity (added 2026-09-28)
- **D19 See that an agent is working, like in Claude Code.** While a session's turn runs, Switchboard shows what it is doing now, how long it has been at it, and (while thinking) the estimated thinking tokens, live, from what the CLI already streams (no new CLI flags): `system/thinking_tokens` ticks → thinking; an `assistant` `tool_use` → that tool is running until its `tool_result`; an `assistant` text block → writing; an open question / permission request → waiting for you; the turn's `result` → idle. Subagent lines (`parent_tool_use_id`) give each agent its own current action.
  - **Chat:** a Claude-Code-style line above the composer while a turn runs: an animated spinner glyph, a **playful verb that rotates while thinking** ("Pondering…", "Noodling…", "Cogitating…"; Switchboard's own list), the time since the turn started (`1m 23s`) and `↓ 1.2k tokens` when known; a running tool reads literally, `● Bash: npm test  0:42` (time since that tool started); "Waiting for you" while a question is open. Hidden when idle.
  - **Sidebar:** a running session's row shows its current action and time under the name (in place of the mode line while it runs), with a pulsing status dot.
  - **Right panel:** each agent card (subagents included) shows what that agent is doing now and for how long.
  - Tool summaries are short and literal: Bash → the command's first line; Read / Edit / Write → the file name; Grep / Glob → the pattern; Agent / Task → its description; WebFetch → the host; anything else → the tool name. Idle sessions look exactly as before (the prototype's states are unchanged).

## Agent overview (added 2026-09-28)
- **D21 Every session shows an agent overview in the right panel.** The developer wants to see what each agent is doing without waiting for the agent to print a status table. The overview always has two parts, and the second shows only when the agent printed a table (the developer's ruling: derived + printed tables).
  - **Derived table, always shown:** Switchboard builds a table with the columns **Agent · Description · Solution · Status** from what it already knows. There is one row for the main agent and one for every Agent / Task subagent, in the order they started (`Session.agents`: `name`, `description`, `solutionPath`, `status`, `statusText`). The Solution column shows the solution's folder name; Status is D19's live action and time while the agent works (`● Bash: npm test 0:42`, `Pondering… 1m 23s`, `⏸ waiting`), else its status (`✓ done`, `✕ failed`, `asked 1`, …).
  - **Printed table, when there is one:** the newest status table the agent printed in chat is repeated under the derived table, headed "As reported by the agent · <age>". A status table is a box-drawing or GFM pipe table whose header has an Agent column and a Status column. It covers agents Switchboard cannot see, such as Workflow-internal ones. It is shown as printed: a box-drawing table in monospace like a chat code block, a pipe table through the D20 renderer. It is updated when a newer table arrives and never edited.
  - Both parts are derived on the fly from the session's agents and its chat, with no new CLI flags. Sessions with only the main agent still get their one-row table. The existing agent cards stay. The prototype's right panel keeps its boxes; the overview is an addition and is checked on its own.
  - **Developer rulings (2026-09-28):** (1) a finished agent that has its own status text shows that text, not `✓ done`, as its card does; (2) the main agent's **card** also thinks with the chat line's rotating verb, so the chat line, the overview and the card read the same (a subagent still reads `Thinking…`); (3) the column widths stay 24 / 27 / 20 / 29 %, with the full solution path as the tooltip.

## Markdown in chat (added 2026-09-28)
- **D20 Chat messages render as Markdown.** Both the agent's and the developer's messages render as GitHub-flavored Markdown (headings, emphasis, lists, task lists, tables, block quotes, inline code, fenced code blocks, links, horizontal rules). Fenced code blocks get **syntax colors** (a highlighter dependency is accepted for this), themed from the SPEC tokens on the code background; box-drawing tables (agents' status tables in code fences) keep their monospace alignment. Raw HTML in messages is **never** rendered (shown as text); links open in a new tab with `rel="noopener noreferrer"`; images are not loaded (shown as links). Plain text without Markdown looks exactly as before (the prototype's bubbles and agent text keep their size, spacing and colors), so the visual oracle stays green. *Developer addition 2026-09-28:* a pasted bare link becomes a hyperlink, in the developer's messages and the agent's: bare `http://` / `https://` URLs and `www.` links (GFM autolink literals) follow the same link rules (new tab, `rel="noopener noreferrer"`, only http(s) / mailto kept); trailing punctuation is not part of the link; a URL inside inline code or a code block stays text; long URLs wrap instead of widening the bubble. The composer field stays plain text (the link appears once the message is sent). *Developer rulings 2026-09-28:* the larger UI bundle (723 kB, Vite's "> 500 kB chunk" warning) is accepted as is, with no code splitting and no raised limit; Switchboard's own service notes and the task bubble render as Markdown like every other message; code blocks highlight lowlight's common set (37 languages).

## Weekly pace (added 2026-09-28)
- **D23 The Week bar shows whether usage is on pace.** A week's allowance is spread evenly over its 7 days, 100 % ÷ 7 ≈ 14.29 % per day, counted from the weekly window's own reset time (from `seven_day.resets_at`: the window started 7 days before it; e.g. a Thursday 15:00 reset gives days Thu 15:00 → Fri 15:00 … Wed 15:00 → Thu 15:00). **Days start at the reset hour** and each day's share is available from the start of that day: during day *n* (1–7) the allowance is *n* × 100 / 7 % (day 4 → 57.14 %, day 5 → 71.43 %, day 7 → 100 %). The Week bar is **green while usage is below the allowance and yellow at or above it** (the SPEC status colors: done / need), and a thin marker on the bar sits at the current allowance; the tooltip says e.g. "On pace: 33 % of 57.14 % allowed until Mon 15:00" (*superseded by the continuous ruling below: the allowance grows by the minute, the tooltip reads "… until 15:00"*). It follows the reset time whenever it moves; unknown usage or reset stays unknown (no color, no marker). The Session bar and model rows are unchanged. The 90 % warning (M9.2) is unchanged.

## Session titles (added 2026-09-28)
- **D22 Sessions have human-friendly titles and can be renamed.** Every session keeps its technical short name (`name`, kebab-case, unique): the worktree folder (`../{repo}-wt-{name}`) and branch (`session/{name}`) are built from it, so it never changes after the start. On top of it, a free-text **title** (trimmed, 1–80 characters, e.g. "JIRA Ticket handling"; not required to be unique) is what the UI shows everywhere a session is named: sidebar, session header, Inbox, toasts, History, Artifacts, Schedules' runs, the palette (which searches title and name). Without a title the name is shown (older sessions unchanged).
  - **New-session form:** the name field takes free text as the title; the short name is derived from it (lower-case, runs of anything but letters and digits → `-`, trimmed, at most 64 characters) and shown in the live summary (branch and worktree lines); when that short name is taken, `-2`, `-3`, … is added. The contract's `NewSession` gains optional `title` (additive); `name` keeps its rules.
  - **Rename:** click the name in the session header (inline edit; Enter saves, Esc cancels) or double-click it in the sidebar; `PUT /api/sessions/{id}/title { title }` (additive). Only the title changes; the name, branch and worktree stay. The next process spawn passes the title as `--name` (the CLI's display name).
  - **Moved sessions (D16)** take the conversation's title as their title (their short name is still derived from it). **Scheduled runs** get the schedule's name as their title.
  - **Developer rulings (2026-09-28)**, on the questions the implementation raised:
    1. *Conflict card: show the title.* `ConflictSession` gains `title` (string | null, additive); the Solutions conflict card and its "Move … to worktree" button name the session by its display title. Worktree paths and branches stay derived from the short name.
    2. *Kebab-case text: store it as a title too.* Text in the New-session name field that already is a valid short name (e.g. `free-talk-640`) is posted as the title as well, so every session created from the form gets a title, even when it equals the name.
    3. *Move with a typed title: accept free text.* With a terminal conversation picked (D16), free text in the name field is accepted: it becomes the moved session's title and its short name is derived from it by the new-session rules (slug, `-2` / `-3` on collisions). With the field empty the move keeps D16 (the conversation's title). The continue route gains an additive `title`.
    4. *Branch owner in Solutions: show the title.* `SolutionBranch` gains `ownerTitle` (the owner session's display title, `null` when the branch has no session; additive). The Solutions detail's branch cards and chips name the owner by it, with the short name in a tooltip. Branch and worktree names are unchanged (supersedes `ASSUMED D22-branch-owner`).

## Remote sessions (added 2026-09-28)
The read-only spike (`docs/spike-remote.md`) found no headless way to list or stream cloud sessions today. The developer chose designs **A** and **C** from it and will test them live on their own Switchboard once they are built: the live probes P1–P7 were not run. Tests use fake-claude only. Both features rely on CLI paths the spike read in the code but never ran, so every failure the CLI reports is shown to the developer verbatim and nothing is retried silently.
- **D24 Reachable from phone (Remote Control on Switchboard's own sessions).** Design A.
  - A **Remote** toggle in the session header, off by default. Turning it on sends the stdin control request `{"subtype":"remote_control","enabled":true,"name":<display title>,"keep_session_on_exit":true}` on the supervised process. The reply's `session_url` and `bridge_session_id` (`cse_…`) are stored on the session. Turning it off sends `enabled:false`, which ends the bridge, and keeps the stored id for later reattach.
  - While it is on, a popover shows the claude.ai link (open, copy) and a **QR code** of it for the phone. One small zero-dependency QR library, pinned exactly, is accepted for this. The popover also notes: "While Remote is on, the transcript is stored on Anthropic's servers."
  - The toggle is enabled only while the session's process is live and its `initialize` reported `remote_control_available: true`. Otherwise it is disabled and its tooltip gives the reason. An error reply shows its text and leaves Remote off.
  - Remote stays on across pause/resume and restart recovery (D7). After the new process's `initialize`, the service re-enables with `reattach_session_id: <cse_…>`, so the claude.ai entry stays the same.
  - A running session with Remote on shows a small phone glyph in its sidebar row.
  - A question or permission request answered on the phone arrives as `control_cancel_request`. It closes the Inbox batch as before (M0.2), now labelled "answered on claude.ai". Messages typed on the phone appear in the chat however the CLI streams them (unverified: P2 when the developer tests).
  - History marks terminal conversations whose transcript has a `bridge-session` line with a "Remote Control" badge.
  - *Implementation note 2026-09-28:* the QR library is **`uqr` 0.1.3** (exact pin; MIT; no dependencies; a 27.5 kB ESM build). Only its `encode` is used; the code is drawn as SVG with React elements. Details and the choices made where D24 is silent: `docs/remote-control.md`, `.loop/questions.md` → *D24*.
- **D25 Continue a remote session locally (teleport).** Design C.
  - The New-session modal gets a **"From a remote session"** option. The developer pastes a claude.ai/code URL or a `session_…` / `cse_…` id, from the cloud or from Remote Control on another machine, and picks a **repo** folder. Workspace folders are refused, because teleport needs a checkout of the session's GitHub repo.
  - Switchboard creates a dedicated clean worktree of that repo (`../{repo}-wt-{name}`, as D14 does for repo sessions). It runs `claude -p --teleport <id> --input-format stream-json --output-format stream-json …` there, with the usual permission flags. The CLI fetches and checks out the session's branch in that worktree.
  - Switchboard learns the local copy's session id from the stream's `system/init` and supervises it like any other session; later resumes use `--resume`. The session records its remote source id, and the worktree records the branch the teleport checked out.
  - The session's title is what the developer typed, else `Remote <short id>`. The header and History say "local copy of a remote session: new work here stays local".
  - Every CLI refusal is shown verbatim and the worktree Switchboard created is removed: a dirty tree, the wrong repo ("You must run claude --teleport <id> from a checkout of <owner/repo>"), a branch that isn't pushed, not signed in, or an archived session.

## Chat composer and the reported table (added 2026-09-28)
- **D26 Shift+Enter makes a new line in the chat composer.** The composer becomes a multi-line field. Enter sends; Shift+Enter inserts a line break. While an IME is composing, Enter never sends. The field starts one line high, looking exactly like the prototype's input, and grows with its text up to about 8 lines, then scrolls. It shrinks back after a send. Messages keep their line breaks, and D20 renders them as Markdown.
- **D27 The reported status table is shown as a readable table, not as printed.** This replaces D21's "shown as printed, never edited".
  - The newest status table the agent printed is parsed into its header and rows. That covers a box-drawing table (columns split on `│`; rows split on `├…┤` lines; a row spanning several text lines has each cell's lines joined) and a GFM pipe table (inline Markdown reduced to text).
  - It is drawn like the derived overview table above it: same type, lines, header and cell ellipsis, with the full text as a tooltip. It keeps all the printed columns, in their order.
  - The Status cell shows a SPEC status color dot plus the text, with any leading status emoji or glyph removed. `🟢`, `running`, `testing` and `in progress` are run (blue); `✅`, `✓`, `done`, `merged` and `green` are done (green); `🟡`, `⏳`, `⏸`, `queued`, `waiting`, `blocked` and `needs` are need (amber); `❌`, `✕`, `🔴` and `failed` are fail (red); anything else is idle (muted).
  - A small "as printed" toggle shows the original text in monospace, as D21 did.
  - A table that can't be parsed into consistent rows falls back to the printed text.
  - **Developer rulings (2026-09-28):** the right panel never scrolls sideways (D29), so "as printed" opens in a popover over the main area, which may cover the sidebar for wide tables; a table that can't be parsed shows only a one-line note in the panel, with the original behind "as printed"; the status glyphs also include `✔` (done), `✖` and `✗` (failed), `🔵` (running) and `🟠` (waiting).

## Signed-in sites in a frame (added 2026-09-28)
- **D28 Signed-in SaaS tools (Jira) open in a direct frame through a Switchboard browser extension.**
  - **Why:** the D15 framing proxy serves a tool as `http://127.0.0.1:<port>`, so a site such as `https://acme.atlassian.net` gets none of the developer's login cookies (they belong to `.atlassian.net`). It then sends the frame to `id.atlassian.com`, which answers `X-Frame-Options: DENY`. A direct frame is refused because Jira's `frame-ancestors` lists only Atlassian's own sites.
  - **The extension:** a small Manifest V3 WebExtension in this repo (`tools/frame-helper/`) with `declarativeNetRequest` rules. It removes `X-Frame-Options` and `Content-Security-Policy` from the response, **only** for `sub_frame` requests whose initiator is a loopback page (`127.0.0.1` / `localhost`), i.e. frames inside Switchboard; every other site keeps its protection.
  - **Browsers:** Chrome and Chromium browsers load it unpacked. Safari gets the same sources wrapped by Apple's `safari-web-extension-converter` into a local macOS app (Xcode is installed), built by a script in the repo.
  - **Safari login cookies:** Safari blocks cookies in cross-site frames. The extension offers a one-time "Allow Jira here" button inside the frame that calls `document.requestStorageAccess()` (Storage Access API; Safari needs Jira to have been used in a normal Safari tab within 30 days). If Safari refuses that, the documented fallback is Safari → Settings → Privacy → "Prevent cross-site tracking" off, which is the developer's call.
  - **Switchboard side:**
    - The extension announces itself to Switchboard's page (a content script on loopback pages sets a marker with its version).
    - With the marker, a tool whose URL is a non-loopback `https:` site opens in a **direct** iframe of its own URL, with no proxy. Local tools keep the D15 proxy.
    - Without the marker, such a tool shows "{host} needs the Switchboard frame helper to open here" with **Open in new tab** and a link to the install steps (`docs/frame-helper.md`).
  - **Tests:** automated tests load the unpacked extension into Playwright's Chromium against stub sites that refuse framing. The developer verifies Safari and the real Jira live.
  - **Developer rulings (2026-09-28), after the build:**
    - **Safari:** Safari's `declarativeNetRequest` never applies response-header rules (WebKit, MDN), so no Safari extension can frame Jira. Safari shows "{host} can't open in a frame in this browser" with Open in new tab, as built; a capability check makes sure a frame is never blank. Use Chrome for sites in a frame.
    - **Narrowed scope:** the helper removes the two headers only for the hosts of the developer's saved **site tools**, and only in the browser tab that runs Switchboard, not for any loopback page. Switchboard's page gives the extension its site-tool hosts; the extension keeps them as tab-scoped session rules (Chrome `declarativeNetRequest.updateSessionRules` with `tabIds` + `requestDomains`). The static any-loopback rule goes away.

## Side panels never scroll sideways (added 2026-09-28)
- **D29 The sidebar and the session's right panel scroll down only, never sideways.**
  - **Sidebar TOOLS rows:** the name always shows in full on the first line. A URL that doesn't fit beside it moves to its own line, right-aligned as in the prototype, and is cut with … there; the full URL is the tooltip. The prototype instead wraps a long name next to its URL, so the full visual pass compares these rows' name and URL boxes by copy and styles only, and `tools.spec` checks the ruled layout.
  - **Right panel:** `overflow-x: hidden`. Agent names wrap as in the prototype. Paths, descriptions and terminal lines are cut with …. A branch chip keeps its width up to 60% of its row, then is cut with …. Name, description, path and branch carry their full text as a tooltip.

## Background work and live model choice (added 2026-09-28)
- **D30 A session waiting on background work shows that it is still working.**
  - **Why:** agents often wait for a GitHub Action (or a build, a subagent or a timer) by starting a background task and ending their turn: `Bash` with `run_in_background: true` (result "Command running in background with ID: <id>"), an async `Agent` ("Async agent launched successfully"), `Monitor`, `ScheduleWakeup`. The CLI process stays alive and continues by itself when the task ends, but Switchboard only saw the turn end and showed the session as idle.
  - **Tracking:** Switchboard tracks each such task from its `tool_use` / `tool_result`. It stays pending until the CLI reports its end on stdout: a `system/task_notification` line with `task_id`, `tool_use_id`, `status` and `summary` (verified by a real probe; the `<task-notification>` user message exists only in the transcript), or until the process exits or is paused.
  - **Display:** while any task is pending and no turn runs, the session counts as working in the background. It shows in:
    - the chat's activity line: `⏳ Waiting for GitHub Actions: gh run view …  3:21`, or `⏳ Waiting for a background task: <summary>`, or `⏳ Waking up at 18:40`;
    - the sidebar row: the action and time, with the running dot pulsing;
    - the agent cards.
    A command that uses `gh run`, `gh pr checks` or `gh workflow` reads "Waiting for GitHub Actions".
  - Pending tasks are additive on `Session.activity`: the D19 shape gains the list of pending tasks, and a `background` state when no turn runs.
- **D31 Model and effort can be changed while a session runs.**
  - The session header gets a **model** picker and an **effort** picker. The choices come from the CLI: the models its `initialize` reports, and the effort levels the chosen model supports.
  - A change applies to the running process through the CLI's control protocol (a `set_model` control request and the effort equivalent, verified against the installed CLI). It takes effect from the next turn and shows as a chat step line ("Model: … · effort: …").
  - The choice is stored on the session. Every later spawn (resume, restart recovery) passes `--model` / `--effort`.
  - If the CLI refuses a change, its text is shown and the stored choice is left unchanged.
  - Sessions without a choice use the CLI's defaults, exactly as today.
  - *Implementation note 2026-09-28:* the effort equivalent of `set_model` in CLI 2.1.283 is `apply_flag_settings {"effortLevel": <level | null>}` (there is no `set_effort`; probed once within D11, control requests only). The CLI does not check the level, so Switchboard does. Details and the choices made where D31 is silent: `docs/model-effort.md`, `.loop/questions.md` → *D31*.

## Ticket branches and closing sessions (added 2026-09-28)
- **D32 A worktree's branch is named after its ticket.**
  - **The rule:** whenever a session creates a git worktree, the developer names its branch. The name is **required** and must be a Jira-style ticket key, its number and a kebab description: `^[A-Z][A-Z0-9]*-[0-9]+-[a-z0-9]+(-[a-z0-9]+)*$` (e.g. `PROJ-0001-test-branch-name`, `PROJD-0001-test-ticket-name`). There is no `session/` prefix. It replaces `session/{name}` for those worktrees.
  - **In the New-session form:** a **Branch** field appears whenever a worktree will be created (a workspace session with Worktrees on: one branch name used in every solution's repo; a repo-folder session in a worktree).
    - It is pre-filled when the title starts with a ticket key ("PROJ-1984 Purchase complete" → `PROJ-1984-purchase-complete`), and typed text is tidied the same way.
    - Start stays disabled until the name is valid. The summary shows the branch.
    - A branch that already exists in a repo is refused with the server's message.
  - **"Move … to worktree" (M6.3):** asks for the branch name the same way.
  - **Unchanged:** worktree folder names (`../{repo}-wt-{name}`, from the short name), scheduled runs, and teleport's initial branch (the CLI checks out the remote branch) keep their current naming.
- **D33 Sessions can be closed out of the sidebar and reopened from History.**
  - **Close:** a sidebar row (on hover) and the session header offer **Close**.
    - Closing a session that is running or waiting asks for confirmation, then stops its process (its conversation stays resumable).
    - A closed session leaves the sidebar and the palette's session list. Its open questions stop being asked, and its Inbox items close.
    - Its worktree and branch are kept.
  - **History:** lists closed sessions with a "Closed" tag and a **Reopen** action. Reopen puts the session back in the sidebar as paused/idle; sending a message resumes it.
  - Stored as `sessions.closed_at` (null = open).

## Rulings after the D30–D33 merge (added 2026-09-28)
- **D30:** every background command counts as work in progress, dev servers started in the background included, as built.
- **Session header:** the actions never wrap. The root path is cut from the **left** with …, so its end stays readable, and the full line is the tooltip. This replaces D24's wrapping path. The header order is: model picker (D31), Close (D33), Remote (D24), Pause, Continue in terminal.
- **D32:** a title starting with a lower-case ticket key also pre-fills the Branch field, upper-cased (`proj-1984 purchase` → `PROJ-1984-purchase`).
- **D33:** after closing the session on screen, the Inbox opens, as built.
- **Notifications:** a question toast and its OS notification close once the developer opens their session, or once their batch leaves the Inbox. A batch of the session on screen raises no toast (`docs/notifications.md`).

## Installable app (added 2026-09-28)
- **D34 Switchboard can be installed from the browser as a local app (a PWA).**
  - **Manifest:** Switchboard serves a web app manifest (`/manifest.webmanifest`): name "Switchboard", `start_url` and `scope` `/`, `display: standalone`, background and theme colors from the SPEC tokens, and icons (192 and 512 px PNG, a maskable one, and an SVG).
  - **Page head:** the page links the manifest and sets a theme color, an `apple-touch-icon` and the Apple web-app metas, so Safari's **File → Add to Dock** gets the name and icon.
  - **No token for these files:** the manifest, the icons and the service worker are served without the token cookie, like the page shell (browsers fetch a manifest without credentials). The Host/Origin guard still applies. They hold nothing sensitive.
  - **Service worker** (`/sw.js`): everything goes to the network; the worker caches nothing but its own offline page, so an installed app never shows a stale UI. When a navigation fails because the service is down, it shows that page instead of the browser's error: "Switchboard isn't running on <host:port>", with how to start it (`npm start`, or Settings → Start at login) and a **Retry** button.
  - **Settings:** an **Install as app** button appears when the browser offers installation (Chrome's `beforeinstallprompt`). In Safari, a one-line hint says "File → Add to Dock". Neither shows when Switchboard already runs as an installed app (`display-mode: standalone`).
  - **Icons:** made once from an SVG of the sidebar's brand mark, rasterised with the test Chromium by a script in the repo, and committed.
  - **Unchanged:** the installed app is the same origin (`http://127.0.0.1:<port>`), so it keeps its token cookie and needs the service running.
  - **Developer ruling (2026-09-28):** page loads on `localhost:<port>` redirect to `127.0.0.1:<port>`, so there is one origin, one installed app and one cookie. API and `/hub` requests are never redirected. The Install row sits in Settings → Claude Code after Start at login, and the title bar uses `--bg-sidebar`, both as built.

## Frame helper: guided setup (added 2026-09-28)
- **D35 The frame helper is set up with a guided one-click flow** (the developer does **not** want it on the Chrome Web Store; an earlier Web Store plan for D35 was dropped before it was built).
  - **Why guided:** a browser never lets a page or a local program install an extension, and Chrome ignores `--load-extension`, so the developer still clicks "Load unpacked" once. Switchboard does everything around that click.
  - **Where:** a **Frame helper** row in Settings (Embedded tools), and a **Set up frame helper** button on a site tool's "needs the Switchboard frame helper" page.
  - **The steps it runs** (a small panel, each step with a button):
    1. **Open Chrome's extensions page:** the service runs the OS opener for `chrome://extensions` in Chrome (argv only; a page cannot open `chrome://` URLs). If that fails, it says "type chrome://extensions in the address bar".
    2. **Turn on Developer mode** (the toggle at the top right): a hint only.
    3. **Load unpacked:** **Reveal in Finder** (the service opens Finder, or Explorer, on `tools/frame-helper`) and **Copy path** (the folder's absolute path, to paste with ⌘⇧G in the file dialog).
  - **Status:** it watches for the helper's marker and turns green by itself ("Frame helper 2.0.0 is on") the moment Chrome loads it. An older helper reads "Reload the frame helper in chrome://extensions". Safari reads "Safari can't frame signed-in sites; they open in a new tab".
  - **Service routes** (behind the token, like every route): `GET /api/frame-helper` (the folder path and the version from its manifest), `POST /api/frame-helper/reveal`, `POST /api/frame-helper/open-extensions`. Their commands are configurable, so tests use fakes and never open a real browser or Finder.
  - **Developer ruling (2026-09-28):** Chrome marks only pages loaded after the helper, so the setup keeps a 4th step, **Reload this tab**, before it turns green. The extension gets no extra permission for that.

## Subagent chats (added 2026-09-28)
- **D36 A subagent's own conversation opens from the chat, and one step brings you back.**
  - **Where to click:** a subagent's `Agent` / `Task` step line in the chat, its agent card in the right panel, or its row in the D21 overview opens **its** chat in the chat tab.
  - **What it shows:** the brief the main agent gave it (as the first message), its assistant messages and tool steps as the main chat shows them (Markdown, D20), its live activity line (D19), and its final result.
  - **The way back:** a bar on top reads "← Main chat · <subagent name>: <description>" with its status. Its back link, **Esc** and the browser's Back return to the main chat at the same scroll position.
  - **Address:** the view has its own URL (`/sessions/{id}/agents/{agentId}`), so it can be linked and reloaded.
  - **No composer:** subagents take no messages, so a note reads "Subagents take no messages · reply in the main chat". Questions a subagent asked still show as their cards, answered in the main chat as before.
  - Subagents whose messages Switchboard never saw (e.g. inside a Workflow) have no chat to open.

## Finished subagents (added 2026-09-28)
- **D37 Finished subagents leave the right panel.**
  - A subagent whose status is **done** leaves the agent cards and the D21 overview table. Failed, running, waiting, idle and paused ones stay, and the main agent always stays.
  - Under the cards, one collapsed line "✓ N finished" (when N > 0) expands them in place. The panel summary still counts every agent.
  - The chat's Agent step link (D36) always opens a finished subagent's chat.
  - The prototype's demo panel shows done subagents, so the visual oracle records this as a developer ruling, like D29.
  - Built together with D36 (same files).

## Default port (added 2026-09-28)
- **Developer ruling:** Switchboard's default port is **13001** (`DEFAULT_PORT`, was 4870); `SWITCHBOARD_PORT` still overrides it. Tests keep their own ports and refuse the app's port. An app installed from `127.0.0.1:4870` (D34) must be installed again from `127.0.0.1:13001`. The handoff spec, the prototype and the demo seed keep their `4870`, since the visual oracle compares copy verbatim.

## Solutions chosen by the agent (added 2026-09-29)
- **D38 A workspace session can start without picked solutions; the agent determines them.**
  - **Form:** picking solutions is optional for a workspace folder. With none picked, the summary reads `solutions  chosen by the agent` (no warning) and Start follows the other rules only. Repo folders are unchanged: their repo is the one solution.
  - **The first message's answers block** reads "Solutions in scope: not chosen: determine them from the task and the router (`AGENTS.md`), name them in your one-line confirmation before you change anything, and ask if it is unclear". Mobile coordination is not pre-answered then.
  - **Worktrees, when on and nothing is picked:** the block tells the agent to create one git worktree per solution it changes, on the session's ticket branch (D32; `session/{name}` for scheduled runs), at `../<repo>-wt-<name>` next to the solution's repo, and to change files only there.
    - Switchboard **adopts** each such worktree when it appears (after an agent's `git worktree add`, and on a sweep at each turn's end): it registers the worktree (Diff tab, PR checks, the Solutions chips, removal) and assigns it to the session.
  - **The session's solutions fill in by themselves** from what the agent touches: every solution it writes into (the D21 agent-solution derivation) or adopts a worktree in joins `Session.solutions`. This is persisted and published, so the chips, the Solutions view and conflict detection follow.
  - **The server** accepts an empty `solutions` for a workspace session; the other validation is unchanged.
  - **Developer rulings (2026-09-29):** fill-in applies to every workspace session, not only those started without solutions. The form's empty state (the hint, `solutions  chosen by the agent`, and Start enabled) differs from the prototype by ruling and is checked on its own, like D29/D37.

## Own answers (added 2026-09-29)
- **D39 A question can be answered with the developer's own words.**
  - Every question card (chat and Inbox) gets, after the offered options, an **Other…** choice that opens a text field. The typed text is the answer, exactly as Claude Code's own "Other" works: the CLI receives it as the answer string.
  - For a multi-select question, the typed text is one more picked item.
  - "Send all answers" needs every question answered, by an option or by a non-empty own answer.
  - The answers bubble and the chat show the typed text verbatim.
  - The answer API gains an additive `text` next to `answerIndex`: one of the two per question.

## Epic/task branching (added 2026-09-29)
- **D40 The New-session form supports the epic/task branching model (lazy).** Developer spec, 2026-09-29.
  - **The model:** `origin/<base>` (default `dev`) → `feature/<EPIC-KEY>-<Epic-Summary-Slug>` (the epic branch) → `<TASK-KEY>-<task-summary-slug>` (the task branch, D32's name). Local and remote names are the same.
  - **Lazy creation (HARD):** the epic and task branches reach origin, and the epic branch even exists locally, only in a repo that actually gets a code change, at that first change. The agent then:
    1. cuts the epic from the current `origin/<base>`, or reuses it if it is on origin;
    2. moves the still-untouched task branch onto it;
    3. pushes both with `git push -u origin <same name>`.
    Repos never changed get no new branch anywhere.
  - **Form, "Branching" section** (shown with Worktrees on, like D32's Branch field):
    - **Epic** (optional): key and summary, typed in by the developer (no Jira lookup).
    - **Epic branch:** derived as `feature/<KEY>-<Summary>`, keeping the summary's casing, spaces → `-`, characters git forbids dropped, runs of `-` merged; editable.
    - **Epic base branch:** default `dev`.
    - **Task branch:** D32's field.
    - **Creation policy:** a read-only line, "lazy: on first code change".
  - **Preflight table:** one row per selected solution (or the repo of a repo folder). It runs automatically, shortly after the solutions, epic or base change, and has a **Re-check** button. It uses `git fetch origin --prune` per repo, then:
    - `origin/<base>` present? If not, a warning with **Drop from task** / **Use other base: ___** (per repo);
    - epic branch on origin? (yes/no; if yes, how many commits it is behind `origin/<base>`);
    - task branch on origin? (yes/no).
  - **Worktree creation with an epic:**
    - always `git fetch origin` first;
    - the task branch worktree is cut from `origin/<epic>` when that exists, else from `origin/<base>` (the repo's own base when overridden), never from local `master`;
    - an **existing task branch is reused** (tracking `origin/<task>` when there, else the local branch), replacing D32's refusal;
    - nothing is pushed and the epic branch is not created at session start;
    - dropped repos get no worktree.
  - **Tasks without an epic** (e.g. a bug fix; developer ruling 2026-09-29): `git fetch origin` first, then the task branch is cut from `origin/master` (the repo's origin default branch, `origin/HEAD`, where it isn't `master`), never from a possibly stale local `master` and never from `dev`. The hand-off line reads `- Branching model: task only: <task branch> (base: origin/master)`.
  - **Hand-off:** the session-start answers block gains:
    - `- Branching model: epic/task (lazy)`;
    - the Epic line (key, epic branch, base);
    - the Task branch line (base: epic branch);
    - the Rule line (create and push the epic + task branches with `git push -u origin <same name>` only in a repo at its first code change; cut the epic from the current `origin/<base>` when it is missing on origin; never create either branch in repos that are not changed);
    - `Dropped repos (no base branch): …` and per-repo base overrides, when any.
    With no picked solutions (D38), the same rule applies to the worktrees the agent creates.
  - **Unchanged:** scheduled runs keep `session/{name}`.
  - **Built after D38**, on top of it.

## Collapsible panes (added 2026-09-29)
- **D41 The sidebar and the session's right panel slide out and back in on request, and the choice is remembered.**
  - Both are shown by default, so the layout matches the prototype.
  - **Controls:**
    - Each pane has a small hide button, and a slim handle at the window edge brings it back.
    - Shortcuts: ⌘B (Ctrl+B) for the sidebar, ⌘⌥B (Ctrl+Alt+B) for the right panel.
    - A slide transition (off with `prefers-reduced-motion`).
    - The main area takes the freed width.
  - **Memory:** the state is kept by the service (settings, per install), so it survives restarts, reloads and the installed app.
  - The right panel exists only in the session view, and its state applies to every session.

## Model at session start, remembered (added 2026-09-29)
- **D42 The New-session form has the model and effort picker, and Switchboard remembers the last choice.**
  - **In the form:** a **Model** row, the same picker as D31's header picker: the model, plus its effort levels when it has some.
    - It offers the latest model list any session's CLI reported (stored by the service), else the CLI's aliases (`default`, `opus`, `sonnet`, `haiku`).
    - It starts on the **last model and effort the developer chose**, in this form or in a running session's header picker, else the CLI's default.
  - **Stored per session:** a new session starts with `--model` / `--effort` from its choice (D31 already passes them on every spawn), and the choice becomes the new "last choice" (a service setting, per install).
  - Scheduled runs' templates carry a model like any other field of the form.
  - `NewSession` gains optional `model` and `effort`, validated like D31's route (additive).
  - **Built after D38**, alongside D40.

## Every background task counts (added 2026-09-29)
- **D43 Background workflows, and every other background task the CLI reports, show the session as working (extends D30).**
  - **Why:** a session that launched a background **Workflow** ("Workflow launched in background. Task ID: w…", a read-only audit, seen live 2026-09-29) showed as idle, because D30 only knew background `Bash`, `Agent`, `Monitor` and `ScheduleWakeup`.
  - **Tracking:**
    - A `Workflow` tool call whose result confirms a background launch is a pending task of kind `workflow`, with its summary.
    - Every `system/task_started` the CLI streams starts a pending task too, whatever its type, unless the tool call already registered it (matched by task id or `tool_use_id`). `system/task_notification` and a terminal `system/task_updated` end it.
    - Unknown task types are kept, as kind `task` with the CLI's description.
  - **Display:** "⏳ Running a workflow: <summary>", or "⏳ Waiting for a background task: <description>" for other kinds, next to D30's lines. Everything else is as D30 has it.
  - **Developer ruling (2026-09-29):** long-lived tasks (agent-team teammates, remote agents, dream runs, paused workflows) count too, as built: the session shows as working while any task is alive.

## Queued messages (added 2026-09-29)
- **D44 The developer's own chat messages show a clock while they are queued.**
  - **Queued** means sent but not yet taken up by the agent:
    - sent while a turn runs, so it waits for that turn to end;
    - sent to a paused or stopped session, so it waits in the outbox until the session resumes.
  - Such a bubble shows a small clock icon (SPEC muted tokens) with a tooltip: "Queued: the agent reads it after its current turn" / "Queued: sent when the session resumes".
  - The icon goes away the moment the agent starts on the message. That moment is derived from the CLI's own signals, verified against the stream: the replay/ack, or the next turn's start, whichever marks the real pickup.
  - Live over `/hub`. Nothing changes for delivered messages.

## Loading a session (added 2026-09-29)
- **D45 Switching sessions shows a loading state, never the previous session's content.**
  - **Placeholders:** while a session's data loads, its header, chat and right panel show skeleton placeholders on SPEC tokens (header bars, 3–4 bubble shapes, overview and card blocks) with a light shimmer. The shimmer is static with `prefers-reduced-motion`.
  - **No flicker:** the placeholders appear only if the load takes longer than about 150 ms.
  - **Never stale:** the view clears when the session id changes, so one session's data never shows under another's name.
  - **Instant revisit:** a session opened before in this tab shows at once from an in-memory cache while it refreshes in the background.
  - A failed load shows the existing error state.

## Session bar pace (added 2026-09-29)
- **D46 The 5-hour Session bar is colored by pace too, like the Week bar (D23), updated every minute.**
  - **The allowance:** the window runs from its reset time minus 5 hours to the reset. It grows evenly: `minutes elapsed ÷ 300 × 100 %`, rounded like D23's, recomputed every minute.
  - **Display:**
    - **green** while the Session usage is below the allowance, **yellow** once it is at or above it;
    - a marker at the allowance (D23's marker);
    - a tooltip "On pace: 38% of 50% until 14:05" / "Ahead of pace: …", where "until" is the next minute step. The reset stays visible as today.
  - **No pace:** without a known reset, or with a reset more than 5 h ahead or in the past, the Session row keeps its plain D17 look.
  - The pace is computed in the browser from `usageWindows`, like D23; no API change.

## Rulings on D40, D42 and D44 (added 2026-09-29)
- **D40:**
  - The derived epic branch keeps only letters, digits, `-`, `_` and `.` after `feature/`; anything else becomes `-`, and the casing is kept.
  - A repo without `origin` is cut from its local HEAD.
  - An existing task branch is reused (replacing D32's refusal).
- **D44:** a chat message to a paused session resumes it at once, as before; its bubble shows the clock until the new process takes it up.

## Stacked task branches (added 2026-09-29)
- **D47 A task branch can be stacked on an earlier, still unmerged task branch.** Developer spec, 2026-09-29, extends D40.
  - **The model:** D40's `origin/dev → feature/<EPIC-KEY>-<Epic-Summary-Slug> → <TASK-KEY>-<task-summary-slug>`, lazy, same names locally and on origin. While an earlier task's PR is unmerged, the next task that needs its code is **stacked** on it: cut from the earlier task branch, its PR into that branch instead of the epic.
    ```
    origin/dev
    └── feature/PROJ-3010-Platform-tracking-and-KPI-delivery-process-development
        └── PROJ-3013-configure-hubspot-opt-in-cookie-banner-across-both-domains   (PR → epic)
            └── PROJ-3014-<slug>                                                   (PR → PROJ-3013)
    ```
  - **Rules:**
    1. **Parent branch:** each task has a parent: the epic branch (default) or an unmerged task branch (stacking), chosen per task by the developer.
    2. **Per-repo resolution:** the parent task branch on origin in this repo → base `origin/<parent>`; else `origin/<epic branch>` when it exists, else `origin/<epic base>` (usually `origin/dev`), the commit the epic will be cut from.
    3. **Lazy creation unchanged:** nothing is pushed or created on origin at session start; only local worktrees on the resolved base.
    4. **PR target** = the parent as resolved for that repo (the parent task branch, or the epic branch when falling back, created lazily).
    5. **When a parent merges:** the child PR is retargeted to the parent's own base and the child rebased (`--onto` if the parent was squash-merged).
  - **Preflight table:** per selected repo, **Resolved base** (`origin/PROJ-3013-…` / `origin/feature/PROJ-3010-…` / `origin/dev (epic not created yet)`), **PR target**, **Parent status** (parent PR open / merged / closed; merged or closed warns "parent merged — base on its target instead").
  - **Worktree creation:** `git fetch origin --prune`, each task worktree from the repo's resolved base; never a local master; no pushes at session start.
  - **Hand-off:** a stacked session's Branching lines become:
    ```
    - Branching model: epic/task (lazy), stacked
      - Epic: PROJ-3010 — feature/PROJ-3010-Platform-tracking-and-KPI-delivery-process-development (base: origin/dev)
      - Task branch: PROJ-3014-<slug>
      - Parent: PROJ-3013-configure-hubspot-opt-in-cookie-banner-across-both-domains (stacked; PR #306/#1080/#1204 open)
      - Per-repo base / PR target:
        - acme-app-front: origin/PROJ-3013-… → PR into PROJ-3013-…
        - static-front: origin/PROJ-3013-… → PR into PROJ-3013-…
        - quizzes-front: origin/dev (epic missing; parent not in repo) → PR into feature/PROJ-3010-… (epic, created lazily)
    ```
    (The developer's text ended at "→ PR into"; they confirmed that was the end, so the completion is ours: when falling back the PR goes into the epic branch, created lazily.) A session whose parent is the epic keeps D40's lines unchanged; a stacked one also gets rule 5 as an instruction.
  - **Developer rulings (2026-09-29, override the spec where they differ):**
    - **Parent field = typed, no listing.** The Branching section gets a **Parent** input defaulting to "Epic branch (independent)" (empty). The developer types a branch name or a task key (`PROJ-3013`); Switchboard never searches for or lists sibling branches. A bare key resolves per repo to the origin branch whose name starts with `<KEY>-` (0 matches = parent not in that repo; more than one = an error row asking for the full name). A task text that mentions stacking ("create it from PROJ-3013", "stack on PROJ-3013", "based on PROJ-3013") pre-fills the field with the key, never overwriting what the developer typed. The preflight checks the typed parent per repo.
    - **Parent status** from `gh pr view <parent branch> --json number,state,url,baseRefName` per repo; no PR = "no PR"; merged / closed = a warning row, Start still allowed.
    - **Rule 5 = tell the agent.** The 5-minute PR poll also watches a stacked session's parent PR per repo (the parent and its PR target stored with the worktree, migration 0013). When it turns MERGED: an Inbox item ("Parent PROJ-3013-… merged — retarget and rebase PROJ-3014-…") and a message asking the agent to retarget its PR to the parent's base (`gh pr edit --base <parent's base>`) if it exists and rebase onto that base (`git rebase --onto origin/<parent base> <old parent tip> <branch>` after a squash merge, else a normal rebase), then report. Once per parent per repo; a closed session gets only the Inbox item. Switchboard itself never runs `gh pr edit`, a rebase or a push.
    - **Also for bug fixes (no epic).** The Parent field shows without an epic too: the parent on origin in this repo → `origin/<parent>`, PR into it; else `origin/master` (the origin default branch after a fetch), PR into it. The hand-off has no Epic line.
    - **Branch-name hygiene:** a typed full parent name is checked with `isValidBranchName` (git's check-ref-format rules).
  - Built on master `5a6c2df` (after D40–D46). Details: `docs/worktrees.md` → *Stacked task branches (D47)*, `docs/new-session.md` → *Parent (D47)*; choices where the spec is silent: `.loop/questions.md` → *D47 · Stacked task branches*.

## Rulings on D47 (added 2026-09-29)
- **Force-push after the rebase:** kept as built: the rule-5 instruction and message ask the agent to ask the developer before force-pushing the rebased branch.
- **A parent closed without merging:** when the poll sees a stacked worktree's parent PR turn CLOSED (not merged), the Inbox gets an item "Parent <parent> closed — retarget <task> to <epic or default branch>" (label "Parent closed", Dismiss only), once per worktree, surviving restarts like the merged item (raised from the sync if missed). Inbox item only: the session gets no message.
- **PR target column:** shows always in the preflight table for every branching session (stacked or not: the parent, the epic, or the default branch without an epic). The Resolved base and Parent status columns stay stacked-only.

## Switchboard peers (added 2026-09-29)
- **D48 Any Switchboard can connect to any other Switchboard ("Switchboard peers").** Developer spec and rulings, 2026-09-29; builds on `docs/spike-remote-pc.md` (the hook design for P4).
  - **Goal:** "Ultimately, any Switchboard should be able to connect to any other Switchboard." The developer has a Mac and one or more Windows PCs on **Tailscale**. Peers are **symmetric**: every instance can both serve and connect.
  - **P1 · Peers and pairing.**
    - An optional **peer listener** bound directly to the machine's **Tailscale IP** (100.x, from `tailscale ip -4` or configured); ruling: bind the Tailscale IP directly, **not** `tailscale serve`. The local UI listener stays on 127.0.0.1 exactly as today (Host/Origin checks, token cookie unchanged). The peer listener serves only a peer API, authenticated by a per-pair bearer token; nothing is served on any other interface; **off by default**, toggled in Settings.
    - **AGENTS.md amendment (approved):** the rule "The service binds to loopback only" becomes "the UI binds loopback only; the optional peer listener binds only the Tailscale address with per-peer tokens" (AGENTS.md and `docs/security.md`, same change).
    - **Pairing** in Settings → Machines: on machine A "Allow a new peer" shows a one-time code (short-lived, single use); on machine B "Add machine" takes A's Tailscale address and the code; they exchange long random per-pair tokens (stored in the DB, never logged, revocable per machine). Machines have a name (default: the host name). Either side can pair with the other; whether one pairing creates both directions is ours to decide and record (ASSUMED D48-both-directions: it does).
    - Connection status per machine (online / offline / auth failed), reconnect with backoff.
  - **P2 · Remote sessions, full control (proxy design).** The local server proxies a peer's session API and live events: the peer's sessions appear in the local sidebar with a **machine tag**, and the full session view works for them exactly like for local ones (chat, question cards, permission prompts, messages incl. queued (D44), pause/resume, model/effort, close/reopen, Diff, Artifacts, Timeline, subagent chats, background tasks). A generic proxy of the existing REST routes and `/hub` events namespaced by machine id, so the existing views are reused; remote ids never collide with local ones. The peer's **Inbox** items (questions, permissions, system items) merge into the local Inbox with the machine tag; answering there answers on the peer; toasts and OS notifications fire for remote items too. An offline peer's sessions show as unreachable (not deleted); the peer keeps running them itself. **Not proxied** (recorded as ASSUMED; the developer may extend later): the peer's settings, folder management, schedules, embedded tools.
  - **P3 · Start sessions on a peer.** The New-session form gets a **Machine** choice (this machine by default); a peer's folders, preflight (D40/D47 branching) and model options load from that peer and the session starts there.
  - **P4 · Hook into hand-started terminal sessions** (the spike's recommended design, with these rulings):
    - A machine lists the interactive terminal `claude` sessions running on it (`claude agents --json` + hook reports; sessions Switchboard itself supervises there, `entrypoint: sdk-cli`, are hidden), and a connected Switchboard can **hook into any of them** from a per-machine picker ("Hook into…"); un-hooked ones are listed (folder, status) and hookable.
    - **Hook install:** Switchboard may write its hook entries into that machine's user Claude settings (`~/.claude/settings.json` / `%USERPROFILE%\.claude\settings.json`, or `CLAUDE_CONFIG_DIR`) through an explicit **Install hooks / Remove hooks** action per machine, with a timestamped backup first, touching only Switchboard's own entries (idempotent; Remove restores nothing else). Windows: exec-form hooks (absolute `node.exe` + `args`, no shell). Tests use temp config dirs only. (This narrows D6's "user settings files are never edited" for this one explicit action.)
    - **Control as close as possible to the phone's Remote Control:** live chat from the transcript (the transcript parser, with the `task-notification` origin handled); permission prompts with **Allow once / Always allow (`updatedPermissions`) / Deny with a message**; **plan approval** (ExitPlanMode); **question cards** (AskUserQuestion) if a PermissionRequest hook can answer them (verify); **replies** through `asyncRewake` waiters on SessionStart/Stop, using the internal `rewakeMessage` / `rewakeSummary` fields with a CLI-version check and the documented fallback.
    - **Waiter life: unlimited**, with guarded resources: one waiter per session, cleaned up at SessionEnd / process exit. Each message is delivered **exactly once**, with a per-session **rate limit** (the spike's runaway, one message re-delivered after every turn, must be impossible, and tested). Mid-turn delivery: verify if possible, else hold until the turn ends. What hooks cannot do (interrupt, slash commands, model change) shows as unavailable for hooked sessions with a short reason.
    - **Real-CLI checks:** at most 3 small probes (interactive `claude --model haiku`, cwd under the gitignored `.spike/sandbox/`, hooks only from spike-owned `--settings` or sandbox project settings, at most 3 user turns each, killed afterwards, a probe hook that delivers at most once and a 60 s kill; skip when the usage line shows ≥ 95 %): (a) can a PermissionRequest hook answer AskUserQuestion, (b) mid-turn delivery.
  - **Security:** per-pair tokens (32 random bytes, constant-time compare, stored hashed where feasible); pairing codes single use and short-lived; the peer listener only on the Tailscale IP; a peer can use only the peer API (no settings, no folder management, no tools proxy); hook endpoints authenticated with a token file readable only by the user; never read credentials or `.key` files; only the unmodified `claude` binary.
  - **P5 (the developer):** a live test on the Windows PC, from the checklist in `docs/peers.md` → *Windows setup and live test*.
  - Details: `docs/peers.md`; choices where the spec is silent: `.loop/questions.md` → *D48 · Switchboard peers*.

## Rulings on D48 (added 2026-09-29)
- **Mid-turn delivery (D48-midturn-policy):** "Deliver mid-turn." A message to a hooked terminal session goes out as soon as possible, also while a turn runs (the CLI folds it in at the next tool boundary, VERIFIED D48-midturn), instead of waiting for the turn to end. Exactly once and the rate limit stay (one wake-up in flight at a time; at most 3 a minute). The bubble's D44 clock clears when the transcript shows the message taken up (the `queued_command` attachment / the absorbed line).
- **Hooked subagents (D48-hooked-subagents):** "Import them too." A hooked session's subagents (plain Agent / Task subagents, background ones included, from `<session>/subagents/agent-*.jsonl` + `.meta.json`) appear in its agent overview and cards, and their chats open, as for local sessions. Workflow agents are D51's; a clear seam is left for them.
- **Offline peers (D48-cache-persist):** "Keep the snapshot but block interaction until reconnection." Each peer's last known open sessions (and the detail the sidebar and the view need) are persisted, so after a restart of this Switchboard an unreachable peer's sessions stay listed, marked unreachable, readable on the last snapshot, but every interaction is blocked (composer, Stop, pause, answers, Inbox actions disabled with "<machine> is offline — reconnect to continue"; the server refuses with 502 `peer-unreachable` anyway). On reconnection the snapshot is replaced by live data. Offline Inbox items stay hidden as built, unless showing them read-only is clearer (ours to record).
- Details: `docs/peers.md` → *Replies (the mailbox)*, *Following a session*, *Remote sessions* → *Offline*; `.loop/questions.md` → *D48 · Switchboard peers*.

## Context window meter (added 2026-09-29)
- **D49 A context window meter above the quick replies.** Developer request, 2026-09-29: "An embedded progress bar above quick replies to see how much of the context window for the current session is filled in. It should detect context compression and then reset accordingly."
  - **Placement (ruling):** a thin bar directly above the quick-replies row of the session composer (main chat). Subagent chats have no composer, so they show no bar.
  - **Content (ruling):** the bar and the text `Context 62% · 124k / 200k`. The hover tooltip names the model's context window and the time the context was last compacted (local 24 h time).
  - **Colors (ruling):** green below 60 %, yellow from 60 %, red from 80 %, on the SPEC tokens (the usage footer's green `--status-done` and yellow `--status-need`, the failure red `--status-fail`).
  - **Compaction (ruling):** the CLI's `system/compact_boundary` (`compact_metadata.trigger` `auto` / `manual`, `pre_tokens`, optional `post_tokens`; names confirmed in the CLI 2.1.284 binary) resets the bar to the post-compaction size: the boundary's `post_tokens` at once, then the next main-agent usage. The text shows "compacted 14:05" until the next turn starts; the tooltip keeps "Last compacted: 14:05 (auto)".
  - **Filled (ruling, matched to the CLI):** the latest main-agent assistant message's `usage`: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. That is the CLI's own status-line formula (`context_window.used_percentage` = `round(tokens / window × 100)`), which leaves `output_tokens` out, so Switchboard leaves them out too. Subagent (sidechain) messages never count.
  - **Window (ruling):** the result's `modelUsage[<model>].contextWindow`, else from the model (`[1m]` → 1 000 000, otherwise 200 000; the CLI's own fallback). It follows D31 / D42 model changes: it is resolved on every read against the session's model choice.
  - **Persistence:** stored on the session (`sessions.context`, migration 0015). It survives a reload, a Switchboard restart, and closing and reopening from History. An Attach / move / teleport import reads the terminal's turns from the transcript. Live over `/hub` `sessionUpdated`, with no polling.
  - **Unknown:** an empty neutral bar, `Context —`.
  - Details: `docs/chat.md` → *Context bar*; choices where the ruling is silent: `.loop/questions.md` → *D49 · Context window meter*.

## Rulings on D49 (added 2026-09-29)
- **D49-backfill: yes.** A session with no stored meter (from before D49) reads its context once from its transcript, reusing the transcript replay (the main chain through the compaction boundary). This happens in the background of its first detail request (`GET /api/sessions/{id}`), which then publishes `sessionUpdated`, or at its next spawn, whichever comes first. The result is stored, so it is never read on every GET. A missing or unreadable transcript stores the empty meter (`Context —`).
- **D49-autocompact-mark: yes.** A small tick on the track where the CLI will auto-compact, and the tooltip adds "Auto-compact at N%".
  - The threshold is exactly the CLI's (2.1.284 `kK` + `_Q`): `window − min(maxOutputTokens, 20 000) − 13 000`, lowered by `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, with the window clamped by `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
  - There is no tick (the tooltip says "Auto-compact off") when `autoCompactEnabled` is false or `DISABLE_COMPACT` / `DISABLE_AUTO_COMPACT` is set. Those are read from the process's env and its user / project / local settings files at each spawn.
  - The tick sits at `threshold / window` on the bar's own scale; see `.loop/questions.md` → *D49* for how the CLI's count (which adds the last reply's output tokens) relates to the displayed percentage.

## Stop the current turn (added 2026-09-29)
- **D50 Stop the current turn.** Developer request, 2026-09-29: "I should be able to stop the current message from being processed (like Ctrl+C in Claude Code terminal mode)."
  - **Stop = interrupt the running turn only (ruling).** The process stays alive and the session becomes idle, ready for the next message; unlike Pause (D7), which interrupts and then ends the process. It uses the stdin `control_request` `interrupt`, with `cancel_queued: true` (read in the CLI 2.1.284 binary: the capability `interrupt_cancel_queued_v1`; the queued main-thread commands are removed with the abort and never run).
  - **Trigger (ruling): a button and Esc.** While a turn runs, the composer's Send becomes a ■ **Stop** button. **Esc** also stops the turn when nothing else is open; an open popover, dialog or menu, or a subagent chat, keeps its current Esc behaviour first (it closes, or goes back to the main chat). Ctrl+C stays copy. Esc stops nothing when no turn runs.
  - **Queued messages (ruling): back into the composer.** Messages sent while the turn ran (the D44 clock) that the CLI has not taken up yet are removed from the queue and never delivered afterwards (`cancel_queued`). Their text goes back into the message field for editing, joined in order. Their bubbles disappear.
  - **Status:** after the interrupt's `result` the session shows idle, not running, and the turn accounting stays right (tested: 0, 1 and 2 queued messages, a stop at a tool boundary, a stop with a permission prompt open).
  - **Chat:** the stopped turn shows as a small "■ Stopped" line.
  - **API:** additive `POST /api/sessions/{id}/interrupt` (`docs/handoff/contracts/local-api.md`).
  - **Out of scope:** peer / hooked sessions (D48, another lane).
  - Details: `docs/supervisor.md` → *Stop the current turn (D50)*, `docs/chat.md` → *Stop (D50)*; choices where the ruling is silent: `.loop/questions.md` → *D50 · Stop the current turn*.

## Rulings on D50 (added 2026-09-29)
- **D50-probe: yes.** One D11 probe on the real CLI (2.1.284, Haiku, `--max-turns 3`, `.spike/sandbox/`, no user settings) confirmed the Stop: the receipt `{still_queued: [], cancelled: []}` came before the result, then the tool's rejection, `[Request interrupted by user for tool use]` and `result/error_during_execution` with `terminal_reason: "aborted_tools"`; the message queued before the interrupt never ran (nothing for 20 s, then EOF). Details: `.loop/questions.md` → *D50*.
- **D50-background: offer it when only background work runs.** When a session runs no turn but background tasks do (D30 / D43, workflows and background agents included), the composer offers **Stop background tasks**, with a confirmation that lists them; confirming sends the CLI's `stop_task` control request for each, and the tasks end as stopped. Esc never does this (only the button and the confirmation). Additive route `POST /api/sessions/{id}/background/stop`.
- **D50-other-tabs: keep as built.** Only the tab that pressed Stop gets the withdrawn texts.
- **With D48 (found at the merge):** Stop and the background stop work on a peer's session through the proxy (both routes on the peer API's allow-list). A hooked terminal session cannot be interrupted through hooks: both routes answer 409 `hooked-unavailable` with the reason, and the composer offers neither (Esc does nothing there).

## Workflow agents are visible (added 2026-09-29)
- **D51 A Workflow's agents show like subagents: in the overview, as cards, in the counts, and with their own chat.** Developer report, 2026-09-29: "In orchestrator mode I cannot see or access the list of subagents running."
  - **Why:** orchestrator sessions run their subagents through the **Workflow** tool. D43 showed a workflow only as "⏳ Running a workflow: <summary>"; the agents inside it never reached the agent overview, the cards or the counts, and their chats could not be opened. Plain `Agent` subagents (background ones too) already worked. Gap #8 had left workflow agents out because M0.1 did not see them in stream-json.
  - **Evidence (CLI 2.1.284, its binary and real session folders read-only; never run):**
    - A background `Workflow` call's result names the run: `Run ID: wf_…`, `Transcript dir: <projects>/<slug>/<session>/subagents/workflows/<runId>`, and `tool_use_result.runId`.
    - **Live on stdout:** `system/task_progress` of the workflow's task carries `workflow_progress`, the whole list of phases (`workflow_phase`) and agents (`workflow_agent`: `index`, `label`, `phaseTitle`, `agentId`, `model`, `state` `start` / `progress` / `done` / `error`, `startedAt`, `lastToolName`, `lastToolSummary`, …), sent when an agent starts or ends and at most every few seconds while agents only progress.
    - **Live in files:** `subagents/workflows/<runId>/journal.jsonl` (`started` / `result` / `failed` per agent) and per agent `agent-<id>.jsonl` (its transcript; the first user line is its brief inside the CLI's "[Workflow harness …]" frame) + `agent-<id>.meta.json` (label and phase).
    - **At the end only:** the run file `workflows/<runId>.json` (status, phases, the final `workflowProgress`, model, times). A running run has no run file yet (seen on a live run of the developer's session).
    - The run folder and run file sit under the **session's** project folder (the transcript's); only the script (`workflows/scripts/<name>-<runId>.js`) may land under the project folder of another cwd the session moved to.
  - **What was built:**
    - **The model (no migration, nothing stored):** each run is a group, `Session.workflows` (name, summary, status, phase, phases, agent / done / failed counts, times); its agents join `Session.agents` as `kind: 'workflow'` with `Agent.workflow` (run, index, agent id, phase, model, start / end, current action, cwd, a version that grows with its transcript). States map to Switchboard's: queued → `idle` "queued", start / progress → `run`, done → `done`, error / failed → `fail`; agents still running when the run ends were cut off → `idle`. The run is `run` while its process is alive and has not reported its end (or, for a terminal's run, while its files changed in the last 2 minutes), then `done` / `fail` / `idle` (stopped).
    - **Sources:** this process's stream (the launch, every `task_progress` snapshot, the task's end) and the CLI's files, read by the server (`src/server/workflows/service.ts`): the journal, metas and transcripts as they grow (only what was appended; a transcript's head once), the run file once. Files are polled every 1.5 s only while a run runs. The files make it correct after a reload, a Switchboard restart, for History (closed and reopened sessions), attached, hooked (D48 P4) and peer (D48) sessions alike.
    - **Agent overview:** a row per run (name · summary · `—` · `● 3/7 done · phase Review`) with its agents indented under it (label · phase · solution from the agent's cwd, else `—` · its live action). D37's fold applies: done agents leave the table (counted in "✓ N finished"), a done run's row goes once none of its agents is left; running and queued ones always show.
    - **Agent cards:** running workflow agents get cards with their current action; at most 6 per run, the rest one line "+N more in <workflow>" (the overview lists them all).
    - **Chat:** a workflow agent's row or card opens its conversation at `/sessions/{id}/agents/{agentId}` (D36's view): "Brief from the workflow" (without the CLI's frame), its messages and tool steps, its result (its return value from the journal); it reloads while it runs. "← Main chat" / Esc / Back as for subagents; the note reads "Workflow agents take no messages".
    - **D43's line** gains the counts: "⏳ Running a workflow: <summary> · 3/7 agents done · phase Review".
    - **Counts:** the panel summary counts workflow agents like subagents.
    - **API (additive):** `Session.workflows`, `Agent.workflow`, `BackgroundTask.workflow`, `GET /api/sessions/{id}/workflow-agents/{agentId}/chat` (also through the D48 peer proxy).
    - **Security:** only files under `<configDir>/projects/*/<the session's CLI session id>/` are read; run and agent ids are checked before they become path parts; symlinks are not followed; no path is taken from a file's contents (the launch's `Transcript dir:` gives only the run id).
  - Details: `docs/derivations.md` → *Workflow agents (D51)*, `docs/session-panel.md` → *Workflow agents (D51)*, `docs/chat.md` → *Subagent chats*; choices where the report is silent: `.loop/questions.md` → *D51 · Workflow agents are visible*.

## Rulings on D51 (added 2026-09-29)
- **D51-solution: yes.** A workflow agent's Solution is the solution of its first successful write (Write / Edit / MultiEdit / NotebookEdit whose result is no error), like a subagent's (D21); without one, the solution of its cwd, else `—`. Each agent transcript is scanned in order as it grows, at most 4 MB per read and 32 MB in all per transcript; once the first write is found (or the cap reached) it is never scanned again, and a finished run's transcripts are scanned once and kept in memory.
- **D51-card-cap: keep 6 cards per run;** the "+N more in <workflow>" line is a button that opens that run's cards in place, and "Show fewer · <workflow>" cuts them again (kept in memory for the page's life, like the finished line).
- **D51-resume: yes.** A **stopped or failed** run whose script Switchboard found gets **Resume run** on an actions row under its overview row. It sends the session's agent a message asking it to call `Workflow({ scriptPath: "<its script>", resumeFromRunId: "<runId>" })` (plus the run's `args` when its run file has them; the parameter names read in the CLI 2.1.284 binary) through the normal message path: D44 queues it while a turn runs, and a paused session resumes on it. It is disabled, with the reason, for a closed session or an unreachable peer. Hooked sessions take it (their messages go through the hooks). Switchboard never runs the script itself. Additive: `WorkflowRun.resume`.
- **D51-probe: yes, done.** One D11 probe on the real CLI (2.1.284, Haiku, `--max-turns 3`, `.spike/sandbox/wf-probe/`, `--setting-sources project,local`, CLAUDE* env removed, `--allowedTools Workflow`, finished in 11 s) confirmed D51's evidence: the Workflow tool exists in `-p` stream-json, the launch result, `task_progress` lines with the whole `workflow_progress` (and lines without it in between), the journal, the per-agent transcripts and metas, the run file at the end, `task_updated` / `task_notification` `completed`, then the CLI's own turn. Details: `.loop/questions.md` → *D51*.

## Ruling: continuous week pace (added 2026-09-29)
- **Supersedes D23's daily steps.** Developer ruling, 2026-09-29: the Week bar's allowance grows **by the minute** over the 7-day window, like the Session bar's (D46): during minute *n* of the 10 080 it is *n* × 100 / 10 080 % (before: each whole day's 14.29 % from that day's start, which left the last day almost nothing). The tooltip names the next minute step's time only: "On pace: 33% of 57.14% until 17:05" (no "allowed", no weekday). The colors, the marker, the 2-decimal rounding, "on pace = below the allowance" and unknown-stays-unknown are D23's as before; `WeeklyPace.day` (1–7) is still reported. Details: `docs/usage.md` → *Weekly pace*.

## A peer's schedules and loops (added 2026-09-29)
- **D52 A peer's schedules and loops show and work on Schedules & loops.** Developer request, 2026-09-29: "Check whether the remote runs schedules or loops and add them to Switchboard (the Mac) within Schedules & loops." Builds on D48 (proxy, remote ids, offline snapshots, no chains), M7.1 / M7.2 (schedules, loop cards), D42.
  - **Schedules (ruling: full management).** A paired machine's schedules appear in the schedule table with its **machine tag**, and are **created, edited, deleted, run now, paused and resumed** from here; the schedule lives and runs on that machine. The schedule editor (the New-session form in schedule mode) gets D48's **Machine** row (D48 had hidden it for schedules): a peer loads that machine's folders and models and saves the schedule there; an Edit stays on the schedule's machine (the row is locked). **Delete** is new for every schedule (Edit → "Delete schedule", two clicks; `DELETE /api/schedules/{id}`, refused while a run is in progress). A peer's failed-run Inbox items already came through the proxied Inbox: Retry run runs on that machine, and "Open fix session" opens the form on that machine in the schedule's folder.
  - **Loops (ruling: all terminal sessions).** A peer's loops (observed `/loop`, `ScheduleWakeup`, `CronCreate`, Workflow runs) appear with its tag: from its Switchboard sessions and its **hooked** terminal sessions (now tracked from their imported events, like supervised ones), and from its **un-hooked** terminal sessions (`claude agents --json` there), derived read-only from their transcripts on that machine (bounded, cached by size and mtime, no hooks needed). A session's loop card opens its session; an un-hooked terminal's card offers **Hook into…** (D48 P4) instead and says why it cannot be opened. This machine's un-hooked terminal sessions show the same way (ASSUMED D52-local-terminals).
  - **Proxy:** every new route is on `PEER_API_ALLOW` (`GET/POST /api/schedules`, `POST …/{id}/run|pause|resume`, `DELETE /api/schedules/{id}`, `GET /api/terminal-loops`); ids are D48 remote ids; `scheduleRun` is forwarded between peers; `POST /api/schedules` takes `machine` (a new schedule there) or a peer schedule's remote id (an Edit there). **Offline:** a peer's schedules and terminal loops stay listed from the snapshot (`peer_snapshots` kinds `schedules`, `terminal-loops`; no migration), tagged unreachable, with every action refused with D48's reason. **No chains:** a peer answers its own schedules and loops only.
  - Details: `docs/peers.md` → *A peer's schedules and loops (D52)*, `docs/schedules.md` → *Delete (D52)* / *A peer's schedules (D52)*, `docs/derivations.md` → *Loop cards* → *Terminal sessions (D52)*; choices where the request is silent: `.loop/questions.md` → *D52 · A peer's schedules and loops*.

## Live activity for remote and hooked sessions (added 2026-09-29)
- **D53 Hooked and peer sessions show the same live activity as local ones; a hooked session's queued message says what it waits on.** Developer request, 2026-09-29: "When a message is sent to the remote session, show the same Claude Code-like statuses in the chat while Claude is thinking on the remote PC — it would help me identify whether the session is stuck." Context: a hooked terminal session on the Windows PC (D48 P4) showed no live activity (Switchboard gets only its hook events and its transcript), so a running tool or a long thinking looked the same as stuck; and a message sat queued (D44 clock) because the session had no waiter yet, with nothing saying why.
  - **Live line (same look and words as D19 / D30):** a hooked session's `Session.activity` is derived from its transcript and hook calls, in the same shape, so the chat line, the sidebar row and the agent cards read it unchanged: a thinking verb from UserPromptSubmit or the transcript's prompt line (timed from the turn's start); `● <Tool>: <summary>` from the transcript's `tool_use` line until its `tool_result` (timed from that line's timestamp); `Writing…` after a text block; `⏸ Waiting for permission: <tool>` while its PermissionRequest is held (a supervised session's wait still reads `Waiting for you`); running subagents on their cards; nothing after Stop / SessionEnd (a Stop or an end line after the turn's start ends it, whichever comes first). No token count (the transcript has none). The transcript is polled every 500 ms while a turn runs (1.5 s otherwise); `activity` events at most one a second per session.
  - **Staleness hint:** `SessionActivity.quietSince` (additive: the newest transcript change or hook call); while a turn runs and nothing changed for 3 minutes, the chat line and the sidebar row add `· no activity for 3m` (muted), not while waiting for the developer.
  - **Delivery state:** additive `Session.hookStatus` `{ waiter, hookSeen, delivery }` on hooked sessions; `delivery` → the queued bubble's clock tooltip and a muted line under it: "Waiting for the session to take it up (delivered to its hook)" (handed to a waiter), "Waiting for the next turn boundary" (mid-turn, before the fold; or a wake-up in flight / rate-limited), "No hook listening yet — type anything in that terminal once (the hooks were installed after this session started)" (idle, no waiter), "Session ended". The header's hooked note adds the no-waiter and ended words.
  - **Peers:** the peer derives the activity of its own sessions (supervised and hooked) and forwards `activity` (D48 already did); found and fixed: this machine's cached peer session kept the activity of its last `sessionUpdated`, so the sidebar list (reloaded on any `sessionUpdated`) fell back to a stale state; it now follows the `activity` events. A machine that is not online shows no live line (`activity: null`; the offline note says why).
  - **Nothing costs model calls, no hook is added** (the transcript's `tool_use` line makes `PreToolUse` unnecessary), nothing is stored, no migration, no new route or event name.
  - Details: `docs/derivations.md` → *Live activity* → *Hooked terminal sessions (D53)*, `docs/chat.md` → *Live activity line* and *Queued messages* → *Hooked sessions (D53)*, `docs/peers.md` → *Live activity and delivery state (D53)*, `docs/handoff/contracts/local-api.md` → *Live activity for hooked and peer sessions (D53)*; choices where the request is silent: `.loop/questions.md` → *D53 · Live activity for remote and hooked sessions*.

## Pin, re-order and folders in the sidebar (added 2026-09-29)
- **D54 Sessions can be pinned, re-ordered and grouped into folders in the sidebar.** Developer request, 2026-09-29: "Pin and re-order sessions in the left pane; foldable folders for sessions to order them." Builds on D33 (close / reopen), D41 (collapsible sidebar), D48 (peers' sessions, remote ids, offline snapshots).
  - **Order (ruling: manual only where the developer placed things):** SESSIONS lists **Pinned** (the dragged order), then the **folders** (the dragged order; a folder's sessions in their dragged order), then the **loose** sessions in the service's order, newest first, as before; a new session appears at the top of that list.
  - **Pin:** from a row's ⋯ menu (Pin / Unpin) or by dragging onto the Pinned group. A session is in one place only: pinned, in one folder, or loose.
  - **Folders (ruling: drag in / out, one level):** "+" in the SESSIONS label creates one; rename, delete (its sessions become loose), collapse / expand (remembered); sessions move in and out by drag and drop and by the row menu's "Move to folder ▸"; folders re-order by dragging their heads; "Move up / down" in the menus is the keyboard path. A collapsed folder shows its name, its session count and an amber dot while a session inside waits for the developer.
  - **Storage (ruling: Switchboard's database):** migration 0019 (`sidebar_folders`, `sidebar_places`); the same in every tab, the installed app and after restarts; live in other tabs through the additive `/hub` event `sidebarLayoutChanged` (the whole layout). Additive routes `GET /api/sidebar`, `POST /api/sidebar/folders`, `PUT /api/sidebar/folders/{folderId}` (+ `/position`), `DELETE /api/sidebar/folders/{folderId}`, `POST /api/sidebar/place`.
  - **Peers:** a paired machine's sessions can be pinned and put into this machine's folders; the layout is per machine (not on the peer API, not forwarded). Forgetting a machine removes its sessions' places.
  - **Closed sessions:** leave the sidebar as today (D33); their place is kept, so Reopen restores it. Deleting a session record removes its place.
  - **Unchanged:** with nothing pinned or foldered the list is the prototype's; hover ×, status dots, machine tags, folder tags, activity lines, the double-click rename and the command palette work as before.
  - Details: `docs/sidebar.md`, `docs/handoff/contracts/local-api.md` → *Sidebar pins and folders (D54)*, `docs/database.md` (0019); choices where the request is silent: `.loop/questions.md` → *D54 · Pin, re-order and folders in the sidebar*.

## Updates from GitHub releases (added 2026-09-30)
- **D55 Switchboard checks its GitHub releases and updates a release install itself; a git checkout is only told.** Developer request, 2026-09-30, after the 1.0.0 release (`switchboard-1.0.0.tar.gz` + `.sha256`, installed with `npm ci --omit=dev && npm start`). Builds on D14 (the data folder), M9.1 (the login service), D34 (the installed app), M2.4 (restart recovery), M3.3 (system Inbox items).
  - **Source (ruling):** the GitHub releases of `MarcinGadomski94/switchboard` (one constant, `RELEASE_REPO`; `SWITCHBOARD_UPDATE_REPO` for forks and tests), through the **public REST API, unauthenticated** (`releases/latest`); on 401 / 403 / 404 / 429 (private repository, rate limit) through **`gh`** (`gh release view` / `gh release download`) when it is installed and signed in, else "Can't reach releases: …". Drafts and pre-releases are ignored. Switchboard never sends a credential of the user's (gh uses its own). The repository became public on 2026-09-30, so the API is the primary path.
  - **When (ruling):** on start and **hourly**, plus **Check for updates** in the new **Settings → Updates** section (version, install kind, last check time and result, latest version, release notes as Markdown, the Update button, an error line). Versions compare as semver against `package.json`.
  - **Behaviour (ruling: prompt, then update + restart):** a newer release raises an Inbox system item (`update-available`, What's new / Dismiss, one per version) and a slim dismissible banner "Switchboard <v> is available" with **What's new** (the notes) and **Update**. Update, after a confirmation that names the sessions to be resumed: download the tarball and the `.sha256` (only from this repository's release asset URLs over HTTPS, redirects only to GitHub's asset hosts, size-limited); verify the SHA-256 (refused on a mismatch or a missing checksum); unpack into a staging folder under the data folder with Node's own zlib and a pure tar reader (only entries under `switchboard-<v>/`; traversal, absolute paths, links and special files refused); `npm ci --omit=dev` there (progress in the UI; a failure leaves the current install untouched); switch; restart. The database and the data folder are untouched (migrations run on the new version's start). One update at a time.
  - **Switch (ASSUMED D55-layout):** versions side by side under `<dataDir>/versions/<v>`; the **login service's definition is the stable pointer** (re-registered for the new folder, the M9.1 plan with its rollback); `<dataDir>/updates/installs.json` keeps the current and the previous install; the previous one stays for a manual rollback (`npm run service:install -- --start` in its folder).
  - **Restart:** verified that none of the login services restarts Switchboard on exit (M9.1: `KeepAlive` false, `Restart=no`, no `RestartOnFailure`), and that stays; instead the updater asks the manager for one start of the new definition: macOS a detached helper runs `launchctl bootout` + `bootstrap` once this process exited; Linux `systemctl --user restart --no-block`; Windows a detached helper runs `schtasks /Run` once this process exited. A Switchboard started by hand (`npm start`) never exits: the developer restarts it (the new folder's `npm start` command is shown). Live sessions resume through the existing restart recovery.
  - **Git checkouts (ruling: notify only):** a folder with `.git` gets the banner, the item, the notes and the git commands, no Update button. The developer's Mac runs from a git checkout.
  - **Windows:** paths, npm (`node <npm-cli.js>`, since `npm.cmd` needs a shell), extraction (no system `tar`) and the Task Scheduler restart are written for it; **unverified on Windows**.
  - **Peers:** nothing forwarded (`updateChanged` is this machine's; no update route on the peer API); a peer's version in Settings → Machines was not added (OPEN D55-peer-version).
  - **Releases:** `npm run release:package` writes `switchboard-<version>.tar.gz` + `.sha256` in the 1.0.0 layout; the developer publishes with `gh release create`.
  - **API (additive):** `GET /api/updates`, `POST /api/updates/check`, `POST /api/updates/install { version }` (202), `POST /api/updates/dismiss { version }`; `/hub` `updateChanged`; `SWITCHBOARD_UPDATES=off`. No migration (the state is the settings key `updates.state`).
  - Details: `docs/updates.md`, `docs/service.md` → *Restart after an update*, `docs/security.md` → *Updates (D55)*, `docs/handoff/contracts/local-api.md` → *Updates from GitHub releases (D55)*; choices where the request is silent: `.loop/questions.md` → *D55 · Updates from GitHub releases*.

## Simple New-session form (added 2026-09-30)
- **D56 The New-session dialog has a Simple form (the default) next to the Full one.** Developer request, 2026-09-30: "Add a simple session starter for new sessions — the current one is quite extensive and custom to what we use it for (workspace router answers, epic/task branching)." Builds on D14 (folders), D22 (titles), D32 (ticket branches), D40 (task-only worktrees), D42 (model at start), D48 (Machine row).
  - **Fields (ruling):** **Folder** (the saved folders, Browse…; D48's Machine row with a paired machine), **Message** (the first message; a textarea: Enter types a new line, **⌘↩ / Ctrl+↩** starts), **Title** (optional; empty = the message's first line, whole words up to 60 characters), **Model + effort** (D42's picker, on the last choice), **Work in its own git worktree** (one checkbox, only for a git repo folder; the branch is derived from the title as a plain slug, `sb/<short name>`, a title that starts with a ticket key keeps D32's pre-fill; shown read-only with **Edit**; any valid git branch name, no D32 ticket rule).
  - **Not in Simple (ruling):** router answers, solutions, branching (epic, base, parent), Ultracode, QA; also schedules, "Resume a terminal conversation" and "From a remote session" (Full only).
  - **Switch (ruling):** a **Simple / Full** toggle at the top; the mode is **remembered** as the settings row `newSession.mode` (`PUT /api/settings`, editable, like D41's pane rows; D42 keeps `models.last` in the same table); **Simple** on a fresh install; what is typed (folder, message, title, model, worktree) **carries over** (one form state). The palette's **New session** opens the remembered mode; a prefill ("Open fix session", a schedule's Edit) and schedule mode open Full.
  - **API (additive):** `POST /api/sessions` takes `simple: true` (`NewSimpleSession`): no router fields (stored `null`, also in a workspace), no solutions, no branching; `worktrees: true` only in a repo folder (422 in a workspace), its branch as sent or `sb/<name>`, cut by D40's task-only rule. The first message is the message alone: a workspace gets **no "Session-start answers" block** (the agent asks the router's questions itself); a repo worktree session gets only the worktree note. No migration.
  - Details: `docs/new-session.md` → *Simple mode (D56)*, `docs/handoff/contracts/local-api.md` → *Simple New-session form (D56)*, `docs/settings.md`; choices where the request is silent: `.loop/questions.md` → *D56 · Simple New-session form*.

## Paste and attach images and files (added 2026-09-30)
- **D57 The chat composer and the New-session forms take images and files: pasted, dropped or picked.** Developer request, 2026-09-30: "I need to be able to paste images and files like I do on the claude.ai page." Builds on D44 (queued messages), D50 (Stop), D56 (the Simple form), D48 (peers, hooked terminal sessions).
  - **Input (ruling):** in the chat composer **paste** (⌘V / Ctrl+V of a screenshot or an image copied in the browser, and of copied files where the browser exposes them), **drag and drop** onto the chat or the composer, and a **📎** file picker (several files); the same in the New-session forms' message field (Simple and Full), so the first message carries them. Before sending they are chips above the field (an image's thumbnail; a file's icon, name and size), each removable; the sent bubble shows thumbnails (a click opens them larger) and file chips with name and size (a PDF opens, other files download).
  - **Delivery (ruling: images + PDFs inline, others as files):** images (PNG, JPEG, GIF, WebP, sniffed by their magic bytes) and PDFs go **inline** in the stream-json user message as content blocks (`image` / `document` with a base64 `source`, the shapes CLI 2.1.284 / 2.1.285 accept, read in its binary); every other file is saved and the message names its absolute path under a line `Attached files:` (`- /…/attachments/<session>/<id>-<name> (12 KB)`), so the agent reads it with its tools. The CLI's limits decide what fits inline (2000 px, 5 MiB base64 / 3.75 MB raw per image, 20 MiB and 100 pages per PDF, a 32 MiB request): an image larger than that is downscaled in the browser first, and what still does not fit (or exceeds the message's inline budget of 24 MiB base64) goes as a file instead of being refused (ASSUMED D57-downscale, D57-inline-budget).
  - **Storage (ruling):** Switchboard's data folder, `<dataDir>/attachments/<session id>/<id>-<name>` (folder 0700, files 0600), never inside a repo; the New-session form's uploads are staged in `_staged/` and move into the new session at its start. Inline images and PDFs are stored too, and the message's event lists its attachments by id (no bytes in the database), so the chat shows them after a reload or a restart. Migration **0020** (`attachments`). Retention: a session's rows go with the session; files older than **30 days**, and folders of sessions that are gone, are removed at start (ASSUMED D57-retention).
  - **API (additive):** `POST /api/sessions/{id}/attachments` and `POST /api/attachments` (staged) take one file as `{ name, data }` (base64) and answer the `Attachment` (id, sanitized name, size, sniffed kind and type); `POST /api/sessions/{id}/messages` and `POST /api/sessions` take `attachments: [ids]` (a message may then have no text); `GET /api/sessions/{id}/attachments/{attachmentId}` serves it; `InterruptResult.withdrawnAttachments`; `UserPayload.attachments` / `sentText`. Caps: **20 MiB per file (413), 50 MiB and 20 files per message** (ASSUMED D57-caps, constants, not configurable).
  - **Serving (ruling):** behind the cookie guard like every route; a sniffed image or PDF inline with its own type, everything else (SVG and HTML included) as `application/octet-stream` + `Content-Disposition: attachment`; always `X-Content-Type-Options: nosniff`; a CSP that runs nothing (all but PDFs).
  - **Queued messages and Stop:** a message with attachments queues like any other (D44); a Stop gives its text and its attachments back to the composer (still uploaded, so sending again carries them).
  - **Peers (D48):** a peer's session uploads through the proxy to that machine (its data folder); the routes are on `PEER_API_ALLOW`, uploads take the attachments' body limit on the peer listener too, downloads pass through as bytes with their serving headers. **Hooked terminal sessions:** hooks carry text only, so every attachment is a file on that machine and its path goes in the message (ASSUMED D57-hooked).
  - **Transcripts:** a terminal prompt with images (Attach, a move, a teleport, a hooked session) keeps them: an image whose base64 is in the transcript is stored as the session's attachment and shown; one without bytes is a placeholder "image". History reads an image-only prompt as `[image]`.
  - Details: `docs/chat.md` → *Attachments (D57)*, `docs/security.md` → *Attachments (D57)*, `docs/database.md` (0020), `docs/handoff/contracts/local-api.md` → *Attachments (D57)*, `docs/fake-claude.md`; choices where the request is silent: `.loop/questions.md` → *D57 · Paste and attach images and files*.

## Resolved spec gaps (accepted as proposed)
1. New-session worktree: branch `session/{name}` from the repo's current HEAD, at `../{repo}-wt-{name}`.
2. "Move … to worktree": create the worktree, then pause + resume the session with a message telling it to move its work there. Never stash / reset / checkout the developer's working tree.
3. Remove worktree: refused if uncommitted or unpushed changes; never `--force`; the branch is kept.
4. "Reindex n now": starts a background session from a built-in reindex prompt (uses the codebase-memory MCP), no direct binary calls.
5. Terminal-started sessions: listed in History; "Attach here" warns if the transcript changed less than 2 minutes ago.
6. No default schedules. The prototype's four schedules are demo data only.
7. Timeline kinds: Read/Grep/Glob/search → plan; Edit/Write/Bash → impl; `/loop`, ScheduleWakeup, rebuild/self-heal → loop; question/permission → ask; successful result → ok. Documented in `docs/derivations.md`.
8. Agents = the main session + one per Agent/Task tool call (plus workflow agents if visible in stream-json). D51: they are, through `task_progress` and the CLI's run files.
9. Artifacts: PR (from gh output / PR URLs), BRANCH, DIFF per solution+branch, CONTRACT `contracts/*.md`, QA `coverage-matrix.md`, FOLLOWUP `mobile-followups/*`, DOC other written `.md`; TICKET not auto-detected in v1.
10. Diff = worktree vs merge-base with its base branch, including uncommitted changes; in-place sessions diff against HEAD.
11. Machine footer: machine-wide CPU/RAM; process count = live supervised `claude` processes.
12. `phase-ledger.md` parsed leniently (table or bullets); absent → "no phase-ledger.md".
13. Tool URLs are saved by Switchboard (per contract), so the copy "saved in this browser" becomes "saved in Switchboard".
14. Settings → Embedded tools can add and remove tools (name + URL).
15. The Solutions view also lists `other/` (group "other/", on request only), visible under the All filter.
16. The scanner skips worktree folders (where `.git` is a file).
17. Paths and copy follow the current OS (the prototype shows Windows paths).
18. DB + token in the per-user app-data folder; tests always use temp folders.
19. Geist / Geist Mono self-hosted (OFL), no font CDN at runtime.
20. The `sb_token` cookie is set when the UI page is loaded from a loopback Host with `Sec-Fetch-Site` none/same-origin; API and `/hub` reject a missing cookie or a foreign Host/Origin.
21. Demo seed with the prototype's mock data, used only by the visual oracle and screenshots, never in normal runs.

## Open for the developer (not blocking the build)
- Whether driving Claude Code from a local tool fits the Max subscription terms (handoff README open decision).
- The router `AGENTS.md` asks agents to always confirm session-start answers via AskUserQuestion; Switchboard pre-fills them from its form (M5.2). If agents keep re-asking, the router may need a Living-document amendment. Outside this repo, so not touched.
