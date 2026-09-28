## Current
item: (none; M6.4 done)
attempt: 0/5
last oracle: M6.4 PASS (attempt 1/5: unit oracle tests/core/codebase-memory.test.ts on the fixtures in tests/fixtures/codebase-memory/ + tests/server/solutions/codebase-memory.test.ts + the moved/affected M6.2 suites: 31/31) · `npm run typecheck` green · `SWITCHBOARD_TEST_PORTS=4920-4929 npm test` 443/443 (37 files) · regression: `npx playwright test tests/e2e/solutions.spec.ts` 2/2 (freshness line on the real path) · visual: n/a (no UI change) · no leftover processes on 4920–4929
## Done
- M6.1 ✓ 2026-09-28 (commit: see git log "M6.1: Workspace scanner") · attempts 3/5 · plan: src/core/workspace-rules.ts (router AGENTS.md folder-item parser: rule words + depth from `<placeholder>` segments, strictest wins; merge onto the ARCHITECTURE baseline, tighten/deepen/add only; `readOnlyCheck` for NewSession names via `solutionCandidates`; `toSolutionGroups`: one group per writable folder, other/ "on request only" (gap #15), one read-only group); src/server/solutions/scanner.ts `WorkspaceScanner` (async walk, real dirs only, `.git` file skipped at every level (gap #16), repo at an intermediate level = solution, `scan()` with router file + line count, `isReadOnly`, ScanError 409 codes); GET /api/solutions served (route falls back to a scanner over the configured root); main.ts wires the scanner; providers.ts optional `isReadOnly` + sessions.ts uses it; tests (core, scanner, API, routes row, shell.spec); docs/solutions.md + lanes/supervisor/core README rows
- M6.2 ✓ 2026-09-28 (commit: see git log "M6.2: Solutions view") · attempts 3/5 · plan: additive `Solution` fields (relativePath, ledger, artifacts, codebaseMemory); src/core/solutions-live.ts (gap #12 ledger parser, phase/status/changes summaries, .git/HEAD branch, hook project id + freshness); src/server/solutions/live.ts `LiveSolutions` over the scanner (worktree + in-place branches, idle chips, diff changes, ledger, artifacts + mobile-followups, dirty list), main.ts + route fallback; demo provider fills the same fields (prototype root/paths); src/web/views/SolutionsView.tsx + solutions-format.ts + solutions.css; tests (core, web, server live on real git + fake-claude, E2E real path, visual oracle); SWITCHBOARD_TEST_PORTS + Playwright testIgnore anchored for lane runs; docs/solutions.md (Live fields, The view), derivations/lanes/demo rows, docs/visual/solutions.md
- M6.3 ✓ 2026-09-28 (commit: see git log "M6.3: Conflict detection + move to worktree") · attempts 4/5 · plan: src/core/conflicts.ts (writers = open sessions with a worktree or in place; conflict = ≥ 2 writers and ≥ 1 in place; flag "⚠ shared working tree"; `sd.warn` copy; "Move <name> to worktree"); additive `Solution.conflictSessions` (api.ts, scan neutral, LiveSolutions fills conflict/flag/conflictSessions with the session's own solution string as `repo`, demo mobile row from solutions.json); UI SolutionConflictCard.tsx + solutions-conflict.ts + CSS (question-card colors, primary buttons → POST /api/solutions/{repo}/isolate, busy + refusal message, reload); sidebar reloads solutions on sessionUpdated (useThrottled, 1 s) for the badge; tests (core, web, server real git + fake-claude, E2E real path, visual oracle with `mobile` selected); docs/solutions.md (Conflicts), derivations/lanes/demo/core README rows, docs/visual/solutions-conflict.md + README review
- M6.4 ✓ 2026-09-28 (commit: see git log "M6.4: codebase-memory freshness") · attempts 1/5 · plan: src/core/codebase-memory.ts (hook categories, project ids moved from solutions-live, `dirtyLines` BOM/CRLF/CR/trim/blank/case-only repeats, `parseDirtyFile`/`dirtyProject` → `<category>/<folder>` under any root form, `concernsSolution`/`solutionFreshness`: own id or overlapping folder, `dirtyTargets` for the Codebase Memory strip); src/server/solutions/codebase-memory.ts `readDirtyList` (ok / missing / unreadable, root as configured + real path); LiveSolutions uses them (depth-0 prefix rule dropped); unit oracle on byte-exact fixtures + reader tests on temp workspaces; docs/solutions.md (Codebase-memory freshness), lanes/core README rows
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
- M6.3 · conflict = ≥ 2 open writers (worktree or in place; paused/detached count, ended do not) and ≥ 1 in place
- M6.3 · card names every writer (both/all), one "Move … to worktree" per in-place writer, detached disabled, refusal message shown
- M6.3 · additive `Solution.conflictSessions` (`repo` = the session's own solution string); flag only for conflicts
- M6.3 · sidebar reloads solutions on sessionUpdated (≤ 1/s) for the conflict badge
- M6.3 · demo mobile names from `sd.warn`; demo click refused (no demo isolate), `conflictFixedBranch` unused
- M6.4 · a line concerns a row = its own id or an overlapping folder (equal / inside / containing); replaces the depth-0 prefix rule
- M6.4 · root matched as configured and as its real path; ids case-insensitive; case-only repeats dropped
- M6.4 · strip gets `dirtyTargets` only (no route here); w1-tools has the strip, `GET /api/codebase-memory`, reindex and its own parser — merge keeps one reader
- M6.4 · synthetic fixtures, `.gitattributes` `* -text` in the fixture folder
