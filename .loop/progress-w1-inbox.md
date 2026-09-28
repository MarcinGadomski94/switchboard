## Current
item: M3.2 Inbox view (done; next in lane: M3.3)
attempt: 2/5
last oracle: M3.2 PASS · attempt 1 green, attempt 2 = the same suite re-run for the committed report · `npm run typecheck` green · `SWITCHBOARD_TEST_PORTS=4910-4919 npm test` 389/389 (tests/server/inbox/inbox-list.test.ts 5, tests/web/inbox.test.ts 6) · Playwright (lane config, ports 4910–4919) 10/10: tests/e2e/inbox.spec.ts 2 (real path, fake-claude ask-2q / perm-allow, no demo: live arrival, Send disabled at 0.45 until both answered, control_response reaches the fake, Inbox zero; newest-first selection + keyboard, permission tool + input verbatim, Allow once, Open session →) + visual/inbox.spec.ts gate green (every box equal to the prototype, copy exact, styles equal; known difference card2Kind "Loop paused" → "Question", D13; pixel diff 1.38% page / 0.03% main / 0.03% system / 0.00% empty) + shell/hub/security specs · no leftover processes

## Done
- M3.2 ✓ 2026-09-28 (commit: see git log "M3.2: Inbox view") · attempts 2/5 · plan: `GET /api/inbox` = `listInbox` (waiting batches + open permissions newest first, then open system items oldest first; branch chips from agents + worktrees; source names before " · "; `systemItem` + kind labels; same items as `inboxCount`); InboxView (`340px | 1fr`, cards, detail with meta/title/chips/text, shared QuestionCard, permission request block + actions, system actions, All clear / Inbox zero, reload on inboxChanged, hide-on-success + refusal line); docs/inbox.md, docs/visual/inbox.md + PNGs; routes/shell tests moved to 200
- M3.1 ✓ 2026-09-28 (commit: see git log "M3.1: Question + permission pipeline") · attempts 3/5 · plan: src/server/inbox/pipeline.ts QuestionPipeline = supervisor ControlRequestHandler (AskUserQuestion → batch + verbatim Questions, source = main agent; other tools → permission items with agent_id; cancel/orphaned → stale; questionBatch + inboxChanged + sessionUpdated on the bus); answers route (400 unless all answered; open → one control_response allow + input + answers{text: label}; stale → user message now via sendToLive or queued in the outbox, pendingDelivered hook); actions route allow-once / deny (fixed message, never updatedPermissions); src/server/inbox/wire.ts (toQuestion, questionBatchItem, permissionItem, inboxCount); createSessionServices wiring in app.ts/main.ts + ApiContext.questions; openQuestionCount counts unanswered stale batches; shared web QuestionCard (src/web/components) + pure state; docs/questions.md + lanes/supervisor/derivations/hub/configuration rows; SWITCHBOARD_TEST_PORTS for lane test ports
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions-w1-inbox.md)
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
