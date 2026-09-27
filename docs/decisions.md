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
