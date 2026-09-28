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
- **D15 Embedded tools through a local framing proxy.** Some tools refuse to be framed (the Codebase Memory UI sends `Content-Security-Policy: … frame-ancestors 'none'`), so the iframe stays blank. Switchboard serves each configured tool through its own **loopback-only reverse proxy on its own port** (127.0.0.1, OS-assigned, one per tool, restarted when the tool's URL changes) and the iframe loads the proxy (`frameUrl`, additive on `Tool`). The proxy forwards method, path, query, body and headers unchanged (WebSocket upgrades too), with these exceptions only: the response's `X-Frame-Options` is dropped and its CSP `frame-ancestors` is replaced by Switchboard's own origins; `Location` headers pointing at the tool are rewritten to the proxy; the request's `Host` is the tool's; **Switchboard's `sb_token` cookie is stripped** before forwarding (cookies ignore ports); requests with a foreign `Host` are refused (DNS rebinding). It only ever forwards to the configured tool URL. Because it runs on its own port, the framed tool is a different origin and cannot use Switchboard's API (the Origin guard refuses it). "New tab" still opens the tool's own URL. If framing fails anyway, the overlay says so and offers New tab (the prototype's copy).
- **D16 Move terminal conversations into Switchboard.** A conversation started in a terminal (History lists it from the transcripts) can **continue in Switchboard as the same conversation**: Switchboard creates a session bound to the transcript's Claude session id, imports its history into the chat (the Attach-here import), and spawns `claude --resume <id>` under supervision with no new message (idle, waiting for you). `claude --resume <id>` keeps working later. While the terminal may still have it open (transcript changed < 2 min ago, or `claude agents --json` lists it live) the move warns and needs a confirm (two live processes on one id split the transcript, M0.4).
  - **Where:** History rows of terminal conversations get **Continue in Switchboard**, with checkboxes and **Move selected (n)** for several at once; the New-session form gets a **Resume a terminal conversation** option listing the chosen folder's terminal conversations not in Switchboard yet (picking one replaces the task; Start moves it).
  - **Folder:** the session's folder is the saved folder that holds the conversation's start folder. If none does, the move offers to **add** the workspace or repo it sits in (D14 rules) and continues; otherwise it is refused with the reason.
  - **Name:** from the conversation's title (else first prompt), kebab-case, made unique. Moved sessions have no session-start answers (work type / mode / phase stay empty) and get no first message.

## Resolved spec gaps (accepted as proposed)
1. New-session worktree: branch `session/{name}` from the repo's current HEAD, at `../{repo}-wt-{name}`.
2. "Move … to worktree": create the worktree, then pause + resume the session with a message telling it to move its work there. Never stash / reset / checkout the developer's working tree.
3. Remove worktree: refused if uncommitted or unpushed changes; never `--force`; the branch is kept.
4. "Reindex n now": starts a background session from a built-in reindex prompt (uses the codebase-memory MCP), no direct binary calls.
5. Terminal-started sessions: listed in History; "Attach here" warns if the transcript changed less than 2 minutes ago.
6. No default schedules. The prototype's four schedules are demo data only.
7. Timeline kinds: Read/Grep/Glob/search → plan; Edit/Write/Bash → impl; `/loop`, ScheduleWakeup, rebuild/self-heal → loop; question/permission → ask; successful result → ok. Documented in `docs/derivations.md`.
8. Agents = the main session + one per Agent/Task tool call (plus workflow agents if visible in stream-json).
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
