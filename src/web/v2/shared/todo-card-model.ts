/**
 * Fix after 2.0 · the v2 task card (classic's todo card in v2's look, `shared/TodoCard.tsx`):
 * its pure rules. What one card shows (status as icon + word + colour, priority, estimate vs
 * actual and tokens, the plan mark) and which of classic's actions it offers (▶ Start, ▸ Run
 * in its own agent, mark done / reopen, edit, delete); the agent view's strip order and its
 * open / closed memory; the plan-item link (D99). DOM-free: the unit tests
 * (`tests/web/v2-todo-card.test.ts`) read it.
 */
import type { SessionTodo } from '../../../core/api.ts';
import type { SessionStatus } from '../../../core/model.ts';
import { parseRemoteId } from '../../../core/peers.ts';
import type { Plan } from '../../../core/plans.ts';
import { formatTokens } from '../../../core/todo-actuals.ts';
import { todoHasPlan, todoPriorityRank } from '../../../core/todos.ts';
import { TASK_COLUMN_LOOK, type TaskColumn, estimateText, overEstimate, priorityLook, taskColumnOf, workerOf } from '../agents/tasks/tasks-model.ts';
import { TASKS_WORDS, type Tone } from '../glossary.ts';

/** The status words (the Tasks board's columns: Review is derived, D102). */
const STATUS_WORD: Readonly<Record<TaskColumn, string>> = { open: TASKS_WORDS.colOpen, progress: TASKS_WORDS.colProgress, review: TASKS_WORDS.colReview, done: TASKS_WORDS.colDone };

/** A card's status: icon + word + colour (never colour alone). */
export interface TodoCardStatus {
  readonly key: TaskColumn;
  readonly label: string;
  readonly icon: string;
  readonly tone: Tone | null;
}

/** Which of classic's actions the card offers, and why one is off. */
export interface TodoCardActionsAvailable {
  /** ▶ Start (in this agent): open and in-progress items (D75; again on an in-progress one). */
  readonly start: boolean;
  /** ▸ Run in its own agent (D76): not done, no run of its own already working on it. */
  readonly run: boolean;
  /** Why ▸ Run is off on a not-done item (`null` when on, or when done). */
  readonly runWhy: string | null;
  /** The check box: `done` marks it done, `reopen` opens a done one again. */
  readonly check: 'done' | 'reopen';
  /** Edit (title, description, handover plan, priority, estimate): not on a done item (classic). */
  readonly edit: boolean;
  /** Mark in progress / Mark not started (classic's ⋯, D75: nothing is sent); `null` on a done item. */
  readonly progress: 'in_progress' | 'open' | null;
  /** Delete (with Undo): always. */
  readonly delete: true;
}

/** Everything one card shows, from the item alone (plus its worker's status and the time). */
export interface TodoCardModel {
  readonly title: string;
  readonly status: TodoCardStatus;
  readonly priority: ReturnType<typeof priorityLook>;
  /** `est 20m`, `est 15m · 18m so far`, `est 1h · took 48m`; `''` for none. */
  readonly estimate: string;
  /** An in-progress or done item past its estimate (amber, with a clock). */
  readonly over: boolean;
  /** D78: a finished item's tokens (`41k tokens`), `null` when none are known or it is not done. */
  readonly tokens: string | null;
  /** D70: it has a real handover plan (not `No plan`). */
  readonly hasPlan: boolean;
  /** It has something to open (a description or a plan). */
  readonly hasDetails: boolean;
  readonly inProgress: boolean;
  readonly done: boolean;
  /** D81: captured, its agent has not filled it in yet. */
  readonly waitingFill: boolean;
  /** Its own agent (D76 run) works on it now. */
  readonly runActive: boolean;
  readonly actions: TodoCardActionsAvailable;
}

/**
 * The card of one item. `workerStatus` is the status of the agent working on it
 * ({@link workerOf}: its run's while that run is active, else its own agent's), which
 * turns an in-progress item into Review once that agent has stopped.
 */
