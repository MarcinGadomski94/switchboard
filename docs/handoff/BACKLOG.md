# Backlog

Order matters. Each item: **AC** = acceptance criteria, **Oracle** = how it's verified. Items marked *(adapt after M0)* may be rewritten by the M0 spike. Stack is Node.js (see `docs/decisions.md`); items below were adapted from the original .NET wording on 2026-09-27.

## M0 · Spike (findings adopted directly; review stop waived 2026-09-27)
- [x] **M0.1 Claude Code headless surface.** Check the installed version's streaming output (`-p --output-format stream-json --verbose`), streaming input (`--input-format stream-json`), `--resume`/`--session-id`, `--permission-mode`, `--allowedTools`, and `--max-turns`. Check whether hooks fire in print mode and how background sessions and attach work. **Oracle:** `docs/spike-m0.md` with the exact commands and captured NDJSON samples in `tools/fake-claude/fixtures/`.
- [x] **M0.2 Questions & permissions.** Find out how `AskUserQuestion` (multi-question, options) and permission requests appear in headless mode, and how to answer them programmatically. Fallbacks, in order: (a) native stream-json control messages; (b) the Claude Agent SDK's permission/tool callbacks, if they can use the CLI's subscription login; (c) a PreToolUse/Notification hook that POSTs to the local service and blocks for the answer. **Oracle:** a recorded fixture of a question answered end-to-end.
- [x] **M0.3 Transcripts & usage.** Confirm the local transcript location (`~/.claude/projects/**.jsonl`) and its format, used for History and terminal-started sessions. Evaluate sources for Max usage %. **Oracle:** notes + sample parse.
- [x] **M0.4 Terminal handoff.** Prove that a session started by the service can be continued in a terminal with `claude --resume <id>` and then picked up again by the service. **Oracle:** recorded steps.

