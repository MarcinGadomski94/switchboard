# v2 · Results (`/results`)

**Owner: lane R.** Lane F (Foundation) made this stub and wired it into the router (`../shell/Outlet.tsx`); the page's exports in `index.tsx` are what the router mounts, so keep their names and props.

## Scope
Grid / list, filters, the preview drawer (versions, compare, source / rendered, full screen), PDF.

## What is here (lane R)
- `index.tsx`: `ResultsPage` (grid / list, type filters with counts, search within, select + Delete with Undo (D111), loading placeholders and the paired computers' sync notes (D113)).
- `ResultDrawer.tsx`: the drawer (preview by kind, versions, Compare side by side, Source / Rendered, Copy, Download, Full screen, Open agent, Delete).
- `results-model.ts` (pure, tested in `tests/web/v2-results.test.ts`): filters, counts, search within, selection, **the deep link** `resultsLink({ id, agent?, computer? })` → `/results?open=<id>&agent=…&computer=…` (the drawer opens on that result).
- E2E: `tests/e2e/v2-results.spec.ts`.

## Shared modules to use
- `components` → `Drawer`
- `api.artifacts()`, `artifactsChanged`

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