export function todoCardModel(todo: SessionTodo, workerStatus: SessionStatus | null | undefined, now: number): TodoCardModel {
  const key = taskColumnOf(todo, workerStatus);
  const look = TASK_COLUMN_LOOK[key];
  const done = todo.state === 'done';
  const inProgress = todo.state === 'in_progress';
  const runActive = todo.runState === 'active' && Boolean(todo.runSessionId);
  const hasPlan = todoHasPlan(todo.plan);
  const tokens = done && typeof todo.actualTokens === 'number' && todo.actualTokens > 0 ? `${formatTokens(todo.actualTokens)} tokens` : null;
  return {
    title: todo.title ?? todo.text,
    status: { key, label: STATUS_WORD[key], icon: look.icon, tone: look.tone },
    priority: priorityLook(todo.priority),
    estimate: estimateText(todo, now),
    over: overEstimate(todo, now),
    tokens,
    hasPlan,
    hasDetails: Boolean(todo.description && todo.description.trim() !== '') || hasPlan,
    inProgress,
    done,
    waitingFill: todo.needsEnrichment === true && !done,
    runActive,
    actions: {
      start: !done,
      run: !done && !runActive,
      runWhy: !done && runActive ? TASKS_WORDS.alreadyRunning : null,
      check: done ? 'reopen' : 'done',
      edit: !done,
      progress: done ? null : inProgress ? 'open' : 'in_progress',
      delete: true,
    },
  };
}

/** The session whose live status decides a card's Review (re-exported for the callers). */
export { workerOf };

/**
 * The agent view's strip order: in progress first, then open by priority (urgent first),
 * each in the session's own order; done last, newest done first.
 */
export function stripOrder(todos: readonly SessionTodo[]): SessionTodo[] {
  const rank = (todo: SessionTodo): number => (todo.state === 'in_progress' ? 0 : todo.state === 'open' ? 1 : 2);
  return [...todos].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.state === 'done' && b.state === 'done' ? (b.doneAt ?? '').localeCompare(a.doneAt ?? '') : todoPriorityRank(a.priority) - todoPriorityRank(b.priority)) ||
      a.position - b.position,
  );
}

/** The strip's open / closed choice, kept per browser. */
export const TASK_STRIP_KEY = 'switchboard.v2.tasksStrip';

/** Reads the strip's choice: closed unless this browser opened it (`'1'`). */
export function readStripOpen(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(TASK_STRIP_KEY) === '1';
  } catch {
    return false;
  }
}

/** Keeps the strip's choice in this browser (best effort: private mode just does not remember). */
export function writeStripOpen(storage: Pick<Storage, 'setItem'> | null, open: boolean): void {
  try {
    storage?.setItem(TASK_STRIP_KEY, open ? '1' : '0');
  } catch {
    // Not remembered.
  }
}

/** D99: the plan step an item is (its project, the step's name, the project's address). */
export interface TodoPlanLink {
  readonly planId: string;
  readonly title: string;
  readonly step: string;
  readonly href: string;
}

/**
 * D99: the project step that works on this item, `null` when it belongs to none. A plan's
 * items point at todos of the plan's own agent (`sourceSessionId`); a paired computer's plan
 * names its sessions by their own ids (`r~<machine>~<id>` here).
 */
export function todoPlanLink(plans: readonly Plan[], todo: Pick<SessionTodo, 'id' | 'sessionId'>): TodoPlanLink | null {
  for (const plan of plans) {
    if (!sameSession(plan.sourceSessionId, todo.sessionId, plan)) continue;
    const item = plan.items.find((candidate) => candidate.todoId === todo.id);
    if (!item) continue;
    const step = item.key && !item.title.startsWith(item.key) ? `${item.key} ${item.title}` : item.title;
    return { planId: plan.id, title: plan.title, step, href: `/projects/${encodeURIComponent(plan.id)}` };
  }
  return null;
}

function sameSession(candidate: string, sessionId: string, plan: Pick<Plan, 'machine'>): boolean {
  if (candidate === sessionId) return true;
  const remote = parseRemoteId(sessionId);
  return remote !== null && plan.machine !== null && plan.machine.id === remote.machineId && candidate === remote.id;
}
