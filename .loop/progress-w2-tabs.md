## Current
item: (none) · M4.5 done, lane w2-tabs idle
attempt: 0/5
last oracle: M4.5 e2e tests/e2e/diff.spec.ts PASS (attempt 1/5; re-run green after keying the tab by session, attempt 2/5) · visual tests/e2e/visual/diff.spec.ts green inside the tab container, 0 % pixel diff (docs/visual/diff.md) · full suite `SWITCHBOARD_TEST_PORTS=4930-4939 npx playwright test` 25/25 · `npm test` 514/514 · typecheck green
## Done
- M4.5 ✓ 2026-09-28 (commit: see git log "M4.5: Diff tab") · attempts 2/5 (both green) · plan: `GET /api/sessions/{id}/diff?file=` in api/sessions.ts over providers.diff (404 / 422 / [] without provider; 501 row removed); additive `FileDiff.uncommitted` (WorktreeManager: untracked + `git diff --name-only HEAD`, in place all, demo all); pure model src/web/views/session/diff.ts (rows short / delta / "solution · path", header "solution / path" + "⎇ branch", note while uncommitted, line tones, key selection) + DiffTab.tsx + diff.css (prototype inline styles; refetch on /hub event kinds impl/loop/ok/tool/error, sessionUpdated, hub reopen, focus); tests/web/diff.test.ts, tests/server/api/diff.test.ts, manager.test + routes.test updates; tests/e2e/diff.spec.ts (real path: fake-claude writes into a temp repo worktree, committed + uncommitted + untracked, live via /hub, in place, empty); tests/e2e/visual/diff.spec.ts; docs worktrees.md / derivations.md / lanes.md / demo.md / visual README
- M4.4 ✓ 2026-09-28 (commit: see git log "M4.4: Timeline tab") · attempts 2/5 · plan: pure model src/web/views/session/timeline.ts (lanes per agent main-first, blocks plan/impl/loop/ask/ok + error with the prototype K colors, axis first event → newest ts/endTs, open blocks to now while live, 0–1000 scrubber, ▶/❚❚ 8 per 50 ms, "Events up to" last 8, H:MM / H:MM:SS clock); terminal-tail.ts (console lines from real payloads, prototype lineColor, [agent] tags; shared with M4.3); TimelineTab.tsx + timeline.css (GET /events + /hub event upserts, refetch on hub reopen, agents via GET /sessions/{id} + sessionUpdated + refetch on unknown agent, 1 s clock while an open block runs); tests/web/{timeline,terminal-tail}.test.ts; tests/e2e/timeline.spec.ts (real path: fake-claude tool-use → subagent → ask-2q, no demo); tests/e2e/visual/timeline.spec.ts; docs/derivations.md (Timeline tab, Terminal tail), lanes row, docs/visual/timeline.md + README review
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions-w2-tabs.md)
- M4.5 · "Not committed" note per selected file while `FileDiff.uncommitted` (additive field); hidden once committed; shown without files
- M4.5 · delta `+a` / `−r` / both / `—`, single green; key selection, fallback to the first file
- M4.5 · refetch on /hub event kinds impl/loop/ok/tool/error, sessionUpdated, reconnect, focus (500 ms fold)
- M4.5 · route 404 / 422 bad `file` / [] without provider
- M4.5 · visual check with the tab container pinned to the prototype's box (M4.1 grid in another lane)
- M4.4 · blocks = plan/impl/loop/ask/ok + error (fail hue); tool/text events not blocks
- M4.4 · lanes main-first then by first block; unknown/null agent → main lane; sub = solutionPath / "workspace root" for main
- M4.4 · axis + open blocks to now while live; H:MM:SS under 6 min; 14 px point blocks
- M4.4 · terminal tail from real payloads (shared with M4.3; merge keeps one)
- M4.4 · demo terminal lines (provisional channel payloads) not rendered → empty demo terminal
- M4.4 · visual check inside the tab container (grid/header are M4.1)
