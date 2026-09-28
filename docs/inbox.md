# Inbox view (M3.2)

SPEC → Inbox, prototype `vInbox` markup + `inboxRaw` / `ib` / `card()` logic. The view reads only `GET /api/inbox` and `/hub`, and writes only through the contract routes (D13). Code: `src/server/inbox/wire.ts` (`listInbox`, item shapes), `src/server/api/inbox.ts` (route), `src/web/views/InboxView.tsx` + `inbox.ts` (pure state) + `inbox.css`, the shared `QuestionCard` (`docs/questions.md`).

## `GET /api/inbox`
`InboxItem[]`, the same items `inboxCount` counts (`inboxChanged.count`):
1. **Items that wait on a session**, newest first (the sidebar's session order): question batches that wait for the developer (open, or stale and still unanswered, `docs/questions.md`) and open permission requests (D6).
2. **Open system items** (raised by M3.3, `docs/system-items.md`), oldest first: the order they were raised, which is the prototype's order (session items, then `SYS` in array order).

Item shapes (`src/core/api.ts` → `InboxItem`):
| Kind | source | title | label | detail | extra |
|---|---|---|---|---|---|
| `questions` | session name | the question verbatim, or `n questions from <names>` | `Question` / `n questions` | `''` | `questions: Question[]` |
| `permission` | session name | the tool's one-line label (`Bash · node -e …`) | `Permission` | the model's description, else the decision reason | `actions` Allow once / Deny, `permission` (tool + input verbatim, asking agent) |
| `system` | stored source (schedule name, `worktrees`) | stored | `SYSTEM_ITEM_LABELS[kind]` (`schedule-run-failed` → `Scheduled run failed`, `worktree-removable` → `PR merged`), else the stored kind | stored | `actions` (the first is primary), `prefill` when stored (M3.3 "Open fix session") |

- `<names>` in a batch title: each distinct question source cut at the first `" · "` (prototype: `web · microfrontends/acme-app-front` → `web`). The questions keep their full source; the card shows it in mono blue.
- **Branch chips** of session items (`sessionBranches`): every agent of the session with a branch, in agent order, as `<last folder of its solutionPath> ⎇ <branch>` (prototype), then the session's live worktrees (M2.2) as `<repo> ⎇ <branch>` when no agent already names that pair. A session working in place with no agent branch has no chips. System items carry their stored chips.
- Status dot: `need` for session items, the stored status for system items.

## The view
- Two columns `340px | 1fr` (`.sb-inbox`). List column: `Inbox` + `n waiting on you`, then one card per item (status dot, source, age via `formatAge`, title, kind label). D22: a question or permission item's source is its session's display title (`sourceTitle`: the title, else the name); a system item's `source` is shown as it is. The selected card has border `#3a3b41` and background `#1c1d21`; the others `#1f2024` and transparent. Cards are `role="button"` (click, Enter, Space).
- **Selection:** the picked item while it is still listed, else the first (prototype `selId`). Not kept in the URL.
- **Detail:** meta line (dot, source, `·`, kind label, `·`, age, D14: the folder tag when the item's session belongs to a folder other than the default one (its session is read with `GET /api/sessions` once the selection names it), and `Open session →` for question and permission items), the 24px title, the branch chips (the row is always there, empty when there are none), the detail text when there is one, then:
  - question batch → `QuestionCard variant="inbox"`: `k of n answered`, Send disabled at 45% opacity until every question has an answer; Send posts `POST /api/questions/batch/{batchId}/answers`.
  - permission request → a code block with the asking agent (mono blue), the tool name and the input as indented JSON, verbatim; then the actions.
  - system item → the actions.
  - Actions: the first primary (`#e8e7e3` on `#111214`), the rest outlined (`#2c2d32`); each posts `POST /api/inbox/{id}/actions/{action}` (system items since M3.3, `docs/system-items.md`). After "Open fix session" succeeds the New-session modal opens with the item's `prefill`.
- After a successful answer or action the item is hidden at once (the prototype's `sent`) and the list reloads; the next item is selected.
- A refused answer or action shows `Not sent: <server message>` (or `Not sent: HTTP <status>`, `Not sent: Switchboard is not reachable.`) in the card's status line or under the actions; the list reloads.
- **Empty:** the list shows `All clear. Nothing is waiting on you.`, the detail `Inbox zero` + `New questions, approvals and failed runs show up here with a toast and sound.` Both appear only once the list has loaded; while it loads or when the service cannot be reached, only the header shows.
- **Live:** the list reloads on `/hub` `inboxChanged` (published on every new batch or permission request, answer, decision and stale transition, and when a system item is raised or closed); the sidebar badge counts the same list.

## Known difference from the prototype
The prototype labels a one-question batch `Loop paused` when that question's source is the mock `circuit breaker`. A real batch's source is always the session's main agent (M0.2) and nothing in the stream-json says a loop breaker asked, so the app shows `Question` and never reads prototype mock data (D13). Recorded in `docs/visual/inbox.md` and `.loop/questions-w1-inbox.md` (ASSUMED).

## Tests
- `tests/server/inbox/inbox-list.test.ts`: `GET /api/inbox` with fake-claude (`ask-2q`, `perm-allow`, `ask-interrupt`), stored system items and branch sources: order, shapes, branches, the count, stale batches, the title and chip rules.
- `tests/web/inbox.test.ts`: the view's pure state and copy.
- `tests/e2e/inbox.spec.ts` (oracle, real path, no demo): a batch arrives live, Send stays disabled at 45% until both questions are answered, the answers reach the fake process as one `control_response`, Inbox zero; two items (newest first, selection, keyboard), a permission request with tool + input verbatim, Allow once reaches the process, Open session →.
- `tests/e2e/visual/inbox.spec.ts` (D10): the demo app against the prototype (default view, one answer picked, a system item picked) and the empty state (`docs/visual/inbox.md`).
