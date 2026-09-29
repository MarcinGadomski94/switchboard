import { type EditableSettings, readKnownSettings } from '../../core/settings.ts';

/**
 * D41 · collapsible panes (`docs/panes.md`): the sidebar and the session view's
 * right panel slide out and back in on request, and the choice is kept by the
 * service (`ui.sidebarHidden` / `ui.rightPanelHidden` in `GET/PUT /api/settings`).
 * This module holds the pure parts: the state, its settings keys, the copy of the
 * controls and the shortcut rules (⌘B / Ctrl+B, ⌥⌘B / Ctrl+Alt+B, never while
 * typing in a text field). The React side is `Panes.tsx`.
 */

/** A pane that can be slid out. */
export type Pane = 'sidebar' | 'rightPanel';

/** Which panes are hidden. Both are shown by default, so the layout is the prototype's. */
export interface PaneState {
  readonly sidebarHidden: boolean;
  readonly rightPanelHidden: boolean;
}

/** Both panes shown (the default, and what an unknown state reads as). */
export const PANES_SHOWN: PaneState = { sidebarHidden: false, rightPanelHidden: false };

/** The setting that stores each pane's state. */
export const PANE_SETTING: Readonly<Record<Pane, 'ui.sidebarHidden' | 'ui.rightPanelHidden'>> = {
  sidebar: 'ui.sidebarHidden',
  rightPanel: 'ui.rightPanelHidden',
};

/** The pane state stored in a `GET /api/settings` body (missing or mistyped values read as shown). */
export function paneStateFromSettings(body: Readonly<Record<string, unknown>> | null | undefined): PaneState {
  const settings = readKnownSettings(body);
  return { sidebarHidden: settings['ui.sidebarHidden'], rightPanelHidden: settings['ui.rightPanelHidden'] };
}

/** How long the first paint waits for the stored pane state before it shows both panes. */
export const PANE_STATE_WAIT_MS = 1_500;

/**
 * The stored pane state for the first paint: `readSettings()` (`GET
 * /api/settings`) read with {@link paneStateFromSettings}. Both panes are shown
 * when it fails or does not answer within `waitMs` (a late answer is ignored).
 */
export async function loadPaneStateFrom(readSettings: () => Promise<Readonly<Record<string, unknown>>>, waitMs = PANE_STATE_WAIT_MS): Promise<PaneState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<PaneState>((resolve) => {
    timer = setTimeout(() => resolve(PANES_SHOWN), waitMs);
  });
  try {
    return await Promise.race([readSettings().then(paneStateFromSettings, () => PANES_SHOWN), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `pane` is hidden in `state`. */
export function isHidden(state: PaneState, pane: Pane): boolean {
  return pane === 'sidebar' ? state.sidebarHidden : state.rightPanelHidden;
}

/** `state` with `pane` hidden or shown (the same object when nothing changes). */
export function withPane(state: PaneState, pane: Pane, hidden: boolean): PaneState {
  if (isHidden(state, pane) === hidden) return state;
  return pane === 'sidebar' ? { ...state, sidebarHidden: hidden } : { ...state, rightPanelHidden: hidden };
}

/** The `PUT /api/settings` body that stores one pane's state. */
export function panePatch(pane: Pane, hidden: boolean): Partial<EditableSettings> {
  return { [PANE_SETTING[pane]]: hidden };
}

/** The shortcut of a pane as the platform writes it: `⌘B` / `⌥⌘B` on Apple platforms, `Ctrl+B` / `Ctrl+Alt+B` elsewhere. */
export function paneShortcutLabel(pane: Pane, apple: boolean): string {
  if (pane === 'sidebar') return apple ? '⌘B' : 'Ctrl+B';
  return apple ? '⌥⌘B' : 'Ctrl+Alt+B';
}

/** A pane control's accessible name and tooltip. */
export interface PaneControlCopy {
  /** The button's label (`aria-label`), e.g. "Hide sidebar". */
  readonly label: string;
  /** Its tooltip (`title`), the label with the shortcut, e.g. "Hide sidebar (⌘B)". */
  readonly tooltip: string;
}

/** Copy of a pane's hide button (`action: 'hide'`) and of its reveal handle (`'show'`). */
export function paneControlCopy(pane: Pane, action: 'hide' | 'show', apple: boolean): PaneControlCopy {
  const label = `${action === 'hide' ? 'Hide' : 'Show'} ${pane === 'sidebar' ? 'sidebar' : 'panel'}`;
  return { label, tooltip: `${label} (${paneShortcutLabel(pane, apple)})` };
}

/** A key press as {@link paneForShortcut} reads it (a `KeyboardEvent`'s fields). */
export interface PanePress {
  readonly key: string;
  readonly code: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly defaultPrevented: boolean;
}

/** Where the page is when the key comes (read from the DOM by the provider). */
export interface PaneShortcutContext {
  /** Focus is in a text field ({@link isTextEntry}). */
  readonly typing: boolean;
  /** A modal is open (`aria-modal="true"`: the palette, the New-session form, a confirmation…). */
  readonly modalOpen: boolean;
  /** The right panel exists (the session view is on screen). */
  readonly rightPanel: boolean;
}

/**
 * The key is B: its character (any case), or, with ⌥ / Alt held, the physical B
 * key (`KeyB`) when ⌥ turned it into another character (`∫` on a Mac); a letter
 * other than B on that key (another layout) is not B.
 */
function isKeyB(press: PanePress): boolean {
  if (press.key.toLowerCase() === 'b') return true;
  return press.altKey && press.code === 'KeyB' && !/^[a-z]$/i.test(press.key);
}

/**
 * D41: the pane a key press toggles, `null` when it is not a pane shortcut here.
 * ⌘B or Ctrl+B toggles the sidebar; ⌥⌘B or Ctrl+Alt+B the right panel, only
 * while it exists (the session view). Never while typing in a text field (the
 * key stays the field's), while a modal is open, with ⇧ held, on a key repeat,
 * while an IME composes, or when another handler took the key.
 */
export function paneForShortcut(press: PanePress, context: PaneShortcutContext): Pane | null {
  if (press.defaultPrevented || press.isComposing || press.repeat || context.typing || context.modalOpen) return null;
  if (!(press.metaKey || press.ctrlKey) || press.shiftKey || !isKeyB(press)) return null;
  if (!press.altKey) return 'sidebar';
  return context.rightPanel ? 'rightPanel' : null;
}

/** What {@link isTextEntry} reads of the focused element. */
export interface FocusedElement {
  /** `tagName` (any case). */
  readonly tagName: string;
  /** An `<input>`'s `type` (lower case), else anything. */
  readonly type?: string | null;
  readonly isContentEditable?: boolean;
}

/** `<input>` types that take no typed text (a shortcut still works while one has focus). */
const NON_TEXT_INPUTS: ReadonlySet<string> = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);

/** `true` when the focused element takes typed text: a textarea, a text-like input, or editable content. */
export function isTextEntry(el: FocusedElement | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  return !NON_TEXT_INPUTS.has((el.type ?? 'text').toLowerCase());
}
