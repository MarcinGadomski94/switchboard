# Resume point: Switchboard (2026-09-29)

The repo lives at `~/RiderProjects/Personal/switchboard` (moved from the workspace's `other/switchboard`). The main branch is **`master`**; there is a GitHub remote (`MarcinGadomski94/switchboard`). Never push.

## master: all green at 363cbe6
- typecheck (4 configs); `npm test -- --maxWorkers=4` 1707 + 1 skipped; `npm run e2e` 168/168 (in `.worktrees/verify`, ports 4970-4979).
- Merged 2026-09-29: default port 13001 (`440fea1`), D39 own answers, D41 collapsible panes, D38 agent-chosen solutions (migration 0011), D43 every background task counts, D46 Session-bar pace, D42 model + effort at start, the stuck-running fix (turn accounting in the recorder), D45 session loading, D44 clock on queued messages, D40 epic/task branching (migration 0012). Rulings for each are in `docs/decisions.md` and `.loop/questions.md`.
- README.md at the root describes everything on master.
- Migrations 0001–0012.
- Known flaky under load: the supervisor sync-point test, `session-handoff.spec`, `timeline.spec`, and timing-based server tests when several lanes run at once (`.loop/questions.md` → Known flaky tests). Run unit tests with `--maxWorkers=4`.

## Working rules
- The developer runs Switchboard as their own launchd agent (`com.switchboard`, port 13001) from the main checkout; it does `npm ci && npm run build && npm start` on every start. Never touch or restart it, never run tests or builds in the main checkout.
- Build features in `.worktrees/<lane>` on distinct test ports (`SWITCHBOARD_TEST_PORTS`). Merge in the main checkout; verify in `.worktrees/verify` (`git -C .worktrees/verify checkout --detach master`).
- After merging, check that code fences in `docs/handoff/contracts/local-api.md` are balanced.

## Open questions for the developer (not blocking)
- D42: should scheduled runs update the remembered model choice? Should schedules edited before D42 start on the last choice?
- D44: run a live Haiku probe of mid-turn absorption? Mark or resend messages a killed process never took up?
- D39: several picks plus an own answer on multi-select questions?
- D41: live sync of pane state across tabs; is the 6 px rail right?
- D40: "letters" in epic branch names include non-ASCII letters (e.g. `Zażółć`); switch to ASCII only?

## The developer's next steps
- Restart their Switchboard (the service rebuilds on start). The session stuck as running on the old build clears after the restart.
- Live tests: D24 Remote, D25 teleport, D31 model/effort, D30 with a real GitHub wait, D40 branching on a real repo.

## Parked by the developer
- Remote sessions on the other PC (Windows).
- Safari can't frame signed-in sites; they open in a new tab.

## Clean-up
- Worktrees of merged lanes (D38–D46, fix/stuck-running, verify) are still present; remove them only when the developer says so.
