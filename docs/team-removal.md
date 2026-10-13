# Removing Team (D100)

Team is experimental and built to be removed cleanly (`docs/team.md`, decision D100). Its code lives in its own folders; the rest of Switchboard knows it only through the small hooks listed here, each marked in the code with the comment **`Team (D100) hook`** (`grep -rn "Team (D100) hook" src` lists them all). `tests/server/team/removal.test.ts` fails when a file carries the marker and is not listed below.

## 1. Delete Team's folders and files

- `src/server/team/` (service, `team.db`, routes, hooks, suggestions, sync)
- `src/core/team.ts`, `src/core/team-templates.ts`, `src/core/team-budget.ts`, `src/core/team-sync.ts`, `src/core/team-tools.ts`
- `src/web/team/` (the sidebar filter and the sidebar's Team entries, Settings → Experimental, the Team page, its dialogs and styles)
- `tests/server/team/`, `tests/web/team.test.ts`, `tests/e2e/team-*.spec.ts`, `tests/e2e/team-world.ts`, `tests/e2e/visual/team.spec.ts`
- `docs/team.md`, this file, `docs/visual/team.md` and its `docs/visual/team-*.png`

## 2. Revert the hooks

| File | Hook | Revert to |
|---|---|---|
| `src/server/app.ts` | imports `installTeam`; builds `apiContext` once and calls `installTeam(app, apiContext)` after `registerApiRoutes` | drop the import and the call (the `apiContext` variable may stay, or inline it back) |
| `src/core/settings.ts` | `experimental.team` in `KnownSettings`, `EDITABLE_SETTINGS`, `SETTING_DEFAULTS` and `readKnownSettings` | remove the key in all four places |
| `src/server/api/settings.ts` | imports `teamSwitchChanged`; calls it when `PUT /api/settings` changes `experimental.team` | drop both |
| `src/server/supervisor/supervisor.ts` | imports `withTeamCharter`; wraps `standingInstructionFor(…)` at the spawn (`#spawn`) and in `#reloadInstructionNow` | `await standingInstructionFor(this.#store.settings)` in both places |
| `src/server/sessions/wire.ts` | imports `withTeamCharter`; wraps `standingInstructionFor(store.settings)` in `instructionState` | `await standingInstructionFor(store.settings)` |
| `src/server/inbox/wire.ts` | imports `labelInboxItems`; `listInbox` returns `labelInboxItems(store, items)` | `return items;` |
| `src/server/peers/service.ts` | imports `labelInboxItems`; `remoteInbox()` returns `labelInboxItems(this.#store, out)`; the Team entries of `PEER_API_ALLOW` | `return out;`; remove the entries under the Team comment |
| `src/server/api/search.ts` | imports `labelSearchAnswer`; wraps the answer of `context.search.search(…)` | return `context.search.search(…)` directly |
| `src/server/reviews/service.ts` | imports `teamReviewGate`; the gate check in `#act` before the action runs | drop the import and the three lines |
| `src/server/devices/local-only.ts` | the Team entries of `DEVICE_ALLOWED` and `DEVICE_REFUSED` | remove them |
| `src/hook/sb-mcp.ts` | imports `registerTeamToolsIfMember`; `main` registers the Team tools before `connect` | `await createTodoServer(loopbackApi(port, sessionId, token)).connect(new StdioServerTransport());` |
| `src/core/api.ts` | imports `TeamChanged`; `HubEvents.teamChanged` and its entry in `HUB_EVENT_NAMES`; `InboxItem.teamRole` | remove all four |
| `src/core/search.ts` | `SearchResult.teamRole` | remove it |
| `src/web/shell/Sidebar.tsx` | imports `useTeamHiddenSessions` / `withoutTeamMembers` and `TeamNavItem` / `TeamSidebarEntry`; `teamHidden`; the one filter on `sessionList`; `<TeamNavItem />` at the end of the nav and `<TeamSidebarEntry />` above `<SidebarSessions>` (both render nothing while Team is off) | `const sessionList = openSessions(sessions.data ?? []);`; drop the two elements |
| `src/web/router.tsx` | `team` in `ViewName`, the simple-view `Route` union and `SIMPLE_VIEWS`; the `/team` row of the header table | remove `team` in the three places and the row |
| `src/web/shell/Shell.tsx` | imports `TeamPage`; `case 'team'` of `View` | drop both |
| `src/web/shell/AppBar.tsx` | `case 'team'` of `pageTitle` | drop it |
| `src/core/tutorial.ts` | `team` in `TourRoute`; `V1_18`, `TEAM_OFF`, `TEAM_NO_MEMBER`; the `team` entry of `WHATS_NEW` | remove them (and `V1_18` if nothing else ships in it) |
| `src/web/views/settings/model.ts` | the `experimental` section | remove the entry |
| `src/web/views/SettingsView.tsx` | imports `ExperimentalSection`; its `case 'experimental'` | remove both |

Tests that name Team's additions (revert with the code):

- `tests/server/api/settings.test.ts`: the `'experimental.team': false` line of the fresh-install answer.
- `tests/web/updates.test.ts`: the last six sections (back to the last five, without `experimental`).
- `tests/e2e/settings.spec.ts`: the `'Experimental'` nav label.
- `tests/server/tutorial/tutorial.test.ts`: `'D100'` at the end of the What's-new decisions.
- `tests/e2e/shell.spec.ts`: the `/api/team/state` branch of the shell's API calls.

Docs: the *Team (D100)* section of `docs/handoff/contracts/local-api.md`, D100 in `docs/decisions.md` (mark it removed rather than deleting the record), the *D100* section of `.loop/questions.md`.

## 3. Delete the data

`<dataDir>/team.db` (and `team.db-wal` / `team.db-shm` if present). Nothing of Team is in `switchboard.db`: the only row Team ever wrote there is the `experimental.team` setting, which an older or Team-less build ignores (an unknown settings key is never read); delete it with `DELETE FROM settings WHERE key = 'experimental.team'` if you want it gone.

Member sessions are ordinary sessions throughout: their records, sidebar places, todos, loops and history are untouched by removal. A member process started while Team was on keeps the charter text until its next start (Settings → Apply to open sessions restarts it at once).

## Checked

The procedure was applied once to a throw-away copy (a scratch `git worktree` of the Team branch): every step above, then `npm run typecheck`; the result is recorded in `.loop/questions.md` → *D100* (`VERIFIED D100-removal`).
