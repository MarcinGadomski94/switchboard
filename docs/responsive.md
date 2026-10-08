# Responsive layout (D74)

Switchboard works on phones and tablets as well as on the desktop: every page, dialog and menu adapts, and a touch screen gets finger-sized controls and long-press drag in the sidebar. Developer request 2026-10-08; rulings in `docs/decisions.md` → D74.

The desktop layout is the prototype's and stays **pixel-identical at 1280 px and wider**: every responsive rule sits in a media query below that width, every element that only the compact layouts need is mounted only there (so the visual oracle's child paths hold), and the touch rules key on `(pointer: coarse)` (the visual oracle runs with a mouse). `tests/e2e/visual/*` pass unchanged.

## Breakpoints

| Layout | Width | Examples | What changes |
|---|---|---|---|
| desktop | ≥ 1280 px | 1366, 1440, 1920 | nothing (the prototype) |
| tablet | 768–1279 px | 768 × 1024, 1024 × 768, 820 × 1180 | top app bar; the sidebar a slide-over drawer; the session's right panel a drawer from the right |
| tablet portrait and below | ≤ 1023 px | 768 × 1024 | the session header's actions move into its ⋯ menu; tables become cards |
| phone | ≤ 767 px | 360 × 740, 390 × 844, 640 × 360 | one column; the drawer covers the screen; the right panel a bottom sheet; dialogs full-screen sheets; list → detail pages |
| short | ≤ 1279 px wide and ≤ 500 px high | 640 × 360 | the session's chips and the quick-reply label hide, so the chat keeps room |

The numbers live in `src/web/shell/viewport.ts` (`DESKTOP_MIN` 1280, `TABLET_MIN` 768, `HEADER_MENU_BELOW` 1024) and the CSS uses the same ones: `(max-width: 1279px)`, `(max-width: 1023px)`, `(max-width: 767px)`. 1280 rather than 1366 keeps small laptop windows (1280 × 800) on the desktop layout; the old shell had a 1100 px minimum width, so nothing between 1100 and 1279 px was designed for the desktop either.

The CSS is in `src/web/styles/responsive/` (imported last, from `main.tsx`): `shell.css` (app bar, drawer, scrim), `session.css` (session view, tabs, todo cards), `pages.css` (the other pages), `modals.css` (dialogs, menus, toasts), `touch.css` (coarse pointers). The React side is `src/web/shell/useLayout.ts` (`useLayout`, `useHeaderMenu`, `useCoarsePointer`, all `matchMedia`).

## Shell

- **App bar** (tablet and phone, every page but the session view): ☰ (opens the sidebar), the page's title, **Inbox** with its count. `AppBar.tsx`.
- **Sidebar drawer:** the D41 slide (`--pane-slide`, transform + visibility), as a fixed drawer over the page: `min(320px, 88vw)` on a tablet with a scrim, the whole screen on a phone (its brand row's hide button closes it). It closes when a page is picked, on the scrim, on Escape, and when a dialog opens from it. While it is open the page behind is `inert`; while it is closed the sidebar is. The drawer scrolls as one (the desktop's fixed top and bottom would leave the sessions no room on a phone).
- **D41 state:** on the compact layouts `usePanes()` reports the drawers (both closed at first, never saved); the stored desktop choice (`ui.sidebarHidden`, `ui.rightPanelHidden`) is untouched and applies again at desktop width. ⌘B / ⌥⌘B toggle the drawers there, and focus moves between a drawer's opener and its hide button as D41's handle and button do (the openers carry `data-pane-handle`). One drawer at a time.
- **Height:** the shell is `var(--app-height, 100dvh)` high; `useVisualViewportHeight` keeps `--app-height` at the visual viewport's height on the compact layouts, so the composer stays above an on-screen keyboard where the browser does not resize the layout viewport (iOS Safari). The viewport meta has `viewport-fit=cover` (safe areas, `env(safe-area-inset-*)` on the app bar, drawers, composer and sheets) and `interactive-widget=resizes-content` (Chrome on Android shrinks the page for the keyboard).

## Session view

- **Header:** ☰ (with the Inbox count as a badge, since the view has no app bar), status dot, title (cut with …), the root path (hidden on phones), the **panel** button, and below 1024 px **⋯**: the header's actions (CLI, account and model pickers, Close / Reopen, Remote, take-over, Pause / Resume, Continue in terminal / Attach here) in a menu under the top row. They are the same elements (no second copy of the logic), shown as a list; the menu closes on a tap outside, on Escape and after an action that does not open a popover of its own (the pickers' popovers and the Remote popover become sheets at the window's bottom). At 1024–1279 px the actions stay in the row and wrap.
- **Chips and tabs:** each one line that scrolls sideways (no scrollbar drawn).
- **Right panel:** a drawer from the right on a tablet (`min(380px, 92vw)`), a bottom sheet on a phone (`min(80dvh, …)`, rounded top); its scrim and its overview's hide button close it.
- **Chat:** tighter padding; messages may use the whole width; code blocks, diffs and Markdown tables scroll inside themselves. The composer is pinned at the bottom (safe-area padding), quick replies are one line that scrolls sideways, the context bar drops its "compacted" note on phones.
- **Timeline:** a narrower label column, every other time tick; the log and terminal stack. **Diff:** on phones the files become a strip that scrolls sideways above the diff. **Artifacts:** rows wrap.
- **Todo strip and cards:** the strip's "next" line hides on phones; a card keeps check · title · ⋯ on its first line and puts its priority, estimate and age under the title; the Priority submenu opens inward.

