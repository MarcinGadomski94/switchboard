## Current
item: (none; M6.1 done, next in lane: M6.2)
attempt: 0/5
last oracle: M6.1 PASS (attempt 3/5; oracle runs: 1 red = two expectations: router-added folders come in router order, and "any candidate in a read-only folder" refused every bare name once a group folder was tightened → the check now needs that candidate to exist; 2 green on the 4 M6.1 files; 3 green = full `npm test`) · `npm run typecheck` green · `npm test` 393/393 (29 files) · oracle tests/core/workspace-rules.test.ts + tests/server/solutions/scanner.test.ts (fixture workspaces in temp dirs, real router phrasing, real `git worktree add` folders; never the real workspace) + tests/server/api/solutions.test.ts (route + 422 via scan + a live `mobile` next to `deprecated/mobile/` starts a fake-claude session) · no leftover processes · E2E not run in this lane (shell.spec expectation updated for /api/solutions → 409 without a root) · visual: n/a (no UI)
## Done
- M6.1 ✓ 2026-09-28 (commit: see git log "M6.1: Workspace scanner") · attempts 3/5 · plan: src/core/workspace-rules.ts (router AGENTS.md folder-item parser: rule words + depth from `<placeholder>` segments, strictest wins; merge onto the ARCHITECTURE baseline, tighten/deepen/add only; `readOnlyCheck` for NewSession names via `solutionCandidates`; `toSolutionGroups`: one group per writable folder, other/ "on request only" (gap #15), one read-only group); src/server/solutions/scanner.ts `WorkspaceScanner` (async walk, real dirs only, `.git` file skipped at every level (gap #16), repo at an intermediate level = solution, `scan()` with router file + line count, `isReadOnly`, ScanError 409 codes); GET /api/solutions served (route falls back to a scanner over the configured root); main.ts wires the scanner; providers.ts optional `isReadOnly` + sessions.ts uses it; tests (core, scanner, API, routes row, shell.spec); docs/solutions.md + lanes/supervisor/core README rows
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
