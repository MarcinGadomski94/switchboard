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

## Markdown (D20)
The text of every user bubble and agent block renders as GitHub-flavored Markdown: `ChatMarkdown` (`src/web/views/session/ChatMarkdown.tsx`, memoized on the text) = `react-markdown` + `remark-gfm` + `rehype-highlight`, with the chat's own rules in `markdown.ts` and the styles in `markdown.css` (`.sb-md`). Only the message text: the step lines, the question cards (questions quoted verbatim), the answers bubble and its note, the composer field, and everything outside the chat (terminal tail, Timeline, Inbox, toasts) stay plain text.

- **Covered:** headings, emphasis / strong / strikethrough, lists (nested, ordered), task lists (read-only checkboxes), tables (column alignment from the delimiter row; a wide table scrolls), block quotes, inline code, fenced code blocks, links, horizontal rules; GFM footnotes work too (their links are in-page `#` links, so they render as text).
- **Raw HTML is never rendered.** No `rehype-raw`, no `dangerouslySetInnerHTML`: an HTML tag, comment or block shows as its source text (a block of it as a paragraph), so `<script>` or `<img onerror>` in a message is just text.
- **Links** (`[text](url)`, `<url>`, and bare URLs / `www.` links / e-mail addresses, the GFM autolink literals: *developer addition 2026-09-28*) open in a new tab (`target="_blank"`, `rel="noopener noreferrer"`). Only absolute `http:`, `https:` and `mailto:` URLs are kept (`safeLinkUrl`, read the way the browser reads an `href`); any other URL (relative, `#…`, `javascript:`, `data:`, …) renders as the link's text without a link. Trailing punctuation is not part of a bare URL (`see https://example.com/a.` links `https://example.com/a`); a URL in inline code or a code block stays text; long URLs wrap inside the bubble. The composer field stays plain text: the link appears once the message is sent and shows in the chat.
- **Images are never loaded:** an image becomes a link to its URL (same rules), labelled with its alt text, or its URL when it has none; inside a link only that label shows (links do not nest). No `<img>` is ever rendered.
- **Syntax colors:** a fenced block with a language (` ```ts `, ` ```bash `, …) is highlighted by `rehype-highlight` with lowlight's 37 common languages (highlight.js classes); a block without a language, or with an unknown one, stays plain (no guessing). The colors are the SPEC's hues in muted form on `bg-code`: keywords / tags in the branch-chip blue, strings and `+` lines in the diff-add green, numbers / types / built-ins in amber (the question hue at the diff colors' chroma), variables and `−` lines in the diff-del red, comments in `--muted-3`, names in `--text-strong`.
- **Code blocks** (`bg-code`, 1 px `--border-card`, 8 px radius, Geist Mono 12px/1.35) never wrap: box-drawing status tables keep their columns exactly, and a wide block scrolls inside itself. At 12px Geist Mono's box-drawing glyphs are about 15.7px tall, so at the 1.35 line height the vertical lines join. Inline code: Geist Mono 12px on `bg-code` with a 1 px border.
- **Plain text looks exactly as before.** The bubble keeps its pre-D20 rules (13.5px/1.55, `--text-2b`, `white-space: pre-wrap`), and the text of a message without Markdown becomes paragraphs without margins, a blank line (1.55em) apart, with soft line breaks kept as line breaks, so it takes exactly the room the plain text took. `rehypeChatText` makes that hold under pre-wrap: it drops the newline nodes that `mdast-util-to-hast` puts between blocks (and after a hard break), which pre-wrap would show as empty lines. Markdown blocks follow the same rhythm: one blank line between blocks, 4px under a heading, 2px between list items. Headings stay modest (16 / 15 / 14 / 13.5px, 600).
- **Performance:** the chat re-renders on every event, so `ChatMarkdown` is memoized on the text; a streamed message re-parses only itself.
- **Status tables (D21):** the newest status table an agent message holds (a box-drawing or pipe table with an Agent and a Status column) is also repeated, as printed, in the right panel's agent overview under "As reported by the agent" (`docs/session-panel.md` → *Agent overview*); the chat itself shows it unchanged.

## Live activity line (D19)
While a turn runs, one line sits between the conversation and the composer, Claude-Code style; it is not rendered at all when no turn runs, so an idle chat is unchanged. Source: `Session.activity` from the session detail, replaced by each `/hub` `activity` event for the session until the next reload (`useLiveActivity`, `src/web/activity/useActivity.ts`; server side `docs/derivations.md` → *Live activity*). Code: `src/web/activity/activity.ts` (pure copy and formats), `ActivityViews.tsx` (`ChatActivityLine`), `activity.css`. The times are the server's timestamps; the line ticks locally once a second.

| State | Line |
|---|---|
| thinking | spinner glyph, a **playful verb** from Switchboard's own list of 20 (`Pondering…`, `Noodling…`, `Cogitating…`, `Patching through…`, …; `THINKING_VERBS`), the time since the turn started (`12s`, `1m 23s`), then `· ↓ 1.2k tokens` once a thinking-token tick arrived (`formatTokens`: `850`, `1.2k`, `12k`, rounded down) |
| tool | `●` (blinking) and `<Tool>: <summary>` literally (`Bash: npm test`; just the name when the summary is the name), then the time since that tool started (`0:42`, `1:02:03`) |
| writing | spinner, `Writing…`, the time since the turn started |
| waiting | `⏸` (amber, still), `Waiting for you`, the time since the question or permission request opened (`0:42`) |

- The verb changes every 4 s (`VERB_ROTATE_MS`): the turn's start time picks the first verb, then it steps through the list, so the same turn shows the same verb in every tab at the same moment (`thinkingVerb`, deterministic for a given clock).
- The spinner is `·✢✳✶✻✽` stepping in place (a CSS `content` animation on the glyph's `::before`), in the running blue (`--status-run`); `prefers-reduced-motion` stops it.
- Type and colors are the prototype's: mono 12px, `#8d8c87` (the step lines' muted color) with the action in `#c9c8c3`, the tokens in `#76756f`; padding 8px 26px like the conversation. A long action is cut with `…`; the time and tokens always show.
- Test ids: `chat-activity` (`data-state`), `chat-activity-glyph` (`data-glyph`: `spinner` / `●` / `⏸`), `chat-activity-text`, `chat-activity-time`, `chat-activity-tokens`.

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
- `tests/web/chat-markdown.test.ts` (D20): the Markdown mapping (plain text as paragraphs, raw HTML as text, link and image rules, bare URLs, a table, a task list, highlight classes, a box-drawing table kept character for character, `rehypeChatText` on its own).
- `tests/e2e/chat-markdown.spec.ts` (D20 oracle, real path, fake-claude `[fake:say]`): an agent reply with a heading, a list, a table, a highlighted TypeScript block and a box-drawing table (every line equally wide); raw HTML in the developer's message and in the reply shows as text and runs nothing; a pasted URL becomes a link that opens in a new tab (answered by a route, never the network); plain text takes exactly the room it took before D20; no Markdown outside the chat.
- D19: `tests/web/activity.test.ts` (formats, the verb rotation with an injected clock, the lines and labels, the summaries from real tool inputs); `tests/e2e/live-activity.spec.ts` (real path: a slow Bash call's line with a growing clock, a thinking turn's verb + time + tokens, the sidebar action and pulsing dot, the agent card's action; all gone after Pause; an idle session unchanged).
