# v2 · One agent (`/agents/:id`, tabs `changes` · `results` · `timeline` · `helpers`, a helper, a result, a message)

**Owner: lane S.** Lane F (Foundation) made this stub and wired it into the router (`../shell/Outlet.tsx`); the page's exports in `index.tsx` are what the router mounts, so keep their names and props.

## Scope
The chat (document-style replies, in-chat answer cards, helper threads, results as attachments), the composer, the per-reply ⋯ menu, the side panel (⌘.), the tabs, the agent ⋯ menu, the automatic-tests chip, the peek sheet.

## Shared modules to use
- `shell/shortcuts.ts` → `useShortcut('side-panel', toggle)` (⌘. is the shell's key)
- `shared/AnswerCard.tsx` → `<AnswerSlot itemKey item variant="chat" where="chat" />` (live card, compact once answered), `AnsweredLine`; `answer-model.ts` → `answeredFromServer(questions)` for history
- `shared/needs-you.ts` → `useNeedsItemsOf(sessionId)`
- `components` → `Sheet` (the peek), `Tabs`, `MenuButton`

## Rules for every lane
- Work only inside this folder (and new files of your own under `src/web/v2/`). The router, the shell and
  `shared/` are lane F's: ask the orchestrator (or record an assumption in `docs/design/v2-decisions.md`) if
  you need a change there.
- Words come from `../glossary.ts` (add missing ones there, never hard-code a v2 term twice).
- Base components from `../components/index.ts` (Button, IconButton, Chip, StatusBadge, Card, Tabs,
  Segmented, Menu/MenuButton, Popover, Dialog, Sheet, Drawer, BottomSheet, Toast/useToast, Skeleton,
  EmptyState, Avatar, ComputerTag, Kbd, Field/Select/TextArea/Checkbox/Switch, Icon).
- Navigate with `useV2Router()` / `<V2Link>` from `../nav.tsx` (v2 paths, `../routes.ts`).
- Data: the classic API clients (`src/web/api/client.ts`, `src/web/plans/api.ts`, `src/web/team/api.ts`,
  `src/web/memory/api.ts`) and hub hooks (`src/web/api/useHub.ts`, `useMachines.ts`, `session-list.ts`).
- CSS: scope every rule under `.sb2` and use `--v2-*` tokens (`../tokens.css`); class names start `v2-`.
- Status = icon + word + colour (`StatusBadge`); touch targets ≥ 44 px; light and dark; reduced motion.
- Tests: unit tests in `tests/web/v2-<area>.test.ts` (pure modules only: no JSX/DOM imports there);
  E2E in `tests/e2e/v2-<area>.spec.ts` with `V2_SERVER_ENV` / `useV2(page)` from `tests/e2e/v2-world.ts`.

Spec: `docs/design/v2-prototype.html` (Direction D v3), `docs/design/v2-plan.md`; architecture: `docs/v2.md`.
