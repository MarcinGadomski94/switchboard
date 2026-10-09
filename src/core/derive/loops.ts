/**
 * Loops observed in a session (D9, M7.2; `docs/derivations.md` → *Loop cards*):
 * derived from the session's stored events, never invented. Pure; the server's
 * `LoopTracker` (src/server/loops/tracker.ts) runs it and stores the result in the
 * `loops` table, which the Schedules & loops view reads (`Session.loops`).
 *
 * Sources:
 * - **`/loop`**: a user message Switchboard wrote that starts with `/loop`. Its own
 *   turn is iteration 1; every later turn the CLI runs on its own (a `result` with
 *   no Switchboard message behind it that is not a background agent's
 *   task-notification) is a firing = one more iteration. The `CronCreate` /
 *   `ScheduleWakeup` calls after it are how `/loop` schedules those firings, so they
 *   belong to it.
 * - **`CronCreate`** (`{cron, prompt, recurring?}`) without a `/loop`: a loop of its
 *   own; iterations = its firings. Next firing = the cron's next match; a recurring
 *   job expires 7 days after it was created (the tool's documented session-only
 *   behavior); `recurring: false` fires once.
 * - **`ScheduleWakeup`** (`delaySeconds`) without a `/loop`: a loop of its own. Next
 *   firing = the call's time + `delaySeconds`, until a firing happens.
 * - **`Workflow`**: one card per session; every call is one run (iteration); a run is
 *   ok / failed by its tool result.
 * - **`CronDelete`** ends the cron it names: the id in its input (`id`), else the
 *   one in its result (`Cancelled job <id>`), matched to the id in the `CronCreate`
 *   result (`Scheduled recurring job <id> …`); "No scheduled job with id …" ends it
 *   too (the process does not have it). Without any id: the only live cron.
 *
 * Session-only schedules die with the process (D93): a process ending (pause,
 * terminal handoff, exit, failure, service stop) or a new process starting (resume,
 * recovery, continue, take-over, …; in a transcript a change of `entrypoint` /
 * `version`, {@link PROCESS_CHANGED}) ends every scheduled loop made before it.
 *
 * Only loops that are still alive are returned (D93): a loop that was cancelled,
 * expired (a recurring cron 7 days after it was created), died with an earlier
 * process, or has nothing left to fire (a one-shot cron or a wake-up that fired) is
 * left out, so its stored card goes. Workflow cards stay (they are runs, not
 * schedules). Cap + breaker come from a `.loop/progress.md` and are added by the
 * tracker, not here.
 */
import type { LoopIteration, LoopIterationResult } from '../api.ts';
import type { SessionStatus } from '../model.ts';
import { nextCronMatch, parseCron } from './cron-next.ts';
import {
  CLI_PROMPT,
  UNLISTED_KIND,
  UNLISTED_LABEL,
  type UnlistedSeries,
  promptKey,
  samePrompt,
  seriesHash,
  seriesInterval,
  seriesRunning,
  unlistedNote,
} from './unlisted-loops.ts';

/** Observed source of a loop (the `loops.kind` column). */
export type LoopSource = '/loop' | 'CronCreate' | 'ScheduleWakeup' | 'Workflow' | typeof UNLISTED_KIND;

/**
 * One iteration of a loop (a strip cell): `ts` = when it finished (its `result`
 * event), else when it started; `label` = the finishing event's label, `null`
 * while open. `none` = it did not finish (the process ended).
 */
export type LoopIterationEntry = LoopIteration;

/** A loop as observed from events. */
export interface ObservedLoop {
  /** Stable per session: `loop`, `cron-<toolUseId>`, `wakeup`, `workflow`. */
  readonly key: string;
  readonly kind: LoopSource;
  /** Card subtitle and chip value: `/loop 1h`, `cron <expression>`, `ScheduleWakeup`, `Workflow · <name>`. */
  readonly label: string;
  readonly startedAt: string;
  readonly iteration: number;
  /** Every iteration, oldest first (the newest {@link MAX_STORED_ITERATIONS}). */
  readonly iterations: readonly LoopIterationEntry[];
  readonly nextFireAt: string | null;
  readonly expiresAt: string | null;
  /** The card note: observed facts only. */
  readonly note: string | null;
}

