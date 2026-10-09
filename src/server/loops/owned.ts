import { randomBytes } from 'node:crypto';
import type { OwnedLoop, OwnedLoopAuthor, OwnedLoopSchedule } from '../../core/api.ts';
import type { UserLoopMark, UserPayload } from '../../core/event-payload.ts';
import { LOOP_ENDED_KEEP_MS, LOOPS_PER_SESSION_MAX, type LoopFieldError, checkLoopInput, followingDue, loopTitle, nextDue } from '../../core/owned-loops.ts';
import type { SessionLoopPatch, SessionLoopRecord } from '../db/repos/session-loops.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { MAX_TIMER_MS, SYSTEM_CLOCK, type SchedulerClock } from '../schedules/scheduler.ts';
import { toOwnedLoop } from './owned-wire.ts';

/** A loop id as {@link LoopService} makes them (10 hex characters); anything else names no loop. */
const LOOP_ID = /^[a-f0-9]{10}$/;

/** Why a due time was skipped because the previous firing still waits. */
export const PENDING_SKIP = 'the previous firing has not been taken up yet';

/** Why missed due times were skipped (Switchboard was not running, or the machine slept). */
export const DOWN_SKIP = 'Switchboard was not running at its time';

/** A refusal, sent as `{ error, message[, errors] }` with `status`. */
export class LoopError extends Error {
  override name = 'LoopError';
  readonly status: number;
  readonly code: string;
  readonly errors: readonly LoopFieldError[];
  constructor(status: number, code: string, message: string, errors: readonly LoopFieldError[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.errors = errors;
  }

  body(): { readonly error: string; readonly message: string; readonly errors?: readonly LoopFieldError[] } {
    return this.errors.length > 0 ? { error: this.code, message: this.message, errors: this.errors } : { error: this.code, message: this.message };
  }
}

/** How a firing reaches the session: the supervisor's message path, or a hooked session's mailbox (app.ts). */
export type LoopDeliver = (session: SessionRecord, text: string, mark: UserLoopMark) => Promise<void>;

/** A loop as the take-over carries it to the target machine (D65). */
export interface PortableLoop {
  readonly label: string | null;
  readonly prompt: string;
  readonly schedule: OwnedLoopSchedule;
  readonly expiresAt: string | null;
  readonly maxRuns: number | null;
  readonly state: 'active' | 'paused';
  readonly runs: number;
  readonly skipped: number;
  readonly lastFiredAt: string | null;
  readonly createdBy: OwnedLoopAuthor;
  readonly createdAt: string;
}

/** Options of {@link LoopService}. */
export interface LoopServiceOptions {
  readonly store: Store;
  readonly deliver: LoopDeliver;
  /** Publishes the session's `sessionUpdated` (its `ownedLoops`). */
  readonly announce?: (sessionId: string) => Promise<void>;
  readonly clock?: SchedulerClock;
  readonly maxTimerMs?: number;
  /** A new loop id (tests pin it). */
  readonly newId?: () => string;
  readonly onError?: (error: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * D94 · Switchboard-owned loops (`docs/loops.md`): a session's agent creates them
 * through `/agent/v1/loops` (the `loop_*` MCP tools), the developer through
 * `/api/sessions/{id}/loops`, and this service fires them: at each due time the
 * prompt goes into the session as a message (origin `service`, marked with the
 * loop), through the same path as any message (idle → now; busy → queued; paused →
 * resumed; hooked → the hook mailbox). At most one firing waits: while the
 * previous one has not been taken up, a due time is skipped. No catch-up after
 * downtime: the missed due times are counted as skipped and the next one fires.
 * A closed session ends its loops. One timer (the scheduler's clock and bound),
 * one queue: firings and commands never interleave.
 */
export class LoopService {
  readonly #store: Store;
  readonly #deliver: LoopDeliver;
  readonly #announce: ((sessionId: string) => Promise<void>) | null;
  readonly #clock: SchedulerClock;
  readonly #maxTimerMs: number;
  readonly #newId: () => string;
  readonly #onError: (error: unknown) => void;
  readonly #pending = new Set<Promise<unknown>>();
  #takingOver: (sessionId: string) => boolean = () => false;
  #queue: Promise<void> = Promise.resolve();
  #timer: unknown = null;
  #started = false;
  #closed = false;

  constructor(options: LoopServiceOptions) {
    this.#store = options.store;
    this.#deliver = options.deliver;
    this.#announce = options.announce ?? null;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#maxTimerMs = options.maxTimerMs ?? MAX_TIMER_MS;
    this.#newId = options.newId ?? (() => randomBytes(5).toString('hex'));
    this.#onError = options.onError ?? ((error) => console.error('switchboard loops:', error));
  }

  /** D65: while a session is being taken over its due times are skipped (the take-over moves its loops). */
  useTakeover(isActive: (sessionId: string) => boolean): void {
    this.#takingOver = isActive;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  /**
   * Starts the timer (main.ts / app.ts once the app is ready). Due times missed
   * while Switchboard was not running are not caught up: each loop counts them as
   * skipped and waits for its next due time (a one-shot whose time passed ends).
   * Ended loops older than {@link LOOP_ENDED_KEEP_MS} are removed.
   */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#track(
      this.#serial(async () => {
        const now = this.#clock.now();
        await this.#store.sessionLoops.pruneEnded(new Date(now.getTime() - LOOP_ENDED_KEEP_MS).toISOString());
        for (const loop of await this.#store.sessionLoops.listActive()) {
          if (loop.expiresAt !== null && Date.parse(loop.expiresAt) <= now.getTime()) {
            await this.#end(loop, 'expired');
            continue;
          }
          const due = loop.nextFireAt === null ? null : new Date(loop.nextFireAt);
          if (due === null) {
            await this.#reschedule(loop, nextDue(loop.schedule, now), 0, null);
            continue;
          }
          if (due.getTime() > now.getTime()) continue;
          if (loop.schedule.kind === 'at') {
            await this.#end(loop, `missed: ${DOWN_SKIP}`, { skipped: loop.skipped + 1, lastError: DOWN_SKIP });
            continue;
          }
          const { next, missed } = followingDue(loop.schedule, due, now);
          await this.#reschedule(loop, next, missed + 1, DOWN_SKIP);
        }
        await this.#arm();
      }),
    );
  }

