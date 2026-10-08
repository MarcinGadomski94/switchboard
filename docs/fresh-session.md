# Fresh session when the context fills (D83)

When a supervised session's context reaches the threshold, Switchboard offers to **continue it in a fresh session**: the agent writes a handover in one turn, a new session starts in the same folder / worktree / branch on the same CLI, model and account with the handover as its first message, takes the old session's sidebar place, todo list and pin, and the old session is closed. Both are linked both ways.

## The offer (`src/web/views/session/FreshOffer.tsx`, `fresh-offer.ts`, `fresh-offer.css`)

- **Where:** a bar right above the composer (under the todo strip), only in the Chat tab. **Context 82% — Continue in a fresh session** with **Continue** and **Not now**.
- **When:** Settings → Sessions → **Fresh session when the context fills** is on (`sessions.freshOffer`, default **on**) and the session's context meter (D49, `Session.context.percent`) is at or past the threshold (`sessions.freshOfferPct`, default **80 %**, 50–95 in steps of 5 in the select; any whole number 50–95 through the API).
- **Not while a turn runs:** the bar is hidden while the session runs or waits for the developer (`status` `run` / `need`, or a live activity) and shows once the turn ends. The route refuses then too (409 `turn-running`).
- **Never for:** a hooked terminal session (D48 P4: Switchboard cannot ask the terminal's `claude` for a handover or start its next session there; the ⋯ menu shows the action disabled with that reason, the route answers 409 `hooked-unavailable` with it), a closed or moved session, a detached one (continued in a terminal), one without a meter (the demo seed), one that is switching CLI or account, an offline peer's session.
- **Not now** snoozes it until the context is **10 points** higher (82 % → shown again at 92 %). The snooze is this browser's (`localStorage` `switchboard.freshSnoozes`, session id → percent) and is forgotten once the context drops below the threshold (a compaction), so the next fill offers it at the threshold again.
- **While it runs** the bar says *Writing the handover for the fresh session…*, then *Starting the fresh session…* (`Session.freshContinue.step`, on every tab). The tab that asked opens the fresh session as soon as it exists (`continuedTo` arrives on `sessionUpdated`).
- A refusal shows its message in the bar.

The **session's ⋯ menu** in the sidebar has the same action, **Continue in a fresh session**, at any percent (the developer decides): it opens the session's chat (the bar shows the progress) and then the fresh session. A refusal shows as a toast.

## What happens (`SessionSupervisor.continueFresh`, `src/server/supervisor/supervisor.ts`)

`POST /api/sessions/{id}/fresh` checks and starts it, then answers 202; the rest runs on:

1. **Handover** — Switchboard asks the agent, as a service message, for a handover as its whole reply: *the goal, the current state, the decisions made so far, the files you touched, the open questions, and the next steps*, and anything uncommitted (`freshHandoverRequest` in `src/server/cli/handover.ts`). This is the D62 / D63 handover mechanism (`#askHandover`): one turn, at most 10 minutes, its last main-agent reply; a paused session is resumed for it. Messages to the session are refused meanwhile (`switching`).
2. **The fresh session** is stored with the old one's folder, cwd (its worktree, if any), branch and branching, CLI, model, effort, account profile and its pin (D63 `profilePinned`), solutions, work type / mode / phase / QA fields, ultracode and permission mode. Its name and title follow the old one: `fix-login` → `fix-login-2`, *Fix login* → *Fix login (2)*; a continued session counts on (`fix-login-3`, *Fix login (3)*; `freshName` / `freshTitle` in `src/core/fresh-session.ts`). It starts a **new conversation** of the CLI (`--session-id`, not `--resume`), with the usual injections (standing instruction, the todo MCP tools, the account's environment), and its chat begins with the divider **Continued from <old title>** (a link).
3. Its **todo list** moves over (`TodoService.moveAll`: ids, states, times, plans and order kept, with D76's run fields, D78's actuals and their `todo_actuals` history, D81's capture flags; the D76 links follow: runs of the moved items name the fresh session as their source, and a continued **run** session hands its run and `todoLink` to the fresh one) and the old session's **worktrees** become its own (the Diff tab follows). Then the handover goes in as its first message (`incomingFresh`: *You are continuing the session "<title>" in a fresh session, in this folder …* + the handover between `---` lines + *check `git status` … then continue with the next steps*).
4. **The old session** gets the divider **Continued in <new title>** (a link) and its `continuedTo`, and is **closed** (D33's close, confirmed: its process stops the way Pause stops it; its open questions leave the Inbox). Its header says *Continued in <new title>* with **Open the fresh session**. Reopen in History still works (its conversation is its own; the todos stay with the fresh session).

If the handover turn fails (the CLI ends, a usage limit, the timeout, no reply) or the start fails, nothing of a new session is kept, the old session stays open and as it was, and its chat gets an error line *Could not continue in a fresh session: <why>*.

## Sidebar place (`src/server/sessions/fresh-place.ts`, `inheritPlace` in `src/core/sidebar-layout.ts`)

The fresh session takes the old one's place: **pinned** at its position, in its **folder** at its position, or at its position in the **loose** order (D71); the old id leaves the layout. An old session that was never placed leaves nothing to take (the fresh one is unplaced, so it shows at the top, newest first). `FreshPlaces` listens to `sessionUpdated` and adopts every session with a `continuedFrom` that is not placed yet — this machine's own, and a **paired machine's** (D48: this machine's layout holds them by their remote ids `r~<machine>~<id>`). The change is published (`sidebarLayoutChanged`) and synced to the machines the layout is shared with (D71); a session placed already is left alone.

## Paired machines (D48)

`POST /api/sessions/{id}/fresh` is on `PEER_API_ALLOW`: for a paired machine's session the bar and the menu work through the proxy; the handover and the new session run on that machine. The answer is mapped like Stop's (`wrapped`: `{ session }` namespaced); `Session.continuedTo` / `continuedFrom` and the dividers' `linkedSessionId` are namespaced, so the links open the other machine's sessions here. A device (D73) may call it too (`DEVICE_ALLOWED`).

## History

A stored session's row shows **Continued in <title>** / **Continued from <title>** links (`HistoryItem.continuedTo` / `continuedFrom`) next to its Closed tag.

## Storage

Migration **0036** adds `sessions.continued_to` (on the old session: the fresh one's id) and `sessions.continued_from` (on the fresh one: the old one's id), plain ids (`docs/database.md`). `Session.continuedTo` / `continuedFrom` carry `{ sessionId, title }` (`title` `null` once that session was deleted); `Session.freshContinue` the step while it runs (not stored: a restart ends a continuation that was running, as it ends a CLI switch).

## Tests

- `tests/core/fresh-session.test.ts`: the offer rules, the snooze, names / titles, `inheritPlace`, the peer mapping.
- `tests/server/sessions/fresh-session.test.ts` (fake-claude): the whole continuation (request, new session's argv and first message, dividers, links, close, a second continuation counts on), refusals (turn running, detached, closed, hooked), a failed handover keeps nothing.
- `tests/server/peers/fresh-session.test.ts`: B continues A's session through the proxy; namespaced links; B's pin follows.
- `tests/web/fresh-offer.test.ts`: eligibility, busy, the snooze storage, the ⋯ menu state, the chat dividers.
- `tests/e2e/fresh-session.spec.ts`: the bar at 85 %, Not now, Continue (todos, pin, close, links both ways, History), the ⋯ menu at 10 %, Settings off / threshold, the phone layout.
