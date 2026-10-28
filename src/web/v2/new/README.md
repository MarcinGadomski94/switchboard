# v2 · The + New sheet

**Owner: lane R.** Lane F (Foundation) made this stub and wired it into the router (`../shell/Outlet.tsx`); the page's exports in `index.tsx` are what the router mounts, so keep their names and props.

## Scope
Agent / conversation / task / project / routine / teammate / crew. Opened from anywhere with `openNew({ kind, text?, prefill?, machine? })`; the shell renders `<NewSheet />` once.

## What is built (lane R)
- `index.tsx`: `openNew`, `NewKind`, `NewRequest`, `NewSheet` (the shell renders it once).
- `NewSheet.tsx`: the sheet (kinds, forms, Save as draft, ⌘↩); a full-screen sheet on a phone.
- `new-model.ts` (pure, `tests/web/v2-new.test.ts`): the kinds, checks, API bodies, routine presets, project steps, the `new-session` draft.
- APIs: `machineApi(machine).createSession` (Simple, or Full with the workspace questions), `api.createChat`, `api.addTodo`, `api.createLoop`, `plansApi.create` + `addItem` (or Import from Jira: the Projects page's v2 `JiraImportDialog`, D112), `api.putMachineDraft('new-session')`.
- From a terminal (D16 in v2): `BringInSheet.tsx` (pure part `bring-in-model.ts`, `tests/web/v2-bring-in.test.ts`) lists this computer's terminal conversations not in Switchboard yet and moves one with classic's `useConversationMoves`; `openNew({ kind: 'bring-in' })` opens it.
- Teammate and Crew (lane X): `CrewDialogs.tsx` opens the Crews page's `NewTeammateDialog` / `NewCrewDialog` (`../crews/`), one New teammate and one New crew for the whole app; `openNew({ kind: 'teammate' | 'crew' })` opens them.
- Decisions: `docs/design/v2-decisions.md` → Lane R → + New.

## Shared modules to use
- `new/index.tsx` → `openNew`, `NewKind`, `NewRequest` (keep these exports)
- `api.createSession`, `api.createChat`, `plansApi.create`, …

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
