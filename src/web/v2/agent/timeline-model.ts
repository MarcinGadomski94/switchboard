import { type BlockKind, PLAY_MAX, type TimelineLane } from '../../views/session/timeline.ts';
import type { Tone } from '../glossary.ts';

/**
 * D131 · lane X · the v2 Timeline tab's playback, pure: where a moment sits on the
 * scrubber, the next / previous moment (Play steps through them when the
 * developer asked for reduced motion, and the keyboard's ⇧← / ⇧→ do too), and how
 * an event-log row reads (icon + word + colour). The lanes, the log and the
 * scrubber's model are the classic timeline's (`views/session/timeline.ts`:
 * `timelineModel`, `playStep`). No React.
 */

/** The scrubber's step for the arrow keys (1 % of the axis). */
export const SCRUB_STEP = PLAY_MAX / 100;

/** The scrubber value of a moment drawn `left` % along the lanes. */
export function playOf(left: number): number {
  if (!Number.isFinite(left)) return 0;
  return Math.min(PLAY_MAX, Math.max(0, Math.round(left * (PLAY_MAX / 100))));
}

/** Every block's start on the scrubber, sorted, without repeats. */
export function moments(lanes: readonly TimelineLane[]): number[] {
  return [...new Set(lanes.flatMap((lane) => lane.blocks.map((block) => playOf(block.left))))].sort((a, b) => a - b);
}

/** The next moment after `play` (the end when there is none). */
export function nextMoment(lanes: readonly TimelineLane[], play: number): number {
  return moments(lanes).find((at) => at > play) ?? PLAY_MAX;
}

/** The moment before `play` (the start when there is none). */
export function previousMoment(lanes: readonly TimelineLane[], play: number): number {
  const list = moments(lanes).filter((at) => at < play);
  return list[list.length - 1] ?? 0;
}

/** How an event of the log reads: icon + word + colour per block kind. */
export const LOG_LOOKS: Readonly<Record<BlockKind, { readonly icon: string; readonly word: string; readonly tone: Tone }>> = {
  plan: { icon: 'rules', word: 'Plan', tone: 'violet' },
  impl: { icon: 'cmd', word: 'Work', tone: 'blue' },
  loop: { icon: 'refresh', word: 'Loop', tone: 'blue' },
  ask: { icon: 'question', word: 'Asked', tone: 'amber' },
  ok: { icon: 'check-circle', word: 'Done', tone: 'green' },
  error: { icon: 'alert', word: 'Error', tone: 'red' },
};

/** The lane and block of the log row `id` (to mark it on the lanes), `null` when it is not drawn. */
export function blockOf(lanes: readonly TimelineLane[], id: number): { readonly lane: string | null; readonly left: number; readonly start: number } | null {
  for (const lane of lanes) {
    const block = lane.blocks.find((candidate) => candidate.id === id);
    if (block) return { lane: lane.id, left: block.left, start: block.start };
  }
  return null;
}
