import { DEFAULT_ITEM_MINUTES, type PlanEdge, type PlanItem } from '../../../core/plans.ts';
import { GRAPH_WORDS } from '../glossary.ts';

/**
 * v2 Project graph (Fixes after 2.0 → *The Project graph, redrawn*): the pure layout, DOM-free and
 * unit-tested in `tests/web/v2-project-graph.test.ts`. Left → right by dependency depth (an item one
 * layer right of its furthest dependency), repository lanes (a step with exactly one repository sits
 * in that repository's lane; several or none: the neutral lane), barycentre sweeps that keep the
 * order with the fewest crossings, fixed card size, a final node after the last layer. Every edge
 * is a cubic curve from a card's right side to the next card's left side, so it never leaves the
 * box of its two ends (and so never the canvas).
 */

/** The sizes of the graph at 100 % (px). */
export const PROJECT_GRAPH = {
  cardWidth: 236,
  cardHeight: 104,
  gapX: 92,
  gapY: 20,
  pad: 24,
  /** The lane's top band that carries its badge, name and progress. */
  laneHead: 40,
  laneFoot: 16,
  laneGap: 18,
  finalWidth: 132,
  finalHeight: 104,
  /** Space between an edge's end and the card it points to (the arrowhead). */
  arrowGap: 7,
} as const;

/** The key of the neutral lane (steps with several repositories or none). */
export const SEVERAL_LANE = '';

/** One card's place. */
export interface ProjectGraphNode {
  readonly id: string;
  readonly layer: number;
  readonly lane: string;
  readonly x: number;
  readonly y: number;
}

/** One lane: a tinted band across the graph with its repository's name. */
export interface ProjectGraphLane {
  readonly key: string;
  readonly label: string;
  /** The lane's colour: its place among the repositories in the plan's order (stable whatever order the lanes are drawn in); `-1` = the neutral lane. */
  readonly hue: number;
  readonly top: number;
  readonly height: number;
}

/** One edge (a dependency, or a last step into the final node). */
export interface ProjectGraphEdge {
  /** `from>to`; `from>final` for the final node's edges. */
  readonly key: string;
  readonly from: string;
  /** An item id, or `final`. */
  readonly to: string;
  readonly path: string;
  readonly toFinal: boolean;
  /** The curve's end points (the crossing count and the bounds tests use them). */
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

/** The graph's layout. */
export interface ProjectGraphLayout {
  readonly nodes: readonly ProjectGraphNode[];
  /** Empty when the steps do not spread over at least two lanes (no bands then). */
  readonly lanes: readonly ProjectGraphLane[];
  readonly edges: readonly ProjectGraphEdge[];
  readonly final: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly sinks: readonly string[];
  readonly layers: number;
  readonly width: number;
  readonly height: number;
}

type LayoutItem = Pick<PlanItem, 'id' | 'position' | 'solutions'>;

/** A repository's display name: its last path segment (`microfrontends/web-front` → `web-front`). */
export function repoName(repo: string): string {
  const parts = repo.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? repo;
}

/**
 * The short repository names for the cards' chips: the plan's repositories without the words they
 * all start with (`acme-api`, `acme-web` → `api`, `web`); a name that would be empty stays whole.
 */
export function shortRepoNames(repos: readonly string[]): ReadonlyMap<string, string> {
  const names = [...new Set(repos)].map((repo) => [repo, repoName(repo)] as const);
  const out = new Map<string, string>();
  if (names.length < 2) {
    for (const [repo, name] of names) out.set(repo, name);
    return out;
  }
  const words = names.map(([, name]) => name.split('-'));
  let common = 0;
  const first = words[0] ?? [];
  while (common < first.length - 1 && words.every((list) => list.length - 1 > common && list[common] === first[common])) common += 1;
  names.forEach(([repo, name], index) => out.set(repo, common > 0 ? (words[index] ?? []).slice(common).join('-') || name : name));
  return out;
}

/** The lane a step sits in: its one repository, else {@link SEVERAL_LANE}. */
export function laneOf(item: Pick<PlanItem, 'solutions'>): string {
  return item.solutions.length === 1 ? (item.solutions[0] ?? SEVERAL_LANE) : SEVERAL_LANE;
}

/** The label of a lane. */
export function laneLabel(key: string): string {
  return key === SEVERAL_LANE ? GRAPH_WORDS.severalRepos : repoName(key);
}

/** The cubic curve from (sx, sy) to (ex, ey): control points at the horizontal middle, so it stays inside their box. */
export function curve(sx: number, sy: number, ex: number, ey: number): string {
  const mx = (sx + ex) / 2;
  return `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`;
}

/** Layers by the longest path; a cycle (never stored) does not loop. */
function layersOf(sorted: readonly LayoutItem[], deps: ReadonlyMap<string, readonly string[]>): Map<string, number> {
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
  return layer;
}

/** Whether segments p1-p2 and p3-p4 cross properly (touching ends do not count). */
function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d = (a: Point, b: Point, c: Point): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * How many pairs of edges cross, each edge taken as the straight segment between its ends (the
 * right middle of its first card and the left middle of the next). Edges sharing a card never count.
 */
export function crossingCount(segments: readonly { readonly from: string; readonly to: string; readonly start: Point; readonly end: Point }[]): number {
  let count = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const a = segments[i];
    if (!a) continue;
    for (let j = i + 1; j < segments.length; j += 1) {
      const b = segments[j];
      if (!b || a.from === b.from || a.to === b.to || a.from === b.to || a.to === b.from) continue;
      if (segmentsCross(a.start, a.end, b.start, b.end)) count += 1;
    }
  }
  return count;
}

