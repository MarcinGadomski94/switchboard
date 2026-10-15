# Removing Project memory (D107)

Project memory is experimental and built to be removed cleanly (`docs/memory.md`, decision D107). Its code lives in its own folders and files; the rest of Switchboard knows it only through the small hooks listed here, each marked in the code with the comment **`Project memory (D107) hook`** (`grep -rn "Project memory (D107) hook" src` lists them all). `tests/server/memory/removal.test.ts` fails when a file carries the marker and is not listed below, or a listed file no longer carries it.

## 1. Delete Project memory's folders and files

- `src/server/memory/` (service, `memory.db` and its migrations, routes, hooks, `install.ts`, the scopes' `reach.ts` and `team-link.ts`)
- `src/core/memory.ts` (shapes, limits, the block, the duplicate check, the MCP tool definitions)
- `src/hook/sb-memory-tools.ts` (the memory tools of the `switchboard` MCP helper)
- `src/web/memory/` (the Memory page, the nav grid's cell, the session panel's line, Settings → Experimental's row, the draft asks' `draft.ts`, its API calls, store and styles)
- `tests/server/memory/`, `tests/core/memory.test.ts`, `tests/e2e/memory.spec.ts`
- `docs/memory.md`, this file

## 2. Revert the hooks

| File | Hook | Revert to |
|---|---|---|
| `src/server/app.ts` | imports `installMemory`; calls `installMemory(app, apiContext)` after `installPlans` | drop the import and the call |
| `src/core/settings.ts` | `experimental.memory` in `KnownSettings`, `EDITABLE_SETTINGS`, `SETTING_DEFAULTS` and `readKnownSettings` | remove the key in all four places |
| `src/server/api/settings.ts` | imports `memorySwitchChanged`; calls it when `PUT /api/settings` changes `experimental.memory` | drop both |
| `src/server/sessions/instruction.ts` | imports `withProjectMemory`; `sessionInstruction` wraps the standing instruction and charter with it (and its `Pick` names `root` / `cwd`) | `return withTeamCharter(store, session.id, await standingInstructionFor(store.settings));` |
| `src/hook/sb-mcp.ts` | imports `registerMemoryToolsIfOn`; `main` calls it before `connect` | drop the import and the call |
| `src/core/api.ts` | imports `MemoryChanged`; `HubEvents.memoryChanged` and its entry in `HUB_EVENT_NAMES` | remove all three |
| `src/server/devices/local-only.ts` | the memory entries of `DEVICE_ALLOWED` (reads, a session's count, the scope options, edit / pin, approve, reject) and of `DEVICE_REFUSED` (add, delete, the cap, the draft asks, the import), and "(D107) project memory" in the file comment | remove them |
| `src/server/peers/service.ts` | the memory entries of `PEER_API_ALLOW` | remove them |
| `src/server/inbox/wire.ts` | `'memory-proposals': 'Memory'` in `SYSTEM_ITEM_LABELS` | remove the line |
| `src/core/tutorial.ts` | `memory` in `TourRoute`; `V1_20` and the `memory` entry of `WHATS_NEW`; the `memory-scopes` entry (1.22.0) | remove them (keep `V1_20` if another 1.20.0 tour uses it) |
| `src/web/router.tsx` | `memory` in `ViewName`, the simple-view `Route` union and `SIMPLE_VIEWS`; the `/memory` row of the header table | remove them |
| `src/web/shell/Shell.tsx` | imports `MemoryPage`; `case 'memory'` of `View` | drop the import and the case |
| `src/web/shell/AppBar.tsx` | `case 'memory'` of `pageTitle` | drop it |
| `src/web/shell/Sidebar.tsx` | imports `MemoryNavItem`; `<MemoryNavItem />` at the end of the nav grid (nothing while off) | drop the import and the element |
| `src/web/shell/nav-icon-glyphs.ts` | `memory` in `NavIconName` and its glyph | remove both (and `'memory'` from the list in `tests/web/nav-grid.test.ts`) |
| `src/web/views/inbox.ts` | `OPEN_MEMORY` and its branch in `openRoute` | `return item.kind === 'system' && actionId === OPEN_PLAN ? (item.route ?? null) : null;` |
| `src/web/views/session/RightPanel.tsx` | imports `SessionMemoryLine`; `<SessionMemoryLine … />` after the Plan tab (nothing while off) | drop the import and the element |
| `src/server/team/hooks.ts` | D107 follow-up 2026-10-15: `memberOf` / `memberList` in `TeamHooks`, `TeamMemberRef`, `teamMemberOf`, `teamMemberList` (the member scope) | remove them (with `src/server/memory/team-link.ts`, deleted in section 1) |
| `src/server/team/service.ts` | imports `memoryMemberMoved`; calls it in `#followMove` after a member moved (its member-scoped memory goes with it); registers `memberOf` / `memberList` and `#memberRef` (and imports `TeamMemberRef`) | drop the import, the call, the two registrations and `#memberRef` |
| `src/web/shell/SidebarSessions.tsx` | imports `draft.ts` and `useMemory`; `memoryOn`; the ⋯ menu's "Draft memory from this session" | drop the imports, `memoryOn` and the item |
| `src/web/team/TeamPage.tsx` | imports `draft.ts` and `useMemory`; `memoryOn`, `draftAllMemory`, the `draft-memory` case of `pickMenu`, the two "Draft memory for all members" buttons, `withMemoryDraft` around `memberMenu(…)` | drop them all (`items={memberMenu(…)}` again) |
| `src/web/views/settings/ExperimentalSection.tsx` | imports `MemorySwitchRow` and renders it | drop the import and the element |

Tests that name Project memory's additions (revert with the code):

- `tests/server/api/settings.test.ts`: the `'experimental.memory': false` line of the fresh-install answer.
- `tests/server/tutorial/tutorial.test.ts`: `'D107'` in the What's-new decisions.
- `tests/web/nav-grid.test.ts`: `'memory'` in the icon names.
- `tests/server/tutorial/tutorial.test.ts`: the second `'D107'` (the `memory-scopes` tour, 1.22.0).

Docs: the *Project memory (D107)* section of `docs/handoff/contracts/local-api.md`, the README's Features bullet, the *D107* section of `.loop/questions.md`, D107 in `docs/decisions.md` (mark it removed rather than deleting the record).

## 3. Delete the data

`<dataDir>/memory.db` (and `memory.db-wal` / `memory.db-shm` if present). Nothing of Project memory's own state is in `switchboard.db`. Two kinds of rows there mention it, both harmless to a build without it:

- the `experimental.memory` setting (an unknown settings key is never read): `DELETE FROM settings WHERE key = 'experimental.memory'`;
- the Inbox items it raised ("N memory proposals for …"): `DELETE FROM system_items WHERE source = 'memory'`.

Sessions keep running as before: their next start (or a D91 Reload instruction) gives them the standing instruction without the memory block.

## Checked

The procedure was applied once to a throw-away copy (a scratch `git worktree` of the memory branch): every step of section 1 and 2, then `npm run typecheck`; the result is recorded in `.loop/questions.md` → *D107* (`VERIFIED D107-removal`).
