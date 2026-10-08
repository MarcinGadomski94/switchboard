import type { SessionContext } from '../../../core/api.ts';
import { formatClockTime, formatTokens } from '../../activity/activity.ts';

/**
 * D49 · the context bar, the composer's first row (`docs/chat.md` → *Context bar*):
 * what it shows for a session's `Session.context`. Pure, for the unit tests.
 */
export interface ContextBarView {
  /** The color band (`data-band`): `ok` green, `warn` yellow, `high` red, `unknown` neutral (empty bar). */
  readonly band: SessionContext['band'];
  /** The fill's width in percent (0 while unknown). */
  readonly fill: number;
  /** `Context 62% · 124k / 200k`, or `Context —` without a reading. */
  readonly text: string;
  /** `compacted 14:05` from a compaction until the next turn starts; `null` otherwise. */
  readonly compacted: string | null;
  /** Ruling D49-autocompact-mark: where the auto-compact tick sits on the track (percent, one decimal); `null` = no tick (auto-compact off). */
  readonly tick: number | null;
  /** The hover tooltip: the window (with the model), where the CLI auto-compacts, and the last compaction (local 24 h time). */
  readonly tooltip: string;
}

/** The bar's text while there is no reading (before the first reply, or right after a compaction without an estimate). */
export const CONTEXT_UNKNOWN_TEXT = 'Context —';

/** `200,000` (grouped the same way on every machine). */
function grouped(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** What the bar shows for `context`. */
export function contextBarView(context: SessionContext): ContextBarView {
  const known = context.tokens !== null && context.percent !== null;
  const text = known ? `Context ${context.percent}% · ${formatTokens(context.tokens ?? 0)} / ${formatTokens(context.window)}` : CONTEXT_UNKNOWN_TEXT;
  const at = context.compaction ? formatClockTime(context.compaction.at) : '';
  const compacted = context.compactedRecently && context.compaction && at ? `compacted ${at}` : null;
  const windowLine = `Context window: ${grouped(context.window)} tokens${context.model ? ` · ${context.model}` : ''}`;
  const compactionLine = context.compaction && at
    ? `Last compacted: ${at}${context.compaction.trigger ? ` (${context.compaction.trigger})` : ''}`
    : 'Not compacted yet';
  const tick = context.autoCompactPercent ?? null;
  const autoLine = tick === null ? 'Auto-compact off' : `Auto-compact at ${Math.round(tick)}%`;
  return {
    band: known ? context.band : 'unknown',
    fill: known ? (context.percent ?? 0) : 0,
    text,
    compacted,
    tick,
    tooltip: `${windowLine}\n${autoLine}\n${compactionLine}`,
  };
}
