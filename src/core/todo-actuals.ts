/**
 * D78 (`docs/todos.md` → *Actual vs. estimate*): what an item took against its estimate,
 * the shared rules of the server, the UI and the agent's tools. Pure: no I/O.
 *
 * - **Time**: the item's in-progress spans from its first `in_progress` to `done` / `review`;
 *   time back in open (and in review or done) does not count.
 * - **Tokens** (approximate): the turns of the session working on it (its run session's, else
 *   its own session's) that ended during those spans, each turn's
 *   `input + cache creation + output` tokens from its `result` line's `usage`
 *   ({@link resultTurnTokens}); cache reads (the context re-read every call) are left out.
 *   A turn that began before the span counts whole; a session without such results (a hooked
 *   terminal session, a CLI that reports none) adds none.
 * - **Calibration**: the ratio of the summed actual time to the summed estimates of the last
 *   {@link CALIBRATION_WINDOW} completed estimated items (this session's when it has
 *   {@link CALIBRATION_MIN}, else its folder's).
 */
import type { SessionTodo, TodoActualsTotal } from './api.ts';
import { formatTodoMinutes } from './todos.ts';

/** How many completed estimated items calibration needs before it says anything. */
export const CALIBRATION_MIN = 3;

/** How many of the most recent completed estimated items calibration looks at. */
export const CALIBRATION_WINDOW = 10;

/** A ratio this close to 1 (either way) counts as "about right". */
const ABOUT_RIGHT = 1.15;

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

/** `true` when the item has finished (done or in review) and recorded its time. */
export function todoHasActuals(todo: Pick<SessionTodo, 'state' | 'actualMs'>): boolean {
  return (todo.state === 'done' || todo.state === 'review') && typeof todo.actualMs === 'number';
}

/** The card's actuals: `took 32m · 41k tokens` (the tokens only when known); `''` when it has none. */
export function todoActualsLabel(todo: Pick<SessionTodo, 'state' | 'actualMs' | 'actualTokens'>): string {
  if (!todoHasActuals(todo)) return '';
  const tokens = typeof todo.actualTokens === 'number' && todo.actualTokens > 0 ? ` · ${formatTokens(todo.actualTokens)} tokens` : '';
  return `took ${formatActual(todo.actualMs ?? 0)}${tokens}`;
}

/** One completed item's record (`todo_actuals`). */
export interface TodoActualSample {
  readonly estimateMinutes: number | null;
  readonly actualMs: number;
  readonly actualTokens: number | null;
}

/** The per-session totals of completed items (the Todos page and board). */
export function todoActualsTotal(samples: readonly TodoActualSample[]): TodoActualsTotal {
  let estimated = 0;
  let estimateMinutes = 0;
  let estimatedActualMs = 0;
  let actualMs = 0;
  let tokens = 0;
  for (const sample of samples) {
    actualMs += sample.actualMs;
    tokens += sample.actualTokens ?? 0;
    if (typeof sample.estimateMinutes === 'number' && sample.estimateMinutes > 0) {
      estimated += 1;
      estimateMinutes += sample.estimateMinutes;
      estimatedActualMs += sample.actualMs;
    }
  }
  return { count: samples.length, estimated, estimateMinutes, estimatedActualMs, actualMs, tokens };
}

/**
 * A group header's line: `est ~2h · took 1h 40m · 210k tokens (4 done)`; `''` when nothing
 * completed is recorded. The estimate compares with the estimated items' actual time only.
 */
export function todoActualsTotalLabel(total: TodoActualsTotal | null | undefined): string {
  if (!total || total.count === 0) return '';
  const parts: string[] = [];
  if (total.estimated > 0) parts.push(`est ~${formatTodoMinutes(total.estimateMinutes)} · took ${formatActual(total.estimatedActualMs)}`);
  else parts.push(`took ${formatActual(total.actualMs)}`);
  if (total.tokens > 0) parts.push(`${formatTokens(total.tokens)} tokens`);
  return `${parts.join(' · ')} (${total.count} done)`;
}

/**
 * The calibration line for an agent: `Calibration: your last 10 estimates (this session) were
 * 1.4× too low on average.`; `null` with fewer than {@link CALIBRATION_MIN} estimated samples.
 * `samples` newest first; only those with an estimate count.
 */
export function todoCalibration(samples: readonly TodoActualSample[], scope: 'this session' | 'this folder'): string | null {
  const estimated = samples.filter((sample) => typeof sample.estimateMinutes === 'number' && sample.estimateMinutes > 0).slice(0, CALIBRATION_WINDOW);
  if (estimated.length < CALIBRATION_MIN) return null;
  const estimate = estimated.reduce((sum, sample) => sum + (sample.estimateMinutes ?? 0), 0);
  const actual = estimated.reduce((sum, sample) => sum + sample.actualMs, 0) / 60_000;
  if (estimate <= 0) return null;
  const ratio = actual / estimate;
  const head = `Calibration: your last ${estimated.length} estimates (${scope})`;
  if (ratio >= ABOUT_RIGHT) return `${head} were ${ratio.toFixed(1)}× too low on average.`;
  if (ratio > 0 && ratio <= 1 / ABOUT_RIGHT) return `${head} were ${(1 / ratio).toFixed(1)}× too high on average.`;
  return `${head} were about right on average.`;
}
