import type { Agent, BackgroundTask, WorkflowRun } from '../../../core/api.ts';
import type { SessionStatus } from '../../../core/model.ts';

/**
 * 2026-10-27 · the helpers fold (`docs/v2.md` → *Helpers fold*), pure: a long
 * session's helper lists (the side panel's Helpers, the Helpers tab, the peek's,
 * the Timeline's lanes, the agents overview) show the helpers that are **active**
 * plus those that **ended within {@link RECENT_HELPER_MS}**; older ones fold under
 * one "Show N … finished earlier" row. A Workflow's agents follow their run: while
 * the run is active each by its own state, once it ended by the run's end. No React.
 */

/** How long a helper that ended stays in the lists before it folds (10 minutes). */
export const RECENT_HELPER_MS = 10 * 60_000;

/** How many folded helpers an expanded list renders at a time ("Show more" adds as many again). */
export const HELPERS_PAGE = 50;

/** The live clock's tick while a recent helper can still fold (at most once a minute). */
export const HELPERS_TICK_MS = 60_000;

/** Where a helper sits: active, ended within {@link RECENT_HELPER_MS}, or folded. */
export type HelperBucket = 'active' | 'recent' | 'earlier';

/** The statuses that mean a helper ended: done, failed or stopped. */
const ENDED: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['done', 'fail', 'idle']);

/** Whether a status means it ended (done, failed, stopped); everything else (working, waiting, starting, paused) is active. */
export function hasEnded(status: SessionStatus): boolean {
  return ENDED.has(status);
}

/** The fields the fold reads of an agent. */
export type FoldAgent = Pick<Agent, 'id' | 'kind' | 'status'> & Partial<Pick<Agent, 'startedAt' | 'updatedAt' | 'endedAt' | 'workflow'>>;

/** The fields the fold reads of a Workflow run. */
export type FoldRun = Pick<WorkflowRun, 'runId' | 'status' | 'startedAt' | 'endedAt'>;

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

function latest(...values: Array<number | null>): number | null {
  let out: number | null = null;
  for (const value of values) if (value !== null && (out === null || value > out)) out = value;
  return out;
}

/** The run a Workflow agent belongs to, when the session lists it. */
function runOf(agent: FoldAgent, runs: ReadonlyMap<string, FoldRun>): FoldRun | null {
  const runId = agent.kind === 'workflow' ? agent.workflow?.runId : undefined;
  return runId ? (runs.get(runId) ?? null) : null;
}

function runMap(runs: readonly FoldRun[]): ReadonlyMap<string, FoldRun> {
  return new Map(runs.map((run) => [run.runId, run]));
}

/** The newest time the helper was seen at (its last change, its current action, its start), `null` when none is known. */
function lastSeen(agent: FoldAgent): number | null {
  return latest(ms(agent.updatedAt), ms(agent.workflow?.action?.since), ms(agent.startedAt), ms(agent.workflow?.startedAt));
}

/**
 * When an ended run ended (ms): its end, else its agents' newest end; a run that
 * was cut off (stopped, its process ended) may have neither: then the newest time
 * it was seen at (its start, its agents' last actions). `null` when nothing says.
 */
function runEndedAt(run: FoldRun, own: readonly FoldAgent[]): number | null {
  return latest(ms(run.endedAt), ...own.map((agent) => ms(agent.workflow?.endedAt ?? agent.endedAt))) ?? latest(ms(run.startedAt), ...own.map(lastSeen));
}

/**
 * When the helper ended (ms), `null` while it is active or when nothing says
 * (then it counts as ended long ago: an older payload without times). Without an
 * end time, the newest time it was seen at (a helper cut off by a stop). A
 * Workflow agent of an ended run ends with its run.
 */
