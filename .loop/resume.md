# Resume point: Switchboard (2026-09-28, late evening)

Everything is local to `other/switchboard`. Nothing is pushed.

## main: all green after the D34–D37 merges
- typecheck (4 configs); `npm test` 1523 + 1 skipped; `npm run e2e` 147/147 (visual report committed).
- Merged today: D19–D34, the D28 scope follow-up, the empty-first-bubble fix, and toasts that close by themselves. D34 (installable app) also has its localhost → 127.0.0.1 page redirect.
- README.md at the root describes everything on main.
- Migrations 0001–0010.
- Known flaky under load: the supervisor sync-point test and `session-handoff.spec` (`.loop/questions.md` → Known flaky tests).

## In flight
- Nothing. Open D36 questions for the developer: trim the subagent result wrapper? store background subagents' final summary?

## The developer's next steps
- `npm run build`, then restart their Switchboard (127.0.0.1:4870). Never restart it for them.
- Reload the unpacked frame helper in Chrome (2.0.0).
- Install the app (Chrome: Settings → Claude Code → Install as app; Safari: File → Add to Dock).
- Live tests: D24 Remote, D25 teleport, D31 model/effort, D30 with a real GitHub wait.

## Parked by the developer
- Remote sessions on the other PC (Windows).
- Safari can't frame signed-in sites; they open in a new tab.

## Clean-up (ask first)
- Merged worktrees: reported-table, frame-helper, frame-scope, background-work, model-effort, ticket-branch, close-sessions, pwa, helper-setup, subagent-chat.
- Older fully merged branches: feature/tool-proxy, feature/usage-ram, lane/w1-*, lane/w2-*.
