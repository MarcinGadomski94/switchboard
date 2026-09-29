# Collapsible panes (D41)

The sidebar and the session view's right panel slide out and back in on request, and the choice is remembered by the service (developer ruling D41, `docs/decisions.md`). Both are shown by default, so the layout is the prototype's.

## Controls
| | Sidebar | Right panel (session view only) |
|---|---|---|
| Hide button | in the brand row, in its free space before the ⌘K key: a small drawn glyph, tooltip **"Hide sidebar (⌘B)"** | in the panel's first row (the agent overview's label row), at its right: tooltip **"Hide panel (⌥⌘B)"** |
| Reveal handle | a 6 px rail at the window's left edge, the sidebar's own place: **"Show sidebar (⌘B)"** | a 6 px rail at the window's right edge: **"Show panel (⌥⌘B)"** |
| Shortcut | ⌘B (Ctrl+B elsewhere) | ⌥⌘B (Ctrl+Alt+B elsewhere) |

- Off Apple platforms the tooltips read `Ctrl+B` / `Ctrl+Alt+B` (the same test as the sidebar's `⌘K` / `Ctrl K` key).
- **The hide buttons move nothing.** The sidebar's button is the brand row's last child (after the ⌘K key, so the prototype's child paths hold), drawn before the key with CSS `order`; its auto margin keeps the key flush right, and at 20 px it is lower than the 22 px mark, so the mark, the name and the key keep their boxes. The panel's button is absolutely placed in the overview's label row (`position: relative`), so that row keeps its height. Both carry no text, so no row's copy changes.
- **The reveal handle** is one `<button>` covering the rail (a click anywhere on it brings the pane back). At rest the rail looks like the hidden pane's edge (the left one the sidebar's background with its divider, the right one the main background with the panel's divider). On hover or keyboard focus it lights up (`--border-control`) and shows a small 20 px button (bg-card, a border-control line) 4 px inside the main area, halfway down the window, where no header action, chat bubble or view title sits.
- **Shortcuts** (`paneForShortcut` in `src/web/shell/panes.ts`): ⌘/Ctrl + B toggles the sidebar in every view; with ⌥/Alt it toggles the right panel, and only while the session view is on screen (elsewhere the key does nothing and the browser keeps its own meaning, e.g. Chrome's bookmark manager on a Mac). They never act:
  - while focus is in a text field (a textarea, a text-like input, editable content; the key stays the field's, e.g. the composer);
  - while a modal is open (`aria-modal="true"`: the palette, the New-session form, the setup wizard, a close confirmation);
  - with ⇧ held, on a key repeat, while an IME composes, or when another handler already took the key.

  The key is B by its character; with ⌥ held, the physical B key (`KeyB`) counts too, because ⌥B types `∫` on a Mac. No other shortcut of the app uses B (⌘K opens the palette, Esc closes and goes back, Enter / Shift+Enter in the composer).
- **Focus follows the control.** A pane that slides out while focus is inside it (e.g. its hide button was clicked or pressed) hands focus to its reveal handle; a pane brought back from its handle gives focus to its hide button. Otherwise focus stays where it is.

## Layout (`src/web/shell/shell.css`, `src/web/views/session/session.css`)
- **Sidebar hidden:** the shell's grid goes from `256px | 1fr` to `6px | 1fr` (`--pane-rail`), so the main area starts at x = 6 and spans to the right edge. The sidebar keeps its 256 px (no reflow) and slides out with `transform: translateX(-100%)`, then stops being painted (`visibility: hidden` after the slide).
- **Right panel hidden:** the session view's grid goes from `1fr | 380px` to `1fr | 6px`; the header, the chat and the other tabs take the freed width (the chat spans to x = 1434 at 1440 px). The panel keeps its 380 px and slides out to the right. The view clips sideways (`overflow-x: clip`, which is not a scroll box), so the panel past the window's edge never makes anything scroll sideways (D29).
- **The slide:** 180 ms (`--pane-slide`) on the grid columns and the pane's transform together, so the pane's edge follows its column. `prefers-reduced-motion: reduce` turns every part of it off (the pane is simply there or gone).
- The grids' children are placed explicitly (`grid-column` / `grid-row`), so the reveal handle shares the hidden pane's cell without pushing the main area into a new row.
- **A hidden pane is inert:** the `inert` attribute and `aria-hidden="true"` on the `<aside>`, so nothing in it takes focus, clicks or the screen reader's attention. It stays mounted, so its lists keep loading and its state (e.g. D37's expanded finished subagents) is kept.
- **Overlays:** the toast (top-right of the shell) and the modals are positioned against the shell, so they stay where they are in every state. The D24 Remote popover and the D31 model popover hang under their header buttons, which move with the header. D27's "as printed" popover opens left of the panel (its placement reads the panel's left edge), and it closes when the panel slides out, since its toggle goes with the panel.

## State and API
- Two editable settings of `GET/PUT /api/settings` (`docs/settings.md`): `ui.sidebarHidden` and `ui.rightPanelHidden`, booleans, default `false`. Additive keys, no new route (`docs/handoff/contracts/local-api.md` → *Collapsible panes (D41)*). Stored per install in the `settings` table, so the choice survives reloads, restarts and the installed app (D34), which shares the origin. The right panel's value applies to every session.
- **First paint:** `main.tsx` reads `GET /api/settings` (`loadPaneState`) before it renders the app, so a hidden pane is painted hidden from the first frame and never flashes open. When the service does not answer within 1.5 s, answers with an error, or stores nothing, both panes are shown (a late answer is ignored).
- **Saving:** every change is saved at once with `PUT /api/settings` carrying only that pane's key. Saves run one after the other, so the service keeps the last one. A failed save leaves the page as it is; the next change saves again.
- **Other open tabs** do not follow a change live (there is no `/hub` event for settings); they show the stored state on their next load. Each change stores an absolute value, so a stale tab never flips the other pane.

## Code
- `src/web/shell/panes.ts`: the pure parts: `PaneState`, `paneStateFromSettings`, `loadPaneStateFrom`, `withPane`, `panePatch`, the controls' copy (`paneControlCopy`, `paneShortcutLabel`), `paneForShortcut`, `isTextEntry`.
- `src/web/shell/Panes.tsx`: `PanesProvider` (the state, saving, the shortcuts, focus), `usePanes`, `loadPaneState`, `PaneHideButton`, `PaneHandle`.
- `Shell.tsx` / `Sidebar.tsx` (the sidebar, its button and handle), `SessionView.tsx` / `RightPanel.tsx` / `AgentOverview.tsx` (the panel, its button and handle; the "as printed" popover closing).

## Tests
- `tests/web/panes.test.ts`: the state helpers (defaults, mistyped values, the first-paint loader with a failed and a late answer), the copy, and the shortcuts (both platforms' modifiers, ⌥B as `∫`, only in the session view for the panel, ignored in text fields, with a modal open, with ⇧, on a repeat, while composing, another layout's letter on the B key).
- `tests/server/api/settings.test.ts`: the two keys' defaults, persistence across a reopened database, 422 on a mistyped value, a stored mistyped value reading as shown.
- `tests/e2e/panes.spec.ts` (real path, fake-claude, no demo seed): hide with the button → reload keeps it hidden (painted hidden at first paint) → the handle brings it back → reload shown, for the sidebar and for the right panel (which stays hidden in a second session); focus moves to the handle and back; ⌘B / ⌥⌘B toggle and do nothing while typing in the composer or (⌥⌘B) outside the session view; nothing scrolls sideways in any of the four states; the toast keeps its top-right box with the sidebar hidden; "as printed" opens left of the panel and closes when the panel slides out; the Remote popover sits under its toggle with the panel hidden.
- `tests/e2e/visual/panes.spec.ts` (D10, an addition checked on its own like D18's Name row): the brand row's parts at the prototype's boxes with the hide button in its free space, the panel's hide button out of the flow in its row, the grids of the default state, the hidden states (the main area from x = 6, the chat to x = 1434, the rails, the handle's button on hover), and no slide with reduced motion. Report: `docs/visual/panes.md`.
