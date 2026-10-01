# Resume point: Switchboard (2026-09-29, afternoon)

The repo lives at `~/RiderProjects/Personal/switchboard` (moved from the workspace's `other/switchboard`). The main branch is **`master`**, with a GitHub remote (`MarcinGadomski94/switchboard`). Push `master` to `origin` only when the developer asks (they did on 2026-09-29: `5a6c2df`, then `d1036fe`).

## master
- Merged 2026-09-29, on top of D38–D46 and the stuck-running fix:
  - D47 stacked task branches (Parent field, per-repo base / PR target, parent-merged and parent-closed Inbox items; migrations 0013, 0014);
  - the timeline.spec fix (page clock) and a Timeline refetch flicker fix;
  - D49 context window meter (bar above the quick replies, compaction reset, transcript backfill, auto-compact tick; migration 0015);
  - D48 Switchboard peers (Settings → Machines, pairing, Tailscale-only peer listener, proxied remote sessions and Inbox, start on a peer, hooks into hand-started terminal sessions, mid-turn replies, hooked subagents, offline snapshots; migrations 0016–0018; AGENTS.md loopback rule amended);
  - D50 Stop the current turn (■ Stop / Esc, `cancel_queued`, queued messages back into the composer, Stop background tasks, Stop through peers, refused for hooked sessions);
  - D51 workflow agents are visible (overview rows per run, cards capped at 6 with expand, openable chats, Solution from the first write, Resume run).
- Rulings for each are in `docs/decisions.md` and `.loop/questions.md`.
- Migrations 0001–0018.
- **Tests:** the last full run that was all green was on `fafd7d5` (D48 + D50): typecheck, `npm test -- --maxWorkers=4` 1879 + 1 skipped, `npm run e2e` 179/179. D51 passed its full suites on its branch; its rulings (`b0bf454`) had targeted tests only. The developer asked to **skip full test runs until they say so**: run typecheck plus the tests a change adds or touches.
- Real-CLI probes today (all D11: Haiku, sandbox): D48 3 sessions (the remote PC spike had 5 more, one of which ran away to ~52 turns through a probe-hook bug), D50 1, D51 1.
- Known flaky under load: the supervisor sync-point test, `session-handoff.spec`, `frame-helper.spec`, and timing-based server tests when several lanes run at once (`.loop/questions.md` → Known flaky tests). `timeline.spec` is fixed. Run unit tests with `--maxWorkers=4`.

## Lane feature/cli-providers (D62, 2026-10-01, not merged)
- Codex CLI and OpenCode as session providers: `.worktrees/providers`, branch `feature/cli-providers` from master `d5ca654`; commits per milestone P0–P8 (`git log master..feature/cli-providers`). Neither CLI was installed or run: run `docs/spike-providers.md` once they are. Migration 0023. Rulings / choices: `docs/decisions.md` → D62, `.loop/questions.md` → *D62 · Codex CLI and OpenCode*.

## Working rules
- The developer runs Switchboard as their own launchd agent (`com.switchboard`, port 13001) from the main checkout; it does `npm ci && npm run build && npm start` on every start. Never touch or restart it; never run tests or builds in the main checkout.
- Build features in `.worktrees/<lane>` on distinct test ports (`SWITCHBOARD_TEST_PORTS`). Merge in the main checkout; on a code conflict, abort and let the lane merge `master` into its branch. Verify in a detached `.worktrees/verify`.
- After merging, check that code fences in `docs/handoff/contracts/local-api.md` are balanced.

## Open questions for the developer (not blocking)
- D42: should scheduled runs update the remembered model choice? Should schedules edited before D42 start on the last choice?
- D44: mark or resend messages a killed process never took up?
- D39: several picks plus an own answer on multi-select questions?
- D41: live sync of pane state across tabs; is the 6 px rail right?
- D40: "letters" in epic branch names include non-ASCII letters (e.g. `Zażółć`); switch to ASCII only?

## The developer's next steps
- Restart their Switchboard to get today's build (the service rebuilds on start).
- **D48 on Windows (P5):** the checklist in `docs/peers.md` → *Windows setup and live test*. Nothing has run on Windows yet (OPEN D48-windows-live). `SWITCHBOARD_CLAUDE_BIN` on Windows: unset for the native installer's `claude.exe` on PATH; for an npm install, a JSON argv prefix `["<node.exe>","<…>\\@anthropic-ai\\claude-code\\cli.js"]`.
- Live tests: D24 Remote, D25 teleport, D31 model/effort, D30 with a real GitHub wait, D40/D47 branching on a real repo.

## Parked by the developer
- Safari can't frame signed-in sites; they open in a new tab.

## Clean-up
- Done 2026-09-29: every merged worktree and branch removed; only `master` remains.
