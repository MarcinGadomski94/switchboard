# v2 · Settings (`/settings[/:section[/:sub]]`), embedded tools (`/tools/:id`), the share target (`/share`)

**Owner: lane R.** Lane F (Foundation) made this stub and wired it into the router (`../shell/Outlet.tsx`); the page's exports in `index.tsx` are what the router mounts, so keep their names and props.

## Built (lane R)
- `index.tsx`: the page (desktop list of sections, phone drill-down), `ToolPage`, `SharePage`.
- `UsageSection.tsx`, `ComputersSection.tsx`, `PhonesSection.tsx`, `sections.tsx` (Rules, Appearance, `useKnownSettings`), `AdvancedSection.tsx`.
- `ClassicFrame.tsx`: a classic section inside v2 (contexts, re-pointed tokens, modals, toasts).
- Pure: `settings-map.ts` (the Advanced pages, where every classic section lives, and their headings `ADVANCED_GROUPS`), `settings-model.ts` (account cards, switch at), `density.ts` (the per-browser density lane S reads), `settings-index.ts` (fix after 2.0: every searchable setting, the ranking, breadcrumbs, marks).
- `SettingsSearch.tsx` (fix after 2.0): the search at the top of every Settings page (`?q=`) and `useSettingFlash` (`?setting=<id>`: scroll to the row, highlight it 2 s). ⌘K reads the same index (`../palette/palette-model.ts` → `settingRows`).
- Tests: `tests/web/v2-settings.test.ts`, `tests/web/v2-settings-search.test.ts`, `tests/e2e/v2-settings.spec.ts`, `tests/e2e/v2-settings-search.spec.ts`.
- **A new setting row:** an anchor (`data-row` or `data-testid`) and an entry in `SETTINGS_INDEX` (label, help, other words); a new Advanced page: a place in `ADVANCED_GROUPS`.

## Scope
Usage & accounts, Rules for every agent, Appearance (theme v2 / Classic — lane F built `ThemeRow` and `SchemeRow` — density, light / dark), Computers, Phones, Advanced (a page per classic section: `/settings/advanced/<classic key>`, grouped under Agents · Projects & code · Accounts & devices · Notifications · App; `code-projects` and `connections` are the classic Solutions and MCP pages). Fix after 2.0: that order, and a search over single settings at the top.

## Shared modules to use
- `settings/ThemeRow.tsx` → `ThemeRow`, `SchemeRow` (keep them in Appearance)
- `theme.ts` → `themeStore`, `useThemeState()`
- `routes.ts` → `V2_SETTINGS_SECTIONS`; `glossary.ts` → `SETTINGS_LABELS`
- classic sections under `src/web/views/settings/` may be reused or embedded

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
