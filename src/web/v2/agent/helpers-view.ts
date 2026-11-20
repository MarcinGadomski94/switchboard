/**
 * SPIKE · what the side panel's Helpers tab lists: the agents overview (`side-model.ts`)
 * with a row for every helper. Details' overview drops a helper the moment it is done
 * (D37) and never shows one launched in the background (its own row ends at once); here
 * both keep their row, so a helper's chat stays one click away while it works and after
 * it finished. The fold is the overview's: the working ones, those that ended in the
 * last 10 minutes, the older ones under "Show N finished earlier". Pure.
 */
import type { BackgroundTask, SessionDetail } from '../../../core/api.ts';
import { withPendingHelpers } from './helpers-model.ts';
import { type OverviewFold, foldOverview, overviewItems } from './side-model.ts';

/** The rows of the Helpers tab at `now`; `background`: what the agent still waits for (the live activity's list). */
export function helpersOverview(session: Pick<SessionDetail, 'agents' | 'status' | 'task' | 'workflows'>, background: readonly Pick<BackgroundTask, 'kind' | 'toolUseId'>[] | null | undefined, now: number): OverviewFold {
  // A helper the agent still waits for reads as working, in its row too (not only for the fold).
  const agents = withPendingHelpers(session.agents, background);
  return foldOverview(overviewItems({ ...session, agents }, { everyHelper: true }), { agents, workflows: session.workflows }, now);
}
