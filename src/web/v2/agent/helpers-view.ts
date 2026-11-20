/**
 * D180 · what the side panel's Helpers tab lists: the agents overview (`side-model.ts`)
 * with a row for every helper. Details' overview drops a helper the moment it is done
 * (D37) and never shows one launched in the background (its own row ends at once); here
 * both keep their row, so a helper's chat stays one click away while it works and after
 * it finished. The fold is the overview's: the working ones, those that ended in the
 * last 10 minutes, the older ones folded. Pure.
 *
 * {@link helperSections} lays the rows out in the tab's sections: **Needs you** (failed and
 * waiting helpers, and a stopped run that can resume), **Working** (each running Workflow run with its working helpers under it,
 * then the working helpers on their own), and **N finished** (folded).
 */
import type { BackgroundTask, SessionDetail } from '../../../core/api.ts';
import { withPendingHelpers } from './helpers-model.ts';
import { type OverviewFold, type OverviewItem, foldOverview, overviewItems } from './side-model.ts';

/** The rows of the Helpers tab at `now`; `background`: what the agent still waits for (the live activity's list). */
export function helpersOverview(session: Pick<SessionDetail, 'agents' | 'status' | 'task' | 'workflows'>, background: readonly Pick<BackgroundTask, 'kind' | 'toolUseId'>[] | null | undefined, now: number): OverviewFold {
  // A helper the agent still waits for reads as working, in its row too (not only for the fold).
  const agents = withPendingHelpers(session.agents, background);
  return foldOverview(overviewItems({ ...session, agents }, { everyHelper: true }), { agents, workflows: session.workflows }, now);
}

/** D180: the Helpers tab's red dot: a helper (not the main agent) failed (`status === 'fail'`). */
export function helperFailed(agents: readonly Pick<SessionDetail['agents'][number], 'kind' | 'status'>[]): boolean {
  return agents.some((agent) => agent.kind !== 'main' && agent.status === 'fail');
}

type AgentItem = Extract<OverviewItem, { kind: 'agent' }>;
type RunItem = Extract<OverviewItem, { kind: 'workflow' }>;

/** One entry of Working: a running Workflow run with its working helpers, or (`run` null) one working helper. */
export interface WorkingEntry {
  readonly run: RunItem | null;
  readonly helpers: readonly AgentItem[];
}

export interface HelperSections {
  /** Failed (`fail`) and waiting (`need`) helpers. */
  readonly needsYou: readonly AgentItem[];
  /** Stopped Workflow runs that can resume (Resume run): Needs you too. */
  readonly stoppedRuns: readonly RunItem[];
  /** Running runs first (with their working helpers), then working helpers on their own. */
  readonly working: readonly WorkingEntry[];
  /** Everything else, in the overview's order (a run with its helpers under it). */
  readonly finished: readonly OverviewItem[];
  /** How many helpers finished (the folded row's "N finished"; a run's own row is not counted, its helpers are). */
  readonly finishedCount: number;
}

function needsYou(item: AgentItem): boolean {
  return item.sessionStatus === 'fail' || item.sessionStatus === 'need';
}

/** The overview's rows (`items`: the fold's shown then earlier rows) in the Helpers tab's sections; the main agent is left out. */
export function helperSections(items: readonly OverviewItem[]): HelperSections {
  const units: Array<{ readonly run: RunItem | null; readonly agents: AgentItem[] }> = [];
  for (const item of items) {
    if (item.kind === 'workflow') units.push({ run: item, agents: [] });
    else if (item.main) continue;
    else if (item.depth === 1 && units.length > 0 && units[units.length - 1]?.run) (units[units.length - 1] as { agents: AgentItem[] }).agents.push(item);
    else units.push({ run: null, agents: [item] });
  }
  const needs: AgentItem[] = [];
  const stopped: RunItem[] = [];
  const runs: WorkingEntry[] = [];
  const alone: WorkingEntry[] = [];
  const finished: OverviewItem[] = [];
  let finishedCount = 0;
  for (const unit of units) {
    for (const agent of unit.agents) if (needsYou(agent)) needs.push(agent);
    if (unit.run) {
      if (unit.run.status === 'working') runs.push({ run: unit.run, helpers: unit.agents.filter((agent) => agent.sessionStatus === 'run') });
      else if (unit.run.resume !== null) stopped.push(unit.run);
      else {
        const done = unit.agents.filter((agent) => !needsYou(agent));
        finished.push(unit.run, ...done);
        finishedCount += done.length;
      }
      continue;
    }
    const agent = unit.agents[0] as AgentItem;
    if (needsYou(agent)) continue;
    if (agent.sessionStatus === 'run') alone.push({ run: null, helpers: [agent] });
    else {
      finished.push(agent);
      finishedCount += 1;
    }
  }
  return { needsYou: needs, stoppedRuns: stopped, working: [...runs, ...alone], finished, finishedCount };
}
