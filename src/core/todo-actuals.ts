/**
 * D78 (`docs/todos.md` → *Actual vs. estimate*): what an item took against its estimate,
 * the shared rules of the server, the UI and the agent's tools. Pure: no I/O.
 *
 * - **Open time** (`actualMs`): the item's in-progress spans from its first `in_progress` to
 *   `done`; time back in open (and done) does not count.
 * - **Working time** (`workingMs`, D147): the part of those spans in which the session working
 *   on it (its run session's, else its own) was working (status `run`: a turn, its subagents or
 *   a wake-up it waits on), split equally among that session's items in progress at the time.
 *   It is what the card's "took" shows and what calibration uses. Items finished before D147
 *   have none (`null`: open time only).
 * - **Tokens** (approximate): the turns of the session working on it (its run session's, else
 *   its own session's) that ended during those spans, each turn's
 *   `input + cache creation + output` tokens from its `result` line's `usage`
 *   ({@link resultTurnTokens}); cache reads (the context re-read every call) are left out.
 *   A turn that began before the span counts whole; a session without such results (a hooked
 *   terminal session, a CLI that reports none) adds none.
 * - **Calibration** (D147): per estimate band ({@link CALIBRATION_BANDS}), the ratio of the
 *   summed working time to the summed estimates of the last {@link CALIBRATION_WINDOW}
 *   completed estimated items with a working time (this session's when it has
 *   {@link CALIBRATION_MIN}, else its folder's); a band with fewer than {@link CALIBRATION_MIN}
 *   says "not enough data".
 */
import type { SessionTodo, TodoActualsTotal } from './api.ts';
import { formatTodoMinutes } from './todos.ts';

/** How many completed estimated items (with a working time) calibration needs, overall and per band. */
export const CALIBRATION_MIN = 3;

/** How many of the most recent completed estimated items (with a working time) calibration looks at. */
export const CALIBRATION_WINDOW = 30;

/** D147: the estimate bands calibration reports on: up to `max` minutes (inclusive), the last one open-ended. */
export const CALIBRATION_BANDS: ReadonlyArray<{ readonly max: number; readonly label: string }> = [
  { max: 60, label: '≤1 h' },
  { max: 240, label: '1–4 h' },
  { max: Number.POSITIVE_INFINITY, label: '>4 h' },
];

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The tokens of one turn from its `result` line (raw stream-json): the `usage`'s
 * `input_tokens + cache_creation_input_tokens + output_tokens`; `null` when the line
 * carries no usage (or only zeros).
 */
export function resultTurnTokens(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const usage = (raw as Record<string, unknown>)['usage'];
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;
  const total = count(u['input_tokens']) + count(u['cache_creation_input_tokens']) + count(u['output_tokens']);
  return total > 0 ? Math.round(total) : null;
}

