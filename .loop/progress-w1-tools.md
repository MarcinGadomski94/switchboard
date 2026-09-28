## Current
item: (none; M7.3 done)
attempt: 3/5
last oracle: M7.3 PASS · `SWITCHBOARD_TEST_PORTS=4930-4939 npx playwright test` 28/28 (tests/e2e/artifacts.spec.ts 7/7: 6 real-path with fake-claude + temp git worktree, 1 demo; visual/artifacts.spec.ts gate green, main-area pixel diff 2.39% All / 0.00% Diffs; settings scan-table test still an expected failure until the M6.1 merge) · `npm run typecheck` green · `npm test` 414/414 (31 files) · nothing listening on 4930–4939
runs: 1 = green (artifacts.spec alone); 2 = red (demo filter check read the previous filter's rows while both counts were "3 of 13"; fixed with `aria-busy` + settle waits); 3 = green (full suite incl. visual)
## Done
- M7.3 ✓ 2026-09-28 (commit: see git log "M7.3: Global artifacts view") · attempts 3/5 · plan: core `src/core/artifacts-view.ts` (pills, `type=` parsing, location label, search match) + wire `ArtifactListItem`; server real `GET /api/artifacts?type=&q=` (`api/artifacts.ts`, 400 on unknown types, newest first, session names); UI `ArtifactsView` + `artifacts.css` (title + n of m + search, pills, table, rows link to the session's Chat, empty states, reload on /hub, aria-busy); tests: vitest `tests/core/artifacts-view.test.ts` + `tests/server/api/artifacts.test.ts`, routes.test row moved, shell.spec expects 200 []; E2E `tests/e2e/artifacts.spec.ts`, visual `tests/e2e/visual/artifacts.spec.ts`; docs derivations (Artifacts view), lanes, core README, visual README + `docs/visual/artifacts*`
- M8.2 ✓ 2026-09-28 (commit: see git log "M8.2: Settings") · attempts 3/5 · plan: server `src/server/settings/settings.ts` + real GET/PUT /api/settings (keys in `src/core/settings.ts`: editable worktrees/ultracode/warnAtPct, read-only address/startAtLogin/root/router title/PR poll); UI `SettingsView` + `views/settings/{model,rows,sections,WorkspaceSection,ToolsSection,notify}` + `settings.css` (7 sections, toggles, threshold select, Send test/Allow, scan table, schedules with `src/core/cron-label.ts`, tool editor with add/remove); sidebar reload via `tools/events.ts`; demo seed startAtLogin; tests: vitest settings.test.ts + settings-model.test.ts, E2E settings.spec.ts (real path + restart persistence + mocked Notification/AudioContext; scan table `test.fail` until M6.1 merge), visual settings.spec.ts; docs/settings.md + lanes/database/demo/derivations/tools/visual rows
- M8.1 ✓ 2026-09-28 (commit: see git log "M8.1: Embedded tools") · attempts 4/5 · plan: server `src/server/tools/{probe,codebase-memory,validate}.ts` + real GET/PUT /api/tools + POST /api/tools/{id}/probe (3 s server-side GET) + additive GET /api/codebase-memory + POST /api/codebase-memory/reindex (gap #4 session via the supervisor, `SessionStartInput`); migration 0002 default tools (cm localhost:13000, sw no URL); providers `toolProbe` / `codebaseMemory` (+ demo: always down, prototype dirty list + indexed); UI ToolView (toolbar, iframe, overlays, Reload/New tab/Edit) + `tools/probe.ts` shared state (sidebar dots) + CodebaseMemoryStrip; tests: vitest tools.test.ts, E2E tools.spec.ts on stub servers, visual tools.spec.ts; test port pool env + testIgnore fix + probe stubs in existing UI specs; docs/tools.md + derivations/database/configuration/demo/lanes/visual rows
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions-w1-tools.md)
- M7.3 · wire `ArtifactListItem` (+ sessionName, updatedAt), newest first
- M7.3 · `type=` comma list of artifact types, 400 on unknown
- M7.3 · search on the service over type/name/location/session/status
- M7.3 · location label: root for null solution; BRANCH shows the solution only
- M7.3 · Age = updatedAt
- M7.3 · empty states + session-less rows ("—", not a link)
- M7.3 · reload on /hub event/sessionUpdated; aria-busy
- M7.3 · filter/search in view state only
- M7.3 · click opens the Chat tab
- M7.3 · visual: row order by content (newest first vs prototype array order)
- M7.3 · shell.spec: /api/artifacts 200 [] on a fresh install
- M8.2 · Settings keys: editable + read-only service values in one GET; PUT partial, editable only
- M8.2 · Start at login read-only until M9.1 (demo seed: on)
- M8.2 · only worktrees/ultracode/threshold are preferences; other rows fixed rules
- M8.2 · value-styled controls (click toggles, select 50–100%)
- M8.2 · Permissions copy per D6; Account without plan; unknown until /api/system
- M8.2 · PR detection = real 5 min; repos = scan count
- M8.2 · scan table derived in the UI from GET /api/solutions; real-path test `test.fail` until M6.1 merge
- M8.2 · cron-label.ts for schedule rows
- M8.2 · tool editor: save on blur/Enter/Test/Open, Remove with confirm, Add card; sidebar re-probes new URLs
- M8.2 · page-local tools-changed event for the sidebar
- M8.2 · Send test without a session; chime/notify helpers until M3.4 merge
- M8.2 · visual oracle answers other lanes' routes in the page
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
