/**
 * Fix after 2.0 · one agent's task cards (the agent view's strip, its side panel, the peek, the
 * phone): classic's todo writes (`views/session/TodoStrip.tsx`: D75 ▶ Start with its older-peer
 * fallback, D76 ▸ Run, done / reopen, the D70 fields, Mark in progress) behind
 * {@link TodoCardHandlers}, the worker statuses that make Review, the run agents' names, the D99
 * plan links, and delete with Undo: the card hides at once in every place it shows, the delete
 * is sent after the toast's 5.6 s (or when the page goes), Undo brings it back (the Tasks page's rule).
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { SessionTodo } from '../../../core/api.ts';
import type { SessionStatus } from '../../../core/model.ts';
import { displayTitle } from '../../../core/session-title.ts';
import { api, withKeepalive } from '../../api/client.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { usePlans } from '../../plans/store.ts';
import { savePatch, startTodo, useMinuteClock, type useSessionTodos } from '../../views/session/TodoStrip.tsx';
import { useToast } from '../components/index.ts';
import { TASKS_WORDS as W } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import type { TodoCardHandlers, TodoCardProps } from './TodoCard.tsx';
import { todoPlanLink, workerOf } from './todo-card-model.ts';

/** How long a deleted task waits before it is really deleted (the toast's Undo window). */
export const TASK_DELETE_DELAY_MS = 5_600;

// The deletes in their Undo window, shared by every place the card shows (strip, side panel, peek).
const pending = new Map<string, { readonly timer: number; readonly send: () => void }>();
let hidden: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function key(sessionId: string, todoId: string): string {
  return `${sessionId}\u0000${todoId}`;
}

function setHidden(next: ReadonlySet<string>): void {
  hidden = next;
  for (const listener of [...listeners]) listener();
}

function hide(id: string, on: boolean): void {
  if (hidden.has(id) === on) return;
  const next = new Set(hidden);
  if (on) next.add(id);
  else next.delete(id);
  setHidden(next);
}

/** Sends every delete still in its Undo window now (the page goes, the tab closes). */
function flush(): void {
  for (const [id, entry] of pending) {
    window.clearTimeout(entry.timer);
    pending.delete(id);
    withKeepalive(() => entry.send());
  }
}

let flushing = false;
function subscribe(listener: () => void): () => void {
  if (!flushing && typeof window !== 'undefined') {
    flushing = true;
    window.addEventListener('pagehide', flush);
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The card props one agent's tasks share, from {@link useSessionTodos}'s list. */
export interface AgentTaskCards {
  /** The items to show (a delete in its Undo window left out). */
  readonly visible: readonly SessionTodo[];
  /** One card's props (all but `layout`). */
  readonly cardProps: (todo: SessionTodo) => Omit<TodoCardProps, 'layout'>;
  /** The last refusal (shown under the cards), `null` when none. */
  readonly error: string | null;
}

/**
 * The cards of agent `sessionId` (`todos` is its {@link useSessionTodos}). `blocked` is why
 * nothing can change (an unreachable computer); `working` whether the agent works now.
 */
export function useAgentTaskCards(sessionId: string, todos: ReturnType<typeof useSessionTodos>, blocked: string | null, working: boolean): AgentTaskCards {
  const toast = useToast();
  const { navigate } = useV2Router();
  const now = useMinuteClock();
  const sessions = useSessionListOf('open');
  const { on, plans } = usePlans();
  const hiddenNow = useSyncExternalStore(subscribe, () => hidden);
  const { run } = todos;

  const byId = useMemo(() => new Map((sessions.data ?? []).map((session) => [session.id, session])), [sessions.data]);
  const statusOf = useCallback((id: string): SessionStatus | null => byId.get(id)?.status ?? null, [byId]);

  const handlersFor = useCallback(
    (todo: SessionTodo): TodoCardHandlers => {
      const title = todo.title ?? todo.text;
      return {
        start: () => void run(() => startTodo(sessionId, todo)),
        run: () =>
          void run(async () => {
            const result = await api.runTodo(sessionId, todo.id);
            toast({ text: W.ran(title), actionLabel: W.open, undo: () => navigate({ area: 'agent', id: result.session.id, tab: 'chat' }) });
            return result.list;
          }),
        check: () => void run(() => api.updateTodo(sessionId, todo.id, { state: todo.state === 'done' ? 'open' : 'done' })),
        save: (fields) => run(() => api.updateTodo(sessionId, todo.id, savePatch(fields))),
        progress: (state) => void run(() => api.updateTodo(sessionId, todo.id, { state })),
        remove: () => {
          const id = key(sessionId, todo.id);
          if (pending.has(id)) return;
          hide(id, true);
          const send = (): void => {
            // A refusal shows under the cards (the list's error) and the card comes back.
            void run(() => api.deleteTodo(sessionId, todo.id)).then(() => hide(id, false));
          };
          const timer = window.setTimeout(() => {
            pending.delete(id);
            send();
          }, TASK_DELETE_DELAY_MS);
          pending.set(id, { timer, send });
          toast({
            text: W.deleted(title),
            ms: TASK_DELETE_DELAY_MS,
            undo: () => {
              const entry = pending.get(id);
              if (!entry) return;
              window.clearTimeout(entry.timer);
              pending.delete(id);
              hide(id, false);
            },
          });
        },
      };
    },
    [sessionId, run, toast, navigate],
  );

  const all = todos.list?.todos ?? [];
  const visible = all.filter((todo) => !hiddenNow.has(key(sessionId, todo.id)));
  const cardProps = (todo: SessionTodo): Omit<TodoCardProps, 'layout'> => {
    const runSession = todo.runSessionId ? byId.get(todo.runSessionId) : undefined;
    return {
      todo,
      workerStatus: statusOf(workerOf(todo)),
      now,
      handlers: handlersFor(todo),
      blocked,
      working: working && workerOf(todo) === sessionId,
      planLink: on ? todoPlanLink(plans, todo) : null,
      runTitle: runSession ? displayTitle(runSession) : null,
    };
  };
  return { visible, cardProps, error: todos.error };
}