/** Tokens as the cards show them: `850`, `41k`, `1.2M`. */
export function formatTokens(tokens: number): string {
  const n = Math.max(0, Math.round(tokens));
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') : Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** A duration in ms as the cards show it: `32m`, `1h 5m`, `<1m`. */
export function formatActual(ms: number): string {
  const minutes = ms / 60_000;
  return minutes < 1 ? '<1m' : formatTodoMinutes(minutes);
}

/** `true` when the item has finished (done) and recorded its time. */
export function todoHasActuals(todo: Pick<SessionTodo, 'state' | 'actualMs'>): boolean {
  return todo.state === 'done' && typeof todo.actualMs === 'number';
}

/**
 * D147: a duration pair as the cards show it: `took 12m (open 51h 3m)` (working time, with the
 * open time in brackets when it reads differently), or `open 51h 3m` without a working time
 * (finished before D147).
 */
export function tookText(workingMs: number | null | undefined, openMs: number): string {
  const open = formatActual(openMs);
  if (typeof workingMs !== 'number') return `open ${open}`;
  const took = formatActual(workingMs);
  return took === open ? `took ${took}` : `took ${took} (open ${open})`;
}

/** The card's actuals: `took 12m (open 51h 3m) · 41k tokens` (D147; the tokens only when known); `''` when it has none. */
export function todoActualsLabel(todo: Pick<SessionTodo, 'state' | 'actualMs' | 'actualTokens' | 'workingMs'>): string {
  if (!todoHasActuals(todo)) return '';
  const tokens = typeof todo.actualTokens === 'number' && todo.actualTokens > 0 ? ` · ${formatTokens(todo.actualTokens)} tokens` : '';
  return `${tookText(todo.workingMs, todo.actualMs ?? 0)}${tokens}`;
}

/** One completed item's record (`todo_actuals`). */
export interface TodoActualSample {
  readonly estimateMinutes: number | null;
  /** Its open time (D78). */
  readonly actualMs: number;
  readonly actualTokens: number | null;
  /** D147: its working time; `null` = open time only (finished before D147). */
  readonly workingMs: number | null;
}

function estimated(sample: Pick<TodoActualSample, 'estimateMinutes'>): boolean {
  return typeof sample.estimateMinutes === 'number' && sample.estimateMinutes > 0;
}

/** The per-session totals of completed items (the Todos page and board). */
export function todoActualsTotal(samples: readonly TodoActualSample[]): TodoActualsTotal {
  let estimatedCount = 0;
  let estimateMinutes = 0;
  let estimatedActualMs = 0;
  let actualMs = 0;
  let tokens = 0;
  const working = { count: 0, ms: 0, openMs: 0, estimated: 0, estimateMinutes: 0, estimatedMs: 0, estimatedOpenMs: 0 };
  for (const sample of samples) {
    actualMs += sample.actualMs;
    tokens += sample.actualTokens ?? 0;
    if (estimated(sample)) {
      estimatedCount += 1;
      estimateMinutes += sample.estimateMinutes ?? 0;
      estimatedActualMs += sample.actualMs;
    }
    if (typeof sample.workingMs === 'number') {
      working.count += 1;
      working.ms += sample.workingMs;
      working.openMs += sample.actualMs;
      if (estimated(sample)) {
        working.estimated += 1;
        working.estimateMinutes += sample.estimateMinutes ?? 0;
        working.estimatedMs += sample.workingMs;
        working.estimatedOpenMs += sample.actualMs;
      }
    }
  }
  return { count: samples.length, estimated: estimatedCount, estimateMinutes, estimatedActualMs, actualMs, tokens, working };
}

/**
 * A group header's line (D147): `est ~2h · took 1h 10m (open 9h 40m) · 210k tokens (4 done)`;
 * `''` when nothing completed is recorded. With items measured in working time the estimate
 * and both times are theirs (the estimated ones' when any has an estimate); items finished
 * before D147 then count only in the tokens and the done count. Without any (all before D147,
 * or an older peer): the open time, `est ~2h · open 9h 40m`.
 */
export function todoActualsTotalLabel(total: TodoActualsTotal | null | undefined): string {
  if (!total || total.count === 0) return '';
  const parts: string[] = [];
  const working = total.working;
  if (working && working.count > 0) {
    if (working.estimated > 0) parts.push(`est ~${formatTodoMinutes(working.estimateMinutes)} · ${tookText(working.estimatedMs, working.estimatedOpenMs)}`);
    else parts.push(tookText(working.ms, working.openMs));
  } else if (total.estimated > 0) parts.push(`est ~${formatTodoMinutes(total.estimateMinutes)} · open ${formatActual(total.estimatedActualMs)}`);
  else parts.push(`open ${formatActual(total.actualMs)}`);
  if (total.tokens > 0) parts.push(`${formatTokens(total.tokens)} tokens`);
  return `${parts.join(' · ')} (${total.count} done)`;
}

/** D147: one band's ratio ("1.3×"), `null` with too few items in it. */
function bandRatio(samples: readonly TodoActualSample[]): number | null {
  if (samples.length < CALIBRATION_MIN) return null;
  const estimate = samples.reduce((sum, sample) => sum + (sample.estimateMinutes ?? 0), 0);
  const working = samples.reduce((sum, sample) => sum + (sample.workingMs ?? 0), 0) / 60_000;
  return estimate > 0 ? working / estimate : null;
}

/**
 * D147: the calibration line for an agent, per estimate band:
 * `Calibration (last 30 finished, this folder): ≤1 h estimates took 0.6× · 1–4 h took 1.3× · >4 h: not enough data`.
 * Only completed items with an estimate **and a working time** count (items finished before
 * D147 have open time only: left out), the newest {@link CALIBRATION_WINDOW} of them; `null`
 * with fewer than {@link CALIBRATION_MIN} such items, or when no band has
 * {@link CALIBRATION_MIN} (a line of "not enough data" only tells the agent nothing).
 * `samples` newest first.
 */
export function todoCalibration(samples: readonly TodoActualSample[], scope: 'this session' | 'this folder'): string | null {
  const usable = calibrationSamples(samples);
  if (usable.length < CALIBRATION_MIN) return null;
  let known = 0;
  const parts = CALIBRATION_BANDS.map((band, index) => {
    const ratio = bandRatio(usable.filter((sample) => bandOf(sample.estimateMinutes ?? 0) === index));
    const head = index === 0 ? `${band.label} estimates` : band.label;
    if (ratio === null) return `${head}: not enough data`;
    known += 1;
    return `${head} took ${ratio.toFixed(1)}×`;
  });
  if (known === 0) return null;
  return `Calibration (last ${usable.length} finished, ${scope}): ${parts.join(' · ')}`;
}

/** D147: the samples calibration can use (estimated, with a working time), newest {@link CALIBRATION_WINDOW}. */
export function calibrationSamples(samples: readonly TodoActualSample[]): TodoActualSample[] {
  return samples.filter((sample) => estimated(sample) && typeof sample.workingMs === 'number').slice(0, CALIBRATION_WINDOW);
}

/** D147: the index of the {@link CALIBRATION_BANDS} band an estimate (minutes) falls in. */
export function bandOf(estimateMinutes: number): number {
  const index = CALIBRATION_BANDS.findIndex((band) => estimateMinutes <= band.max);
  return index === -1 ? CALIBRATION_BANDS.length - 1 : index;
}
