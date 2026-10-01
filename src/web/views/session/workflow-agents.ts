import type { Agent, AgentActivity, Session, SessionActivity, WorkflowRun } from '../../../core/api.ts';
import type { SessionStatus } from '../../../core/model.ts';

/**
 * D51: a Workflow's agents in the right panel and the chat (`docs/session-panel.md`
 * → *Workflow agents*), kept free of React so `tests/web` can check them. The
 * agents are in `Session.agents` (`kind: 'workflow'`, `Agent.workflow`), their runs
 * in `Session.workflows`.
 */

/** Running workflow agents shown as cards per run, at most (the rest: one "+N more" line; the overview lists them all). */
export const WORKFLOW_CARD_CAP = 6;

/** The label over a workflow agent's first bubble (its brief, from the workflow's script). */
export const WORKFLOW_BRIEF_LABEL = 'Brief from the workflow';

/** The note in a workflow agent's composer place (its first part). */
export const WORKFLOW_NO_MESSAGES = 'Workflow agents take no messages';

/** `true` for a Workflow's agent. */
export function isWorkflowAgent(agent: Pick<Agent, 'kind'>): boolean {
  return agent.kind === 'workflow';
}

/**
 * A running workflow agent's action as a D19 activity entry (its card, its row, its
 * chat's line): its last tool (`● Read: notes.md  0:12`, timed since that call),
 * else `Thinking…` since it started. `null` while it does not run.
 */
export function workflowActivity(agent: Pick<Agent, 'kind' | 'status' | 'workflow'>): AgentActivity | null {
  const workflow = agent.workflow;
  if (agent.kind !== 'workflow' || !workflow || agent.status !== 'run') return null;
  const startedAt = workflow.startedAt ?? workflow.action?.since ?? null;
  if (workflow.action) {
    return { state: 'tool', since: workflow.action.since, startedAt: startedAt ?? workflow.action.since, tool: workflow.action.tool, summary: workflow.action.summary };
  }
  return startedAt ? { state: 'thinking', since: startedAt, startedAt, tool: null, summary: null } : null;
}

/** An agent's live action: its entry in `Session.activity.agents`, else (D51) a workflow agent's own. */
export function agentActivity(activity: SessionActivity | null, agent: Pick<Agent, 'id' | 'kind' | 'status' | 'workflow'>): AgentActivity | null {
  return activity?.agents[agent.id] ?? workflowActivity(agent);
}

/** A run's Status words: `3/7 done · phase Review` while it runs, `✓ 7/7 done`, `✕ failed · 2/7 done`, `stopped · 2/7 done`. */
export function workflowRunStatusText(run: Pick<WorkflowRun, 'status' | 'doneCount' | 'agentCount' | 'phase'>): string {
  const counts = `${run.doneCount}/${run.agentCount} done`;
  switch (run.status) {
    case 'run':
      return run.phase ? `● ${counts} · phase ${run.phase}` : `● ${counts}`;
    case 'done':
      return `✓ ${counts}`;
    case 'fail':
      return `✕ failed · ${counts}`;
    default:
      return `stopped · ${counts}`;
  }
}

/** The progress of a run: `3/7 agents done · phase Review` (without a phase: the counts only). */
export function workflowProgressText(run: Pick<WorkflowRun, 'doneCount' | 'agentCount' | 'phase'>): string {
  const counts = `${run.doneCount}/${run.agentCount} agents done`;
  return run.phase ? `${counts} · phase ${run.phase}` : counts;
}

/** The background line's progress (D43's "Running a workflow: …" gains it): `3/7 agents done · phase Review`; `null` before any agent. */
export function workflowBackgroundProgress(progress: { readonly doneCount: number; readonly agentCount: number; readonly phase: string | null } | null | undefined): string | null {
  return progress && progress.agentCount > 0 ? workflowProgressText(progress) : null;
}

/** One entry of the overview's derived table in D51's grouping. */
export type OverviewEntry<A> =
  | { readonly kind: 'agent'; readonly agent: A; readonly depth: 0 | 1 }
  | { readonly kind: 'workflow'; readonly run: WorkflowRun; readonly status: SessionStatus; readonly statusText: string };

/**
 * The overview's rows in D51's grouping: the other agents first (as before), then
 * each run, oldest first: a workflow row (its name, summary and progress), then its
 * agents indented. D37's fold applies: agents that are done have no row; a run's
 * row goes too once the run is done and none of its agents is left. `shown` is the
 * list after the fold (`isFinishedSubagent`), `runs` the session's runs.
 */
