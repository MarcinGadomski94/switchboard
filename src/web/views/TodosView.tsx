import { useCallback, useState } from 'react';
import type { SessionTodo, SessionTodoList, TodoGroup } from '../../core/api.ts';
import { todoActualsTotalLabel } from '../../core/todo-actuals.ts';
import { splitTodos, todoEstimateTotal } from '../../core/todos.ts';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useThrottled } from '../api/useThrottled.ts';
import { MachineTag } from '../components/MachineTag.tsx';
import { useSessionList } from '../folders/useFolders.ts';
import { Link } from '../router.tsx';
import { useToasts } from '../toast/ToastHost.tsx';
import { TodoBoard } from './TodoBoard.tsx';
import { TodoCards, TodoSelectionBar, runToast, runTodos, startTodo, todoRefusal, useMinuteClock, useRunSessions, useTodoSelection } from './session/TodoStrip.tsx';
import './session/todos.css';
import './todos-view.css';

/** Where a group's session works (its solutions, else its folder's name). */
function placeOf(group: TodoGroup): string {
  if (group.solutions.length > 0) return group.solutions.join(' · ');
  if (!group.folderPath) return '';
  const parts = group.folderPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? group.folderPath;
}

/** D77: the page's view (List | Board), kept in this browser. */
type TodosMode = 'list' | 'board';
const MODE_KEY = 'sb.todos.view';

function readMode(): TodosMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

/**
 * D68 / D69 · the Todos page (`docs/todos.md` → *Todos page*): every open
 * session's items as the same cards as the session's strip, grouped under a
 * session header (its title, machine tag, where it works, its open count, D70 its
 * open items' estimate total, D78 its completed items' actual vs. estimate, and
 * **Open session**); the done ones behind **Show done**. D75: **▶ Start** sends the item's
 * start message to its session (no need to open it) and marks it in progress; a small
 * toast offers **Open**. An in-progress card's edge pulses while its session works.
 * D76: ⋯ → **Run in new session** and **Select** → **Run N in new sessions**; the items in
 * review follow the open ones. D77: **List | Board** (remembered), the board in {@link TodoBoard}.
 */
