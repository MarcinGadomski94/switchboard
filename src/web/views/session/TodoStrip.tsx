import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionTodo, SessionTodoList, TodoFieldsInput, TodoPatchInput, TodoRunResult } from '../../../core/api.ts';
import { displayTitle } from '../../../core/session-title.ts';
import { moveTodo, splitTodos, todoCountsLabel, todoMoveScope, todoStartMessage } from '../../../core/todos.ts';
import { ApiError, api } from '../../api/client.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { useSessionList } from '../../folders/useFolders.ts';
import { type Toast, useToasts } from '../../toast/ToastHost.tsx';
import { TodoCard, TodoForm, type TodoRunSession } from './TodoCard.tsx';
import './todos.css';

export { authorLabel } from './TodoCard.tsx';

/** The refusal's message (`{ message }` of the API), else a generic line. */
export function todoRefusal(error: unknown): string {
  if (error instanceof ApiError) {
    const message = (error.body as { message?: unknown } | null)?.message;
    if (typeof message === 'string') return message;
    if (error.unreachable) return 'Switchboard could not be reached.';
  }
  return 'That did not work. Try again.';
}

/**
 * D75 · ▶ Start: marks the item in progress and sends its start message to the session
 * (`POST …/todos/{todoId}/start`). A paired machine still on 1.11 or earlier has no such
 * route (its peer API refuses it, 403, or answers an unknown route, 404 without
 * `not-found`): the message is then sent as a plain message and the item stays as it was.
 */
export async function startTodo(sessionId: string, todo: SessionTodo): Promise<SessionTodoList> {
  try {
    return await api.startTodo(sessionId, todo.id);
  } catch (error) {
    const code = error instanceof ApiError ? (error.body as { error?: unknown } | null)?.error : undefined;
    const olderPeer = error instanceof ApiError && sessionId.startsWith('r~') && (error.status === 403 || (error.status === 404 && code !== 'not-found'));
    if (!olderPeer) throw error;
    await api.sendMessage(sessionId, todoStartMessage({ id: todo.id, title: todo.title ?? todo.text, description: todo.description, plan: todo.plan }));
    return api.sessionTodos(sessionId);
  }
}

/** D76: the run sessions as the cards show them (title, live status), from the session list (peers' included). */
export function useRunSessions(): (id: string | null | undefined) => TodoRunSession | null {
  const sessions = useSessionList();
  const byId = useMemo(() => new Map((sessions.data ?? []).map((session) => [session.id, session])), [sessions.data]);
  return useCallback(
    (id) => {
      const session = id ? byId.get(id) : undefined;
      return session ? { title: displayTitle(session), status: session.status, closed: Boolean(session.closedAt) } : null;
    },
    [byId],
  );
}

/** D76: the toast of a started run (its note when it has no worktree; D82: the rule that routed it), with **Open** to the run session. */
export function runToast(result: TodoRunResult, todo: Pick<SessionTodo, 'id' | 'title'>): Toast {
  return {
    id: `todo-run-${todo.id}`,
    title: 'Running in a new session',
    sub: 'now',
    branch: '',
    // D82: the Model by task rule that routed the run, after the note.
    text: [todo.title, result.note, result.routing ?? null].filter((part): part is string => !!part).join(' · '),
    sessionId: result.session.id,
    jumpLabel: 'Open',
  };
}

/**
 * D76 · Run N in new sessions: one run per item, one after the other (each its own session and
 * worktree); answers how many started and the refusals' messages.
 */
export async function runTodos(items: ReadonlyArray<{ readonly sessionId: string; readonly todo: SessionTodo }>, onRan: (result: TodoRunResult, todo: SessionTodo) => void): Promise<{ readonly started: number; readonly errors: readonly string[] }> {
  let started = 0;
  const errors: string[] = [];
  for (const { sessionId, todo } of items) {
    try {
      onRan(await api.runTodo(sessionId, todo.id), todo);
      started += 1;
    } catch (error) {
      errors.push(`${todo.title}: ${todoRefusal(error)}`);
    }
  }
  return { started, errors };
}