  /** Stops the timer and waits for work in progress. */
  async stop(): Promise<void> {
    this.#started = false;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    await this.settled();
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.stop();
  }

  /** Resolves once the background work started so far has finished. */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
    await this.#queue;
  }

  // ── queries ───────────────────────────────────────────────────────────

  /** The session's loops, oldest first (ended ones included). @throws {LoopError} 404 for an unknown session. */
  async list(sessionId: string): Promise<OwnedLoop[]> {
    await this.#session(sessionId);
    return (await this.#store.sessionLoops.list(sessionId)).map(toOwnedLoop);
  }

  /** One loop of the session. @throws {LoopError} 404. */
  async get(sessionId: string, loopId: string): Promise<OwnedLoop> {
    return toOwnedLoop(await this.#loop(sessionId, loopId));
  }

  // ── commands ──────────────────────────────────────────────────────────

  /**
   * Creates a loop in the session (`loop_create`, or the developer's New loop…).
   * @throws {LoopError} 404 no session, 409 `closed` / `too-many`, 422 `invalid`.
   */
  async create(sessionId: string, body: unknown, author: OwnedLoopAuthor): Promise<OwnedLoop> {
    this.#assertOpen();
    const session = await this.#session(sessionId);
    if (session.closedAt !== null) throw new LoopError(409, 'closed', 'the session is closed: a loop could not fire in it');
    const now = this.#clock.now();
    const checked = checkLoopInput(body, now);
    if (!checked.ok) throw new LoopError(422, 'invalid', checked.errors.map((error) => error.message).join('; '), checked.errors);
    const fields = checked.value;
    const schedule = fields.schedule as OwnedLoopSchedule;
    const created = await this.#serial(async () => {
      if ((await this.#store.sessionLoops.countLive(sessionId)) >= LOOPS_PER_SESSION_MAX) {
        throw new LoopError(409, 'too-many', `a session has at most ${LOOPS_PER_SESSION_MAX} loops: cancel one first`);
      }
      const record = await this.#store.sessionLoops.create({
        id: this.#newId(),
        sessionId,
        label: fields.label ?? null,
        prompt: fields.prompt as string,
        schedule,
        expiresAt: fields.expiresAt ?? null,
        maxRuns: fields.maxRuns ?? null,
        nextFireAt: nextDue(schedule, now)?.toISOString() ?? null,
        createdBy: author,
      });
      await this.#arm();
      return record;
    });
    await this.#changed(sessionId);
    return toOwnedLoop(created);
  }

  /**
   * Changes a loop (`loop_update`, the card's Edit): only the fields given; a new
   * schedule's next due time is computed from now. An ended loop cannot change.
   * @throws {LoopError} 404, 409 `ended`, 422 `invalid`.
   */
  async update(sessionId: string, loopId: string, body: unknown): Promise<OwnedLoop> {
    this.#assertOpen();
    const now = this.#clock.now();
    const checked = checkLoopInput(body, now, { partial: true });
    if (!checked.ok) throw new LoopError(422, 'invalid', checked.errors.map((error) => error.message).join('; '), checked.errors);
    const fields = checked.value;
    const updated = await this.#serial(async () => {
      const loop = await this.#loop(sessionId, loopId);
      if (loop.state === 'ended') throw new LoopError(409, 'ended', `this loop has ended (${loop.endedReason ?? 'ended'}): create a new one`);
      const schedule = fields.schedule ?? loop.schedule;
      const patch: SessionLoopPatch = {
        ...(fields.prompt !== undefined ? { prompt: fields.prompt } : {}),
        ...(fields.label !== undefined ? { label: fields.label } : {}),
        ...(fields.expiresAt !== undefined ? { expiresAt: fields.expiresAt } : {}),
        ...(fields.maxRuns !== undefined ? { maxRuns: fields.maxRuns } : {}),
        ...(fields.schedule ? { schedule, nextFireAt: loop.state === 'active' ? (nextDue(schedule, now)?.toISOString() ?? null) : null } : {}),
      };
      const expiresAt = patch.expiresAt !== undefined ? patch.expiresAt : loop.expiresAt;
      if (schedule.kind === 'at' && expiresAt !== null && Date.parse(expiresAt) <= Date.parse(schedule.at)) {
        throw new LoopError(422, 'invalid', 'expires_at must be after the one-time firing (at)', [{ field: 'expires_at', message: 'expires_at must be after the one-time firing (at)' }]);
      }
      let record = (await this.#store.sessionLoops.update(loop.id, patch)) as SessionLoopRecord;
      const maxRuns = record.maxRuns;
      if (maxRuns !== null && record.runs >= maxRuns) record = await this.#end(record, `ran ${record.runs} times (max_runs)`);
      await this.#arm();
      return record;
    });
    await this.#changed(sessionId);
    return toOwnedLoop(updated);
  }

  /** Pause: no firing until Resume. @throws {LoopError} 404, 409 `ended`. */
  async pause(sessionId: string, loopId: string): Promise<OwnedLoop> {
    const record = await this.#serial(async () => {
      const loop = await this.#loop(sessionId, loopId);
      if (loop.state === 'ended') throw new LoopError(409, 'ended', `this loop has ended (${loop.endedReason ?? 'ended'})`);
      const updated = (await this.#store.sessionLoops.update(loop.id, { state: 'paused', nextFireAt: null })) as SessionLoopRecord;
      await this.#arm();
      return updated;
    });
    await this.#changed(sessionId);
    return toOwnedLoop(record);
  }

  /** Resume: the next due time from now (nothing missed is caught up; a one-shot whose time passed ends). @throws {LoopError} 404, 409 `ended`. */
  async resume(sessionId: string, loopId: string): Promise<OwnedLoop> {
    const record = await this.#serial(async () => {
      const loop = await this.#loop(sessionId, loopId);
      if (loop.state === 'ended') throw new LoopError(409, 'ended', `this loop has ended (${loop.endedReason ?? 'ended'})`);
      if (loop.state === 'active') return loop;
      const next = nextDue(loop.schedule, this.#clock.now());
      const updated =
        next === null
          ? await this.#end(loop, 'its one-time firing passed while it was paused')
          : ((await this.#store.sessionLoops.update(loop.id, { state: 'active', nextFireAt: next.toISOString() })) as SessionLoopRecord);
      await this.#arm();
      return updated;
    });
    await this.#changed(sessionId);
    return toOwnedLoop(record);
  }

  /**
   * Run now: one firing at once (it counts as a run; the schedule is unchanged).
   * Refused while the previous firing still waits, and for an ended loop or a
   * closed session.
   * @throws {LoopError} 404, 409 `ended` / `closed` / `pending` / `unavailable`.
   */
  async runNow(sessionId: string, loopId: string): Promise<OwnedLoop> {
    this.#assertOpen();
    const record = await this.#serial(async () => {
      const loop = await this.#loop(sessionId, loopId);
      if (loop.state === 'ended') throw new LoopError(409, 'ended', `this loop has ended (${loop.endedReason ?? 'ended'})`);
      const outcome = await this.#fire(loop, 'manual');
      await this.#arm();
      return outcome;
    });
    await this.#changed(sessionId);
    return toOwnedLoop(record);
  }

  /** Cancel: the loop is removed. @throws {LoopError} 404. */
  async cancel(sessionId: string, loopId: string): Promise<void> {
    await this.#serial(async () => {
      const loop = await this.#loop(sessionId, loopId);
      await this.#store.sessionLoops.delete(loop.id);
      await this.#arm();
    });
    await this.#changed(sessionId);
  }

  /** D83: the session's loops go to the fresh session that continues it (they keep their ids, runs and schedule). */
  async moveAll(fromSessionId: string, toSessionId: string): Promise<number> {
    const moved = await this.#serial(() => this.#store.sessionLoops.moveAll(fromSessionId, toSessionId));
    if (moved > 0) {
      await this.#changed(fromSessionId);
      await this.#changed(toSessionId);
    }
    return moved;
  }

  /** D65: the session's loops that have not ended, as the take-over carries them. */
  async portable(sessionId: string): Promise<PortableLoop[]> {
    return (await this.#store.sessionLoops.list(sessionId))
      .filter((loop) => loop.state !== 'ended')
      .map((loop) => ({
        label: loop.label,
        prompt: loop.prompt,
        schedule: loop.schedule,
        expiresAt: loop.expiresAt,
        maxRuns: loop.maxRuns,
        state: loop.state === 'paused' ? 'paused' : 'active',
        runs: loop.runs,
        skipped: loop.skipped,
        lastFiredAt: loop.lastFiredAt,
        createdBy: loop.createdBy,
        createdAt: loop.createdAt,
      }));
  }

  /**
   * D65: re-creates loops carried by a take-over in the session on this machine
   * (new ids; the next due time from now; an expired one or a passed one-shot is
   * not re-created). Items that do not have the expected shape are left out.
   */
  async importLoops(sessionId: string, items: readonly unknown[]): Promise<number> {
    const now = this.#clock.now();
    let count = 0;
    await this.#serial(async () => {
      for (const item of items.slice(0, LOOPS_PER_SESSION_MAX)) {
        if (!isRecord(item) || typeof item['prompt'] !== 'string' || item['prompt'].trim() === '' || !isRecord(item['schedule'])) continue;
        const schedule = portableSchedule(item['schedule']);
        if (!schedule) continue;
        const expiresAt = typeof item['expiresAt'] === 'string' ? item['expiresAt'] : null;
        if (expiresAt !== null && Date.parse(expiresAt) <= now.getTime()) continue;
        const next = nextDue(schedule, now);
        if (next === null) continue;
        const paused = item['state'] === 'paused';
        const number = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);
        const maxRuns = typeof item['maxRuns'] === 'number' && Number.isInteger(item['maxRuns']) && item['maxRuns'] > 0 ? item['maxRuns'] : null;
        await this.#store.sessionLoops.create({
          id: this.#newId(),
          sessionId,
          label: typeof item['label'] === 'string' && item['label'].trim() !== '' ? item['label'].trim() : null,
          prompt: item['prompt'].trim(),
          schedule,
          expiresAt,
          maxRuns,
          state: paused ? 'paused' : 'active',
          runs: number(item['runs']),
          skipped: number(item['skipped']),
          lastFiredAt: typeof item['lastFiredAt'] === 'string' ? item['lastFiredAt'] : null,
          nextFireAt: paused ? null : next.toISOString(),
          createdBy: item['createdBy'] === 'developer' ? 'developer' : 'agent',
          ...(typeof item['createdAt'] === 'string' ? { createdAt: item['createdAt'] } : {}),
        });
        count++;
      }
      await this.#arm();
    });
    if (count > 0) await this.#changed(sessionId);
    return count;
  }

  /** Ends every loop of the session that has not ended (D65: moved to another machine). */
  async endAll(sessionId: string, reason: string): Promise<void> {
    await this.#serial(async () => {
      for (const loop of await this.#store.sessionLoops.list(sessionId)) {
        if (loop.state !== 'ended') await this.#end(loop, reason);
      }
      await this.#arm();
    });
    await this.#changed(sessionId);
  }

  /** Looks for due loops now and fires them (the timer calls it; tests may too). */
  async tick(): Promise<void> {
    const changed = new Set<string>();
    await this.#serial(async () => {
      if (this.#closed) return;
      const now = this.#clock.now();
      for (const loop of await this.#store.sessionLoops.listActive()) {
        try {
          if (loop.expiresAt !== null && Date.parse(loop.expiresAt) <= now.getTime()) {
            await this.#end(loop, 'expired');
            changed.add(loop.sessionId);
            continue;
          }
          if (loop.nextFireAt === null || Date.parse(loop.nextFireAt) > now.getTime()) continue;
          const due = new Date(loop.nextFireAt);
          const fired = await this.#fire(loop, 'schedule');
          changed.add(loop.sessionId);
          if (fired.state !== 'active') continue;
          if (loop.schedule.kind === 'at') {
            await this.#end(fired, fired.runs > loop.runs ? 'its one-time firing ran' : `skipped: ${fired.lastError ?? 'not sent'}`);
            continue;
          }
          // One firing, however many were due (a late timer or a machine that slept never bursts): the rest are skipped.
          const { next, missed } = followingDue(loop.schedule, due, now);
          await this.#reschedule(fired, next, missed, missed > 0 ? DOWN_SKIP : fired.lastError);
        } catch (error) {
          this.#onError(error);
        }
      }
      await this.#arm();
    });
    for (const sessionId of changed) await this.#changed(sessionId);
  }

  // ── internals ─────────────────────────────────────────────────────────

  #assertOpen(): void {
    if (this.#closed) throw new LoopError(503, 'closing', 'Switchboard is shutting down');
  }

  async #session(sessionId: string): Promise<SessionRecord> {
    const session = sessionId === '' ? null : await this.#store.sessions.get(sessionId);
    if (!session) throw new LoopError(404, 'not-found', `no session ${sessionId}`);
    return session;
  }

  /** The session's loop (a loop of another session is not found: the agent token reaches only its own). */
  async #loop(sessionId: string, loopId: string): Promise<SessionLoopRecord> {
    await this.#session(sessionId);
    const id = loopId.trim().replace(/^\[|\]$/g, '');
    const loop = LOOP_ID.test(id) ? await this.#store.sessionLoops.get(id) : null;
    if (!loop || loop.sessionId !== sessionId) throw new LoopError(404, 'not-found', `no loop ${id} in this session (loop_list shows the ids)`);
    return loop;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #track(promise: Promise<unknown>): void {
    const tracked = promise.catch((error: unknown) => this.#onError(error)).finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }

  async #changed(sessionId: string): Promise<void> {
    try {
      await this.#announce?.(sessionId);
    } catch (error) {
      this.#onError(error);
    }
  }

  /** Sets the one timer to the earliest due time or expiry, at most {@link MAX_TIMER_MS} away (call inside {@link #serial}). */
  async #arm(): Promise<void> {
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#started || this.#closed) return;
    const now = this.#clock.now().getTime();
    let wait = this.#maxTimerMs;
    for (const loop of await this.#store.sessionLoops.listActive()) {
      for (const at of [loop.nextFireAt, loop.expiresAt]) {
        if (at !== null) wait = Math.min(wait, Math.max(Date.parse(at) - now, 0));
      }
    }
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      this.#track(this.tick());
    }, wait);
  }

  /** `true` while the loop's last firing waits for the agent (queued: a busy turn, a resume, a hooked session's mailbox). */
  async #waiting(loop: SessionLoopRecord): Promise<boolean> {
    if (loop.lastEventId === null) return false;
    const event = await this.#store.events.get(loop.lastEventId);
    if (!event || event.sessionId !== loop.sessionId) return false;
    const payload = event.payload as Partial<UserPayload> | null;
    return payload?.type === 'user' && payload.queued !== undefined && payload.withdrawn !== true && payload.notSent !== true;
  }

  /**
   * One firing (call inside {@link #serial}): ends the loop when its session is
   * closed; skips (counted, with the reason) when the previous firing still waits,
   * the session is being taken over, continues in a terminal or cannot take the
   * message; else sends it and counts the run (ending the loop at `max_runs`).
   * A manual firing is refused instead of skipped.
   */
  async #fire(loop: SessionLoopRecord, trigger: 'schedule' | 'manual'): Promise<SessionLoopRecord> {
    const session = await this.#store.sessions.get(loop.sessionId);
    if (!session) return loop;
    if (session.closedAt !== null) {
      if (trigger === 'manual') throw new LoopError(409, 'closed', 'the session is closed');
      return this.#end(loop, session.movedTo ? `the session moved to ${session.movedTo.machineName}` : 'session closed');
    }
    const skip = async (reason: string, code: string): Promise<SessionLoopRecord> => {
      if (trigger === 'manual') throw new LoopError(409, code, reason);
      return (await this.#store.sessionLoops.update(loop.id, { skipped: loop.skipped + 1, lastError: reason })) as SessionLoopRecord;
    };
    if (await this.#waiting(loop)) return skip(PENDING_SKIP, 'pending');
    if (this.#takingOver(session.id)) return skip('the session is being taken over', 'unavailable');
    if (!session.hooked && !session.attached) return skip('the session continues in a terminal', 'unavailable');
    const run = loop.runs + 1;
    const mark: UserLoopMark = { id: loop.id, label: loopTitle(loop.label, loop.prompt), run };
    try {
      await this.#deliver(session, loop.prompt, mark);
    } catch (error) {
      return skip(error instanceof Error ? error.message : String(error), 'unavailable');
    }
    const eventId = await this.#firingEvent(loop.sessionId, loop.id, run);
    let updated = (await this.#store.sessionLoops.update(loop.id, {
      runs: run,
      lastFiredAt: this.#clock.now().toISOString(),
      lastEventId: eventId,
      lastError: null,
    })) as SessionLoopRecord;
    if (updated.maxRuns !== null && updated.runs >= updated.maxRuns) updated = await this.#end(updated, `ran ${updated.runs} times (max_runs)`);
    return updated;
  }

  /** The chat message of the loop's run `run` (the newest events are enough: it was just written). */
  async #firingEvent(sessionId: string, loopId: string, run: number): Promise<number | null> {
    const events = await this.#store.events.latest(sessionId, 50);
    for (const event of [...events].reverse()) {
      const payload = event.payload as Partial<UserPayload> | null;
      if (payload?.type === 'user' && payload.loop?.id === loopId && payload.loop.run === run) return event.id;
    }
    return null;
  }

  async #reschedule(loop: SessionLoopRecord, next: Date | null, missed: number, reason: string | null): Promise<SessionLoopRecord> {
    if (next === null) return this.#end(loop, 'nothing left to fire', missed > 0 ? { skipped: loop.skipped + missed } : {});
    return (await this.#store.sessionLoops.update(loop.id, {
      nextFireAt: next.toISOString(),
      ...(missed > 0 ? { skipped: loop.skipped + missed, lastError: reason } : {}),
    })) as SessionLoopRecord;
  }

  /** Ends the loop with `reason` (call inside {@link #serial}; the caller publishes the change). A loop past its expiry waits for it, then ends here. */
  async #end(loop: SessionLoopRecord, reason: string, extra: SessionLoopPatch = {}): Promise<SessionLoopRecord> {
    return (await this.#store.sessionLoops.update(loop.id, { ...extra, state: 'ended', endedReason: reason, nextFireAt: null })) as SessionLoopRecord;
  }
}

/** A carried schedule, checked; `null` when it is not one. */
function portableSchedule(value: Record<string, unknown>): OwnedLoopSchedule | null {
  if (value['kind'] === 'cron' && typeof value['cron'] === 'string') {
    const checked = checkLoopInput({ prompt: 'x', cron: value['cron'] }, new Date(0));
    return checked.ok ? (checked.value.schedule ?? null) : null;
  }
  if (value['kind'] === 'every' && typeof value['minutes'] === 'number' && Number.isInteger(value['minutes']) && value['minutes'] >= 1) return { kind: 'every', minutes: value['minutes'] };
  if (value['kind'] === 'at' && typeof value['at'] === 'string' && !Number.isNaN(Date.parse(value['at']))) return { kind: 'at', at: new Date(value['at']).toISOString() };
  return null;
}