export function TodosView() {
  const groups = useApi(api.todos);
  const { show } = useToasts();
  // D75: which sessions are working (an in-progress card's edge pulses).
  const sessions = useSessionList();
  const working = new Set((sessions.data ?? []).filter((session) => session.status === 'run').map((session) => session.id));
  const runSessionOf = useRunSessions();
  const [showDone, setShowDone] = useState(false);
  const [mode, setMode] = useState<TodosMode>(readMode);
  const [error, setError] = useState<string | null>(null);
  const selection = useTodoSelection();
  const [running, setRunning] = useState(false);
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

  const pickMode = (next: TodosMode): void => {
    setMode(next);
    selection.stop();
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // Private mode: not remembered.
    }
  };

  const startIn = (group: TodoGroup, todo: SessionTodo): void => {
    void run(() => startTodo(group.sessionId, todo)).then((ok) => {
      if (!ok) return;
      show({
        id: `todo-start-${todo.id}`,
        title: 'Sent to the agent',
        sub: 'now',
        branch: '',
        text: `${todo.title ?? todo.text} · ${group.title}`,
        sessionId: group.sessionId,
        jumpLabel: 'Open',
      });
    });
  };

  // D76: a new session works on the item (its own worktree in a git repo); the toast offers Open.
  const runIn = (group: TodoGroup, todo: SessionTodo): void => {
    void run(async () => {
      const result = await api.runTodo(group.sessionId, todo.id);
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
      reloadNow();
    });
  };

  const all = groups.data ?? [];
  const open = all.reduce((sum, group) => sum + splitTodos(group.todos).open.length, 0);
  const done = all.reduce((sum, group) => sum + splitTodos(group.todos).done.length, 0);
  const inReview = all.reduce((sum, group) => sum + splitTodos(group.todos).review.length, 0);
  const pending = (group: TodoGroup): number => {
    const split = splitTodos(group.todos);
    return split.open.length + split.review.length;
  };
  const visible = all.filter((group) => showDone || pending(group) > 0);
  const withOpen = all.filter((group) => splitTodos(group.todos).open.length > 0).length;

  return (
    <section className="sb-view sb-todos-page" data-view="todos" data-mode={mode} data-testid="view-todos">
      <div className="sb-todos-page-head">
        <div className="sb-todos-page-title">Todos</div>
        <div className="sb-todos-page-summary" data-testid="todos-summary">
          {open} open in {withOpen} session{withOpen === 1 ? '' : 's'}
          {inReview > 0 ? ` · ${inReview} in review` : ''}
        </div>
        <div className="sb-todos-mode" role="group" aria-label="View" data-testid="todos-mode">
          <button type="button" className="sb-todos-mode-button" data-testid="todos-mode-list" aria-pressed={mode === 'list'} onClick={() => pickMode('list')}>
            List
          </button>
          <button type="button" className="sb-todos-mode-button" data-testid="todos-mode-board" aria-pressed={mode === 'board'} onClick={() => pickMode('board')}>
            Board
          </button>
        </div>
        {mode === 'list' ? (
          <>
            <button
              type="button"
              className="sb-todos-page-select"
              data-testid="todos-select-toggle"
              aria-pressed={selection.selecting}
              disabled={open === 0}
              onClick={() => (selection.selecting ? selection.stop() : selection.setSelecting(true))}
            >
              Select
            </button>
            <label className="sb-todos-page-done">
              <input type="checkbox" data-testid="todos-show-done" checked={showDone} onChange={() => setShowDone((v) => !v)} />
              Show done ({done})
            </label>
          </>
        ) : null}
      </div>
      {error ? (
        <div className="sb-todos-error sb-todos-page-error" role="alert" data-testid="todos-error">
          {error}
        </div>
      ) : null}
      {mode === 'board' ? (
        <TodoBoard groups={all} run={run} now={now} working={working} runSessionOf={runSessionOf} onStart={startIn} onRun={runIn} />
      ) : (
        <div className="sb-todos-page-list">
          {selection.selecting ? <TodoSelectionBar selection={selection} busy={running} onRun={runSelected} /> : null}
          {visible.length === 0 ? (
            <div className="sb-todos-page-empty" data-testid="todos-empty">
              {groups.data === null ? '' : 'No open todos. Ask an agent to “add it to the todo list”, or use + Todo under a session’s chat.'}
            </div>
          ) : null}
          {visible.map((group) => {
            const { open: openItems, review: reviewItems, done: doneItems } = splitTodos(group.todos);
            const disabled = group.machine !== null && group.machine.state !== 'online';
            const session = { view: 'session', id: group.sessionId, tab: 'chat' } as const;
            const actuals = todoActualsTotalLabel(group.actuals);
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
                  {/* D78: the completed items' actual vs. estimate (also the ones removed after their done hour). */}
                  {actuals ? (
                    <span className="sb-todos-group-actuals" data-testid="todos-group-actuals" title="Completed items: their estimates against the time they took and their tokens (approximate)">
                      {actuals}
                    </span>
                  ) : null}
                  <Link to={session} className="sb-todos-group-open" data-testid="todos-open-session">
                    Open session
                  </Link>
                </div>
                {openItems.length + reviewItems.length > 0 ? (
                  <TodoCards
                    sessionId={group.sessionId}
                    all={group.todos}
                    items={[...openItems, ...reviewItems]}
                    disabled={disabled}
                    run={run}
                    now={now}
                    working={working.has(group.sessionId)}
                    onStart={(todo) => startIn(group, todo)}
                    onRun={(todo) => runIn(group, todo)}
                    runSessionOf={runSessionOf}
                    selection={selection}
                  />
                ) : null}
                {showDone && doneItems.length > 0 ? (
                  <div className="sb-todos-group-done" data-testid="todos-group-done">
                    <div className="sb-todos-done-head">
                      <span className="sb-todos-done-toggle">Done ({doneItems.length})</span>
                      <span className="sb-todos-done-note">removed an hour after done</span>
                    </div>
                    <TodoCards sessionId={group.sessionId} all={group.todos} items={doneItems} disabled={disabled} run={run} now={now} onStart={null} runSessionOf={runSessionOf} />
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
