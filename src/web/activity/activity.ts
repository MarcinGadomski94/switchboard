import type { ActivityState, AgentActivity, SessionActivity } from '../../core/api.ts';

/**
 * The live activity's copy (D19, `docs/chat.md` → *Live activity line*): the
 * chat's Claude-Code-style line above the composer, the sidebar's action line and
 * the agent cards' status slot, from `Session.activity` / the `/hub` `activity`
 * event. Pure (the clock is a parameter) so `tests/web` can check it.
 */

/**
 * Switchboard's own thinking verbs (D19: "a playful verb that rotates while
 * thinking"). The first three are the decision's examples; the rest lean on the
 * switchboard: an operator patching calls through.
 */
export const THINKING_VERBS: readonly string[] = [
  'Pondering…',
  'Noodling…',
  'Cogitating…',
  'Patching through…',
  'Plugging in…',
  'Routing…',
  'Dialing in…',
  'Untangling…',
  'Tinkering…',
  'Sleuthing…',
  'Rummaging…',
  'Whittling…',
  'Juggling…',
  'Sifting…',
  'Tuning…',
  'Weaving…',
  'Wrangling…',
  'Scheming…',
  'Connecting dots…',
  'Chewing on it…',
];

/** How long one thinking verb stays (ms). */
export const VERB_ROTATE_MS = 4_000;

/** The copy of the states that have no verb of their own. */
export const WRITING = 'Writing…';
export const THINKING = 'Thinking…';
export const WAITING = 'Waiting for you';

/** Milliseconds from `iso` to `now`, never negative (0 for an unreadable time). */
export function elapsedMs(iso: string, now: number): number {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, now - at) : 0;
}

/** Elapsed time as the chat line shows a turn's: `0s`, `12s`, `1m 23s`, `2h 5m`. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A running tool's clock: `0:42`, `12:05`, `1:02:03`. */
export function formatClock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

/** `tenths` tenths of `unit`, one decimal unless it is 0: `12` → `1.2k`, `10` → `1k`. */
function tenthsOf(tenths: number, unit: string): string {
  const rest = tenths % 10;
  return `${Math.floor(tenths / 10)}${rest ? `.${rest}` : ''}${unit}`;
}

/** A token count: `850`, `1.2k`, `12k`, `1.5M` (rounded down, never up). */
export function formatTokens(count: number): string {
  const n = Math.max(0, Math.floor(count));
  if (n < 1_000) return String(n);
  if (n < 10_000) return tenthsOf(Math.floor(n / 100), 'k');
  if (n < 1_000_000) return `${Math.floor(n / 1_000)}k`;
  return tenthsOf(Math.floor(n / 100_000), 'M');
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * The thinking verb at `now`: a turn starts at a verb picked from its start time
 * and moves to the next one every {@link VERB_ROTATE_MS}, so every view of the
 * same turn shows the same verb at the same moment.
 */
export function thinkingVerb(turnStartedAt: string, now: number): string {
  const step = Math.floor(elapsedMs(turnStartedAt, now) / VERB_ROTATE_MS);
  return THINKING_VERBS[(hash(turnStartedAt) + step) % THINKING_VERBS.length] ?? THINKING_VERBS[0] ?? THINKING;
}

/** A tool's words: `Bash: npm test`, or just the name when the summary is the name. */
export function toolText(tool: string | null, summary: string | null): string {
  const name = tool ?? 'Tool';
  return summary && summary !== name ? `${name}: ${summary}` : name;
}

/** The glyph in front of the chat line: the spinner while working, `●` for a running tool, `⏸` while waiting. */
export type ActivityGlyph = 'spinner' | '●' | '⏸';

/** The chat's activity line (D19). */
export interface ChatActivityLine {
  readonly state: ActivityState;
  readonly glyph: ActivityGlyph;
  /** The verb (thinking), `Writing…`, `Bash: npm test`, `Waiting for you`. */
  readonly text: string;
  /** `12s` / `1m 23s` since the turn started (thinking, writing); `0:42` since the tool or the wait started. */
  readonly time: string;
  /** `↓ 1.2k tokens` while thinking once a tick arrived; else `null`. */
  readonly tokens: string | null;
}

/**
 * The chat line (D19): thinking → a rotating verb, the time since the turn
 * started and `↓ n tokens` when known; a running tool → `● <Tool>: <summary>` and
 * the time since that tool started; writing → `Writing…` and the turn's time;
 * waiting → `Waiting for you` and the time since the request opened.
 */
export function chatActivityLine(activity: SessionActivity, now: number): ChatActivityLine {
  const turn = formatElapsed(elapsedMs(activity.turnStartedAt, now));
  switch (activity.state) {
    case 'tool':
      return { state: 'tool', glyph: '●', text: toolText(activity.tool, activity.summary), time: formatClock(elapsedMs(activity.since, now)), tokens: null };
    case 'waiting':
      return { state: 'waiting', glyph: '⏸', text: WAITING, time: formatClock(elapsedMs(activity.since, now)), tokens: null };
    case 'writing':
      return { state: 'writing', glyph: 'spinner', text: WRITING, time: turn, tokens: null };
    default:
      return {
        state: 'thinking',
        glyph: 'spinner',
        text: thinkingVerb(activity.turnStartedAt, now),
        time: turn,
        tokens: activity.thinkingTokens === null ? null : `↓ ${formatTokens(activity.thinkingTokens)} tokens`,
      };
  }
}

/** A compact action + time (the sidebar row, an agent card's status slot). */
export interface ActivityLabel {
  readonly state: ActivityState;
  readonly text: string;
  readonly time: string;
}

/**
 * An agent's action for the sidebar and the agent cards: `Thinking…` / `Writing…`
 * with the time since the agent became active (the turn, for the main agent),
 * `Bash: npm test` / `Waiting for you` with the time since that began, in the
 * chat line's formats.
 */
export function activityLabel(entry: Pick<AgentActivity, 'state' | 'since' | 'startedAt' | 'tool' | 'summary'>, now: number): ActivityLabel {
  switch (entry.state) {
    case 'tool':
      return { state: 'tool', text: toolText(entry.tool, entry.summary), time: formatClock(elapsedMs(entry.since, now)) };
    case 'waiting':
      return { state: 'waiting', text: WAITING, time: formatClock(elapsedMs(entry.since, now)) };
    case 'writing':
      return { state: 'writing', text: WRITING, time: formatElapsed(elapsedMs(entry.startedAt, now)) };
    default:
      return { state: 'thinking', text: THINKING, time: formatElapsed(elapsedMs(entry.startedAt, now)) };
  }
}

/** The session's action for its sidebar row: the top-level state, timed like the chat line. */
export function sessionActivityLabel(activity: SessionActivity, now: number): ActivityLabel {
  return activityLabel({ ...activity, startedAt: activity.turnStartedAt }, now);
}
