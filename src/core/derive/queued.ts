/**
 * Queued messages (D44; `docs/derivations.md` → *Queued messages*): which of the
 * user messages Switchboard wrote to a process's stdin the agent has not taken up
 * yet, derived in memory from the process's stream-json and never guessed. Pure:
 * the recorder feeds a {@link QueueTracker} and stores what it says on the
 * messages' events (`UserPayload.queued`).
 *
 * What the CLI does (read in the 2.1.284 binary, matching the M0 recordings; the
 * details are in `docs/derivations.md`): a stdin message goes into the CLI's
 * command queue. It is taken up when a turn starts on it (`system/init` opens that
 * turn) or when a running turn absorbs it at a tool boundary; with
 * `--replay-user-messages` its `isReplay` echo is written at that pickup (for the
 * message that starts a turn, only just before the turn's first assistant line).
 * So a message written while a turn runs waits until that turn's `result` (or the
 * turn's next tool boundary), and the first of the next turn's `init` or its own
 * replay marks the pickup. A message echoed before any turn started on it was
 * absorbed by a running turn (or merged into one with the message ahead of it):
 * it gets no `result` of its own ({@link TakenUp.absorbed}).
 */
import type { QueuedReason, UserPayload } from '../event-payload.ts';

/** What was going on when a message was written ({@link queuedReason}). */
export interface SendContext {
  /** A turn runs, or other messages written earlier still wait for their turn. */
  readonly turnRunning: boolean;
  /** Switchboard started the process for this message: the session had none (a paused or stopped session). */
  readonly resuming: boolean;
}

/**
 * Why a message written now waits, or `null` when the agent takes it up at once
 * (a live process with nothing running: "sent idle → never queued").
 */
export function queuedReason(context: SendContext): QueuedReason | null {
  if (context.turnRunning) return 'turn';
  if (context.resuming) return 'resume';
  return null;
}

/** The payload without `queued` (D44: the message no longer waits); the other fields unchanged. */
export function withoutQueued(payload: UserPayload): UserPayload {
  if (payload.queued === undefined) return payload;
  const { queued: _queued, ...rest } = payload;
  return rest;
}

interface Pending {
  readonly eventId: number;
  readonly text: string;
  /** The reason while it waits, `null` once taken up (or when it never waited). */
  queued: QueuedReason | null;
  /** A turn started on it (it still waits for its replay, the delivery ack). */
  takenUp: boolean;
}

/** A message the CLI took up ({@link QueueTracker.replayed}). */
export interface TakenUp {
  readonly eventId: number;
  /** It was still queued: its event loses `queued`. */
  readonly wasQueued: boolean;
  /**
   * No turn had started on it: a running turn absorbed it (a tool boundary) or a
   * turn took it with the message ahead of it, so no `result` of its own follows.
   */
  readonly absorbed: boolean;
}

/**
 * The messages one process was sent that the CLI has not echoed yet, oldest first.
 * One instance per process (the recorder's); calls must be serialized.
 */
export class QueueTracker {
  readonly #pending: Pending[] = [];

  /** Records a message written to stdin (its event id and text) with the reason it waits, if any. */
  sent(eventId: number, text: string, queued: QueuedReason | null): void {
    this.#pending.push({ eventId, text, queued, takenUp: false });
  }

  /**
   * A turn started on a stdin message (`system/init` while messages are pending):
   * the oldest message no turn has started on yet is taken up. Returns its event id
   * when it was queued (its clock goes), else `null`.
   */
  turnStarted(): number | null {
    const next = this.#pending.find((pending) => !pending.takenUp);
    if (!next) return null;
    next.takenUp = true;
    if (next.queued === null) return null;
    next.queued = null;
    return next.eventId;
  }

  /**
   * The CLI's replay of a stdin message (`isReplay`): the pending message with that
   * text, else the oldest one (the text may differ in whitespace). It is delivered
   * and leaves the list. `null` when nothing is pending.
   */
  replayed(text: string): TakenUp | null {
    const at = this.#pending.findIndex((pending) => pending.text === text);
    const [hit] = this.#pending.splice(at >= 0 ? at : 0, 1);
    if (!hit) return null;
    return { eventId: hit.eventId, wasQueued: hit.queued !== null, absorbed: !hit.takenUp };
  }

  /**
   * The process ended: nothing is taken up any more. Returns the event ids of the
   * messages still queued (they lose the clock: the CLI never read them and
   * nothing sends them again) and forgets every pending message.
   */
  ended(): number[] {
    const ids = this.#pending.filter((pending) => pending.queued !== null).map((pending) => pending.eventId);
    this.#pending.length = 0;
    return ids;
  }

  /** The event ids of the messages that wait now, with their reasons, oldest first. */
  queued(): Array<{ readonly eventId: number; readonly reason: QueuedReason }> {
    const out: Array<{ readonly eventId: number; readonly reason: QueuedReason }> = [];
    for (const pending of this.#pending) if (pending.queued !== null) out.push({ eventId: pending.eventId, reason: pending.queued });
    return out;
  }
}
