import type { Schedule, Session } from '../../core/api.ts';
import { nextRun, parseCron } from '../../core/cron.ts';
import { runSessionName } from '../../core/schedules.ts';
import type { ScheduleRunResult, ScheduleRunTrigger, SessionStatus } from '../../core/model.ts';
import type { ScheduleRecord, ScheduleRunRecord } from '../db/repos/schedules.ts';
import type { Store } from '../db/store.ts';
import type { HubBus } from '../hub/bus.ts';
import { type ScheduleRunner, SystemItemError } from '../inbox/system-items.ts';
import { type FolderRef, repoSolutionName } from '../folders/ref.ts';
import { type SessionStartContext, resolveSessionFolder, startNewSession } from '../sessions/start.ts';
import { type FieldError, SESSION_NAME } from '../sessions/validate.ts';
import { type ValidScheduleInput, validateScheduleInput } from './validate.ts';
import { toSchedule } from './wire.ts';

/**
 * The scheduler (M7.1, D8, `docs/schedules.md`): starts a session from a
 * schedule's template when its cron fires (machine-local time), on "Run now" and
 * on the Inbox's "Retry run" (M3.3). Each run is a `schedule_runs` row; its result
 * follows the session it started (`run` → running, `need` → need, `done` → ok,
 * `fail` → fail). A failed run raises the M3.3 "Scheduled run failed" item and
 * every change goes out as `scheduleRun { scheduleId, result }` on `/hub`.
 * No default schedules (gap #6): the table starts empty.
 */