## M1 · Skeleton
- [ ] **M1.1** One Node project per `ARCHITECTURE.md` (`src/core`, `src/server`, `src/web`, `tools/`, `tests/`), TypeScript strict, npm scripts `dev`, `build`, `start`, `typecheck`, `test`, `e2e`. Fastify binds to 127.0.0.1:4870 only (port configurable for tests). Host/Origin guard + `sb_token` cookie middleware. **Oracle:** typecheck + tests asserting a non-loopback bind is refused and foreign Host/Origin / missing cookie are rejected.
- [ ] **M1.2** `tools/fake-claude` (Node script, same argv surface as the real CLI per M0): replays fixtures and supports resume, questions and hang. **Oracle:** unit tests.
- [ ] **M1.3** SQLite via built-in `node:sqlite` with plain SQL migrations covering **every** entity in the data model up front (later items should not need schema changes). **Oracle:** migration test (fresh DB + re-run is a no-op).
- [ ] **M1.4** App shell (React + Vite): sidebar + main area, tokens from `SPEC.md` as CSS variables, fonts Geist / Geist Mono self-hosted. Includes the demo seed loader (`docs/decisions.md` #21) and the Playwright visual-oracle harness (app + prototype screenshots at 1440×900). **Oracle:** visual match of the empty shell.

## M2 · Session runtime
- [ ] **M2.1** SessionSupervisor: start, stop, pause and resume a Claude Code process with cwd = workspace root. Streams NDJSON into typed events. **Oracle:** integration test with fake-claude.
- [ ] **M2.2** Worktree manager: `git worktree add ../{repo}-wt-{session}` for each solution in scope, a registry, and cleanup once the PR is merged (via `gh pr view --json state`). **Oracle:** tests on a temp git repo.
- [ ] **M2.3** SSE hub `/hub` with events per `contracts/local-api.md`. **Oracle:** contract test.
- [ ] **M2.4** Crash recovery: on service restart, running sessions are re-attached via `--resume`. **Oracle:** kill/restart test.

## M3 · Inbox & questions
- [ ] **M3.1** Question pipeline (per M0.2) → a `Question` entity with source attribution and verbatim text. **Oracle:** fixture test.
- [ ] **M3.2** Inbox view (SPEC §Inbox): list + detail, batched answers. Send stays disabled until every question is answered. **Oracle:** E2E + visual.
- [ ] **M3.3** System items: failed scheduled run, and PR merged → worktree removable. **Oracle:** E2E.
- [ ] **M3.4** Notifications: toast + sound + OS notification (Web Notifications API). "Jump to session" works. **Oracle:** E2E with a mocked Notification.

## M4 · Session view
- [ ] **M4.1** Header with the session-start chips, Pause, and Continue in terminal / Attach here. **Oracle:** visual.
- [ ] **M4.2** Chat tab: messages, tool-step lines, inline question card, quick replies, composer. **Oracle:** E2E + visual.
- [ ] **M4.3** Agents & solutions panel, terminal tail, handoff card with copy. **Oracle:** visual.
- [ ] **M4.4** Timeline tab: lanes per agent, playhead, scrub/play, event log. **Oracle:** E2E.
- [ ] **M4.5** Diff tab: files per solution/branch, unified diff. Shows "Not committed" until the developer approves. **Oracle:** E2E on a temp repo.
- [ ] **M4.6** Artifacts tab. **Oracle:** E2E.

## M5 · New session & setup
- [ ] **M5.1** New-session modal (SPEC §New session): task first, then work type, mode, solutions (read-only folders locked), phase, coordination or QA contract, worktree toggle, ultracode toggle, live summary. **Oracle:** E2E.
- [ ] **M5.2** The confirmed answers are passed to the agent in its first message, so it confirms instead of re-asking. *(adapt after M0)* **Oracle:** fixture test on the first-turn payload.
- [ ] **M5.3** First-run wizard (5 steps). The CLI check uses `claude auth status`, and gh uses `gh auth status`. **Oracle:** E2E.

## M6 · Solutions
- [ ] **M6.1** Workspace scanner: reads the router `AGENTS.md` folder rules; editable / on request / read-only. **Oracle:** unit test on a fixture workspace.
- [ ] **M6.2** Solutions view: groups, branch chips with worktree and session, filter, detail panel (branches, phase-ledger, artifacts, follow-ups). **Oracle:** visual + E2E.
- [ ] **M6.3** Conflict detection: two sessions writing the same repo without worktree isolation → warning plus a "move to worktree" action. **Oracle:** unit + E2E.
- [ ] **M6.4** codebase-memory freshness from `.claude/.codebase-memory-dirty`. **Oracle:** unit.

## M7 · Schedules, loops, artifacts, history
- [ ] **M7.1** Scheduler (cron): runs a session from a template; run now, pause/resume, 14-run history strip. "+ New scheduled run" opens the New-session modal with a 7th *Schedule* section (cron field, readable preview, next 3 run times; button "Save schedule"); Edit reopens it prefilled. **Oracle:** unit with a fake clock + E2E.
- [ ] **M7.2** Loop cards: iteration, cap, breaker state, expiry. Iteration / next firing / expiry from observed /loop, ScheduleWakeup, CronCreate and Workflow events; cap + breaker from a `.loop/progress.md` in the session's working folders if present, else "—". **Oracle:** E2E.
- [ ] **M7.3** Global artifacts: filters + search; clicking opens the source session. **Oracle:** E2E.
- [ ] **M7.4** History from stored sessions + transcripts; searchable. **Oracle:** E2E.

## M8 · Tools & settings
- [ ] **M8.1** Embedded tools: configurable URL, reachability probe, iframe, offline/not-configured states, open in new tab. Codebase Memory (`http://localhost:13000`) and Acme Tool (URL set in Settings). **Oracle:** E2E with a local stub server.
- [ ] **M8.2** Settings: 7 sections per SPEC, persisted in SQLite (tool URLs included; Embedded tools can add/remove tools). **Oracle:** E2E.
- [ ] **M8.3** ⌘K / Ctrl+K palette: views, sessions, solutions, tools, New session; arrow keys + Enter. **Oracle:** E2E.

## M9 · Packaging
- [ ] **M9.1** Runs as a per-user background service: Windows (Task Scheduler at logon, or a Windows Service), macOS (launchd agent), Linux (systemd --user). "Start at login" toggle. Requires Node ≥ 24 on PATH. **Oracle:** generated launchd / systemd / Task Scheduler files verified by unit tests and a `--dry-run` of install/uninstall; a GitHub Actions matrix workflow is written but not run (no remote). Nothing is installed on this machine.
- [ ] **M9.2** Usage meter per M0.3, warning at 90%, "just warn" behavior. **Oracle:** unit.
- [ ] **M9.3** Full visual pass of every view against the prototype. **Oracle:** screenshot suite.
