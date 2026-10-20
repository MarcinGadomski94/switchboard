# Removing Plans (D99)

Plans is experimental and built to be removed cleanly (`docs/plans.md`, decision D99). Its code lives in its own folders and files; the rest of Switchboard knows it only through the small hooks listed here, each marked in the code with the comment **`Plans (D99) hook`** (`grep -rn "Plans (D99) hook" src` lists them all). `tests/server/plans/removal.test.ts` fails when a file carries the marker and is not listed below, or a listed file no longer carries it.

## 1. Delete Plans' folders and files

- `src/server/plans/` (service and scheduler, `plans.db` and its migrations, repository, routes, git / gh adapter, environment, hooks, `install.ts`)
- `src/core/plans.ts` (shapes, graph rules, texts, the MCP tool definitions)
- `src/core/plans-jira.ts` (the Jira lane's shapes and rules; its server code is `src/server/plans/jira/`, its UI `src/web/plans/jira/`, both inside the folders above)
- `src/core/plans-jira-context.ts` (D118: the Jira context of a plan's agents and the `plan_jira_context` tool)
- `src/web/plans-jira-dev.html` (the Jira import dialog's dev mount)
- `src/hook/sb-plan-tools.ts` (the plan tools of the `switchboard` MCP helper)
- `src/web/plans/` (Settings → Experimental's Plans row, `PlansSwitchRow.tsx`; the Plans list and plan page, their dialogs, model, store and styles, the nav grid's cell (D101: through the shell's `NavCell`; the `plans` icon in `src/web/shell/nav-icon-glyphs.ts` and `plansBadge` in `nav-grid.ts` may stay) and the session's Plan tab, the Jira lane's `jira/` folder)
- `tests/server/plans/`, `tests/core/plans.test.ts`, `tests/e2e/plans-switch.spec.ts`, `tests/core/plans-jira.test.ts`, `tests/helpers/fake-jira.ts`, `tests/e2e/plans-jira.spec.ts`, `tests/web/plans.test.ts`, `tests/e2e/plans.spec.ts`, `tests/e2e/plans-world.ts`, `tests/e2e/visual/plans.spec.ts`
- `docs/plans.md`, `docs/plans-ui.md`, this file, `docs/visual/plans.md` and its `docs/visual/plans-*.png`

## 2. Revert the hooks

| File | Hook | Revert to |
|---|---|---|
| `src/server/app.ts` | imports `installPlans` and the `PlanService` type; `AppOptions.plans`; calls `installPlans(app, apiContext, options.plans)` after `installTeam` | drop the imports, the option and the call |
| `src/core/settings.ts` | `experimental.plans` in `KnownSettings`, `EDITABLE_SETTINGS`, `SETTING_DEFAULTS` and `readKnownSettings` | remove the key in all four places |
| `src/server/api/settings.ts` | imports `plansSwitchChanged`; calls it when `PUT /api/settings` changes `experimental.plans` | drop both |
| `src/hook/sb-mcp.ts` | `main` probes the feature tools (`FeatureTools`, `sb-feature-tools.ts`) before `connect` and keeps them in step | nothing once `sb-feature-tools.ts` has no plans set (the hook comment goes) |
| `src/hook/sb-feature-tools.ts` | the `plans` entry of `FEATURE_TOOL_SETS` (imports `PLAN_TOOLS`, `PLAN_PROPOSE_TOOL`, `PLAN_JIRA_CONTEXT_TOOL`, `registerPlanTools`) | drop the entry and the four imports |
| `src/core/api.ts` | imports `PlanChanged`; re-exports the plan types; `HubEvents.planChanged` and its entry in `HUB_EVENT_NAMES` | remove all four |
| `src/core/peer-wire.ts` | imports `Plan`; `peerPlan`; `planChanged` in `PEER_HUB_EVENTS` and its `peerHubEvent` case; `plan` / `plans` / `plan-item` in `PeerAnswerKind`, `peerAnswerKind` and `mapPeerAnswer`; the Jira lane's two lines in `peerAnswerKind` (the import answers `plan-item`, a plan's Jira state and proposals `none`); D102: `peerRoute` and its use in `peerInboxItem` (a "Ready to merge" item's plan route) | remove them (`InboxItem.route` may stay: generic) |
| `src/server/peers/service.ts` | imports `peerPlan` and `Plan`; `plans` in `PEER_LISTS`; the Plans entries of `PEER_API_ALLOW` (with the Jira lane's preview, import, plan Jira state, refresh and proposed order; D102: an item's merge / open-pr / send-back); the `planChanged` branch of the peer stream; `remotePlans()`; the plans refresh after a forwarded plan call; in `refreshList`, a 404 of the plans list read as no plans | remove them (`refreshList` back to `answer.body` throughout) |
| `src/server/db/repos/peer-snapshots.ts` | `plans` in `PeerSnapshotKind` | remove it |
| `src/server/devices/local-only.ts` | the Plans entries of `DEVICE_ALLOWED` (with the Jira lane's preview, import, plan Jira state, refresh and proposed order) and of `DEVICE_REFUSED` (`/api/integrations/jira`), and "(D99) plans" in the file comment | remove them |
| `src/server/api/sessions.ts` | imports `plansFollowContinuation`; `POST /api/sessions/{id}/fresh`'s `onStarted` calls it after the worktrees are assigned (D83: a continued session's plans and the items it ran follow it) | drop the import and the call |
| `src/server/inbox/system-items.ts` | `planNotice` (the "Plan ready" / "Plan done", second-conflict and "Confirm done" Inbox items); D102: imports `plansInboxMerge`; `PLAN_READY_TO_MERGE` / `PLAN_MERGE` / `OPEN_PLAN` / `PLAN_READY_TO_MERGE_ACTIONS`, `planMergeNotice`, `closePlanMergeNotices` and the `plan-merge` / `open-plan` branch of `#perform` (the "Ready to merge" item); D115 follow-ups: imports `plansInboxAskRepos`; `PLAN_PICK_REPOS` / `PLAN_ASK_REPOS` / `PLAN_PICK_REPOS_ACTIONS`, `planPickReposNotice`, `closePlanPickReposNotices`, `#closePickRepos` and the `plan-ask-repos` branch of `#perform` (the "Pick repositories" item); D120: `PLAN_STOPPED` / `PLAN_STOPPED_ACTIONS`, `planStoppedNotice`, `closePlanStoppedNotices` (the "Stopped" item) | remove them (the `refused` error code and the closed-by-the-action check in `act` may stay) |
| `src/server/insights/service.ts` | D108: imports `plansInsightOutcomes`; Insights reads the plan items' outcomes through it (`plans: null` while off) | drop the import and pass `plans: null` (the Outcomes section then shows no Plans part, as while Plans is off) |
| `src/server/team/service.ts` | D100 follow-up 2026-10-16: imports `plansItemsOfTodos`; `#currentItem` names a member's current todo by its plan item's key and title (the sidebar's member rows) | drop the import; `#currentItem` returns `{ title: todo.title, key: null }` (Team itself may be gone already: then nothing to do) |
| `src/server/todos/run.ts` | `TodoRunOverrides` and the `overrides` parameter of `runTodo` (a plan item's branch, cut, brief and answers; `from: null` = D76's own cut, a plan without a target branch) | remove the type and the parameter; the branch, `from`, `task` and `answers` back to D76's (the source session's) |
| `src/core/tutorial.ts` | `plans` in `TourRoute`; the `plans` entry of `WHATS_NEW` (1.17.0) and the `plans-any` entry (1.22.0, the D99 follow-up of 2026-10-15) | remove them |
| `src/web/router.tsx` | `plans` and `plan` in `ViewName`; `plans` in the simple-view `Route` union and `SIMPLE_VIEWS`; the `{ view: 'plan', id }` route, its `parseRoute` line and its `routePath` case; the `/plans` row of the header table | remove them |
| `src/web/shell/Shell.tsx` | imports `PlansPage` and `PlanPage`; `case 'plans'` and `case 'plan'` of `View` | drop the imports and the cases |
| `src/web/shell/AppBar.tsx` | `case 'plans'` / `case 'plan'` of `pageTitle` | drop them |
| `src/web/shell/Sidebar.tsx` | imports `PlansNavItem`; `<PlansNavItem />` at the end of the nav (D101: the nav grid's last cell; renders nothing while Plans is off) | drop the import and the element |
| `src/web/views/session/RightPanel.tsx` | imports `SessionPlanTab`; `<SessionPlanTab sessionId={…} />` at the top of the panel (nothing while off) | drop the import and the element |
| `src/web/tutorial/TourHost.tsx` | imports `PLANS_TOUR_IDS`, `plansOn`, `withoutPlansTour`; the pending tours without the Plans tours while Plans is off | `const tours = pendingTours(state);` |
| `src/web/views/settings/TutorialSection.tsx` | imports `usePlans`, `withoutPlansTour`; `whatsNew` without the Plans tour while off | `state.data?.whatsNew` in its two places |
| `src/web/views/settings/ExperimentalSection.tsx` | the shared Experimental section: imports `PlansSwitchRow` and renders it | drop the import and the element; delete the file when no other experimental feature (Team) is left |
| `src/web/views/SettingsView.tsx` | imports `ExperimentalSection`; its `case 'experimental'` (shared with Team, D100) | keep while Team is there; otherwise remove both |
| `src/web/views/settings/model.ts` | the `experimental` section (shared with Team, D100) | keep while Team is there; otherwise remove the entry |

D109 (not markers: the shared code never imports Plans): Plans registers itself into the shared PR watcher (`registerCiMergeOwner` in `src/server/plans/service.ts`, the `prs` read and `ciSendsFailures` / `prOpened` in `install.ts` and `environment.ts`) and its Jira lane registers the todo import's Jira source (`registerJiraIssueSource` in `src/server/plans/jira/install.ts`). They go with `src/server/plans/`; without them the watcher raises its own "ready to merge" for every session and the Import issues dialog says Jira needs Plans.

Not markers (Plans' D102 Merge step, shared code): `src/server/worktrees/branch-merge.ts` (`BranchMergeGit`, the safe local merge and Open PR) may stay or go; the `plan-ready-to-merge`, `plan-confirm` and (D115 follow-ups) `plan-pick-repos` and (D120) `plan-stopped` and (D121) `plan-reopened` labels in `SYSTEM_ITEM_LABELS` (`src/server/inbox/wire.ts`) and the web's `openRoute` / `OPEN_PLAN` (`src/web/views/inbox.ts`) and the Needs-you `merge` shape (`src/web/team/`) are harmless without Plans.

Outside `src/` (not markers): `vite.config.ts` builds the Jira dialog's dev mount as an entry (`rollupOptions.input.plansJiraDev`: remove it); `tests/helpers/server-process.ts` drops `ATL_*` from test servers' environment (the Jira lane's guard; harmless without Plans, may stay).

Tests that name Plans' additions (revert with the code):

- `tests/server/api/settings.test.ts`: the `'experimental.plans': false` line of the fresh-install answer.
- The Experimental section's Plans row has no screenshot of its own.
- `tests/server/tutorial/tutorial.test.ts`: `'D99'` in the What's-new decisions.
- `tests/e2e/shell.spec.ts`: the `/api/plans/state` branch of the shell's API calls.
- `tests/e2e/tutorial.spec.ts`: the `WHATS_NEW` filter without `plans` / `plans-any` and the `status['plans']` / `status['plans-any']` lines.

Docs: the *Plans (D99)* and *Plans · Jira (D99)* sections of `docs/handoff/contracts/local-api.md`, *Jira credentials (D99)* in `docs/security.md`, the Jira paragraphs of `PRIVACY.md`, the *D99-Jira* section of `.loop/questions.md`, D99 in `docs/decisions.md` (mark it removed rather than deleting the record), the *D99* and *D99-UI* sections of `.loop/questions.md`.

## 3. Delete the data

If Jira was connected in Settings → Integrations → Jira, remove it there first (or delete the keychain item named `Switchboard Jira` by hand: Keychain Access on macOS, Credential Manager on Windows, `secret-tool clear service "Switchboard Jira" account default` on Linux). The Jira lane's tables (`plan_jira*`) are inside `plans.db` and go with it.

`<dataDir>/plans.db` (and `plans.db-wal` / `plans.db-shm` if present). Nothing of Plans' own state is in `switchboard.db`. Three kinds of rows there mention it, all harmless to a build without Plans:

- the `experimental.plans` setting (an unknown settings key is never read): `DELETE FROM settings WHERE key = 'experimental.plans'`;
- the Inbox items it raised ("Plan ready", a second conflict, D102's "Ready to merge"): `DELETE FROM system_items WHERE source = 'plans'`;
- a paired machine's last known plans: `DELETE FROM peer_snapshots WHERE kind = 'plans'`.

Plan items are ordinary todos and their runs ordinary sessions (D76 todo runs) throughout: the todos, the run sessions, their worktrees, branches, pull requests are untouched by removal (D102: there are no review cards any more; an item waiting for your merge keeps its branch for you to merge by hand). Sessions that were working on an item keep their branch; nothing merges or starts any more.

## Checked

The procedure was applied once to a throw-away copy (a scratch `git worktree` of the Plans branch): every step above, then `npm run typecheck`; the result is recorded in `.loop/questions.md` → *D99* (`VERIFIED D99-removal`).
