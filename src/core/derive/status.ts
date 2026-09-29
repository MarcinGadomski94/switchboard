/**
 * Session status (`need | run | done | fail | idle | paused`; `docs/derivations.md`
 * → *Session status*), derived from what the supervisor knows about the session's
 * process. Pure: the supervisor keeps the inputs, this decides.
 */
import type { SessionStatus } from '../model.ts';

/**
 * Outcome of the last turn the process finished (turns Switchboard interrupted to
 * stop the process do not count). D50: `stopped` = the developer stopped the turn
 * (Stop / Esc); the process lives on, ready for the next message.
 */
export type TurnOutcome = 'success' | 'error' | 'stopped';

/** A Switchboard-initiated stop (D7): `pause`, `detach` or the service shutting down. */
export type StopReason = 'pause' | 'detach' | 'shutdown';

/** State of a live process. */
export interface LiveStatusInput {
  readonly live: true;
  /** `can_use_tool` requests waiting for a reply (questions, permissions). */
  readonly openRequests: number;
  /** A user message is waiting for its `result`, or the CLI runs a turn of its own. */
  readonly turnRunning: boolean;
  /** Subagents (`local_agent` tasks) started and not finished. */
  readonly runningAgents: number;
  readonly lastOutcome: TurnOutcome | null;
}

/** State after the process ended (or failed to start). */
export interface EndedStatusInput {
  readonly live: false;
  /** Set when Switchboard stopped it. */
  readonly stopReason: StopReason | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** The process could not be started at all (e.g. the CLI binary is missing). */
  readonly spawnFailed: boolean;
  readonly lastOutcome: TurnOutcome | null;
}

/** Input of {@link deriveSessionStatus}. */
export type StatusInput = LiveStatusInput | EndedStatusInput;

/**
 * - Live: an open request → `need`; a running turn or subagent → `run`; else the
 *   last turn's outcome (`done` / `fail`); nothing ran yet, or D50 the developer
 *   stopped the last turn → `idle`.
 * - Ended: a stop Switchboard started (`pause` / `detach`) → `paused`, whatever the
 *   exit code (D7: exit 0 idle, exit 1 mid-turn or with a question open); a failed
 *   start, a non-zero exit or a signal it did not send → `fail`; a clean exit it did
 *   not ask for → `done` (or `fail` when the last turn failed).
 *
 * `shutdown` is not decided here: the supervisor keeps the stored status then, so a
 * restart can resume `run` / `need` sessions (D7, M2.4).
 */
export function deriveSessionStatus(input: StatusInput): SessionStatus {
  if (input.live) {
    if (input.openRequests > 0) return 'need';
    if (input.turnRunning || input.runningAgents > 0) return 'run';
    if (input.lastOutcome === 'error') return 'fail';
    if (input.lastOutcome === 'success') return 'done';
    return 'idle';
  }
  if (input.stopReason === 'pause' || input.stopReason === 'detach') return 'paused';
  if (input.spawnFailed) return 'fail';
  if (input.exitCode === 0 && input.signal === null) return input.lastOutcome === 'error' ? 'fail' : 'done';
  return 'fail';
}
