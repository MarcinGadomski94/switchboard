## Current
item: M3.4 Notifications (done; lane w1-inbox has no further item)
attempt: 5/5
last oracle: M3.4 PASS · attempt 1 red (tests/e2e/notifications.spec.ts expected a 360 px border box; the prototype's `width:360px` is the content box, 394 px outside: a test mistake), attempt 2 green (notifications.spec.ts 3/3 + visual/toast.spec.ts 1/1), attempt 3 = the lane suite red (M3.2's inbox.spec clicked "Open session →" under the new toast), attempt 4 = the lane suite green 16/16, attempt 5 = the visual report run (`SWITCHBOARD_VISUAL_REPORT=1`, gate green) · `npm run typecheck` green · `SWITCHBOARD_TEST_PORTS=4910-4919 npm test` 408/408 (tests/web/notify.test.ts 11) · no leftover processes
## Done
- M3.4 ✓ 2026-09-28 (commit: see git log "M3.4: Notifications") · attempts 5/5 · plan: src/web/toast/notify.ts (`questionNotice`: session name, `question · now` / `n questions · now`, branch chips, the question verbatim, `<session> needs you`; `playChime`: prototype beep 784 → 1046 Hz on a fresh AudioContext, closed after, dropped when suspended; `notifyOs`: only when granted, never asks, click → focus + jump); src/web/toast/useQuestionNotifications.ts (`/hub` questionBatch → once per batch → Inbox item lookup → toast + chime + OS notification together) mounted in ToastHost (branch line only when present); tests/web/notify.test.ts, tests/e2e/notifications.spec.ts + question-world.ts (real path, mocked Notification + AudioContext), tests/e2e/visual/toast.spec.ts + docs/visual/toast.md; docs/notifications.md + lanes/hub/demo/visual rows
- M3.3 ✓ 2026-09-28 (commit: see git log "M3.3: Inbox system items") · attempts 3/5 · plan: src/server/inbox/system-items.ts SystemItemService (raise "Scheduled run failed" from failed schedule_runs via `scheduleRunFinished` hook + `sync()` at start and every 30 s, "PR merged" from `worktreeRemovable` + sync; one item per run / worktree via `createOnce`; `inboxChanged`); actions on the contract route (open-fix-session / dismiss / keep close; retry-run → ScheduleRunner, 501 until M7.1; remove-worktree → WorktreeManager.remove, gap #3 refusals 409); InboxItem.prefill + NewSessionPrefill; ModalProvider `open('new-session', { prefill })`, placeholder `data-prefill`; demo seed real kinds + ns prefill; docs/system-items.md + inbox/lanes/hub/questions/demo/derivations rows
- M3.2 ✓ 2026-09-28 (commit: see git log "M3.2: Inbox view") · attempts 2/5 · plan: `GET /api/inbox` = `listInbox` (waiting batches + open permissions newest first, then open system items oldest first; branch chips from agents + worktrees; source names before " · "; `systemItem` + kind labels; same items as `inboxCount`); InboxView (`340px | 1fr`, cards, detail with meta/title/chips/text, shared QuestionCard, permission request block + actions, system actions, All clear / Inbox zero, reload on inboxChanged, hide-on-success + refusal line); docs/inbox.md, docs/visual/inbox.md + PNGs; routes/shell tests moved to 200
- M3.1 ✓ 2026-09-28 (commit: see git log "M3.1: Question + permission pipeline") · attempts 3/5 · plan: src/server/inbox/pipeline.ts QuestionPipeline = supervisor ControlRequestHandler (AskUserQuestion → batch + verbatim Questions, source = main agent; other tools → permission items with agent_id; cancel/orphaned → stale; questionBatch + inboxChanged + sessionUpdated on the bus); answers route (400 unless all answered; open → one control_response allow + input + answers{text: label}; stale → user message now via sendToLive or queued in the outbox, pendingDelivered hook); actions route allow-once / deny (fixed message, never updatedPermissions); src/server/inbox/wire.ts (toQuestion, questionBatchItem, permissionItem, inboxCount); createSessionServices wiring in app.ts/main.ts + ApiContext.questions; openQuestionCount counts unanswered stale batches; shared web QuestionCard (src/web/components) + pure state; docs/questions.md + lanes/supervisor/derivations/hub/configuration rows; SWITCHBOARD_TEST_PORTS for lane test ports
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions-w1-inbox.md)
- M3.4 · toast copy from real data (question verbatim, branch chips)
- M3.4 · OS notification when granted, never asks, click jumps
- M3.4 · questionBatch only, no settings gate until M8.2
- M3.4 · toast data from GET /api/inbox, payload not extended
- M3.4 · chime on a fresh context, dropped when suspended
- M3.4 · no auto-dismiss, toast stack kept (M1.4)
- M3.4 · no demo arrival; visual on the real path
- M3.4 · inbox.spec puts the toast away before "Open session →"
- M3.4 · lane Playwright config, ports 4910–4919
- M3.3 · detection: event + scheduler hook + 30 s sync (non-demo)
- M3.3 · one item per run / worktree, Dismiss / Keep final
- M3.3 · failed-run copy from stored data only (summary, green streak)
- M3.3 · fix-session prefill derivation (template + single / ui-first)
- M3.3 · Open fix session closes at once (prototype)
- M3.3 · Retry run via ScheduleRunner, 501 until M7.1
- M3.3 · Remove worktree refusals 409, already removed = done
- M3.3 · PR merged copy (PR number, relative path)
- M3.3 · refusal codes beyond the contract
- M3.3 · modal prefill as data-prefill until M5.1
- M3.3 · demo seed kinds + prototype ns prefill
- M3.3 · E2E waits for the first PR check; lane Playwright config
- M3.2 · inbox order: session items newest first, then system items oldest first (prototype order)
- M3.2 · no "Loop paused" label (mock source "circuit breaker"; D13) — known visual difference
- M3.2 · batch title source names = part before " · "
- M3.2 · branch chips = agents with a branch + live worktrees
- M3.2 · system item kind labels (schedule-run-failed / worktree-removable)
- M3.2 · permission item detail design (code block + Allow once / Deny)
- M3.2 · hide on success + "Not sent: …" refusal copy
- M3.2 · selection not in URL; empty states only once loaded
- M3.2 · system actions post the contract route; 404 until M3.3
- M3.2 · empty-state visual vs a non-demo app
- M3.2 · Playwright via a scratchpad lane config (repo testIgnore ignores .worktrees/*)
- M3.1 · stale answers: sendToLive now, else outbox for the next run; never spawns/resumes
- M3.1 · stale-answers message wording
- M3.1 · stale unanswered batch leaves the status alone; counts in Inbox + openQuestionCount
- M3.1 · duplicate question texts → labels joined ", "
- M3.1 · unreadable AskUserQuestion input → permission item
- M3.1 · HTTP codes beyond the contract (404/409/400 unknown-action)
- M3.1 · question source = main agent name; InboxItem.permission additive block
- M3.1 · Inbox copy for batch / permission items (branches → M3.2)
- M3.1 · QuestionCard copy/tooltip/header/disabled details
- M3.1 · wiring via createSessionServices + bind
- M3.1 · supervisor sendToLive + pendingDelivered hook
- M3.1 · SWITCHBOARD_TEST_PORTS test-port override; Playwright not run
- M3.1 · restart.test.ts answers through the real route
- M3.1 · visual oracle deferred to M3.2 / M4.2
