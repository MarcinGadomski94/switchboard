import type { ActivityState, AgentActivity, BackgroundTask, SessionActivity } from '../../core/api.ts';

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

/** D30: the background wait's words (`<words>: <summary>`, a wake-up `Waking up at HH:MM`). */
export const WAITING_GITHUB = 'Waiting for GitHub Actions';
export const WAITING_BACKGROUND = 'Waiting for a background task';
export const WAKING_UP = 'Waking up at';

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

/** The glyph in front of the chat line: the spinner while working, `●` for a running tool, `⏸` while waiting, `⏳` while background work runs (D30). */
export type ActivityGlyph = 'spinner' | '●' | '⏸' | '⏳';

/** `HH:MM` (24 h, local time) of an ISO time; empty for an unreadable one. */
export function formatClockTime(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** D30: the oldest of the pending background tasks (the one the views show); `null` without any. */
export function oldestBackgroundTask(tasks: readonly BackgroundTask[]): BackgroundTask | null {
  let oldest: BackgroundTask | null = null;
  for (const task of tasks) if (oldest === null || task.startedAt < oldest.startedAt) oldest = task;
  return oldest;
}

/**
 * D30: one background task's words: a wake-up → `Waking up at 18:40`; a GitHub wait
 * → `Waiting for GitHub Actions: <summary>`; anything else → `Waiting for a
 * background task: <summary>`.
 */
export function backgroundText(task: Pick<BackgroundTask, 'kind' | 'summary' | 'wakeAt' | 'github'>): string {
  if (task.kind === 'wakeup' && task.wakeAt) return `${WAKING_UP} ${formatClockTime(task.wakeAt)}`;
  return `${task.github ? WAITING_GITHUB : WAITING_BACKGROUND}: ${task.summary}`;
}

/** D30: a background wait as the views show it: the oldest task's words, `+N more` for the others, the time since it started. */
export interface BackgroundLine {
  readonly text: string;
  /** `+2 more` with several tasks; `null` with one. */
  readonly more: string | null;
  /** `3:21`: since the oldest task started. */
  readonly time: string;
}

/**
 * D30: the background wait (the chat line, the sidebar row, the main agent's card
 * and overview cell): the oldest pending task ({@link backgroundText}), `+N more`
 * when others are pending, and the time since it started (`3:21`, a running tool's
 * clock). Without the list (an older payload), the activity's own `summary` and
 * `since` stand in.
 */
export function backgroundLine(
  tasks: readonly BackgroundTask[],
  fallback: Pick<AgentActivity, 'since' | 'tool' | 'summary'>,
  now: number,
): BackgroundLine {
  const oldest = oldestBackgroundTask(tasks);
  if (oldest === null) {
    return { text: `${WAITING_BACKGROUND}: ${fallback.summary ?? fallback.tool ?? 'Tool'}`, more: null, time: formatClock(elapsedMs(fallback.since, now)) };
  }
  return {
    text: backgroundText(oldest),
    more: tasks.length > 1 ? `+${tasks.length - 1} more` : null,
    time: formatClock(elapsedMs(oldest.startedAt, now)),
  };
}

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
  /** D30 `background` with several tasks: `+N more`; absent otherwise. */
  readonly more?: string;
}

/**
 * The chat line (D19): thinking → a rotating verb, the time since the turn
 * started and `↓ n tokens` when known; a running tool → `● <Tool>: <summary>` and
 * the time since that tool started; writing → `Writing…` and the turn's time;
 * waiting → `Waiting for you` and the time since the request opened. D30:
 * background → `⏳`, the oldest task's words ({@link backgroundLine}), `+N more`,
 * the time since it started.
 */
