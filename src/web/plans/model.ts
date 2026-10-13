import { type Plan, type PlanEdge, type PlanItem, type PlanItemState, type PlanMergeMode, DEFAULT_ITEM_MINUTES, findCycle } from '../../core/plans.ts';

/**
 * D99 · the Plans page's pure rules (`docs/plans-ui.md` → *The Plans page*), kept free of React
 * so `tests/web/plans.test.ts` checks them: the look of an item's state, its status line, the
 * graph's layout (layers by the longest path, no layout dependency), the critical path's
 * edges, the header chips, the timeline's segments and summary, the detail's texts and the
 * dependency editor's hints.
 */

// ── the look of a state ───────────────────────────────────────────────────

/** How an item state shows: its icon, its colour (a CSS value) and its word. */
export interface StateLook {
  readonly icon: string;
  readonly color: string;
  readonly word: string;
}

/** The violet of an item in review (the approved design; not a SPEC token). */
export const REVIEW_COLOR = 'oklch(0.75 0.12 310)';

/** Per state: icon, colour, word (the approved design's table). */
export const STATE_LOOK: Readonly<Record<PlanItemState, StateLook>> = {
  waiting: { icon: '○', color: 'var(--status-idle)', word: 'waiting' },
  ready: { icon: '◌', color: 'var(--muted-1)', word: 'ready' },
  running: { icon: '●', color: 'var(--status-run)', word: 'running' },
  question: { icon: '?', color: 'var(--status-need)', word: 'question' },
  review: { icon: '◐', color: REVIEW_COLOR, word: 'in review' },
  done: { icon: '✔', color: 'var(--status-done)', word: 'done' },
  blocked: { icon: '✖', color: 'var(--status-fail)', word: 'blocked' },
};

/**
 * An item's short label: the number of its key when every keyed item of the plan shares one
 * project prefix (`PROJ-3157` → `3157`, as the design shows), its full key otherwise, its
 * title (cut at 24 characters) without a key.
 */
export function shortLabel(item: Pick<PlanItem, 'key' | 'title'>, items: readonly Pick<PlanItem, 'key'>[]): string {
  if (item.key) {
    const prefixes = new Set(items.map((other) => other.key?.split('-')[0]).filter((prefix): prefix is string => prefix !== undefined));
    return prefixes.size === 1 ? (item.key.split('-')[1] ?? item.key) : item.key;
  }
  return item.title.length > 24 ? `${item.title.slice(0, 23)}…` : item.title;
}

/** The status line under a card's title ("waiting on 3157", "running", "needs your answer", …). */
export function statusLine(item: PlanItem, items: readonly PlanItem[]): string {
  switch (item.state) {
    case 'waiting': {
      const open = item.dependsOn.map((id) => items.find((other) => other.id === id)).filter((dep): dep is PlanItem => dep !== undefined && dep.state !== 'done');
      return open.length > 0 ? `waiting on ${open.map((dep) => shortLabel(dep, items)).join(', ')}` : 'waiting';
    }
    case 'ready':
      return 'ready';
    case 'running':
      return item.waitingOn === 'checks' ? 'running · checks' : 'running';
    case 'question':
      return 'needs your answer';
    case 'review':
      return 'in review';
    case 'done':
      return 'done · merged';
    case 'blocked':
      return 'blocked';
  }
}

/** The repo and estimate line of a card: `acme · ~45m` (`all repos` without solutions; `~?` without an estimate). */
export function repoLine(item: Pick<PlanItem, 'solutions' | 'estimateMinutes'>, plan: Pick<Plan, 'repos'>): string {
  const repo = item.solutions.length > 0 ? item.solutions.join(', ') : plan.repos.length === 1 ? (plan.repos[0] as string) : 'all repos';
  return `${repo} · ${item.estimateMinutes === null ? '~?' : `~${durationShort(item.estimateMinutes)}`}`;
}

/** Minutes as `45m`, `3h`, `2.5h`, `12h`, `2d 3h`. */
export function durationShort(minutes: number): string {
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))}m`;
  const hours = minutes / 60;
  if (hours < 10) return `${Number(hours.toFixed(1)).toString()}h`;
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${Math.round(hours - days * 24)}h`;
}

// ── header ────────────────────────────────────────────────────────────────

