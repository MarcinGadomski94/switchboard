# Questions and permission requests (M3.1)

The question pipeline turns the CLI's `can_use_tool` control requests into Inbox work and writes the developer's answers back. It uses the mechanism the M0 spike recommends (`docs/spike-m0.md` → *Recommendation for M3.1*): the native stream-json control protocol with `--permission-prompt-tool stdio` on the one supervised `claude -p` process. No Agent SDK, no hooks, no settings files (D6). Code: `src/server/inbox/` (pipeline + wire shapes), `src/server/api/inbox.ts` (routes), `src/web/components/QuestionCard.tsx` (the shared card).

## Wiring
- `QuestionPipeline` is the supervisor's `ControlRequestHandler` (`docs/supervisor.md`). `createSessionServices(config, store, bus)` in `src/server/app.ts` builds both and joins them (`pipeline.bind(supervisor)`); `main.ts` and `buildApp` (when it makes its own supervisor) use it. Because the pipeline is the handler from the start, it also hears about requests a crash left open (`orphaned`, M2.4 restart recovery).
- Routes reach it as `ApiContext.questions`. Its `/hub` events go to the app's bus.

## Question batches (AskUserQuestion)
- One `can_use_tool` request for `AskUserQuestion` = one **batch**: `batchId` = the control `request_id`; `tool_use_id` and the tool input are stored verbatim (`question_batches`).
- One `Question` per `input.questions[i]`: `text` = `question`, `header`, option `label` + `description` and `multiSelect`, all verbatim (`questions`, with `position`).
- **Source** = the session's main agent (its agent name: `orchestrator`, the one solution, or `main`; gap #8). Subagents have no AskUserQuestion (M0.2), so no attribution is inferred from the text.
- An AskUserQuestion input without readable questions (no non-empty `questions` array, a question without text, no options, an option without a label) is never answered for the developer: it becomes a permission item (Allow once / Deny) with the input verbatim.
- On creation: `/hub` `questionBatch` `{ sessionId, batchId, questions: Question[] }` and `inboxChanged { count }`. The session is `need` (supervisor).

### Answering: `POST /api/questions/batch/{batchId}/answers`
Body `{ answers: [{ questionId, answerIndex }] }`.

| Case | Answer |
|---|---|
| unknown batch | `404 {error:"not-found"}` |
| already answered | `409 {error:"already-answered"}` |
| not every question answered exactly once with an integer index of one of its options (or no/garbled body) | `400 {error:"invalid"}` |
| an answer for the same batch is being written | `409 {error:"busy"}` |
| otherwise | `204` |

