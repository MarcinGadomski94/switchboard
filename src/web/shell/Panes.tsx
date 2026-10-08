import { type ReactNode, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { routePath, useRouter } from '../router.tsx';
import { useLayout, useVisualViewportHeight } from './useLayout.ts';
import { type Layout, isCompact } from './viewport.ts';
import {
  PANES_SHOWN,
  type Pane,
  type PaneState,
  isHidden,
  isTextEntry,
  loadPaneStateFrom,
  paneControlCopy,
  paneForShortcut,
  panePatch,
  withPane,
} from './panes.ts';

/**
 * D41 · collapsible panes (`docs/panes.md`), the React side: the state provider
 * (loaded before the first paint, saved to the service on every change, the ⌘B /
 * ⌥⌘B shortcuts), a pane's hide button and its reveal handle. The rules are in
 * `panes.ts`; the layout (the slide, the rails) in `shell.css` and `session.css`.
 */

/** D74: both drawers closed (the compact layouts' first state). */
const DRAWERS_CLOSED: PaneState = { sidebarHidden: true, rightPanelHidden: true };

/** The `id` of each pane's element (the controls' `aria-controls`). */
export const PANE_ID: Readonly<Record<Pane, string>> = { sidebar: 'sb-sidebar', rightPanel: 'sb-right-panel' };

/** The test id prefix of each pane's controls (`<prefix>-hide`, `<prefix>-show`). */
const TEST_ID: Readonly<Record<Pane, string>> = { sidebar: 'sidebar', rightPanel: 'right-panel' };

/** An open modal (the palette, the New-session form, the setup wizard, a confirmation): the shortcuts wait until it closes. */
const MODAL_SELECTOR = '[aria-modal="true"]';

/** `true` on macOS / iOS, where the shortcuts read ⌘B / ⌥⌘B (as the sidebar's ⌘K key does). */
const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/**
 * Reads the stored pane state from the service (`GET /api/settings`) for the
 * first paint ({@link loadPaneStateFrom}), so a hidden pane never flashes open.
 */
export function loadPaneState(): Promise<PaneState> {
  return loadPaneStateFrom(api.settings);
}

/** The pane state and its controls. */
export interface PanesValue {
  readonly state: PaneState;
  /** Hides or shows a pane and saves the choice (`PUT /api/settings`). */
  readonly setHidden: (pane: Pane, hidden: boolean) => void;
  /** Hides a shown pane, shows a hidden one. */
  readonly toggle: (pane: Pane) => void;
  /**
   * D74: the layout (`viewport.ts`). On tablets and phones (`compact`) the panes
   * are drawers: `state` is whether each drawer is closed (both closed at first,
   * never saved), and `setHidden` opens or closes the drawer; the stored D41
   * state is kept for the desktop layout.
   */
  readonly layout: Layout;
  readonly compact: boolean;
}

const PanesContext = createContext<PanesValue | null>(null);

/** A pane change and where focus was when it came (focus follows the control, see {@link PanesProvider}). */
interface Change {
  readonly pane: Pane;
  readonly hidden: boolean;
  readonly focus: Element | null;
}

/** The element a key press comes from (the focused one; the document's active element for a key on the window). */
function focusedElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : document.activeElement;
}

/**
 * Holds which panes are hidden (D41), starting from `initial` (read before the
 * first paint, {@link loadPaneState}). Every change is saved at once, one save
 * after the other so the service keeps the last one; a failed save leaves the
 * page as it is (the next change saves again). ⌘B / Ctrl+B toggles the sidebar
 * and ⌥⌘B / Ctrl+Alt+B the right panel while the session view shows one;
 * neither while typing in a text field or while a modal is open
 * (`paneForShortcut`). Focus follows the control: a pane that slides out with
 * focus inside hands it to its reveal handle, and a pane brought back from its
 * handle gives it to its hide button.
 */
