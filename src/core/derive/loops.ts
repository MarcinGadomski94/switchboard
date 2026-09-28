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
 * - **`CronDelete`** stops the cron it names (by the id appearing in the
 *   `CronCreate` result), or the only active cron.
 *
 * Session-only schedules die with the process: when the process ends (pause,
 * terminal handoff, exit, failure, service stop), active scheduled loops stop and
 * lose their next firing and expiry. Cap + breaker come from a `.loop/progress.md`
 * and are added by the tracker, not here.
 */
import type { LoopIteration, LoopIterationResult } from '../api.ts';
import type { SessionStatus } from '../model.ts';
import { nextCronMatch, parseCron } from './cron-next.ts';

/** Observed source of a loop (the `loops.kind` column). */
export type LoopSource = '/loop' | 'CronCreate' | 'ScheduleWakeup' | 'Workflow';

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
  cron: { expression: string; recurring: boolean; createdAt: string; jobText: string } | null;
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
        loops.set('loop', loop);
        pending.push(loop);
      } else {
        pending.push(null);
      }
      continue;
    }

    if (type === 'lifecycle') {
      if (!PROCESS_END_ACTIONS.has(String(payload['action']))) continue;
      pending = [];
      selfTurn = null;
      for (const loop of loops.values()) {
        for (const it of loop.iterations) if (it.result === 'open') it.result = 'none';
        if (loop.kind !== 'Workflow' && loop.stop === null && (loop.schedule !== null || loop.kind === '/loop')) loop.stop = 'process-ended';
      }
      continue;
    }

    if (type === 'result') {
      const label = event.label || null;
      const result: LoopIterationResult = payload['isError'] === true ? 'fail' : 'ok';
      if (payload['taskNotification'] === true) {
        selfTurn = null;
        continue;
      }
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
      const target = scheduled().sort((a, b) => (a.schedule?.scheduledAt ?? '').localeCompare(b.schedule?.scheduledAt ?? '')).at(-1);
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
      if (!succeeded(tool)) continue;
      if (tool.name === 'CronCreate') {
        const expression = typeof tool.input['cron'] === 'string' ? tool.input['cron'].trim() : '';
        if (!parseCron(expression)) continue;
        const cron = { expression, recurring: tool.input['recurring'] !== false, createdAt: event.ts, jobText: tool.result ?? '' };
        const owner = loopCommand();
        if (owner) {
          setSchedule(owner, { cron, wakeup: null }, event.ts);
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
        loops.set(loop.key, loop);
        continue;
      }
      if (tool.name === 'CronDelete') {
        const id = typeof tool.input['id'] === 'string' ? tool.input['id'].trim() : '';
        const crons = scheduled().filter((loop) => loop.schedule?.cron);
        const named = id ? crons.filter((loop) => loop.schedule?.cron?.jobText.includes(id)) : [];
        const hits = named.length > 0 ? named : crons.length === 1 ? crons : [];
        for (const loop of hits) {
          if (loop.schedule) loop.schedule.cron = null;
          if (!loop.schedule?.wakeup) loop.stop = 'cron-deleted';
        }
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
      const newest = scheduled().sort((a, b) => (a.schedule?.scheduledAt ?? '').localeCompare(b.schedule?.scheduledAt ?? '')).at(-1);
      if (newest === loop) iterations.push({ result: openResult(options.status), ts: selfTurn.ts, label: null });
    }

    const notes: string[] = [];
    if (cron?.recurring && !expired) notes.push(SESSION_ONLY_NOTE);
    if (expired) notes.push('Expired 7 days after the cron job was created.');
    if (loop.stop === 'process-ended') notes.push("Stopped: the session's claude process ended.");
    if (loop.stop === 'cron-deleted') notes.push('Stopped: the cron job was deleted.');
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
  return out;
}
