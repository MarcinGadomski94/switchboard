/**
 * The Timeline tab's model (M4.4, SPEC → Session → Timeline): lanes per agent,
 * blocks colored by kind, the playhead, the scrubber's clock and the "Events up
 * to" log, computed from the session's events and agents. Pure, so it is unit
 * tested without a browser. The rules are in `docs/derivations.md` → *Timeline
 * tab*; the prototype's own code is the `tl` object of
 * `docs/handoff/prototype/Switchboard App.dc.html`.
 */
import type { Agent, Session, SessionEvent } from '../../../core/api.ts';
import type { EventKind, SessionStatus } from '../../../core/model.ts';

/** Event kinds drawn as blocks: SPEC's plan / impl / loop / ask / ok, plus `error` so failures show. */
export const BLOCK_KINDS = ['plan', 'impl', 'loop', 'ask', 'ok', 'error'] as const;
/** The kind of a timeline block (its color, `timeline.css`). */
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** Scrubber range: the prototype's `<input type="range" min="0" max="1000">`. */
export const PLAY_MAX = 1000;
/** Play step: the prototype adds 8 every 50 ms (a full sweep in 6.25 s). */
export const PLAY_STEP = 8;
/** Play tick in ms. */
export const PLAY_TICK_MS = 50;
/** The log shows the last 8 events up to the playhead (prototype `.slice(-8)`). */
export const LOG_LIMIT = 8;
/** Ticks on the axis: 7 labels, 0/6 … 6/6 of the span (prototype). */
export const TICK_COUNT = 7;
/** Below this span the clock labels show seconds, so the ticks of a short session differ. */
export const SECONDS_BELOW_MS = 6 * 60_000;
/** Smallest span, so a session whose events share one millisecond still has an axis. */
export const MIN_SPAN_MS = 1_000;
/** Second line of the main agent's lane when it has no solution path: its process runs in the workspace root. */
export const MAIN_LANE_SUB = 'workspace root';
/** Play button copy (prototype). */
export const PLAY_LABEL = '▶';
/** Pause button copy (prototype). */
export const PAUSE_LABEL = '❚❚';
/** Log heading (prototype: "Events up to {now}"). */
export const LOG_HEADING = 'Events up to';

/** A block on a lane. `left` / `width` are percentages of the lane. */
export interface TimelineBlock {
  readonly id: number;
  readonly kind: BlockKind;
  readonly label: string;
  readonly left: number;
  readonly width: number;
  /** Start and end, epoch ms. */
  readonly start: number;
  readonly end: number;
  /** Still running (a tool call without its result, an open request) while the session is live. */
  readonly open: boolean;
  /** Starts after the playhead (the prototype's opacity 0.35). */
  readonly dim: boolean;
}

/** One lane: an agent, with its blocks. */
export interface TimelineLane {
  /** The agent's id, `null` for the fallback lane of a session without agents. */
  readonly id: string | null;
  readonly name: string;
  /** Second line: the agent's solution path (prototype `ln.sol`). */
  readonly sub: string;
  readonly blocks: readonly TimelineBlock[];
}

/** One row of the "Events up to" log. */
export interface TimelineLogEntry {
  readonly id: number;
  /** Clock time of the block's start (`H:MM`). */
  readonly time: string;
  readonly kind: BlockKind;
  /** The lane's name. */
  readonly who: string;
  readonly label: string;
}

/** Everything the tab renders. */
export interface TimelineModel {
  /** No events at all: no axis. */
  readonly empty: boolean;
  /** `start – end` of the axis. */
  readonly range: string;
  readonly ticks: readonly string[];
  /** The clock at the playhead. */
  readonly now: string;
  /** Playhead position, percent of the lane. */
  readonly head: number;
  readonly lanes: readonly TimelineLane[];
  readonly log: readonly TimelineLogEntry[];
  /** Some block is still running in a live session: the axis ends at `now` and moves with it. */
  readonly ticking: boolean;
}

/** What the model is computed from. */
export interface TimelineInput {
  readonly events: readonly SessionEvent[];
  readonly agents: readonly Agent[];
  /** The session's status: `run` / `need` = a live process whose open blocks grow until now. */
  readonly status: SessionStatus | null;
  /** Current time, epoch ms. */
  readonly now: number;
  /** Scrubber value, 0 … {@link PLAY_MAX}. */
  readonly play: number;
  /** D14: the main lane's second line without a solution path (default `workspace root`; a repo session's repo name). */
  readonly root?: string;
}

