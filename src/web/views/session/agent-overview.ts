import type { Agent } from '../../../core/api.ts';
import type { SessionStatus } from '../../../core/model.ts';
import { folderName } from '../../folders/folders.ts';
import { UNKNOWN, formatAge } from '../../shell/format.ts';
import { agentDescription, agentStatus } from './right-panel.ts';

/**
 * The right panel's agent overview (D21, `docs/session-panel.md` → *Agent
 * overview*), kept free of React so `tests/web` can check it: the derived table's
 * rows from `Session.agents` and the heading of the printed table the agent
 * reported (`SessionDetail.reportedTable`). The live Status (D19) comes from
 * `overviewActivityLabel` in `src/web/activity/activity.ts`.
 */

/** The section label (mono uppercase through the panel's `sb-sv-panel-label`, like "Agents & solutions"). */
export const OVERVIEW_LABEL = 'Agents overview';

/** The derived table's columns (D21). */
export const OVERVIEW_COLUMNS: readonly string[] = ['Agent', 'Description', 'Solution', 'Status'];

/**
 * The Status cell of an agent that is not active in a running turn and has no
 * status text of its own (D21: `✓ done`, `✕ failed`, `⏸ waiting`); the marks are
 * the chat's step marks, in the SPEC status colors.
 */
export const OVERVIEW_STATUS_WORDS: Readonly<Record<SessionStatus, string>> = {
  need: '⏸ waiting',
  run: '● running',
  done: '✓ done',
  fail: '✕ failed',
  idle: 'idle',
  paused: 'paused',
};

/** One row of the derived table. */
export interface OverviewRow {
  readonly id: string;
  /** `true` for the session's main agent (its thinking reads like the chat line). */
  readonly main: boolean;
  readonly name: string;
  /** Empty when there is none. */
  readonly description: string;
  /** The solution's folder name (`acme-app-front`), or `—` when the agent has not written into one. */
  readonly solution: string;
  /** The workspace-relative solution folder (the Solution cell's tooltip); `null` without one. */
  readonly solutionPath: string | null;
  /** Drives the Status cell's color (`statusColor`). */
  readonly status: SessionStatus;
  /** The Status cell while the agent is not active: its status text, else {@link OVERVIEW_STATUS_WORDS}. */
  readonly statusText: string;
}

/**
 * The derived table (D21): one row per agent in the order they started (the
 * session's agents: the main agent first, then one per Agent / Task call):
 * - Agent: the agent's name;
 * - Description: the agent card's (its own; the main agent's is the first line
 *   of the session's task);
 * - Solution: the folder name of the agent's `solutionPath`, `—` without one;
 * - Status: the agent's status text when set, else `✓ done` / `✕ failed` /
 *   `⏸ waiting` / `● running` / `idle` / `paused`; an agent the pause cut off
 *   reads `paused`, as on its card. While the agent is active, the view shows its
 *   live action instead (D19).
 */
export function overviewRows(
  agents: readonly Agent[],
  session: { readonly status: SessionStatus; readonly task: string },
): OverviewRow[] {
  return agents.map((agent) => {
    const { status, text } = agentStatus(agent, session.status);
    return {
      id: agent.id,
      main: agent.kind === 'main',
      name: agent.name,
      description: agentDescription(agent, session.task),
      solution: agent.solutionPath ? folderName(agent.solutionPath) : UNKNOWN,
      solutionPath: agent.solutionPath,
      status,
      statusText: text ?? OVERVIEW_STATUS_WORDS[status],
    };
  });
}

/** The printed table's heading without its age. */
export const REPORTED_HEADING = 'As reported by the agent';

/** The printed table's heading: `As reported by the agent · 3m` (the sidebar's relative age, `now` under a minute). */
export function reportedHeading(at: string, now: number): string {
  return `${REPORTED_HEADING} · ${formatAge(at, now)}`;
}
