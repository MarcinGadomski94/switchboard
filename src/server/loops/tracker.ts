import type { Loop, SessionActivity, SessionEvent } from '../../core/api.ts';
import { LOOP_SOURCE_TOOLS, type ObservedLoop, deriveLoops, isLoopCommand } from '../../core/derive/loops.ts';
import type { LoopRecord } from '../db/repos/loops.ts';
import type { Store } from '../db/store.ts';
import { folderOfSession } from '../folders/ref.ts';
import type { HubBus } from '../hub/bus.ts';
import { toSession } from '../sessions/wire.ts';
import type { SupervisorEvents } from '../supervisor/supervisor.ts';
import { type FoundProgress, findLoopProgress, sessionWorkingFolders } from './progress.ts';
import { toLoop } from './wire.ts';

/** Where the tracker hears about session events (the SessionSupervisor). */
export interface LoopEventSource {
  on(name: 'event', listener: (payload: SupervisorEvents['event']) => void): () => void;
  /** D19: the session's live activity, carried by the `sessionUpdated` the tracker publishes (none = `null`). */
  activity?(sessionId: string): SessionActivity | null;
}

/** Options for {@link LoopTracker}. */
export interface LoopTrackerOptions {
  readonly store: Store;
  readonly events: LoopEventSource;
  /** Where `sessionUpdated` goes when a session's loops change (`/hub`). */
  readonly bus?: HubBus;
  /** Events fold into one refresh per session per this many ms (default 150). */
  readonly debounceMs?: number;
  readonly now?: () => Date;
  /** Called when a refresh fails (default: `console.error`). */
  readonly onError?: (error: unknown) => void;
}

/** The fields of a `loops` row the tracker owns. */
type LoopFields = Pick<
  LoopRecord,
  'kind' | 'label' | 'iteration' | 'cap' | 'breakerCount' | 'breakerState' | 'nextFireAt' | 'expiresAt' | 'iterations' | 'progressPath' | 'note'
>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** `true` for an event that can start or feed a loop (D9 sources). */
export function isLoopSourceEvent(event: Pick<SessionEvent, 'payload'>): boolean {
  const payload = asRecord(event.payload);
  if (!payload) return false;
  if (payload['type'] === 'user') return typeof payload['text'] === 'string' && isLoopCommand(payload['text']);
  return payload['type'] === 'tool' && typeof payload['name'] === 'string' && LOOP_SOURCE_TOOLS.includes(payload['name']);
}

const ROW_PREFIX = 'loop:';

/** The row id of an observed loop: stable per session + source, so refreshes update in place. */
export function loopRowId(sessionId: string, key: string): string {
  return `${ROW_PREFIX}${sessionId}:${key}`;
}

/**
 * Keeps the `loops` table in step with what sessions do (D9, M7.2;
 * `docs/derivations.md` → *Loop cards*). It listens to the supervisor's `event`
 * notifications; a `/loop` message or a ScheduleWakeup / CronCreate / CronDelete /
 * Workflow call, and afterwards any event of a session that has loops (its turns,
 * its process ending, a write to its progress file), schedules a refresh of that
 * session (folded per session, one at a time): all of its events
 * go through `deriveLoops`, cap + breaker are read from the newest
 * `.loop/progress.md` in its working folders (in its own folder, D14), the rows are created or updated
 * (never invented, never deleted), and a changed session is published as
 * `sessionUpdated` so the Schedules & loops view and the session header follow.
 */
export class LoopTracker {
  readonly #store: Store;
  readonly #bus: HubBus | undefined;
  readonly #debounceMs: number;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  readonly #off: Array<() => void> = [];
  readonly #events: LoopEventSource;
  /** Sessions known to have loops (`true`) or not (`false`); unknown ones are looked up once. */
  readonly #tracked = new Map<string, boolean>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #running = new Map<string, Promise<void>>();
  #closed = false;

  constructor(options: LoopTrackerOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#debounceMs = options.debounceMs ?? 150;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? ((error) => console.error('switchboard loops:', error));
    this.#events = options.events;
    this.listen(options.events);
  }

  /**
   * Also follows the events of `source` (D52: the hook service's imported events of
   * hooked terminal sessions). Its `activity` is not read: the published session
   * carries the main source's.
   */
  listen(source: Pick<LoopEventSource, 'on'>): void {
    if (this.#closed) return;
    this.#off.push(
      source.on('event', ({ sessionId, event }) => {
        void this.#onEvent(sessionId, event).catch(this.#onError);
      }),
    );
  }