/** "4/7 done". */
export function progressText(plan: Pick<Plan, 'progress'>): string {
  return `${plan.progress.done}/${plan.progress.total} done`;
}

/** "~3h left", `null` when the core gives no estimate (an item blocked, nothing left). */
export function timeLeftText(plan: Pick<Plan, 'estimatedMinutesLeft'>): string | null {
  return plan.estimatedMinutesLeft === null ? null : `~${durationShort(plan.estimatedMinutesLeft)} left`;
}

/** The merge-mode chip: "Merge: agents · hold ⚑ 3165", "Merge: I merge each one", "Merge mode: not chosen yet". */
export function mergeModeChip(plan: Pick<Plan, 'mergeMode' | 'items'>): string {
  switch (plan.mergeMode) {
    case null:
      return 'Merge mode: not chosen yet';
    case 'developer':
      return 'Merge: I merge each one';
    case 'agents':
      return 'Merge: agents';
    case 'agents-with-holds': {
      const holds = plan.items.filter((item) => item.hold).map((item) => shortLabel(item, plan.items));
      return holds.length > 0 ? `Merge: agents · hold ⚑ ${holds.join(', ')}` : 'Merge: agents · no holds';
    }
  }
}

/** The limits chip: "3 at once · 85 %". */
export function limitsChip(plan: Pick<Plan, 'maxConcurrency' | 'usageThreshold'>): string {
  return `${plan.maxConcurrency} at once · ${plan.usageThreshold} %`;
}

/** The target chip: "⎇ epic/x → dev". */
export function targetChip(plan: Pick<Plan, 'targetBranch' | 'baseBranch'>): string {
  return `⎇ ${plan.targetBranch} → ${plan.baseBranch}`;
}

/** The final node's text: "epic → dev · yours". */
export function finalNodeText(plan: Pick<Plan, 'targetBranch' | 'baseBranch'>): string {
  return `${plan.targetBranch} → ${plan.baseBranch} · yours`;
}

/**
 * A plan's state word for the list and the header: "running", "paused", "paused · Plans was
 * switched off" (the core's `pausedReason`), "running · held: <why>" (usage), "draft", "done", ….
 */
export function planStateText(plan: Pick<Plan, 'state' | 'held' | 'pausedReason'>): string {
  if (plan.state === 'paused') return plan.pausedReason ? `paused · ${plan.pausedReason}` : 'paused';
  if (plan.state === 'running' && plan.held) return `running · held: ${plan.held}`;
  return plan.state;
}

/** How many plans run now (the nav's badge). */
export function runningCount(plans: readonly Pick<Plan, 'state'>[]): number {
  return plans.filter((plan) => plan.state === 'running').length;
}

// ── the graph ─────────────────────────────────────────────────────────────

/** Card size and gaps of the graph (px). */
export const GRAPH = { cardWidth: 190, cardHeight: 86, gapX: 48, gapY: 18, pad: 16 } as const;

/** One card's place. */
export interface GraphNode {
  readonly id: string;
  readonly layer: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
}

/** The graph's layout: the cards, the final node, the size. */
export interface GraphLayout {
  readonly nodes: readonly GraphNode[];
  readonly final: { readonly x: number; readonly y: number; readonly layer: number };
  /** The items without dependents (they lead into the final node). */
  readonly sinks: readonly string[];
  readonly width: number;
  readonly height: number;
}

/**
 * Layers by the longest path (an item sits one layer right of its furthest dependency; items
 * without dependencies in layer 0), ordered inside a layer by the mean row of their
 * dependencies (one barycentre pass), ties by plan position. The final ◇ node sits one layer
 * after the last, at the vertical middle. A cycle (never stored: the server refuses one) puts
 * the rest in the last layer rather than looping.
 */