/** One placement of the cards for a lane order. */
interface Arrangement {
  readonly lanes: readonly string[];
  readonly laneFor: (id: string) => string;
  readonly yOf: (id: string) => number;
  readonly laneTop: ReadonlyMap<string, number>;
  readonly rowsOf: ReadonlyMap<string, number>;
  readonly contentBottom: number;
  readonly head: number;
  readonly foot: number;
  readonly step: number;
  readonly crossings: number;
}

/** The lane orders to try: every order up to 5 lanes (the first is the given one), else only the given one. */
function lanePermutations(order: readonly string[]): string[][] {
  if (order.length > 5) return [[...order]];
  const out: string[][] = [];
  const walk = (prefix: string[], rest: string[]): void => {
    if (rest.length === 0) {
      out.push(prefix);
      return;
    }
    rest.forEach((key, index) => walk([...prefix, key], [...rest.slice(0, index), ...rest.slice(index + 1)]));
  };
  walk([], [...order]);
  return out;
}

/** Orders and places the cards in `lanes` (barycentre sweeps, the order with the fewest crossings kept). */
function arrange(
  lanes: readonly string[],
  banded: boolean,
  sorted: readonly LayoutItem[],
  layer: ReadonlyMap<string, number>,
  layerCount: number,
  laneKey: ReadonlyMap<string, string>,
  deps: ReadonlyMap<string, readonly string[]>,
  dependents: ReadonlyMap<string, readonly string[]>,
  valid: readonly PlanEdge[],
): Arrangement {
  const G = PROJECT_GRAPH;
  const laneFor = (id: string): string => (banded ? (laneKey.get(id) ?? SEVERAL_LANE) : (lanes[0] ?? SEVERAL_LANE));

  // Cells: (lane, layer) → ids, first in plan order.
  const cellKey = (lane: string, at: number): string => `${lane}\u0000${at}`;
  const cells = new Map<string, string[]>();
  for (const item of sorted) {
    const key = cellKey(laneFor(item.id), layer.get(item.id) ?? 0);
    const list = cells.get(key) ?? [];
    list.push(item.id);
    cells.set(key, list);
  }
  const rowsOf = new Map(lanes.map((lane) => [lane, Math.max(1, ...Array.from({ length: layerCount }, (_, at) => cells.get(cellKey(lane, at))?.length ?? 0))]));
  const head = banded ? G.laneHead : 0;
  const foot = banded ? G.laneFoot : 0;
  const laneTop = new Map<string, number>();
  let y = G.pad;
  for (const lane of lanes) {
    laneTop.set(lane, y);
    y += head + (rowsOf.get(lane) ?? 1) * (G.cardHeight + G.gapY) - G.gapY + foot + G.laneGap;
  }
  const contentBottom = y - G.laneGap;
  const step = G.cardHeight + G.gapY;
  const position = new Map(sorted.map((item, index) => [item.id, index]));

  // Slots: an order inside each cell, then a slot (row) per card that keeps that order.
  const slot = new Map<string, number>();
  const yOf = (id: string): number => (laneTop.get(laneFor(id)) ?? 0) + head + (slot.get(id) ?? 0) * step;
  const place = (ids2: readonly string[], lane: string, desired: (id: string) => number | null): void => {
    const rows = rowsOf.get(lane) ?? 1;
    const top = (laneTop.get(lane) ?? 0) + head;
    let next = 0;
    ids2.forEach((id, index) => {
      const want = desired(id);
      const wanted = want === null ? next : Math.round((want - top) / step);
      const value = Math.min(Math.max(wanted, next), rows - (ids2.length - index));
      slot.set(id, value);
      next = value + 1;
    });
  };
  const mean = (list: readonly string[]): number | null => (list.length === 0 ? null : list.reduce((sum, id) => sum + yOf(id), 0) / list.length);
  const orderCell = (list: string[], weight: (id: string) => number | null): void => {
    const w = new Map(list.map((id) => [id, weight(id)]));
    list.sort((a, b) => {
      const wa = w.get(a) ?? null;
      const wb = w.get(b) ?? null;
      if (wa !== null && wb !== null && wa !== wb) return wa - wb;
      if (wa === null && wb !== null) return 1;
      if (wb === null && wa !== null) return -1;
      return (position.get(a) ?? 0) - (position.get(b) ?? 0);
    });
  };
  const sweep = (down: boolean): void => {
    const order = Array.from({ length: layerCount }, (_, at) => (down ? at : layerCount - 1 - at));
    for (const at of order) {
      for (const lane of lanes) {
        const list = cells.get(cellKey(lane, at));
        if (!list) continue;
        const neighbours = (id: string): readonly string[] => (down ? (deps.get(id) ?? []) : (dependents.get(id) ?? []));
        orderCell(list, (id) => mean(neighbours(id)));
        place(list, lane, (id) => mean(neighbours(id)));
      }
    }
  };
  const segments = (): { from: string; to: string; start: Point; end: Point }[] =>
    valid.map((edge) => ({
      from: edge.from,
      to: edge.to,
      start: { x: (layer.get(edge.from) ?? 0) * (G.cardWidth + G.gapX) + G.cardWidth, y: yOf(edge.from) },
      end: { x: (layer.get(edge.to) ?? 0) * (G.cardWidth + G.gapX), y: yOf(edge.to) },
    }));
  // The first placement: plan order, packed top.
  for (const lane of lanes) for (let at = 0; at < layerCount; at += 1) place(cells.get(cellKey(lane, at)) ?? [], lane, () => null);
  const snapshot = (): { cells: Map<string, string[]>; slot: Map<string, number> } => ({ cells: new Map([...cells].map(([key, list]) => [key, [...list]])), slot: new Map(slot) });
  let best = snapshot();
  let bestCrossings = crossingCount(segments());
  for (let round = 0; round < 6 && bestCrossings > 0; round += 1) {
    sweep(round % 2 === 0);
    const crossings = crossingCount(segments());
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      best = snapshot();
    }
  }
  // A final down sweep that only straightens (slots), from the best order.
  cells.clear();
  for (const [key, list] of best.cells) cells.set(key, list);
  slot.clear();
  for (const [key, value] of best.slot) slot.set(key, value);
  for (let at = 1; at < layerCount; at += 1) {
    for (const lane of lanes) {
      const list = cells.get(cellKey(lane, at));
      if (list) place(list, lane, (id) => mean(deps.get(id) ?? []));
    }
  }
  if (crossingCount(segments()) > bestCrossings) {
    slot.clear();
    for (const [key, value] of best.slot) slot.set(key, value);
  }

  return { lanes, laneFor, yOf, laneTop, rowsOf, contentBottom, head, foot, step, crossings: crossingCount(segments()) };
}

