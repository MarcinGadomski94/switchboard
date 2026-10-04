import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { SessionTodo, SessionTodoList } from '../../../core/api.ts';
import { moveTodo, splitTodos } from '../../../core/todos.ts';
import { ApiError, api } from '../../api/client.ts';
import { useHubEvent } from '../../api/useHub.ts';
import './todos.css';

/** The refusal's message (`{ message }` of the API), else a generic line. */
export function todoRefusal(error: unknown): string {
  if (error instanceof ApiError) {
    const message = (error.body as { message?: unknown } | null)?.message;
    if (typeof message === 'string') return message;
    if (error.unreachable) return 'Switchboard could not be reached.';
  }
  return 'That did not work. Try again.';
}

/** Who added an item, as the list shows it (subtle). */
export function authorLabel(todo: Pick<SessionTodo, 'addedBy'>): string {
  return todo.addedBy === 'agent' ? 'agent' : 'you';
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

/**
 * D68 · the session's todo strip, just above the composer (`docs/todos.md` →
 * *In the session*): **Todo (n)** with the open count, collapsed or expanded (kept
 * in this browser); expanded, the open items (tick, edit inline, ↑ ↓, ✕, who
 * added it), an add field, and the done items under a collapsed **Done (n)** with
 * **Clear done**. With no items it is not shown: the composer's **+ Todo** opens it
 * with the add field (`adding`).
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
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ readonly id: string; readonly text: string } | null>(null);
  const addInput = useRef<HTMLInputElement | null>(null);
  const all = list?.todos ?? [];
  const { open, done } = splitTodos(all);
  const disabled = blocked !== null;

  useEffect(() => {
    if (adding) setExpanded(true);
  }, [adding]);
  // Once the add field is there (the strip expanded), it takes the focus.
  useEffect(() => {
    if (adding && expanded) addInput.current?.focus();
  }, [adding, expanded]);

  if (!list || (all.length === 0 && !adding)) return null;

  const toggle = (): void => {
    const next = !expanded;
    setExpanded(next);
    try {
      window.localStorage.setItem(EXPANDED_KEY, next ? '1' : '0');
    } catch {
      // Private mode: the strip just does not remember.
    }
    if (!next) onAddingChange(false);
  };

  const add = async (): Promise<void> => {
    const sent = draft;
    const text = sent.trim();
    if (text === '' || disabled) return;
    if (await run(() => api.addTodo(sessionId, text))) {
      // Cleared unless the field was edited meanwhile (the next item typed while this one was saved).
      setDraft((current) => (current === sent ? '' : current));
      addInput.current?.focus();
    }
  };

  const saveEdit = async (): Promise<void> => {
    if (!editing) return;
    const item = all.find((t) => t.id === editing.id);
    const text = editing.text.trim();
    setEditing(null);
    if (!item || text === '' || text === item.text) return;
    await run(() => api.updateTodo(sessionId, item.id, { text }));
  };

  const onAddKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void add();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDraft('');
      onAddingChange(false);
    }
  };

  const onEditKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void saveEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(null);
    }
  };

  const row = (todo: SessionTodo) => {
    const isDone = todo.state === 'done';
    const scope = isDone ? done : open;
    const index = scope.findIndex((t) => t.id === todo.id);
    return (
      <li key={todo.id} className="sb-todo" data-testid="todo-item" data-todo-id={todo.id} data-state={todo.state} data-added-by={todo.addedBy}>
        <input
          type="checkbox"
          className="sb-todo-check"
          data-testid="todo-check"
          aria-label={isDone ? `Reopen ${todo.text}` : `Mark ${todo.text} done`}
          checked={isDone}
          disabled={disabled}
          onChange={() => void run(() => api.updateTodo(sessionId, todo.id, { state: isDone ? 'open' : 'done' }))}
        />
        {editing?.id === todo.id ? (
          <input
            className="sb-todo-edit"
            data-testid="todo-edit"
            aria-label="Edit todo"
            value={editing.text}
            autoFocus
            onChange={(event) => setEditing({ id: todo.id, text: event.target.value })}
            onKeyDown={onEditKey}
            onBlur={() => void saveEdit()}
          />
        ) : (
          <button
            type="button"
            className="sb-todo-text"
            data-testid="todo-text"
            title={disabled ? todo.text : 'Click to edit'}
            disabled={disabled || isDone}
            onClick={() => setEditing({ id: todo.id, text: todo.text })}
          >
            {todo.text}
          </button>
        )}
        <span className="sb-todo-by" data-testid="todo-by" title={todo.addedBy === 'agent' ? 'Added by the agent' : 'Added by you'}>
          {authorLabel(todo)}
        </span>
        {isDone ? null : (
          <>
            <button
              type="button"
              className="sb-todo-icon"
              data-testid="todo-up"
              aria-label={`Move ${todo.text} up`}
              disabled={disabled || index <= 0}
              onClick={() => {
                const ids = moveTodo(all, todo.id, -1);
                if (ids) void run(() => api.reorderTodos(sessionId, ids));
              }}
            >
              ↑
            </button>
            <button
              type="button"
              className="sb-todo-icon"
              data-testid="todo-down"
              aria-label={`Move ${todo.text} down`}
              disabled={disabled || index === scope.length - 1}
              onClick={() => {
                const ids = moveTodo(all, todo.id, 1);
                if (ids) void run(() => api.reorderTodos(sessionId, ids));
              }}
            >
              ↓
            </button>
          </>
        )}
        <button type="button" className="sb-todo-icon" data-testid="todo-delete" aria-label={`Delete ${todo.text}`} disabled={disabled} onClick={() => void run(() => api.deleteTodo(sessionId, todo.id))}>
          ✕
        </button>
      </li>
    );
  };

  return (
    <section className="sb-todos" data-testid="todo-strip" data-expanded={expanded ? 'true' : 'false'} aria-label="Todo list">
      <button type="button" className="sb-todos-head" data-testid="todo-toggle" aria-expanded={expanded} onClick={toggle}>
        <span className="sb-todos-caret" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="sb-todos-title" data-testid="todo-count">
          Todo ({open.length})
        </span>
        {!expanded && open[0] ? <span className="sb-todos-next">{open[0].text}</span> : null}
      </button>
      {expanded ? (
        <div className="sb-todos-body">
          {open.length > 0 ? <ul className="sb-todos-list">{open.map(row)}</ul> : null}
          <div className="sb-todos-add">
            <input
              ref={addInput}
              className="sb-todos-add-input"
              data-testid="todo-add-input"
              aria-label="Add a todo"
              placeholder={disabled ? (blocked ?? '') : 'Add a todo…'}
              value={draft}
              disabled={disabled}
              maxLength={1000}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onAddKey}
              onBlur={() => {
                if (draft.trim() === '' && all.length === 0) onAddingChange(false);
              }}
            />
            <button type="button" className="sb-button sb-todos-add-button" data-testid="todo-add" disabled={disabled || draft.trim() === ''} onClick={() => void add()}>
              Add
            </button>
          </div>
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
              {showDone ? <ul className="sb-todos-list">{done.map(row)}</ul> : null}
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
