import type { PlanEdge, PlanItem } from '../../../core/plans.ts';
import type { Timeline, TimelineRow } from '../../plans/model.ts';
import { durationShort } from '../../plans/model.ts';
import { GRAPH_WORDS, PROJECT_WORDS, STATUS } from '../glossary.ts';
import type { BoardColumn } from '../shared/board-model.ts';
import { type GraphTone, SEVERAL_LANE, curve, elapsedMinutes, laneLabel, laneOf, remainingCriticalPath, shortRepoNames, stepProgress } from './graph-layout.ts';
import type { StepLook } from './project-model.ts';

/**
 * Fixes after 2.0 → *Steps, Board and Timeline in the Graph's look* (`docs/design/v2-decisions.md`):
 * the pure rules the three views share with the Graph (DOM-free, unit-tested in
 * `tests/web/v2-project-views.test.ts`). The Graph's own maths stay in `graph-layout.ts` and are
 * imported, never copied: the tone (`graphTone`), the ring value (`stepProgress`), the critical path
 * (`remainingCriticalPath`), the lanes (`laneOf`, `shortRepoNames`), the hover path (`relatedPath`).
 *
 * Re-implemented here because `GraphView.tsx` computes them inline (dedupe later: the Graph can
 * import these): the card's meta line ({@link stepMeta}), the chip's hue ({@link laneHues} /
 * {@link repoChip}), the header's counts by tone ({@link toneCounts}).
 */

// ── tones, sections ─────────────────────────────────────────────────────

/** The icon in a step's ring per tone (working shows the spinning ring alone). Same as `graph-parts.tsx`'s `TONE_ICON`. */
export const TONE_ICON: Readonly<Record<GraphTone, string | null>> = {
  working: null,
  ready: 'play',
  waiting: 'clock',
  needs: 'alert',
  approval: 'half',
  failed: 'x',
  done: 'check',
};

/** The header bar's segments, in this order (the Graph header's order). */
export const PROGRESS_SEGMENTS: readonly GraphTone[] = ['done', 'working', 'needs', 'approval', 'failed', 'ready', 'waiting'];

/** How many steps have each tone. */
export function toneCounts(tones: Iterable<GraphTone>): Readonly<Record<GraphTone, number>> {
  const out: Record<GraphTone, number> = { working: 0, ready: 0, waiting: 0, needs: 0, approval: 0, failed: 0, done: 0 };
  for (const tone of tones) out[tone] += 1;
  return out;
}

/** The Steps list's sections when grouped by state, top to bottom (Done is folded). */
export const STEP_SECTIONS = ['needs', 'working', 'ready', 'waiting', 'done'] as const;
/** One of {@link STEP_SECTIONS}. */
export type StepSection = (typeof STEP_SECTIONS)[number];

/** The section a step sits in: everything that waits for the developer (needs you, approval, failed) is "Needs you". */
export function sectionOf(tone: GraphTone): StepSection {
  switch (tone) {
    case 'needs':
    case 'approval':
    case 'failed':
      return 'needs';
    default:
      return tone;
  }
}

/** The tone a section's header shows (its mark and count colour). */
export const SECTION_TONE: Readonly<Record<StepSection, GraphTone>> = { needs: 'needs', working: 'working', ready: 'ready', waiting: 'waiting', done: 'done' };

/** The Steps list by state: the non-empty sections in {@link STEP_SECTIONS} order, each in the plan's order. */
export function stepSections<T extends Pick<PlanItem, 'id' | 'position'>>(items: readonly T[], toneOf: (item: T) => GraphTone): { readonly section: StepSection; readonly items: readonly T[] }[] {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  return STEP_SECTIONS.map((section) => ({ section, items: sorted.filter((item) => sectionOf(toneOf(item)) === section) })).filter((group) => group.items.length > 0);
}

/** How the Steps list groups: by state (the default) or by repository lane. */
export const STEPS_GROUPINGS = ['state', 'repo'] as const;
/** One of {@link STEPS_GROUPINGS}. */
export type StepsGrouping = (typeof STEPS_GROUPINGS)[number];

/** The remembered grouping, checked (anything else = by state). */
export function readStepsGrouping(stored: string | null): StepsGrouping {
  return stored === 'repo' ? 'repo' : 'state';
}

/** The tone of a board column (its header's mini ring and count). */
export const COLUMN_TONE: Readonly<Record<BoardColumn, GraphTone>> = { needs: 'needs', working: 'working', ready: 'approval', done: 'done' };

/**
 * A board column's cards: the plan's order, except the Working column puts its working steps
 * before the ready and waiting ones that share it (what moves first reads first).
 */
