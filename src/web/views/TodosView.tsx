import { useState } from 'react';
import type { TodoGroup } from '../../core/api.ts';
import { splitTodos } from '../../core/todos.ts';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useThrottled } from '../api/useThrottled.ts';
import { MachineTag } from '../components/MachineTag.tsx';
import { Link } from '../router.tsx';
import { authorLabel, todoRefusal } from './session/TodoStrip.tsx';
import './session/todos.css';
import './todos-view.css';

/** Where a group's session works (its solutions, else its folder's name). */
function placeOf(group: TodoGroup): string {
  if (group.solutions.length > 0) return group.solutions.join(' · ');
  if (!group.folderPath) return '';
  const parts = group.folderPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? group.folderPath;
}

/**
 * D68 · the Todos page (`docs/todos.md` → *Todos page*): every open session's
 * open items, grouped by session (title and where it works; a paired machine's
 * with its tag), the done ones behind **Show done**. A session's title opens it;
 * an item's box ticks it (or unticks a done one), as in the session's strip.
 */
export function TodosView() {
  const groups = useApi(api.todos);
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useThrottled(groups.reload, 300);
  useHubEvent('todosChanged', () => reload());

  const all = groups.data ?? [];
  const open = all.reduce((sum, group) => sum + splitTodos(group.todos).open.length, 0);
  const done = all.reduce((sum, group) => sum + splitTodos(group.todos).done.length, 0);
  const visible = all.filter((group) => showDone || splitTodos(group.todos).open.length > 0);
  const withOpen = all.filter((group) => splitTodos(group.todos).open.length > 0).length;

  const tick = async (sessionId: string, todoId: string, next: 'open' | 'done'): Promise<void> => {
    try {
      await api.updateTodo(sessionId, todoId, { state: next });
      setError(null);
      groups.reload();
    } catch (caught) {
      setError(todoRefusal(caught));
    }
  };

  return (
    <div className="sb-todos-page" data-testid="todos-view">
      <div className="sb-todos-page-head">
        <div className="sb-todos-page-title">Todos</div>
        <div className="sb-todos-page-summary" data-testid="todos-summary">
          {open} open in {withOpen} session{withOpen === 1 ? '' : 's'}
        </div>
        <label className="sb-todos-page-done">
          <input type="checkbox" data-testid="todos-show-done" checked={showDone} onChange={() => setShowDone((v) => !v)} />
          Show done ({done})
        </label>
      </div>
      {error ? (
        <div className="sb-todos-error sb-todos-page-error" role="alert" data-testid="todos-error">
          {error}
        </div>
      ) : null}
      <div className="sb-todos-page-list">
        {visible.length === 0 ? (
          <div className="sb-todos-page-empty" data-testid="todos-empty">
            {groups.data === null ? '' : 'No open todos. Ask an agent to “add it to the todo list”, or use + Todo under a session’s chat.'}
          </div>
        ) : null}
        {visible.map((group) => {
          const { open: openItems, done: doneItems } = splitTodos(group.todos);
          const items = showDone ? [...openItems, ...doneItems] : openItems;
          return (
            <section key={group.sessionId} className="sb-todos-group" data-testid="todos-group" data-session-id={group.sessionId}>
              <div className="sb-todos-group-head">
                <Link to={{ view: 'session', id: group.sessionId, tab: 'chat' }} className="sb-todos-group-title" data-testid="todos-group-title">
                  {group.title}
                </Link>
                <MachineTag machine={group.machine} />
                <span className="sb-todos-group-place">{placeOf(group)}</span>
                <span className="sb-todos-group-count">{openItems.length} open</span>
              </div>
              <ul className="sb-todos-list">
                {items.map((todo) => (
                  <li key={todo.id} className="sb-todo" data-testid="todos-item" data-state={todo.state} data-todo-id={todo.id}>
                    <input
                      type="checkbox"
                      className="sb-todo-check"
                      data-testid="todos-check"
                      aria-label={todo.state === 'done' ? `Reopen ${todo.text}` : `Mark ${todo.text} done`}
                      checked={todo.state === 'done'}
                      disabled={group.machine !== null && group.machine.state !== 'online'}
                      onChange={() => void tick(group.sessionId, todo.id, todo.state === 'done' ? 'open' : 'done')}
                    />
                    <Link to={{ view: 'session', id: group.sessionId, tab: 'chat' }} className="sb-todo-text sb-todos-item-text" data-testid="todos-item-text">
                      {todo.text}
                    </Link>
                    <span className="sb-todo-by">{authorLabel(todo)}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
