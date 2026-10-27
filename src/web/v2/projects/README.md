# v2 · Projects (`/projects`, `/projects/:id`, `/projects/:id/graph`)

**Owner: lane P.** Lane F (Foundation) made this stub and wired it into the router (`../shell/Outlet.tsx`); the page's exports in `index.tsx` are what the router mounts, so keep their names and props.

## Scope
The list, then Steps / Board / Graph / Timeline (a phone: Steps / Graph); approval modes, holds, Combine / Send back, Reopen, stopped and needs-you steps, Jira import, delete, the run subfolder.

## Built (lane P, 2026-10-25)
- `index.tsx` mounts `ProjectsPage` (`ProjectsPage.tsx`: cards with progress, time left, mode, Jira tag, needs-you / stopped counts; the Timeline; Import from Jira, `JiraImport.tsx`; New project → `openNew`) and `ProjectPage` (`ProjectPage.tsx`: the header with the approval mode, the acknowledgement, Start / Hold / Resume and the ⋯ menu; `views.tsx`: Steps / Board / Graph / Timeline; `dialogs.tsx`; `JiraSection.tsx`: From Jira, proposals).
- Pure rules: `project-model.ts` (`tests/web/v2-projects.test.ts`); data: `useProject.ts` (the plan, live, its Jira state, proposals and tasks), actions: `useStepActions.ts`.
- **Steps / Board / Timeline in the Graph's look** (Fixes after 2.0 → *Steps, Board and Timeline in the Graph's look*; `docs/v2.md` → *Projects: Steps, Board and Timeline*): `views.tsx` (the three views and the step row / board card), `views-look.tsx` (the shared header `ProjectProgress`, `StepRing`, the chips, the estimate bar, lane heads, the FLIP / reduced-motion / clock hooks, the remembered Critical path), `views-model.ts` (pure: sections, grouping, column order, lanes and hues as the Graph colours them, the meta line, the timeline's bars, lanes and arrows; `tests/web/v2-project-views.test.ts`), `project-views.css` (kept apart from `projects.css`). E2E: `tests/e2e/v2-project-views.spec.ts`. They import the Graph's `Ring`, `laneColour`, `toneColour`, `openNodeMenu`, `graphTone`, `stepProgress`, `remainingCriticalPath`, `relatedPath`; what `GraphView.tsx` keeps private (its header, `TONE_ICON`, the card's meta line, the hooks) is re-implemented there, to dedupe later.
- E2E: `tests/e2e/v2-projects.spec.ts`. Decisions: `docs/design/v2-decisions.md` → *Lane P*.
- **Graph** (Fixes after 2.0 → *The Project graph, redrawn*; `docs/v2.md` → *Projects: the Graph view*): `GraphView.tsx` (the view, its header and the canvas: fit, zoom, pan, pinch, double tap, minimap, the phone's opening view), `graph-parts.tsx` (the renderers: card, edges with the travelling dots, lanes, final node, ring, minimap, tooltip), `graph-layout.ts` (pure: layers, repository lanes, crossing reduction, the hover path, fit / zoom / pinch maths, the minimap, the critical path; `tests/web/v2-project-graph.test.ts`). E2E: `tests/e2e/v2-project-graph.spec.ts`. Phones offer Steps and Graph (`PHONE_PROJECT_VIEWS`). The minimap shows only while steps are outside the view (a phone: on Map). What's new: the v2 tour `project-graph` (`src/core/tutorial.ts`, anchor `v2-project-graph`).
- **Graph in full screen** (Fixes after 2.0 → *The Project graph in full screen*; `docs/v2.md` → *Projects: the Graph view*): `GraphView.tsx` (`useGraphFullscreen`: the Fullscreen API or the overlay, Esc; `useIdle`; Follow; the Fit pill; the overlay layer it registers with `components/Portal.tsx`), `graph-fullscreen.ts` (pure: when to fit or follow, Follow's view, the title; `tests/web/v2-project-graph-fullscreen.test.ts`), `ProjectGraphPage.tsx` (`/projects/:id/graph`, mounted bare by the shell). E2E: `tests/e2e/v2-project-graph-fullscreen.spec.ts` (sample plan shared with the graph spec: `tests/e2e/project-graph-sample.ts`). What's new: the v2 tour `project-graph-fullscreen` (2.4.3, anchor `v2-graph-fullscreen`).

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
