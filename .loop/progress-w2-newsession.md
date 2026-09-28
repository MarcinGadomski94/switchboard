## Current
item: (none; M5.1 done)
attempt: 3/5 (M5.1)
last oracle: e2e new-session.spec PASS (5/5) · visual/new-session.spec PASS (96 parts ±2 px, 22 SPEC tokens) · full suite: typecheck, vitest 507/507, playwright 27/27
plan (M5.1):
- Pure form logic in `src/web/modals/new-session.ts` (defaults = router's recommended answers, prefill overlay, name sanitising, chip groups from `GET /api/solutions` with read-only folders collapsed + locked, coordination/QA visibility, live summary lines with `../{repo}-wt-{name}` (gap #1), canStart, NewSession body, error text) + Vitest unit tests.
- `NewSessionModal.tsx` + `new-session.css`: the prototype's markup/inline styles as classes (sections 1–6, pills, chips, toggles 32×18, mono summary, Cancel / Start session at 45% when disabled); reads `/api/solutions` + `/api/sessions` through `api`, POSTs `api.createSession`, shows the server's refusal, navigates to the new session; keeps `data-prefill` for M3.3's spec.
- E2E `tests/e2e/new-session.spec.ts` on the real path (no demo, D13): fake-claude, fake gh, temp workspace with git repos + read-only folders; every section, visibility rules, summary, duplicate name, Start → session + worktree on disk; 422 for read-only / duplicate / missing qa via the API; "Open fix session" prefill fills the form and starts.
- Visual spec `tests/e2e/visual/new-session.spec.ts` (demo seed vs prototype modal, form filled to the prototype's draft): boxes ±2 px, copy, computed styles; record in `docs/visual/`.
- Docs: `docs/new-session.md`, derivations, lanes row; ASSUMED lines in `.loop/questions-w2-newsession.md`.
attempts (M5.1):
1. e2e new-session.spec: PASS 5/5
2. visual/new-session.spec: FAIL (QA fields container font 16px sans vs 12px mono; input text cursor vs static box) → font on `.sb-ns-qa-fields`, input cursor accepted as a known difference
3. visual/new-session.spec: PASS; then the whole suite green
## Done
- M5.1 ✓ 2026-09-28 (commit: see `git log --oneline -1` on lane/w2-newsession, "M5.1: New-session modal")
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions-w2-newsession.md)
- M5.1: recommended answers as defaults; QA stack + sources required; read-only chips per top folder; extra ⚠ / refusal / `not found` lines; coordination only when shown; static "Max" copy.