## Pages

| Page | Tablet | Phone |
|---|---|---|
| Inbox | list 280 px + detail | list → item (‹ Inbox) |
| Solutions | rows: name / phase / changes, branches under them; detail column 260–300 px | list → solution (‹ Solutions) |
| Schedules & loops | the table becomes cards (name, cron · next, the strip, actions) | loop cards in one column |
| MCP | head wraps | actions under each server; form rows stack |
| Artifacts | cards: type · name · age, where, session · note | the search on its own line |
| History | cards: name · date, summary, outcome | the search on its own line |
| Todos | head wraps | cards as in the session |
| Tool | the URL on its own line | the overlay card fits |
| Settings | nav 190 px + section; rows wrap; tables become cards | `/settings` lists the sections, `/settings/<section>` shows one with ‹ Settings |

**List → detail on phones** (`components/ListDetail.tsx`): the page's `data-pane` (`list` / `detail`) says which half shows; a pick shows the item, **‹ Back** returns. Settings does it through the URL (`/settings` vs `/settings/<section>`); Inbox and Solutions in the page's state (a solution opened from elsewhere shows at once).

## Dialogs and menus

- Every dialog fits the window: on tablets centered with 16 px around (`calc(100vw - 32px)` / `--app-height`, since a percentage of the overlay's auto-sized grid area does not limit them); on phones **full-screen sheets** (safe areas respected), except the short Close confirmation, which sits at the bottom as a sheet, and the palette, which keeps a strip of backdrop to tap away.
- **New session (Full):** below 1024 px the side column (toggles, summary, actions) goes under the form, the whole sheet scrolls, the actions stay at its bottom (sticky), the Simple / Full switch stays at the top right. Grids of two columns (task, branch, schedule, QA, branching) become one. **Simple** wraps its rows.
- **Setup wizard:** the steps rail becomes a row over the step (phones show the current step's label only).
- Menus (the sidebar's ⋯, the footer's CLI menu, a todo card's ⋯) stay inside the window and scroll when long; toasts and the update banner fit the width. Dialogs and toasts sit above the drawers.

## Touch

On a coarse pointer (any width), `touch.css`:

- **Tap targets ≥ 44 × 44 px**: nav items, session and folder rows, ⋯ buttons, tabs, header actions, Send, quick replies, question options, todo controls, page actions and filters, dialog pills and buttons, menu items.
- **Hover-only controls get a touch path:** a sidebar row's and a folder's **⋯** are always shown; the row's **×** (hover only) hides and **Close** is in the row's ⋯ menu instead (`sidebar-menu-close`, coarse pointers only).
- **Tooltips:** a long press (~500 ms) on an element with a `title` shows it in a bubble above the element (`TouchTooltip.tsx`); the click that would follow is swallowed; the next touch dismisses it. Not in the sessions list, where a long press drags.
- Fields are at least 16 px (iOS zooms into smaller ones).

## Long-press drag (sidebar)

The mouse's HTML drag and drop (D54 / D58 / D71) is unchanged. On a touch screen (`touch-drag.ts`, `SidebarSessions.tsx`):

1. A finger on a session row or a folder head starts a press (not on its ⋯, × or a name field).
2. Moving more than **8 px** within **400 ms** is a scroll: the press is dropped, the browser scrolls, no drag starts.
3. Held still for 400 ms, the row **lifts** (no haptics): the row is highlighted, a small label with its name follows the finger, the row's menu closes.
4. Moving, the element under the finger is read back through its `data-drop-zone` (`row`, `folder-head`, `pinned-head`, `loose`) into the same `DropOver` the mouse handlers build, so `resolveDrop` / `indicatorOf` decide the drop and its indicator (a line before / after, or the folder highlighted). Near the top or bottom edge the list (or, in the drawer, the whole sidebar) scrolls (`dragScrollStep`). While lifted, the list's `touchmove` is cancelled (a non-passive listener), so the page does not scroll under the finger.
5. Lifting the finger drops (the same writes as a mouse drop); the click the release may send is swallowed, so the row's link is not followed. A browser that cancels the pointer (`pointercancel`) cancels the drag.

The browser's own touch drag of `draggable` elements is refused while a press is active, and the long press's link callout / text selection is off (`-webkit-touch-callout`, `user-select`). `prefers-reduced-motion` turns the drawer and sheet slides off.

## Tests

- `tests/e2e/responsive.spec.ts`: at 360 × 740, 640 × 360, 768 × 1024 and 1024 × 768 (touch, demo seed): every page (the nav's views, a tool, a session's tabs, every Settings section) has no horizontal overflow (`scrollWidth` ≤ the width, and no element past the window's edge outside a sideways-scrolling box); the app bar and the drawer; the phone's list → detail pages; the dialogs (New session Simple and Full, palette, setup wizard, Close confirmation) and the menus fit; the desktop (1440) has none of it.
- `tests/e2e/responsive-session.spec.ts`: with fake-claude at the four sizes and 390 × 844: the composer at the bottom, a message sent with Send gets its reply, a wide code block and table scroll inside themselves, the tabs switch, the right panel opens (a bottom sheet on phones) and its scrim closes it.
- `tests/e2e/responsive-touch.spec.ts`: long-press drag into a folder and re-order among loose rows (Chromium, CDP touch input), a swipe that scrolls the drawer and starts no drag, tap targets ≥ 44 px, and a WebKit pass at the phone sizes (pages, drawer, long-press drag) when the Playwright WebKit browser is installed.
- `tests/web/responsive.test.ts`: the thresholds and the long-press rules.