/**
 * The layout of a project's steps. `repos` (the plan's repositories) gives the lanes' first order;
 * lanes of repositories it does not list follow, by name. Up to 5 repository lanes, every order is
 * tried and the one with the fewest crossings wins (ties: the neutral lane last, then the plan's
 * order); the neutral lane moves up only when that saves crossings.
 */
export function projectGraphLayout(items: readonly LayoutItem[], edges: readonly PlanEdge[], repos: readonly string[] = []): ProjectGraphLayout {
  const G = PROJECT_GRAPH;
  const sorted = [...items].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Set(sorted.map((item) => item.id));
  const valid = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to);
  const deps = new Map<string, string[]>(sorted.map((item) => [item.id, []]));
  const dependents = new Map<string, string[]>(sorted.map((item) => [item.id, []]));
  for (const edge of valid) {
    deps.get(edge.to)?.push(edge.from);
    dependents.get(edge.from)?.push(edge.to);
  }
  const layer = layersOf(sorted, deps);
  const layerCount = Math.max(0, ...[...layer.values()].map((value) => value + 1));

  // Lanes: the plan's order, then the rest by name, the neutral lane last.
  const laneKey = new Map(sorted.map((item) => [item.id, laneOf(item)]));
  const present = new Set(laneKey.values());
  const known = repos.filter((repo) => present.has(repo));
  const rest = [...present].filter((key) => key !== SEVERAL_LANE && !known.includes(key)).sort();
  const laneOrder = [...new Set([...known, ...rest]), ...(present.has(SEVERAL_LANE) ? [SEVERAL_LANE] : [])];
  const banded = laneOrder.length >= 2;
  // The lanes in the order with the fewest crossings; ties: the orders with the neutral lane last
  // first, then the plan's order.
  const all = banded ? lanePermutations(laneOrder) : [[laneOrder[0] ?? SEVERAL_LANE]];
  const neutralLast = (order: readonly string[]): boolean => !present.has(SEVERAL_LANE) || order[order.length - 1] === SEVERAL_LANE;
  const candidates = [...all.filter(neutralLast), ...all.filter((order) => !neutralLast(order))];
  let chosen: Arrangement | null = null;
  for (const lanes of candidates) {
    const next = arrange(lanes, banded, sorted, layer, layerCount, laneKey, deps, dependents, valid);
    if (chosen === null || next.crossings < chosen.crossings) chosen = next;
    if (chosen.crossings === 0) break;
  }
  const { lanes, laneFor, yOf, laneTop, rowsOf, contentBottom, head, foot, step } = chosen as Arrangement;
  const xOf = (at: number): number => G.pad + at * (G.cardWidth + G.gapX);
  const nodes: ProjectGraphNode[] = sorted.map((item) => ({ id: item.id, layer: layer.get(item.id) ?? 0, lane: laneFor(item.id), x: xOf(layer.get(item.id) ?? 0), y: yOf(item.id) }));
  const at = new Map(nodes.map((node) => [node.id, node]));
  const sinks = sorted.map((item) => item.id).filter((id) => (dependents.get(id)?.length ?? 0) === 0);
  const sinkYs = sinks.map((id) => (at.get(id)?.y ?? G.pad) + G.cardHeight / 2);
  const middle = sinkYs.length > 0 ? (Math.min(...sinkYs) + Math.max(...sinkYs)) / 2 : G.pad + G.cardHeight / 2;
  const finalBox = { x: xOf(layerCount), y: Math.round(middle - G.finalHeight / 2), width: G.finalWidth, height: G.finalHeight };

  const edgeOf = (from: ProjectGraphNode, to: Point & { readonly height: number }, toId: string, toFinal: boolean): ProjectGraphEdge => {
    const start = { x: from.x + G.cardWidth, y: from.y + G.cardHeight / 2 };
    const end = { x: to.x - G.arrowGap, y: to.y + to.height / 2 };
    return { key: `${from.id}>${toId}`, from: from.id, to: toId, path: curve(start.x, start.y, end.x, end.y), toFinal, start, end };
  };
  const out: ProjectGraphEdge[] = [];
  for (const edge of valid) {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from && to) out.push(edgeOf(from, { ...to, height: G.cardHeight }, edge.to, false));
  }
  for (const id of sinks) {
    const from = at.get(id);
    if (from) out.push(edgeOf(from, finalBox, 'final', true));
  }
  const width = finalBox.x + finalBox.width + G.pad;
  const height = Math.max(contentBottom, finalBox.y + finalBox.height) + G.pad;
  const hueOf = (key: string): number => (key === SEVERAL_LANE ? -1 : laneOrder.filter((other) => other !== SEVERAL_LANE).indexOf(key));
  const laneList: ProjectGraphLane[] = banded ? lanes.map((key) => ({ key, label: laneLabel(key), hue: hueOf(key), top: laneTop.get(key) ?? 0, height: head + (rowsOf.get(key) ?? 1) * step - G.gapY + foot })) : [];
  return { nodes, lanes: laneList, edges: out, final: finalBox, sinks, layers: layerCount, width, height };
}

