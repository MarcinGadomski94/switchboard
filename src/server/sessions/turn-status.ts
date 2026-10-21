import { TURN_ASK_MAX, type TurnStatus, type TurnWait, isTurnStatus, turnEndWait, turnWaits } from '../../core/derive/turn-status.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';

/** A refusal of {@link TurnStatusService}, sent as `{ error, message }`. */
export class TurnStatusError extends Error {
  override name = 'TurnStatusError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Options of {@link TurnStatusService}. */
export interface TurnStatusOptions {
  readonly store: Store;
  /** Publishes the session (`sessionUpdated`) after its turn wait changed. */
  readonly publish: (sessionId: string) => Promise<void>;
  /** Now (tests pass a fake clock). */
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

/** How a turn ended, as the stream (or a hooked session's Stop) says it. */
export interface TurnEnd {
  readonly outcome: 'success' | 'error' | 'stopped';
  /** The turn's last assistant text (`null` when none is known). */
  readonly text: string | null;
}

function sameWait(a: TurnWait | null, b: TurnWait | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * D124 (`docs/derivations.md` → *Session status* → *Waiting for you at a turn's end*): the
 * sessions' turn waits, stored on the session (`sessions.turn_wait`, migration 0047, so a restart
 * keeps "needs you"):
 *
 * - {@link declare}: the agent's `turn_status` (`POST /agent/v1/turn-status`), stored at once for
 *   the turn it is made in (the session still reads `run` until the turn is over);
 * - {@link turnStarted}: a new turn (the developer's message, any turn the CLI starts) clears it;
 * - {@link turnEnded}: the turn's end keeps the declaration, else runs the text check on the
 *   turn's last text (`detected`);
 * - {@link notWaiting}: the session's **Not waiting** and a Dismiss of its Inbox item clear a
 *   (false) wait for that turn.
 *
 * The status a session reads follows from it (`effectiveSessionStatus`, in `toSession`).
 */
export class TurnStatusService {
  readonly #store: Store;
  readonly #publish: (sessionId: string) => Promise<void>;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;

  constructor(options: TurnStatusOptions) {
    this.#store = options.store;
    this.#publish = options.publish;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? ((error) => console.error('switchboard turn status:', error));
  }

  /**
   * `turn_status` (`POST /agent/v1/turn-status`, the session the agent token belongs to): `status`
   * one of `done` / `waiting_for_you` / `blocked`; `ask` (≤ {@link TURN_ASK_MAX} characters, one line)
   * required for the last two.
   * @throws {TurnStatusError} 404 `not-found`, 409 `closed`, 422 `invalid`.
   */
  async declare(sessionId: string, body: unknown): Promise<TurnWait> {
    const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const status = input['status'];
    if (!isTurnStatus(status)) throw new TurnStatusError(422, 'invalid', 'status must be one of done, waiting_for_you, blocked');
    const rawAsk = typeof input['ask'] === 'string' ? input['ask'].replace(/\s+/g, ' ').trim() : '';
    if (input['ask'] !== undefined && input['ask'] !== null && typeof input['ask'] !== 'string') throw new TurnStatusError(422, 'invalid', 'ask must be a string');
    if (rawAsk.length > TURN_ASK_MAX) throw new TurnStatusError(422, 'invalid', `ask is at most ${TURN_ASK_MAX} characters`);
    if (status !== 'done' && rawAsk === '') throw new TurnStatusError(422, 'invalid', `give an ask with ${status}: one line saying what the developer must do or answer`);
    const record = await this.#store.sessions.get(sessionId);
    if (!record) throw new TurnStatusError(404, 'not-found', `no session ${sessionId}`);
    if (record.closedAt !== null) throw new TurnStatusError(409, 'closed', 'the session is closed');
    const wait: TurnWait = { status: status as TurnStatus, ask: status === 'done' ? null : rawAsk, source: 'declared', at: this.#now().toISOString() };
    await this.#set(record, wait);
    return wait;
  }

  /**
   * A new turn starts (at `startedAt`, default now): the last turn's wait (declared or detected) is
   * cleared. A declaration made after `startedAt` is the new turn's own and stays (it reached
   * Switchboard before the turn's start was handled). Answers whether one was cleared.
   */
  async turnStarted(sessionId: string, startedAt?: Date): Promise<boolean> {
    const record = await this.#store.sessions.get(sessionId);
    if (!record || record.turnWait === null) return false;
    const since = (startedAt ?? this.#now()).getTime();
    if (record.turnWait.source === 'declared' && Date.parse(record.turnWait.at) > since) return false;
    await this.#set(record, null);
    return true;
  }

  /**
   * The turn is over: a declaration made during it stays (it wins both ways); without one the text
   * check reads the turn's last text (only a successful turn's; never a chat's, D106).
   */
  async turnEnded(sessionId: string, end: TurnEnd): Promise<void> {
    const record = await this.#store.sessions.get(sessionId);
    if (!record || record.closedAt !== null) return;
    const declared = record.turnWait?.source === 'declared' ? record.turnWait : null;
    // A chat (D106) is a conversation: every reply waits for the developer by nature, so only its agent's own declaration counts.
    const text = record.kind === 'chat' ? null : end.text;
    await this.#set(record, turnEndWait({ declared, text, outcome: end.outcome, at: this.#now().toISOString() }));
  }

  /**
   * **Not waiting** (the session's needs-you line; `POST /api/sessions/{id}/not-waiting`) and a Dismiss
   * of its Inbox item: the wait of that turn is cleared (`at` given: only that episode's).
   * @throws {TurnStatusError} 404 `not-found`.
   */
  async notWaiting(sessionId: string, at: string | null = null): Promise<SessionRecord> {
    const record = await this.#store.sessions.get(sessionId);
    if (!record) throw new TurnStatusError(404, 'not-found', `no session ${sessionId}`);
    if (!turnWaits(record.turnWait) || (at !== null && record.turnWait.at !== at)) return record;
    return (await this.#set(record, null)) ?? record;
  }

  async #set(record: SessionRecord, wait: TurnWait | null): Promise<SessionRecord | null> {
    if (sameWait(record.turnWait, wait)) return record;
    const updated = await this.#store.sessions.update(record.id, { turnWait: wait });
    await this.#publish(record.id).catch((error: unknown) => this.#onError(error));
    return updated;
  }
}
