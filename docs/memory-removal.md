# Project memory graduated (D132)

Project memory (`docs/memory.md`, decision D107) shipped as an experimental feature behind **Settings → Experimental → Project memory**, off by default and built as a switchable hook with an off-state so it could be removed cleanly. In **2.0** it graduated to general release together with Team and Plans (D132; the developer: "in order to do that we would need to pull out or experimental functionalities to general release").

## What changed in 2.0

- **The off-switch is gone.** There is no `experimental.memory` setting any more (`PUT /api/settings` refuses the key with 422) and Settings has no Experimental section.
- **Always on.** `memory.db` is opened (and migrated) at start; no route answers `404 memory-off` any more. Only a `memory.db` that cannot be opened makes the memory routes answer `503 memory-unavailable` (and injects nothing), as before.
- **MCP tools.** The `memory_*` tools register through the same probe as before (`GET /agent/v1/memory`, `src/hook/sb-feature-tools.ts`): in every session with a project folder.
- **Nothing is injected without approved entries.** A session gets a memory block only from **approved** entries of its folder, repositories or member; with none its instruction is exactly as before (`withProjectMemory` returns it unchanged). Proposals are never injected.
- **Existing installs.** Whatever the stored switch said, Project memory is on after the start; `forgetGraduatedSwitches` (`src/server/settings/graduated.ts`) deletes the stored `experimental.memory` row once. Approved entries kept from a time it was on reach new and resumed sessions again (open ones are flagged "instruction outdated", D91).
- **Paired machines and phones.** The peer and device allow-lists are unchanged. A paired machine still on 1.x with memory off answers `404 memory-off` ("Project memory is off there" on a member's memory copy, retried when it changes).

## How it is wired

Project memory's code lives in its own folders and files: `src/server/memory/` (service, `memory.db` and its migrations, routes, hooks, `reach.ts`, `team-link.ts`), `src/core/memory.ts`, `src/hook/sb-memory-tools.ts` and `src/web/memory/`. The rest of Switchboard knows it only through the hooks below, each marked in the code with the comment **`Project memory (D107) hook`** (`grep -rn "Project memory (D107) hook" src`). `tests/server/memory/removal.test.ts` fails when a file carries the marker and is not listed here, or a listed file no longer carries it.

| File | Hook |
|---|---|
| `src/server/app.ts` | imports `installMemory`; calls `installMemory(app, apiContext)` after `installPlans` |
| `src/server/sessions/instruction.ts` | imports `withProjectMemory`; `sessionInstruction` wraps the standing instruction and charter with it (and its `Pick` names `root` / `cwd`) |
| `src/hook/sb-mcp.ts` | `main` probes the feature tools (`FeatureTools`, `sb-feature-tools.ts`) before `connect` and keeps them in step |
| `src/hook/sb-feature-tools.ts` | the `memory` entry of `FEATURE_TOOL_SETS` (imports `MEMORY_TOOLS`, `registerMemoryTools`) |
| `src/core/api.ts` | imports `MemoryChanged`; `HubEvents.memoryChanged` and its entry in `HUB_EVENT_NAMES` |
| `src/server/devices/local-only.ts` | the memory entries of `DEVICE_ALLOWED` (reads, a session's count, the scope options, edit / pin, approve, reject) and of `DEVICE_REFUSED` (add, delete, the cap, the draft asks, the import), and "(D107) project memory" in the file comment |
| `src/server/peers/service.ts` | the memory entries of `PEER_API_ALLOW`; imports `memoryPeerChanged` and the `memoryChanged` branch at the top of `#onPeerEvent` (a pending member-memory copy is retried) |
| `src/core/peer-wire.ts` | `'memoryChanged'` in `PEER_HUB_EVENTS` (streamed to paired machines; never republished) |
| `src/server/inbox/system-items.ts` | imports `MEMORY_COPY_RETRY` / `MEMORY_COPY_KEEP` / `memoryInboxAction`; their branch in `#perform` (the "missing its memory" item's Retry / Keep on this PC) |
| `src/server/inbox/wire.ts` | `'memory-proposals': 'Memory'` and `'memory-copy': 'Memory'` in `SYSTEM_ITEM_LABELS` |
| `src/core/tutorial.ts` | `memory` in `TourRoute`; `V1_20` and the `memory` entry of `WHATS_NEW`; the `memory-scopes` entry (1.22.0) |
| `src/web/router.tsx` | `memory` in `ViewName`, the simple-view `Route` union and `SIMPLE_VIEWS`; the `/memory` row of the header table |
| `src/web/shell/Shell.tsx` | imports `MemoryPage`; `case 'memory'` of `View` |
| `src/web/shell/AppBar.tsx` | `case 'memory'` of `pageTitle` |
| `src/web/shell/Sidebar.tsx` | imports `MemoryNavItem`; `<MemoryNavItem />` at the end of the nav grid (nothing while unavailable) |
| `src/web/shell/nav-icon-glyphs.ts` | `memory` in `NavIconName` and its glyph |
| `src/web/views/inbox.ts` | `OPEN_MEMORY` and its branch in `openRoute` |
| `src/web/views/session/RightPanel.tsx` | imports `SessionMemoryLine`; `<SessionMemoryLine … />` after the Plan tab (nothing while unavailable) |
| `src/server/team/hooks.ts` | D107 follow-up 2026-10-15: `memberOf` / `memberList` in `TeamHooks`, `TeamMemberRef`, `teamMemberOf`, `teamMemberList` (the member scope) |
| `src/server/team/service.ts` | imports `memoryMemberMoved`; calls it in `#followMove` after a member moved (its member-scoped memory goes with it); registers `memberOf` / `memberList` and `#memberRef` (and imports `TeamMemberRef`) |
| `src/web/shell/SidebarSessions.tsx` | imports `draft.ts` and `useMemory`; `memoryOn`; the ⋯ menu's "Draft memory from this session" |
| `src/web/team/TeamPage.tsx` | imports `draft.ts` and `useMemory`; `memoryOn`, `draftAllMemory`, the `draft-memory` case of `pickMenu`, the two "Draft memory for all members" buttons, `withMemoryDraft` around `memberMenu(…)` |
| `src/web/v2/agents/AgentsPage.tsx` | imports `draft.ts`; an agent's ⋯ menu offers "Draft notes" (D131 v2 Agents) |
| `src/web/v2/agents/notes/NotesPage.tsx` | the v2 Notes page (D131): `memoryApi`, `refusalText`, `reloadMemory` and the `MemoryEntry` type |
| `src/web/v2/agents/notes/notes-model.ts` | the v2 Notes page's pure part (D131): the memory types, `folderName`, `memoryOrder`, `scopeKindOf` |
| `src/web/v2/agent/side-model.ts` | the v2 agent side panel's notes line (D131): the `MemorySessionCount` type |
| `src/web/v2/agent/SideExtras.tsx` | the v2 agent side panel's "What agents know" line (D131): `memoryApi`, `useMemory`, `memoryCountTooltip` |
| `src/web/v2/agent/Header.tsx` | the v2 agent ⋯ menu's "Draft notes" (D131): `memoryApi(…).draft` |
| `src/web/v2/shared/needs-you-model.ts` | v2 Needs you (D131): a note waiting for approval is an item (the `MemoryEntry` type) |
| `src/web/v2/shared/needs-you-store.ts` | v2 Needs you (D131): the store reads the waiting notes (the `MemoryEntry` type) |
| `src/web/v2/shared/needs-you.ts` | v2 Needs you (D131): reads the waiting notes and approves / rejects them (`memoryApi`) |

Removing Project memory now would be a new decision; the step-by-step removal procedure of 1.x is in this file's history (before D132).
