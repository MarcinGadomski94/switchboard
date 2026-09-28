## Current
item: (none) · M4.4 done, lane w2-tabs idle
attempt: 0/5
last oracle: M4.4 e2e tests/e2e/timeline.spec.ts PASS (attempt 2/5; attempt 1 red: range end vs playhead clock differed for a sub-second session → axis end padded to the minimum span) · full suite `SWITCHBOARD_TEST_PORTS=4930-4939 npx playwright test` 23/23 · `npm test` 501/501 · typecheck green · visual tests/e2e/visual/timeline.spec.ts green inside the tab container (docs/visual/timeline.md)
## Done
- M4.4 ✓ 2026-09-28 (commit: see git log "M4.4: Timeline tab") · attempts 2/5 · plan: pure model src/web/views/session/timeline.ts (lanes per agent main-first, blocks plan/impl/loop/ask/ok + error with the prototype K colors, axis first event → newest ts/endTs, open blocks to now while live, 0–1000 scrubber, ▶/❚❚ 8 per 50 ms, "Events up to" last 8, H:MM / H:MM:SS clock); terminal-tail.ts (console lines from real payloads, prototype lineColor, [agent] tags; shared with M4.3); TimelineTab.tsx + timeline.css (GET /events + /hub event upserts, refetch on hub reopen, agents via GET /sessions/{id} + sessionUpdated + refetch on unknown agent, 1 s clock while an open block runs); tests/web/{timeline,terminal-tail}.test.ts; tests/e2e/timeline.spec.ts (real path: fake-claude tool-use → subagent → ask-2q, no demo); tests/e2e/visual/timeline.spec.ts; docs/derivations.md (Timeline tab, Terminal tail), lanes row, docs/visual/timeline.md + README review
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions-w2-tabs.md)
- M4.4 · blocks = plan/impl/loop/ask/ok + error (fail hue); tool/text events not blocks
- M4.4 · lanes main-first then by first block; unknown/null agent → main lane; sub = solutionPath / "workspace root" for main
- M4.4 · axis + open blocks to now while live; H:MM:SS under 6 min; 14 px point blocks
- M4.4 · terminal tail from real payloads (shared with M4.3; merge keeps one)
- M4.4 · demo terminal lines (provisional channel payloads) not rendered → empty demo terminal
- M4.4 · visual check inside the tab container (grid/header are M4.1)