export function helperEndedAt(agent: FoldAgent, runs: ReadonlyMap<string, FoldRun> = new Map()): number | null {
  const run = runOf(agent, runs);
  if (run && hasEnded(run.status)) return latest(ms(run.endedAt), ms(agent.workflow?.endedAt), ms(agent.endedAt)) ?? latest(ms(run.startedAt), lastSeen(agent));
  if (!hasEnded(agent.status)) return null;
  return ms(agent.endedAt) ?? ms(agent.workflow?.endedAt) ?? lastSeen(agent);
}

/** Whether the helper counts as active (its run's state rules a Workflow agent once the run ended). */
export function isActiveHelper(agent: FoldAgent, runs: ReadonlyMap<string, FoldRun> = new Map()): boolean {
  const run = runOf(agent, runs);
  if (run && hasEnded(run.status)) return false;
  return !hasEnded(agent.status);
}

/** The helper's newest sign of activity (ms): its end once ended, else its last change, its current action or its start; 0 when unknown. */
export function helperActivityAt(agent: FoldAgent, runs: ReadonlyMap<string, FoldRun> = new Map()): number {
  if (!isActiveHelper(agent, runs)) return helperEndedAt(agent, runs) ?? 0;
  return lastSeen(agent) ?? 0;
}

/** The helper's bucket at `now`: active, ended within {@link RECENT_HELPER_MS} (the boundary itself is still recent), else earlier. */
export function helperBucket(agent: FoldAgent, now: number, runs: ReadonlyMap<string, FoldRun> = new Map()): HelperBucket {
  if (isActiveHelper(agent, runs)) return 'active';
  const ended = helperEndedAt(agent, runs);
  return ended !== null && now - ended <= RECENT_HELPER_MS ? 'recent' : 'earlier';
}

/** A session's helpers split for the lists, each part newest activity first. */
export interface HelperFold<A> {
  readonly active: readonly A[];
  readonly recent: readonly A[];
  readonly earlier: readonly A[];
}

/** The helpers (every agent but the main one) of a session, folded at `now`; `runs` = the session's Workflow runs. */
export function foldHelpers<A extends FoldAgent>(agents: readonly A[], now: number, runs: readonly FoldRun[] = []): HelperFold<A> {
  const byRun = runMap(runs);
  const rows = agents.filter((agent) => agent.kind !== 'main').map((agent, index) => ({ agent, index, at: helperActivityAt(agent, byRun), bucket: helperBucket(agent, now, byRun) }));
  // Newest first; the later-created one first on a tie (stable for equal times).
  const sorted = rows.sort((a, b) => b.at - a.at || b.index - a.index);
  const pick = (bucket: HelperBucket): A[] => sorted.filter((row) => row.bucket === bucket).map((row) => row.agent);
  return { active: pick('active'), recent: pick('recent'), earlier: pick('earlier') };
}

/** How many helpers are active (the counts and badges outside the lists). */
export function activeHelperCount(agents: readonly FoldAgent[], runs: readonly FoldRun[] = []): number {
  const byRun = runMap(runs);
  return agents.filter((agent) => agent.kind !== 'main' && isActiveHelper(agent, byRun)).length;
}

/** What a list renders: the shown helpers, the fold row's count, how many expanded ones wait behind "Show more". */
export interface HelperRows<A> {
  /** Active, then recent, then (expanded) the first `limit` folded ones. */
  readonly shown: readonly A[];
  /** How many are folded (the "Show N … finished earlier" row; no row at 0). */
  readonly earlier: number;
  /** Expanded: how many folded ones are not rendered yet ("Show more"); 0 otherwise. */
  readonly more: number;
}

/** The rows of a list: folded ones only while `expanded`, at most `limit` of them ({@link HELPERS_PAGE} steps). */
export function helperRows<A>(fold: HelperFold<A>, expanded: boolean, limit: number = HELPERS_PAGE): HelperRows<A> {
  const earlier = fold.earlier.length;
  if (!expanded) return { shown: [...fold.active, ...fold.recent], earlier, more: 0 };
  const cut = Math.max(0, limit);
  return { shown: [...fold.active, ...fold.recent, ...fold.earlier.slice(0, cut)], earlier, more: Math.max(0, earlier - cut) };
}

