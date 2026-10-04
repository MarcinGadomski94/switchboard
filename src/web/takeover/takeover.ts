import type { Session } from '../../core/api.ts';
import { offlineReason } from '../../core/peers.ts';
import {
  type RepoResolution,
  type TakeoverPreview,
  type TakeoverRun,
  type TakeoverStepState,
  type TakeoverStepStatus,
} from '../../core/takeover.ts';

/**
 * D65 (`docs/peers.md` → *Taking a session over*): the take-over dialog's pure
 * parts: which sessions offer it, the labels, what each repo row says, whether
 * **Take over** may start, and how a run reads. No React, no network.
 */

/** Which way the dialog goes: a peer's session comes **here**, a session of this machine moves **to** a peer. */
export type TakeoverDirection = 'take-over' | 'move';

/** What the dialog is opened for. */
export interface TakeoverRequest {
  /** The session's id as this machine knows it (a remote id for a peer's session). */
  readonly sessionId: string;
  /** The paired machine a local session moves to; `null` for a peer's session (it comes here). */
  readonly targetMachine: string | null;
  /** The name of the other machine (for the title). */
  readonly machineName: string;
  readonly title: string;
}

/** The header's / the row menu's label for a peer's session. */
export const TAKE_OVER_LABEL = 'Take over to this machine';

/** The label of the move action for `machineName`. */
export function moveLabel(machineName: string): string {
  return `Move to ${machineName} ▸`;
}

/** The dialog's title. */
export function dialogTitle(direction: TakeoverDirection, machineName: string): string {
  return direction === 'take-over' ? `Take over from ${machineName}` : `Move to ${machineName}`;
}

/** The direction of a session: a peer's session is taken over here, a local one is moved. */
export function directionOf(session: Pick<Session, 'machine'>): TakeoverDirection {
  return session.machine ? 'take-over' : 'move';
}

/**
 * Whether a session offers a take-over: it is open, was not moved already, and
 * (a peer's session) its machine is reachable. A session Switchboard never ran
 * (the demo's) has no process to take over.
 */
export function offersTakeover(session: Pick<Session, 'machine' | 'closedAt' | 'movedTo' | 'remote' | 'hooked'>): boolean {
  if ((session.closedAt ?? null) !== null || session.movedTo) return false;
  if (session.machine && offlineReason(session.machine) !== null) return false;
  // A demo session has no `remote` state and is not a hooked one: nothing runs it.
  if (!session.machine && session.remote === null && session.hooked !== true) return false;
  return true;
}

/** A line about a repo's work: "3 uncommitted files · 2 unpushed commits". */
export function workLine(resolution: Pick<RepoResolution, 'uncommitted' | 'ahead'>): string {
  const parts = [`${resolution.uncommitted} uncommitted file${resolution.uncommitted === 1 ? '' : 's'}`];
  if (resolution.ahead !== null && resolution.ahead > 0) parts.push(`${resolution.ahead} unpushed commit${resolution.ahead === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** What the dialog says will happen to a repo, short. */
export function actionLabel(resolution: Pick<RepoResolution, 'action'>): string {
  return resolution.action === 'use' ? 'Use here' : resolution.action === 'clone' ? 'Clone first' : 'Blocked';
}

/** `true` while a clone path the developer typed would still be refused (empty). */
export function missingClonePath(preview: TakeoverPreview, paths: Readonly<Record<string, string>>): boolean {
  return preview.target.repos.some((repo) => repo.action === 'clone' && (paths[repo.key] ?? repo.cloneTo ?? '').trim() === '');
}

/** The clone paths the request carries: only what the developer typed that differs from the suggestion. */
export function clonePathsOf(preview: TakeoverPreview, typed: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const repo of preview.target.repos) {
    if (repo.action !== 'clone' && repo.action !== 'blocked') continue;
    const value = typed[repo.key]?.trim();
    if (value && value !== repo.cloneTo) out[repo.key] = value;
  }
  return out;
}

/** Whether **Take over** may start: nothing blocks it, the clone paths are set, a hooked terminal's stop is confirmed. */
export function canStart(preview: TakeoverPreview | null, confirmed: boolean, paths: Readonly<Record<string, string>>): boolean {
  if (!preview || !preview.ok) return false;
  if (preview.stopsTerminal && !confirmed) return false;
  return !missingClonePath(preview, paths);
}

/** The glyph of a step. */
export function stepMark(status: TakeoverStepStatus): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'running':
      return '●';
    case 'failed':
      return '✗';
    case 'skipped':
      return '–';
    default:
      return '○';
  }
}

/** The headline of a finished (or running) run. */
export function runHeadline(run: TakeoverRun, machineName: string): string {
  if (run.state === 'done') return run.leftovers.length > 0 || run.steps.some((step) => step.status === 'failed') ? 'Taken over — with something left to clean up' : 'Taken over';
  if (run.state === 'failed') {
    if (run.rolledBack === true) return 'The take-over failed — everything was undone';
    if (run.rolledBack === false) return 'The take-over failed and could not be fully undone';
    return 'The take-over did not start';
  }
  if (run.error) return 'Undoing the changes…';
  return `Taking over to ${machineName}…`;
}

/** The running step (the first that is running), for the aria-live line. */
export function runningStep(steps: readonly TakeoverStepState[]): TakeoverStepState | null {
  return steps.find((step) => step.status === 'running') ?? null;
}
