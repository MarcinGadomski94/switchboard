# Chat tab (M4.2)

SPEC → Session → Chat, prototype `vSession` chat markup + `msgs` / `card()` / `ssAnswered` / `quick` / `sendDraft`. The tab reads only the contract routes and `/hub` (D13): the conversation from `GET /api/sessions/{id}/events` + the `event` stream, the question batches from `GET /api/sessions/{id}`, and it writes through `POST /api/sessions/{id}/messages` and `POST /api/questions/batch/{batchId}/answers`. Code: `src/web/views/session/ChatTab.tsx` (view), `chat.ts` (pure state), `session.css` (`sb-chat-*`), the shared `QuestionCard` (`docs/questions.md`); server: `sessionQuestions` in `src/server/sessions/wire.ts`.

## What it shows
`chatItems(events, questions, mainAgentId)`, top to bottom:

1. **Only the main conversation**: events of the session's main agent (or of no agent). A subagent's own lines (its text, tools, prompts) belong to its agent card and the timeline (M4.3 / M4.4); the main agent's `Agent · …` call is the step line that stands for it. Without a known main agent every event shows.
2. **Time order**: `ts`, then id. Turns a terminal added while detached carry the transcript's timestamps (M4.1), so they sit where they happened.
3. **User bubbles** (right, `#212227`, 12px radius, max 72%): every `user` payload: typed here, the task, "Continue.", a service note (restart, stale answers) or a terminal prompt (`data-origin`).
4. **Agent blocks** (left, max 92%): an `assistant` text, then the **step lines** that followed it until the next text, user message, question batch, turn end or lifecycle step. A turn that starts with a tool gets a block without text. Step lines are mono 12px `#8d8c87`, `<mark> <event label>` (labels per `docs/derivations.md` → *Events*):

   | Event | Mark |
   |---|---|
   | tool call with its result | `✓` (`✕` when the result is an error, e.g. an interrupted or denied call) |
   | tool call without a result yet | `●` |
   | AskUserQuestion with an open request but no batch behind it (not read yet, or an input the pipeline turned into a permission item, M3.1) | `⏸` |
   | permission request (`request`) | `⏸` open · `✓` allowed · `✕` denied, cancelled or stale |
   | automatic denial (`denied`), failed turn (`result` with `isError`), permission-mode mismatch | `✕` |

   Not shown: successful `result`s (the text before them is the answer), lifecycle steps, subagent prompts, events without a `type` (the demo's timeline rows). The demo's terminal lines are successful results (M4.3, `docs/session-panel.md`), so they do not show here either.
5. **Question batches** at their AskUserQuestion call (the tool event's `requestId` = `batchId`); batches with no such event among the loaded events (the demo seed's) come after everything else, in batch order:
   - **waiting** (a question without `answeredAt`: open, or stale and unanswered) → the shared `QuestionCard` with `variant="chat"`: head `n questions · relayed verbatim`, each source in mono blue, the question verbatim in “…”, option pills, `k of n answered`, Send disabled at 45% opacity until every question has an answer. Send posts the contract body; the card stays locked until the reloaded session shows the batch answered. A refusal shows `Not sent: <message>` in the status line.
   - **answered** → the answers bubble (right, `12px 12px 4px 12px`, max 80%), one line per question `<source name>: <option label>` (the source's part before `" · "`, prototype `ssAnswered`), and under it `● Answers written into the briefs. Blocked agents are resuming…` (mono 12px, `oklch(0.74 0.12 250)`), the SPEC copy, for every answered batch (a stale batch's answers go out as a user message instead, `docs/questions.md`, and that message then shows as a user bubble).

The list stays scrolled to the newest item while the developer is at (or within 32px of) the bottom, and jumps there after they send a message or an answer; scrolling up stops that until they scroll back down.

## Composer
- **Quick replies** (label `QUICK REPLIES`, pills): the prototype's four labels and texts verbatim. A pill **fills the draft** and focuses the field; it never sends by itself (prototype `quick`).

  | Pill | Draft |
  |---|---|
  | Accept recommended | `Accept recommended: feature-building · single-solution · UI-first · sequential` |
  | Match Figma exactly | `Match the Figma frame exactly; don't add variants.` |
  | Stop and ask designer | `Stop and park this until the designer confirms.` |
  | Commit when green | `Commit once all checks are green. Stage only this feature's files.` |
- **Field + Send**: placeholder `Message <session name>…` (D22: the session's title, else its name). Enter (not while an IME composes) or Send posts the trimmed draft to `POST /api/sessions/{id}/messages`; an empty draft sends nothing. On `202` the draft clears (unless it was edited meanwhile); the message shows once the service records it (the `/hub` `event`), so what the chat shows is what the process got. The service resumes a paused session to deliver it (`SessionSupervisor.sendMessage`).
- A refusal shows `Not sent: <server message>` under the field and keeps the draft, e.g. `Not sent: the session continues in a terminal; attach it first` while detached (M4.1). Picking a quick reply clears it.

## Data
- `SessionDetail.questions` (additive on the provisional type, `src/core/api.ts`): every question of every batch of the session, batches oldest first, questions in order, in the contract's `Question` shape (`state` = the batch's state). The view reloads the detail on `/hub` `sessionUpdated`, `event` and `questionBatch` for the session (throttled to 500 ms) and right after an answer.
- The demo seed writes the prototype's chat as the same payloads (`src/server/demo/seed.ts` → `demoStep`): messages → `user` / `assistant`, each tool line → a step event with the same mark (`✓` finished tool, `●` running tool, `✕` failed tool, `⏸` open permission request). The prototype's single `•` note line (prod-monitoring) has no event of its own and shows as `✓`. The demo question batches have no AskUserQuestion event, so they sit at the end, as in the prototype.

## Tests
- `tests/web/chat.test.ts`: items, grouping, order, marks, the main-agent filter, batch placement, the answers lines, the composer copy and the quick replies against the prototype source.
- `tests/server/sessions/questions.test.ts`: `SessionDetail.questions`.
- `tests/e2e/session-chat.spec.ts` (oracle, real path, no demo): fake-claude `tool-use` (task bubble, `✓ Write · out.txt`, `✓ Bash · ls`, `DONE`), a quick reply fills the draft only, Enter sends (`202`, the bubble shows), `ask-2q` shows the inline card (Send disabled at 45% until both are answered), the answers reach the process (the fake's AskUserQuestion result is built from them) and the card turns into the answers bubble followed by the reply, Send works, a detached session refuses with the service message.
- `tests/e2e/visual/session-chat.spec.ts` (D10): the demo app against the prototype (`docs/visual/chat.md`).
