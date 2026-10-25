# Team graduated (D132)

Team (`docs/team.md`, decision D100) shipped as an experimental feature behind **Settings → Experimental → Team**, off by default and built as a switchable hook with an off-state so it could be removed cleanly. In **2.0** it graduated to general release together with Plans and Project memory (D132; the developer: "in order to do that we would need to pull out or experimental functionalities to general release").

## What changed in 2.0

- **The off-switch is gone.** There is no `experimental.team` setting any more (`PUT /api/settings` refuses the key with 422) and Settings has no Experimental section.
- **Always on.** `team.db` is opened (and migrated) at start with its first team, and the timers and the sync with paired machines run; no route answers `404 team-off` any more. Only a `team.db` that cannot be opened makes the Team routes answer `503 team-unavailable` (and hides nothing), as before.
- **MCP tools.** The `team_*` tools and `request_access` register through the same probe as before (`GET /agent/v1/team`, `src/hook/sb-feature-tools.ts`): only in a team member's session.
- **Existing installs.** Whatever the stored switch said, Team is on after the start; `forgetGraduatedSwitches` (`src/server/settings/graduated.ts`) deletes the stored `experimental.team` row once. With no member nothing changes: no session leaves the SESSIONS list (only members' sessions do), no charter is added to any instruction, and the sidebar shows no team entry above SESSIONS until a team has a member or a second team exists (the nav grid's Team cell is always there). Someone who had Team on and then off gets their members back on the Team page (their sessions leave SESSIONS again), exactly as switching it on did in 1.x.
- **Paired machines and phones.** The peer and device allow-lists are unchanged. A paired machine still on 1.x with Team off answers `404 team-off`; its members are not shown, as before.

## How it is wired

Team's code lives in its own folders and files: `src/server/team/` (service, `team.db`, routes, hooks, suggestions, sync, `access/`), `src/core/team*.ts`, `src/hook/sb-access-mcp.ts` and `src/web/team/`. The rest of Switchboard knows it only through the hooks below, each marked in the code with the comment **`Team (D100) hook`** (`grep -rn "Team (D100) hook" src`). `tests/server/team/removal.test.ts` fails when a file carries the marker and is not listed here, or a listed file no longer carries it.

