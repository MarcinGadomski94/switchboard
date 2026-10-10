import type { Loop, SessionActivity, SessionEvent } from '../../core/api.ts';
import { LOOP_SOURCE_TOOLS, type LoopEventInput, type ObservedLoop, deriveLoops, isLoopCommand, loopPayloadEssentials } from '../../core/derive/loops.ts';
import type { EventRecord } from '../db/repos/events.ts';
import type { LoopRecord } from '../db/repos/loops.ts';
import type { Store } from '../db/store.ts';
import { folderOfSession } from '../folders/ref.ts';
import type { HubBus } from '../hub/bus.ts';
import { toSession } from '../sessions/wire.ts';
import type { SupervisorEvents } from '../supervisor/supervisor.ts';
import { type FoundProgress, findLoopProgress, sessionWorkingFolders } from './progress.ts';
import { toLoop } from './wire.ts';
import { TranscriptLoopEvents } from './terminal.ts';
import { CLI_PROMPT } from '../../core/derive/unlisted-loops.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';

/** A turn end of a session with no loop rows looks for unlisted schedules at most this often (it reads the transcript). */
const UNTRACKED_CHECK_MS = 60_000;

/** At most this many transcripts' prompt events are kept in memory. */
const MAX_CACHED_TRANSCRIPTS = 32;

/** D95: at most this many sessions' slim events are kept in memory (the most recently refreshed). */
const MAX_CACHED_SESSIONS = 16;

/** D95: a stored event as the tracker keeps it: its payload cut to what `deriveLoops` reads, its time parsed once. */
interface SlimEvent extends LoopEventInput {
  readonly id: number;
  readonly time: number;
}