export function graphLayout(items: readonly Pick<PlanItem, 'id' | 'position'>[], edges: readonly PlanEdge[]): GraphLayout {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const ids = new Set(sorted.map((item) => item.id));
  const deps = new Map<string, string[]>(sorted.map((item) => [item.id, []]));
  for (const edge of edges) if (ids.has(edge.from) && ids.has(edge.to)) deps.get(edge.to)?.push(edge.from);
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = Math.max(-1, ...(deps.get(id) ?? []).map(layerOf)) + 1;
    visiting.delete(id);
    layer.set(id, value);
    return value;
  };
  for (const item of sorted) layerOf(item.id);
  const layers: string[][] = [];
  for (const item of sorted) {
    const at = layer.get(item.id) ?? 0;
    (layers[at] ??= []).push(item.id);
  }
  const row = new Map<string, number>();
  layers.forEach((ids, index) => {
    if (index > 0) {
      const weight = (id: string): number => {
        const rows = (deps.get(id) ?? []).map((dep) => row.get(dep)).filter((value): value is number => value !== undefined);
        return rows.length === 0 ? Number.POSITIVE_INFINITY : rows.reduce((sum, value) => sum + value, 0) / rows.length;
      };
      const position = new Map(sorted.map((item, i) => [item.id, i]));
      ids.sort((a, b) => weight(a) - weight(b) || (position.get(a) ?? 0) - (position.get(b) ?? 0));
    }
    ids.forEach((id, index2) => row.set(id, index2));
  });
  const rows = Math.max(1, ...layers.map((ids) => ids?.length ?? 0));
  const columnHeight = rows * GRAPH.cardHeight + (rows - 1) * GRAPH.gapY;
  const nodes: GraphNode[] = [];
  layers.forEach((ids, at) => {
    const height = ids.length * GRAPH.cardHeight + (ids.length - 1) * GRAPH.gapY;
    const top = GRAPH.pad + (columnHeight - height) / 2;
    ids.forEach((id, index) => nodes.push({ id, layer: at, row: index, x: GRAPH.pad + at * (GRAPH.cardWidth + GRAPH.gapX), y: top + index * (GRAPH.cardHeight + GRAPH.gapY) }));
  });
  const finalLayer = layers.length;
  const hasDependents = new Set(edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).map((edge) => edge.from));
  return {
    nodes,
    final: { layer: finalLayer, x: GRAPH.pad + finalLayer * (GRAPH.cardWidth + GRAPH.gapX), y: GRAPH.pad + (columnHeight - GRAPH.cardHeight) / 2 },
    sinks: sorted.map((item) => item.id).filter((id) => !hasDependents.has(id)),
    width: GRAPH.pad * 2 + (finalLayer + 1) * GRAPH.cardWidth + finalLayer * GRAPH.gapX,
    height: GRAPH.pad * 2 + columnHeight,
  };
}