export function PanesProvider({ initial = PANES_SHOWN, children }: { readonly initial?: PaneState; readonly children: ReactNode }) {
  const [stored, setState] = useState<PaneState>(initial);
  const current = useRef(stored);
  // D74: the drawers of the compact layouts (closed at first; never saved).
  const layout = useLayout();
  const compact = isCompact(layout);
  const [drawers, setDrawers] = useState<PaneState>(DRAWERS_CLOSED);
  const drawersRef = useRef(drawers);
  drawersRef.current = drawers;
  const compactRef = useRef(compact);
  compactRef.current = compact;
  const state = compact ? drawers : stored;
  useVisualViewportHeight(compact);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const change = useRef<Change | null>(null);
  const { route } = useRouter();
  const rightPanel = useRef(route.view === 'session');
  rightPanel.current = route.view === 'session';

  const setHidden = useCallback((pane: Pane, hidden: boolean) => {
    if (compactRef.current) {
      const next = withPane(drawersRef.current, pane, hidden);
      if (next === drawersRef.current) return;
      change.current = { pane, hidden, focus: document.activeElement };
      // One drawer at a time: opening one closes the other.
      const only = hidden ? next : withPane(next, pane === 'sidebar' ? 'rightPanel' : 'sidebar', true);
      drawersRef.current = only;
      setDrawers(only);
      return;
    }
    const next = withPane(current.current, pane, hidden);
    if (next === current.current) return;
    change.current = { pane, hidden, focus: document.activeElement };
    current.current = next;
    setState(next);
    saving.current = saving.current.then(() => api.saveSettings(panePatch(pane, hidden))).catch(() => undefined);
  }, []);
  const toggle = useCallback(
    (pane: Pane) => setHidden(pane, !isHidden(compactRef.current ? drawersRef.current : current.current, pane)),
    [setHidden],
  );

  // D74: a drawer closes when the page changes (a link in it was followed) and when the layout turns desktop.
  const path = routePath(route);
  useEffect(() => {
    drawersRef.current = DRAWERS_CLOSED;
    setDrawers(DRAWERS_CLOSED);
  }, [path, compact]);

  // D74: Escape closes an open drawer (not while a modal is open: Escape is the modal's).
  useEffect(() => {
    if (!compact) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector(MODAL_SELECTOR)) return;
      const open = drawersRef.current;
      if (!open.rightPanelHidden) setHidden('rightPanel', true);
      else if (!open.sidebarHidden) setHidden('sidebar', true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compact, setHidden]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const focused = focusedElement(event.target);
      const typing = isTextEntry(
        focused ? { tagName: focused.tagName, type: focused instanceof HTMLInputElement ? focused.type : null, isContentEditable: focused instanceof HTMLElement && focused.isContentEditable } : null,
      );
      const pane = paneForShortcut(event, { typing, modalOpen: document.querySelector(MODAL_SELECTOR) !== null, rightPanel: rightPanel.current });
      if (!pane) return;
      event.preventDefault();
      toggle(pane);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  // Runs after the panes' own elements changed (children commit first).
  useLayoutEffect(() => {
    const last = change.current;
    change.current = null;
    if (!last?.focus) return;
    const { pane, hidden, focus } = last;
    if (hidden) {
      if (document.getElementById(PANE_ID[pane])?.contains(focus)) document.querySelector<HTMLElement>(`[data-pane-handle="${pane}"]`)?.focus();
    } else if (focus instanceof HTMLElement && focus.dataset['paneHandle'] === pane) {
      document.querySelector<HTMLElement>(`[data-pane-hide="${pane}"]`)?.focus();
    }
  }, [state]);

  const value = useMemo<PanesValue>(() => ({ state, setHidden, toggle, layout, compact }), [state, setHidden, toggle, layout, compact]);
  return <PanesContext.Provider value={value}>{children}</PanesContext.Provider>;
}

/** The pane state and its controls (inside {@link PanesProvider}). */
export function usePanes(): PanesValue {
  const value = useContext(PanesContext);
  if (!value) throw new Error('usePanes outside PanesProvider');
  return value;
}

/** A pane's glyph: a window with its sidebar (`left`) or its right panel (`right`) marked. Drawn, so no text. */
function PaneGlyph({ side }: { readonly side: 'left' | 'right' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d={side === 'left' ? 'M5.5 2.5v9' : 'M8.5 2.5v9'} stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/**
 * A pane's hide button (D41): a small drawn glyph (no text, so the row it sits in
 * keeps its copy), "Hide sidebar (⌘B)" / "Hide panel (⌥⌘B)" as its tooltip.
 * `className` places it (`sb-brand-hide` in the sidebar's brand row,
 * `sb-overview-hide` in the right panel's first row).
 */
export function PaneHideButton({ pane, className }: { readonly pane: Pane; readonly className: string }) {
  const { setHidden } = usePanes();
  const copy = paneControlCopy(pane, 'hide', APPLE);
  return (
    <button
      type="button"
      className={`sb-button sb-pane-hide ${className}`}
      data-testid={`${TEST_ID[pane]}-hide`}
      data-pane-hide={pane}
      aria-label={copy.label}
      aria-controls={PANE_ID[pane]}
      aria-expanded={true}
      title={copy.tooltip}
      onClick={() => setHidden(pane, true)}
    >
      <PaneGlyph side={pane === 'sidebar' ? 'left' : 'right'} />
    </button>
  );
}

/**
 * A hidden pane's reveal handle (D41): a slim rail at the window's edge, the
 * pane's own place; on hover or keyboard focus it lights up and shows a small
 * button. The whole rail is one button ("Show sidebar (⌘B)" / "Show panel
 * (⌥⌘B)"), so a click anywhere on it brings the pane back.
 */
export function PaneHandle({ pane }: { readonly pane: Pane }) {
  const { setHidden } = usePanes();
  const copy = paneControlCopy(pane, 'show', APPLE);
  return (
    <button
      type="button"
      className="sb-button sb-pane-handle"
      data-testid={`${TEST_ID[pane]}-show`}
      data-pane-handle={pane}
      data-side={pane === 'sidebar' ? 'left' : 'right'}
      aria-label={copy.label}
      aria-controls={PANE_ID[pane]}
      aria-expanded={false}
      title={copy.tooltip}
      onClick={() => setHidden(pane, false)}
    >
      <span className="sb-pane-handle-chip" data-testid={`${TEST_ID[pane]}-show-chip`}>
        <PaneGlyph side={pane === 'sidebar' ? 'left' : 'right'} />
      </span>
    </button>
  );
}
