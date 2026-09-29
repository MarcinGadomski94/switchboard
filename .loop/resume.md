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
| D41 collapsible sidebar / right panel | `.worktrees/collapsible-panes` · `feature/collapsible-panes` | 4940-4949 |
| D43 background workflows + any CLI task show as working | `.worktrees/bg-workflows` · `feature/bg-workflows` | 4910-4919 |
| D44 clock on queued chat messages | `.worktrees/queued-messages` · `feature/queued-messages` | 4900-4909 |
| D45 session loading skeleton + instant revisit | `.worktrees/session-loading` · `feature/session-loading` | 4890-4899 |
| D46 Session-bar pace (5 h), every minute | `.worktrees/session-pace` · `feature/session-pace` | 4880-4889 |
| D40 epic/task branching | **after D38 merges** | 4950-4959 |
| D42 model + effort in the form, remembered | **after D38 merges** | 4960-4969 |

- D39 is merged (`97b74a8`) and verified in `.worktrees/verify` (a detached worktree at master): e2e 149/149; 10 unit timeouts under load average ~39 passed on rerun (49/49).
- The main branch is **`master`**; there is a GitHub remote (`MarcinGadomski94/switchboard`). Never push.
- Verify merges in `.worktrees/verify` (`git -C .worktrees/verify checkout --detach master`), never in the main checkout (the developer's launchd service runs from it and does `npm ci` on start).
- Open question for the developer: several picks on multi-select questions together with an own answer (D39 allows one pick per question).

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