/** Time and timers, injectable so tests drive the scheduler with a fake clock. */
export interface SchedulerClock {
  now(): Date;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The real clock (timers `unref`'d so they never keep the process alive). */
export const SYSTEM_CLOCK: SchedulerClock = {
  now: () => new Date(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** The longest the timer sleeps before it looks again (the clock may jump, e.g. after sleep). */
export const MAX_TIMER_MS = 60_000;

/** Summary of a cron firing skipped because the previous run was still in progress. */
export const SKIPPED_SUMMARY = 'the previous run was still in progress';

/** Why the scheduler refused. `code` maps to an HTTP status in the route. */
export type SchedulerErrorCode = 'not-found' | 'running' | 'invalid' | 'closing';

/** A refusal of a scheduler command. */
export class SchedulerError extends Error {
  override name = 'SchedulerError';
  readonly code: SchedulerErrorCode;
  /** The validation messages (`invalid` only). */
  readonly errors: readonly FieldError[];
  constructor(code: SchedulerErrorCode, message: string, errors: readonly FieldError[] = []) {
    super(message);
    this.code = code;
    this.errors = errors;
  }
}

/** What the scheduler needs from the supervisor: its `sessionUpdated` notifications. */
export interface SessionUpdates {
  on(name: 'sessionUpdated', listener: (session: Session) => void): () => void;
}

/** What the scheduler needs from the M3.3 system items: the failed-run hook. */
export interface FailedRunSink {
  scheduleRunFinished(runId: string): Promise<unknown>;
}

/** Options for {@link Scheduler}. */
export interface SchedulerOptions {
  readonly store: Store;
  /** How runs start sessions: the `POST /api/sessions` flow's services (sessions/start.ts). */
  readonly sessions: SessionStartContext;
  /** The supervisor's `sessionUpdated` (a run's result follows its session). */
  readonly updates: SessionUpdates;
  /** Where `scheduleRun` goes (`/hub`). */
  readonly bus?: HubBus;
  /** M3.3: raises "Scheduled run failed" for a failed run. */
  readonly systemItems?: FailedRunSink;
  readonly clock?: SchedulerClock;
  /** Upper bound of one timer sleep (default {@link MAX_TIMER_MS}). */
  readonly maxTimerMs?: number;
  /** Called when background work fails (default: `console.error`). */
  readonly onError?: (error: unknown) => void;
}

/** The final results: the run no longer follows its session. */
const FINAL: ReadonlySet<ScheduleRunResult> = new Set(['ok', 'fail', 'skipped']);

/** A run's result for a session status; `null` = no change (idle, paused). */
export function runResultFor(status: SessionStatus): ScheduleRunResult | null {
  switch (status) {
    case 'run':
      return 'running';
    case 'need':
      return 'need';
    case 'done':
      return 'ok';
    case 'fail':
      return 'fail';
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? '';
}

/** Refusal text of a session that did not start (`Not started: …`, as the New-session modal words it). */
function refusalText(body: { readonly message?: string; readonly errors?: ReadonlyArray<{ readonly message: string }> }): string {
  const messages = body.errors?.map((error) => error.message) ?? [];
  if (messages.length > 0) return `Not started: ${messages.join('; ')}`;
  return `Not started: ${body.message ?? 'the session could not start'}`;
}

/** Runs sessions from schedules on cron, on Run now and on Retry run (M7.1). */
export class Scheduler {
  readonly #store: Store;
  readonly #sessions: SessionStartContext;
  readonly #bus: HubBus | null;
  readonly #sink: FailedRunSink | null;
  readonly #clock: SchedulerClock;
  readonly #maxTimerMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #unsubscribe: () => void;
  /** Per schedule: the time from which its next firing is looked for (set at start, save, resume and each firing). */
  readonly #armedFrom = new Map<string, number>();
  /** Session id → the id of the unfinished run it belongs to. */
  readonly #runBySession = new Map<string, string>();
  /** Schedules whose run is being started right now (a second start is refused / skipped). */
  readonly #starting = new Set<string>();
  /** Background work (ticks, session updates) that tests and `stop` wait for. */
  readonly #pending = new Set<Promise<unknown>>();
  #queue: Promise<void> = Promise.resolve();
  #timer: unknown = null;
  #started = false;
  #recovered = false;
  #closed = false;

  constructor(options: SchedulerOptions) {
    this.#store = options.store;
    this.#sessions = options.sessions;
    this.#bus = options.bus ?? null;
    this.#sink = options.systemItems ?? null;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#maxTimerMs = options.maxTimerMs ?? MAX_TIMER_MS;
    this.#onError = options.onError ?? ((error) => console.error('switchboard scheduler:', error));
    this.#unsubscribe = options.updates.on('sessionUpdated', (session) => {
      if (!this.#runBySession.has(session.id)) return;
      this.#track(this.#serial(() => this.#follow(session.id, session.status)));
    });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  /**
   * Starts the cron timer (main.ts: once the port is ours, never in demo mode).
   * The first start also picks up the runs left unfinished before a restart.
   * Every schedule looks for its next firing from now on: firings missed while
   * the service was down are not caught up.
   */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    const recover = !this.#recovered;
    this.#recovered = true;
    this.#track(
      this.#serial(async () => {
        // Runs still unfinished from before a restart keep following their sessions.
        if (recover) await this.#reconcile();
        const now = this.#clock.now().getTime();
        for (const schedule of await this.#store.schedules.list()) this.#armedFrom.set(schedule.id, now);
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

  /** {@link stop}, and stops following sessions. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#unsubscribe();
    await this.stop();
  }

  /** Resolves once the background work started so far (ticks, run updates) has finished. */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  // ── queries ───────────────────────────────────────────────────────────

  /** Every schedule (creation order) as `GET /api/schedules` returns it. */
  async list(): Promise<Schedule[]> {
    const schedules = await this.#store.schedules.list();
    return Promise.all(schedules.map((schedule) => this.#wire(schedule)));
  }

  /** One schedule's wire shape. */
  async get(id: string): Promise<Schedule> {
    return this.#wire(await this.#record(id));
  }

  /** When the schedule fires next (`null` while paused or never again). */
  nextRunAt(schedule: ScheduleRecord): Date | null {
    if (schedule.paused) return null;
    const parsed = parseCron(schedule.cron);
    if (!parsed.ok) return null;
    const now = this.#clock.now().getTime();
    const from = Math.max(this.#armedFrom.get(schedule.id) ?? now, now);
    return nextRun(parsed.cron, new Date(from));
  }

  // ── commands ──────────────────────────────────────────────────────────

  /**
   * "Save schedule" (D8): creates a schedule from a `ScheduleInput`, or replaces the
   * cron and template of the one named by `id` (Edit). Its next firing is looked
   * for from now on.
   * @throws {SchedulerError} `invalid` (with `errors`), `not-found`.
   */
  async save(body: unknown): Promise<Schedule> {
    this.#assertOpen();
    // D14: the runs start in `template.folder` (a saved folder's id), the default folder when omitted.
    const template = isRecord(body) && isRecord(body['template']) ? body['template'] : null;
    let folder: FolderRef | null = null;
    if (template) {
      const resolved = await resolveSessionFolder(this.#sessions, template, 'template.folder');
      if (!resolved.ok) {
        const errors = resolved.body.errors ?? [{ field: 'template.folder', message: resolved.body.message ?? 'no usable folder' }];
        throw new SchedulerError('invalid', errors.map((e) => e.message).join('; '), errors);
      }
      folder = resolved.folder;
    }
    const scan = this.#sessions.providers.solutions;
    const readOnlyIn = folder?.kind === 'workspace' ? folder : null;
    const result = await validateScheduleInput(body, {
      scheduleNameTaken: async (name, exceptId) => {
        const other = await this.#store.schedules.getByName(name);
        return other !== null && other.id !== exceptId;
      },
      ...(scan?.isReadOnly && readOnlyIn ? { readOnly: (solution: string) => scan.isReadOnly!(solution, readOnlyIn) } : {}),
      ...(folder ? { folder: { id: folder.id, kind: folder.kind, repoName: repoSolutionName(folder) } } : {}),
    });
    if (!result.ok) throw new SchedulerError('invalid', result.errors.map((e) => e.message).join('; '), result.errors);
    const record = await this.#persist(result.value);
    this.#armedFrom.set(record.id, this.#clock.now().getTime());
    await this.#rearm();
    return this.#wire(record);
  }

  /** Pauses the cron (Run now still works). */
  async pause(id: string): Promise<Schedule> {
    await this.#record(id);
    const record = await this.#store.schedules.update(id, { paused: true });
    await this.#rearm();
    return this.#wire(record ?? (await this.#record(id)));
  }

  /** Resumes the cron; the next firing is looked for from now on (no catch-up). */
  async resume(id: string): Promise<Schedule> {
    await this.#record(id);
    const record = await this.#store.schedules.update(id, { paused: false });
    this.#armedFrom.set(id, this.#clock.now().getTime());
    await this.#rearm();
    return this.#wire(record ?? (await this.#record(id)));
  }

  /**
   * "Run now" / "Retry run": one manual run of the schedule now. Refused while a run
   * of it is in progress (its session runs or waits for the developer).
   * @returns the run, whatever its first result (`running`, or `fail` when the session could not start).
   * @throws {SchedulerError} `not-found`, `running`, `closing`.
   */
  async runNow(id: string): Promise<ScheduleRunRecord> {
    this.#assertOpen();
    const schedule = await this.#record(id);
    return this.#serial(() => this.#fire(schedule, 'manual'));
  }

  /** Looks for due schedules now and fires them (the timer calls it; tests may too). */
  async tick(): Promise<void> {
    await this.#serial(async () => {
      if (this.#closed) return;
      const now = this.#clock.now();
      for (const schedule of await this.#store.schedules.list()) {
        if (schedule.paused) continue;
        const parsed = parseCron(schedule.cron);
        if (!parsed.ok) continue;
        const from = this.#armedFrom.get(schedule.id);
        if (from === undefined) {
          this.#armedFrom.set(schedule.id, now.getTime());
          continue;
        }
        const due = nextRun(parsed.cron, new Date(from));
        if (due === null || due.getTime() > now.getTime()) continue;
        // One firing, however many were due (a late timer or a clock jump never bursts).
        this.#armedFrom.set(schedule.id, now.getTime());
        try {
          await this.#fire(schedule, 'cron');
        } catch (error) {
          this.#onError(error);
        }
      }
      await this.#arm();
    });
  }

  // ── internals ─────────────────────────────────────────────────────────

  #assertOpen(): void {
    if (this.#closed) throw new SchedulerError('closing', 'the scheduler is shutting down');
  }

  async #record(id: string): Promise<ScheduleRecord> {
    const record = await this.#store.schedules.get(id);
    if (!record) throw new SchedulerError('not-found', `no schedule ${id}`);
    return record;
  }

  async #persist(input: ValidScheduleInput): Promise<ScheduleRecord> {
    const fields = { name: input.name, description: input.description, cron: input.cron, template: input.template, folderId: input.template.folder };
    if (input.id === null) return this.#store.schedules.create({ ...fields, paused: false });
    await this.#record(input.id);
    const updated = await this.#store.schedules.update(input.id, fields);
    return updated ?? this.#record(input.id);
  }

  async #wire(schedule: ScheduleRecord): Promise<Schedule> {
    const runs = await this.#store.schedules.recentRuns(schedule.id, 14);
    return toSchedule(schedule, runs, this.nextRunAt(schedule), await this.#inProgress(schedule.id));
  }

  /** Runs one piece of work after the ones queued before it (firings and run updates never interleave). */
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

  /** Re-arms the timer after a change (only while started). */
  async #rearm(): Promise<void> {
    if (!this.#started) return;
    await this.#serial(() => this.#arm());
  }

  /** Sets the one timer to the earliest next firing, at most {@link MAX_TIMER_MS} away. */
  async #arm(): Promise<void> {
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#started || this.#closed) return;
    const now = this.#clock.now().getTime();
    let wait = this.#maxTimerMs;
    for (const schedule of await this.#store.schedules.list()) {
      if (schedule.paused) continue;
      const parsed = parseCron(schedule.cron);
      if (!parsed.ok) continue;
      const next = nextRun(parsed.cron, new Date(this.#armedFrom.get(schedule.id) ?? now));
      if (next) wait = Math.min(wait, Math.max(next.getTime() - now, 0));
    }
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      this.#track(this.tick());
    }, wait);
  }

  /** `true` while a run of the schedule is starting, or its session runs or waits for the developer. */
  async #inProgress(scheduleId: string): Promise<boolean> {
    if (this.#starting.has(scheduleId)) return true;
    for (const run of await this.#store.schedules.unfinishedRuns()) {
      if (run.scheduleId !== scheduleId || !run.sessionId) continue;
      const session = await this.#store.sessions.get(run.sessionId);
      if (session && (session.status === 'run' || session.status === 'need')) return true;
    }
    return false;
  }

  /** Starts one run (call inside {@link #serial}). */
  async #fire(schedule: ScheduleRecord, trigger: ScheduleRunTrigger): Promise<ScheduleRunRecord> {
    const now = this.#clock.now();
    if (await this.#inProgress(schedule.id)) {
      if (trigger === 'manual') throw new SchedulerError('running', 'a run of this schedule is still in progress');
      const skipped = await this.#store.schedules.addRun({
        scheduleId: schedule.id,
        ts: now.toISOString(),
        finishedAt: now.toISOString(),
        result: 'skipped',
        summary: SKIPPED_SUMMARY,
        triggeredBy: trigger,
      });
      this.#publish(schedule.id, 'skipped');
      return skipped;
    }
    this.#starting.add(schedule.id);
    try {
      const run = await this.#store.schedules.addRun({ scheduleId: schedule.id, ts: now.toISOString(), result: 'running', triggeredBy: trigger });
      this.#publish(schedule.id, 'running');
      try {
        const template = isRecord(schedule.template) ? schedule.template : {};
        // D14: the run starts in the schedule's folder (a schedule without one: the default folder at run time).
        const folder = schedule.folderId ?? (typeof template['folder'] === 'string' ? template['folder'] : null);
        const body = { ...template, folder, name: await this.#freeName(schedule.name, now) };
        const outcome = await startNewSession(this.#sessions, body, {
          beforeSpawn: async (session) => {
            await this.#store.sessions.update(session.id, { scheduleId: schedule.id });
            await this.#store.schedules.updateRun(run.id, { sessionId: session.id });
            this.#runBySession.set(session.id, run.id);
          },
        });
        if (!outcome.ok) return await this.#finish(run.id, 'fail', refusalText(outcome.body));
        // The session may already have moved on while it started.
        const session = await this.#store.sessions.get(outcome.record.id);
        if (session) await this.#follow(session.id, session.status);
      } catch (error) {
        return await this.#finish(run.id, 'fail', refusalText({ message: error instanceof Error ? error.message : String(error) }));
      }
      return (await this.#store.schedules.getRun(run.id)) ?? run;
    } finally {
      this.#starting.delete(schedule.id);
    }
  }

  /** A session name for a run that no session has yet. */
  async #freeName(scheduleName: string, at: Date): Promise<string> {
    for (let attempt = 1; attempt < 100; attempt++) {
      const name = runSessionName(scheduleName, at, attempt);
      if (SESSION_NAME.test(name) && (await this.#store.sessions.getByName(name)) === null) return name;
    }
    return runSessionName(scheduleName, at, 100);
  }

  /** Applies a session status to its run (call inside {@link #serial}). */
  async #follow(sessionId: string, status: SessionStatus): Promise<void> {
    const runId = this.#runBySession.get(sessionId);
    if (!runId) return;
    const run = await this.#store.schedules.getRun(runId);
    if (!run || FINAL.has(run.result)) {
      this.#runBySession.delete(sessionId);
      return;
    }
    const result = runResultFor(status);
    if (result === null || result === run.result) return;
    const summary = await this.#summary(sessionId, result);
    if (FINAL.has(result)) {
      await this.#finish(run.id, result, summary);
      return;
    }
    await this.#store.schedules.updateRun(run.id, { result, summary });
    this.#publish(run.scheduleId, result);
  }

  /** Gives a run its final result, publishes it and raises the M3.3 item for a failure. */
  async #finish(runId: string, result: ScheduleRunResult, summary: string | null): Promise<ScheduleRunRecord> {
    const updated = await this.#store.schedules.updateRun(runId, { result, summary, finishedAt: this.#clock.now().toISOString() });
    if (!updated) throw new SchedulerError('not-found', `no run ${runId}`);
    if (updated.sessionId) this.#runBySession.delete(updated.sessionId);
    this.#publish(updated.scheduleId, result);
    if (result === 'fail' && this.#sink) {
      try {
        await this.#sink.scheduleRunFinished(runId);
      } catch (error) {
        this.#onError(error);
      }
    }
    return updated;
  }

  /**
   * The run's short result copy, from its session: for `need` the first open
   * question verbatim (or `Permission · <tool>`); for `ok` / `fail` the label of
   * the last turn's result (its first line), else of the newest error event.
   */
  async #summary(sessionId: string, result: ScheduleRunResult): Promise<string | null> {
    if (result === 'need') {
      const batches = await this.#store.questions.listBatches({ sessionId, states: ['open'] });
      const batch = batches[batches.length - 1];
      if (batch) {
        const first = (await this.#store.questions.questionsOf(batch.id))[0];
        if (first) return firstLine(first.text) || null;
      }
      const permission = (await this.#store.permissions.list({ sessionId, states: ['open'] })).at(-1);
      return permission ? `Permission · ${permission.toolName}` : null;
    }
    if (result !== 'ok' && result !== 'fail') return null;
    const events = await this.#store.events.latest(sessionId, 50);
    const byType = (type: string) => [...events].reverse().find((event) => isRecord(event.payload) && event.payload['type'] === type);
    const resultEvent = byType('result');
    const pick = result === 'fail' ? (resultEvent?.kind === 'error' ? resultEvent : [...events].reverse().find((event) => event.kind === 'error')) : resultEvent;
    const label = pick?.label.trim() ?? '';
    return label === '' || label === 'Done' ? null : label;
  }

  /** At the first start: re-attaches unfinished runs to their sessions and settles those whose session already ended. */
  async #reconcile(): Promise<void> {
    for (const run of await this.#store.schedules.unfinishedRuns()) {
      if (!run.sessionId) {
        // A start that never completed (the service stopped during it); a run without a session cannot follow one.
        if (run.result === 'running') await this.#finish(run.id, 'fail', 'Not started: Switchboard stopped while the run was starting');
        continue;
      }
      const session = await this.#store.sessions.get(run.sessionId);
      if (!session) continue;
      this.#runBySession.set(session.id, run.id);
      await this.#follow(session.id, session.status);
    }
  }

  #publish(scheduleId: string, result: ScheduleRunResult): void {
    this.#bus?.publish('scheduleRun', { scheduleId, result });
  }
}

/**
 * The M3.3 "Retry run" runner over a scheduler: a manual run now. A run still in
 * progress is refused as the item's `busy` (409), a deleted schedule as `gone`.
 */
export function scheduleRunnerFor(scheduler: Pick<Scheduler, 'runNow'>): ScheduleRunner {
  return {
    runNow: async (scheduleId: string) => {
      try {
        return await scheduler.runNow(scheduleId);
      } catch (error) {
        if (error instanceof SchedulerError && error.code === 'running') throw new SystemItemError('busy', error.message);
        if (error instanceof SchedulerError && error.code === 'not-found') throw new SystemItemError('gone', 'the schedule no longer exists');
        throw error;
      }
    },
  };
}