/** `true` for the kinds drawn as blocks. */
export function isBlockKind(kind: EventKind): kind is BlockKind {
  return (BLOCK_KINDS as readonly string[]).includes(kind);
}

/** `true` while the session has a live process (`run` or `need`). */
export function isLiveStatus(status: SessionStatus | null): boolean {
  return status === 'run' || status === 'need';
}

/**
 * `true` when the event is still running: a tool call without its result, or a
 * permission request that is still open.
 */
export function isOpenEvent(event: SessionEvent): boolean {
  if (event.endTs !== null) return false;
  const payload = event.payload as { type?: unknown; state?: unknown } | null;
  if (payload?.type === 'tool') return true;
  return payload?.type === 'request' && payload.state === 'open';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Local clock time: `H:MM` (hours unpadded, as the prototype's `10:02`), rounded to
 * the nearest minute, or `H:MM:SS` rounded to the nearest second with `seconds`.
 */
export function formatClock(ms: number, seconds = false): string {
  const unit = seconds ? 1_000 : 60_000;
  const d = new Date(Math.round(ms / unit) * unit);
  const base = `${d.getHours()}:${pad(d.getMinutes())}`;
  return seconds ? `${base}:${pad(d.getSeconds())}` : base;
}

function parse(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function clampPlay(play: number): number {
  if (!Number.isFinite(play)) return PLAY_MAX;
  return Math.min(PLAY_MAX, Math.max(0, play));
}

/**
 * Second line of a lane (prototype `ln.sol`): the solution path, else the main
 * agent's workspace root; D14: a repo session's main agent runs in its repo
 * (`root` = the repo's name).
 */
export function laneSub(agent: Agent, root: string = MAIN_LANE_SUB): string {
  if (agent.solutionPath) return agent.solutionPath;
  return agent.kind === 'main' ? root : '';
}

interface Draft {
  readonly event: SessionEvent;
  readonly kind: BlockKind;
  readonly start: number;
  /** End when known (closed), else `null` (open or a point). */
  readonly closedEnd: number;
  readonly open: boolean;
}

/**
 * The Timeline tab's model. Lanes: one per agent, the main agent first, then the
 * others in the order of their first block (agents without blocks last, in their
 * own order). Events of an unknown or no agent go to the main agent's lane.
 * Blocks: events of the kinds in {@link BLOCK_KINDS}, from `ts` to `endTs`; an open
 * one runs to now while the session is live, else to the axis end; anything else
 * is a point (drawn at the block's minimum width). The axis runs from the first
 * event to the last `ts` / `endTs` (or now, while an open block runs).
 */
export function timelineModel(input: TimelineInput): TimelineModel {
  const play = clampPlay(input.play);
  const live = isLiveStatus(input.status);

  const agents = input.agents;
  const main = agents.find((agent) => agent.kind === 'main') ?? agents[0] ?? null;
  const laneOf = new Map<string, number>();
  agents.forEach((agent, index) => laneOf.set(agent.id, index));
  const mainIndex = main ? agents.indexOf(main) : 0;

  // Axis bounds from every event (text included: the task message starts the session).
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  const drafts: Array<Draft & { lane: number }> = [];
  let anyOpen = false;
  for (const event of input.events) {
    const ts = parse(event.ts);
    if (ts === null) continue;
    const endTs = parse(event.endTs);
    first = Math.min(first, ts);
    last = Math.max(last, ts, endTs ?? ts);
    if (!isBlockKind(event.kind)) continue;
    const open = endTs === null && isOpenEvent(event);
    if (open) anyOpen = true;
    const lane = event.agentId !== null && laneOf.has(event.agentId) ? (laneOf.get(event.agentId) as number) : mainIndex;
    drafts.push({ event, kind: event.kind, start: ts, closedEnd: endTs ?? ts, open, lane });
  }

  const empty = !Number.isFinite(first);
  const ticking = !empty && live && anyOpen;
  const start = empty ? input.now : first;
  const lastSeen = empty ? input.now : ticking ? Math.max(last, input.now) : last;
  const span = Math.max(lastSeen - start, MIN_SPAN_MS);
  // The axis end (a very short session is padded to the minimum span).
  const end = start + span;
  const seconds = span < SECONDS_BELOW_MS;
  const clock = (ms: number): string => formatClock(ms, seconds);
  const at = start + (play / PLAY_MAX) * span;

  const pct = (ms: number): number => ((ms - start) / span) * 100;
  const blocksByLane = new Map<number, TimelineBlock[]>();
  for (const draft of drafts) {
    const blockEnd = draft.open ? Math.max(draft.start, end) : Math.max(draft.start, draft.closedEnd);
    const block: TimelineBlock = {
      id: draft.event.id,
      kind: draft.kind,
      label: draft.event.label,
      left: pct(draft.start),
      width: pct(blockEnd) - pct(draft.start),
      start: draft.start,
      end: blockEnd,
      open: draft.open && live,
      dim: draft.start > at,
    };
    const list = blocksByLane.get(draft.lane) ?? [];
    list.push(block);
    blocksByLane.set(draft.lane, list);
  }
  for (const list of blocksByLane.values()) list.sort((a, b) => a.start - b.start || a.id - b.id);

  // Lanes: the main agent first, the others by their first block, then the idle ones.
  const firstBlock = (index: number): number => blocksByLane.get(index)?.[0]?.start ?? Number.POSITIVE_INFINITY;
  const order = agents.map((_, index) => index);
  order.sort((a, b) => {
    if (a === mainIndex) return -1;
    if (b === mainIndex) return 1;
    return firstBlock(a) - firstBlock(b) || a - b;
  });
  const lanes: TimelineLane[] = order.map((index) => {
    const agent = agents[index] as Agent;
    return { id: agent.id, name: agent.name, sub: laneSub(agent, input.root), blocks: blocksByLane.get(index) ?? [] };
  });
  if (lanes.length === 0 && drafts.length > 0) {
    lanes.push({ id: null, name: 'session', sub: '', blocks: blocksByLane.get(mainIndex) ?? [] });
  }

  const names = new Map<number, string>();
  lanes.forEach((lane) => {
    for (const block of lane.blocks) names.set(block.id, lane.name);
  });
  const log = lanes
    .flatMap((lane) => lane.blocks)
    .filter((block) => block.start <= at)
    .sort((a, b) => a.start - b.start || a.id - b.id)
    .slice(-LOG_LIMIT)
    .map((block) => ({ id: block.id, time: formatClock(block.start), kind: block.kind, who: names.get(block.id) ?? '', label: block.label }));

  return {
    empty,
    range: empty ? '' : `${clock(start)} – ${clock(end)}`,
    ticks: empty ? [] : Array.from({ length: TICK_COUNT }, (_, i) => clock(start + (span * i) / (TICK_COUNT - 1))),
    now: empty ? '—' : clock(at),
    head: play / 10,
    lanes,
    log,
    ticking,
  };
}

/** The next scrubber value while playing, and whether playing continues (prototype `togglePlay`). */
export function playStep(play: number): { readonly play: number; readonly playing: boolean } {
  const next = play + PLAY_STEP;
  return next >= PLAY_MAX ? { play: PLAY_MAX, playing: false } : { play: next, playing: true };
}

/**
 * Where the Timeline takes its session (and so its lanes) from: the newest `/hub`
 * `sessionUpdated` copy over the fetched detail. A refetch (asked for when an event
 * names an agent the session does not list yet) replaces only the copies that
 * arrived before it was asked for, and only once its answer lands; until then the
 * newest copy stays, so a lane it shows does not vanish and come back while the
 * refetch runs.
 */
export interface SessionSource {
  /** The newest `/hub` copy and its number (1, 2, …); `null` when none or when a refetch replaced it. */
  readonly pushed: { readonly session: Session; readonly seq: number } | null;
  /** How many copies arrived so far. */
  readonly seq: number;
  /** {@link seq} when the pending refetch was asked for; `null` without one. */
  readonly reloadFrom: number | null;
}

/** No `/hub` copy yet and no refetch pending. */
export const EMPTY_SESSION_SOURCE: SessionSource = { pushed: null, seq: 0, reloadFrom: null };

/** A `/hub` copy arrived: it wins over the fetched detail. */
export function sessionPushed(source: SessionSource, session: Session): SessionSource {
  const seq = source.seq + 1;
  return { ...source, pushed: { session, seq }, seq };
}

/** A refetch was asked for: the copies so far give way once its answer lands. */
export function sessionRefetching(source: SessionSource): SessionSource {
  return { ...source, reloadFrom: source.seq };
}

/** The fetched detail changed: a pending refetch replaces the copies that arrived before it was asked for. */
export function sessionFetched(source: SessionSource): SessionSource {
  const from = source.reloadFrom;
  if (from === null) return source;
  return { ...source, reloadFrom: null, pushed: source.pushed !== null && source.pushed.seq <= from ? null : source.pushed };
}

/** The session to draw: the `/hub` copy when there is one, else the fetched detail. */
export function shownSession(source: SessionSource, fetched: Session | null): Session | null {
  return source.pushed?.session ?? fetched;
}