/**
 * The hover / focus path of step `id`: itself, everything it waits on (upstream) and everything
 * that waits on it (downstream), and the edges on those paths (an upstream edge ends upstream or at
 * the step; a downstream edge starts at the step or downstream). The final node joins when a
 * step on the path leads into it.
 */
export function relatedPath(id: string, edges: readonly PlanEdge[], sinks: readonly string[] = []): { readonly nodes: ReadonlySet<string>; readonly edges: ReadonlySet<string> } {
  const up = new Set<string>();
  const down = new Set<string>();
  const walk = (start: string, into: Set<string>, next: (edge: PlanEdge) => string | null): void => {
    const queue = [start];
    while (queue.length > 0) {
      const at = queue.shift() as string;
      for (const edge of edges) {
        const other = next(edge) === at ? (edge.from === at ? edge.to : edge.from) : null;
        if (other !== null && other !== id && !into.has(other)) {
          into.add(other);
          queue.push(other);
        }
      }
    }
  };
  walk(id, up, (edge) => edge.to);
  walk(id, down, (edge) => edge.from);
  const nodes = new Set([id, ...up, ...down]);
  const hot = new Set<string>();
  for (const edge of edges) {
    if (up.has(edge.from) && (edge.to === id || up.has(edge.to))) hot.add(`${edge.from}>${edge.to}`);
    if ((edge.from === id || down.has(edge.from)) && down.has(edge.to)) hot.add(`${edge.from}>${edge.to}`);
  }
  for (const sink of sinks) {
    if (sink === id || down.has(sink)) {
      hot.add(`${sink}>final`);
      nodes.add('final');
    }
  }
  return { nodes, edges: hot };
}

