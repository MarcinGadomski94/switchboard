# Resume point: Switchboard (2026-09-28, late evening)

Everything is local to `other/switchboard`. Nothing is pushed.

## main: HEAD `8f883e7`, all green
- typecheck (4 configs); `npm test` 1474 + 1 skipped; `npm run e2e` 139/139.
- Merged today: D19–D34, the D28 scope follow-up, the empty-first-bubble fix, and toasts that close by themselves. D34 (installable app) also has its localhost → 127.0.0.1 page redirect.
- README.md at the root: move D35–D37 from "Coming (being built)" into Features when they merge.
- Migrations 0001–0010.
- Known flaky under load: the supervisor sync-point test and `session-handoff.spec` (`.loop/questions.md` → Known flaky tests).

## In flight
| Item | Worktree · branch | Ports |
|---|---|---|
| D35 guided frame-helper setup (the Web Store was dropped) | `.worktrees/helper-setup` · `feature/helper-setup` | 4930-4939 |
| D36 subagent chats + D37 finished subagents leave the panel | `.worktrees/subagent-chat` · `feature/subagent-chat` | 4940-4949 |

## The developer's next steps
- `npm run build`, then restart their Switchboard (127.0.0.1:4870). Never restart it for them.
- Reload the unpacked frame helper in Chrome (2.0.0).
- Install the app (Chrome: Settings → Claude Code → Install as app; Safari: File → Add to Dock).
- Live tests: D24 Remote, D25 teleport, D31 model/effort, D30 with a real GitHub wait.

## Parked by the developer
- Remote sessions on the other PC (Windows).
- Safari can't frame signed-in sites; they open in a new tab.

## Clean-up (ask first)
- Merged worktrees: reported-table, frame-helper, frame-scope, background-work, model-effort, ticket-branch, close-sessions, pwa.
- Older fully merged branches: feature/tool-proxy, feature/usage-ram, lane/w1-*, lane/w2-*.
