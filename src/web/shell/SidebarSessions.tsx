import { type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Session, SessionActivity } from '../../core/api.ts';
import { CLOSE_TOOLTIP } from '../../core/session-close.ts';
import { displayTitle } from '../../core/session-title.ts';
import {
  EMPTY_SIDEBAR_LAYOUT,
  NEW_FOLDER_NAME,
  SIDEBAR_FOLDER_NAME_MAX,
  type SidebarFolder,
  type SidebarLayout,
  arrangeSidebar,
  needsYou,
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
import { Link } from '../router.tsx';
import { formatAge, modeLine, statusColor } from './format.ts';
import { type DragItem, type DropIndicator, type DropOver, type RowGroup, indicatorOf, resolveDrop, sameOver, sideOf } from './sidebar-dnd.ts';
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
}

/**
 * D54: a small menu over the page (a portal, so it never sits inside a row's
 * link), under its ⋯ button: ↑ / ↓ move between the items, Esc closes and gives
 * the focus back to the button, a click outside closes it.
 */
function Menu({ anchor, label, items, onClose }: { readonly anchor: HTMLElement; readonly label: string; readonly items: readonly MenuItem[]; readonly onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const rect = anchor.getBoundingClientRect();
  const width = 196;
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  const top = Math.min(rect.bottom + 4, window.innerHeight - 40);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, []);
  useEffect(() => {
    const outside = (event: globalThis.MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
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

/** Which menu is open. */
type OpenMenu =
  | { readonly kind: 'session'; readonly id: string; readonly anchor: HTMLElement; readonly folders: boolean; readonly group: RowGroup; readonly visible: readonly string[] }
  | { readonly kind: 'folder'; readonly id: string; readonly anchor: HTMLElement };

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
 * each collapsible, one level), then the loose sessions in the service's order
 * (newest first, as before D54). With nothing pinned and no folder the list is
 * exactly the prototype's rows. Sessions and folders move by drag and drop and by
 * each row's / folder's ⋯ menu (Pin / Unpin, Move up / down, Move to folder…),
 * the keyboard path. The label's drawn "+" creates a folder. The layout is
 * stored by the service and live in every tab (`sidebarLayoutChanged`).
 */
export function SidebarSessions({ sessions, loaded, activityOf, closer, isCurrent, tagOf, now }: SidebarSessionsProps) {
  const { layout, run, error } = useSidebarLayout();
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [over, setOver] = useState<DropOver | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const arranged = arrangeSidebar(sessions, layout);
  const closeMenu = useCallback(() => setMenu(null), []);

  const endDrag = (): void => {
    setDrag(null);
    setOver(null);
  };

  const place = (input: Parameters<typeof api.placeSidebarSession>[0]): void => {
    void run(() => api.placeSidebarSession(input));
  };

  /** dragover / drop handlers of one target. */
  const target = (at: DropOver | ((event: DragEvent<HTMLElement>) => DropOver)) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!drag) return;
      const next = typeof at === 'function' ? at(event) : at;
      if (resolveDrop(layout, drag, next) === null) {
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
      const action = resolveDrop(layout, drag, next);
      event.preventDefault();
      event.stopPropagation();
      endDrag();
      if (!action) return;
      if (action.kind === 'place') place(action.input);
      else void run(() => api.moveSidebarFolder(action.folderId, action.index));
    },
  });

  const indicator = (at: DropOver): DropIndicator | undefined => {
    if (!drag || !over || !sameOver(over, at)) return undefined;
    return indicatorOf(layout, drag, at) ?? undefined;
  };

  const sideAt = (event: DragEvent<HTMLElement>) => sideOf(event.clientY, event.currentTarget.getBoundingClientRect());

  const sessionMenu = (session: Session, visible: readonly string[], group: RowGroup): MenuItem[] => {
    const where = placeOf(layout, session.id);
    const items: MenuItem[] = [];
    if (where === 'pinned') items.push({ label: 'Unpin', testId: 'sidebar-menu-unpin', run: () => place({ sessionId: session.id, place: 'loose' }) });
    else items.push({ label: 'Pin', testId: 'sidebar-menu-pin', run: () => place({ sessionId: session.id, place: 'pinned' }) });
    if (group.kind !== 'loose') {
      const stored = group.kind === 'pinned' ? layout.pinned : (layout.folders.find((f) => f.id === group.folderId)?.sessionIds ?? []);
      const step = (delta: -1 | 1): void => {
        const index = stepPosition(stored, visible, session.id, delta);
        if (index === null) return;
        place(group.kind === 'pinned' ? { sessionId: session.id, place: 'pinned', index } : { sessionId: session.id, place: 'folder', folderId: group.folderId, index });
      };
      items.push({ label: 'Move up', testId: 'sidebar-menu-up', run: () => step(-1), disabled: stepPosition(stored, visible, session.id, -1) === null });
      items.push({ label: 'Move down', testId: 'sidebar-menu-down', run: () => step(1), disabled: stepPosition(stored, visible, session.id, 1) === null });
    }
    items.push({ label: 'Move to folder ▸', testId: 'sidebar-menu-move-to-folder', run: () => setMenu((m) => (m && m.kind === 'session' ? { ...m, folders: true } : m)) });
    return items;
  };

  const folderTargets = (session: Session): MenuItem[] => {
    const where = placeOf(layout, session.id);
    const current = where !== null && where !== 'pinned' ? where.folderId : null;
    const items: MenuItem[] = layout.folders
      .filter((f) => f.id !== current)
      .map((f) => ({ label: f.name, testId: `sidebar-menu-folder-${f.id}`, run: () => place({ sessionId: session.id, place: 'folder', folderId: f.id }) }));
    if (current !== null) items.push({ label: 'Out of the folder', testId: 'sidebar-menu-out-of-folder', run: () => place({ sessionId: session.id, place: 'loose' }) });
    if (items.length === 0) items.push({ label: 'No folders yet (+ in SESSIONS)', testId: 'sidebar-menu-no-folders', run: () => undefined, disabled: true });
    return items;
  };

  const folderMenu = (folder: SidebarFolder): MenuItem[] => {
    const ids = layout.folders.map((f) => f.id);
    const at = ids.indexOf(folder.id);
    return [
      { label: 'Rename', testId: 'sidebar-menu-rename', run: () => setRenaming(folder.id) },
      { label: folder.collapsed ? 'Expand' : 'Collapse', testId: 'sidebar-menu-collapse', run: () => void run(() => api.updateSidebarFolder(folder.id, { collapsed: !folder.collapsed })) },
      { label: 'Move up', testId: 'sidebar-menu-up', run: () => void run(() => api.moveSidebarFolder(folder.id, at - 1)), disabled: at <= 0 },
      { label: 'Move down', testId: 'sidebar-menu-down', run: () => void run(() => api.moveSidebarFolder(folder.id, at + 1)), disabled: at >= ids.length - 1 },
      { label: 'Delete folder', testId: 'sidebar-menu-delete', run: () => void run(() => api.deleteSidebarFolder(folder.id)) },
    ];
  };

  const row = (session: Session, group: RowGroup, visible: readonly string[]): ReactNode => {
    const activity = activityOf(session.id);
    const at: (event: DragEvent<HTMLElement>) => DropOver =
      group.kind === 'loose' ? () => ({ zone: 'loose' }) : (event) => ({ zone: 'row', group, sessionId: session.id, side: sideAt(event) });
    const shown: DropOver | null = over && over.zone === 'row' && over.sessionId === session.id ? over : null;
    return (
      <Link
        key={session.id}
        to={{ view: 'session', id: session.id, tab: 'chat' }}
        className="sb-session"
        data-session-id={session.id}
        data-group={group.kind}
        data-drop={shown ? indicator(shown) : undefined}
        data-dragging={drag?.kind === 'session' && drag.id === session.id ? 'true' : undefined}
        aria-current={isCurrent(session.id) ? 'page' : undefined}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/x-switchboard-session', session.id);
          setMenu(null);
          setDrag({ kind: 'session', id: session.id });
        }}
        onDragEnd={endDrag}
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
            <span className="sb-session-age">{formatAge(session.lastActivityAt ?? session.createdAt, now)}</span>
          </div>
          <div className="sb-session-mode">
            {/* D48: a peer's session carries its machine's tag (and "unreachable" while it is offline). */}
            <MachineTag machine={session.machine} />
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

  const menuItems = ((): { label: string; items: MenuItem[] } | null => {
    if (!menu) return null;
    if (menu.kind === 'session') {
      const session = sessions.find((s) => s.id === menu.id);
      if (!session) return null;
      const items = menu.folders ? folderTargets(session) : sessionMenu(session, menu.visible, menu.group);
      return { label: `${displayTitle(session)}: sidebar`, items: items.map((item) => ({ ...item, run: () => { item.run(); if (item.testId !== 'sidebar-menu-move-to-folder') setMenu(null); } })) };
    }
    const folder = layout.folders.find((f) => f.id === menu.id);
    if (!folder) return null;
    return { label: `Folder ${folder.name}`, items: folderMenu(folder).map((item) => ({ ...item, run: () => { item.run(); setMenu(null); } })) };
  })();
  const openMenu = menu && menuItems ? <Menu key={`${menu.kind}:${menu.id}:${menu.kind === 'session' && menu.folders ? 'f' : ''}`} anchor={menu.anchor} label={menuItems.label} items={menuItems.items} onClose={closeMenu} /> : null;

  const pinnedIds = arranged.pinned.map((s) => s.id);
  const draggingPlaced = drag?.kind === 'session' && placeOf(layout, drag.id) !== null;
  const showPinnedHead = arranged.pinned.length > 0 || drag?.kind === 'session';
  const pinnedHead: DropOver = { zone: 'pinned-head' };
  const looseZone: DropOver = { zone: 'loose' };

  return (
    <>
      <div className="sb-section-label">
        Sessions
        <span className="sb-section-count">{loaded ? String(sessions.length) : ''}</span>
        {/* D54: drawn, not text, so the label's copy stays the prototype's. */}
        <button type="button" className="sb-button sb-folder-add" data-testid="sidebar-new-folder" aria-label="New folder" title="New folder" onClick={() => setCreating(true)}>
          <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true" focusable="false">
            <path d="M5.5 1.5v8M1.5 5.5h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div
        className="sb-sessions"
        data-testid="sidebar-sessions"
        data-dragging={drag ? drag.kind : undefined}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
        }}
      >
        {showPinnedHead ? (
          <div className="sb-group-label" data-testid="sidebar-pinned-head" data-drop={indicator(pinnedHead)} {...target(pinnedHead)}>
            Pinned
            {arranged.pinned.length === 0 ? <span className="sb-group-hint">drop here to pin</span> : null}
          </div>
        ) : null}
        {arranged.pinned.map((session) => row(session, { kind: 'pinned' }, pinnedIds))}
        {arranged.folders.map(({ folder, sessions: inside }) => {
          const headAt = (event: DragEvent<HTMLElement>): DropOver => ({ zone: 'folder-head', folderId: folder.id, side: sideAt(event) });
          const shown = over && over.zone === 'folder-head' && over.folderId === folder.id ? over : null;
          const visible = inside.map((s) => s.id);
          const toggle = (): void => void run(() => api.updateSidebarFolder(folder.id, { collapsed: !folder.collapsed }));
          return [
            <div
              key={`folder:${folder.id}`}
              className="sb-folder"
              data-testid="sidebar-folder"
              data-folder-id={folder.id}
              data-collapsed={folder.collapsed ? 'true' : 'false'}
              data-drop={shown ? indicator(shown) : undefined}
              data-dragging={drag?.kind === 'folder' && drag.id === folder.id ? 'true' : undefined}
              draggable={renaming !== folder.id}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/x-switchboard-folder', folder.id);
                setMenu(null);
                setDrag({ kind: 'folder', id: folder.id });
              }}
              onDragEnd={endDrag}
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
              {folder.collapsed && needsYou(inside) ? <span className="sb-folder-need" data-testid="sidebar-folder-need" title="A session in this folder waits for you" /> : null}
              <span className="sb-folder-count" data-testid="sidebar-folder-count">
                {inside.length}
              </span>
              <MenuButton label={`More for folder ${folder.name}`} testId="sidebar-folder-menu" className="sb-folder-more" onOpen={(anchor) => setMenu({ kind: 'folder', id: folder.id, anchor })} />
            </div>,
            ...(folder.collapsed ? [] : inside.map((session) => row(session, { kind: 'folder', folderId: folder.id }, visible))),
          ];
        })}
        {creating ? (
          <div className="sb-folder sb-folder-new">
            <FolderNameField
              initial={NEW_FOLDER_NAME}
              label="New folder name"
              testId="sidebar-new-folder-name"
              saveOnBlur={false}
              onSave={(name) => {
                setCreating(false);
                void run(() => api.createSidebarFolder(name));
              }}
              onCancel={() => setCreating(false)}
            />
          </div>
        ) : null}
        {draggingPlaced ? (
          <div className="sb-group-label sb-loose-zone" data-testid="sidebar-loose-zone" data-drop={indicator(looseZone)} {...target(looseZone)}>
            <span className="sb-group-hint">drop here to unpin / take out of the folder</span>
          </div>
        ) : null}
        {arranged.loose.map((session) => row(session, { kind: 'loose' }, []))}
      </div>
      {openMenu}
      {error ? (
        <div className="sb-session-close-error" role="alert" data-testid="sidebar-layout-error">
          {error}
        </div>
      ) : null}
    </>
  );
}