| File | Hook |
|---|---|
| `src/server/app.ts` | imports `installTeam`; builds `apiContext` once and calls `installTeam(app, apiContext)` after `registerApiRoutes`; T2: imports `withTeamAccessServers` and wraps the `agentMcpLaunch(…)` of `useAgentMcp` with it |
| `src/server/supervisor/supervisor.ts` | imports `withTeamCharter` and `teamAccessEnv`; wraps `standingInstructionFor(…)` at the spawn (`#spawn`) and in `#reloadInstructionNow`; T2: `teamAccess` at the spawn (its `env` spread into the spawn's `env`, its `mask` applied in `onLine` and `onNotice`) |
| `src/server/todos/agent-mcp.ts` | T2: `AgentMcpLaunch.extraServers` (`AgentMcpExtraServer`), added by `claudeMcpConfig`, `codexMcpArgs` and `opencodeMcpEntries` |
| `src/server/cli/opencode/bridge.ts` | T2: `configContent` spreads `opencodeMcpEntries(agentMcp)` |
| `src/server/api/sessions.ts` | imports `teamSessionModelChanged`; calls it after `supervisor.setModel` in `PUT /api/sessions/:id/model` (a member's saved model follows its header's choice) |
| `src/server/sessions/wire.ts` | imports `withTeamCharter`; wraps `standingInstructionFor(store.settings)` in `instructionState` |
| `src/server/inbox/wire.ts` | imports `labelInboxItems`; `listInbox` returns `labelInboxItems(store, items)` |
| `src/server/peers/service.ts` | imports `labelInboxItems`; `remoteInbox()` returns `labelInboxItems(this.#store, out)`; the Team entries of `PEER_API_ALLOW` (T2: the access metadata reads) |
| `src/server/api/search.ts` | imports `labelSearchAnswer`; wraps the answer of `context.search.search(…)` |
| `src/server/devices/local-only.ts` | the Team entries of `DEVICE_ALLOWED` and `DEVICE_REFUSED` (T2: the Access tab's reads; setup / test / revoke / expiry refused; D100 follow-up 2026-10-16: folding a team in the drawer, `PUT /api/team/teams/{id}/sidebar`) |
| `src/server/plans/hooks.ts` | D100 follow-up 2026-10-16 (the sidebar's member rows): `PlanHooks.itemsOfTodos`, `PlanItemRef` and the seam `plansItemsOfTodos` (Team names a member's current todo by its plan item's key) |
| `src/server/plans/repo.ts` | D100 follow-up 2026-10-16: `PlanRepository.itemsByTodos` (the query behind `itemsOfTodos`) |
| `src/server/plans/service.ts` | D100 follow-up 2026-10-16: `PlanService.itemsOfTodos` and its `itemsOfTodos` entry in `registerPlanHooks` |
| `src/hook/sb-mcp.ts` | `main` probes the feature tools (`FeatureTools`, `sb-feature-tools.ts`) before `connect` and keeps them in step |
| `src/hook/sb-feature-tools.ts` | the `team` entry of `FEATURE_TOOL_SETS` (imports `TEAM_TOOLS`, `registerTeamTools`, `registerAccessTool`) |
| `src/core/api.ts` | imports `TeamChanged`; `HubEvents.teamChanged` and its entry in `HUB_EVENT_NAMES`; `InboxItem.teamRole` |
| `src/core/search.ts` | `SearchResult.teamRole` |
| `src/web/shell/Sidebar.tsx` | imports `useTeamHiddenSessions` / `withoutTeamMembers` and `TeamNavItem` / `TeamSidebarEntry`; `teamHidden`; the one filter on `sessionList`; `<TeamNavItem />` at the end of the nav (D101: the nav grid, so it is the grid's last-but-Plans cell) and `<TeamSidebarEntry />` above `<SidebarSessions>` (both render nothing while Team is unavailable) |
| `src/web/views/SolutionConflictCard.tsx` | imports `useTeamSwitch`; `team` (its `roles`) names a writer that is a member in its name link's tooltip and adds the `conflict-member` line ("… is the Team member …: it is not in the sidebar's SESSIONS. Open it ›") under the card's text (2026-10-14) |
| `src/web/router.tsx` | `team` in `ViewName` and `SIMPLE_VIEWS`; the `{ view: 'team'; teamId? }` member of the `Route` union; the `/team/{teamId}` branch of `parseRoute` and the `case 'team'` of `routePath` (multiple teams, 2026-10-14); the `/team` row of the header table |
| `src/web/shell/Shell.tsx` | imports `TeamPage`; `case 'team'` of `View` |
| `src/web/shell/AppBar.tsx` | `case 'team'` of `pageTitle` |
| `src/core/tutorial.ts` | `team` in `TourRoute`; `TEAM_OFF`, `TEAM_NO_MEMBER`; the `team`, `team-update`, (D105) `better-charters` and (D100 follow-up 2026-10-16) `team-sidebar` and `team-left-column` entries of `WHATS_NEW`; `V1_23` and `V1_24` when nothing else uses them |
| `src/server/sessions/run-place.ts` | D99 / D76 follow-up 2026-10-19: imports `teamOriginalPlace`; a run whose source is a member goes to the folder the member had (`member` of `placeRun`) |
| `src/server/memory/team-link.ts` | Project memory's member scope (D107 follow-up 2026-10-15): imports `teamMemberOf` / `teamMemberList` (and `TeamMemberRef`) from `team/hooks.ts` |

Removing Team now would be a new decision; the step-by-step removal procedure of 1.x is in this file's history (before D132).
