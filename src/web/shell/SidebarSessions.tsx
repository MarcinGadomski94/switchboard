import { UNDO_LAST_TURN_LABEL } from '../../core/checkpoints.ts';
import { lastTurnRevert, openRevert, useCheckpoints } from '../views/session/checkpoints.ts';
import { type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Session, SessionActivity } from '../../core/api.ts';
import { CLOSE_TOOLTIP } from '../../core/session-close.ts';
import { displayTitle } from '../../core/session-title.ts';
import {
  type ArrangedFolder,
  EMPTY_SIDEBAR_LAYOUT,
  NEW_FOLDER_NAME,
  SIDEBAR_FOLDER_NAME_MAX,
  type SidebarFolder,
  type SidebarLayout,
  arrangeSidebar,
  checkFolderParent,
  childFolders,
  descendantIds,
  looseList,
  needsYou,
  parentOf,
  placeOf,
  stepPosition,
} from '../../core/sidebar-layout.ts';
import { SessionActivityOr } from '../activity/ActivityViews.tsx';
import { ApiError, api } from '../api/client.ts';
import { useHubEvent, useHubStatus } from '../api/useHub.ts';
import type { CloseSessionControl } from '../components/CloseSession.tsx';
import { InlineTitle } from '../components/InlineTitle.tsx';
import { MachineTag } from '../components/MachineTag.tsx';
import { PhoneGlyph } from '../components/PhoneGlyph.tsx';
import { FolderTag } from '../folders/FolderTag.tsx';
import { Link, useRouter } from '../router.tsx';
import { formatAge, modeLine, statusColor } from './format.ts';
import { MENU_GAP, MENU_MARGIN, dragScrollStep, menuTop } from './sidebar-menu.ts';
import { openTakeover } from '../takeover/store.ts';
import { FRESH_ACTION_LABEL } from '../../core/fresh-session.ts';
import { freshActionState, markFreshAsked, takeFreshAsked } from '../views/session/fresh-offer.ts';
import { refusalText } from '../views/inbox.ts';
import { useToasts } from '../toast/ToastHost.tsx';
import { openContinueHooked } from '../hooked-continue/store.ts';
import { CONTINUE_HOOKED_LABEL, offersHookedContinue } from '../../core/hooked-continue.ts';
import { TAKE_OVER_LABEL, moveLabel, offersTakeover } from '../takeover/takeover.ts';
import { usePairedMachines } from '../takeover/usePairedMachines.ts';
import { type DragItem, type DropIndicator, type DropOver, type RowGroup, folderSideOf, indicatorOf, resolveDrop, sameOver, sideOf } from './sidebar-dnd.ts';
import { LONG_PRESS_MS, type Press, dropOverAt, pressHeld, pressMove, pressStart } from './touch-drag.ts';
import { useCoarsePointer } from './useLayout.ts';
import './sidebar-layout.css';

/** The text of a refused layout write. */
function layoutErrorText(caught: unknown): string {
  if (caught instanceof ApiError) {
    const body = caught.body as { message?: unknown; errors?: Array<{ message?: unknown }> } | null;
    const message = body?.errors?.[0]?.message ?? body?.message;
    if (typeof message === 'string') return message;
    if (caught.unreachable) return 'Switchboard could not be reached.';
  }
  return 'The sidebar layout could not be saved.';
}

/** What {@link useSidebarLayout} gives the list. */
interface SidebarLayoutControl {
  readonly layout: SidebarLayout;
  /** Runs one write; its answer (the whole new layout) replaces the shown one. */
  readonly run: (call: () => Promise<SidebarLayout>) => Promise<boolean>;
  readonly error: string | null;
}

/**
 * D54: the stored layout (`GET /api/sidebar`), kept current by every write's
 * answer and by `sidebarLayoutChanged` (another tab, the installed app), and
 * read again whenever the `/hub` stream (re)opens (a change may have been missed).
 */
function useSidebarLayout(): SidebarLayoutControl {
  const [layout, setLayout] = useState<SidebarLayout>(EMPTY_SIDEBAR_LAYOUT);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.sidebarLayout().then(setLayout, () => undefined);
  }, []);
  useEffect(load, [load]);
  useHubEvent('sidebarLayoutChanged', (payload) => setLayout(payload));
  const status = useHubStatus();
  useEffect(() => {
    if (status === 'open') load();
  }, [status, load]);
  const run = useCallback(async (call: () => Promise<SidebarLayout>): Promise<boolean> => {
    try {
      setLayout(await call());
      setError(null);
      return true;
    } catch (caught) {
      setError(layoutErrorText(caught));
      return false;
    }
  }, []);
  return { layout, run, error };
}

/**
 * D33: the × of a sidebar row: invisible at rest, shown on hover or focus at the
 * row's right (over the age, which hides meanwhile; shell.css), absolutely placed
 * so the row keeps the prototype's geometry. A click closes the session and never
 * follows the row's link. The glyph is drawn, so the row's text is unchanged.
 */
