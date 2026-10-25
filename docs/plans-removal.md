# Plans graduated (D132)

Plans (`docs/plans.md`, decision D99) shipped as an experimental feature behind **Settings → Experimental → Plans**, off by default and built as a switchable hook with an off-state so it could be removed cleanly. In **2.0** it graduated to general release together with Team and Project memory (D132; the developer: "in order to do that we would need to pull out or experimental functionalities to general release").

## What changed in 2.0

- **The off-switch is gone.** There is no `experimental.plans` setting any more (`PUT /api/settings` refuses the key with 422) and Settings has no Experimental section. The Jira connection that sat under the Plans row moved to its own section, **Settings → Jira** (`/settings/experimental` opens it).
- **Always on.** `plans.db` is opened (and migrated) at start; the scheduler and its timers run; no route answers `404 plans-off` any more. Only a `plans.db` that cannot be opened makes the plan routes (and the Jira lane's) answer `503 plans-unavailable`, as before.
- **MCP tools.** The `plan_*` tools register through the same probe as before (`GET /agent/v1/plans`, `src/hook/sb-feature-tools.ts`), which now answers 200 for every session with the agent token; each tool still acts only on the plans whose source is that session.
- **Existing installs.** Whatever the stored switch said, Plans is on after the start; `forgetGraduatedSwitches` (`src/server/settings/graduated.ts`) deletes the stored `experimental.plans` row once (nothing reads it either way). With no plans nothing changes: nothing runs, no Inbox item appears, no session is touched. A plan a 1.x build paused when the switch went off keeps its "Plans was switched off" reason until you resume it.
- **Paired machines and phones.** The peer and device allow-lists are unchanged (`src/server/peers/service.ts`, `src/server/devices/local-only.ts`). A paired machine still on 1.x with Plans off answers `404 plans-off`; it is read as "no plans there", as before.

## How it is wired

Plans' code lives in its own folders and files: `src/server/plans/` (service, scheduler, `plans.db` and its migrations, routes, the Jira lane in `jira/`), `src/core/plans.ts`, `src/core/plans-jira.ts`, `src/core/plans-jira-context.ts`, `src/core/plan-run-folder.ts`, `src/hook/sb-plan-tools.ts` and `src/web/plans/`. The rest of Switchboard knows it only through the hooks below, each marked in the code with the comment **`Plans (D99) hook`** (`grep -rn "Plans (D99) hook" src`). `tests/server/plans/removal.test.ts` fails when a file carries the marker and is not listed here, or a listed file no longer carries it.

| File | Hook |
|---|---|
| `src/server/app.ts` | imports `installPlans` and the `PlanService` type; `AppOptions.plans`; calls `installPlans(app, apiContext, options.plans)` after `installTeam` |
| `src/hook/sb-mcp.ts` | `main` probes the feature tools (`FeatureTools`, `sb-feature-tools.ts`) before `connect` and keeps them in step |
| `src/hook/sb-feature-tools.ts` | the `plans` entry of `FEATURE_TOOL_SETS` (imports `PLAN_TOOLS`, `PLAN_PROPOSE_TOOL`, `PLAN_JIRA_CONTEXT_TOOL`, `registerPlanTools`) |
| `src/core/api.ts` | imports `PlanChanged`; re-exports the plan types; `HubEvents.planChanged` and its entry in `HUB_EVENT_NAMES` |
| `src/core/peer-wire.ts` | imports `Plan`; `peerPlan`; `planChanged` in `PEER_HUB_EVENTS` and its `peerHubEvent` case; `plan` / `plans` / `plan-item` in `PeerAnswerKind`, `peerAnswerKind` and `mapPeerAnswer`; the Jira lane's two lines in `peerAnswerKind` (the import answers `plan-item`, a plan's Jira state and proposals `none`); D102: `peerRoute` and its use in `peerInboxItem` (a "Ready to merge" item's plan route) |
| `src/server/peers/service.ts` | imports `peerPlan` and `Plan`; `plans` in `PEER_LISTS`; the Plans entries of `PEER_API_ALLOW` (with the Jira lane's preview, import, plan Jira state, refresh and proposed order; D102: an item's merge / open-pr / send-back); the `planChanged` branch of the peer stream; `remotePlans()`; the plans refresh after a forwarded plan call; in `refreshList`, a 404 of the plans list read as no plans |
| `src/server/db/repos/peer-snapshots.ts` | `plans` in `PeerSnapshotKind` |
| `src/server/devices/local-only.ts` | the Plans entries of `DEVICE_ALLOWED` (with the Jira lane's preview, import, plan Jira state, refresh and proposed order) and of `DEVICE_REFUSED` (`/api/integrations/jira`), and "(D99) plans" in the file comment |
| `src/server/api/sessions.ts` | imports `plansFollowContinuation`; `POST /api/sessions/{id}/fresh`'s `onStarted` calls it after the worktrees are assigned (D83: a continued session's plans and the items it ran follow it) |
| `src/server/inbox/system-items.ts` | `planNotice` (the "Plan ready" / "Plan done", second-conflict and "Confirm done" Inbox items); D102: imports `plansInboxMerge`; `PLAN_READY_TO_MERGE` / `PLAN_MERGE` / `OPEN_PLAN` / `PLAN_READY_TO_MERGE_ACTIONS`, `planMergeNotice`, `closePlanMergeNotices` and the `plan-merge` / `open-plan` branch of `#perform` (the "Ready to merge" item); D115 follow-ups: imports `plansInboxAskRepos`; `PLAN_PICK_REPOS` / `PLAN_ASK_REPOS` / `PLAN_PICK_REPOS_ACTIONS`, `planPickReposNotice`, `closePlanPickReposNotices`, `#closePickRepos` and the `plan-ask-repos` branch of `#perform` (the "Pick repositories" item); D120: `PLAN_STOPPED` / `PLAN_STOPPED_ACTIONS`, `planStoppedNotice`, `closePlanStoppedNotices` (the "Stopped" item) |
| `src/server/insights/service.ts` | D108: imports `plansInsightOutcomes`; Insights reads the plan items' outcomes through it (`plans: null` while unavailable) |
| `src/server/team/service.ts` | D100 follow-up 2026-10-16: imports `plansItemsOfTodos`; `#currentItem` names a member's current todo by its plan item's key and title (the sidebar's member rows) |
| `src/server/todos/run.ts` | `TodoRunOverrides` and the `overrides` parameter of `runTodo` (a plan item's branch, cut, brief and answers; `from: null` = D76's own cut, a plan without a target branch; D130: `sidebarFolder`, copied into the run's `todoLink`) |
| `src/core/tutorial.ts` | `plans` in `TourRoute`; the `plans` entry of `WHATS_NEW` (1.17.0) and the `plans-any` entry (1.22.0, the D99 follow-up of 2026-10-15) |
| `src/web/router.tsx` | `plans` and `plan` in `ViewName`; `plans` in the simple-view `Route` union and `SIMPLE_VIEWS`; the `{ view: 'plan', id }` route, its `parseRoute` line and its `routePath` case; the `/plans` row of the header table |
| `src/web/shell/Shell.tsx` | imports `PlansPage` and `PlanPage`; `case 'plans'` and `case 'plan'` of `View` |
| `src/web/shell/AppBar.tsx` | `case 'plans'` / `case 'plan'` of `pageTitle` |
| `src/web/shell/Sidebar.tsx` | imports `PlansNavItem`; `<PlansNavItem />` at the end of the nav (D101: the nav grid's last cell; renders nothing while Plans is unavailable) |
| `src/web/views/session/RightPanel.tsx` | imports `SessionPlanTab`; `<SessionPlanTab sessionId={…} />` at the top of the panel (nothing while unavailable) |
| `src/web/tutorial/TourHost.tsx` | imports `PLANS_TOUR_IDS`, `plansOn`, `withoutPlansTour`; the pending tours without the Plans tours while Plans is unavailable |
| `src/web/views/settings/TutorialSection.tsx` | imports `usePlans`, `withoutPlansTour`; `whatsNew` without the Plans tour while unavailable |
| `src/web/views/SettingsView.tsx` | imports `JiraSection`; its `case 'jira'` (D132) |
| `src/web/views/settings/model.ts` | D132: the `jira` section (Settings → Jira; `/settings/experimental` resolves to it) |
| `src/web/views/settings/JiraSection.tsx` | D132: Settings → **Jira**, the Jira lane's connection (it sat under the Plans switch in Settings → Experimental until 2.0) |

Plans also registers itself into the shared PR watcher (D109, `registerCiMergeOwner`) and the todo import's Jira source (`registerJiraIssueSource`); neither is a marker (the shared code never imports Plans).

Removing Plans now would be a new decision; the step-by-step removal procedure of 1.x is in this file's history (before D132).