/**
 * When the next recent helper folds (ms), `null` when none can: the live clock
 * only ticks while this is not `null` (at most once a minute, {@link HELPERS_TICK_MS}).
 */
export function nextFoldAt(agents: readonly FoldAgent[], now: number, runs: readonly FoldRun[] = []): number | null {
  const byRun = runMap(runs);
  let next: number | null = null;
  for (const agent of agents) {
    if (agent.kind === 'main' || helperBucket(agent, now, byRun) !== 'recent') continue;
    const at = (helperEndedAt(agent, byRun) ?? now) + RECENT_HELPER_MS;
    if (next === null || at < next) next = at;
  }
  return next;
}

/** A Workflow run's bucket at `now`: active while it runs, recent within {@link RECENT_HELPER_MS} of its end, else earlier (it folds as one row). */
export function runBucket(run: FoldRun, agents: readonly FoldAgent[], now: number): HelperBucket {
  if (!hasEnded(run.status)) return 'active';
  const own = agents.filter((agent) => agent.kind === 'workflow' && agent.workflow?.runId === run.runId);
  const ended = runEndedAt(run, own);
  return ended !== null && now - ended <= RECENT_HELPER_MS ? 'recent' : 'earlier';
}

/** A run's newest activity (ms): its end once ended, else the newest of its agents' and its start. */
export function runActivityAt(run: FoldRun, agents: readonly FoldAgent[]): number {
  const own = agents.filter((agent) => agent.kind === 'workflow' && agent.workflow?.runId === run.runId);
  const byRun = runMap([run]);
  if (hasEnded(run.status)) return runEndedAt(run, own) ?? 0;
  return latest(ms(run.startedAt), ...own.map((agent) => helperActivityAt(agent, byRun))) ?? 0;
}

/** The fold of the Timeline's lanes: the shown lanes and the folded lanes (one summary lane, expandable). */
export interface LaneFold<L> {
  readonly shown: readonly L[];
  readonly earlier: readonly L[];
}

/**
 * The Timeline's lanes folded: a lane of a folded helper goes to `earlier` (the
 * summary lane "N earlier helpers"); the main agent's lane and lanes of agents the
 * session does not list stay. The lanes keep the timeline's own order.
 */
export function foldLanes<L extends { readonly id: string | null }>(lanes: readonly L[], agents: readonly FoldAgent[], now: number, runs: readonly FoldRun[] = []): LaneFold<L> {
  const byRun = runMap(runs);
  const folded = new Set(agents.filter((agent) => agent.kind !== 'main' && helperBucket(agent, now, byRun) === 'earlier').map((agent) => agent.id));
  return { shown: lanes.filter((lane) => lane.id === null || !folded.has(lane.id)), earlier: lanes.filter((lane) => lane.id !== null && folded.has(lane.id)) };
}

/**
 * The agents with an async helper the main agent still waits on counted as
 * working: an async `Agent` call's row ends at its launch (the CLI streams no task
 * events for it, `docs/derivations.md` → *Background work*), while the live
 * activity lists it as a pending background task by the call's id. For the fold
 * only (the lists show the row's own status). The same array when nothing changes.
 */
export function withPendingHelpers<A extends Pick<Agent, 'kind' | 'status'> & { readonly toolUseId?: string | null }>(agents: readonly A[], background: readonly Pick<BackgroundTask, 'kind' | 'toolUseId'>[] | null | undefined): readonly A[] {
  const pending = new Set((background ?? []).filter((task) => task.kind === 'agent').map((task) => task.toolUseId));
  if (pending.size === 0) return agents;
  let changed = false;
  const out = agents.map((agent) => {
    if (agent.kind === 'main' || !agent.toolUseId || !pending.has(agent.toolUseId) || !hasEnded(agent.status)) return agent;
    changed = true;
    return { ...agent, status: 'run' as const };
  });
  return changed ? out : agents;
}
