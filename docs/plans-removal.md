# Removing Plans (D99)

Plans is experimental and built to be removed cleanly (`docs/plans.md`, decision D99). Its code lives in its own folders and files; the rest of Switchboard knows it only through the small hooks listed here, each marked in the code with the comment **`Plans (D99) hook`** (`grep -rn "Plans (D99) hook" src` lists them all). `tests/server/plans/removal.test.ts` fails when a file carries the marker and is not listed below, or a listed file no longer carries it.

## 1. Delete Plans' folders and files

- `src/server/plans/` (service and scheduler, `plans.db` and its migrations, repository, routes, git / gh adapter, environment, hooks, `install.ts`)
- `src/core/plans.ts` (shapes, graph rules, texts, the MCP tool definitions)
- `src/hook/sb-plan-tools.ts` (the plan tools of the `switchboard` MCP helper)
- `src/web/plans/` (Settings → Experimental's Plans row, `PlansSwitchRow.tsx`; the Plans list and plan page, their dialogs, model, store and styles, the nav item and the session's Plan tab, the Jira import seam)
- `tests/server/plans/`, `tests/core/plans.test.ts`, `tests/web/plans.test.ts`, `tests/e2e/plans.spec.ts`, `tests/e2e/plans-world.ts`, `tests/e2e/visual/plans.spec.ts`
- `docs/plans.md`, this file, `docs/visual/plans.md` and its `docs/visual/plans-*.png`

## 2. Revert the hooks

| File | Hook | Revert to |
|---|---|---|
| `src/server/app.ts` | imports `installPlans` and the `PlanService` type; `AppOptions.plans`; calls `installPlans(app, apiContext, options.plans)` after `installTeam` | drop the imports, the option and the call |
| `src/core/settings.ts` | `experimental.plans` in `KnownSettings`, `EDITABLE_SETTINGS`, `SETTING_DEFAULTS` and `readKnownSettings` | remove the key in all four places |
| `src/server/api/settings.ts` | imports `plansSwitchChanged`; calls it when `PUT /api/settings` changes `experimental.plans` | drop both |
| `src/hook/sb-mcp.ts` | imports `registerPlanToolsIfOn`; `main` calls it before `connect` | drop the import and the call |
| `src/core/api.ts` | imports `PlanChanged`; re-exports the plan types; `HubEvents.planChanged` and its entry in `HUB_EVENT_NAMES` | remove all four |
| `src/core/peer-wire.ts` | imports `Plan`; `peerPlan`; `planChanged` in `PEER_HUB_EVENTS` and its `peerHubEvent` case; `plan` / `plans` / `plan-item` in `PeerAnswerKind`, `peerAnswerKind` and `mapPeerAnswer` | remove them |
| `src/server/peers/service.ts` | imports `peerPlan` and `Plan`; `plans` in `PEER_LISTS`; the Plans entries of `PEER_API_ALLOW`; the `planChanged` branch of the peer stream; `remotePlans()`; the plans refresh after a forwarded plan call | remove them |
| `src/server/db/repos/peer-snapshots.ts` | `plans` in `PeerSnapshotKind` | remove it |
| `src/server/devices/local-only.ts` | the Plans entries of `DEVICE_ALLOWED` and "(D99) plans" in the file comment | remove them |
| `src/server/inbox/system-items.ts` | `planNotice` (the "Plan ready" and second-conflict Inbox items) | remove the method |
| `src/server/todos/run.ts` | `TodoRunOverrides` and the `overrides` parameter of `runTodo` (a plan item's branch, cut, brief and answers) | remove the type and the parameter; the branch, `from`, `task` and `answers` back to D76's (the source session's) |
| `src/core/tutorial.ts` | `plans` in `TourRoute`; the `plans` entry of `WHATS_NEW` (1.18.0) | remove both (`V1_18` stays while Team ships in it) |
| `src/web/router.tsx` | `plans` and `plan` in `ViewName`; `plans` in the simple-view `Route` union and `SIMPLE_VIEWS`; the `{ view: 'plan', id }` route, its `parseRoute` line and its `routePath` case; the `/plans` row of the header table | remove them |
| `src/web/shell/Shell.tsx` | imports `PlansPage` and `PlanPage`; `case 'plans'` and `case 'plan'` of `View` | drop the imports and the cases |
| `src/web/shell/AppBar.tsx` | `case 'plans'` / `case 'plan'` of `pageTitle` | drop them |
| `src/web/shell/Sidebar.tsx` | imports `PlansNavItem`; `<PlansNavItem />` at the end of the nav (renders nothing while Plans is off) | drop the import and the element |
| `src/web/views/session/RightPanel.tsx` | imports `SessionPlanTab`; `<SessionPlanTab sessionId={…} />` at the top of the panel (nothing while off or without a plan) | drop the import and the element |
| `src/web/tutorial/TourHost.tsx` | imports `PLANS_TOUR_ID`, `plansOn`, `withoutPlansTour`; the pending tours without the Plans tour while Plans is off | `const tours = pendingTours(state);` |
| `src/web/views/settings/TutorialSection.tsx` | imports `usePlans`, `withoutPlansTour`; `whatsNew` without the Plans tour while off | `state.data?.whatsNew` in its two places |
| `src/web/views/settings/ExperimentalSection.tsx` | the shared Experimental section: imports `PlansSwitchRow` and renders it | drop the import and the element; delete the file when no other experimental feature (Team) is left |
| `src/web/views/SettingsView.tsx` | imports `ExperimentalSection`; its `case 'experimental'` (shared with Team, D100) | keep while Team is there; otherwise remove both |
| `src/web/views/settings/model.ts` | the `experimental` section (shared with Team, D100) | keep while Team is there; otherwise remove the entry |

Tests that name Plans' additions (revert with the code):

- `tests/server/api/settings.test.ts`: the `'experimental.plans': false` line of the fresh-install answer.
- `tests/e2e/visual/settings.spec.ts` / `tests/e2e/settings.spec.ts`: nothing Plans-specific beyond the Experimental section's second row (its screenshot changes back).
- `tests/server/tutorial/tutorial.test.ts`: `'D99'` in the What's-new decisions.
- `tests/e2e/shell.spec.ts`: the `/api/plans/state` branch of the shell's API calls.

Docs: the *Plans (D99)* section of `docs/handoff/contracts/local-api.md`, D99 in `docs/decisions.md` (mark it removed rather than deleting the record), the *D99* section of `.loop/questions.md`.

## 3. Delete the data

`<dataDir>/plans.db` (and `plans.db-wal` / `plans.db-shm` if present). Nothing of Plans' own state is in `switchboard.db`. Three kinds of rows there mention it, all harmless to a build without Plans:

- the `experimental.plans` setting (an unknown settings key is never read): `DELETE FROM settings WHERE key = 'experimental.plans'`;
- the Inbox items it raised ("Plan ready", a second conflict; dismiss-only): `DELETE FROM system_items WHERE source = 'plans'`;
- a paired machine's last known plans: `DELETE FROM peer_snapshots WHERE kind = 'plans'`.

Plan items are ordinary todos and their runs ordinary sessions (D76 todo runs) throughout: the todos, the run sessions, their worktrees, branches, pull requests and review cards are untouched by removal. Sessions that were working on an item keep their branch; nothing merges or starts any more.

## Checked

The procedure was applied once to a throw-away copy (a scratch `git worktree` of the Plans branch): every step above, then `npm run typecheck`; the result is recorded in `.loop/questions.md` → *D99* (`VERIFIED D99-removal`).
