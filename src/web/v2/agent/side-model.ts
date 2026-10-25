import type { SessionDetail } from '../../../core/api.ts';
import type { MemorySessionCount } from '../../../core/memory.ts';
import type { SessionStatus } from '../../../core/model.ts';
import { parseRemoteId } from '../../../core/peers.ts';
import type { Plan } from '../../../core/plans.ts';
import { reportedTableView, overviewRows, type ReportedTableView } from '../../views/session/agent-overview.ts';
import { hasSubagentChat } from '../../views/session/chat.ts';
import { isFinishedSubagent } from '../../views/session/right-panel.ts';
import { overviewEntries, resumeRunMessage } from '../../views/session/workflow-agents.ts';
import { type V2Status, sessionStatusToV2 } from '../glossary.ts';
import { projectStatus, stepLook, stepName } from '../projects/project-model.ts';

/**
 * D131 · lane X · the side panel's added groups, pure: the agents overview (D21 /
 * D27 / D51: one row per agent that has not finished, each Workflow run with its
 * agents under it and its Resume run, and the table the agent printed), the
 * project the agent belongs to (D99: its plan agent or one of its steps), and the
 * notes line (D107: what agents know for its folder, with the Notes link). The
 * rules are the classic right panel's (`views/session/agent-overview.ts`,
 * `workflow-agents.ts`, `plans/PlansNav.tsx`, `memory/MemoryNav.tsx`). No React.
 */

/** A row of the agents overview. */
export type OverviewItem =
  | {
      readonly kind: 'agent';
      readonly id: string;
      readonly main: boolean;
      readonly name: string;
      readonly description: string;
      /** The code project's folder name, `—` without one; its whole path is {@link solutionPath}. */
      readonly solution: string;
      readonly solutionPath: string | null;
      readonly status: V2Status;
      /** The classic status (the live activity's colour rule needs it). */
      readonly sessionStatus: SessionStatus;
      /** The status text when the agent is not active (its own status text, else the status word). */
      readonly statusText: string;
      /** 1 = a Workflow's agent under its run's row. */
      readonly depth: 0 | 1;
      /** A helper with a chat of its own (D36). */
      readonly opensChat: boolean;
    }
  | {
      readonly kind: 'workflow';
      readonly runId: string;
      readonly name: string;
      readonly summary: string;
      readonly status: V2Status;
      readonly statusText: string;
      /** The message Resume run sends (a stopped or failed run that can resume), else `null`. */
      readonly resume: string | null;
    };

/** The derived overview (D21), Workflow runs grouped (D51); finished helpers leave it (D37). */
export function overviewItems(session: Pick<SessionDetail, 'agents' | 'status' | 'task' | 'workflows'>): OverviewItem[] {
  const shown = session.agents.filter((agent) => !isFinishedSubagent(agent));
  const rows = new Map(overviewRows(shown, session).map((row) => [row.id, row]));
  const out: OverviewItem[] = [];
  for (const entry of overviewEntries(shown, session.workflows ?? [])) {
    if (entry.kind === 'workflow') {
      out.push({ kind: 'workflow', runId: entry.run.runId, name: entry.run.name, summary: entry.run.summary ?? '', status: sessionStatusToV2(entry.status), statusText: entry.statusText, resume: resumeRunMessage(entry.run) });
      continue;
    }
    const row = rows.get(entry.agent.id);
    if (!row) continue;
    out.push({
      kind: 'agent',
      id: row.id,
      main: row.main,
      name: row.name,
      description: row.description,
      solution: row.solution,
      solutionPath: row.solutionPath,
      status: sessionStatusToV2(row.status),
      sessionStatus: row.status,
      statusText: row.statusText,
      depth: entry.depth,
      opensChat: hasSubagentChat(entry.agent),
    });
  }
  return out;
}

/** The overview's summary in the group's header: "3 agents · 1 working". */
export function overviewSummary(items: readonly OverviewItem[]): string {
  const agents = items.filter((item) => item.kind === 'agent');
  const working = agents.filter((item) => item.kind === 'agent' && (item.sessionStatus === 'run' || item.sessionStatus === 'need')).length;
  const word = agents.length === 1 ? '1 agent' : `${agents.length} agents`;
  return working > 0 ? `${word} · ${working} working` : word;
}

/** The table the agent printed (D27), parsed; `null` = it does not parse (show it as printed). */
export function reportedView(session: Pick<SessionDetail, 'reportedTable'>): ReportedTableView | null {
  return session.reportedTable ? reportedTableView(session.reportedTable) : null;
}

/** The agent's place in a project (D99). */
export interface AgentProject {
  readonly planId: string;
  readonly title: string;
  /** `source` = the project's own agent (its plan was made here); `step` = it runs one of its steps. */
  readonly role: 'source' | 'step';
  /** The step's name ("PROJ-12 · Add the API"), for a step. */
  readonly step: string | null;
  /** The step's status (a step), else the project's. */
  readonly status: V2Status;
  readonly statusLabel: string;
  /** "3 of 7 steps done". */
  readonly progress: string;
  /** The project's v2 address. */
  readonly href: string;
}

/** Whether `candidate` (as a plan names a session) is the agent `sessionId` (as this computer addresses it). */
function sameSession(candidate: string | null, sessionId: string, plan: Pick<Plan, 'machine'>): boolean {
  if (candidate === null) return false;
  if (candidate === sessionId) return true;
  // A paired computer's plan may name its sessions by their own ids.
  const remote = parseRemoteId(sessionId);
  return remote !== null && plan.machine !== null && plan.machine.id === remote.machineId && candidate === remote.id;
}

/** The projects the agent belongs to: as their own agent, or running a step (D99); closed / cancelled ones too, newest first as listed. */
export function agentProjects(plans: readonly Plan[], sessionId: string): AgentProject[] {
  const out: AgentProject[] = [];
  for (const plan of plans) {
    const progress = `${plan.progress.done} of ${plan.progress.total} step${plan.progress.total === 1 ? '' : 's'} done`;
    const href = `/projects/${encodeURIComponent(plan.id)}`;
    const item = plan.items.find((candidate) => sameSession(candidate.runSessionId, sessionId, plan)) ?? null;
    if (item) {
      const look = stepLook(item, plan.items);
      out.push({ planId: plan.id, title: plan.title, role: 'step', step: stepName(item), status: look.status, statusLabel: look.label, progress, href });
      continue;
    }
    if (sameSession(plan.sourceSessionId, sessionId, plan)) {
      const look = projectStatus(plan);
      out.push({ planId: plan.id, title: plan.title, role: 'source', step: null, status: look.status, statusLabel: look.label, progress, href });
    }
  }
  return out;
}

/** The notes line (D107): the Notes page scoped to the agent's folder (`/notes?scope=<folder>`), `null` without a folder. */
export function notesHref(count: Pick<MemorySessionCount, 'folder'> | null, folderPath: string | null | undefined): string | null {
  const folder = count?.folder ?? folderPath ?? null;
  return folder ? `/notes?scope=${encodeURIComponent(folder)}` : null;
}
