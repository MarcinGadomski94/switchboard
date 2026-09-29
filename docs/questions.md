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
Body `{ answers: [{ questionId, answerIndex }] }`; D39 adds `{ questionId, text }` (an own answer, *Own answers (D39)* below): exactly one of the two per entry.

| Case | Answer |
|---|---|
| unknown batch | `404 {error:"not-found"}` |
| already answered | `409 {error:"already-answered"}` |
| not every question answered exactly once, an unknown question, or an `answerIndex` that is not an integer index of one of its options (or no/garbled body) | `400 {error:"invalid"}` |
| D39: an entry with both or neither of `answerIndex` / `text`, or a `text` that is not 1–2000 characters once trimmed (checked after the 400 cases) | `422 {error:"invalid", message, errors:[{questionId, field:"answer"\|"text", message}]}`, every refused entry |
| an answer for the same batch is being written | `409 {error:"busy"}` |
| otherwise | `204` |

- **Open batch** → exactly one stdin line: `{"type":"control_response","response":{"subtype":"success","request_id":<batchId>,"response":{"behavior":"allow","updatedInput":{<input unchanged>,"answers":{"<question text>":"<option label>"}}}}}`. The batch becomes `answered`, delivered via `control_response`. The recorded `ask-2q` answer is reproduced byte for byte (apart from the fresh `request_id`).
- **multiSelect**: the contract has one `answerIndex` per question, so a multi-select question takes one option and `answers` carries that one label (the CLI accepts several joined with `", "`; M0.2). D39: or one own answer, which is then its whole answer string.
- **Same question text twice** in one batch: the CLI keys `answers` by text, so their distinct labels (D39: or own answers) are joined with `", "` (the CLI's own multi-value format).
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

### Own answers (D39)
Every question can be answered with the developer's own words ("Other…" on the card) instead of an option, as Claude Code's own "Other" does. Code: `src/core/own-answer.ts` (the rule, shared with the card), `validateAnswers` / `answersByText` in `pipeline.ts`, `QuestionRepository.answer` / `ownAnswerOf`.
- **The entry:** `{ questionId, text }`. `text` is trimmed and must be 1–2000 characters (`checkOwnAnswer`); inner line breaks stay. `null` counts as not given, so `{ answerIndex: 0, text: null }` is an option answer.
- **What goes to the CLI:** `answers[<question text>]` = the trimmed text, verbatim, in the same `control_response` as the option labels (`{ "Which color should the button be?": "Blue", "Which size should it be?": "Medium, with rounded corners" }`). A stale batch's answers message has `"<question>" = "<text>"`.
- **How the CLI itself does it** (read in the CLI 2.1.284 binary's bundled code, read-only, never run for D39): the terminal's AskUserQuestion form adds an `Other` choice (value `__other__`, placeholder "Type something.") to every question. For a single-select question the typed text becomes the answer string as it is. For a multi-select one the picked labels and the typed text become one string through the helper that joins several labels: items joined with `", "`, and an item that contains `", "` or `"` written as a quoted JSON string (the parser next to it reads such items back with `JSON.parse`). A permission answer from a host the CLI checks strictly (AskUserQuestion's `admitCardAnswer`) may only add `answers` (plus `annotations`, `response`, `followUp`) to the unchanged input; each `answers` value is a string of at most 8192 characters or, for a multi-select question only, an array of at most options + 1 strings, which it joins with that helper. Other hosts' `updatedInput` is taken as it is. Switchboard sends one string per question, as before, so both accept it; the 2000-character limit stays under the 8192.
- **Multi-select:** the card and the contract carry one answer per question (M3.1), so a multi-select question takes one option **or** one own answer, never both; the own answer is its whole answer string. D39's "the typed text is one more picked item" needs several picks per question first (`.loop/questions.md` → *D39*).
- **Stored** without a migration: `answer_index` NULL and the text in `answer_label` (the column already holds "the answer as written into `answers`"); the question has `answered_at` like an option answer, and the batch completes when every question has one. `ownAnswerOf(record)` reads it back.
- **Question.answerText** (additive): the own answer as sent, `answerIndex` then `null`; `null` otherwise (`toQuestion`).

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

**Other… (D39).** After each question's options the card adds an **Other…** pill: the options' class and look (`sb-qcard__option sb-qcard__other`, `data-testid="question-other"`, tooltip "Answer in your own words"), the options row's last child. Picking it selects it and opens a text field under the options (`question-own-input`: a two-line textarea, focused at once, `maxlength` 2000, placeholder `Your answer · Enter confirms · Shift+Enter adds a line · Esc cancels`, the pill's type and radius, the selected pill's border on `--bg-sidebar`):
- **Enter** confirms when the text counts (1–2000 characters once trimmed, `checkOwnAnswer`): the field closes onto the answer, shown verbatim (line breaks kept) in the selected pill's colors under the options (`question-own-answer`; a click, or Other… again, reopens the field with the text). Enter on an empty or blank field does nothing. **Shift+Enter** adds a line. **Esc** cancels back to no pick (the text is dropped). Both move the focus back to the Other… pill; an IME composition keeps its own Enter / Esc.
- A non-empty text counts at once, confirmed or not: for `k of n answered` and for enabling Send. Picking an option drops the own answer; one question holds one answer (a multi-select question too, M3.1).
- Send posts `{ questionId, text }` (the trimmed text) for it (`answerBody`). A stored own answer (`Question.answerText`) is the card's initial pick, confirmed.
- The answers bubble (`answeredLines`) shows `<source name>: <the text verbatim>`; its lines keep line breaks (`white-space: pre-wrap`) and break a long word inside the bubble.
- Read-only cards (D36) show the pill disabled like the options.
- Pure state in `question-card.ts`: `OwnPick`, `pickOther`, `typeOwn`, `confirmOwn`, `cancelOwn`, `ownAnswerKeyAction`, `isAnswered`.

## Tests
- `tests/server/inbox/pipeline.test.ts` (the M3.1 oracle): fake-claude through `buildApp` + the contract routes, no demo data. `ask-2q` (one batch, two verbatim questions, `questionBatch` payload keys, 400 cases, the stdin line equals the recording apart from `request_id`, done), `ask-multiselect`, `perm-allow` / `perm-deny` through the Inbox actions (stdin equals the recordings), `subagent-perm` attribution, `ask-interrupt` (Pause → stale, nothing written; answer → queued; Resume → `<answers>\n\nContinue.`), a stale batch answered while the resumed process is idle (sent at once), SIGKILL with a request open (permission closes, batch stays answerable and is queued), and the pure rules.
- `tests/server/supervisor/restart.test.ts` (M2.4) answers its stale batch through the real route: the resumed idle process gets `Switchboard restarted.\n\n<answers>`.
- `tests/web/question-card.test.ts`: the card's state and markup; D39: Other… picked with the text empty, blank, too long or filled (counts, Send body), Enter / Esc, a stored own answer, the answers lines, the markup.
- D39 in `pipeline.test.ts` (*own answers*): `ask-2q` answered with Blue + a typed text (the `control_response` equals the recording with only the answer values changed, the fake's tool result, the stored text, `Question.answerText`), the 422 cases (nothing written), `ask-multiselect` with a text, `ask-interrupt` (the text in the stale answers message), and the pure rules; `tests/server/db/repos.test.ts` (stored as the label with no index, survives a reopen, an empty one refused).
- `tests/e2e/own-answers.spec.ts` (D39 oracle, real path): an `ask-2q` batch answered with Blue and an own answer, in the chat card and in the Inbox: Other… focused, `1 of 2` while empty or blank, Esc back to no pick, Shift+Enter, Enter confirms; the fake's `control_response` carries `{ "Which color should the button be?": "Blue", "Which size should it be?": "<typed text>" }`; the answers bubble shows the text verbatim on two lines.