  async #onEvent(sessionId: string, event: SessionEvent): Promise<void> {
    if (this.#closed) return;
    if (isLoopSourceEvent(event)) {
      this.#tracked.set(sessionId, true);
      this.schedule(sessionId);
      return;
    }
    let tracked = this.#tracked.get(sessionId);
    if (tracked === undefined) {
      tracked = (await this.#store.loops.list(sessionId)).length > 0;
      if (!this.#tracked.has(sessionId)) this.#tracked.set(sessionId, tracked);
    }
    if (tracked) this.schedule(sessionId);
  }

  /**
   * Refreshes the session's loops once the delay has passed since the first
   * unhandled event (events in between fold into that refresh; a steady stream
   * still refreshes every delay).
   */
  schedule(sessionId: string): void {
    if (this.#closed || this.#timers.has(sessionId)) return;
    this.#timers.set(
      sessionId,
      setTimeout(() => {
        this.#timers.delete(sessionId);
        void this.refresh(sessionId).catch(this.#onError);
      }, this.#debounceMs),
    );
  }

  /**
   * Recomputes and stores the session's loops now (serialized per session).
   * Returns the session's loops as the API shows them.
   */
  refresh(sessionId: string): Promise<Loop[]> {
    const previous = this.#running.get(sessionId) ?? Promise.resolve();
    let result: Loop[] = [];
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        result = await this.#refreshNow(sessionId);
      });
    const tracked = run.finally(() => {
      if (this.#running.get(sessionId) === tracked) this.#running.delete(sessionId);
    });
    this.#running.set(sessionId, tracked);
    return run.then(() => result);
  }

  /**
   * Refreshes every session whose tracker-owned loop still shows a next firing or
   * an expiry. Run once at start: a service stop ends every process (session-only
   * schedules die with it) after this tracker stopped listening, so those rows are
   * re-derived from the stored events. Rows the tracker does not own (the demo
   * seed's) are left alone.
   */
  async sweep(): Promise<void> {
    const sessions = new Set<string>();
    for (const row of await this.#store.loops.list()) {
      if (row.id.startsWith(ROW_PREFIX) && (row.nextFireAt !== null || row.expiresAt !== null)) sessions.add(row.sessionId);
    }
    await Promise.all([...sessions].map((sessionId) => this.refresh(sessionId)));
  }

  /** Resolves once no refresh is scheduled or running (tests). */
  async idle(): Promise<void> {
    for (;;) {
      if (this.#timers.size === 0 && this.#running.size === 0) return;
      await Promise.allSettled([...this.#running.values()]);
      if (this.#timers.size > 0) await new Promise((resolve) => setTimeout(resolve, this.#debounceMs + 5));
    }
  }

  /** Stops listening; scheduled refreshes are dropped, running ones finish. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const off of this.#off.splice(0)) off();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    await Promise.allSettled([...this.#running.values()]);
  }

  async #refreshNow(sessionId: string): Promise<Loop[]> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) return [];
    const events = (await this.#store.events.list(sessionId)).sort((a, b) => a.id - b.id);
    const main = (await this.#store.agents.listBySession(sessionId)).find((agent) => agent.kind === 'main') ?? null;
    const observed = deriveLoops(events, { now: this.#now(), status: session.status, mainAgentId: main?.id ?? null });
    if (observed.length === 0) return (await this.#store.loops.list(sessionId)).map(toLoop);
    this.#tracked.set(sessionId, true);
    // D14: the session's own folders; the shown path is relative to its folder.
    const progress = await findLoopProgress(await sessionWorkingFolders(this.#store, session), folderOfSession(session)?.root ?? null);
    let changed = false;
    for (const loop of observed) {
      const fields = rowFields(loop, progress);
      const id = loopRowId(sessionId, loop.key);
      const existing = await this.#store.loops.get(id);
      if (!existing) {
        await this.#store.loops.create({ id, sessionId, ...fields });
        changed = true;
      } else if (!sameFields(existing, fields)) {
        await this.#store.loops.update(id, fields);
        changed = true;
      }
    }
    if (changed && this.#bus && !this.#closed) {
      const record = await this.#store.sessions.get(sessionId);
      if (record) this.#bus.publish('sessionUpdated', await toSession(this.#store, record, this.#events.activity?.(sessionId) ?? null));
    }
    return (await this.#store.loops.list(sessionId)).map(toLoop);
  }
}

function rowFields(loop: ObservedLoop, progress: FoundProgress | null): LoopFields {
  const notes = [loop.note];
  if (progress && (progress.progress.cap !== null || progress.progress.breakerCount !== null)) {
    notes.push(`Cap and breaker from ${progress.shown}.`);
  }
  const note = notes.filter((n): n is string => Boolean(n)).join(' ');
  return {
    kind: loop.kind,
    label: loop.label,
    iteration: loop.iteration,
    cap: progress?.progress.cap ?? null,
    breakerCount: progress?.progress.breakerCount ?? null,
    breakerState: null,
    nextFireAt: loop.nextFireAt,
    expiresAt: loop.expiresAt,
    iterations: loop.iterations.map((it) => ({ result: it.result, ts: it.ts, label: it.label })),
    progressPath: progress && (progress.progress.cap !== null || progress.progress.breakerCount !== null) ? progress.shown : null,
    note: note === '' ? null : note,
  };
}

function sameFields(existing: LoopRecord, fields: LoopFields): boolean {
  for (const key of Object.keys(fields) as Array<keyof LoopFields>) {
    if (JSON.stringify(existing[key]) !== JSON.stringify(fields[key])) return false;
  }
  return true;
}
