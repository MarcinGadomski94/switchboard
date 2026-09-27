/**
 * Agents of a session (decisions gap #8; `docs/derivations.md` → *Agents*): the
 * session's main agent plus one agent per Agent/Task tool call. Workflow agents
 * would be a third kind, but the CLI's stream-json does not show them (M0.1), so
 * none are derived.
 */
import type { SessionMode, SessionStatus } from '../model.ts';

/** The fields of a new subagent, from its Agent/Task `tool_use`. */
export interface SubagentSeed {
  readonly name: string;
  readonly description: string | null;
  readonly subagentType: string | null;
}

/**
 * The main agent's name: `orchestrator` in orchestrator mode (the router's own
 * word for it), the only solution's name in single-solution mode, else `main`.
 */
export function mainAgentName(mode: SessionMode | null, solutions: readonly string[]): string {
  if (mode === 'orchestrator') return 'orchestrator';
  if (mode === 'single' && solutions.length === 1 && solutions[0]) return solutions[0];
  return 'main';
}

/** A subagent from the Agent/Task `tool_use` input: named by its `subagent_type`, described by its `description`. */
export function subagentFromToolUse(input: Readonly<Record<string, unknown>>): SubagentSeed {
  const type = typeof input['subagent_type'] === 'string' && input['subagent_type'] !== '' ? (input['subagent_type'] as string) : null;
  const description = typeof input['description'] === 'string' && input['description'] !== '' ? (input['description'] as string) : null;
  return { name: type ?? 'agent', description, subagentType: type };
}

/**
 * A subagent's status from its task's final status (`task_updated.patch.status`,
 * `task_notification.status`): `completed` → `done`, `failed` / `error` → `fail`,
 * `killed` / `stopped` (it was cut off, e.g. by a pause) → `idle`. Anything else
 * leaves it running.
 */
export function agentStatusFromTask(status: string | null): SessionStatus {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
    case 'error':
      return 'fail';
    case 'killed':
    case 'stopped':
      return 'idle';
    default:
      return 'run';
  }
}

/** `true` if a task status ends the task. */
export function isTaskFinished(status: string | null): boolean {
  return agentStatusFromTask(status) !== 'run';
}

/** `system/task_started.task_type` of a subagent (a background shell is `local_bash`). */
export const AGENT_TASK_TYPE = 'local_agent';