export function overviewEntries<A extends Pick<Agent, 'kind' | 'workflow'>>(shown: readonly A[], runs: readonly WorkflowRun[]): OverviewEntry<A>[] {
  const known = new Set(runs.map((run) => run.runId));
  const grouped = (agent: A): boolean => agent.kind === 'workflow' && agent.workflow != null && known.has(agent.workflow.runId);
  const out: OverviewEntry<A>[] = shown.filter((agent) => !grouped(agent)).map((agent) => ({ kind: 'agent', agent, depth: 0 }));
  for (const run of runs) {
    const agents = shown.filter((agent) => grouped(agent) && agent.workflow?.runId === run.runId);
    if (agents.length === 0 && run.status === 'done') continue;
    out.push({ kind: 'workflow', run, status: run.status, statusText: workflowRunStatusText(run) });
    for (const agent of agents) out.push({ kind: 'agent', agent, depth: 1 });
  }
  return out;
}

/** D51: a run whose cards were cut: how many more of its agents the overview lists. */
export interface MoreCards {
  readonly runId: string;
  readonly name: string;
  readonly count: number;
}

/** The "+N more" line of a cut run: `+4 more in proj-3014-final-round` (a button: it opens the run's cards, D51 ruling D51-card-cap). */
export function moreCardsLine(more: MoreCards): string {
  return `+${more.count} more in ${more.name}`;
}

/** The line under an opened run's cards that cuts them again: `Show fewer · proj-3014-final-round`. */
export function fewerCardsLine(more: MoreCards): string {
  return `Show fewer · ${more.name}`;
}

/**
 * The agent cards after D51's cap: at most {@link WORKFLOW_CARD_CAP} cards per run
 * (in order: running ones first, then the others), the rest counted per run
 * (`more`). A run in `open` (its "+N more" line was clicked) shows every card and
 * is listed in `fewer` (its "Show fewer" line). While the finished cards are
 * expanded (D37) every card shows.
 */
export function cappedCards<A extends Pick<Agent, 'kind' | 'status' | 'workflow'>>(
  shown: readonly A[],
  runs: readonly WorkflowRun[],
  expanded: boolean,
  open: ReadonlySet<string> = new Set(),
): { readonly cards: readonly A[]; readonly more: readonly MoreCards[]; readonly fewer: readonly MoreCards[] } {
  if (expanded) return { cards: shown, more: [], fewer: [] };
  const byRun = new Map<string, A[]>();
  for (const agent of shown) {
    const runId = agent.kind === 'workflow' ? agent.workflow?.runId : undefined;
    if (!runId) continue;
    const list = byRun.get(runId);
    if (list) list.push(agent);
    else byRun.set(runId, [agent]);
  }
  const hidden = new Set<A>();
  const more: MoreCards[] = [];
  const fewer: MoreCards[] = [];
  for (const [runId, agents] of byRun) {
    if (agents.length <= WORKFLOW_CARD_CAP) continue;
    if (open.has(runId)) {
      fewer.push({ runId, name: runs.find((run) => run.runId === runId)?.name ?? runId, count: agents.length - WORKFLOW_CARD_CAP });
      continue;
    }
    const ranked = [...agents].sort((a, b) => Number(b.status === 'run') - Number(a.status === 'run'));
    for (const agent of ranked.slice(WORKFLOW_CARD_CAP)) hidden.add(agent);
    more.push({ runId, name: runs.find((run) => run.runId === runId)?.name ?? runId, count: agents.length - WORKFLOW_CARD_CAP });
  }
  return { cards: shown.filter((agent) => !hidden.has(agent)), more, fewer };
}

/** D51 ruling D51-resume: the button on a stopped or failed run's row. */
export const RESUME_RUN = 'Resume run';

/**
 * The message "Resume run" sends the session's agent (the normal message path:
 * D44 queues it, a paused session resumes on it): call the Workflow tool with the
 * run's script and `resumeFromRunId` (the parameter names in CLI 2.1.284), plus the
 * run's `args` when it had any; done agents replay from the CLI's cache.
 */
export function resumeRunMessage(run: Pick<WorkflowRun, 'runId' | 'name' | 'resume'>): string | null {
  const resume = run.resume;
  if (!resume) return null;
  const args = resume.args !== null && resume.args !== undefined ? `, args: ${JSON.stringify(resume.args)}` : '';
  return [
    `Resume the stopped workflow run ${run.runId} (${run.name}). Call the Workflow tool once with exactly:`,
    '',
    `Workflow({ scriptPath: ${JSON.stringify(resume.scriptPath)}, resumeFromRunId: ${JSON.stringify(run.runId)}${args} })`,
    '',
    'Do not edit the script. Its agents that already finished replay from the cache; the others run again.',
  ].join('\n');
}

/**
 * Why "Resume run" cannot be used now, or `null` when it can: the session is
 * closed (reopen it first), or it is a paired machine's that cannot be reached.
 * Hooked sessions take messages through their hooks (D48), so they can.
 */
export function resumeBlocked(session: Pick<Session, 'closedAt'> & { readonly machine?: Session['machine'] }): string | null {
  if (session.closedAt) return 'Reopen the session to resume the run';
  // Fix · peer reconnects: a reconnecting machine takes it (held until it is back).
  if (session.machine && session.machine.state !== 'online' && session.machine.state !== 'reconnecting') return `${session.machine.name} is unreachable`;
  return null;
}