function SessionCloseButton({ session, busy, onClose }: { readonly session: Session; readonly busy: boolean; readonly onClose: () => void }) {
  const click = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!busy) onClose();
  };
  return (
    <button
      type="button"
      className="sb-button sb-session-close"
      data-testid="sidebar-session-close"
      data-session-id={session.id}
      aria-label={`Close ${displayTitle(session)}`}
      aria-busy={busy || undefined}
      title={CLOSE_TOOLTIP}
      onClick={click}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true" focusable="false">
        <path d="M1 1l7 7M8 1L1 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/** A drawn ⋯ (no text, so the row's and header's copy is unchanged). */
function MoreGlyph() {
  return (
    <svg width="11" height="3" viewBox="0 0 11 3" aria-hidden="true" focusable="false">
      <circle cx="1.5" cy="1.5" r="1.2" fill="currentColor" />
      <circle cx="5.5" cy="1.5" r="1.2" fill="currentColor" />
      <circle cx="9.5" cy="1.5" r="1.2" fill="currentColor" />
    </svg>
  );
}

/** D54: the ⋯ that opens a row's or a folder's menu; clicks never follow the row's link. */
function MenuButton({ label, testId, className, onOpen }: { readonly label: string; readonly testId: string; readonly className: string; readonly onOpen: (anchor: HTMLElement) => void }) {
  return (
    <button
      type="button"
      className={`sb-button ${className}`}
      data-testid={testId}
      aria-label={label}
      aria-haspopup="menu"
      title={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen(event.currentTarget);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <MoreGlyph />
    </button>
  );
}

/** One entry of a {@link Menu}. */
interface MenuItem {
  readonly label: string;
  readonly testId: string;
  readonly run: () => void;
  readonly disabled?: boolean;
  /** D80 / D83: its tooltip (a disabled item's reason). */
  readonly title?: string;
  /** D58: a folder in a folder list is indented by its level (0 = top level). */
  readonly level?: number;
  /** Picking it keeps the menu open (it switches to a sub-list). */
  readonly keepOpen?: boolean;
}

/**
 * D54: a small menu over the page (a portal, so it never sits inside a row's
 * link, and the scrolling sessions list never clips it), under its ⋯ button, or
 * above it when the window has no room below ({@link menuTop}): ↑ / ↓ move
 * between the items, Esc closes and gives the focus back to the button, a click
 * outside closes it, and so does scrolling the list (or the sidebar / page around
 * it), which would leave the menu away from its row.
 */
function Menu({ anchor, label, items, onClose }: { readonly anchor: HTMLElement; readonly label: string; readonly items: readonly MenuItem[]; readonly onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const rect = anchor.getBoundingClientRect();
  const width = 196;
  const left = Math.max(MENU_MARGIN, Math.min(rect.right - width, window.innerWidth - width - MENU_MARGIN));
  const [top, setTop] = useState(() => rect.bottom + MENU_GAP);

  // Placed once its height is known, before it is painted.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const at = anchor.getBoundingClientRect();
    setTop(menuTop(at, menu.getBoundingClientRect().height, window.innerHeight));
  }, [anchor, items.length]);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const outside = (event: globalThis.MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose();
    };
    // Only a scroll that moves its ⋯ (the list, the sidebar, the page): a chat scrolling in the main area leaves it open.
    const scrolled = (event: Event): void => {
      if (event.target instanceof Node && event.target.contains(anchor)) onClose();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('scroll', scrolled, true);
    };
  }, [anchor, onClose]);

  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      anchor.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = buttons[(at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length];
      next?.focus();
    } else if (event.key === 'Tab') {
      onClose();
    }
  };

  return createPortal(
    <div ref={ref} className="sb-layout-menu" role="menu" aria-label={label} data-testid="sidebar-menu" style={{ left, top, width }} onKeyDown={keys}>
      {items.map((item) => (
        <button
          key={item.testId}
          type="button"
          role="menuitem"
          className="sb-layout-menu-item"
          data-testid={item.testId}
          disabled={item.disabled}
          title={item.title}
          style={item.level ? { paddingLeft: 8 + item.level * 12 } : undefined}
          onClick={() => {
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/**
 * Scrolls the SESSIONS list (only the list, never the sidebar or the page) just
 * enough that `el` shows in full; nothing moves when it already does.
 */
function revealInList(list: HTMLElement, el: HTMLElement): void {
  const box = list.getBoundingClientRect();
  const at = el.getBoundingClientRect();
  if (at.top < box.top) list.scrollTop -= box.top - at.top;
  else if (at.bottom > box.bottom) list.scrollTop += Math.min(at.bottom - box.bottom, at.top - box.top);
}

/** Which menu is open. */
type OpenMenu =
  | { readonly kind: 'session'; readonly id: string; readonly anchor: HTMLElement; readonly folders: boolean; readonly group: RowGroup; readonly visible: readonly string[] }
  | { readonly kind: 'folder'; readonly id: string; readonly anchor: HTMLElement; readonly view: 'main' | 'move' | 'delete' };

/** D58: the indent of one folder level, in px (a top-level folder's sessions keep D54's 12 px). */
const LEVEL_INDENT = 10;

/** Props of {@link SidebarSessions}. */
export interface SidebarSessionsProps {
  /** The open sessions, in the service's order (newest first). */
  readonly sessions: readonly Session[];
  /** `false` until the list has loaded (the count stays empty). */
  readonly loaded: boolean;
  readonly activityOf: (sessionId: string) => SessionActivity | null;
  readonly closer: CloseSessionControl;
  readonly isCurrent: (sessionId: string) => boolean;
  readonly tagOf: (session: Session) => string | null;
  /** D62 P6: the row's CLI badge (`codex`), `null` = none (a list of Claude Code sessions only). */
  readonly cliBadge?: (session: Session) => string | null;
  readonly now: number;
}

/** A text field for a folder's name: Enter saves, Esc cancels; leaving it saves (`saveOnBlur`) or cancels. */
function FolderNameField({ initial, label, testId, saveOnBlur, onSave, onCancel }: { readonly initial: string; readonly label: string; readonly testId: string; readonly saveOnBlur: boolean; readonly onSave: (name: string) => void; readonly onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (save: boolean): void => {
    if (done.current) return;
    done.current = true;
    if (save && value.trim() !== '') onSave(value.trim());
    else onCancel();
  };
  return (
    <input
      className="sb-folder-input"
      data-testid={testId}
      aria-label={label}
      value={value}
      maxLength={SIDEBAR_FOLDER_NAME_MAX}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(saveOnBlur)}
    />
  );
}

/**
 * The SESSIONS label and list (SPEC → Shell; D54 `docs/sidebar.md`): the
 * **Pinned** group (dragged order), then the sidebar folders (dragged order,
 * each collapsible; D58: folders hold subfolders too, shown first and indented
 * one step per level), then the loose sessions: D71: the unplaced ones in the
 * service's order (newest first, as before D54), then the loose order the
 * developer dragged. With nothing pinned and no folder the list is exactly
 * the prototype's rows. Sessions and folders move by drag and drop and by each
 * row's / folder's ⋯ menu (Pin / Unpin, Move up / down — D71: loose rows too —, Move to folder…), the
 * keyboard path. The label's drawn "+" creates a folder, a folder's menu a
 * subfolder. The layout is stored by the service and live in every tab
 * (`sidebarLayoutChanged`).
 */
export function SidebarSessions({ sessions, loaded, activityOf, closer, isCurrent, tagOf, cliBadge, now }: SidebarSessionsProps) {
  const { layout, run, error } = useSidebarLayout();
  const { navigate } = useRouter();
  const { show: showToast } = useToasts();
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [over, setOver] = useState<DropOver | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  // D80: the open session menu's checkpoints (*Undo last turn*), read when it opens.
  const menuCheckpoints = useCheckpoints(menu?.kind === 'session' ? menu.id : '', menu?.kind === 'session' ? `${menu.id}:${menu.anchor.isConnected}` : '');
  // D65: the paired machines a session can be moved to from its ⋯ menu.
  const { machines: pairedMachines } = usePairedMachines(true);
  /** The folder a new folder's name field is in (`null` = the top level, D54's "+"); `undefined` = no field. */
  const [creating, setCreating] = useState<string | null | undefined>(undefined);
  const [renaming, setRenaming] = useState<string | null>(null);
  const arranged = arrangeSidebar(sessions, layout);
  /** D71: the listed sessions in the service's order (a loose drop's position counts in the whole loose list). */
  const listedIds = sessions.map((s) => s.id);
  const closeMenu = useCallback(() => setMenu(null), []);
  const listRef = useRef<HTMLDivElement>(null);
  /** The session whose row was last revealed (the effect below). */
  const revealed = useRef<string | null>(null);
  const currentId = sessions.find((s) => isCurrent(s.id))?.id ?? null;
  // D74: on a touch screen the row's ⋯ is always shown and its menu also closes the session (the × needs a hover).
  const coarse = useCoarsePointer();

  // The session on screen (opened from the palette, the Inbox, a link, …) has its row scrolled into the list's view,
  // once per session: a later layout change or a scroll by hand is left alone. In a collapsed folder its folder's head
  // is revealed instead (the outermost collapsed one; the folder stays collapsed).
  useEffect(() => {
    if (currentId === null) {
      revealed.current = null;
      return;
    }
    const list = listRef.current;
    if (!list || revealed.current === currentId) return;
    const folder = arranged.folders.find((entry) => !entry.hidden && entry.folder.collapsed && entry.total.some((s) => s.id === currentId))?.folder;
    const target =
      list.querySelector<HTMLElement>(`a.sb-session[data-session-id="${CSS.escape(currentId)}"]`) ??
      (folder ? list.querySelector<HTMLElement>(`[data-folder-id="${CSS.escape(folder.id)}"]`) : null);
    if (!target) return; // not listed yet: tried again on the next render
    revealed.current = currentId;
    revealInList(list, target);
  });

  /**
   * D71 fix: while a drag is held at the list's top / bottom edge, the list scrolls
   * every frame (half the {@link dragScrollStep} per frame), until the pointer
   * leaves the edge (the next `dragover`), the list, or the drag ends. Not left to
   * the browser: WebKit has no drag auto-scroll for a scrolling box.
   */
  const scrolling = useRef<{ step: number; frame: number | null }>({ step: 0, frame: null });
  /**
   * D74: what a held drag scrolls: the list, or, in the drawer of a tablet or a
   * phone (where the whole sidebar scrolls as one, docs/responsive.md), the sidebar.
   */
  const scroller = useCallback((): HTMLElement | null => {
    const list = listRef.current;
    if (!list) return null;
    if (list.scrollHeight > list.clientHeight + 1) return list;
    return list.closest<HTMLElement>('.sb-shell[data-layout] .sb-sidebar') ?? list;
  }, []);
  const edgeScroll = useCallback((step: number): void => {
    const state = scrolling.current;
    state.step = step;
    if (step === 0) {
      if (state.frame !== null) cancelAnimationFrame(state.frame);
      state.frame = null;
      return;
    }
    if (state.frame !== null) return;
    const tick = (): void => {
      const list = scroller();
      if (!list || state.step === 0) {
        state.frame = null;
        return;
      }
      list.scrollTop += state.step / 2;
      state.frame = requestAnimationFrame(tick);
    };
    state.frame = requestAnimationFrame(tick);
  }, []);
  useEffect(() => {
    if (!drag) edgeScroll(0);
  }, [drag, edgeScroll]);
  useEffect(() => () => edgeScroll(0), [edgeScroll]);

  const endDrag = (): void => {
    setDrag(null);
    setOver(null);
  };

  /**
   * D74 · long-press drag on a touch screen (`touch-drag.ts`, `docs/responsive.md`):
   * a row or folder held still for {@link LONG_PRESS_MS} lifts (`drag` set, as a mouse
   * drag sets it) and follows the finger; the target under it is read back from its
   * `data-drop-zone` (`dropOverAt`), so the drop and its indicator are the mouse
   * drag's (`resolveDrop`, `indicatorOf`). A finger that moves first is a scroll
   * (the browser's), and no drag starts.
   */
  const touch = useRef<{ press: Press; item: DragItem; label: string; pointerId: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const [ghost, setGhost] = useState<{ readonly label: string; readonly x: number; readonly y: number } | null>(null);
  /** Until when a click is swallowed (the click a lifted row's release may send). */
  const swallowClick = useRef(0);
  const latest = useRef({ drag, over, layout, listedIds });
  latest.current = { drag, over, layout, listedIds };

  const cancelTouch = useCallback((): void => {
    const current = touch.current;
    if (current?.timer) clearTimeout(current.timer);
    touch.current = null;
    setGhost(null);
  }, []);

  const touchStart = (item: DragItem, label: string) => (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' || !event.isPrimary) return;
    // The ⋯, the × and a name field keep their own touches.
    if (event.target instanceof Element && event.target.closest('button, input, textarea')) return;
    cancelTouch();
    const start = { x: event.clientX, y: event.clientY };
    const pressed = { press: pressStart(start), item, label, pointerId: event.pointerId, timer: null as ReturnType<typeof setTimeout> | null };
    pressed.timer = setTimeout(() => {
      if (touch.current !== pressed) return;
      pressed.timer = null;
      pressed.press = pressHeld(pressed.press);
      if (pressed.press.phase !== 'dragging') return;
      setMenu(null);
      setDrag(item);
      setGhost({ label, x: start.x, y: start.y });
    }, LONG_PRESS_MS);
    touch.current = pressed;
  };

  useEffect(() => {
    const list = listRef.current;
    const dropAt = (x: number, y: number): DropOver | null => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-zone]');
      if (!el || !list?.contains(el)) return null;
      return dropOverAt(el, y);
    };
    const move = (event: globalThis.PointerEvent): void => {
      const current = touch.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (current.press.phase === 'pending') {
        current.press = pressMove(current.press, { x: event.clientX, y: event.clientY });
        if (current.press.phase === 'cancelled') cancelTouch();
        return;
      }
      if (current.press.phase !== 'dragging') return;
      setGhost({ label: current.label, x: event.clientX, y: event.clientY });
      const { layout: now, listedIds: listed, over: was } = latest.current;
      const next = dropAt(event.clientX, event.clientY);
      const valid = next && resolveDrop(now, current.item, next, listed) !== null ? next : null;
      if (!sameOver(was, valid)) setOver(valid);
      const box = scroller()?.getBoundingClientRect();
      if (box) edgeScroll(dragScrollStep(event.clientY, { top: Math.max(box.top, 0), bottom: Math.min(box.bottom, window.innerHeight) }));
    };
    const up = (event: globalThis.PointerEvent): void => {
      const current = touch.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const dragging = current.press.phase === 'dragging';
      cancelTouch();
      if (!dragging) return;
      swallowClick.current = Date.now() + 600;
      const { layout: now, listedIds: listed } = latest.current;
      const at = event.type === 'pointerup' ? dropAt(event.clientX, event.clientY) : null;
      const action = at ? resolveDrop(now, current.item, at, listed) : null;
      setDrag(null);
      setOver(null);
      edgeScroll(0);
      if (!action) return;
      if (action.kind === 'place') void run(() => api.placeSidebarSession(action.input));
      else void run(() => api.moveSidebarFolder(action.folderId, action.index, action.parentId));
    };
    // A lifted row's finger never scrolls the list (or the page); only a non-passive listener may say so.
    const hold = (event: TouchEvent): void => {
      if (touch.current?.press.phase === 'dragging' && event.cancelable) event.preventDefault();
    };
    // The long press must not open the browser's link menu or select text.
    const menu = (event: Event): void => {
      if (touch.current) event.preventDefault();
    };
    const click = (event: globalThis.MouseEvent): void => {
      if (Date.now() < swallowClick.current) {
        swallowClick.current = 0;
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    list?.addEventListener('touchmove', hold, { passive: false });
    list?.addEventListener('contextmenu', menu);
    list?.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      list?.removeEventListener('touchmove', hold);
      list?.removeEventListener('contextmenu', menu);
      list?.removeEventListener('click', click, true);
    };
  }, [cancelTouch, edgeScroll, run, scroller]);
  useEffect(() => cancelTouch, [cancelTouch]);

  const place = (input: Parameters<typeof api.placeSidebarSession>[0]): void => {
    void run(() => api.placeSidebarSession(input));
  };

  /** dragover / drop handlers of one target. */
  const target = (at: DropOver | ((event: DragEvent<HTMLElement>) => DropOver)) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!drag) return;
      const next = typeof at === 'function' ? at(event) : at;
      if (resolveDrop(layout, drag, next, listedIds) === null) {
        if (over !== null) setOver(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      if (!sameOver(over, next)) setOver(next);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!drag) return;
      const next = typeof at === 'function' ? at(event) : at;
      const action = resolveDrop(layout, drag, next, listedIds);
      event.preventDefault();
      event.stopPropagation();
      endDrag();
      if (!action) return;
      if (action.kind === 'place') place(action.input);
      else void run(() => api.moveSidebarFolder(action.folderId, action.index, action.parentId));
    },
  });

  const indicator = (at: DropOver): DropIndicator | undefined => {
    if (!drag || !over || !sameOver(over, at)) return undefined;
    return indicatorOf(layout, drag, at, listedIds) ?? undefined;
  };

  const sideAt = (event: DragEvent<HTMLElement>) => sideOf(event.clientY, event.currentTarget.getBoundingClientRect());

  /** D58: every folder in tree order with its level (the "Move to folder ▸" lists). */
  const tree = arranged.folders.map(({ folder, level }) => ({ folder, level }));

  /** D83: the ⋯ menu's Continue in a fresh session: the session's chat opens (its bar shows the progress), then the fresh session. */
  const continueFresh = (session: Session): void => {
    setMenu(null);
    markFreshAsked(session.id);
    navigate({ view: 'session', id: session.id, tab: 'chat' });
    api.freshSession(session.id).catch((error: unknown) => {
      takeFreshAsked(session.id);
      showToast({
        id: `fresh-refused-${session.id}`,
        title: 'Could not continue in a fresh session',
        sub: session.displayTitle ?? session.title ?? session.name,
        branch: '',
        text: error instanceof ApiError ? refusalText(error.status, error.body) : refusalText(0, null),
        sessionId: null,
      });
    });
  };

  const sessionMenu = (session: Session, visible: readonly string[], group: RowGroup): MenuItem[] => {
    const where = placeOf(layout, session.id);
    const items: MenuItem[] = [];
    if (where === 'pinned') items.push({ label: 'Unpin', testId: 'sidebar-menu-unpin', run: () => place({ sessionId: session.id, place: 'loose' }) });
    else items.push({ label: 'Pin', testId: 'sidebar-menu-pin', run: () => place({ sessionId: session.id, place: 'pinned' }) });
    // D71: loose sessions move up / down too (in the whole loose list: the unplaced ones, then the loose order).
    const stored = group.kind === 'pinned' ? layout.pinned : group.kind === 'loose' ? looseList(layout, listedIds) : (layout.folders.find((f) => f.id === group.folderId)?.sessionIds ?? []);
    const step = (delta: -1 | 1): void => {
      const index = stepPosition(stored, visible, session.id, delta);
      if (index === null) return;
      if (group.kind === 'pinned') place({ sessionId: session.id, place: 'pinned', index });
      else if (group.kind === 'loose') place({ sessionId: session.id, place: 'loose', index });
      else place({ sessionId: session.id, place: 'folder', folderId: group.folderId, index });
    };
    items.push({ label: 'Move up', testId: 'sidebar-menu-up', run: () => step(-1), disabled: stepPosition(stored, visible, session.id, -1) === null });
    items.push({ label: 'Move down', testId: 'sidebar-menu-down', run: () => step(1), disabled: stepPosition(stored, visible, session.id, 1) === null });
    items.push({ label: 'Move to folder ▸', testId: 'sidebar-menu-move-to-folder', keepOpen: true, run: () => setMenu((m) => (m && m.kind === 'session' ? { ...m, folders: true } : m)) });
    // D74: a touch screen has no hover to show the row's ×: closing is in the menu too.
    if (coarse) items.push({ label: CLOSE_TOOLTIP, testId: 'sidebar-menu-close', run: () => closer.request({ ...session, activity: activityOf(session.id) ?? session.activity }) });
    // D80 (ruling D80-q1): *Undo last turn* once the session has a turn; disabled with the reason when the newest turn has no checkpoint.
    const undo = session.closedAt == null ? lastTurnRevert(menuCheckpoints) : null;
    if (undo) {
      items.push({
        label: UNDO_LAST_TURN_LABEL,
        testId: 'sidebar-menu-undo-turn',
        disabled: undo.reason !== null,
        title: undo.reason ?? `Revert the files to before turn ${undo.turn} (the newest)`,
        run: () => {
          if (undo.turn !== null) openRevert({ sessionId: session.id, turn: undo.turn });
        },
      });
    }
    // D72: a hooked terminal session continues as a Switchboard-run one (on the machine whose terminal it is).
    if (offersHookedContinue(session)) {
      const title = session.displayTitle ?? session.title ?? session.name;
      items.push({ label: CONTINUE_HOOKED_LABEL, testId: 'sidebar-menu-continue-hooked', run: () => openContinueHooked({ sessionId: session.id, title, machineName: session.machine?.name ?? null }) });
    }
    // D83: continue in a fresh session (a hooked terminal session: shown disabled, its tooltip says why).
    const fresh = freshActionState(session);
    if (fresh.shown) {
      items.push({
        label: FRESH_ACTION_LABEL,
        testId: 'sidebar-menu-fresh',
        disabled: fresh.disabledReason !== null,
        ...(fresh.disabledReason ? { title: fresh.disabledReason } : {}),
        run: () => continueFresh(session),
      });
    }
    // D65: take a peer's session over to this machine, or move this machine's session to a paired machine.
    if (offersTakeover(session)) {
      const title = session.displayTitle ?? session.title ?? session.name;
      if (session.machine) {
        const peer = session.machine;
        items.push({ label: TAKE_OVER_LABEL, testId: 'sidebar-menu-takeover', run: () => openTakeover({ sessionId: session.id, targetMachine: null, machineName: peer.name, title }) });
      } else {
        for (const machine of pairedMachines.filter((entry) => entry.state === 'online')) {
          items.push({ label: moveLabel(machine.name), testId: `sidebar-menu-move-to-${machine.id}`, run: () => openTakeover({ sessionId: session.id, targetMachine: machine.id, machineName: machine.name, title }) });
        }
      }
    }
    return items;
  };

  /** A session's "Move to folder ▸": the folder tree, indented (D58); its own folder is shown, not offered. */
  const folderTargets = (session: Session): MenuItem[] => {
    const where = placeOf(layout, session.id);
    const current = where !== null && where !== 'pinned' ? where.folderId : null;
    const items: MenuItem[] = tree.map(({ folder: f, level }) =>
      f.id === current
        ? { label: `${f.name} (here)`, testId: `sidebar-menu-current-folder-${f.id}`, level, disabled: true, run: () => undefined }
        : { label: f.name, testId: `sidebar-menu-folder-${f.id}`, level, run: () => place({ sessionId: session.id, place: 'folder', folderId: f.id }) },
    );
    if (current !== null) items.push({ label: 'Out of the folder', testId: 'sidebar-menu-out-of-folder', run: () => place({ sessionId: session.id, place: 'loose' }) });
    if (items.length === 0) items.push({ label: 'No folders yet (+ in SESSIONS)', testId: 'sidebar-menu-no-folders', run: () => undefined, disabled: true });
    return items;
  };

  /** D58: "New subfolder": a name field at the end of the folder's subfolders (the folder opens if it was collapsed). */
  const startSubfolder = (folder: SidebarFolder): void => {
    if (folder.collapsed) void run(() => api.updateSidebarFolder(folder.id, { collapsed: false }));
    setCreating(folder.id);
  };

  const folderMenu = (folder: SidebarFolder): MenuItem[] => {
    const ids = childFolders(layout, parentOf(folder)).map((f) => f.id);
    const at = ids.indexOf(folder.id);
    const hasSubfolders = childFolders(layout, folder.id).length > 0;
    const view = (next: 'move' | 'delete') => () => setMenu((m) => (m && m.kind === 'folder' ? { ...m, view: next } : m));
    return [
      { label: 'Rename', testId: 'sidebar-menu-rename', run: () => setRenaming(folder.id) },
      { label: 'New subfolder', testId: 'sidebar-menu-new-subfolder', run: () => startSubfolder(folder), disabled: checkFolderParent(layout, null, folder.id) !== null },
      { label: folder.collapsed ? 'Expand' : 'Collapse', testId: 'sidebar-menu-collapse', run: () => void run(() => api.updateSidebarFolder(folder.id, { collapsed: !folder.collapsed })) },
      { label: 'Move up', testId: 'sidebar-menu-up', run: () => void run(() => api.moveSidebarFolder(folder.id, at - 1)), disabled: at <= 0 },
      { label: 'Move down', testId: 'sidebar-menu-down', run: () => void run(() => api.moveSidebarFolder(folder.id, at + 1)), disabled: at >= ids.length - 1 },
      { label: 'Move to folder ▸', testId: 'sidebar-menu-move-to-folder', keepOpen: true, run: view('move') },
      hasSubfolders
        ? { label: 'Delete folder…', testId: 'sidebar-menu-delete', keepOpen: true, run: view('delete') }
        : { label: 'Delete folder', testId: 'sidebar-menu-delete', run: () => void run(() => api.deleteSidebarFolder(folder.id)) },
    ];
  };

  /**
   * D58: a folder's "Move to folder ▸": Top level, then the folder tree without
   * the folder itself and its own subfolders (no loops); its present parent is
   * shown, not offered; a folder too deep for it is disabled.
   */
  const folderMoveTargets = (folder: SidebarFolder): MenuItem[] => {
    const parent = parentOf(folder);
    const inside = new Set([folder.id, ...descendantIds(layout, folder.id)]);
    const items: MenuItem[] = [];
    if (parent !== null) items.push({ label: 'Top level', testId: 'sidebar-menu-top-level', run: () => void run(() => api.moveSidebarFolder(folder.id, childFolders(layout, null).length, null)) });
    for (const { folder: f, level } of tree) {
      if (inside.has(f.id)) continue;
      if (f.id === parent) {
        items.push({ label: `${f.name} (here)`, testId: `sidebar-menu-current-folder-${f.id}`, level, disabled: true, run: () => undefined });
        continue;
      }
      items.push({
        label: f.name,
        testId: `sidebar-menu-folder-${f.id}`,
        level,
        disabled: checkFolderParent(layout, folder.id, f.id) !== null,
        run: () => void run(() => api.moveSidebarFolder(folder.id, childFolders(layout, f.id).length, f.id)),
      });
    }
    if (items.length === 0) items.push({ label: 'No other folders', testId: 'sidebar-menu-no-folders', run: () => undefined, disabled: true });
    return items;
  };

  /** D58: deleting a folder with subfolders asks first (nothing is lost: they move up a level). */
  const deleteConfirm = (folder: SidebarFolder): MenuItem[] => {
    const count = childFolders(layout, folder.id).length;
    const up = parentOf(folder) === null ? 'the top level' : 'its parent folder';
    return [
      { label: `Delete: ${count} subfolder${count === 1 ? '' : 's'} and the sessions move to ${up}`, testId: 'sidebar-menu-delete-confirm', run: () => void run(() => api.deleteSidebarFolder(folder.id)) },
      { label: 'Cancel', testId: 'sidebar-menu-delete-cancel', keepOpen: true, run: () => setMenu((m) => (m && m.kind === 'folder' ? { ...m, view: 'main' } : m)) },
    ];
  };

  const row = (session: Session, group: RowGroup, visible: readonly string[], level = 0): ReactNode => {
    const activity = activityOf(session.id);
    // D71: a loose row is a drop target of its own too (before / after it: the loose sessions' manual order).
    const at = (event: DragEvent<HTMLElement>): DropOver => ({ zone: 'row', group, sessionId: session.id, side: sideAt(event) });
    const shown: DropOver | null = over && over.zone === 'row' && over.sessionId === session.id ? over : null;
    return (
      <Link
        key={session.id}
        to={{ view: 'session', id: session.id, tab: 'chat' }}
        className="sb-session"
        data-session-id={session.id}
        data-group={group.kind}
        data-group-folder={group.kind === 'folder' ? group.folderId : undefined}
        data-drop-zone="row"
        data-drop={shown ? indicator(shown) : undefined}
        data-dragging={drag?.kind === 'session' && drag.id === session.id ? 'true' : undefined}
        aria-current={isCurrent(session.id) ? 'page' : undefined}
        // D58: a subfolder's sessions sit one step further in per level.
        style={level > 0 ? ({ marginLeft: 12 + level * LEVEL_INDENT } satisfies CSSProperties) : undefined}
        draggable
        onDragStart={(event) => {
          // D74: a touch press drags by long press (below); the browser's own touch drag is not used.
          if (touch.current) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/x-switchboard-session', session.id);
          setMenu(null);
          setDrag({ kind: 'session', id: session.id });
        }}
        onDragEnd={endDrag}
        onPointerDown={touchStart({ kind: 'session', id: session.id }, displayTitle(session))}
        {...target(at)}
      >
        {/* D30: waiting on background work reads as working: the running color, pulsing. */}
        <span className="sb-session-dot" data-activity={activity?.state} style={{ background: statusColor(activity?.state === 'background' ? 'run' : session.status) }} />
        <div className="sb-session-body">
          <div className="sb-session-head">
            {/* D22: the display title; a double-click renames it in place. */}
            <InlineTitle session={session} gesture="double-click" className="sb-session-name" />
            {/* D24: reachable from the phone (Remote Control on a live process). */}
            {session.remote?.enabled && session.live ? (
              <span className="sb-session-remote" data-testid="session-remote-glyph" title="Remote Control on: reachable from claude.ai and the Claude app">
                <PhoneGlyph title="Remote Control on" />
              </span>
            ) : null}
            {/* D68: the session's open todos. */}
            {session.openTodoCount ? (
              <span className="sb-session-todos" data-testid="session-todo-count" title={`${session.openTodoCount} open todo${session.openTodoCount === 1 ? '' : 's'}`}>
                ☐ {session.openTodoCount}
              </span>
            ) : null}
            <span className="sb-session-age">{formatAge(session.lastActivityAt ?? session.createdAt, now)}</span>
          </div>
          <div className="sb-session-mode">
            {/* D48: a peer's session carries its machine's tag (and "unreachable" while it is offline). */}
            <MachineTag machine={session.machine} />
            {/* D62 P6: the session's CLI (rows carry it once the list mixes CLIs). */}
            {cliBadge?.(session) ? (
              <span className="sb-cli-badge" data-testid="session-cli-badge" data-provider={session.provider ?? 'claude'}>
                {cliBadge(session)}
              </span>
            ) : null}
            <FolderTag name={tagOf(session)} title={session.folderPath} />
            <SessionActivityOr activity={activity}>{modeLine(session)}</SessionActivityOr>
          </div>
        </div>
        {/* D33: after the row's own parts, so the prototype's child paths (dot, body) are unchanged. */}
        <SessionCloseButton session={session} busy={closer.busyId === session.id} onClose={() => closer.request({ ...session, activity: activity ?? session.activity })} />
        {/* D54: the row's menu (Pin, Move up / down, Move to folder), next to the ×. */}
        <MenuButton
          label={`More for ${displayTitle(session)}`}
          testId="sidebar-session-menu"
          className="sb-session-more"
          onOpen={(anchor) => setMenu({ kind: 'session', id: session.id, anchor, folders: false, group, visible })}
        />
      </Link>
    );
  };

  const wrap = (items: MenuItem[]): MenuItem[] =>
    items.map((item) => ({
      ...item,
      run: () => {
        item.run();
        if (!item.keepOpen) setMenu(null);
      },
    }));

  const menuItems = ((): { label: string; items: MenuItem[] } | null => {
    if (!menu) return null;
    if (menu.kind === 'session') {
      const session = sessions.find((s) => s.id === menu.id);
      if (!session) return null;
      const items = menu.folders ? folderTargets(session) : sessionMenu(session, menu.visible, menu.group);
      return { label: `${displayTitle(session)}: sidebar`, items: wrap(items) };
    }
    const folder = layout.folders.find((f) => f.id === menu.id);
    if (!folder) return null;
    const items = menu.view === 'move' ? folderMoveTargets(folder) : menu.view === 'delete' ? deleteConfirm(folder) : folderMenu(folder);
    return { label: `Folder ${folder.name}`, items: wrap(items) };
  })();
  const menuView = menu ? (menu.kind === 'session' ? (menu.folders ? 'f' : '') : menu.view) : '';
  const openMenu = menu && menuItems ? <Menu key={`${menu.kind}:${menu.id}:${menuView}`} anchor={menu.anchor} label={menuItems.label} items={menuItems.items} onClose={closeMenu} /> : null;

  const pinnedIds = arranged.pinned.map((s) => s.id);
  const looseIds = arranged.loose.map((s) => s.id);
  const draggedFolder = drag?.kind === 'folder' ? layout.folders.find((f) => f.id === drag.id) : undefined;
  const draggingPlaced = drag?.kind === 'session' && placeOf(layout, drag.id) !== null;
  // D58: a subfolder dragged out goes to the top level from the same zone.
  const draggingNested = draggedFolder !== undefined && parentOf(draggedFolder) !== null;
  const showPinnedHead = arranged.pinned.length > 0 || drag?.kind === 'session';
  const pinnedHead: DropOver = { zone: 'pinned-head' };
  const looseZone: DropOver = { zone: 'loose' };

  /** A folder name field for a new folder in `parentId` (`null` = the top level). */
  const newFolderField = (parentId: string | null, level: number): ReactNode => (
    <div key={`new-folder:${parentId ?? ''}`} className="sb-folder sb-folder-new" style={level > 0 ? { marginLeft: level * LEVEL_INDENT } : undefined}>
      <FolderNameField
        initial={NEW_FOLDER_NAME}
        label={parentId === null ? 'New folder name' : 'New subfolder name'}
        testId="sidebar-new-folder-name"
        saveOnBlur={false}
        onSave={(name) => {
          setCreating(undefined);
          void run(() => api.createSidebarFolder(name, parentId));
        }}
        onCancel={() => setCreating(undefined)}
      />
    </div>
  );

  const byParent = new Map<string | null, Array<ArrangedFolder<Session>>>();
  for (const entry of arranged.folders) {
    const parent = parentOf(entry.folder);
    byParent.set(parent, [...(byParent.get(parent) ?? []), entry]);
  }

  /** One folder: its head, then (open) its subfolders, a new subfolder's field, and its sessions (D58). */
  const renderFolder = ({ folder, sessions: inside, level, total }: ArrangedFolder<Session>): ReactNode[] => {
    const headAt = (event: DragEvent<HTMLElement>): DropOver => ({ zone: 'folder-head', folderId: folder.id, side: folderSideOf(event.clientY, event.currentTarget.getBoundingClientRect()) });
    const shown = over && over.zone === 'folder-head' && over.folderId === folder.id ? over : null;
    const visible = inside.map((s) => s.id);
    const toggle = (): void => void run(() => api.updateSidebarFolder(folder.id, { collapsed: !folder.collapsed }));
    const head = (
      <div
        key={`folder:${folder.id}`}
        className="sb-folder"
        data-testid="sidebar-folder"
        data-folder-id={folder.id}
        data-parent-id={parentOf(folder) ?? undefined}
        data-level={level}
        data-collapsed={folder.collapsed ? 'true' : 'false'}
        data-drop-zone="folder-head"
        data-drop={shown ? indicator(shown) : undefined}
        data-dragging={drag?.kind === 'folder' && drag.id === folder.id ? 'true' : undefined}
        style={level > 0 ? { marginLeft: level * LEVEL_INDENT } : undefined}
        draggable={renaming !== folder.id}
        onDragStart={(event) => {
          event.stopPropagation();
          if (touch.current) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/x-switchboard-folder', folder.id);
          setMenu(null);
          setDrag({ kind: 'folder', id: folder.id });
        }}
        onDragEnd={endDrag}
        onPointerDown={renaming === folder.id ? undefined : touchStart({ kind: 'folder', id: folder.id }, folder.name)}
        onClick={toggle}
        {...target(headAt)}
      >
        <button
          type="button"
          className="sb-button sb-folder-toggle"
          data-testid="sidebar-folder-toggle"
          aria-expanded={!folder.collapsed}
          aria-label={`${folder.collapsed ? 'Expand' : 'Collapse'} ${folder.name}`}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false">
            <path d="M2 1.5L5.5 4 2 6.5" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {renaming === folder.id ? (
          <FolderNameField
            initial={folder.name}
            label="Folder name"
            testId="sidebar-folder-rename"
            saveOnBlur
            onSave={(name) => {
              setRenaming(null);
              if (name !== folder.name) void run(() => api.updateSidebarFolder(folder.id, { name }));
            }}
            onCancel={() => setRenaming(null)}
          />
        ) : (
          <span className="sb-folder-name" data-testid="sidebar-folder-name" title={folder.name}>
            {folder.name}
          </span>
        )}
        {/* D58: anything inside, at any depth. */}
        {folder.collapsed && needsYou(total) ? <span className="sb-folder-need" data-testid="sidebar-folder-need" title="A session in this folder waits for you" /> : null}
        {/* D58: its sessions and those of its subfolders. */}
        <span className="sb-folder-count" data-testid="sidebar-folder-count">
          {total.length}
        </span>
        <MenuButton label={`More for folder ${folder.name}`} testId="sidebar-folder-menu" className="sb-folder-more" onOpen={(anchor) => setMenu({ kind: 'folder', id: folder.id, anchor, view: 'main' })} />
      </div>
    );
    if (folder.collapsed && creating !== folder.id) return [head];
    return [
      head,
      ...(byParent.get(folder.id) ?? []).flatMap(renderFolder),
      ...(creating === folder.id ? [newFolderField(folder.id, level + 1)] : []),
      ...inside.map((session) => row(session, { kind: 'folder', folderId: folder.id }, visible, level)),
    ];
  };

  return (
    <>
      <div className="sb-section-label">
        Sessions
        <span className="sb-section-count">{loaded ? String(sessions.length) : ''}</span>
        {/* D54: drawn, not text, so the label's copy stays the prototype's. */}
        <button type="button" className="sb-button sb-folder-add" data-testid="sidebar-new-folder" aria-label="New folder" title="New folder" onClick={() => setCreating(null)}>
          <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true" focusable="false">
            <path d="M5.5 1.5v8M1.5 5.5h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div
        ref={listRef}
        className="sb-sessions"
        data-testid="sidebar-sessions"
        data-dragging={drag ? drag.kind : undefined}
        data-touch-drag={ghost ? 'true' : undefined}
        // D71 fix: a drag held near the list's top / bottom edge scrolls it (every engine; WebKit has no drag auto-scroll here).
        onDragOverCapture={(event) => {
          if (drag) edgeScroll(dragScrollStep(event.clientY, event.currentTarget.getBoundingClientRect()));
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setOver(null);
            edgeScroll(0);
          }
        }}
      >
        {showPinnedHead ? (
          <div className="sb-group-label" data-testid="sidebar-pinned-head" data-drop-zone="pinned-head" data-drop={indicator(pinnedHead)} {...target(pinnedHead)}>
            Pinned
            {arranged.pinned.length === 0 ? <span className="sb-group-hint">drop here to pin</span> : null}
          </div>
        ) : null}
        {arranged.pinned.map((session) => row(session, { kind: 'pinned' }, pinnedIds))}
        {(byParent.get(null) ?? []).flatMap(renderFolder)}
        {creating === null ? newFolderField(null, 0) : null}
        {draggingPlaced || draggingNested ? (
          <div className="sb-group-label sb-loose-zone" data-testid="sidebar-loose-zone" data-drop-zone="loose" data-drop={indicator(looseZone)} {...target(looseZone)}>
            <span className="sb-group-hint">{draggingNested ? 'drop here to move to the top level' : 'drop here to unpin / take out of the folder'}</span>
          </div>
        ) : null}
        {arranged.loose.map((session) => row(session, { kind: 'loose' }, looseIds))}
      </div>
      {openMenu}
      {/* D74: the lifted row's label under the finger. */}
      {ghost
        ? createPortal(
            <div className="sb-touch-ghost" data-testid="sidebar-touch-ghost" aria-hidden="true" style={{ left: ghost.x, top: ghost.y }}>
              {ghost.label}
            </div>,
            document.body,
          )
        : null}
      {error ? (
        <div className="sb-session-close-error" role="alert" data-testid="sidebar-layout-error">
          {error}
        </div>
      ) : null}
    </>
  );
}
