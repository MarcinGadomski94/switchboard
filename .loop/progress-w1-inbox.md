## Current
item: M3.1 Question + permission pipeline (done; next in lane: M3.2)
attempt: 3/5
last oracle: M3.1 PASS · attempt 1 green (tests/server/inbox + routes, in isolation) · attempt 2 red in the full suite (ask-multiselect read the fake's stdin log before it was written → wait for the line) · attempt 3 green: `npm run typecheck` green · `SWITCHBOARD_TEST_PORTS=4910-4919 npm test` 378/378 twice (tests/server/inbox/pipeline.test.ts 11: ask-2q stdin byte-equal to the recording apart from request_id, ask-multiselect, perm-allow / perm-deny byte-equal via the Inbox actions, subagent-perm attribution, ask-interrupt stale → queued → Resume delivers `<answers>\n\nContinue.`, stale answered while live → sent at once, SIGKILL → permission stale / batch answerable; restart.test.ts answers through the real route; tests/web/question-card.test.ts 4) · no leftover processes · Playwright not run (binds 4871–4879; no E2E oracle for M3.1) · visual: n/a (QuestionCard not mounted in a view until M3.2 / M4.2)
## Done
- M3.1 ✓ 2026-09-28 (commit: see git log "M3.1: Question + permission pipeline") · attempts 3/5 · plan: src/server/inbox/pipeline.ts QuestionPipeline = supervisor ControlRequestHandler (AskUserQuestion → batch + verbatim Questions, source = main agent; other tools → permission items with agent_id; cancel/orphaned → stale; questionBatch + inboxChanged + sessionUpdated on the bus); answers route (400 unless all answered; open → one control_response allow + input + answers{text: label}; stale → user message now via sendToLive or queued in the outbox, pendingDelivered hook); actions route allow-once / deny (fixed message, never updatedPermissions); src/server/inbox/wire.ts (toQuestion, questionBatchItem, permissionItem, inboxCount); createSessionServices wiring in app.ts/main.ts + ApiContext.questions; openQuestionCount counts unanswered stale batches; shared web QuestionCard (src/web/components) + pure state; docs/questions.md + lanes/supervisor/derivations/hub/configuration rows; SWITCHBOARD_TEST_PORTS for lane test ports
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions-w1-inbox.md)
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