/** D76: the multi-select of the strip and the Todos page (item id → its session). */
export function useTodoSelection() {
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlyMap<string, { readonly sessionId: string; readonly todo: SessionTodo }>>(new Map());
  const toggle = useCallback((sessionId: string, todo: SessionTodo, on: boolean) => {
    setPicked((current) => {
      const next = new Map(current);
      if (on) next.set(todo.id, { sessionId, todo });
      else next.delete(todo.id);
      return next;
    });
  }, []);
  const stop = useCallback(() => {
    setSelecting(false);
    setPicked(new Map());
  }, []);
  return { selecting, setSelecting, picked, toggle, stop };
}

/** D76: the bar of a multi-select: how many are picked, **Run N in new sessions**, Cancel. */
export function TodoSelectionBar({ selection, busy, onRun }: { readonly selection: ReturnType<typeof useTodoSelection>; readonly busy: boolean; readonly onRun: () => void }) {
  const count = selection.picked.size;
  return (
    <div className="sb-todo-selection" data-testid="todo-selection" role="region" aria-label="Selected todos">
      <span className="sb-todo-selection-count">{count === 0 ? 'Select items to run' : `${count} selected`}</span>
      <button type="button" className="sb-todo-selection-run" data-testid="todo-run-selected" disabled={count === 0 || busy} aria-busy={busy} onClick={onRun}>
        Run {count} in new session{count === 1 ? '' : 's'}
      </button>
      <button type="button" className="sb-todo-selection-cancel" data-testid="todo-select-cancel" onClick={selection.stop}>
        Cancel
      </button>
    </div>
  );
}

/** The strip's open / closed state, kept in this browser. */
const EXPANDED_KEY = 'sb.todos.expanded';

function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

/** D68: one session's todo list, live (`todosChanged`), with its writes. */
export function useSessionTodos(sessionId: string) {
  const [list, setList] = useState<SessionTodoList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.sessionTodos(sessionId).then(
      (answer) => setList(answer),
      () => undefined,
    );
  }, [sessionId]);
  useEffect(() => {
    setList(null);
    load();
  }, [load]);
  useHubEvent('todosChanged', (payload) => {
    if (payload.sessionId === sessionId) load();
  });
  // Reconnected or reloaded elsewhere: the session's own update also carries its count.
  useHubEvent('sessionUpdated', (payload) => {
    if (payload.id === sessionId && list && (payload.openTodoCount ?? 0) !== list.openCount) load();
  });
  const run = useCallback(async (write: () => Promise<SessionTodoList>): Promise<boolean> => {
    try {
      setList(await write());
      setError(null);
      return true;
    } catch (caught) {
      setError(todoRefusal(caught));
      return false;
    }
  }, []);
  return { list, error, setError, run };
}

/** A clock for the cards' ages and countdowns, ticking once a minute. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The PUT that saves a form: every field (an emptied description is removed; D70: the plan, priority and estimate, `null` = none). */
export function savePatch(fields: TodoFieldsInput): TodoPatchInput {
  return { title: fields.title, description: fields.description ?? '', plan: fields.plan, priority: fields.priority, estimateMinutes: fields.estimateMinutes };
}

