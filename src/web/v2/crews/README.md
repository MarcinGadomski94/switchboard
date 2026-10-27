# v2 · Crews (`/crews`, `/crews/:id`, `?member=&tab=access` opens a teammate's Access tab)

**Owner: lane P.** Lane F (Foundation) made this stub and wired it into the router (`../shell/Outlet.tsx`); the page's exports in `index.tsx` are what the router mounts, so keep their names and props.

## Scope
All crews (ordered), crew detail with a switcher, teammates, job descriptions, access requests and keys, budgets, hand-offs, Move to crew / computer, Pause, New teammate.

## Built (lane P, 2026-10-25)
- `index.tsx` mounts `CrewsPage` (`CrewsPage.tsx`: crews in order, drag and ⋯ › Move up / down, New crew, New teammate) and `CrewPage` (`CrewPage.tsx`: the switcher, teammate cards with Needs-you AnswerCards, budgets, the teammate ⋯ menu, activity and hand-offs, the teammate panel `?member=&tab=access`, the phone's drill-down); `dialogs.tsx` (New crew / teammate, Move to crew / computer, Budget, Model, job description edit), `AccessPanel.tsx` (Add key).
- 2026-10-27 (D137 follow-up, the developer chose B): archived teammates are hidden from both pages and every count (`crewStats` via `visibleTeam`, `CrewPage` via `visibleMembers`), with the quiet `ArchivedLine` ("1 archived teammate · Show in Archived"); `docs/team.md` → *Archived members*.
- Pure rules: `crew-model.ts` (`tests/web/v2-crews.test.ts`). E2E: `tests/e2e/v2-crews.spec.ts`. Decisions: `docs/design/v2-decisions.md` → *Lane P*.

## Shared modules to use
- `glossary.ts` → `teammateStatusToV2`, `TERMS.crew/teammate/jobDescription`
- `shared/needs-you-model.ts` → `countByCrew(items)`; items carry `crew`
- `src/web/team/api.ts` (`teamApi`)

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
