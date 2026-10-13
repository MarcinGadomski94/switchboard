# Removing Team (D100)

Team is experimental and built to be removed cleanly (`docs/team.md`, decision D100). Its code lives in its own folders; the rest of Switchboard knows it only through the small hooks listed here, each marked in the code with the comment **`Team (D100) hook`** (`grep -rn "Team (D100) hook" src` lists them all). `tests/server/team/removal.test.ts` fails when a file carries the marker and is not listed below.

## 1. Delete Team's folders and files

- `src/server/team/` (service, `team.db`, routes, hooks, suggestions, sync, T2's `access/`)
- `src/core/team.ts`, `src/core/team-templates.ts`, `src/core/team-budget.ts`, `src/core/team-sync.ts`, `src/core/team-tools.ts`
- `src/web/team/` (the sidebar filter and the sidebar's Team entries (D101: the nav grid's Team cell renders through the shell's `NavCell`, with the `team` icon of `src/web/shell/nav-icon-glyphs.ts` and `teamBadge` of `nav-grid.ts`, which may stay), Settings → Experimental's Team row (`TeamSwitchRow.tsx`), the Team page, its dialogs and styles, T2's Access tab in `src/web/team/access/`)
- `src/core/team-access.ts`, `src/core/team-access-catalog.ts`, `src/core/team-access-tools.ts` (T2: access requests)
- `src/hook/sb-access-mcp.ts` (T2: the access MCP launcher) and `src/web/team-access-dev.html` (T2: the Access tab's dev mount)
- `tests/server/team/`, `tests/web/team.test.ts`, `tests/e2e/team-*.spec.ts`, `tests/e2e/team-world.ts`, `tests/e2e/visual/team.spec.ts`
- `docs/team.md`, this file, `docs/visual/team.md` and its `docs/visual/team-*.png`

## 2. Revert the hooks

| File | Hook | Revert to |
|---|---|---|
| `src/server/app.ts` | imports `installTeam`; builds `apiContext` once and calls `installTeam(app, apiContext)` after `registerApiRoutes`; T2: imports `withTeamAccessServers` and wraps the `agentMcpLaunch(…)` of `useAgentMcp` with it | drop the imports, the call and the wrap (the `apiContext` variable may stay, or inline it back) |
| `src/core/settings.ts` | `experimental.team` in `KnownSettings`, `EDITABLE_SETTINGS`, `SETTING_DEFAULTS` and `readKnownSettings` | remove the key in all four places |
| `src/server/api/settings.ts` | imports `teamSwitchChanged`; calls it when `PUT /api/settings` changes `experimental.team` | drop both |
| `src/server/supervisor/supervisor.ts` | imports `withTeamCharter` and `teamAccessEnv`; wraps `standingInstructionFor(…)` at the spawn (`#spawn`) and in `#reloadInstructionNow`; T2: `teamAccess` at the spawn (its `env` spread into the spawn's `env`, its `mask` applied in `onLine` and `onNotice`) | `await standingInstructionFor(this.#store.settings)` in both places; drop `teamAccess` (the spawn's `env` back to `{ ...childEnv(this.#env), ...profileEnv }`, `onLine` / `onNotice` without the mask) |
| `src/server/todos/agent-mcp.ts` | T2: `AgentMcpLaunch.extraServers` (`AgentMcpExtraServer`), added by `claudeMcpConfig`, `codexMcpArgs` and `opencodeMcpEntries` | drop the field and the type; `claudeMcpConfig` / `codexMcpArgs` back to the `switchboard` server only; `opencodeMcpEntries` back to `opencodeMcpEntry` |
| `src/server/cli/opencode/bridge.ts` | T2: `configContent` spreads `opencodeMcpEntries(agentMcp)` | `[agentMcp.name]: opencodeMcpEntry(agentMcp)` |
| `src/server/sessions/wire.ts` | imports `withTeamCharter`; wraps `standingInstructionFor(store.settings)` in `instructionState` | `await standingInstructionFor(store.settings)` |
| `src/server/inbox/wire.ts` | imports `labelInboxItems`; `listInbox` returns `labelInboxItems(store, items)` | `return items;` |
| `src/server/peers/service.ts` | imports `labelInboxItems`; `remoteInbox()` returns `labelInboxItems(this.#store, out)`; the Team entries of `PEER_API_ALLOW` (T2: the access metadata reads) | `return out;`; remove the entries under the Team comment |
| `src/server/api/search.ts` | imports `labelSearchAnswer`; wraps the answer of `context.search.search(…)` | return `context.search.search(…)` directly |
| `src/server/devices/local-only.ts` | the Team entries of `DEVICE_ALLOWED` and `DEVICE_REFUSED` (T2: the Access tab's reads; setup / test / revoke / expiry refused) | remove them |
| `src/hook/sb-mcp.ts` | imports `registerTeamToolsIfMember`; `main` registers the Team tools before `connect` | `await createTodoServer(loopbackApi(port, sessionId, token)).connect(new StdioServerTransport());` |
| `src/core/api.ts` | imports `TeamChanged`; `HubEvents.teamChanged` and its entry in `HUB_EVENT_NAMES`; `InboxItem.teamRole` | remove all four |
| `src/core/search.ts` | `SearchResult.teamRole` | remove it |
| `src/web/shell/Sidebar.tsx` | imports `useTeamHiddenSessions` / `withoutTeamMembers` and `TeamNavItem` / `TeamSidebarEntry`; `teamHidden`; the one filter on `sessionList`; `<TeamNavItem />` at the end of the nav (D101: the nav grid, so it is the grid's last-but-Plans cell) and `<TeamSidebarEntry />` above `<SidebarSessions>` (both render nothing while Team is off) | `const sessionList = openSessions(sessions.data ?? []);`; drop the two elements |
| `src/web/router.tsx` | `team` in `ViewName`, the simple-view `Route` union and `SIMPLE_VIEWS`; the `/team` row of the header table | remove `team` in the three places and the row |
| `src/web/shell/Shell.tsx` | imports `TeamPage`; `case 'team'` of `View` | drop both |
| `src/web/shell/AppBar.tsx` | `case 'team'` of `pageTitle` | drop it |
| `src/core/tutorial.ts` | `team` in `TourRoute`; `TEAM_OFF`, `TEAM_NO_MEMBER`; the `team` entry of `WHATS_NEW` | remove them |
| `src/web/views/settings/model.ts` | the `experimental` section (shared with Plans, D99) | remove the entry, unless another experimental feature (Plans) is still there |
| `src/web/views/SettingsView.tsx` | imports `ExperimentalSection`; its `case 'experimental'` (shared with Plans, D99) | remove both, unless another experimental feature (Plans) is still there |
| `src/web/views/settings/ExperimentalSection.tsx` | the shared Experimental section: imports `TeamSwitchRow` and renders it | drop the import and the element; delete the file when no other experimental feature (Plans) is left |

Outside `src/` (not markers): `vite.config.ts` builds T2's dev mount as a second entry (`rollupOptions.input.teamAccessDev`: remove it; the `main` entry may stay or the whole `rollupOptions` go); `tools/fake-claude` has a generic `[fake:echo-env NAME]` token (T2's tests use it; it may stay).

Tests that name Team's additions (revert with the code):

- `tests/server/api/settings.test.ts`: the `'experimental.team': false` line of the fresh-install answer.
- `tests/web/updates.test.ts`: the last six sections (back to the last five, without `experimental`).
- `tests/e2e/settings.spec.ts`: the `'Experimental'` nav label.
- `tests/server/tutorial/tutorial.test.ts`: `'D100'` at the end of the What's-new decisions.
- `tests/e2e/shell.spec.ts`: the `/api/team/state` branch of the shell's API calls.
- `tests/helpers/server-process.ts`: T2's `SWITCHBOARD_TEST_SECRET_STORE: 'memory'` default (harmless without Team; may stay).

Docs: the *Team (D100)* section of `docs/handoff/contracts/local-api.md`, D100 in `docs/decisions.md` (mark it removed rather than deleting the record), the *D100* section of `.loop/questions.md`.

## 3. Delete the data

Before deleting the code, **Revoke** every member's access (or remove the members): that removes their values from the OS keychain. Otherwise delete the keychain items named `Switchboard Team` by hand (Keychain Access on macOS, Credential Manager entries `Switchboard Team:…` on Windows, `secret-tool clear service "Switchboard Team" account …` on Linux).

`<dataDir>/team.db` (and `team.db-wal` / `team.db-shm` if present). Nothing of Team is in `switchboard.db`: the only row Team ever wrote there is the `experimental.team` setting, which an older or Team-less build ignores (an unknown settings key is never read); delete it with `DELETE FROM settings WHERE key = 'experimental.team'` if you want it gone.

Member sessions are ordinary sessions throughout: their records, sidebar places, todos, loops and history are untouched by removal. A member process started while Team was on keeps the charter text until its next start (Settings → Apply to open sessions restarts it at once).

## Checked

The procedure was applied once to a throw-away copy (a scratch `git worktree` of the Team branch): every step above, then `npm run typecheck`; the result is recorded in `.loop/questions.md` → *D100* (`VERIFIED D100-removal`).