/** D69: the list's cards with their actions, for the strip and the Todos page. */
export function TodoCards({
  sessionId,
  all,
  items,
  disabled,
  run,
  now,
  onStart,
  working = false,
  onRun = null,
  runSessionOf = null,
  selection = null,
}: {
  readonly sessionId: string;
  /** Every item of the session (the order Move up / down rewrites). */
  readonly all: readonly SessionTodo[];
  /** The ones to show, in order (one state; D70: open ones by priority). */
  readonly items: readonly SessionTodo[];
  readonly disabled: boolean;
  readonly run: (write: () => Promise<SessionTodoList>) => Promise<boolean>;
  readonly now: number;
  /** ▶ Start for an open or in-progress item; `null` = not offered. */
  readonly onStart: ((todo: SessionTodo) => void) | null;
  /** D75: the session is working (an in-progress card's edge pulses). */
  readonly working?: boolean;
  /** D76: ⋯ → Run in new session; `null` = not offered. */
  readonly onRun?: ((todo: SessionTodo) => void) | null;
  /** D76: a run session's title and live status. */
  readonly runSessionOf?: ((id: string | null | undefined) => TodoRunSession | null) | null;
  /** D76: the multi-select, `null` = not selecting. */
  readonly selection?: ReturnType<typeof useTodoSelection> | null;
}) {
  const selecting = selection?.selecting === true;
  return (
    <ul className="sb-todos-list">
      {items.map((todo) => {
        // D70: Move up / down stays within the item's priority level (open), or among the done ones.
        const scope = todoMoveScope(all, todo);
        return (
          <TodoCard
            key={todo.id}
            todo={todo}
            index={scope.findIndex((t) => t.id === todo.id)}
            count={scope.length}
            disabled={disabled}
            now={now}
            working={working}
            runSession={runSessionOf ? runSessionOf(todo.runSessionId) : null}
            selected={selecting ? (selection?.picked.has(todo.id) ?? false) : null}
            onSelect={selecting && selection ? (on) => selection.toggle(sessionId, todo, on) : null}
            actions={{
              onToggleDone: () => void run(() => api.updateTodo(sessionId, todo.id, { state: todo.state === 'done' ? 'open' : 'done' })),
              onSave: (fields) => run(() => api.updateTodo(sessionId, todo.id, savePatch(fields))),
              onMove: (step) => {
                const ids = moveTodo(all, todo.id, step);
                if (ids) void run(() => api.reorderTodos(sessionId, ids));
              },
              onDelete: () => void run(() => api.deleteTodo(sessionId, todo.id)),
              onPriority: (priority) => void run(() => api.updateTodo(sessionId, todo.id, { priority })),
              // D75: by hand from the ⋯ menu (nothing is sent).
              onProgress: (state) => void run(() => api.updateTodo(sessionId, todo.id, { state })),
              onStart: onStart && (todo.state === 'open' || todo.state === 'in_progress') ? () => onStart(todo) : null,
              onRun: onRun ? () => onRun(todo) : null,
            }}
          />
        );
      })}
    </ul>
  );
}

/**
 * D68 / D69 · the session's todo strip, just above the composer (`docs/todos.md` →
 * *In the session*): a header with **TODO**, `3 open · ~2h 15m · 1 done` (D70: the open
 * items' estimate total), a thin progress
 * bar and **+ Add**, collapsed (the next open item's title: D70, the top one by priority) or expanded (kept in
 * this browser); expanded, the open items as cards ({@link TodoCard}), the add
 * form at the top, and the done items under a collapsed **Done (n)** with **Clear
 * done**. With no items it is not shown: the composer's **+ Todo** opens it with
 * the add form (`adding`). D75: **▶ Start** sends the item's start message to this session
 * and marks it in progress (the composer and its draft are not touched).
 */
