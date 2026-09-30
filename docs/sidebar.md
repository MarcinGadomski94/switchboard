# Sidebar: pins, order and folders (D54, subfolders D58)

Developer request D54 (`docs/decisions.md` → *Pin, re-order and folders in the sidebar*): "Pin and re-order sessions in the left pane; foldable folders for sessions to order them." Choices where the request is silent: `.loop/questions.md` → *D54 · Pin, re-order and folders in the sidebar*.

Developer request D58 (`docs/decisions.md` → *Subfolders in the sidebar*): "Make a possibility for subfolders too." Folders now hold folders; see *Subfolders (D58)* below and `.loop/questions.md` → *D58 · Subfolders in the sidebar*.

Code: rules `src/core/sidebar-layout.ts` (pure, shared by the server and the UI); storage `src/server/db/repos/sidebar.ts` + migrations `0019_sidebar_layout.sql` and `0021_sidebar_subfolders.sql` (D58); routes `src/server/api/sidebar.ts`; UI `src/web/shell/SidebarSessions.tsx` (+ `sidebar-dnd.ts`, `sidebar-layout.css`).

## The SESSIONS list
Top to bottom:
1. **Pinned** — the pinned sessions, in the order the developer dragged them into. The group label shows only while something is pinned (and, as a drop zone, while a session is dragged).
2. **Folders** — in their dragged order. Each folder head shows a chevron, the name, the number of its (open) sessions — D58: including those of its subfolders, at any depth — and, on hover, a ⋯ menu. Its subfolders follow it (D58), then its sessions, slightly indented, in their dragged order. A **collapsed** folder shows only its head (nothing inside it, at any depth); when a session inside — at any depth — waits for the developer (status `need`) the head adds an amber dot.
3. **Loose sessions** — every other open session, in the service's order (newest first, peers' sessions after this machine's), exactly as before D54. A new session appears at the top of this list.

A session is in exactly one place: pinned, in one folder, or loose. Pinning a session that is in a folder takes it out of the folder, and moving a pinned session into a folder unpins it. D54's folders were one level; since D58 a folder can hold folders (below).

