import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionTodo, SessionTodoList, TodoGroup, TodoState } from '../../core/api.ts';
import { BOARD_COLUMNS, BOARD_COLUMN_LABELS, type BoardCard, type BoardFilters, NO_BOARD_FILTERS, boardCanDrop, boardColumns, boardDrop, boardFolderOf } from '../../core/todo-board.ts';
import { todoActualsTotalLabel } from '../../core/todo-actuals.ts';
import { TODO_PRIORITIES, TODO_PRIORITY_LABELS, isTodoPriority, moveTodo, todoMoveScope } from '../../core/todos.ts';
import { api } from '../api/client.ts';
import { LONG_PRESS_MS, type Press, pressHeld, pressMove, pressStart } from '../shell/touch-drag.ts';
import { useLayout } from '../shell/useLayout.ts';
import { TodoCard, type TodoRunSession } from './session/TodoCard.tsx';
import { savePatch } from './session/TodoStrip.tsx';
import './todo-board.css';

/** The mouse moves this far before a press becomes a drag (a click stays a click). */
const MOUSE_SLOP_PX = 4;

/** Where a group's session works (its solutions, else its folder's name). */
function placeOf(group: TodoGroup): string {
  if (group.solutions.length > 0) return group.solutions.join(' · ');
  const parts = (group.folderPath ?? '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** The phone's column (one column per screen width, swiped sideways), kept in this browser. */
const PHONE_COLUMN_KEY = 'sb.todos.boardColumn';

function readPhoneColumn(): TodoState {
  try {
    const value = window.localStorage.getItem(PHONE_COLUMN_KEY);
    return (BOARD_COLUMNS as readonly string[]).includes(value ?? '') ? (value as TodoState) : 'open';
  } catch {
    return 'open';
  }
}

/** A drag in progress: the card, the pointer, its phase (a touch waits for the long press). */
interface Drag {
  readonly card: BoardCard;
  readonly pointerId: number;
  readonly touch: boolean;
  press: Press;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * D77 · the Todos page's **Board** (`docs/todos.md` → *Board*): columns **Open · In progress ·
 * Review · Done** across every session (this machine's and the paired machines'), the cards as on
 * the list (compact) and labelled with their session; filters (priority, machine, folder, session)
 * and a search. **Dragging** a card into another column changes its state (`boardDrop`): Open ↔ In
 * progress without sending anything, Done means done (the review is skipped), Review only for an
 * item run in its own session; within a column the order is priority, then session, then position.
 * The mouse drags after a few pixels; a touch screen lifts the card after a long press (D74, the
 * sidebar's rule); the card's ⋯ → **Move to** does the same without dragging. On phones (ruling
 * 2026-10-08) the columns are **swipeable**: one column per screen width (scroll snap), with a tab
 * strip (the names and counts) that follows the swipe and scrolls to a column when tapped; a card
 * moves with ⋯ → Move to, or by a long-press drag onto a tab. The last column is kept.
 * Under it, the per-session totals of the completed items' actual vs. estimate (D78).
 */
export function TodoBoard({
  groups,
  run,
  now,
  working,
  runSessionOf,
  onStart,
  onRun,
}: {
  readonly groups: readonly TodoGroup[];
  readonly run: (write: () => Promise<SessionTodoList>) => Promise<boolean>;
  readonly now: number;
  readonly working: ReadonlySet<string>;
  readonly runSessionOf: (id: string | null | undefined) => TodoRunSession | null;
  readonly onStart: (group: TodoGroup, todo: SessionTodo) => void;
  readonly onRun: (group: TodoGroup, todo: SessionTodo) => void;
}) {
  const [filters, setFilters] = useState<BoardFilters>(NO_BOARD_FILTERS);
  const columns = useMemo(() => boardColumns(groups, filters), [groups, filters]);
  const layout = useLayout();
  const phone = layout === 'phone';
  const [phoneColumn, setPhoneColumn] = useState<TodoState>(readPhoneColumn);
  const columnsRef = useRef<HTMLDivElement | null>(null);
  const keepColumn = (state: TodoState): void => {
    setPhoneColumn(state);
    try {
      window.localStorage.setItem(PHONE_COLUMN_KEY, state);
    } catch {
      // Private mode: not remembered.
    }
  };
  /** Scrolls the swipeable columns to `state`'s column. */
  const scrollToColumn = useCallback((state: TodoState, smooth: boolean): void => {
    const strip = columnsRef.current;
    const target = strip?.querySelector<HTMLElement>(`[data-board-column="${state}"]`);
    if (!strip || !target) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const left = target.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
    strip.scrollTo({ left, behavior: smooth && !reduce ? 'smooth' : 'auto' });
  }, []);
  const pickColumn = (state: TodoState): void => {
    keepColumn(state);
    scrollToColumn(state, true);
  };
  // A phone opens on the kept column.
  useEffect(() => {
    if (phone) scrollToColumn(readPhoneColumn(), false);
  }, [phone, scrollToColumn]);
  /** The swipe settled on a column: the tab strip follows. */
  const onSwipe = (): void => {
    const strip = columnsRef.current;
    if (!strip) return;
    let best: TodoState | null = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const el of strip.querySelectorAll<HTMLElement>('[data-board-column]')) {
      const gap = Math.abs(el.getBoundingClientRect().left - strip.getBoundingClientRect().left);
      if (gap < distance) {
        distance = gap;
        best = (el.dataset['boardColumn'] as TodoState | undefined) ?? null;
      }
    }
    if (best && best !== phoneColumn) keepColumn(best);
  };

  const machines = useMemo(() => {
    const seen = new Map<string, string>();
    for (const group of groups) if (group.machine) seen.set(group.machine.id, group.machine.name);
    return [...seen.entries()];
  }, [groups]);
  const folders = useMemo(() => [...new Set(groups.map(boardFolderOf).filter((folder) => folder !== ''))].sort(), [groups]);

  const move = useCallback(
    (card: BoardCard, to: TodoState): void => {
      const patch = boardDrop(card.todo, to);
      if (patch) void run(() => api.updateTodo(card.group.sessionId, card.todo.id, patch));
    },
    [run],
  );

  // ── drag (pointer events: the mouse after a few pixels, a touch after the long press) ──
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  const [over, setOver] = useState<TodoState | null>(null);
  const [ghost, setGhost] = useState<{ readonly label: string; readonly x: number; readonly y: number } | null>(null);
  const swallowClick = useRef(0);
  const board = useRef<HTMLDivElement | null>(null);

  const cancel = useCallback((): void => {
    const current = drag.current;
    if (current?.timer) clearTimeout(current.timer);
    drag.current = null;
    setDragging(null);
    setOver(null);
    setGhost(null);
  }, []);

  const columnAt = (x: number, y: number): TodoState | null => {
    // A column, or (phones) a column's tab.
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-board-column], [data-board-drop]');
    const state = el?.dataset['boardColumn'] ?? el?.dataset['boardDrop'];
    return state && (BOARD_COLUMNS as readonly string[]).includes(state) ? (state as TodoState) : null;
  };

  const press = (card: BoardCard, disabled: boolean) => (event: PointerEvent<HTMLElement>) => {
    if (disabled || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    // The card's own controls keep their clicks.
    if (event.target instanceof Element && event.target.closest('button, a, input, textarea, select, [role="menu"]')) return;
    cancel();
    const touch = event.pointerType !== 'mouse';
    const start = { x: event.clientX, y: event.clientY };
    const pressed: Drag = { card, pointerId: event.pointerId, touch, press: pressStart(start), timer: null };
    if (touch) {
      pressed.timer = setTimeout(() => {
        if (drag.current !== pressed) return;
        pressed.timer = null;
        pressed.press = pressHeld(pressed.press);
        if (pressed.press.phase !== 'dragging') return;
        setDragging(card);
        setGhost({ label: card.todo.title, x: start.x, y: start.y });
      }, LONG_PRESS_MS);
    }
    drag.current = pressed;
  };

  useEffect(() => {
    const moveTo = (event: globalThis.PointerEvent): void => {
      const current = drag.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const at = { x: event.clientX, y: event.clientY };
      if (current.press.phase === 'pending') {
        if (current.touch) {
          current.press = pressMove(current.press, at);
          if (current.press.phase === 'cancelled') cancel();
          return;
        }
        if (Math.hypot(at.x - current.press.start.x, at.y - current.press.start.y) <= MOUSE_SLOP_PX) return;
        current.press = pressHeld(current.press);
        setDragging(current.card);
      }
      if (current.press.phase !== 'dragging') return;
      setGhost({ label: current.card.todo.title, x: at.x, y: at.y });
      const column = columnAt(at.x, at.y);
      setOver(column && boardCanDrop(current.card.todo, column) ? column : null);
    };
    const up = (event: globalThis.PointerEvent): void => {
      const current = drag.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const lifted = current.press.phase === 'dragging';
      const column = lifted && event.type === 'pointerup' ? columnAt(event.clientX, event.clientY) : null;
      cancel();
      if (!lifted) return;
      swallowClick.current = Date.now() + 600;
      if (column) move(current.card, column);
    };
    // A lifted card's finger never scrolls the board; only a non-passive listener may say so.
    const hold = (event: TouchEvent): void => {
      if (drag.current?.press.phase === 'dragging' && event.cancelable) event.preventDefault();
    };
    const menu = (event: Event): void => {
      if (drag.current?.touch) event.preventDefault();
    };
    const click = (event: globalThis.MouseEvent): void => {
      if (Date.now() < swallowClick.current) {
        swallowClick.current = 0;
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const root = board.current;
    window.addEventListener('pointermove', moveTo);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    root?.addEventListener('touchmove', hold, { passive: false });
    root?.addEventListener('contextmenu', menu);
    root?.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('pointermove', moveTo);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      root?.removeEventListener('touchmove', hold);
      root?.removeEventListener('contextmenu', menu);
      root?.removeEventListener('click', click, true);
    };
  }, [cancel, move]);
  useEffect(() => cancel, [cancel]);

  const totals = groups.filter((group) => todoActualsTotalLabel(group.actuals) !== '');

  return (
    <div className="sb-board" data-testid="todo-board" data-dragging={dragging ? 'true' : undefined} ref={board}>
      <div className="sb-board-filters" role="search" aria-label="Filter the board">
        <input
          type="search"
          className="sb-board-search"
          data-testid="board-search"
          placeholder="Search todos"
          aria-label="Search todos"
          value={filters.search}
          onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
        />
        <select
          className="sb-board-filter"
          data-testid="board-filter-priority"
          aria-label="Priority"
          value={filters.priority}
          onChange={(event) => setFilters((current) => ({ ...current, priority: isTodoPriority(event.target.value) ? event.target.value : 'all' }))}
        >
          <option value="all">Any priority</option>
          {TODO_PRIORITIES.map((level) => (
            <option key={level} value={level}>
              {TODO_PRIORITY_LABELS[level]}
            </option>
          ))}
        </select>
        {machines.length > 0 ? (
          <select className="sb-board-filter" data-testid="board-filter-machine" aria-label="Machine" value={filters.machine} onChange={(event) => setFilters((current) => ({ ...current, machine: event.target.value }))}>
            <option value="all">Any machine</option>
            <option value="local">This machine</option>
            {machines.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        ) : null}
        <select className="sb-board-filter" data-testid="board-filter-folder" aria-label="Folder" value={filters.folder} onChange={(event) => setFilters((current) => ({ ...current, folder: event.target.value }))}>
          <option value="all">Any folder</option>
          {folders.map((folder) => (
            <option key={folder} value={folder}>
              {folder.split(/[\\/]/).filter(Boolean).pop() ?? folder}
            </option>
          ))}
        </select>
        <select className="sb-board-filter" data-testid="board-filter-session" aria-label="Session" value={filters.session} onChange={(event) => setFilters((current) => ({ ...current, session: event.target.value }))}>
          <option value="all">Any session</option>
          {groups.map((group) => (
            <option key={group.sessionId} value={group.sessionId}>
              {group.title}
            </option>
          ))}
        </select>
      </div>
      {phone ? (
        <div className="sb-board-picker" role="tablist" aria-label="Column" data-testid="board-column-picker">
          {BOARD_COLUMNS.map((state) => (
            <button
              key={state}
              type="button"
              role="tab"
              className="sb-board-pick"
              data-testid={`board-pick-${state}`}
              aria-selected={state === phoneColumn}
              data-board-drop={state}
              data-over={over === state ? 'true' : undefined}
              onClick={() => pickColumn(state)}
            >
              {BOARD_COLUMN_LABELS[state]} <span className="sb-board-pick-count">{columns[state].length}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="sb-board-columns" data-swipe={phone ? 'true' : undefined} ref={columnsRef} onScroll={phone ? onSwipe : undefined}>
        {BOARD_COLUMNS.map((state) => (
          <section
            key={state}
            className="sb-board-column"
            data-board-column={state}
            data-testid={`board-column-${state}`}
            data-over={over === state ? 'true' : undefined}
            data-refused={dragging && dragging.todo.state !== state && !boardCanDrop(dragging.todo, state) ? 'true' : undefined}
            aria-label={BOARD_COLUMN_LABELS[state]}
          >
            <div className="sb-board-column-head">
              <span className="sb-board-column-title">{BOARD_COLUMN_LABELS[state]}</span>
              <span className="sb-board-column-count" data-testid="board-column-count">
                {columns[state].length}
              </span>
            </div>
            <ul className="sb-todos-list sb-board-cards">
              {columns[state].length === 0 ? <li className="sb-board-empty">{state === 'review' ? 'Items run in their own session wait here' : 'Nothing here'}</li> : null}
              {columns[state].map((card) => {
                const { todo, group } = card;
                const sessionId = group.sessionId;
                const disabled = group.machine !== null && group.machine.state !== 'online';
                const scope = todoMoveScope(group.todos, todo);
                return (
                  <TodoCard
                    key={todo.id}
                    todo={todo}
                    index={scope.findIndex((t) => t.id === todo.id)}
                    count={scope.length}
                    disabled={disabled}
                    now={now}
                    working={working.has(sessionId)}
                    runSession={runSessionOf(todo.runSessionId)}
                    sessionLabel={[group.title, group.machine?.name ?? null, placeOf(group) || null].filter(Boolean).join(' · ')}
                    dragProps={{ onPointerDown: press(card, disabled), 'data-board-card': 'true', 'data-dragged': dragging?.todo.id === todo.id ? 'true' : undefined }}
                    actions={{
                      onToggleDone: () => void run(() => api.updateTodo(sessionId, todo.id, { state: todo.state === 'done' ? 'open' : 'done' })),
                      onSave: (fields) => run(() => api.updateTodo(sessionId, todo.id, savePatch(fields))),
                      onMove: (step) => {
                        const ids = moveTodo(group.todos, todo.id, step);
                        if (ids) void run(() => api.reorderTodos(sessionId, ids));
                      },
                      onDelete: () => void run(() => api.deleteTodo(sessionId, todo.id)),
                      onPriority: (priority) => void run(() => api.updateTodo(sessionId, todo.id, { priority })),
                      onProgress: (next) => void run(() => api.updateTodo(sessionId, todo.id, { state: next })),
                      onStart: todo.state === 'open' || todo.state === 'in_progress' ? () => onStart(group, todo) : null,
                      onRun: () => onRun(group, todo),
                      onMoveTo: (to) => move(card, to),
                    }}
                  />
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      {totals.length > 0 ? (
        <div className="sb-board-actuals" data-testid="board-actuals" data-tour="todos-actuals" aria-label="Actual vs. estimate per session">
          <div className="sb-board-actuals-title">Actual vs. estimate (completed)</div>
          {totals.map((group) => (
            <div key={group.sessionId} className="sb-board-actuals-row" data-testid="board-actuals-row">
              <span className="sb-board-actuals-session">{group.title}</span>
              <span className="sb-board-actuals-value">{todoActualsTotalLabel(group.actuals)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {ghost ? (
        <div className="sb-board-ghost" data-testid="board-ghost" aria-hidden="true" style={{ left: ghost.x + 8, top: ghost.y + 8 }}>
          {ghost.label}
        </div>
      ) : null}
    </div>
  );
}
