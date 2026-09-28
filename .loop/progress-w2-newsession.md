## Current
item: (none; M7.1 done)
attempt: 4/5 (M7.1)
last oracle: unit with a fake clock tests/server/schedules/scheduler.test.ts PASS (9/9) · E2E tests/e2e/schedules.spec.ts PASS (3/3, incl. the real timer firing `* * * * *`) · visual tests/e2e/visual/schedules.spec.ts PASS (gate green, header + table diff 0.27%) · full suite: typecheck, vitest 574/574, playwright 34/34 (then the M7.1 specs + inbox-system / shell / new-session again after the restart-reconcile move: 14/14); ports 4920–4929 free afterwards
plan (M7.1):
- core `src/core/cron.ts`: 5-field cron parse (lists, ranges, steps, names, Vixie DOM/DOW rule), next N local run times, readable preview ("02:00 daily", "every 4h", "08:30 weekdays", "Mon 07:00", else the expression); `src/core/schedules.ts` run session names.
- server `src/server/schedules/{scheduler,wire,validate}.ts`: Scheduler with an injectable clock (one timer capped at 60 s, per-schedule "armed from", no catch-up after downtime, one firing per clock jump, overlap → `skipped`), runs = `startNewSession` (the POST /api/sessions flow moved to `sessions/start.ts`) with name `<schedule>-<MMDD>-<HHMM>`, result from the session's status, summary from its questions / events; `scheduleRun` on the bus; failed runs → `systemItems.scheduleRunFinished` (M3.3) and `scheduleRunnerFor` for Retry run; restart reconcile at the first start.
- API `api/schedules.ts`: GET list, POST create / Edit (`id`), /run, /pause, /resume; ApiContext.scheduler; app.ts / main.ts wiring (timer only outside demo, after listen).
- UI: SchedulesView header + ScheduleTable (prototype markup), "+ New scheduled run" → New-session modal with section 7 · Schedule (ScheduleSection + schedule-form.ts) and "Save schedule"; the name cell = Edit (prefilled).
- Oracle: vitest cron + scheduler (fake clock, real supervisor / fake-claude / pipeline / worktrees / system items) + routes + web models; E2E real path; visual vs the prototype; inbox-system.spec now retries through the scheduler; demo seed run summaries.
attempts (M7.1):
1. scheduler.test.ts: FAIL (the test's `at(h, m, s)` helper took the seconds as the day) → `atSecond`
2. scheduler.test.ts: FAIL (the test rig had no question pipeline, so a `need` run had no stored question; the fake's log was read before it was written) → pipeline wired as createSessionServices does, wait for the log
3. scheduler.test.ts PASS; schedules.test.ts / web / E2E schedules.spec PASS; visual FAIL (the spec looked the prototype grid up by its style attribute) → by computed columns
4. full run: typecheck, vitest 574/574, playwright 34/34 PASS; then the restart reconcile moved from the constructor to the first `start()` (a second instance that cannot bind never touches runs) and the affected specs re-run green
## Done
- M5.1 ✓ 2026-09-28 (commit 103bc05, "M5.1: New-session modal")
- M5.2 ✓ 2026-09-28 (commit 5972877, "M5.2: First-turn payload")
- M5.3 ✓ 2026-09-28 (commit babdb02, "M5.3: First-run wizard")
- M7.1 ✓ 2026-09-28 (commit: see `git log --oneline -1` on lane/w2-newsession, "M7.1: Scheduler + New scheduled run")
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions-w2-newsession.md)
- M7.1: run session `<schedule>-<MMDD>-<HHMM>`; Save/Edit via POST /api/schedules (`id`), no delete; task required, empty cron field; results follow the session, `need` = in progress, overlap → skipped / 409; local time, no catch-up, timer outside demo only; run sessions left live; summary + table copy rules; Edit = name cell; modal title / `7 · Schedule` / summary lines; preview falls back to the expression; additive wire fields; demo run summaries; POST /api/sessions flow in sessions/start.ts.
- M5.1: recommended answers as defaults; QA stack + sources required; read-only chips per top folder; extra ⚠ / refusal / `not found` lines; coordination only when shown; static "Max" copy.
- M5.2: empty task → idle + answers in the outbox (kind `session-start`); payload wording/labels; folders `/`-relative with name fallback, coordination only when applicable and given, `—` for empty QA sources.
- M5.3: root saved in settings + applied live (env wins, refused while processes run / without AGENTS.md); server-side Browse…; login row names no plan; first run per install, Skip per tab; SWITCHBOARD_SETUP_WIZARD=off + test-server defaults (fake bins); /api/system derivations + 30 s cache; step 5 threshold read-only; additive /api/setup routes.
