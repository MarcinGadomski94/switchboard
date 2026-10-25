import type { MachineState } from '../../../core/peers.ts';
import type { TakeoverPreview, TakeoverRun, TakeoverStepStatus } from '../../../core/takeover.ts';
import { canStart, missingClonePath } from '../../takeover/takeover.ts';
import type { Tone } from '../glossary.ts';

/**
 * D131 · lane X · the v2 **Move to computer** (D65 take-over / move, D110 target
 * folders) and **Continue in Switchboard** (D72) dialogs' pure parts: which
 * computers a local agent can move to, why the dialog's main button is disabled
 * (in words), and how a repo row, a step and a run read as icon + word + colour.
 * The API calls and their rules are the classic dialogs' (`src/web/takeover/`,
 * `src/web/hooked-continue/`). No React, no network.
 */

/** A paired computer in the dialog's "Move to" picker. */
export interface MoveTarget {
  readonly id: string;
  readonly name: string;
  readonly state: 'online' | 'reconnecting' | 'offline';
  /** Why it cannot be picked now (offline / reconnecting), `null` = it can. */
  readonly reason: string | null;
}

/** The paired computers as picker entries: the online ones first (in their order), then the others with why they cannot take it. */
export function moveTargets(machines: ReadonlyArray<{ readonly id: string; readonly name: string; readonly state: MachineState }>): MoveTarget[] {
  const view = machines.map((machine): MoveTarget => {
    const state = machine.state === 'online' ? 'online' : machine.state === 'reconnecting' ? 'reconnecting' : 'offline';
    const reason = state === 'online' ? null : state === 'reconnecting' ? `Reconnecting to ${machine.name}…` : `${machine.name} is offline`;
    return { id: machine.id, name: machine.name, state, reason };
  });
  return [...view.filter((m) => m.reason === null), ...view.filter((m) => m.reason !== null)];
}

/** The picker's label of a computer: its name, plus its state when it cannot be picked. */
export function targetLabel(target: MoveTarget): string {
  return target.state === 'online' ? target.name : `${target.name} (${target.state === 'reconnecting' ? 'reconnecting' : 'offline'})`;
}

/** What decides whether the dialog's Move / Take over button may run. */
export interface MoveGateInput {
  readonly preview: TakeoverPreview | null;
  readonly previewError: string | null;
  readonly confirmed: boolean;
  readonly clonePaths: Readonly<Record<string, string>>;
  /** The other computer (the target of a move, the source of a take-over), with its live state. */
  readonly other: { readonly name: string; readonly state: 'online' | 'reconnecting' | 'offline' } | null;
  readonly running: boolean;
}

/**
 * Why the main button is disabled, in words (`null` = it may start). The order is
 * what the developer can act on first: the other computer, the preview, the
 * blockers both sides found, a clone folder to fill in, the terminal's stop to
 * confirm. The classic `canStart` is the final say.
 */
export function moveBlockedReason(input: MoveGateInput): string | null {
  if (input.running) return 'It is moving now.';
  if (input.other && input.other.state === 'offline') return `${input.other.name} is offline: it can move once it reconnects.`;
  if (input.other && input.other.state === 'reconnecting') return `Reconnecting to ${input.other.name}…`;
  if (input.previewError) return input.previewError;
  const preview = input.preview;
  if (!preview) return 'Checking both computers…';
  if (preview.blockers.length > 0) return preview.blockers[0] ?? 'Something on one of the computers stops it.';
  if (!preview.ok) return 'Something on one of the computers stops it.';
  if (missingClonePath(preview, input.clonePaths)) return 'Fill in where to clone each missing code project.';
  if (preview.stopsTerminal && !input.confirmed) return 'Confirm that the terminal’s claude is stopped first.';
  return canStart(preview, input.confirmed, input.clonePaths) ? null : 'Something on one of the computers stops it.';
}

/** How something reads: icon + word + colour. */
export interface Look {
  readonly icon: string;
  readonly word: string;
  readonly tone: Tone;
}

/** A repo row's mark (✓ / ⚠ / ✖) in v2: Found, Needs a look, Blocked. */
export function repoLook(mark: '✓' | '⚠' | '✖'): Look {
  if (mark === '✓') return { icon: 'check-circle', word: 'Found', tone: 'green' };
  if (mark === '⚠') return { icon: 'alert', word: 'Needs a look', tone: 'amber' };
  return { icon: 'x', word: 'Blocked', tone: 'red' };
}

/** What happens to a repo on the target, in words. */
export function repoActionWord(action: 'use' | 'clone' | 'blocked'): string {
  return action === 'use' ? 'Used there' : action === 'clone' ? 'Cloned first' : 'Cannot move';
}

/** A step of a running move. */
export function stepLook(status: TakeoverStepStatus): Look {
  switch (status) {
    case 'done':
      return { icon: 'check-circle', word: 'Done', tone: 'green' };
    case 'running':
      return { icon: 'dot', word: 'Running', tone: 'blue' };
    case 'failed':
      return { icon: 'x', word: 'Failed', tone: 'red' };
    case 'skipped':
      return { icon: 'circle', word: 'Skipped', tone: 'grey' };
    default:
      return { icon: 'circle', word: 'Waiting', tone: 'grey' };
  }
}

/** A run's headline as icon + word + colour (the words are the classic `runHeadline`'s). */
export function runTone(run: Pick<TakeoverRun, 'state' | 'leftovers' | 'steps' | 'error'>): Tone {
  if (run.state === 'done') return run.leftovers.length > 0 || run.steps.some((step) => step.status === 'failed') ? 'amber' : 'green';
  if (run.state === 'failed') return 'red';
  return run.error ? 'amber' : 'blue';
}

/** The v2 dialog's title: "Move to <computer>" (a move of this computer's agent), "Move here from <computer>" (a paired computer's agent). */
export function moveTitle(direction: 'take-over' | 'move', machineName: string | null): string {
  if (direction === 'take-over') return `Move here from ${machineName ?? 'the other computer'}`;
  return machineName ? `Move to ${machineName}` : 'Move to another computer';
}

/** A run's headline (the classic `runHeadline`'s cases, in the v2 dialog's words). */
export function moveHeadline(run: Pick<TakeoverRun, 'state' | 'leftovers' | 'steps' | 'error' | 'rolledBack'>, machineName: string): string {
  if (run.state === 'done') return run.leftovers.length > 0 || run.steps.some((step) => step.status === 'failed') ? 'Moved, with something left to clean up' : 'Moved';
  if (run.state === 'failed') {
    if (run.rolledBack === true) return 'The move failed. Everything was undone.';
    if (run.rolledBack === false) return 'The move failed and could not be fully undone.';
    return 'The move did not start.';
  }
  if (run.error) return 'Undoing the changes…';
  return `Moving to ${machineName}…`;
}