function slimEvent(event: EventRecord): SlimEvent {
  return { id: event.id, ts: event.ts, time: Date.parse(event.ts), agentId: event.agentId, label: event.label, payload: loopPayloadEssentials(event.payload) };
}

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
 * (never invented), and a changed session is published as
 * `sessionUpdated` so the Schedules & loops view and the session header follow.
 * D93: the derivation lists live loops only, so a tracker-owned row whose loop
 * ended (cancelled, expired, died with an earlier process, nothing left to fire)
 * is deleted.
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
  /** D52: where a session's loop events come from instead of its stored events (a hooked session's transcript); `null` = the stored events. */
  #eventsOf: ((sessionId: string) => Promise<readonly LoopEventInput[] | null>) | null = null;
  /** Unlisted schedules: where a supervised Claude Code session's transcript is (`null` = not read). */
  #transcriptOf: ((session: SessionRecord) => Promise<string | null>) | null = null;
  readonly #transcripts = new TranscriptLoopEvents();
  readonly #recentFiles = new Set<string>();
  /**
   * D95 (`docs/performance.md` → *Incremental derivations*): per session, its stored
   * events cut to what the derivation reads, at the store's write revision; a refresh
   * reads only the events written since (`EventRepository.changedSince`), not the
   * whole history again.
   */
  readonly #slim = new Map<string, { revision: number; readonly byId: Map<number, SlimEvent> }>();
  /** Sessions with no loop rows whose turn end asked for an unlisted-schedule check (one timer each). */
  readonly #slowTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  /**
   * D52: derives a session's loops from `source` when it answers (a hooked terminal
   * session: its transcript, whose scheduled firings are meta lines and whose turn
   * ends are no `result` events, VERIFIED D52-probe-fire), else from its stored events.
   */
  useEventsOf(source: (sessionId: string) => Promise<readonly LoopEventInput[] | null>): void {
    this.#eventsOf = source;
  }

  /**
   * Unlisted schedules (`docs/derivations.md` → *Loop cards*): a supervised Claude
   * Code session's prompts the CLI wrote itself are read from its transcript (the
   * stream has no such prompt text), merged into its stored events.
   */
  useTranscripts(find: (session: SessionRecord) => Promise<string | null>): void {
    this.#transcriptOf = find;
  }

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
    // Unlisted schedules: a session with no loop rows is looked at again within a minute of its activity
    // (a supervised turn's result, a hooked session's imported text; neither names a loop tool).
    else if ((this.#transcriptOf || this.#eventsOf) && ['result', 'assistant'].includes(String(asRecord(event.payload)?.['type']))) this.#scheduleSlow(sessionId);
  }

  /** A session with no loop rows was active: look for an unlisted schedule within {@link UNTRACKED_CHECK_MS}. */
  #scheduleSlow(sessionId: string): void {
    if (this.#closed || this.#slowTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.#slowTimers.delete(sessionId);
      void this.refresh(sessionId).catch(this.#onError);
    }, UNTRACKED_CHECK_MS);
    timer.unref?.();
    this.#slowTimers.set(sessionId, timer);
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
   * Refreshes every session with a tracker-owned loop row. Run once at start: a
   * service stop ends every process (session-only schedules die with it) after this
   * tracker stopped listening, and rows stored before D93 may belong to loops that
   * ended long ago, so they are re-derived from the stored events (ended ones are
   * deleted). Rows the tracker does not own (the demo seed's) are left alone.
   */
  async sweep(): Promise<void> {
    const sessions = new Set<string>();
    for (const row of await this.#store.loops.list()) {
      if (row.id.startsWith(ROW_PREFIX)) sessions.add(row.sessionId);
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
    for (const timer of this.#slowTimers.values()) clearTimeout(timer);
    this.#slowTimers.clear();
    await Promise.allSettled([...this.#running.values()]);
    this.#slim.clear();
  }

  /** The prompts the CLI wrote itself in the session's transcript (Claude Code, supervised); `[]` when not read. */
  async #cliPrompts(session: SessionRecord): Promise<LoopEventInput[]> {
    if (!this.#transcriptOf || session.provider !== 'claude') return [];
    const file = await this.#transcriptOf(session).catch(() => null);
    if (!file) return [];
    // Bounded cache: the newest files read stay.
    this.#recentFiles.delete(file);
    this.#recentFiles.add(file);
    if (this.#recentFiles.size > MAX_CACHED_TRANSCRIPTS) {
      const oldest = this.#recentFiles.values().next().value;
      if (oldest !== undefined) this.#recentFiles.delete(oldest);
      this.#transcripts.retain(this.#recentFiles);
    }
    return (await this.#transcripts.events(file)).filter((event) => asRecord(event.payload)?.['type'] === CLI_PROMPT);
  }

  /**
   * D95: the session's stored events, slim (`loopPayloadEssentials`): from memory, with
   * the events written since the last refresh read again; everything is read when
   * the session is not in memory or the store's change log no longer reaches back.
   */
  async #storedEvents(sessionId: string): Promise<SlimEvent[]> {
    // The revision first: a write that lands while the events are read is read again next time.
    const revision = await this.#store.events.revision(sessionId);
    let cached = this.#slim.get(sessionId);
    if (cached && cached.revision !== revision) {
      const ids = await this.#store.events.changedSince(sessionId, cached.revision);
      if (ids === null) cached = undefined;
      else {
        for (const event of await this.#store.events.byIds(sessionId, ids)) cached.byId.set(event.id, slimEvent(event));
        cached.revision = revision;
      }
    }
    if (!cached) {
      cached = { revision, byId: new Map((await this.#store.events.list(sessionId)).map((event) => [event.id, slimEvent(event)])) };
    }
    this.#slim.delete(sessionId);
    this.#slim.set(sessionId, cached);
    for (const oldest of this.#slim.keys()) {
      if (this.#slim.size <= MAX_CACHED_SESSIONS) break;
      this.#slim.delete(oldest);
    }
    return [...cached.byId.values()];
  }

  async #refreshNow(sessionId: string): Promise<Loop[]> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) return [];
    const own = this.#eventsOf ? await this.#eventsOf(sessionId) : null;
    let observed: ObservedLoop[];
    if (own) {
      observed = deriveLoops(own, { now: this.#now(), status: session.status, mainAgentId: null });
    } else {
      // D93: in time order (insert order on ties): imported terminal turns may be stored after later events.
      const stored = await this.#storedEvents(sessionId);
      const prompts = (await this.#cliPrompts(session)).map((event) => ({ ...event, time: Date.parse(event.ts) }));
      const events = [...stored, ...prompts].sort((a, b) => a.time - b.time || order(a) - order(b));
      const main = await this.#store.agents.mainOf(sessionId);
      observed = deriveLoops(events, { now: this.#now(), status: session.status, mainAgentId: main?.id ?? null });
    }
    let changed = false;
    // D93: rows of loops that ended (the derivation lists live ones only) go; rows it does not own stay.
    const live = new Set(observed.map((loop) => loopRowId(sessionId, loop.key)));
    for (const row of await this.#store.loops.list(sessionId)) {
      if (row.id.startsWith(`${ROW_PREFIX}${sessionId}:`) && !live.has(row.id)) {
        await this.#store.loops.delete(row.id);
        changed = true;
      }
    }
    if (observed.length > 0) this.#tracked.set(sessionId, true);
    // D14: the session's own folders; the shown path is relative to its folder.
    const progress = observed.length > 0 ? await findLoopProgress(await sessionWorkingFolders(this.#store, session), folderOfSession(session)?.root ?? null) : null;
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

/** Insert order of a stored event; a transcript prompt goes before stored events of the same moment. */
function order(event: LoopEventInput): number {
  const id = (event as { id?: unknown }).id;
  return typeof id === 'number' ? id : -1;
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
