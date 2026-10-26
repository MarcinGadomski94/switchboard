/**
 * D131 · the v2 Tasks page (`/tasks`, lane A): its pure rules. The board's four
 * columns over the todo states (D75 / D102), the card's estimate-vs-actual line,
 * the priority's look, the order within a column, what a move changes, the quick
 * add's title and target, and the estimates' accuracy line. DOM-free: the Node
 * typecheck and the unit tests (`tests/web/v2-tasks.test.ts`) read it.
 */
import type { SessionStatus } from '../../../../core/model.ts';
import type { SessionTodo, TodoActualsTotal, TodoGroup, TodoPatchInput, TodoPriority } from '../../../../core/api.ts';
import type { MachineState } from '../../../../core/peers.ts';
import { formatActual } from '../../../../core/todo-actuals.ts';
import { captureTitle } from '../../../../core/todo-capture.ts';
import { TODO_TITLE_MAX, formatTodoMinutes, todoPriorityRank } from '../../../../core/todos.ts';
import type { Tone } from '../../glossary.ts';

/** The board's columns, left to right. */
export type TaskColumn = 'open' | 'progress' | 'review' | 'done';

export const TASK_COLUMNS: readonly TaskColumn[] = ['open', 'progress', 'review', 'done'];

/** How a column's heading looks: its word (from the glossary at render), icon and colour (the prototype's). */
export const TASK_COLUMN_LOOK: Readonly<Record<TaskColumn, { readonly icon: string; readonly tone: Tone | null }>> = {
  open: { icon: 'circle', tone: null },
  progress: { icon: 'dot', tone: 'blue' },
  review: { icon: 'half', tone: 'violet' },
  done: { icon: 'check-circle', tone: 'green' },
};

/**
 * The session whose agent works on the item: its run session while that run is active
 * (D76, ▸ Run in its own agent), else its own session.
 */
export function workerOf(todo: Pick<SessionTodo, 'sessionId' | 'runSessionId' | 'runState'>): string {
  return todo.runState === 'active' && todo.runSessionId ? todo.runSessionId : todo.sessionId;
}

/**
 * The column of an item. The service has three states (open, in progress, done; D102
 * removed `review`), so **Review** is derived: an item in progress whose working agent
 * (`workerOf`) is known and not running (`status !== 'run'`) waits for the developer to
 * check it and mark it done. An unknown worker (not in the session list yet) stays In progress.
 */
export function taskColumnOf(todo: Pick<SessionTodo, 'state'>, workerStatus: SessionStatus | null | undefined): TaskColumn {
  if (todo.state === 'done') return 'done';
  if (todo.state !== 'in_progress') return 'open';
  return workerStatus && workerStatus !== 'run' ? 'review' : 'progress';
}

/** One card: the item, its agent's group, and its column. */
export interface TaskCard {
  readonly todo: SessionTodo;
  readonly group: TodoGroup;
  readonly column: TaskColumn;
}

/**
 * Every group's items by column. `statusOf(sessionId)` answers a session's live status
 * (`null` when unknown); `hidden` holds ids that are on their way out (a delete inside its
 * Undo window). Within a column: by priority (urgent first), then the groups in the
 * service's order (most recently active first), then the session's own order; Done by
 * the newest done first.
 */
export function boardOf(groups: readonly TodoGroup[], statusOf: (sessionId: string) => SessionStatus | null, hidden: ReadonlySet<string> = new Set()): Readonly<Record<TaskColumn, TaskCard[]>> {
  const out: Record<TaskColumn, TaskCard[]> = { open: [], progress: [], review: [], done: [] };
  const rank = new Map(groups.map((group, index) => [group.sessionId, index]));
  for (const group of groups) {
    for (const todo of group.todos) {
      if (hidden.has(cardKey(group.sessionId, todo.id))) continue;
      const column = taskColumnOf(todo, statusOf(workerOf(todo)));
      out[column].push({ todo, group, column });
    }
  }
  const byPriority = (a: TaskCard, b: TaskCard): number =>
    todoPriorityRank(a.todo.priority) - todoPriorityRank(b.todo.priority) || (rank.get(a.group.sessionId) ?? 0) - (rank.get(b.group.sessionId) ?? 0) || a.todo.position - b.todo.position;
  out.open.sort(byPriority);
  out.progress.sort(byPriority);
  out.review.sort(byPriority);
  out.done.sort((a, b) => (b.todo.doneAt ?? '').localeCompare(a.todo.doneAt ?? '') || byPriority(a, b));
  return out;
}

/**
 * The rail's Tasks badge (fix after 2.0): the items not done yet across every group the
 * board shows (this computer's and the paired ones'), i.e. the Open, In progress and
 * Review columns together. Review is derived from In progress, so only the state counts.
 */
export function unfinishedCount(groups: readonly Pick<TodoGroup, 'todos'>[] | null | undefined): number {
  let count = 0;
  for (const group of groups ?? []) for (const todo of group.todos) if (todo.state !== 'done') count += 1;
  return count;
}

/** A card's key across sessions (item ids are per session). */
export function cardKey(sessionId: string, todoId: string): string {
  return `${sessionId}\u0000${todoId}`;
}

