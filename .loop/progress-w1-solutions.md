## Current
item: (none; M6.2 done, next in lane: M6.3)
attempt: 0/5
last oracle: M6.2 PASS (attempt 3/5; oracle runs: 1 green = visual tests/e2e/visual/solutions.spec.ts (176 parts ±2 px all equal, copy exact, 24 SPEC-token checks, same rows per filter pill, pixel diff 0.01% view / 1.37% page); 2 red = E2E tests/e2e/solutions.spec.ts, a locator matched the DIFF row "contracts · 1 file" as well as CONTRACT (test fix: match the tag exactly); 3 green = E2E real path (fake-claude sessions through the API, worktree + in place, live via /hub, filters, detail, no-root message) + visual) · `npm run typecheck` green · `SWITCHBOARD_TEST_PORTS=4920-4929 npm test` 412/412 (32 files) · `SWITCHBOARD_TEST_PORTS=4920-4929 npx playwright test` 10/10 · no leftover processes on 4920–4929 · visual: docs/visual/solutions.md
## Done
- M6.1 ✓ 2026-09-28 (commit: see git log "M6.1: Workspace scanner") · attempts 3/5 · plan: src/core/workspace-rules.ts (router AGENTS.md folder-item parser: rule words + depth from `<placeholder>` segments, strictest wins; merge onto the ARCHITECTURE baseline, tighten/deepen/add only; `readOnlyCheck` for NewSession names via `solutionCandidates`; `toSolutionGroups`: one group per writable folder, other/ "on request only" (gap #15), one read-only group); src/server/solutions/scanner.ts `WorkspaceScanner` (async walk, real dirs only, `.git` file skipped at every level (gap #16), repo at an intermediate level = solution, `scan()` with router file + line count, `isReadOnly`, ScanError 409 codes); GET /api/solutions served (route falls back to a scanner over the configured root); main.ts wires the scanner; providers.ts optional `isReadOnly` + sessions.ts uses it; tests (core, scanner, API, routes row, shell.spec); docs/solutions.md + lanes/supervisor/core README rows
- M6.2 ✓ 2026-09-28 (commit: see git log "M6.2: Solutions view") · attempts 3/5 · plan: additive `Solution` fields (relativePath, ledger, artifacts, codebaseMemory); src/core/solutions-live.ts (gap #12 ledger parser, phase/status/changes summaries, .git/HEAD branch, hook project id + freshness); src/server/solutions/live.ts `LiveSolutions` over the scanner (worktree + in-place branches, idle chips, diff changes, ledger, artifacts + mobile-followups, dirty list), main.ts + route fallback; demo provider fills the same fields (prototype root/paths); src/web/views/SolutionsView.tsx + solutions-format.ts + solutions.css; tests (core, web, server live on real git + fake-claude, E2E real path, visual oracle); SWITCHBOARD_TEST_PORTS + Playwright testIgnore anchored for lane runs; docs/solutions.md (Live fields, The view), derivations/lanes/demo rows, docs/visual/solutions.md
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions-w1-solutions.md)
- M6.1 · folder rules = baseline + router list items starting with a backticked folder; rule words; strictest wins; router never loosens; no AGENTS.md → baseline
- M6.1 · walk: real dirs only; `.git` file skipped at every level; `.git` dir = solution at any level; non-git last-level folders still listed (`git: false`)
- M6.1 · wire shape: groups per writable folder + one read-only group, notes, sort, absolute `path`, neutral live fields until M6.2; 409 codes; route fallback scanner; no cache (M6.2: demo `path` is relative)
- M6.1 · NewSession read-only via optional `SolutionsProvider.isReadOnly` (path in a read-only folder, or an existing router-layout candidate in one); name match kept for providers without it (demo)
- M6.1 · shell.spec expects /api/solutions 409 without a root; E2E left to the merge step (port range)
- M6.1 · router fixture = folder-rule parts of the real router verbatim
- M6.2 · detail data as additive `Solution` fields on GET /api/solutions (no new endpoint)
- M6.2 · sessions on a row: live worktrees (any status) + open in-place sessions (unique resolution); read-only rows: no "read by"
- M6.2 · idle chip = checkout branch from .git/HEAD, owner idle; orphan worktree owner —
- M6.2 · status urgency need>fail>run>paused>done>idle; "active" = not idle
- M6.2 · phase = ledger, else open sessions, else —; ledger in the main checkout
- M6.2 · changes = +added / −removed / — from the sessions' diffs
- M6.2 · artifacts = sessions' artifacts by name + mobile-followups files (no meta); empty "No artifacts"
- M6.2 · ledger fallbacks "no phase-ledger.md" / "phase-ledger.md has no entries"
- M6.2 · freshness from .codebase-memory-dirty with the hook's project id (+ whole-folder prefix); unknown copy; M6.4 refines
- M6.2 · open Codebase Memory → tool named so, else Settings → tools
- M6.2 · conflict/flag neutral (M6.3); no "contract source" derivation
- M6.2 · demo paths = prototype's Windows root verbatim
- M6.2 · view: first row default, selection survives filters, 1 s reload debounce, 409/empty copy
- M6.2 · SWITCHBOARD_TEST_PORTS + Playwright testIgnore anchored (shared test plumbing)
