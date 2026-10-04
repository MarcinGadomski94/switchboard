import { useCallback, useEffect, useState } from 'react';
import type { SessionTodo, SessionTodoList, TodoFieldsInput, TodoPatchInput } from '../../../core/api.ts';
import { moveTodo, splitTodos, todoEstimateTotal, todoMoveScope, todoStartMessage } from '../../../core/todos.ts';
import { ApiError, api } from '../../api/client.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { TodoCard, TodoForm } from './TodoCard.tsx';
import { requestComposerFill } from './composer-fill.ts';
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
}: {
  readonly sessionId: string;
  /** Every item of the session (the order Move up / down rewrites). */
  readonly all: readonly SessionTodo[];
  /** The ones to show, in order (one state; D70: open ones by priority). */
  readonly items: readonly SessionTodo[];
  readonly disabled: boolean;
  readonly run: (write: () => Promise<SessionTodoList>) => Promise<boolean>;
  readonly now: number;
  /** ▶ Start for an open item; `null` = not offered. */
  readonly onStart: ((todo: SessionTodo) => void) | null;
}) {
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
            actions={{
              onToggleDone: () => void run(() => api.updateTodo(sessionId, todo.id, { state: todo.state === 'done' ? 'open' : 'done' })),
              onSave: (fields) => run(() => api.updateTodo(sessionId, todo.id, savePatch(fields))),
              onMove: (step) => {
                const ids = moveTodo(all, todo.id, step);
                if (ids) void run(() => api.reorderTodos(sessionId, ids));
              },
              onDelete: () => void run(() => api.deleteTodo(sessionId, todo.id)),
              onStart: onStart && todo.state === 'open' ? () => onStart(todo) : null,
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
 * the add form (`adding`). **▶ Start** fills this session's composer (never sends).
 */
export function TodoStrip({
  sessionId,
  todos,
  blocked,
  adding,
  onAddingChange,
}: {
  readonly sessionId: string;
  readonly todos: ReturnType<typeof useSessionTodos>;
  /** Why nothing can be changed (an unreachable peer's session), `null` when it can. */
  readonly blocked: string | null;
  readonly adding: boolean;
  readonly onAddingChange: (adding: boolean) => void;
}) {
  const { list, error, run } = todos;
  const [expanded, setExpanded] = useState(readExpanded);
  const [showDone, setShowDone] = useState(false);
  const now = useMinuteClock();
  const all = list?.todos ?? [];
  const { open, done } = splitTodos(all);
  const disabled = blocked !== null;

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
  // D70: the open items' known estimates (`~2h 15m`, `+` when some have none).
  const estimateTotal = todoEstimateTotal(all);
  const progress = total === 0 ? 0 : done.length / total;

  return (
    <section className="sb-todos" data-testid="todo-strip" data-expanded={expanded ? 'true' : 'false'} aria-label="Todo list">
      <div className="sb-todos-head">
        <button type="button" className="sb-todos-toggle" data-testid="todo-toggle" aria-expanded={expanded} onClick={toggle}>
          <span className="sb-todos-caret" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="sb-todos-title">Todo</span>
          <span className="sb-todos-counts" data-testid="todo-count">
            {open.length} open{estimateTotal ? <span data-testid="todo-estimate-total"> · {estimateTotal}</span> : null} · {done.length} done
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
          {open.length > 0 ? (
            <TodoCards
              sessionId={sessionId}
              all={all}
              items={open}
              disabled={disabled}
              run={run}
              now={now}
              onStart={(todo) => requestComposerFill(sessionId, todoStartMessage({ id: todo.id, title: todo.title ?? todo.text, description: todo.description, plan: todo.plan }))}
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
              {showDone ? <TodoCards sessionId={sessionId} all={all} items={done} disabled={disabled} run={run} now={now} onStart={null} /> : null}
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