/** The event fields the derivation reads (a stored event or its wire form). */
export interface LoopEventInput {
  readonly ts: string;
  readonly agentId: string | null;
  readonly label: string;
  readonly payload: unknown;
}

/** Context of {@link deriveLoops}. */
export interface LoopDeriveOptions {
  readonly now: Date;
  /** The session's status: the color of an iteration that is still open. */
  readonly status: SessionStatus;
  /** The main agent's id: its activity with no message pending is a self-started turn. */
  readonly mainAgentId?: string | null;
}

/** Recurring `CronCreate` jobs auto-expire this long after they were created (the tool's description). */
export const CRON_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** How many iterations a loop keeps (the strip shows fewer). */
export const MAX_STORED_ITERATIONS = 100;

/** Tools that feed loop cards (D9). */
export const LOOP_SOURCE_TOOLS: readonly string[] = ['CronCreate', 'CronDelete', 'ScheduleWakeup', 'Workflow'];

/** The session-only note of a recurring cron loop (CronCreate's documented behavior; the prototype's copy). */
export const SESSION_ONLY_NOTE = 'Session-only schedule. It stops when the session closes or after 7 days.';

const PROCESS_END_ACTIONS = new Set(['paused', 'detached', 'exited', 'failed', 'stopped', 'leftover-stopped', 'not-resumed']);

/**
 * D93: lifecycle actions of a process start (every `#spawn` of the supervisor): the
 * session's previous process is gone, and its session-only schedules with it, also
 * when no end was recorded (a hooked terminal's process, D72 `continued`).
 */
const PROCESS_START_ACTIONS = new Set([
  'started',
  'resumed',
  'attached',
  'recovered',
  'moved',
  'teleported',
  'switched',
  'account-switched',
  'taken-over',
  'continued',
  'continued-from',
  'instruction-updated',
]);

/**
 * D93: the lifecycle action a transcript's events carry where the CLI process
 * changed (`entrypoint` or `version` differs from the line before,
 * `terminal-loops.ts`). Never stored.
 */
export const PROCESS_CHANGED = 'process-changed';

/** A one-shot cron may fire this much before its minute (the CLI's documented early firing is up to 90 s). */
const ONE_SHOT_EARLY_MS = 2 * 60_000;