- **Open batch** → exactly one stdin line: `{"type":"control_response","response":{"subtype":"success","request_id":<batchId>,"response":{"behavior":"allow","updatedInput":{<input unchanged>,"answers":{"<question text>":"<option label>"}}}}}`. The batch becomes `answered`, delivered via `control_response`. The recorded `ask-2q` answer is reproduced byte for byte (apart from the fresh `request_id`).
- **multiSelect**: the contract has one `answerIndex` per question, so a multi-select question takes one option and `answers` carries that one label (the CLI accepts several joined with `", "`; M0.2).
- **Same question text twice** in one batch: the CLI keys `answers` by text, so their distinct labels are joined with `", "` (the CLI's own multi-value format).
- **Stale batch** (see below), or an open one whose request ended just before the answer: the answers are stored (the batch stays `stale`, with `answeredAt`) and go to the session as a normal user message, questions and answers verbatim:
  ```
  Answers to your earlier questions:
  "<question text>" = "<option label>"
  …
  ```
  - the session has a live process that is not being stopped (e.g. resumed idle after a restart, or resumed and idle) → sent at once (`SessionSupervisor.sendToLive`); the outbox (restart note) rides along in the same message;
  - otherwise (paused, ended, detached, service closing) → queued in the session's outbox (`pending_messages`, kind `stale-answers`, with the batch id) and sent ahead of the session's next message, e.g. `<answers>\n\nContinue.` on Resume. Answering never starts or resumes a process by itself.
  - The batch records `deliveredVia: user_message` once the message is written (`pendingDelivered` hook for queued ones).
- After an answer: `inboxChanged` and `sessionUpdated` (the open question count).

## Permission requests (D6)
- A `can_use_tool` request for any other tool = an Inbox **permission item** (`permission_requests`): `tool_name` + `input` verbatim, `description`, `decision_reason`, and `agent_id` when a subagent asks. The asking agent is the subagent whose `system/task_started.task_id` equals `agent_id` (`subagent-perm`), else the main agent.
- `POST /api/inbox/{id}/actions/{action}`:
  - `allow-once` → `{"behavior":"allow","updatedInput":<input unchanged>}`. **Never** `updatedPermissions` (its suggestions would write the project's `.claude/settings.local.json`).
  - `deny` → `{"behavior":"deny","message":"The user denied this tool use in Switchboard."}` (the recorded `perm-deny` text; the model gets it verbatim as an error tool result).
  - `204`; unknown id `404`; another action `400 {error:"unknown-action"}`; not open (decided or stale) `409 {error:"not-open"}`; a request that ended just before the click closes as stale and answers `409`. M3.3 adds the system items' actions to the same route (`docs/system-items.md`).
- `inboxChanged` after each change.

## Stale requests
A `control_cancel_request` (after an interrupt, e.g. Pause with a question open) or the process ending with a request open makes it **stale**. Nothing is ever written to a stale request.

**Answered on claude.ai (D24).** While Remote Control is on for the process and Switchboard is not stopping it, a `control_cancel_request` means the phone answered first (`docs/remote-control.md`). The supervisor passes `answeredOn: "claude.ai"` to `cancelled`, and the pipeline closes a question batch as answered there (`closeAnsweredElsewhere`: state `answered`, `answeredAt`, `answered_on`, no answers): it leaves the Inbox, no longer counts in `openQuestionCount`, and `POST …/answers` answers 409 `already-answered` ("… already answered on claude.ai"). The chat shows the answers bubble **Answered on claude.ai**. A permission item closes as stale, as below; its step line reads `… · answered on claude.ai`.
- A stale **batch** stays answerable (above) and stays in the Inbox until answered, unless its session is closed.
- **Session closed (D33).** Closing a session (`docs/supervisor.md` → *Close and reopen*) runs `QuestionPipeline.closeSession`: every batch of the session that still waits (open, or stale and unanswered) is closed without answers through `closeUnanswered` (the stale path: an open batch becomes `stale`, plus `closed_reason` = `session closed`), and every open permission request goes stale. A closed batch waits no more: it leaves the Inbox and `openQuestionCount`, `Question.closedReason` carries the label, the chat shows **Closed · session closed** instead of the card, and `POST …/answers` answers `409 not-open` ("question batch <id> was closed (session closed)"). Reopening the session does not bring them back. `inboxChanged` is published.
- A stale **permission item** closes without a decision and leaves the Inbox.
- Session status is not changed by this: a paused session stays `paused`, a `need` session resumed idle after a restart is `idle` (the process is not waiting for anything). The unanswered stale batch still counts in the session's `openQuestionCount` and in the Inbox.

## Shapes (`src/server/inbox/wire.ts`)
- `toQuestion` = the contract's `Question` (state = the batch's state).
- `questionBatchItem` / `permissionItem` = `InboxItem`s for M3.2's `GET /api/inbox`. Batch: kind label `Question` / `n questions`, title = the question verbatim / `n questions from <sources>` (prototype copy). Permission: title = the tool's one-line label (`Bash · node -e "console.log(6*7)"`), label `Permission`, detail = the model's description (else the decision reason), actions Allow once / Deny, and the additive `permission` block (`requestId`, `toolName`, `input`, `description`, `decisionReason`, `agentId`, `agent`) with the request verbatim. Since M3.2 the batch title uses each source's name part (before `" · "`) and both items carry the session's branch chips (`sessionBranches`, `docs/inbox.md`).
- `inboxCount` = waiting batches (open, or stale and unanswered) + open permission items + open system items: the items of M3.2's `listInbox` (`GET /api/inbox`, `docs/inbox.md`).

## QuestionCard (web, shared)
`src/web/components/QuestionCard.tsx` renders one batch: head `n questions · relayed verbatim`, per question the source (mono blue), the question verbatim in “…”, and option pills (the option description is the tooltip); footer `k of n answered` (or the prototype's all-answered line) and Send (`Send answer` / `Send all answers`), disabled and at 45% opacity until every question has an answer. `variant="inbox"` (max 760px, quote 13.5px/1.5, pills 6px 12px) or `"chat"` (inline, quote 13px, pills 5px 11px), values from the prototype's `ibCard` / `ssCard` markup. `onSend` gets the contract body. The pure state is in `question-card.ts` (`questionCardView`, `answerBody`, `answeredLines` for the chat's answers bubble: `<source name>: <label>`, the source cut at its first `" · "`, M4.2). The Inbox (M3.2) and the chat tab (M4.2) mount it; their visual oracles cover it in place.

## Tests
- `tests/server/inbox/pipeline.test.ts` (the M3.1 oracle): fake-claude through `buildApp` + the contract routes, no demo data. `ask-2q` (one batch, two verbatim questions, `questionBatch` payload keys, 400 cases, the stdin line equals the recording apart from `request_id`, done), `ask-multiselect`, `perm-allow` / `perm-deny` through the Inbox actions (stdin equals the recordings), `subagent-perm` attribution, `ask-interrupt` (Pause → stale, nothing written; answer → queued; Resume → `<answers>\n\nContinue.`), a stale batch answered while the resumed process is idle (sent at once), SIGKILL with a request open (permission closes, batch stays answerable and is queued), and the pure rules.
- `tests/server/supervisor/restart.test.ts` (M2.4) answers its stale batch through the real route: the resumed idle process gets `Switchboard restarted.\n\n<answers>`.
- `tests/web/question-card.test.ts`: the card's state and markup.