/** An SVG path from the right middle of a box at (x1, y1) to the left middle of one at (x2, y2): a horizontal S curve. */
export function edgePath(from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }): string {
  const sx = from.x + GRAPH.cardWidth;
  const sy = from.y + GRAPH.cardHeight / 2;
  const ex = to.x - 4;
  const ey = to.y + GRAPH.cardHeight / 2;
  const bend = Math.max(24, (ex - sx) / 2);
  return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${ex - bend} ${ey}, ${ex} ${ey}`;
}

/** The critical path's edges as `from>to` keys (consecutive items of `criticalPath.itemIds`). */
export function criticalEdgeKeys(plan: Pick<Plan, 'criticalPath'>): ReadonlySet<string> {
  const ids = plan.criticalPath.itemIds;
  const keys = new Set<string>();
  for (let index = 1; index < ids.length; index += 1) keys.add(`${ids[index - 1]}>${ids[index]}`);
  return keys;
}

// ── dependency editing ────────────────────────────────────────────────────

/** The hint line of the dependency editor: before the first click, and after it. */
export function editHint(first: Pick<PlanItem, 'key' | 'title'> | null, items: readonly Pick<PlanItem, 'key'>[]): string {
  return first ? `Now click the ticket that depends on ${shortLabel(first, items)}… (click a dependency's arrow to remove it)` : 'Click the ticket that must finish first. (Click an arrow to remove that dependency.)';
}

/**
 * The editor's check before "`to` after `from`" is sent: `null` when it may be added, else the
 * toast's text: "Refused: X already waits on Y — that would be a loop".
 */
export function refuseEdge(plan: Pick<Plan, 'items' | 'edges'>, from: string, to: string): string | null {
  const a = plan.items.find((item) => item.id === from);
  const b = plan.items.find((item) => item.id === to);
  if (!a || !b) return 'Refused: that ticket is not in the plan';
  if (from === to) return 'Refused: a ticket cannot wait on itself';
  if (plan.edges.some((edge) => edge.from === from && edge.to === to)) return `Refused: ${shortLabel(b, plan.items)} already waits on ${shortLabel(a, plan.items)}`;
  return findCycle(plan.edges, from, to) ? `Refused: ${shortLabel(a, plan.items)} already waits on ${shortLabel(b, plan.items)} — that would be a loop` : null;
}

/** Whether the dependencies may be edited (a draft, or a plan that runs or is paused). */
export function canEditDependencies(plan: Pick<Plan, 'state' | 'machine'>): boolean {
  return plan.machine === null && (plan.state === 'draft' || plan.state === 'running' || plan.state === 'paused');
}

// ── the detail ────────────────────────────────────────────────────────────

/** A waiting item's line: "Starts by itself when 3157 and 3160 are done." */
export function waitingText(item: PlanItem, items: readonly PlanItem[]): string {
  const open = item.dependsOn.map((id) => items.find((other) => other.id === id)).filter((dep): dep is PlanItem => dep !== undefined && dep.state !== 'done');
  if (open.length === 0) return 'Starts by itself when a slot is free.';
  const names = open.map((dep) => shortLabel(dep, items));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Starts by itself when ${list} ${names.length === 1 ? 'is' : 'are'} done.`;
}

/** A done item's line: "Merged into <target> · checks ✔". */
export function doneText(item: Pick<PlanItem, 'checks' | 'note'>, plan: Pick<Plan, 'targetBranch'>): string {
  const checks = item.checks === null || item.checks.state === 'green' || item.checks.state === 'none' ? 'checks ✔' : item.checks.state === 'red' ? 'checks ✖' : 'checks …';
  return `Merged into ${plan.targetBranch} · ${checks}`;
}

/** The worktree name shown in the detail (the run branch), `—` before it starts. */
export function worktreeName(item: Pick<PlanItem, 'branch'>): string {
  return item.branch ?? '—';
}

// ── the merge-mode dialog ─────────────────────────────────────────────────

/** One option of the dialog. */
export interface MergeModeOption {
  readonly mode: PlanMergeMode;
  readonly title: string;
  readonly text: string;
  readonly recommended: boolean;
}

/** The dialog's three options, in the design's order. */
export const MERGE_MODE_OPTIONS: readonly MergeModeOption[] = [
  { mode: 'agents', title: 'Agents merge', text: "A ticket counts as done when its agent has merged it with green checks. Review cards don't block.", recommended: false },
  { mode: 'agents-with-holds', title: 'Agents merge, with hold points', text: 'The same, except the tickets you tick below wait for your Merge on their Review card.', recommended: true },
  { mode: 'developer', title: 'I merge each one', text: 'Every ticket waits for your Merge on its Review card.', recommended: false },
];

/** The dialog's footer note. */
export function alwaysOnNote(plan: Pick<Plan, 'targetBranch'>): string {
  return `Always on: agents merge only into ${plan.targetBranch} — never dev or master · checks must be green · a second conflict comes to your Inbox.`;
}

// ── the timeline ──────────────────────────────────────────────────────────

/** A timeline segment's kind (the design's legend). */
export type SegmentKind = 'working' | 'you' | 'dependency' | 'usage' | 'projected';

/** One bar segment (epoch ms). */
export interface Segment {
  readonly kind: SegmentKind;
  readonly from: number;
  readonly to: number;
  /** What the developer waited on (`you` segments): `review`, `question`, `conflict`. */
  readonly on?: string;
}

/** One row of the timeline. */
export interface TimelineRow {
  readonly itemId: string;
  readonly repo: string;
  readonly segments: readonly Segment[];
}

/** The whole timeline: rows grouped by repository, the axis' span and the summary line's parts. */
export interface Timeline {
  readonly groups: readonly { readonly repo: string; readonly rows: readonly TimelineRow[] }[];
  readonly start: number;
  readonly end: number;
  readonly now: number;
  /** Hours the developer was waited on, and hours of all the items' work so far. */
  readonly youHours: number;
  readonly totalHours: number;
  /** The longest wait on the developer: its item id, kind and hours; `null` when none. */
  readonly longest: { readonly itemId: string; readonly on: string; readonly hours: number } | null;
  /** When the last projected bar ends (epoch ms); `null` when everything is done. */
  readonly projectedFinish: number | null;
}

const MINUTE = 60_000;

function parse(value: string | null): number | null {
  if (value === null) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/** What a running item waits on that is the developer's: a question, a review, a conflict sent to the Inbox. */
function waitsOnYou(item: PlanItem): string | null {
  if (item.state === 'question') return 'question';
  if (item.state === 'review') return 'review';
  if (item.waitingOn === 'question' || item.waitingOn === 'review' || item.waitingOn === 'conflict') return item.waitingOn;
  return null;
}

/**
 * The timeline (`docs/plans-ui.md` → *Timeline*), from the items' timestamps (`startedAt`,
 * `waitingSince`, `mergedAt`, `doneAt`) and the plan's: before an item starts it waits on a
 * dependency (hatched; from the plan's start); from its start the agent works (run blue) until
 * it waits on the developer (`waitingSince` of a question, review or conflict: amber) or is
 * done; while the plan is held for usage a ready item's wait shows red from the hold's best
 * known start (the latest of the plan's start and its dependencies' ends); what is left is
 * projected (dashed): each open item after the projected end of its dependencies, for its
 * estimate (a running one for what is left of it), not before now. Only the current wait on
 * the developer is known per item: the core keeps no history of earlier ones (ASSUMED,
 * `.loop/questions.md` → *D99-UI*).
 */
export function timeline(plan: Plan, now: number): Timeline {
  const origin = parse(plan.startedAt) ?? parse(plan.createdAt) ?? now;
  const byId = new Map(plan.items.map((item) => [item.id, item]));
  const projectedEnd = new Map<string, number>();
  const ordered = topo(plan.items, plan.edges);
  const rows = new Map<string, TimelineRow>();
  let youMs = 0;
  let totalMs = 0;
  let longest: Timeline['longest'] = null;
  let projectedFinish: number | null = null;
  const heldForUsage = plan.state === 'running' && plan.held !== null;
  for (const item of ordered) {
    const segments: Segment[] = [];
    const started = parse(item.startedAt);
    const ended = parse(item.doneAt) ?? parse(item.mergedAt);
    const depsEnd = Math.max(origin, ...item.dependsOn.map((dep) => projectedEnd.get(dep) ?? origin));
    if (started !== null) {
      if (started > origin) segments.push({ kind: 'dependency', from: origin, to: started });
      const waitFrom = parse(item.waitingSince);
      const on = waitsOnYou(item);
      const workEnd = ended ?? (on !== null && waitFrom !== null ? waitFrom : now);
      if (workEnd > started) segments.push({ kind: 'working', from: started, to: workEnd });
      if (ended === null && on !== null) {
        const from = waitFrom ?? workEnd;
        segments.push({ kind: 'you', from, to: now, on });
        youMs += now - from;
        if (!longest || (now - from) / 3_600_000 > longest.hours) longest = { itemId: item.id, on, hours: (now - from) / 3_600_000 };
      }
      totalMs += (ended ?? now) - started;
      if (ended !== null) projectedEnd.set(item.id, ended);
      else if (item.state === 'blocked') projectedEnd.set(item.id, now);
      else {
        const estimate = item.estimateMinutes ?? DEFAULT_ITEM_MINUTES;
        const left = Math.max(estimate * MINUTE - (now - started), MINUTE);
        const end = now + left;
        segments.push({ kind: 'projected', from: now, to: end });
        projectedEnd.set(item.id, end);
        projectedFinish = Math.max(projectedFinish ?? 0, end);
      }
    } else if (item.state === 'blocked') {
      projectedEnd.set(item.id, depsEnd);
      if (now > origin) segments.push({ kind: 'dependency', from: origin, to: now });
    } else {
      if (plan.state !== 'draft' && now > origin) {
        const waitEnd = Math.min(now, Math.max(origin, depsEnd));
        if (waitEnd > origin) segments.push({ kind: 'dependency', from: origin, to: waitEnd });
        if (item.state === 'ready' && heldForUsage && now > waitEnd) segments.push({ kind: 'usage', from: waitEnd, to: now });
        else if (now > waitEnd) segments.push({ kind: 'dependency', from: waitEnd, to: now });
      }
      const from = Math.max(now, depsEnd);
      const end = from + (item.estimateMinutes ?? DEFAULT_ITEM_MINUTES) * MINUTE;
      segments.push({ kind: 'projected', from, to: end });
      projectedEnd.set(item.id, end);
      projectedFinish = Math.max(projectedFinish ?? 0, end);
    }
    const repo = item.solutions.length > 0 ? (item.solutions[0] as string) : plan.repos.length === 1 ? (plan.repos[0] as string) : 'all repos';
    rows.set(item.id, { itemId: item.id, repo, segments });
  }
  const groups: { repo: string; rows: TimelineRow[] }[] = [];
  for (const item of [...plan.items].sort((a, b) => a.position - b.position)) {
    const row = rows.get(item.id);
    if (!row || !byId.has(item.id)) continue;
    let group = groups.find((candidate) => candidate.repo === row.repo);
    if (!group) {
      group = { repo: row.repo, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  const ends = [...rows.values()].flatMap((row) => row.segments.map((segment) => segment.to));
  return {
    groups,
    start: origin,
    end: Math.max(now, ...ends, origin + 60 * MINUTE),
    now,
    youHours: youMs / 3_600_000,
    totalHours: totalMs / 3_600_000,
    longest,
    projectedFinish,
  };
}

function topo(items: readonly PlanItem[], edges: readonly PlanEdge[]): PlanItem[] {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const done = new Set<string>();
  const out: PlanItem[] = [];
  let guard = 0;
  while (out.length < sorted.length && guard < sorted.length + 1) {
    guard += 1;
    for (const item of sorted) {
      if (done.has(item.id)) continue;
      const deps = edges.filter((edge) => edge.to === item.id).map((edge) => edge.from);
      if (deps.every((dep) => done.has(dep) || !sorted.some((other) => other.id === dep))) {
        done.add(item.id);
        out.push(item);
      }
    }
  }
  for (const item of sorted) if (!done.has(item.id)) out.push(item);
  return out;
}

/** Hours with one decimal ("8.6"), whole hours without (`3`). */
function hoursText(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** "today 18:20", "tomorrow 07:30", else "Thu 15 Oct 09:00" (local time). */
export function finishText(at: number, now: number): string {
  const when = new Date(at);
  const today = new Date(now);
  const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  const day = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((day(when) - day(today)) / 86_400_000);
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `tomorrow ${time}`;
  return `${when.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

/** The summary line: "Waiting on you: 8.6 h of 24 · longest: 3165 review (3 h) · Projected finish: tomorrow 07:30". */
export function timelineSummary(view: Timeline, plan: Pick<Plan, 'items'>): string {
  const parts = [`Waiting on you: ${hoursText(view.youHours)} h of ${hoursText(view.totalHours)}`];
  if (view.longest) {
    const item = plan.items.find((candidate) => candidate.id === view.longest?.itemId);
    parts.push(`longest: ${item ? shortLabel(item, plan.items) : '?'} ${view.longest.on} (${hoursText(view.longest.hours)} h)`);
  }
  parts.push(view.projectedFinish === null ? 'Finished' : `Projected finish: ${finishText(view.projectedFinish, view.now)}`);
  return parts.join(' · ');
}

/** The x of a time on an axis `width` px wide. */
export function timeX(at: number, view: Pick<Timeline, 'start' | 'end'>, width: number): number {
  const span = Math.max(1, view.end - view.start);
  return Math.max(0, Math.min(width, ((at - view.start) / span) * width));
}

/** The axis' ticks: every hour when the span is short, else every 3 / 6 / 12 / 24 h (at most ~12 ticks). */
export function axisTicks(view: Pick<Timeline, 'start' | 'end'>): number[] {
  const hours = (view.end - view.start) / 3_600_000;
  const step = [1, 2, 3, 6, 12, 24, 48].find((candidate) => hours / candidate <= 12) ?? 96;
  const first = Math.ceil(view.start / (step * 3_600_000)) * step * 3_600_000;
  const ticks: number[] = [];
  for (let at = first; at <= view.end; at += step * 3_600_000) ticks.push(at);
  return ticks;
}

/** Whether an item offers an inline action in the List view: `answer` (a question), `merge` (a review), else none. */
export function inlineAction(item: Pick<PlanItem, 'state'>): 'answer' | 'merge' | null {
  return item.state === 'question' ? 'answer' : item.state === 'review' ? 'merge' : null;
}