/** The canvas view: a translation and a scale. */
export interface GraphView {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

/** The zoom limits. */
export const ZOOM = { min: 0.3, max: 2.5, fitMax: 1, step: 1.2, doubleTap: 1.6, doubleTapFitAt: 1.4, phone: 0.55, narrow: 560 } as const;

/**
 * The view that fits the content into the frame (never above 100 %), centred, `margin` px around;
 * `reserveBottom` px at the bottom stay free (the minimap's corner).
 */
export function fitView(content: { readonly width: number; readonly height: number }, frame: { readonly width: number; readonly height: number }, margin = 12, reserveBottom = 0): GraphView {
  const room = frame.height - reserveBottom;
  const k = Math.max(0.05, Math.min(ZOOM.fitMax, (frame.width - margin * 2) / Math.max(1, content.width), (room - margin * 2) / Math.max(1, content.height)));
  return { k, x: (frame.width - content.width * k) / 2, y: (room - content.height * k) / 2 };
}

/** The view zoomed by `factor` around the frame point (cx, cy), clamped to {@link ZOOM}. */
export function zoomAt(view: GraphView, factor: number, cx: number, cy: number): GraphView {
  const k = Math.min(ZOOM.max, Math.max(Math.min(ZOOM.min, view.k), view.k * factor));
  const ratio = k / view.k;
  return { k, x: cx - (cx - view.x) * ratio, y: cy - (cy - view.y) * ratio };
}

/** The pinch gesture's start: the view then, and the two fingers' midpoint and distance (frame px). */
export interface PinchStart {
  readonly view: GraphView;
  readonly mx: number;
  readonly my: number;
  readonly distance: number;
}

/**
 * The view during a pinch: scaled by the fingers' distance against the start (clamped to
 * {@link ZOOM}), around the start midpoint, which follows the fingers (so the midpoint also pans).
 */
export function pinchView(start: PinchStart, mx: number, my: number, distance: number): GraphView {
  const wanted = start.view.k * (distance / Math.max(1, start.distance));
  const k = Math.min(ZOOM.max, Math.max(Math.min(ZOOM.min, start.view.k), wanted));
  const ratio = k / start.view.k;
  return { k, x: mx - (start.mx - start.view.x) * ratio, y: my - (start.my - start.view.y) * ratio };
}

/** A double tap at (cx, cy): zoom in ×1.6 around it, or Fit (`null`) when already at 1.4 or more. */
export function doubleTapView(view: GraphView, cx: number, cy: number): GraphView | null {
  return view.k >= ZOOM.doubleTapFitAt ? null : zoomAt(view, ZOOM.doubleTap, cx, cy);
}

/** Whether a canvas is too narrow to open fitted (a phone): the whole project would be unreadable. */
export function isNarrowCanvas(width: number): boolean {
  return width < ZOOM.narrow;
}

/**
 * The view a narrow canvas opens at: zoom {@link ZOOM.phone}, centred on the first working step in
 * plan order, else the first not-done one, else the first; `null` without steps (then Fit).
 */
export function openingView(layout: Pick<ProjectGraphLayout, 'nodes'>, items: readonly Pick<PlanItem, 'id' | 'state' | 'position'>[], frame: { readonly width: number; readonly height: number }): GraphView | null {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const target = sorted.find((item) => item.state === 'running') ?? sorted.find((item) => item.state !== 'done') ?? sorted[0];
  const node = target ? layout.nodes.find((entry) => entry.id === target.id) : undefined;
  if (!node) return null;
  const k = ZOOM.phone;
  return { k, x: frame.width / 2 - (node.x + PROJECT_GRAPH.cardWidth / 2) * k, y: frame.height / 2 - (node.y + PROJECT_GRAPH.cardHeight / 2) * k };
}

/** The frame's height for a graph: its fitted-to-width height plus margins and `reserveBottom`, at least `min`, at most `max`. */
export function frameHeight(content: { readonly width: number; readonly height: number }, frameWidth: number, reserveBottom = 0, min = 260, max = 680): number {
  const k = Math.min(ZOOM.fitMax, Math.max(0.05, (frameWidth - 24) / Math.max(1, content.width)));
  return Math.round(Math.min(max, Math.max(min, content.height * k + 24 + reserveBottom)));
}

// ── the minimap ─────────────────────────────────────────────────────────

/** The minimap's size (px) and the room Fit leaves under the graph for it. */
export const MINIMAP = { width: 180, height: 92, inset: 12 } as const;

/** Where the content sits in the minimap: scale `s`, offset (ox, oy) (the content fitted and centred). */
export interface MinimapFrame {
  readonly s: number;
  readonly ox: number;
  readonly oy: number;
}

/** The minimap's scale and offset for content of this size. */
export function minimapFrame(content: { readonly width: number; readonly height: number }, mini: { readonly width: number; readonly height: number } = MINIMAP): MinimapFrame {
  const s = Math.min(mini.width / Math.max(1, content.width), mini.height / Math.max(1, content.height));
  return { s, ox: (mini.width - content.width * s) / 2, oy: (mini.height - content.height * s) / 2 };
}

/** The part of the content the frame shows, as a rectangle in minimap pixels. */
export function minimapViewport(view: GraphView, frame: { readonly width: number; readonly height: number }, mini: MinimapFrame): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  return { x: mini.ox + (-view.x / view.k) * mini.s, y: mini.oy + (-view.y / view.k) * mini.s, width: (frame.width / view.k) * mini.s, height: (frame.height / view.k) * mini.s };
}

