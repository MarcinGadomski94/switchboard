/**
 * D93 follow-up (`docs/derivations.md` → *Loop cards* → *Unlisted schedules*):
 * recurring turns the CLI starts by itself with no job Switchboard can see. Pure.
 *
 * Input: `cli-prompt` events, one per prompt the CLI wrote itself
 * (`promptSource: "system"`, no `scheduledTaskId`, not a task notification; read
 * from the transcript, `terminal-loops.ts`). Prompts with the same text (first
 * line, whitespace collapsed, digits ignored) form a series. A series is shown when,
 * in the current process, it has at least {@link MIN_OCCURRENCES} prompts at a
 * roughly regular interval, its last prompt is at most twice that interval ago,
 * and no live loop Switchboard derived has the same prompt (that loop explains it).
 * A process boundary (the lifecycle events `deriveLoops` reads) starts every series
 * over, and a process end leaves none.
 *
 * Nothing about the job itself is observable (no id, no next firing, no expiry),
 * so the card carries only what was seen: the prompt, the occurrences, and an
 * interval estimated from them.
 */
import type { LoopIterationResult } from '../api.ts';

/** The `kind` of an unlisted-schedule card. */
export const UNLISTED_KIND = 'Unlisted';

/** The card's label. */
export const UNLISTED_LABEL = 'Unlisted schedule in the CLI';

/** A series needs this many prompts before it is shown. */
export const MIN_OCCURRENCES = 3;

/** The interval is estimated from at most this many of the newest gaps. */
const INTERVAL_GAPS = 5;

/** Every one of the newest (up to 3) gaps must be within this factor of the estimate (jitter). */
const JITTER = 0.5;

/** Shorter intervals are not taken for a schedule (a burst, not a cadence). */
const MIN_INTERVAL_MS = 60_000;

/** The event payload type of a prompt the CLI wrote itself. */
export const CLI_PROMPT = 'cli-prompt';

/** The series key of a prompt text: its first line, whitespace collapsed, digits as `#`, lower case. */
export function promptKey(text: string): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
  return line.replace(/\s+/g, ' ').replace(/\d/g, '#').toLowerCase().slice(0, 200);
}

/** `true` when two prompt texts are the same series (or one is the start of the other). */
export function samePrompt(a: string, b: string): boolean {
  const x = promptKey(a);
  const y = promptKey(b);
  if (x === '' || y === '') return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/**
 * The interval of a series from its occurrence times (oldest first): the median of
 * the newest gaps, or `null` with fewer than {@link MIN_OCCURRENCES} occurrences,
 * an interval under a minute, or gaps too irregular to be a schedule.
 */
export function seriesInterval(times: readonly number[]): number | null {
  if (times.length < MIN_OCCURRENCES) return null;
  const gaps: number[] = [];
  for (let i = Math.max(1, times.length - INTERVAL_GAPS); i < times.length; i++) gaps.push((times[i] ?? 0) - (times[i - 1] ?? 0));
  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  if (median < MIN_INTERVAL_MS) return null;
  for (const gap of gaps.slice(-3)) if (Math.abs(gap - median) > median * JITTER) return null;
  return median;
}

/** `true` while a series with these occurrence times still runs at `now` (its last one at most two intervals ago). */
export function seriesRunning(times: readonly number[], now: number): boolean {
  const interval = seriesInterval(times);
  const last = times.at(-1);
  return interval !== null && last !== undefined && now - last <= 2 * interval;
}

/** `~30 min`, `~2 h`, `~1 day` for an interval in ms. */
export function formatInterval(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `~${minutes} min`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `~${hours} h`;
  const days = Math.round(ms / 86_400_000);
  return `~${days} day${days === 1 ? '' : 's'}`;
}

/** One occurrence of a series. */
export interface UnlistedOccurrence {
  /** When the CLI wrote the prompt. */
  ts: string;
  /** From the turn's `result`; `open` until it comes. */
  result: LoopIterationResult | 'open';
  label: string | null;
}

/** A series being collected (mutable while the events are read). */
export interface UnlistedSeries {
  readonly key: string;
  /** The newest prompt's text. */
  text: string;
  readonly occurrences: UnlistedOccurrence[];
}

/** The note of an unlisted-schedule card (`firstLine` = the prompt's first line). */
export function unlistedNote(firstLine: string, interval: number): string {
  return [
    `Prompt: "${firstLine}".`,
    `Started by the CLI itself about every ${formatInterval(interval).slice(1)}; no job for it is visible (CronList does not list it), so its next firing and expiry are unknown.`,
    'It may stop on its own (a recurring job auto-expires 7 days after it was created).',
  ].join(' ');
}

/** A stable, short key part for a series (djb2, base 36). */
export function seriesHash(key: string): string {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = ((hash * 33) ^ key.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}
