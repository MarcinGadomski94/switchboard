# v2 · Projects (`/projects`, `/projects/:id`)

**Owner: lane P.** Lane F (Foundation) made this stub and wired it into the router (`../shell/Outlet.tsx`); the page's exports in `index.tsx` are what the router mounts, so keep their names and props.

## Scope
The list, then Steps / Board / Graph / Timeline; approval modes, holds, Combine / Send back, Reopen, stopped and needs-you steps, Jira import, delete, the run subfolder.

## Built (lane P, 2026-10-25)
- `index.tsx` mounts `ProjectsPage` (`ProjectsPage.tsx`: cards with progress, time left, mode, Jira tag, needs-you / stopped counts; the Timeline; Import from Jira, `JiraImport.tsx`; New project → `openNew`) and `ProjectPage` (`ProjectPage.tsx`: the header with the approval mode, the acknowledgement, Start / Hold / Resume and the ⋯ menu; `views.tsx`: Steps / Board / Graph / Timeline; `dialogs.tsx`; `JiraSection.tsx`: From Jira, proposals).
- Pure rules: `project-model.ts` (`tests/web/v2-projects.test.ts`); data: `useProject.ts` (the plan, live, its Jira state, proposals and tasks), actions: `useStepActions.ts`.
- E2E: `tests/e2e/v2-projects.spec.ts`. Decisions: `docs/design/v2-decisions.md` → *Lane P*.

## Shared modules to use
- `glossary.ts` → `planItemStateToV2`, `TERMS.project`, `TERMS.step`, `WORDS.combine`
- `shared/AnswerCard.tsx` for a step's ready / stopped / pick items
- `src/web/plans/api.ts` (`plansApi`)

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
