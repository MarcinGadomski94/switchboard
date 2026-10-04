import { useCallback, useState } from 'react';
import type { SessionTodoList, TodoGroup } from '../../core/api.ts';
import { splitTodos, todoEstimateTotal, todoStartMessage } from '../../core/todos.ts';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useThrottled } from '../api/useThrottled.ts';
import { MachineTag } from '../components/MachineTag.tsx';
import { Link, useRouter } from '../router.tsx';
import { TodoCards, todoRefusal, useMinuteClock } from './session/TodoStrip.tsx';
import { requestComposerFill } from './session/composer-fill.ts';
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
 * D68 / D69 · the Todos page (`docs/todos.md` → *Todos page*): every open
 * session's items as the same cards as the session's strip, grouped under a
 * session header (its title, machine tag, where it works, its open count, D70 its
 * open items' estimate total, and
 * **Open session**); the done ones behind **Show done**. **▶ Start** opens the
 * session and fills its composer (never sends).
 */
export function TodosView() {
  const groups = useApi(api.todos);
  const { navigate } = useRouter();
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useMinuteClock();
  const reload = useThrottled(groups.reload, 300);
  useHubEvent('todosChanged', () => reload());
  const reloadNow = groups.reload;

  const run = useCallback(
    async (write: () => Promise<SessionTodoList>): Promise<boolean> => {
      try {
        await write();
        setError(null);
        reloadNow();
        return true;
      } catch (caught) {
        setError(todoRefusal(caught));
        return false;
      }
    },
    [reloadNow],
  );

  const all = groups.data ?? [];
  const open = all.reduce((sum, group) => sum + splitTodos(group.todos).open.length, 0);
  const done = all.reduce((sum, group) => sum + splitTodos(group.todos).done.length, 0);
  const visible = all.filter((group) => showDone || splitTodos(group.todos).open.length > 0);
  const withOpen = all.filter((group) => splitTodos(group.todos).open.length > 0).length;

  return (
    <section className="sb-view sb-todos-page" data-view="todos" data-testid="view-todos">
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
          const disabled = group.machine !== null && group.machine.state !== 'online';
          const session = { view: 'session', id: group.sessionId, tab: 'chat' } as const;
          return (
            <section key={group.sessionId} className="sb-todos-group" data-testid="todos-group" data-session-id={group.sessionId} aria-label={group.title}>
              <div className="sb-todos-group-head">
                <Link to={session} className="sb-todos-group-title" data-testid="todos-group-title">
                  {group.title}
                </Link>
                <MachineTag machine={group.machine} />
                <span className="sb-todos-group-place">{placeOf(group)}</span>
                <span className="sb-todos-group-count" data-testid="todos-group-count">
                  {openItems.length} open
                </span>
                {/* D70: the session's open items' known estimates. */}
                {todoEstimateTotal(group.todos) ? (
                  <span className="sb-todos-group-estimate" data-testid="todos-group-estimate" title="Estimated time for an AI agent (open items)">
                    {todoEstimateTotal(group.todos)}
                  </span>
                ) : null}
                <Link to={session} className="sb-todos-group-open" data-testid="todos-open-session">
                  Open session
                </Link>
              </div>
              {openItems.length > 0 ? (
                <TodoCards
                  sessionId={group.sessionId}
                  all={group.todos}
                  items={openItems}
                  disabled={disabled}
                  run={run}
                  now={now}
                  onStart={(todo) => {
                    requestComposerFill(group.sessionId, todoStartMessage({ id: todo.id, title: todo.title ?? todo.text, description: todo.description, plan: todo.plan }));
                    navigate(session);
                  }}
                />
              ) : null}
              {showDone && doneItems.length > 0 ? (
                <div className="sb-todos-group-done" data-testid="todos-group-done">
                  <div className="sb-todos-done-head">
                    <span className="sb-todos-done-toggle">Done ({doneItems.length})</span>
                    <span className="sb-todos-done-note">removed an hour after done</span>
                  </div>
                  <TodoCards sessionId={group.sessionId} all={group.todos} items={doneItems} disabled={disabled} run={run} now={now} onStart={null} />
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </section>
  );
}
