/**
 * D188 · the Tasks page by agent: the agent filter (which agents' lists the board shows),
 * its address (`/tasks?agent=<id>[,…]`) and remembered value, and the board split into one
 * section per agent. DOM-free: the unit tests (`tests/web/v2-tasks-agents.test.ts`) read it.
 * A task belongs to the agent whose list holds it (its group), as its card's agent line says;
 * one run by another agent (D76) stays under its own list's agent.
 */
import type { SessionStatus } from '../../../../core/model.ts';
import type { TodoGroup } from '../../../../core/api.ts';
import { type TaskCard, type TaskColumn, TASK_COLUMNS, boardOf } from './tasks-model.ts';

/** The browser's remembered filter (localStorage). */
export const TASKS_AGENTS_KEY = 'v2.tasks.agents';
/** The browser's remembered "Group by agent" (localStorage, `'on'` / `'off'`). */
export const TASKS_GROUP_KEY = 'v2.tasks.group';
/** The sections folded while grouped (localStorage, a JSON list of session ids). */
export const TASKS_FOLDED_KEY = 'v2.tasks.folded';

/** One agent the filter offers: an agent that has tasks on the board. */
export interface TaskAgent {
  readonly sessionId: string;
  readonly title: string;
  /** The paired computer's name; `null` for this computer's agents. */
  readonly computer: string | null;
  /** Its tasks (every state). */
  readonly count: number;
  /** Its tasks not done yet. */
  readonly open: number;
}

/** The agents that have tasks, by title (then computer), each once. */
export function taskAgents(groups: readonly TodoGroup[]): TaskAgent[] {
  const out: TaskAgent[] = [];
  for (const group of groups) {
    if (group.todos.length === 0) continue;
    out.push({ sessionId: group.sessionId, title: group.title, computer: group.machine?.name ?? null, count: group.todos.length, open: group.todos.filter((todo) => todo.state !== 'done').length });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title) || (a.computer ?? '').localeCompare(b.computer ?? '') || a.sessionId.localeCompare(b.sessionId));
}

/** Whether an agent matches the filter's search text (its title or its computer, any case). */
export function agentMatches(agent: Pick<TaskAgent, 'title' | 'computer'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return agent.title.toLowerCase().includes(q) || (agent.computer ?? '').toLowerCase().includes(q);
}

/** The session ids an address names (`?agent=a,b`); `null` when it names none (the remembered filter applies). */
export function agentsFromSearch(search: string): string[] | null {
  const raw = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('agent');
  if (raw === null) return null;
  return [...new Set(raw.split(',').map((id) => id.trim()).filter((id) => id !== ''))];
}

/** The address's query for a filter (`?agent=…`, the ids kept as typed: `~` and `-` need no escape); `''` for every agent. */
export function agentsSearch(ids: readonly string[]): string {
  return ids.length === 0 ? '' : `?agent=${ids.map((id) => encodeURIComponent(id).replace(/%7E/gi, '~')).join(',')}`;
}

/** The address of an agent's tasks (the agent view's link). */
export function agentTasksPath(sessionId: string): string {
  return `/tasks${agentsSearch([sessionId])}`;
}

/** A remembered filter as stored (a JSON list of ids); anything else reads as every agent. */
export function readStoredAgents(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && id !== '') : [];
  } catch {
    return [];
  }
}

/** The groups the filter keeps (every one when it names none). */
export function filterGroups(groups: readonly TodoGroup[], ids: readonly string[]): readonly TodoGroup[] {
  if (ids.length === 0) return groups;
  const keep = new Set(ids);
  return groups.filter((group) => keep.has(group.sessionId));
}

/** A filter without the agents that no longer have tasks (a finished or archived one): it never hides the whole board for an agent you can't pick any more. */
export function liveFilter(ids: readonly string[], agents: readonly Pick<TaskAgent, 'sessionId'>[]): string[] {
  const known = new Set(agents.map((agent) => agent.sessionId));
  return ids.filter((id) => known.has(id));
}

/** Adds or removes one agent from the filter. */
export function toggleAgent(ids: readonly string[], sessionId: string): string[] {
  return ids.includes(sessionId) ? ids.filter((id) => id !== sessionId) : [...ids, sessionId];
}

/** One section of the grouped board: an agent and its own board (the same columns as the whole one). */
export interface AgentSection {
  readonly group: TodoGroup;
  readonly board: Readonly<Record<TaskColumn, TaskCard[]>>;
  /** Its cards on the board (all columns). */
  readonly total: number;
  /** Its cards not done yet (Open, In progress, Review). */
  readonly open: number;
}

/**
 * The board split by agent: one section per group with a card to show, in the service's
 * order (most recently active first), each with the board's own rules (`boardOf`).
 */
export function agentSections(groups: readonly TodoGroup[], statusOf: (sessionId: string) => SessionStatus | null, hidden: ReadonlySet<string> = new Set()): AgentSection[] {
  const out: AgentSection[] = [];
  for (const group of groups) {
    const board = boardOf([group], statusOf, hidden);
    const total = TASK_COLUMNS.reduce((sum, column) => sum + board[column].length, 0);
    if (total === 0) continue;
    out.push({ group, board, total, open: total - board.done.length });
  }
  return out;
}