export function chatActivityLine(activity: SessionActivity, now: number): ChatActivityLine {
  const turn = formatElapsed(elapsedMs(activity.turnStartedAt, now));
  switch (activity.state) {
    case 'background': {
      const line = backgroundLine(activity.background ?? [], activity, now);
      return { state: 'background', glyph: '⏳', text: line.text, time: line.time, tokens: null, ...(line.more ? { more: line.more } : {}) };
    }
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
  /** D30 `background` with several tasks: `+N more`; absent otherwise. */
  readonly more?: string;
}

/**
 * An agent's action for the sidebar and a subagent's card: `Thinking…` / `Writing…`
 * with the time since the agent became active (the turn, for the main agent),
 * `Bash: npm test` / `Waiting for you` with the time since that began, in the
 * chat line's formats. D30: `background` → the chat line's background words and
 * time, from the session's pending tasks (`background`).
 */
export function activityLabel(
  entry: Pick<AgentActivity, 'state' | 'since' | 'startedAt' | 'tool' | 'summary'>,
  now: number,
  background: readonly BackgroundTask[] = [],
): ActivityLabel {
  switch (entry.state) {
    case 'background': {
      const line = backgroundLine(background, entry, now);
      return { state: 'background', text: line.text, time: line.time, ...(line.more ? { more: line.more } : {}) };
    }
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

/** The session's action for its sidebar row: the top-level state, timed like the chat line (D30: the background wait likewise). */
export function sessionActivityLabel(activity: SessionActivity, now: number): ActivityLabel {
  return activityLabel({ ...activity, startedAt: activity.turnStartedAt }, now, activity.background ?? []);
}

/**
 * An agent's action for its card (D19) with the main agent's thinking in the chat
 * line's words: {@link activityLabel}, except that the main agent (`turnStartedAt`
 * given) thinks with the chat line's rotating verb and the turn's time
 * (`Pondering…  1m 23s`); a subagent (`null`) reads `Thinking…`. D21 ruling
 * 2026-09-28: the card, the overview and the chat line use the same verb. D30: the
 * main agent's background wait reads like the chat line's, from `background` (the
 * session's pending tasks).
 */
export function cardActivityLabel(
  entry: Pick<AgentActivity, 'state' | 'since' | 'startedAt' | 'tool' | 'summary'>,
  turnStartedAt: string | null,
  now: number,
  background: readonly BackgroundTask[] = [],
): ActivityLabel {
  const label = activityLabel(entry, now, background);
  return label.state === 'thinking' && turnStartedAt !== null ? { ...label, text: thinkingVerb(turnStartedAt, now) } : label;
}

/**
 * An agent's action for the agent overview's Status cell (D21): the agent card's
 * label ({@link cardActivityLabel}, so the main agent thinks with the chat line's
 * verb) with the chat line's glyph in front of a running tool
 * (`● Bash: npm test  0:42`), a wait (`⏸ Waiting for you  0:12`) or, D30, a
 * background wait (`⏳ Waiting for GitHub Actions: gh run view 42  3:21`).
 */
export function overviewActivityLabel(
  entry: Pick<AgentActivity, 'state' | 'since' | 'startedAt' | 'tool' | 'summary'>,
  turnStartedAt: string | null,
  now: number,
  background: readonly BackgroundTask[] = [],
): ActivityLabel {
  const label = cardActivityLabel(entry, turnStartedAt, now, background);
  switch (label.state) {
    case 'tool':
      return { ...label, text: `● ${label.text}` };
    case 'waiting':
      return { ...label, text: `⏸ ${label.text}` };
    case 'background':
      return { ...label, text: `⏳ ${label.text}` };
    default:
      return label;
  }
}

/**
 * D36: the live line of a subagent's own chat, from its entry in
 * `SessionActivity.agents`: its card's words ({@link activityLabel}: a subagent
 * thinks as `Thinking…`, D21 ruling, timed since it started; `Writing…`;
 * `<Tool>: <summary>` and `Waiting for you` timed since they began) with the chat
 * line's glyphs. No token count: the thinking-token ticks are the main agent's.
 */
export function subagentActivityLine(entry: Pick<AgentActivity, 'state' | 'since' | 'startedAt' | 'tool' | 'summary'>, now: number): ChatActivityLine {
  const label = activityLabel(entry, now);
  const glyph: ActivityGlyph = label.state === 'tool' ? '●' : label.state === 'waiting' ? '⏸' : label.state === 'background' ? '⏳' : 'spinner';
  return { state: label.state, glyph, text: label.text, time: label.time, tokens: null, ...(label.more ? { more: label.more } : {}) };
}