export function TodoStrip({
  sessionId,
  todos,
  blocked,
  adding,
  onAddingChange,
  working = false,
}: {
  readonly sessionId: string;
  readonly todos: ReturnType<typeof useSessionTodos>;
  /** D75: the session is working (its status `run`): an in-progress card's left edge pulses. */
  readonly working?: boolean;
  /** Why nothing can be changed (an unreachable peer's session), `null` when it can. */
  readonly blocked: string | null;
  readonly adding: boolean;
  readonly onAddingChange: (adding: boolean) => void;
}) {
  const { list, error, setError, run } = todos;
  const [expanded, setExpanded] = useState(readExpanded);
  const [showDone, setShowDone] = useState(false);
  const now = useMinuteClock();
  const all = list?.todos ?? [];
  const { open, review, done } = splitTodos(all);
  const disabled = blocked !== null;
  const { show } = useToasts();
  const runSessionOf = useRunSessions();
  const selection = useTodoSelection();
  const [running, setRunning] = useState(false);
  // D76: a new session works on the item; a toast offers Open (and says when it has no worktree).
  const runOne = (todo: SessionTodo): void => {
    void run(async () => {
      const result = await api.runTodo(sessionId, todo.id);
      show(runToast(result, todo));
      return result.list;
    });
  };
  const runSelected = (): void => {
    setRunning(true);
    void runTodos([...selection.picked.values()], (result, todo) => show(runToast(result, todo))).then(({ errors }) => {
      setRunning(false);
      selection.stop();
      setError(errors.length > 0 ? errors.join(' · ') : null);
    });
  };

  useEffect(() => {
    if (adding) setExpanded(true);
  }, [adding]);

  if (!list || (all.length === 0 && !adding)) return null;

  const remember = (next: boolean): void => {
    setExpanded(next);
    try {
      window.localStorage.setItem(EXPANDED_KEY, next ? '1' : '0');
    } catch {
      // Private mode: the strip just does not remember.
    }
  };
  const toggle = (): void => {
    const next = !expanded;
    remember(next);
    if (!next) onAddingChange(false);
  };

  const add = async (fields: TodoFieldsInput): Promise<boolean> => {
    if (disabled) return false;
    // D69 ruling: the form stays open (cleared) for the next item; Esc / Cancel closes it.
    return run(() => api.addTodo(sessionId, fields));
  };

  const total = open.length + done.length;
  const progress = total === 0 ? 0 : done.length / total;

  return (
    <section className="sb-todos" data-testid="todo-strip" data-tour="todo-strip" data-expanded={expanded ? 'true' : 'false'} aria-label="Todo list">
      <div className="sb-todos-head">
        <button type="button" className="sb-todos-toggle" data-testid="todo-toggle" aria-expanded={expanded} onClick={toggle}>
          <span className="sb-todos-caret" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="sb-todos-title">Todo</span>
          {/* D70: the open items' known estimates (`~2h 15m`, `+` when some have none); D75: `1 in progress · 2 open · ~2h · 1 done`. */}
          <span className="sb-todos-counts" data-testid="todo-count" title={todoCountsLabel(all)}>
            {todoCountsLabel(all)}
          </span>
          {!expanded && open[0] ? (
            <span className="sb-todos-next" data-testid="todo-next">
              {open[0].title ?? open[0].text}
            </span>
          ) : null}
        </button>
        <span
          className="sb-todos-progress"
          data-testid="todo-progress"
          role="progressbar"
          aria-label="Done"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done.length}
        >
          <span className="sb-todos-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
        {open.length > 0 ? (
          <button
            type="button"
            className="sb-todos-add-button sb-todos-select-button"
            data-testid="todo-select-toggle"
            aria-pressed={selection.selecting}
            disabled={disabled}
            title="Select items to run each in a new session"
            onClick={() => {
              if (selection.selecting) selection.stop();
              else {
                remember(true);
                selection.setSelecting(true);
              }
            }}
          >
            Select
          </button>
        ) : null}
        <button
          type="button"
          className="sb-todos-add-button"
          data-testid="todo-add"
          disabled={disabled}
          title={blocked ?? 'Add an item'}
          onClick={() => {
            remember(true);
            onAddingChange(true);
          }}
        >
          + Add
        </button>
      </div>
      {expanded ? (
        <div className="sb-todos-body">
          {adding ? <TodoForm key="add" mode="add" initial={null} disabled={disabled} onSave={add} onCancel={() => onAddingChange(false)} /> : null}
          {selection.selecting ? <TodoSelectionBar selection={selection} busy={running} onRun={runSelected} /> : null}
          {open.length + review.length > 0 ? (
            <TodoCards
              sessionId={sessionId}
              all={all}
              // D76: the items in review after the open ones.
              items={[...open, ...review]}
              disabled={disabled}
              run={run}
              now={now}
              working={working}
              // D75: sends the start message to this session (queued while it works) and marks the item in progress.
              onStart={(todo) => void run(() => startTodo(sessionId, todo))}
              onRun={runOne}
              runSessionOf={runSessionOf}
              selection={selection}
            />
          ) : null}
          {done.length > 0 ? (
            <div className="sb-todos-done">
              <div className="sb-todos-done-head">
                <button type="button" className="sb-todos-done-toggle" data-testid="todo-done-toggle" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                  {showDone ? '▾' : '▸'} Done ({done.length})
                </button>
                <span className="sb-todos-done-note">removed an hour after done</span>
                <button type="button" className="sb-todos-clear" data-testid="todo-clear-done" disabled={disabled} onClick={() => void run(() => api.clearDoneTodos(sessionId))}>
                  Clear done
                </button>
              </div>
              {showDone ? <TodoCards sessionId={sessionId} all={all} items={done} disabled={disabled} run={run} now={now} onStart={null} runSessionOf={runSessionOf} /> : null}
            </div>
          ) : null}
          {error ? (
            <div className="sb-todos-error" role="alert" data-testid="todo-error">
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
