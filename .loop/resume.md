# Resume point: Switchboard (2026-09-28 ~17:45)

Everything is local to `other/switchboard`. Nothing is pushed.

## main: HEAD `26bd5a0`, all green (D29 layout: 1235 + 1 skipped, e2e 114/114). The developer's instance was rebuilt and restarted at 17:53, with everything through D26 plus D29

## In flight
| Item | Worktree · branch | Ports | Migration |
|---|---|---|---|
| D28 follow-up: narrow the helper to site-tool hosts in Switchboard's tab | `.worktrees/frame-scope` · `feature/frame-scope` | 4930-4939 | — |
| D30 background work shows as working (GitHub Actions waits) | `.worktrees/background-work` · `feature/background-work` | 4940-4949 | — |
| D31 model + effort in a running session | `.worktrees/model-effort` · `feature/model-effort` | 4950-4959 | 0009 |
| D32 ticket branch names for worktrees | `.worktrees/ticket-branch` · `feature/ticket-branch` | 4920-4929 | 0011 if needed |
| D33 close sessions, reopen from History | `.worktrees/close-sessions` · `feature/close-sessions` | 4960-4969 | 0010 |

On main: D28 merged `81b0816` (Chrome works; Safari can't apply response-header rules, so it opens a new tab), its rulings `37e9b42`; suites 1289 + 1 skipped, e2e 119/119. Merged worktrees still on disk: reported-table, frame-helper (ask before removing).
Earlier on main: D27 merged, with its rulings (glyphs; an unreadable table is a note); D29 layout; the empty-first-bubble fix `1a6e364`; decisions D30–D33 (`2ca00ad`).

## Before: `efbb185`
- Merged: test-build isolation, D23, D20, D19, D22 (rulings 1–4), D21 (plus its rulings), D24 Remote Control, D25 teleport, the remote spike doc, and a visual report.
- Last run: typecheck; `npm test` 1234 + 1 skipped (before the CSS fix `0a26608`, which only touches the header CSS/TSX and the teleport E2E); `npm run e2e` 112/112 after it.
- Migrations 0001–0008.
- Known flaky: a supervisor transcript sync-point test (`.loop/questions.md` → Known flaky tests).

## The developer's next steps
- Their Switchboard on 127.0.0.1:4870 runs from this checkout. It needs `npm run build` + a restart: migrations 0006–0008 run on start, and the UI is new. Never restart it for them.
- Live tests (the checklists are in `docs/remote-control.md` for D24 and in the D25 agent report, summarised in `docs/supervisor.md` → Teleport).
- The D24 handshake: every spawn now sends `initialize` first. Watch for anything odd.

## Clean-up
- Done 2026-09-28: the nine merged worktrees and their branches were removed.