/** The job id in a `CronCreate` result (`Scheduled recurring job 1a2b3c4d (…)`), `null` when none. */
export function cronJobId(result: string): string | null {
  const match = /\bjob\s+["'`]?([A-Za-z0-9][\w-]*)/i.exec(result);
  return match?.[1] ?? null;
}

/** The job a `CronDelete` names: its input's id, else its result's (`Cancelled job <id>`, `No scheduled job with id '<id>'`). */
export function cronDeleteId(input: Readonly<Record<string, unknown>>, result: string | undefined): string | null {
  for (const key of ['id', 'jobId', 'job_id']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  if (result === undefined) return null;
  const match = /\bwith id\s+["'`]?([A-Za-z0-9][\w-]*)/i.exec(result) ?? /\bjob\s+["'`]?([A-Za-z0-9][\w-]*)/i.exec(result);
  return match?.[1] ?? null;
}

/**
 * D93: `false` for a stored loop whose expiry has passed (a recurring cron's 7 days
 * ran out while nothing in its session made the tracker refresh it): it is not
 * shown, and the next refresh or start sweep deletes its row.
 */
export function loopNotExpired(loop: { readonly expiresAt: string | null }, now: Date): boolean {
  return loop.expiresAt === null || !(Date.parse(loop.expiresAt) <= now.getTime());
}

/**
 * `false` for a stored loop that is no longer shown: past its expiry
 * ({@link loopNotExpired}), or an unlisted schedule whose series stopped (no prompt
 * for more than twice its interval, `unlisted-loops.ts`).
 */
export function loopShown(
  loop: { readonly kind: string; readonly expiresAt: string | null; readonly iterations: ReadonlyArray<{ readonly ts: string | null }> },
  now: Date,
): boolean {
  if (!loopNotExpired(loop, now)) return false;
  if (loop.kind !== UNLISTED_KIND) return true;
  const times = loop.iterations.map((it) => (it.ts ? Date.parse(it.ts) : Number.NaN)).filter((t) => !Number.isNaN(t));
  return seriesRunning(times, now.getTime());
}

/** `true` for a message that starts a `/loop`. */
export function isLoopCommand(text: string): boolean {
  return /^\/loop(\s|$)/.test(text.trim());
}

/** `/loop 1h` for `/loop 1h <prompt>`, `/loop` for a self-paced `/loop <prompt>`. */
export function loopCommandLabel(text: string): string {
  const interval = /^\/loop\s+(\d+\s*[smhd])(?:\s|$)/i.exec(text.trim());
  return interval ? `/loop ${(interval[1] ?? '').replace(/\s+/g, '')}` : '/loop';
}

interface Schedule {
  cron: { expression: string; recurring: boolean; createdAt: string; jobText: string; jobId: string | null } | null;
  wakeup: { at: string } | null;
  /** Time of the call that set the schedule (firings go to the most recently scheduled loop). */
  scheduledAt: string;
  firedSinceSchedule: boolean;
}

interface LoopState {
  key: string;
  kind: LoopSource;
  label: string;
  startedAt: string;
  iteration: number;
  iterations: Array<{ result: LoopIterationResult | 'open'; ts: string | null; label: string | null; toolUseId?: string }>;
  schedule: Schedule | null;
  stop: 'process-ended' | 'cron-deleted' | null;
  /** The prompts its schedules fire (the `/loop` text, `CronCreate` / `ScheduleWakeup` `prompt`): a CLI-started series with one of them is this loop's. */
  prompts?: string[];
}

function addPrompt(loop: LoopState, prompt: unknown): void {
  if (typeof prompt !== 'string' || prompt.trim() === '') return;
  (loop.prompts ??= []).push(prompt);
}

/** The prompt of `/loop [interval] <prompt>`. */
function loopCommandPrompt(text: string): string {
  return text.trim().replace(/^\/loop\s*/, '').replace(/^\d+\s*[smhd](\s|$)/i, '').trim();
}

/** `true` when the loop's schedule can be what fired a self-started turn that began at `turnStart` (D93). */
function canFire(loop: LoopState, turnStart: string): boolean {
  const schedule = loop.schedule;
  if (!schedule) return false;
  if (schedule.wakeup) return true;
  const cron = schedule.cron;
  if (!cron) return false;
  const start = Date.parse(turnStart);
  if (cron.recurring) return start < Date.parse(cron.createdAt) + CRON_EXPIRY_MS;
  // A one-shot fires at its minute: a turn before it is something else's.
  const at = nextCronMatch(cron.expression, new Date(Date.parse(cron.createdAt)));
  return at !== null && start >= at.getTime() - ONE_SHOT_EARLY_MS;
}

interface ToolPayloadLike {
  readonly type: 'tool';
  readonly name: string;
  readonly toolUseId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly result?: string;
  readonly isError?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toolOf(payload: Record<string, unknown>): ToolPayloadLike | null {
  if (payload['type'] !== 'tool' || typeof payload['name'] !== 'string') return null;
  const input = asRecord(payload['input']) ?? {};
  return {
    type: 'tool',
    name: payload['name'],
    toolUseId: typeof payload['toolUseId'] === 'string' ? payload['toolUseId'] : '',
    input,
    ...(typeof payload['result'] === 'string' ? { result: payload['result'] } : {}),
    ...(typeof payload['isError'] === 'boolean' ? { isError: payload['isError'] } : {}),
  };
}

function succeeded(tool: ToolPayloadLike): boolean {
  return tool.result !== undefined && tool.isError !== true;
}

function firstLine(text: string, limit = 120): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function workflowLabel(input: Readonly<Record<string, unknown>>): string {
  for (const key of ['name', 'description', 'title']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return `Workflow · ${firstLine(value, 60)}`;
  }
  return 'Workflow';
}

function openResult(status: SessionStatus): LoopIterationResult {
  if (status === 'need') return 'need';
  if (status === 'run') return 'run';
  if (status === 'fail') return 'fail';
  return 'none';
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Derives the loops of one session from its events (oldest first). See the file
 * header for the rules; `docs/derivations.md` → *Loop cards*.
 */
export function deriveLoops(events: readonly LoopEventInput[], options: LoopDeriveOptions): ObservedLoop[] {
  const loops = new Map<string, LoopState>();
  /** Switchboard messages whose turn has not produced its result yet: the loop a `/loop` message started, else null. */
  let pending: Array<LoopState | null> = [];
  let selfTurn: { ts: string } | null = null;
  const main = options.mainAgentId ?? null;
  /** CLI-started prompt series of the current process, by {@link promptKey}. */
  const series = new Map<string, UnlistedSeries>();
  /** The last process boundary was an end: no process, so no series. */
  let processEnded = false;
  /** The prompt the CLI wrote for the turn now running (until its `result`). */
  let turnPrompt: string | null = null;

  const scheduled = (): LoopState[] =>
    [...loops.values()].filter((loop) => loop.kind !== 'Workflow' && loop.stop === null && loop.schedule !== null);
  /** The session's `/loop` (the latest one): schedules made after it are its firings, also after a resume. */
  const loopCommand = (): LoopState | null => loops.get('loop') ?? null;
  const setSchedule = (loop: LoopState, patch: Partial<Schedule>, ts: string): void => {
    const base: Schedule = loop.schedule ?? { cron: null, wakeup: null, scheduledAt: ts, firedSinceSchedule: false };
    loop.schedule = { ...base, ...patch, scheduledAt: ts, firedSinceSchedule: false };
    loop.stop = null;
  };

  for (const event of events) {
    const payload = asRecord(event.payload);
    if (!payload) continue;
    const type = payload['type'];

    if (type === 'user') {
      const text = typeof payload['text'] === 'string' ? payload['text'] : '';
      if (isLoopCommand(text)) {
        const loop: LoopState = {
          key: 'loop',
          kind: '/loop',
          label: loopCommandLabel(text),
          startedAt: event.ts,
          iteration: 1,
          iterations: [{ result: 'open', ts: event.ts, label: null }],
          schedule: null,
          stop: null,
        };
        addPrompt(loop, loopCommandPrompt(text));
        loops.set('loop', loop);
        pending.push(loop);
      } else {
        pending.push(null);
      }
      continue;
    }

    if (type === 'lifecycle') {
      const action = String(payload['action']);
      if (!PROCESS_END_ACTIONS.has(action) && !PROCESS_START_ACTIONS.has(action) && action !== PROCESS_CHANGED) continue;
      pending = [];
      selfTurn = null;
      // A CLI-started series belongs to its process.
      series.clear();
      turnPrompt = null;
      processEnded = PROCESS_END_ACTIONS.has(action);
      for (const loop of loops.values()) {
        for (const it of loop.iterations) if (it.result === 'open') it.result = 'none';
        if (loop.kind !== 'Workflow' && loop.stop === null && (loop.schedule !== null || loop.kind === '/loop')) loop.stop = 'process-ended';
      }
      continue;
    }

    if (type === CLI_PROMPT) {
      const text = typeof payload['text'] === 'string' ? payload['text'] : '';
      const key = promptKey(text);
      if (key === '') continue;
      processEnded = false;
      const entry = series.get(key) ?? { key, text, occurrences: [] };
      for (const it of entry.occurrences) if (it.result === 'open') it.result = 'none';
      entry.text = text;
      entry.occurrences.push({ ts: event.ts, result: 'open', label: null });
      series.set(key, entry);
      turnPrompt = text;
      continue;
    }

    if (type === 'result') {
      const label = event.label || null;
      const result: LoopIterationResult = payload['isError'] === true ? 'fail' : 'ok';
      if (payload['taskNotification'] !== true) {
        // The turn of the newest CLI-started prompt still open ends here.
        let open: { result: LoopIterationResult | 'open'; ts: string; label: string | null } | null = null;
        for (const entry of series.values()) {
          const last = entry.occurrences.at(-1);
          if (last && last.result === 'open' && last.ts <= event.ts && (!open || last.ts > open.ts)) open = last;
        }
        if (open) {
          open.result = result;
          open.label = label;
        }
      }
      if (payload['taskNotification'] === true) {
        selfTurn = null;
        continue;
      }
      // A turn whose CLI-written prompt is known counts only for a loop that fires that prompt (or one whose prompt is unknown).
      const prompt = turnPrompt;
      turnPrompt = null;
      if (pending.length > 0) {
        const loop = pending.shift() ?? null;
        const first = loop?.iterations[0];
        if (first && first.result === 'open') {
          first.result = result;
          first.ts = event.ts;
          first.label = label;
        }
        continue;
      }
      // A turn the CLI ran on its own: a firing of the most recently scheduled loop.
      const turnStart = selfTurn?.ts ?? event.ts;
      selfTurn = null;
      const target = scheduled()
        .filter((loop) => canFire(loop, turnStart))
        .filter((loop) => prompt === null || !loop.prompts?.length || loop.prompts.some((p) => samePrompt(p, prompt)))
        .sort((a, b) => (a.schedule?.scheduledAt ?? '').localeCompare(b.schedule?.scheduledAt ?? ''))
        .at(-1);
      if (!target || !target.schedule) continue;
      target.iteration += 1;
      target.iterations.push({ result, ts: event.ts, label });
      // What fired was scheduled before this turn; a wake-up the turn itself set is the next one.
      if (target.schedule.scheduledAt < turnStart) {
        target.schedule.firedSinceSchedule = true;
        if (target.schedule.cron && !target.schedule.cron.recurring) target.schedule.cron = null;
        target.schedule.wakeup = null;
      }
      continue;
    }

    if (type === 'tool') {
      const tool = toolOf(payload);
      if (!tool) continue;
      if (pending.length === 0 && selfTurn === null && (main === null || event.agentId === null || event.agentId === main)) {
        selfTurn = { ts: event.ts };
      }
      if (tool.name === 'Workflow') {
        const loop = loops.get('workflow') ?? {
          key: 'workflow',
          kind: 'Workflow' as const,
          label: workflowLabel(tool.input),
          startedAt: event.ts,
          iteration: 0,
          iterations: [],
          schedule: null,
          stop: null,
        };
        loop.label = workflowLabel(tool.input);
        const existing = loop.iterations.find((it) => it.toolUseId === tool.toolUseId && tool.toolUseId !== '');
        const result: LoopIterationResult | 'open' = tool.result === undefined ? 'open' : tool.isError ? 'fail' : 'ok';
        const label = tool.result === undefined ? null : firstLine(tool.result) || null;
        if (existing) {
          if (existing.result === 'open') {
            existing.result = result;
            existing.label = label;
          }
        } else {
          loop.iteration += 1;
          loop.iterations.push({ result, ts: event.ts, label, toolUseId: tool.toolUseId });
        }
        loops.set('workflow', loop);
        continue;
      }
      if (tool.name === 'CronDelete') {
        if (tool.result === undefined) continue;
        // D93: the job it names (input, else "Cancelled job <id>"); "No scheduled job …" means the process has none by that id either.
        const id = cronDeleteId(tool.input, tool.result);
        const missing = /no scheduled job/i.test(tool.result);
        if (tool.isError === true && !missing) continue;
        const crons = scheduled().filter((loop) => loop.schedule?.cron);
        const hits = id
          ? crons.filter((loop) => {
              const cron = loop.schedule?.cron;
              return cron !== null && cron !== undefined && (cron.jobId !== null ? cron.jobId === id : cron.jobText.includes(id));
            })
          : missing || crons.length !== 1
            ? []
            : crons;
        for (const loop of hits) {
          if (loop.schedule) loop.schedule.cron = null;
          if (!loop.schedule?.wakeup) loop.stop = 'cron-deleted';
        }
        continue;
      }
      if (!succeeded(tool)) continue;
      if (tool.name === 'CronCreate') {
        const expression = typeof tool.input['cron'] === 'string' ? tool.input['cron'].trim() : '';
        if (!parseCron(expression)) continue;
        const jobText = tool.result ?? '';
        const cron = { expression, recurring: tool.input['recurring'] !== false, createdAt: event.ts, jobText, jobId: cronJobId(jobText) };
        const owner = loopCommand();
        if (owner) {
          setSchedule(owner, { cron, wakeup: null }, event.ts);
          addPrompt(owner, tool.input['prompt']);
        } else {
          const key = `cron-${tool.toolUseId || event.ts}`;
          const loop: LoopState = loops.get(key) ?? {
            key,
            kind: 'CronCreate',
            label: `cron ${expression}`,
            startedAt: event.ts,
            iteration: 0,
            iterations: [],
            schedule: null,
            stop: null,
          };
          setSchedule(loop, { cron, wakeup: null }, event.ts);
          addPrompt(loop, tool.input['prompt']);
          loops.set(key, loop);
        }
        continue;
      }
      if (tool.name === 'ScheduleWakeup') {
        const delay = tool.input['delaySeconds'];
        if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) continue;
        const at = new Date(Date.parse(event.ts) + delay * 1000).toISOString();
        const owner = loopCommand();
        const loop: LoopState =
          owner ??
          loops.get('wakeup') ?? {
            key: 'wakeup',
            kind: 'ScheduleWakeup',
            label: 'ScheduleWakeup',
            startedAt: event.ts,
            iteration: 0,
            iterations: [],
            schedule: null,
            stop: null,
          };
        setSchedule(loop, { wakeup: { at }, cron: loop.schedule?.cron ?? null }, event.ts);
        addPrompt(loop, tool.input['prompt']);
        loops.set(loop.key, loop);
        continue;
      }
      continue;
    }

    // Main-agent text with no message pending: a turn the CLI started on its own is running.
    if (type === 'assistant' && pending.length === 0 && selfTurn === null && (main === null || event.agentId === null || event.agentId === main)) {
      selfTurn = { ts: event.ts };
    }
  }

  const now = options.now.getTime();
  const out: ObservedLoop[] = [];
  /** Prompts of the live scheduled loops listed: they explain a CLI-started series with the same prompt. */
  const livePrompts: string[] = [];
  for (const loop of loops.values()) {
    const iterations: LoopIterationEntry[] = loop.iterations.map((it) => ({
      result: it.result === 'open' ? openResult(options.status) : it.result,
      ts: it.ts,
      label: it.label,
    }));
    let nextFireAt: string | null = null;
    let expiresAt: string | null = null;
    let expired = false;
    const cron = loop.stop === null ? loop.schedule?.cron : null;
    const wakeup = loop.stop === null ? loop.schedule?.wakeup : null;
    if (cron) {
      if (cron.recurring) {
        const expiry = Date.parse(cron.createdAt) + CRON_EXPIRY_MS;
        if (now >= expiry) expired = true;
        else {
          expiresAt = new Date(expiry).toISOString();
          nextFireAt = nextCronMatch(cron.expression, new Date(now))?.toISOString() ?? null;
          if (nextFireAt && Date.parse(nextFireAt) > expiry) nextFireAt = null;
        }
      } else {
        nextFireAt = nextCronMatch(cron.expression, new Date(Date.parse(cron.createdAt)))?.toISOString() ?? null;
      }
    }
    if (wakeup && !nextFireAt) nextFireAt = wakeup.at;
    // A self-started turn in progress belongs to the loop it would count for.
    if (selfTurn && loop.kind !== 'Workflow' && loop.stop === null && loop.schedule) {
      const turn = selfTurn.ts;
      const newest = scheduled()
        .filter((candidate) => canFire(candidate, turn))
        .filter((candidate) => turnPrompt === null || !candidate.prompts?.length || candidate.prompts.some((p) => samePrompt(p, turnPrompt ?? '')))
        .sort((a, b) => (a.schedule?.scheduledAt ?? '').localeCompare(b.schedule?.scheduledAt ?? ''))
        .at(-1);
      if (newest === loop) iterations.push({ result: openResult(options.status), ts: selfTurn.ts, label: null });
    }

    // D93: only live loops are listed. Ended = cancelled, died with its process, expired, or nothing left to fire
    // (a fired one-shot / wake-up); a `/loop` whose first turn still runs has not scheduled yet.
    if (loop.kind !== 'Workflow') {
      const firstTurnOpen = loop.kind === '/loop' && loop.stop === null && loop.iterations[0]?.result === 'open';
      if (loop.stop !== null || (nextFireAt === null && !firstTurnOpen)) continue;
    }

    if (loop.kind !== 'Workflow') livePrompts.push(...(loop.prompts ?? []));

    const notes: string[] = [];
    if (cron?.recurring && !expired) notes.push(SESSION_ONLY_NOTE);
    const last = [...iterations].reverse().find((it) => it.label && (it.result === 'ok' || it.result === 'fail'));
    if (last?.label) notes.push(`Last iteration: ${sentence(last.label)}`);

    out.push({
      key: loop.key,
      kind: loop.kind,
      label: loop.label,
      startedAt: loop.startedAt,
      iteration: loop.kind === '/loop' ? Math.max(loop.iteration, 1) : loop.iteration,
      iterations: iterations.slice(-MAX_STORED_ITERATIONS),
      nextFireAt,
      expiresAt,
      note: notes.length > 0 ? notes.join(' ') : null,
    });
  }

  // Recurring turns the CLI starts itself with no job Switchboard saw (`unlisted-loops.ts`).
  if (!processEnded) {
    for (const entry of series.values()) {
      const times = entry.occurrences.map((it) => Date.parse(it.ts));
      if (!seriesRunning(times, now)) continue;
      if (livePrompts.some((prompt) => samePrompt(prompt, entry.text))) continue;
      const interval = seriesInterval(times) ?? 0;
      const firstLine = (entry.text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
      const iterations: LoopIterationEntry[] = entry.occurrences.map((it) => ({
        result: it.result === 'open' ? openResult(options.status) : it.result,
        ts: it.ts,
        label: it.label,
      }));
      out.push({
        key: `unlisted-${seriesHash(entry.key)}`,
        kind: UNLISTED_KIND,
        label: UNLISTED_LABEL,
        startedAt: entry.occurrences[0]?.ts ?? options.now.toISOString(),
        iteration: entry.occurrences.length,
        iterations: iterations.slice(-MAX_STORED_ITERATIONS),
        nextFireAt: null,
        expiresAt: null,
        note: unlistedNote(firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine, interval),
      });
    }
  }
  return out;
}
