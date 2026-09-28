## Current
item: (none; M5.3 done)
attempt: 2/5 (M5.3)
last oracle: tests/e2e/setup-wizard.spec.ts PASS (2/2) · visual tests/e2e/visual/setup-wizard.spec.ts PASS (5 steps, gate green, panel diff 0.29%) · full suite: typecheck, vitest 541/541, playwright 30/30; ports 4920–4929 free afterwards
plan (M5.3):
- Server `src/server/system/probe.ts` = the real `SystemProvider` behind `GET /api/system` (contract): CLI via `<claude bin> --version`, `claude auth status` / `gh auth status` exit codes through the configurable bins (cached 30 s, `?fresh=1` re-checks), machine CPU/RAM (gap #11), `processes` = the supervisor's live count; wired in main.ts, 503 without a provider.
- Server `src/server/setup/*` + `/api/setup` routes: setup state (completed, auto-open unless `SWITCHBOARD_SETUP_WIZARD=off`), workspace-root check (AGENTS.md title + line count), save (settings table `setup.workspaceRoot`; `SWITCHBOARD_WORKSPACE_ROOT` wins; applied live to supervisor / worktree manager / scanner through small setters + a live `config.workspaceRoot`), folder listing for Browse…, complete; usage threshold read from `usage.warnAtPct` (M8.2 key, default 90).
- UI: fill `SetupWizard.tsx` (5 steps, rail, Back / Skip / Continue → Finish, prototype copy + inline styles) with a pure model `setup-wizard.ts` + CSS; `FirstRunGate` in the shell opens it once per page load while setup is not finished (Skip = not again in this tab).
- Test servers default to fake claude / fake gh / wizard off (`tests/helpers/server-process.ts`); shell.spec + routes.test follow `/api/system` going live.
- Oracle `tests/e2e/setup-wizard.spec.ts` (real path: fake-claude, fake gh, fixture workspace, no demo): first run walks all 5 steps, root chosen with Browse… and applied live (a session starts there), mocked Notification, Finish persists across restart; signed-out / env-root / Skip / Back / rail. Plus vitest for service, probe, routes, model; visual spec vs the prototype (D10).
- Docs: `docs/setup.md`, configuration / lanes rows; ASSUMED lines.
attempts (M5.3):
1. setup-wizard.spec.ts: FAIL (scan rows: infrastructure/ before deprecated/: the read-only group is sorted by name) → rows of a group ordered by its note (router order)
2. setup-wizard.spec.ts: PASS; then shell.spec (the gate's /api/setup call) and the visual spec (inert Browse… cursor, table height = data) adjusted outside the oracle count
## Done
- M5.1 ✓ 2026-09-28 (commit 103bc05, "M5.1: New-session modal")
- M5.2 ✓ 2026-09-28 (commit 5972877, "M5.2: First-turn payload")
- M5.3 ✓ 2026-09-28 (commit: see `git log --oneline -1` on lane/w2-newsession, "M5.3: First-run wizard")
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions-w2-newsession.md)
- M5.1: recommended answers as defaults; QA stack + sources required; read-only chips per top folder; extra ⚠ / refusal / `not found` lines; coordination only when shown; static "Max" copy.
- M5.2: empty task → idle + answers in the outbox (kind `session-start`); payload wording/labels; folders `/`-relative with name fallback, coordination only when applicable and given, `—` for empty QA sources.
- M5.3: root saved in settings + applied live (env wins, refused while processes run / without AGENTS.md); server-side Browse…; login row names no plan; first run per install, Skip per tab; SWITCHBOARD_SETUP_WIZARD=off + test-server defaults (fake bins); /api/system derivations + 30 s cache; step 5 threshold read-only; additive /api/setup routes.