/** The look of a priority: its word, icon and colour (never colour alone; the prototype's `.prio`). */
export function priorityLook(priority: TodoPriority | string | null | undefined): { readonly label: string; readonly icon: string; readonly tone: Tone; readonly key: TodoPriority } {
  switch (priority) {
    case 'urgent':
      return { key: 'urgent', label: 'Urgent', icon: 'alert', tone: 'red' };
    case 'high':
      return { key: 'high', label: 'High', icon: 'bolt', tone: 'amber' };
    case 'low':
      return { key: 'low', label: 'Low', icon: 'chev-down', tone: 'grey' };
    default:
      return { key: 'medium', label: 'Medium', icon: 'dot', tone: 'grey' };
  }
}

/**
 * The time an item has spent in progress so far (ms): its ended spans (`actualMs`) plus,
 * while in progress, the running one since `startedAt`. `null` when it never started.
 */
export function elapsedMs(todo: Pick<SessionTodo, 'state' | 'actualMs' | 'startedAt'>, now: number): number | null {
  const ended = typeof todo.actualMs === 'number' ? todo.actualMs : null;
  if (todo.state !== 'in_progress') return ended;
  const started = todo.startedAt ? Date.parse(todo.startedAt) : Number.NaN;
  const running = Number.isFinite(started) ? Math.max(0, now - started) : 0;
  if (ended === null && !Number.isFinite(started)) return null;
  return (ended ?? 0) + running;
}

/**
 * The card's estimate vs actual (the prototype's): `est 20m` (open), `est 15m · 18m so far`
 * (in progress), `est 1h · took 48m` (done); each part only when known; `''` for none.
 */
export function estimateText(todo: Pick<SessionTodo, 'state' | 'estimateMinutes' | 'actualMs' | 'startedAt'>, now: number): string {
  const parts: string[] = [];
  if (typeof todo.estimateMinutes === 'number' && todo.estimateMinutes > 0) parts.push(`est ${formatTodoMinutes(todo.estimateMinutes)}`);
  if (todo.state !== 'open') {
    const ms = elapsedMs(todo, now);
    if (ms !== null) parts.push(todo.state === 'done' ? `took ${formatActual(ms)}` : `${formatActual(ms)} so far`);
  }
  return parts.join(' · ');
}

/** `true` when an in-progress item has run past its estimate (the line turns amber, with the word "over"). */
export function overEstimate(todo: Pick<SessionTodo, 'state' | 'estimateMinutes' | 'actualMs' | 'startedAt'>, now: number): boolean {
  if (typeof todo.estimateMinutes !== 'number' || todo.state === 'open') return false;
  const ms = elapsedMs(todo, now);
  return ms !== null && ms > todo.estimateMinutes * 60_000;
}

/**
 * What moving an item to a column changes (`PUT …/todos/{id}`), `null` when nothing or
 * when the column is not a state (Review is derived: nothing can be put there).
 */
export function movePatch(todo: Pick<SessionTodo, 'state'>, to: TaskColumn): TodoPatchInput | null {
  const state = to === 'open' ? 'open' : to === 'progress' ? 'in_progress' : to === 'done' ? 'done' : null;
  if (state === null || state === todo.state) return null;
  return { state };
}

/** The columns an item can be moved to from the ⋯ menu (every state but its own). */
export function moveTargets(todo: Pick<SessionTodo, 'state'>): TaskColumn[] {
  return (['open', 'progress', 'done'] as const).filter((column) => movePatch(todo, column) !== null);
}

/**
 * The quick add's text as a capture (D81): a leading `task ` (the palette's command
 * word) dropped; a text over 120 characters or with a line break gets a short title cut
 * at a word and keeps the whole text as its note. `null` for nothing to add.
 */
export function quickAddInput(text: string): { readonly title: string; readonly note: string | null } | null {
  const body = text.replace(/^\s*task\s+/i, '').trim();
  if (body === '') return null;
  if (body.length <= TODO_TITLE_MAX && !/[\r\n]/.test(body)) return { title: body, note: null };
  return { title: captureTitle(body, TODO_TITLE_MAX), note: body };
}

/** Why Start here / Run in its own agent cannot run on this computer now (`null` = it can). */
export function blockedReason(machine: { readonly name: string; readonly state: MachineState } | null | undefined, words: { readonly offline: (name: string) => string; readonly reconnecting: (name: string) => string }): string | null {
  if (!machine || machine.state === 'online') return null;
  return machine.state === 'reconnecting' ? words.reconnecting(machine.name) : words.offline(machine.name);
}

/**
 * The estimates' accuracy over every agent's completed, estimated items (D78's
 * `actuals`): 100% minus the relative error of the summed actual time against the summed
 * estimates, never below 0. `null` while nothing estimated has completed.
 */
export function estimateAccuracy(totals: ReadonlyArray<TodoActualsTotal | null | undefined>): { readonly percent: number; readonly count: number } | null {
  let estimate = 0;
  let actual = 0;
  let count = 0;
  for (const total of totals) {
    if (!total || total.estimated <= 0) continue;
    estimate += total.estimateMinutes * 60_000;
    actual += total.estimatedActualMs;
    count += total.estimated;
  }
  if (count === 0 || estimate <= 0) return null;
  const percent = Math.round(Math.max(0, 1 - Math.abs(actual - estimate) / estimate) * 100);
  return { percent, count };
}

/** The item a capture added: in the answered list, the newest one not in `before`. */
export function addedTodo(before: ReadonlySet<string>, after: readonly SessionTodo[]): SessionTodo | null {
  let found: SessionTodo | null = null;
  for (const todo of after) {
    if (before.has(todo.id)) continue;
    if (!found || todo.createdAt > found.createdAt) found = todo;
  }
  return found;
}
