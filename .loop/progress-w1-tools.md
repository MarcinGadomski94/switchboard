## Current
item: (none; M8.1 done)
attempt: 4/5
last oracle: M8.1 PASS · `SWITCHBOARD_TEST_PORTS=4930-4939 npx playwright test` 12/12 (tests/e2e/tools.spec.ts 4/4: toolbar + server-side probe + iframe + Reload + New tab + Edit; "isn't configured"; "is not reachable" → Retry; strip + "Reindex 2 now" → fake-claude session with the built-in prompt; visual/tools.spec.ts gate green, main-area pixel diff 0.00%) · `npm run typecheck` green · `npm test` 378/378 (27 files) · no leftover processes, nothing listening on 4930–4939
runs: 1 = no specs found (Playwright `testIgnore` `**/.worktrees/**` matched the lane worktree's absolute path → anchored inside tests/e2e); 2 = red (test expected `/sessions/<id>/chat`, the router writes the chat tab as `/sessions/<id>`); 3 = green (tools.spec); 4 = green (full suite incl. visual)
## Done
- M8.1 ✓ 2026-09-28 (commit: see git log "M8.1: Embedded tools") · attempts 4/5 · plan: server `src/server/tools/{probe,codebase-memory,validate}.ts` + real GET/PUT /api/tools + POST /api/tools/{id}/probe (3 s server-side GET) + additive GET /api/codebase-memory + POST /api/codebase-memory/reindex (gap #4 session via the supervisor, `SessionStartInput`); migration 0002 default tools (cm localhost:13000, sw no URL); providers `toolProbe` / `codebaseMemory` (+ demo: always down, prototype dirty list + indexed); UI ToolView (toolbar, iframe, overlays, Reload/New tab/Edit) + `tools/probe.ts` shared state (sidebar dots) + CodebaseMemoryStrip; tests: vitest tools.test.ts, E2E tools.spec.ts on stub servers, visual tools.spec.ts; test port pool env + testIgnore fix + probe stubs in existing UI specs; docs/tools.md + derivations/database/configuration/demo/lanes/visual rows
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions-w1-tools.md)
- M8.1 · default tools via migration 0002 (ids cm/sw)
- M8.1 · probe: any HTTP status = up, GET, no redirects, 3 s
- M8.1 · probe 404 unknown / 409 not-configured
- M8.1 · PUT /api/tools validation rules
- M8.1 · additive routes /api/codebase-memory (+ /reindex)
- M8.1 · reindex session shape + built-in prompt; supervisor `SessionStartInput`
- M8.1 · dirty-file format from the workspace hook (read-only), naming rules
- M8.1 · no chip times / no indexed count on the real path (unknown, never invented)
- M8.1 · strip empty + started states
- M8.1 · "Unknown tool" card
- M8.1 · probe state = prototype tstate (URL-less tools idle until opened)
- M8.1 · no iframe sandbox
- M8.1 · `.sb-tool` text color
- M8.1 · test infra: SWITCHBOARD_TEST_PORTS, testIgnore anchoring, stubToolProbes in shell/hub/security specs, migrate.test count-free