export function columnOrder<T extends Pick<PlanItem, 'position'>>(items: readonly T[], toneOf: (item: T) => GraphTone): T[] {
  const rank = (item: T): number => {
    const tone = toneOf(item);
    return tone === 'working' ? 0 : tone === 'ready' ? 1 : tone === 'waiting' ? 2 : 0;
  };
  return [...items].sort((a, b) => rank(a) - rank(b) || a.position - b.position);
}

// ── lanes, chips ────────────────────────────────────────────────────────

/** The lanes in the Graph's order: the plan's repositories, then the rest by name, the neutral lane last. */
export function laneOrder(items: readonly Pick<PlanItem, 'solutions'>[], repos: readonly string[]): string[] {
  const present = new Set(items.map(laneOf));
  const known = repos.filter((repo) => present.has(repo));
  const rest = [...present].filter((key) => key !== SEVERAL_LANE && !known.includes(key)).sort();
  return [...new Set([...known, ...rest]), ...(present.has(SEVERAL_LANE) ? [SEVERAL_LANE] : [])];
}

/**
 * Each repository's hue, as the Graph colours it (`projectGraphLayout`'s lane hue, else the chip's
 * fallback): with two lanes or more, a lane's place among the repository lanes; with one, the
 * repository's place among all of the plan's repositories. `-1` = the neutral lane.
 */
export function laneHues(items: readonly Pick<PlanItem, 'solutions'>[], repos: readonly string[]): (repo: string) => number {
  const lanes = laneOrder(items, repos);
  const banded = lanes.length >= 2;
  const real = lanes.filter((key) => key !== SEVERAL_LANE);
  const all = [...new Set([...repos, ...items.flatMap((item) => item.solutions)])];
  const order = [...new Set([...repos.filter((repo) => all.includes(repo)), ...all.filter((repo) => !repos.includes(repo)).sort()])];
  return (repo: string): number => {
    if (repo === SEVERAL_LANE) return -1;
    if (banded && real.includes(repo)) return real.indexOf(repo);
    return order.indexOf(repo);
  };
}

/** A step's repository chip. */
export type RepoChip = { readonly text: string; readonly hue: number } | null;

/** The chips of a plan's steps: the short name in its lane's hue; "N repos" (neutral) for several; `null` for none. */
export function repoChips(items: readonly Pick<PlanItem, 'solutions'>[], repos: readonly string[]): (item: Pick<PlanItem, 'solutions'>) => RepoChip {
  const all = [...new Set([...repos, ...items.flatMap((other) => other.solutions)])];
  const short = shortRepoNames(all);
  const hue = laneHues(items, repos);
  return (item) => {
    if (item.solutions.length > 1) return { text: GRAPH_WORDS.repos(item.solutions.length), hue: -1 };
    const repo = laneOf(item);
    if (!repo) return null;
    return { text: short.get(repo) ?? repo, hue: hue(repo) };
  };
}

/** One repository lane of a list (the Steps list by repository, the Timeline): its steps in the plan's order and its progress. */
export interface RepoLane<T> {
  readonly key: string;
  readonly label: string;
  readonly hue: number;
  readonly items: readonly T[];
  readonly done: number;
}

/** The steps by repository lane, in the Graph's lane order. */
export function repoLanes<T extends Pick<PlanItem, 'id' | 'position' | 'solutions' | 'state'>>(items: readonly T[], repos: readonly string[]): RepoLane<T>[] {
  const hue = laneHues(items, repos);
  const sorted = [...items].sort((a, b) => a.position - b.position);
  return laneOrder(items, repos).map((key) => {
    const members = sorted.filter((item) => laneOf(item) === key);
    return { key, label: laneLabel(key), hue: hue(key), items: members, done: members.filter((item) => item.state === 'done').length };
  });
}

// ── a step's words ──────────────────────────────────────────────────────

/**
 * The meta line of a step (the Graph card's): "Working · 25m", what a waiting step waits on, a
 * stopped step's "— open to restart", "Done · 38m"; else the state's word.
 */
export function stepMeta(item: PlanItem, look: StepLook, tone: GraphTone, now: number): string {
  const elapsed = elapsedMinutes(item, now);
  if (tone === 'working' && elapsed !== null) return `${look.label} · ${durationShort(elapsed)}`;
  if (look.kind === 'waiting') return look.detail ?? look.label;
  if (look.kind === 'stopped' && item.stoppedBy !== undefined) return `${item.stoppedBy === 'account' ? PROJECT_WORDS.stoppedAccount : STATUS.stopped.label} — ${GRAPH_WORDS.openToRestart}`;
  if (tone === 'done' && item.actualMinutes !== null) return `${look.label} · ${durationShort(item.actualMinutes)}`;
  return look.label;
}

/** The estimate bar's value (working steps with an estimate): the time so far against it, 0…0.95; `null` = no bar. */
export function estimateBar(item: Pick<PlanItem, 'state' | 'estimateMinutes' | 'startedAt' | 'actualMinutes'>, tone: GraphTone, now: number): number | null {
  if (tone !== 'working' || item.estimateMinutes === null || elapsedMinutes(item, now) === null) return null;
  return stepProgress(item, now);
}