/** The view (same zoom) that centres the frame on the content point under minimap point (px, py). */
export function viewAtMinimapPoint(px: number, py: number, view: GraphView, frame: { readonly width: number; readonly height: number }, mini: MinimapFrame): GraphView {
  const cx = (px - mini.ox) / mini.s;
  const cy = (py - mini.oy) / mini.s;
  return { k: view.k, x: frame.width / 2 - cx * view.k, y: frame.height / 2 - cy * view.k };
}

// ── progress and the critical path ──────────────────────────────────────

type TimedItem = Pick<PlanItem, 'id' | 'state' | 'estimateMinutes' | 'startedAt' | 'actualMinutes' | 'dependsOn'>;

/** Minutes a step has been worked on (its `actualMinutes`, else since `startedAt`); `null` before it starts. */
export function elapsedMinutes(item: Pick<PlanItem, 'startedAt' | 'actualMinutes'>, now: number): number | null {
  if (item.actualMinutes !== null) return item.actualMinutes;
  if (!item.startedAt) return null;
  const started = Date.parse(item.startedAt);
  return Number.isNaN(started) ? null : Math.max(0, Math.floor((now - started) / 60_000));
}

/**
 * A step's ring value (0…1): 1 when done; else the time so far against its estimate (at most
 * 0.95: the estimate is a guess), 0 without an estimate or before it starts.
 */