With nothing pinned and no folder, the list is exactly the prototype's rows (the visual oracle's child paths are unchanged). The only visible additions at rest are the drawn **+** after the SESSIONS count (the label's copy stays "Sessions6") and, on hover or keyboard focus, a row's **⋯** left of its × (it covers the end of the head; nothing moves).

## Gestures
- **New folder:** the **+** after the SESSIONS count opens a name field at the end of the folders ("New folder", selected). Enter creates it (at the end of the folders), Esc or leaving the field cancels.
- **Pin / Unpin:** a row's ⋯ → **Pin** (to the end of Pinned) or **Unpin** (loose again).
- **Move to folder ▸:** a row's ⋯ → **Move to folder ▸** lists the other folders (the session goes to the end of the one picked) and **Out of the folder** for a session in one. Without folders it says "No folders yet (+ in SESSIONS)".
- **Move up / Move down:** in a pinned or foldered row's ⋯, and in a folder's ⋯ (the folder among the folders). Disabled at the edges. They step over sessions the sidebar does not show (closed ones keep their slot).
- **Folder menu:** **Rename** (a name field in the head: Enter or leaving it saves, Esc cancels), **New subfolder** (D58), **Collapse / Expand**, **Move up / down** (among the folders of its level), **Move to folder ▸** (D58), **Delete folder** (at once, nothing is lost: its sessions become loose; D58: see below for a subfolder and a folder with subfolders).
- **Collapse / expand:** the chevron, a click on the head, or the folder menu. Remembered by the service.
- The ⋯ menus are keyboard menus: the first item takes the focus, ↑ / ↓ move, Enter picks, Esc closes and gives the focus back to the ⋯, Tab or a click outside closes.

## Drag and drop
Native HTML5 drag and drop (Chromium, Safari, Firefox); rows and folder heads are draggable. While dragging, the dragged item fades and the target shows where it goes: a 2 px line (`--status-run`) above or below a row or folder head (by which half the pointer is in), or a highlight when it goes **into** something.

| Dragged | Dropped on | Result |
|---|---|---|
| a session | a pinned row (upper / lower half) | pinned, before / after it |
| a session | the **Pinned** label | pinned first (the label shows as a drop zone "drop here to pin" while nothing is pinned) |
| a session | a folder head | into the folder, at its end |
| a session | a row in a folder | into that folder, before / after the row |
| a pinned or foldered session | the zone "drop here to unpin / take out of the folder" (shown while dragging it, above the loose sessions) or a loose row | loose again |
| a loose session | a loose row | nothing (that list keeps the service's order) |
| a folder head | another folder head (upper / lower quarter) | the folder moves before / after it, at that folder's level (D58; D54 used the halves) |
| a folder head | the middle half of another folder head | into it, at the end of its subfolders (D58) |
| a subfolder head | the zone "drop here to move to the top level" (shown while dragging a subfolder) or a loose row | the top level, at the end of the folders (D58) |
| a folder head | itself, one of its own subfolders, or a place deeper than 5 levels allow | nothing (no indicator) |
| a folder head | anything else | nothing |

The rules are `resolveDrop` / `indicatorOf` in `src/web/shell/sidebar-dnd.ts`; positions are computed against the stored layout (`dropPosition`, so hidden ids such as a closed session keep their slot). Drag and drop works with the D41 sidebar shown; while it is slid out it is inert.

## Subfolders (D58)
- **Nesting:** a folder holds sessions **and folders**, to at most **5 levels** (a top-level folder is level 1). Each level has its own manual order. A folder's subfolders come first under its head, then its sessions.
- **Indent:** each level sits 10 px further in (a top-level folder's sessions keep D54's 12 px). Names that do not fit end with an ellipsis; nothing in the sidebar scrolls sideways, also at 5 levels in the 256 px sidebar.
- **New subfolder:** a folder's ⋯ → **New subfolder** opens the name field ("New folder", selected) at the end of its subfolders (a collapsed folder opens); Enter creates it there. Disabled at the fifth level.
- **Move:** drag a folder onto the middle of another folder's head (into it), onto its upper / lower quarter (before / after it, at its level), or onto the "move to the top level" zone. The folder menu's **Move to folder ▸** lists **Top level** (for a subfolder) and the folder tree, indented, without the folder itself and its own subfolders (no loops); its present parent is shown as "(here)", disabled; a folder whose subfolders would go past 5 levels there is disabled. **Move up / down** re-orders within its level. The folder moves with its subfolders and sessions.
- **Sessions:** a row's **Move to folder ▸** lists the whole tree, indented; the session's own folder shows as "(here)", disabled.
- **Collapse:** each folder collapses on its own (remembered). A collapsed folder's count and amber dot cover everything inside it, at any depth; a folder inside a collapsed one keeps its own state for when its parent opens.
- **Delete:** deleting a folder never deletes a session or a folder inside it: its **subfolders move up one level**, into its place among its siblings, and **its sessions go to the end of its parent folder** (or become loose when it was a top-level folder, as in D54). A folder with subfolders asks first: its menu's **Delete folder…** turns into "Delete: N subfolders and the sessions move to …" and **Cancel**.
- **Rules:** `src/core/sidebar-layout.ts` (`checkFolderParent`, `moveFolder`, `removeFolder`, `normalizeFolders`, `arrangeSidebar`), the same on the server (which refuses a loop or too deep with 422) and in the UI (which offers only what the server takes).

## Storage and sync
- Stored in Switchboard's database (migrations `0019` and `0021`, `docs/database.md`), so it is the same in every tab, the installed app and after a restart.
- Every write answers the whole new layout and is published as `sidebarLayoutChanged` on `/hub`; every open tab replaces its layout with it. A tab also reads the layout again whenever its `/hub` stream (re)opens.
- The write is one transaction (read, change, write), so two tabs writing at once never interleave.
- **Peers (D48):** a paired machine's session (remote id `r~<machine>~<id>`) can be pinned or put into this machine's folders. The layout is this machine's own: the routes are not on the peer API's allow-list, session ids travel in the body (so the D48 forwarding never sends them to the peer), and `sidebarLayoutChanged` is not on the peer event stream. An offline peer's sessions stay in their places (they stay listed, unreachable). **Forgetting** a machine removes its sessions' places.
- **Closed sessions (D33):** a closed session leaves the sidebar as before, but its place is kept: **Reopen** brings it back where it was. A session record that is deleted (a refused teleport start) takes its place with it (a database trigger).
- A folder's count and its rows are the listed (open) sessions only (D58: the count adds those of its subfolders).

## API (additive; `contracts/local-api.md` → *Sidebar pins and folders (D54)* and *Subfolders in the sidebar (D58)*)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/sidebar | — | SidebarLayout |
| POST | /api/sidebar/folders | `{ name, parentId? }` | 201 SidebarLayout (the new folder last among the folders of `parentId`; absent / `null` = the top level) · 404 unknown parent · 422 too deep |
| PUT | /api/sidebar/folders/{folderId} | `{ name?, collapsed? }` | SidebarLayout · 404 |
| PUT | /api/sidebar/folders/{folderId}/position | `{ index, parentId? }` | SidebarLayout · 404 unknown folder / parent · 422 a loop or too deep |
| DELETE | /api/sidebar/folders/{folderId} | — | SidebarLayout (D58: its subfolders move up, its sessions go to its parent or are loose) · 404 |
| POST | /api/sidebar/place | `{ sessionId, place: pinned \| folder \| loose, folderId?, index? }` | SidebarLayout · 404 unknown session / folder |

D58: every `SidebarFolder` carries `parentId` (`null` = top level) and `folders` is in tree order (each folder followed by its subfolders); `parentId` absent on a move = it stays at its level (D54's body). Names are trimmed, 1–60 characters, and may repeat. `index` is the final position in the target group (absent = the end). Bad input answers 422 `{ error: "invalid", errors }`; a refused write changes nothing and publishes nothing.

## Tests
- `tests/core/sidebar-layout.test.ts` — placing, folders, positions, grouping, validation; D58: the tree helpers, tree order, moves, no loops, the depth limit, delete moving things up, totals and hidden folders.
- `tests/web/sidebar-dnd.test.ts` — what each drop writes and how it is shown; D58: into / beside nested folders, loops and depth refused, out to the top level.
- `tests/server/db/migrate.test.ts` → *0021 sidebar subfolders (D58)* — D54 folders stay top level with their places.
- `tests/server/api/sidebar.test.ts` — the routes, persistence, `sidebarLayoutChanged`, refusals, a peer's session and forgetting its machine, closed and deleted sessions, not on the peer API; D58: `parentId` on create / move, positions per parent, 404 / 422 refusals, delete with subfolders, a peer's session in a subfolder.
- `tests/e2e/sidebar-layout.spec.ts` — on the demo seed: the untouched list, pin, drag re-order, a folder, drag in and out, collapse, a reload and a second tab, and the keyboard path.
- `tests/e2e/sidebar-subfolders.spec.ts` (D58) — New subfolder, a session and a folder dragged in, out to the top level, collapse hides and counts (amber dot through two levels), reload and a second tab, the menus (tree targets without the folder's own subfolders, delete with subfolders asks), 5 levels without sideways scrolling.
