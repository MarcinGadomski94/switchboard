/**
 * D77 (`docs/todos.md` → *Board*): the Todos page's board, its pure rules: the columns,
 * the filters, the order within a column and what a drop into a column does. Shared by
 * the UI (`src/web/views/TodoBoard.tsx`) and its tests. Pure: no I/O.
 */
import type { SessionTodo, TodoGroup, TodoPatchInput, TodoPriority, TodoState } from './api.ts';
import { isTodoPriority, todoPriorityRank } from './todos.ts';

/** The board's columns, left to right. */
export const BOARD_COLUMNS: readonly TodoState[] = ['open', 'in_progress', 'review', 'done'];

/** A column's heading. */
export const BOARD_COLUMN_LABELS: Readonly<Record<TodoState, string>> = { open: 'Open', in_progress: 'In progress', review: 'Review', done: 'Done' };

/** One card on the board: the item and its session's group. */
export interface BoardCard {
  readonly todo: SessionTodo;
  readonly group: TodoGroup;
}

/** The board's filters (`all` / `''` = no filter). `machine`: `local` = this machine, else a paired machine's id. */
export interface BoardFilters {
  readonly priority: TodoPriority | 'all';
  readonly machine: string;
  readonly folder: string;
  readonly session: string;
  readonly search: string;
}

/** No filter. */
export const NO_BOARD_FILTERS: BoardFilters = { priority: 'all', machine: 'all', folder: 'all', session: 'all', search: '' };

/** A group's folder as the filter names it (its path, `''` when unknown). */
export function boardFolderOf(group: Pick<TodoGroup, 'folderPath'>): string {
  return group.folderPath ?? '';
}

/** `true` when the card passes the filters (the search matches the title, description or session title, any case). */
export function boardCardMatches(card: BoardCard, filters: BoardFilters): boolean {
  const { todo, group } = card;
  if (filters.priority !== 'all' && (isTodoPriority(todo.priority) ? todo.priority : 'medium') !== filters.priority) return false;
  if (filters.machine !== 'all' && (filters.machine === 'local' ? group.machine !== null : group.machine?.id !== filters.machine)) return false;
  if (filters.folder !== 'all' && boardFolderOf(group) !== filters.folder) return false;
  if (filters.session !== 'all' && group.sessionId !== filters.session) return false;
  const needle = filters.search.trim().toLowerCase();
  if (needle !== '') {
    const haystack = [todo.title ?? todo.text, todo.description ?? '', group.title].join('\n').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/**
 * The board's columns: every group's items that pass the filters, by state; within a column by
 * priority (urgent first), then the sessions in the page's order (most recently active first),
 * then the session's own order (position).
 */
export function boardColumns(groups: readonly TodoGroup[], filters: BoardFilters): Readonly<Record<TodoState, BoardCard[]>> {
  const out: Record<TodoState, BoardCard[]> = { open: [], in_progress: [], review: [], done: [] };
  const rank = new Map(groups.map((group, index) => [group.sessionId, index]));
  for (const group of groups) {
    for (const todo of group.todos) {
      const card = { todo, group };
      if (!boardCardMatches(card, filters)) continue;
      (out[todo.state] ?? out.open).push(card);
    }
  }
  for (const state of BOARD_COLUMNS) {
    out[state].sort(
      (a, b) =>
        todoPriorityRank(a.todo.priority) - todoPriorityRank(b.todo.priority) ||
        (rank.get(a.group.sessionId) ?? 0) - (rank.get(b.group.sessionId) ?? 0) ||
        a.todo.position - b.todo.position,
    );
  }
  return out;
}

/**
 * What a drop of `todo` into column `to` changes (`PUT …/todos/{id}`), `null` when it changes
 * nothing or is not allowed: Review only for an item with a run session; Done means done (the
 * review is skipped); In progress marks it in progress without sending anything.
 */
export function boardDrop(todo: Pick<SessionTodo, 'state' | 'runSessionId'>, to: TodoState): TodoPatchInput | null {
  if (todo.state === to) return null;
  if (to === 'review') return todo.runSessionId ? { state: 'review' } : null;
  if (to === 'done') return { state: 'done', skipReview: true };
  return { state: to };
}

/** `true` when `todo` may be dropped into column `to` (the drag's highlight). */
export function boardCanDrop(todo: Pick<SessionTodo, 'state' | 'runSessionId'>, to: TodoState): boolean {
  return boardDrop(todo, to) !== null;
}