/** The critical path's steps and edges (the Graph's `remainingCriticalPath`), or nothing while it is switched off. */
export function criticalMarks(on: boolean, items: Parameters<typeof remainingCriticalPath>[0], edges: readonly PlanEdge[], now: number): { readonly ids: ReadonlySet<string>; readonly edges: ReadonlySet<string> } {
  if (!on) return { ids: new Set(), edges: new Set() };
  const path = remainingCriticalPath(items, edges, now);
  return { ids: new Set(path.ids), edges: path.edges };
}

// ── the timeline ────────────────────────────────────────────────────────

/** The timeline's sizes (px). */
export const TIMELINE = {
  /** The names column. */
  nameWidth: 264,
  nameWidthNarrow: 200,
  laneHead: 34,
  row: 40,
  laneGap: 10,
  /** The bar's height inside a row. */
  bar: 16,
} as const;

/** A row's bar: where the step's own time starts (after the wait for its dependencies) and ends. */
export function barSpan(segments: TimelineRow['segments']): { readonly from: number; readonly to: number; readonly waitFrom: number | null } | null {
  if (segments.length === 0) return null;
  const own = segments.filter((segment) => segment.kind !== 'dependency');
  const waits = segments.filter((segment) => segment.kind === 'dependency');
  const to = Math.max(...segments.map((segment) => segment.to));
  if (own.length === 0) return { from: Math.min(...waits.map((segment) => segment.from)), to, waitFrom: null };
  const from = Math.min(...own.map((segment) => segment.from));
  const before = waits.filter((segment) => segment.from < from);
  return { from, to, waitFrom: before.length > 0 ? Math.min(...before.map((segment) => segment.from)) : null };
}

/** One timeline lane: its rows (the core's timeline rows, regrouped by the Graph's lanes). */
export interface TimelineLane {
  readonly key: string;
  readonly label: string;
  readonly hue: number;
  readonly done: number;
  readonly rows: readonly TimelineRow[];
  /** The lane's top inside the chart (px). */
  readonly top: number;
}

/** The timeline's lanes and each row's middle (px from the chart's top): the Graph's lanes and order. */
export function timelineLanes(view: Pick<Timeline, 'groups'>, items: readonly PlanItem[], repos: readonly string[]): { readonly lanes: readonly TimelineLane[]; readonly rowY: ReadonlyMap<string, number>; readonly height: number } {
  const rows = new Map(view.groups.flatMap((group) => group.rows.map((row) => [row.itemId, row] as const)));
  const T = TIMELINE;
  const lanes: TimelineLane[] = [];
  const rowY = new Map<string, number>();
  let top = 0;
  for (const lane of repoLanes(
    items.filter((item) => rows.has(item.id)),
    repos,
  )) {
    if (lane.items.length === 0) continue;
    const laneRows = lane.items.map((item) => rows.get(item.id) as TimelineRow);
    laneRows.forEach((row, index) => rowY.set(row.itemId, top + T.laneHead + index * T.row + T.row / 2));
    lanes.push({ key: lane.key, label: lane.label, hue: lane.hue, done: lane.done, rows: laneRows, top });
    top += T.laneHead + laneRows.length * T.row + T.laneGap;
  }
  return { lanes, rowY, height: Math.max(0, top - T.laneGap) };
}

/** A dependency arrow on the timeline: from the end of a step's bar to the start of the bar that waits on it. */
export interface TimelineArrow {
  readonly key: string;
  readonly from: string;
  readonly to: string;
  readonly path: string;
  readonly x1: number;
  readonly x2: number;
}

/** The arrows (px on a track `width` wide): the plan's edges between rows that have bars. */
export function timelineArrows(edges: readonly PlanEdge[], spans: ReadonlyMap<string, { readonly from: number; readonly to: number }>, rowY: ReadonlyMap<string, number>, axis: Pick<Timeline, 'start' | 'end'>, width: number, gap = 4): TimelineArrow[] {
  const x = (at: number): number => Math.max(0, Math.min(width, ((at - axis.start) / Math.max(1, axis.end - axis.start)) * width));
  const out: TimelineArrow[] = [];
  for (const edge of edges) {
    const a = spans.get(edge.from);
    const b = spans.get(edge.to);
    const ya = rowY.get(edge.from);
    const yb = rowY.get(edge.to);
    if (!a || !b || ya === undefined || yb === undefined || edge.from === edge.to) continue;
    const x1 = x(a.to);
    const x2 = Math.max(0, x(b.from) - gap);
    out.push({ key: `${edge.from}>${edge.to}`, from: edge.from, to: edge.to, path: curve(x1, ya, x2, yb), x1, x2 });
  }
  return out;
}