export function stepProgress(item: Pick<PlanItem, 'state' | 'estimateMinutes' | 'startedAt' | 'actualMinutes'>, now: number): number {
  if (item.state === 'done') return 1;
  const elapsed = elapsedMinutes(item, now);
  if (elapsed === null || item.estimateMinutes === null || item.estimateMinutes <= 0) return 0;
  return Math.min(0.95, elapsed / item.estimateMinutes);
}

/** What is left of a step (minutes): 0 done; running: its estimate less the time so far (at least 1); else its estimate ({@link DEFAULT_ITEM_MINUTES} without one), as the core's time left counts it. */
export function minutesLeft(item: Pick<PlanItem, 'state' | 'estimateMinutes' | 'startedAt' | 'actualMinutes'>, now: number): number {
  if (item.state === 'done') return 0;
  const estimate = item.estimateMinutes ?? DEFAULT_ITEM_MINUTES;
  const elapsed = item.state === 'running' ? elapsedMinutes(item, now) : null;
  return elapsed === null ? estimate : Math.max(estimate - elapsed, 1);
}

/**
 * The critical path the graph highlights: the longest chain of steps by what is left of them
 * ({@link minutesLeft}; done steps count 0), its not-done steps and the edges between them. Ties:
 * the earlier step in plan order. Empty when everything is done.
 */
export function remainingCriticalPath(items: readonly (TimedItem & Pick<PlanItem, 'position'>)[], edges: readonly PlanEdge[], now: number): { readonly ids: readonly string[]; readonly edges: ReadonlySet<string>; readonly minutes: number } {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const ids = new Set(sorted.map((item) => item.id));
  const valid = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to);
  const deps = new Map<string, string[]>(sorted.map((item) => [item.id, []]));
  for (const edge of valid) deps.get(edge.to)?.push(edge.from);
  const layer = layersOf(sorted.map((item) => ({ ...item, solutions: [] })), deps);
  const order = [...sorted].sort((a, b) => (layer.get(a.id) ?? 0) - (layer.get(b.id) ?? 0) || a.position - b.position);
  const best = new Map<string, { minutes: number; via: string | null }>();
  for (const item of order) {
    let via: string | null = null;
    let before = 0;
    for (const dep of deps.get(item.id) ?? []) {
      const entry = best.get(dep);
      if (entry && (entry.minutes > before || (via === null && entry.minutes === before && before > 0))) {
        before = entry.minutes;
        via = dep;
      }
    }
    best.set(item.id, { minutes: before + minutesLeft(item, now), via });
  }
  let end: string | null = null;
  let minutes = 0;
  for (const item of order) {
    const entry = best.get(item.id);
    if (entry && entry.minutes > minutes) {
      end = item.id;
      minutes = entry.minutes;
    }
  }
  const path: string[] = [];
  const seen = new Set<string>();
  for (let at = end; at !== null && !seen.has(at); at = best.get(at)?.via ?? null) {
    seen.add(at);
    path.unshift(at);
  }
  const state = new Map(sorted.map((item) => [item.id, item.state]));
  const open = path.filter((id) => state.get(id) !== 'done');
  const hot = new Set<string>();
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1] as string;
    const to = path[index] as string;
    if (state.get(from) !== 'done' && state.get(to) !== 'done') hot.add(`${from}>${to}`);
  }
  return { ids: open, edges: hot, minutes };
}

/** The graph's tone of a step (the card's accent, dot and word colour). */
export type GraphTone = 'working' | 'ready' | 'waiting' | 'needs' | 'approval' | 'failed' | 'done';

/**
 * A step's graph tone: working (accent), ready (teal), waiting (neutral), stopped or needs you
 * (orange), ready for approval (violet), failed (red: blocked, its agent failed, D139), done (green).
 */
export function graphTone(item: Pick<PlanItem, 'state' | 'storedState' | 'reason'> & Partial<Pick<PlanItem, 'stoppedBy'>>): GraphTone {
  switch (item.state) {
    case 'done':
      return 'done';
    case 'running':
      return 'working';
    case 'ready':
      return 'ready';
    case 'waiting':
      return 'waiting';
    case 'blocked':
      return 'failed';
    case 'ready-to-merge':
    case 'to-confirm':
      return 'approval';
    case 'stopped':
      return item.stoppedBy === 'error' || item.storedState === 'failed' ? 'failed' : 'needs';
    case 'question':
    case 'needs-you':
      return 'needs';
  }
}
