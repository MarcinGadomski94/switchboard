## Current
item: (none) · M8.3 done, lane w2-tabs idle
attempt: 0/5
last oracle: M8.3 e2e tests/e2e/palette.spec.ts PASS (attempt 1 red: typecheck — the pure model imported router.tsx under the non-JSX tsconfig — and the solution order (scanner lists auth-front before web-front); attempt 2 red: Enter pressed before GET /api/solutions answered in the test (waits added); green from attempt 3; the tools test is an expected failure while GET /api/tools is 501, D13) · final: typecheck green · `SWITCHBOARD_TEST_PORTS=4930-4939 npm test` 562/562 · `npx playwright test` 33/33 (1 expected failure) · visual tests/e2e/visual/palette.spec.ts green, pixel diff 1.3 / 0.4 / 0.4 % (docs/visual/palette.md) · nothing listening on 4930–4939
## Done
- M8.3 ✓ 2026-09-28 (commit: see git log "M8.3: ⌘K / Ctrl+K palette") · attempts 3/5 · plan: pure model src/web/modals/palette.ts (views · New session · tools · sessions · solutions in the prototype order; filter on `label kind hint`, case-insensitive; max 10; clamp + ↑↓) + Palette.tsx + palette.css (prototype inline styles; GET /api/sessions, /api/tools, /api/solutions per opening, sessionUpdated reload; Enter / click pick; ⌘K while open resets); solution results select through src/web/views/solution-focus.ts (+3 lines in SolutionsView); modals.css palette overlay align-items → normal; tests/web/palette.test.ts; tests/e2e/palette.spec.ts (real path: fake-claude sessions, temp git workspace, live /hub; tools test expected-red until M8.1 merges); tests/e2e/visual/palette.spec.ts; docs derivations.md (⌘K palette) / lanes.md / visual README + palette.md
- M7.2 ✓ 2026-09-28 (commit: see git log "M7.2: Loop cards") · attempts 2/5 (+2 DoD fix rounds) · plan: pure src/core/derive/loops.ts (`/loop` message, CronCreate / ScheduleWakeup / CronDelete / Workflow tool events, self-started turns = firings; iteration, strip, next firing, expiry, note) + src/core/derive/cron-next.ts + src/core/loop-progress.ts; src/server/loops/{tracker,progress,wire}.ts LoopTracker (supervisor `event` → derive → `loops` rows `loop:<session>:<key>` + `sessionUpdated`; progress file from worktrees / solution folders / cwd; preClose close + startup sweep) wired in buildApp; additive `Session.loops` (wire `Loop`, `LoopIteration`); UI src/web/views/{LoopCards.tsx,loops.ts,loops.css,schedules.css} + SchedulesView mount; fake-claude `[fake:tool]` / `[fake:fire]`; tests core (loops, cron-next, loop-progress), web/loops, server/loops/tracker (real supervisor + fake-claude), tools/fake-claude-loop, hub keys; E2E tests/e2e/loops.spec.ts (real path: /loop + CronCreate + 2 firings live, progress cap + breaker, progress change, reload, pause stops, Open session; ScheduleWakeup + need border; Workflow card); visual tests/e2e/visual/loops.spec.ts; docs derivations.md (Loop cards) / lanes.md / fake-claude.md / demo.md / core README / visual README + loops.md
- M4.6 ✓ 2026-09-28 (commit: see git log "M4.6: Artifacts tab") · attempts 2/5 · plan: pure model src/web/views/session/artifacts.ts (rows in server order: tag + stored name + stored meta; DIFF in the session form `<solution> · <n files>` with count + `+a −r` from SessionDetail.files for the same solution/branch unless a meta is stored; empty → INFO · No artifacts) + ArtifactsTab.tsx + artifacts.css (prototype inline styles; GET /api/sessions/{id}); refresh hook useSessionRefresh.ts extracted from DiffTab and shared; demo seed inserts artifacts last-to-first (prototype order on same-age ties) + seed test; tests/web/artifacts.test.ts; tests/e2e/artifacts.spec.ts (real path: fake-claude writes CONTRACT / DIFF / DOC / QA / FOLLOWUP in a temp workspace + worktree, live via /hub, git-based DIFF counts incl. a developer commit, contract route, styles, INFO empty row); tests/e2e/visual/artifacts.spec.ts; docs derivations.md (Artifacts tab) / lanes.md / demo.md / visual README + artifacts.md
- M4.5 ✓ 2026-09-28 (commit: see git log "M4.5: Diff tab") · attempts 2/5 (both green) · plan: `GET /api/sessions/{id}/diff?file=` in api/sessions.ts over providers.diff (404 / 422 / [] without provider; 501 row removed); additive `FileDiff.uncommitted` (WorktreeManager: untracked + `git diff --name-only HEAD`, in place all, demo all); pure model src/web/views/session/diff.ts (rows short / delta / "solution · path", header "solution / path" + "⎇ branch", note while uncommitted, line tones, key selection) + DiffTab.tsx + diff.css (prototype inline styles; refetch on /hub event kinds impl/loop/ok/tool/error, sessionUpdated, hub reopen, focus); tests/web/diff.test.ts, tests/server/api/diff.test.ts, manager.test + routes.test updates; tests/e2e/diff.spec.ts (real path: fake-claude writes into a temp repo worktree, committed + uncommitted + untracked, live via /hub, in place, empty); tests/e2e/visual/diff.spec.ts; docs worktrees.md / derivations.md / lanes.md / demo.md / visual README
- M4.4 ✓ 2026-09-28 (commit: see git log "M4.4: Timeline tab") · attempts 2/5 · plan: pure model src/web/views/session/timeline.ts (lanes per agent main-first, blocks plan/impl/loop/ask/ok + error with the prototype K colors, axis first event → newest ts/endTs, open blocks to now while live, 0–1000 scrubber, ▶/❚❚ 8 per 50 ms, "Events up to" last 8, H:MM / H:MM:SS clock); terminal-tail.ts (console lines from real payloads, prototype lineColor, [agent] tags; shared with M4.3); TimelineTab.tsx + timeline.css (GET /events + /hub event upserts, refetch on hub reopen, agents via GET /sessions/{id} + sessionUpdated + refetch on unknown agent, 1 s clock while an open block runs); tests/web/{timeline,terminal-tail}.test.ts; tests/e2e/timeline.spec.ts (real path: fake-claude tool-use → subagent → ask-2q, no demo); tests/e2e/visual/timeline.spec.ts; docs/derivations.md (Timeline tab, Terminal tail), lanes row, docs/visual/timeline.md + README review
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions-w2-tabs.md)
- M8.3 · tools = every tool of GET /api/tools (no showInSidebar filter), hint = URL host
- M8.3 · session hint = sidebar mode line; solution hint = group folder
- M8.3 · solution pick via one-shot focus store (solution-focus.ts), no URL change
- M8.3 · lists loaded per opening, no cache; sessionUpdated reload while open
- M8.3 · keys per prototype (clamped ↑↓, Enter, click, no hover); ⌘K while open resets; row scrolled into view
- M8.3 · modals.css palette overlay align-items flex-start → normal (prototype computed value)
- M8.3 · tools E2E test.fail while GET /api/tools is 501 (D13; M8.1 on lane/w1-tools) — merge must make it pass
- M8.3 · visual: tools rows + qa-free-talk mock hint are data differences, listed not gated
- M7.2 · loops as additive `Session.loops` (no new route)
- M7.2 · facts Iteration / cap · Next / expires · Breaker ("—" when unknown), not the prototype's mock facts
- M7.2 · iteration = /loop turn + firings (results with nothing pending, not task-notifications); schedules after /loop belong to it; standalone cron / wake-up cards; Workflow = one card, calls = runs
- M7.2 · ScheduleWakeup `delaySeconds` (unrecorded schema; binary lookup refused), Workflow label from name / description / title
- M7.2 · recurring cron expires +7 days, next = cron match (local, no jitter); process end stops session-only schedules; CronDelete stops the named / only cron
- M7.2 · cap = attempt a/n, breaker = consecutive_*: n under ## Breaker, newest progress.md in worktrees / solution folders / cwd; breakerState null for real loops
- M7.2 · note = observed facts only (session-only sentence, stop / expiry, last iteration, progress source); empty-grid copy
- M7.2 · strip ≤ 30 cells padded to cap, ≤ 100 stored; order oldest first, ties by session start
- M7.2 · LoopTracker in buildApp (preClose close, startup sweep of its own rows; demo rows untouched)
- M7.2 · fake-claude [fake:tool] / [fake:fire] with invented result text
- M7.2 · SchedulesView = container + LoopCards only (M7.1 adds header + table); visual check inside the card grid
- M4.6 · DIFF rows `<solution> · <n files>`, git count + `+a −r` unless a meta is stored; other types stored meta verbatim, empty when unknown
- M4.6 · empty → `INFO · No artifacts` (M6.2 form); server order; static rows with a location tooltip
- M4.6 · demo seed inserts artifacts last-to-first (prototype order on same-age ties)
- M4.6 · refresh hook shared with the Diff tab (useSessionRefresh.ts)
- M4.6 · visual check inside the tab container (M4.1 grid in another lane)
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
