# Sidebar: pins, order and folders (D54)

Developer request D54 (`docs/decisions.md` → *Pin, re-order and folders in the sidebar*): "Pin and re-order sessions in the left pane; foldable folders for sessions to order them." Choices where the request is silent: `.loop/questions.md` → *D54 · Pin, re-order and folders in the sidebar*.

Code: rules `src/core/sidebar-layout.ts` (pure, shared by the server and the UI); storage `src/server/db/repos/sidebar.ts` + migration `0019_sidebar_layout.sql`; routes `src/server/api/sidebar.ts`; UI `src/web/shell/SidebarSessions.tsx` (+ `sidebar-dnd.ts`, `sidebar-layout.css`).

## The SESSIONS list
Top to bottom:
1. **Pinned** — the pinned sessions, in the order the developer dragged them into. The group label shows only while something is pinned (and, as a drop zone, while a session is dragged).
2. **Folders** — in their dragged order. Each folder head shows a chevron, the name, the number of its (open) sessions and, on hover, a ⋯ menu. Its sessions follow it, slightly indented, in their dragged order. A **collapsed** folder shows only its head; when a session inside waits for the developer (status `need`) the head adds an amber dot.
3. **Loose sessions** — every other open session, in the service's order (newest first, peers' sessions after this machine's), exactly as before D54. A new session appears at the top of this list.

A session is in exactly one place: pinned, in one folder, or loose. Pinning a session that is in a folder takes it out of the folder, and moving a pinned session into a folder unpins it. Folders are one level (no folder in a folder).

With nothing pinned and no folder, the list is exactly the prototype's rows (the visual oracle's child paths are unchanged). The only visible additions at rest are the drawn **+** after the SESSIONS count (the label's copy stays "Sessions6") and, on hover or keyboard focus, a row's **⋯** left of its × (it covers the end of the head; nothing moves).

## Gestures
- **New folder:** the **+** after the SESSIONS count opens a name field at the end of the folders ("New folder", selected). Enter creates it (at the end of the folders), Esc or leaving the field cancels.
- **Pin / Unpin:** a row's ⋯ → **Pin** (to the end of Pinned) or **Unpin** (loose again).
- **Move to folder ▸:** a row's ⋯ → **Move to folder ▸** lists the other folders (the session goes to the end of the one picked) and **Out of the folder** for a session in one. Without folders it says "No folders yet (+ in SESSIONS)".
- **Move up / Move down:** in a pinned or foldered row's ⋯, and in a folder's ⋯ (the folder among the folders). Disabled at the edges. They step over sessions the sidebar does not show (closed ones keep their slot).
- **Folder menu:** **Rename** (a name field in the head: Enter or leaving it saves, Esc cancels), **Collapse / Expand**, **Move up / down**, **Delete folder** (at once, nothing is lost: its sessions become loose).
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
| a folder head | another folder head (upper / lower half) | the folder moves before / after it |
| a folder head | anything else | nothing |

The rules are `resolveDrop` / `indicatorOf` in `src/web/shell/sidebar-dnd.ts`; positions are computed against the stored layout (`dropPosition`, so hidden ids such as a closed session keep their slot). Drag and drop works with the D41 sidebar shown; while it is slid out it is inert.

## Storage and sync
- Stored in Switchboard's database (migration `0019`, `docs/database.md`), so it is the same in every tab, the installed app and after a restart.
- Every write answers the whole new layout and is published as `sidebarLayoutChanged` on `/hub`; every open tab replaces its layout with it. A tab also reads the layout again whenever its `/hub` stream (re)opens.
- The write is one transaction (read, change, write), so two tabs writing at once never interleave.
- **Peers (D48):** a paired machine's session (remote id `r~<machine>~<id>`) can be pinned or put into this machine's folders. The layout is this machine's own: the routes are not on the peer API's allow-list, session ids travel in the body (so the D48 forwarding never sends them to the peer), and `sidebarLayoutChanged` is not on the peer event stream. An offline peer's sessions stay in their places (they stay listed, unreachable). **Forgetting** a machine removes its sessions' places.
- **Closed sessions (D33):** a closed session leaves the sidebar as before, but its place is kept: **Reopen** brings it back where it was. A session record that is deleted (a refused teleport start) takes its place with it (a database trigger).
- A folder's count and its rows are the listed (open) sessions only.

## API (additive; `contracts/local-api.md` → *Sidebar pins and folders (D54)*)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/sidebar | — | SidebarLayout |
| POST | /api/sidebar/folders | `{ name }` | 201 SidebarLayout (the new folder last) |
| PUT | /api/sidebar/folders/{folderId} | `{ name?, collapsed? }` | SidebarLayout · 404 |
| PUT | /api/sidebar/folders/{folderId}/position | `{ index }` | SidebarLayout · 404 |
| DELETE | /api/sidebar/folders/{folderId} | — | SidebarLayout · 404 |
| POST | /api/sidebar/place | `{ sessionId, place: pinned \| folder \| loose, folderId?, index? }` | SidebarLayout · 404 unknown session / folder |

Names are trimmed, 1–60 characters, and may repeat. `index` is the final position in the target group (absent = the end). Bad input answers 422 `{ error: "invalid", errors }`; a refused write changes nothing and publishes nothing.

## Tests
- `tests/core/sidebar-layout.test.ts` — placing, folders, positions, grouping, validation.
- `tests/web/sidebar-dnd.test.ts` — what each drop writes and how it is shown.
- `tests/server/api/sidebar.test.ts` — the routes, persistence, `sidebarLayoutChanged`, refusals, a peer's session and forgetting its machine, closed and deleted sessions, not on the peer API.
- `tests/e2e/sidebar-layout.spec.ts` — on the demo seed: the untouched list, pin, drag re-order, a folder, drag in and out, collapse, a reload and a second tab, and the keyboard path.
