# Resume point: Switchboard (2026-09-28, late evening)

Everything is local to `other/switchboard`. Nothing is pushed.

## main: all green after the D34–D37 merges
- typecheck (4 configs); `npm test` 1523 + 1 skipped; `npm run e2e` 147/147 (visual report committed).
- Merged today: D19–D34, the D28 scope follow-up, the empty-first-bubble fix, and toasts that close by themselves. D34 (installable app) also has its localhost → 127.0.0.1 page redirect.
- README.md at the root describes everything on main.
- Migrations 0001–0010.
- Known flaky under load: the supervisor sync-point test and `session-handoff.spec` (`.loop/questions.md` → Known flaky tests).

## In flight (2026-09-29)
| Item | Worktree · branch | Ports |
|---|---|---|
| D38 solutions chosen by the agent | `.worktrees/agent-solutions` · `feature/agent-solutions` | 4920-4929 |
| D39 own answers (Other…) on question cards | `.worktrees/own-answers` · `feature/own-answers` | 4930-4939 |
| D41 collapsible sidebar / right panel, remembered | `.worktrees/collapsible-panes` · `feature/collapsible-panes` | 4940-4949 |
| D40 epic/task branching in the New-session form | **not started: dispatch after D38 merges** (same form, first message and worktree code) | 4950-4959 |

The repo lives in ~/RiderProjects/Personal/switchboard; its default port is 13001; the developer's own launchd service (com.switchboard) runs `npm ci` on start. Never run anything in the main checkout while it may restart; use worktrees.

## The developer's next steps
- `npm run build`, then restart their Switchboard (127.0.0.1:4870). Never restart it for them.
- Reload the unpacked frame helper in Chrome (2.0.0).
- Install the app (Chrome: Settings → Claude Code → Install as app; Safari: File → Add to Dock).
- Live tests: D24 Remote, D25 teleport, D31 model/effort, D30 with a real GitHub wait.

## Parked by the developer
- Remote sessions on the other PC (Windows).
- Safari can't frame signed-in sites; they open in a new tab.

## Clean-up
- Done 2026-09-28: every merged worktree and branch removed; only `main` remains.
