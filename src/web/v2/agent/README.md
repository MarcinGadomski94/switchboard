# v2 · One agent (`/agents/:id`, tabs `changes` · `results` · `timeline` · `helpers`, a helper, a result, a message)

**Owner: lane S.** The router mounts `AgentPage` from `index.tsx` (`../shell/Outlet.tsx`); the shell mounts `PeekHost` once (`../shell/Shell.tsx`). Keep those names and props.

## What is here

| File | What |
|---|---|
| `index.tsx` | `AgentPage` (the router's page), and the peek exports |
| `AgentView.tsx` | The full view: header, tabs, chat + dock or a tab, the side panel (desktop column, tablet drawer, phone bottom sheet), ⌘. |
| `Header.tsx` | Agents › folder, View menu, Details, the agent ⋯ menu (`AgentMenuButton`) and its dialogs; the title (click to rename), status, automatic-tests chip, computer / folder / engine tags, the Needs-you line, the tabs |
| `ChatPane.tsx` | The chat ("E. Chat text space"): rows, paging (D95), a search hit (D97), in-chat answer cards (`AnswerSlot`), the reply ⋯ menu |
| `Dock.tsx` | The composer dock: live line (Stop / Esc), queued and paused messages, the tasks and working-memory strips, 📎 + box + Send (⌘↩) |
| `SidePanel.tsx` | Details: the project line and What agents know (`SideExtras.tsx`), Working memory, How it works, Helpers, Agents overview (`SideExtras.tsx`: D21 / D27 / D51 with Resume run), Background apps, Tasks, Handoff note & terminal, Advanced (each group remembered) |
| `SideExtras.tsx` | Lane X: `ProjectLine` (D99), `NotesLine` (D107, links `/notes?scope=<folder>`), `OverviewGroup` |
| `MoveDialog.tsx` | Lane X: `MoveDialogsHost` (mounted by `PeekHost`): the v2 Move to computer (D65 / D110) and Continue in Switchboard (D72) dialogs over the classic stores (`openTakeover`, `openContinueHooked`) and API |
| `tabs.tsx` | Changes, Results (opens lane R's `results/ResultDrawer.tsx`, `openAgent={false}`, Delete with Undo), Timeline, Helpers |
| `HelperChat.tsx` | A helper's own chat (`/agents/:id/helpers/:helperId`) |
| `Peek.tsx` | `openPeek`, `closePeek`, `PeekHost`, `PeekSheet` |
| `dialogs.tsx` | Undo from here (D80), Save as result (D89), Rename, Continue in a terminal, Remote control (QR), confirmations |
| `useAgent.ts`, `useChatRows.ts` | Data: the classic session data (`useSessionData`), hub reloads, activity, computer, save points; the chat rows |
| `chat-model.ts`, `composer-model.ts`, `header-model.ts`, `reply-menu.ts`, `how-model.ts`, `view-settings.ts` | Pure, unit-tested (`tests/web/v2-agent.test.ts`) |
| `results-bits.ts`, `move-model.ts`, `side-model.ts` | Lane X, pure, unit-tested (`tests/web/v2-x-agent.test.ts`) |
| `agent.css` | Styles, all under `.sb2`, classes `v2-ag-*` |

Everything reuses the classic session view's models, hooks and API clients (chat items, outgoing / D114, Stop / D50, drafts / D88, attachments / D57, checkpoints / D80, diff / D90, timeline, fresh session / D83, CI / D109, processes / D127); only the markup is new. E2E: `tests/e2e/v2-agent.spec.ts`.

## The peek sheet (for Home, Agents, the Board)

```tsx
import { openPeek, closePeek, PeekSheet } from '../agent/index.tsx';

openPeek(sessionId); // opens the one peek sheet of the page (the shell renders PeekHost)
closePeek();
```

- `openPeek(sessionId)` shows the agent in a side sheet (full width on a phone): its chat with the composer (send, queue, Stop), **Changes**, **Results** and **Helpers**, and **Open full view** (`/agents/:id`, same tab).
- `<PeekSheet sessionId onClose />` is the sheet itself, for a page that wants to own it (most should call `openPeek`).
- Escape or the scrim closes it. Answer cards in its chat answer like everywhere else (they leave Needs you at once).
- Tests and the console: `window.__sbV2Peek(id)` = `openPeek(id)`.
- `AgentMenuButton` (`Header.tsx`) is the agent ⋯ menu with every action; a row elsewhere may reuse it with `data` from `useAgent(sessionId, false, null)`.

## Shared modules used
- `shell/shortcuts.ts` → `useShortcut('side-panel', toggle)` (⌘.)
- `shared/AnswerCard.tsx` → `<AnswerSlot itemKey item variant="chat" where="chat" />`, `AnsweredLine`; `answer-model.ts` → `answeredFromServer`
- `shared/needs-you.ts` → `useNeedsItemsOf(sessionId)`, `useNeedsYou()` (the answered map keeps the compact line in history)
- `shared/agent-row.tsx` / `agent-line.ts` → `AgentComputerTag`, `agentStatusOf`, `agentName`
- `components` → `Sheet`, `Drawer`, `BottomSheet`, `Dialog`, `Tabs`, `Segmented`, `Menu`, …

Spec: `docs/design/v2-prototype.html` (agent full view, peek, phone chat); architecture: `docs/v2.md`; the assumptions: `docs/design/v2-decisions.md` → *Lane S*.
