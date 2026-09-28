/**
 * Cap + breaker of a loop from its `.loop/progress.md` (D9, M7.2), in the state
 * file format of `docs/handoff/LOOP.md`:
 *
 * ```
 * ## Current
 * item: M3.2
 * attempt: 2/5
 * …
 * ## Breaker
 * consecutive_blocked: 0
 * ```
 *
 * - **cap** = the `n` of `attempt: a/n` (LOOP.md's "iteration cap": max plan-act-verify
 *   cycles per item);
 * - **breaker** = the count of the first `consecutive_<what>: <n>` line of the
 *   `## Breaker` section (LOOP.md uses `consecutive_failures`, the overnight
 *   version `consecutive_blocked`); outside that section such a line is ignored.
 *
 * Anything missing or shaped differently stays `null`: the card then shows "—".
 * Nothing is inferred from the Done / Blocked lists or from prose.
 */

/** What the loop cards read from a progress file. */
export interface LoopProgress {
  /** LOOP.md iteration cap (`attempt: a/<cap>`). */
  readonly cap: number | null;
  /** Consecutive failed / blocked items (`## Breaker` → `consecutive_…: <n>`). */
  readonly breakerCount: number | null;
}

/** Parses a `.loop/progress.md` leniently (CRLF, indentation, `**bold**` keys, list bullets). */
export function parseLoopProgress(text: string): LoopProgress {
  let cap: number | null = null;
  let breakerCount: number | null = null;
  let section = '';
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n|\r/)) {
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading) {
      section = (heading[1] ?? '').trim().toLowerCase();
      continue;
    }
    const line = raw.replace(/^\s*(?:[-*+]\s+)?/, '').replace(/\*\*|__/g, '');
    if (cap === null) {
      const attempt = /^attempt\s*:\s*(\d+)\s*\/\s*(\d+)\b/i.exec(line);
      if (attempt) cap = Number(attempt[2]);
    }
    if (breakerCount === null && section.startsWith('breaker')) {
      const breaker = /^consecutive[_ -]?[a-z_ -]*:\s*(\d+)\b/i.exec(line);
      if (breaker) breakerCount = Number(breaker[1]);
    }
  }
  return { cap, breakerCount };
}
