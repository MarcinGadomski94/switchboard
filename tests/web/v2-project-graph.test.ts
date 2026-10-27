import { describe, expect, it } from 'vitest';
import type { PlanEdge, PlanItem } from '../../src/core/plans.ts';
import { GRAPH, graphLayout } from '../../src/web/plans/model.ts';
import {
  MINIMAP,
  PROJECT_GRAPH,
  SEVERAL_LANE,
  ZOOM,
  crossingCount,
  doubleTapView,
  isNarrowCanvas,
  openingView,
  pinchView,
  elapsedMinutes,
  fitView,
  frameHeight,
  graphTone,
  laneOf,
  minimapFrame,
  minimapViewport,
  minutesLeft,
  projectGraphLayout,
  relatedPath,
  remainingCriticalPath,
  shortRepoNames,
  stepProgress,
  viewAtMinimapPoint,
  zoomAt,
} from '../../src/web/v2/projects/graph-layout.ts';

/**
 * The v2 Project graph's pure layout (`src/web/v2/projects/graph-layout.ts`): layers by depth,
 * repository lanes, crossings not worse than the classic layout, deterministic, every edge inside
 * the canvas, the hover path, fit and zoom.
 */

type Item = Pick<PlanItem, 'id' | 'position' | 'solutions'>;

const step = (id: string, position: number, solutions: readonly string[] = []): Item => ({ id, position, solutions });
const e = (from: string, to: string): PlanEdge => ({ from, to });

/** A 15-step fan-out / fan-in sample over three repositories (generic names). */
function sample(): { items: Item[]; edges: PlanEdge[]; repos: string[] } {
  const repos = ['acme-api', 'acme-web', 'acme-sdk'];
  const r = (index: number): string[] => [repos[index] as string];
  const items = [
    step('a1', 1, r(0)), // scaffold api
    step('w1', 2, r(1)), // scaffold web
    step('s1', 3, r(2)), // scaffold sdk
    step('a2', 4, r(0)),
    step('a3', 5, r(0)),
    step('s2', 6, r(2)),
    step('w2', 7, r(1)),
    step('s3', 8, r(2)),
    step('s4', 9, r(2)),
    step('a4', 10, r(0)),
    step('w3', 11, r(1)),
    step('w4', 12, r(1)),
    step('x1', 13, [repos[0] as string, repos[1] as string]),
    step('w5', 14, r(1)),
    step('x2', 15, []),
  ];
  const edges = [e('a1', 'a2'), e('a1', 'a3'), e('s1', 's2'), e('w1', 'w2'), e('a2', 'w2'), e('s2', 's3'), e('a3', 's4'), e('s2', 's4'), e('a2', 'a4'), e('s3', 'w3'), e('w2', 'w3'), e('s4', 'w4'), e('w3', 'w4'), e('a4', 'x1'), e('w4', 'w5'), e('x1', 'w5'), e('w5', 'x2'), e('s3', 'x2')];
  return { items, edges, repos };
}

function oldCrossings(items: readonly Item[], edges: readonly PlanEdge[]): number {
  const layout = graphLayout(items, edges);
  const at = new Map(layout.nodes.map((node) => [node.id, node]));
  return crossingCount(
    edges.flatMap((edge) => {
      const from = at.get(edge.from);
      const to = at.get(edge.to);
      return from && to ? [{ from: edge.from, to: edge.to, start: { x: from.x + GRAPH.cardWidth, y: from.y + GRAPH.cardHeight / 2 }, end: { x: to.x, y: to.y + GRAPH.cardHeight / 2 } }] : [];
    }),
  );
}

function newCrossings(items: readonly Item[], edges: readonly PlanEdge[], repos: readonly string[] = []): number {
  return crossingCount(projectGraphLayout(items, edges, repos).edges.filter((edge) => !edge.toFinal));
}

/** Points along a cubic path `M sx sy C c1x c1y, c2x c2y, ex ey`. */
function pathPoints(path: string): { x: number; y: number }[] {
  const n = path.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  const [sx = 0, sy = 0, c1x = 0, c1y = 0, c2x = 0, c2y = 0, ex = 0, ey = 0] = n;
  const out: { x: number; y: number }[] = [];
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const u = 1 - t;
    out.push({ x: u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex, y: u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey });
  }
  return out;
}

describe('layers', () => {
  it('puts a step one layer right of its furthest dependency, roots in layer 0, the final node after the last', () => {
    const { items, edges, repos } = sample();
    const layout = projectGraphLayout(items, edges, repos);
    const layer = new Map(layout.nodes.map((node) => [node.id, node.layer]));
    expect(layer.get('a1')).toBe(0);
    expect(layer.get('w1')).toBe(0);
    expect(layer.get('a2')).toBe(1);
    expect(layer.get('w2')).toBe(2);
    expect(layer.get('w3')).toBe(3);
    expect(layer.get('x2')).toBe(6);
    for (const edge of edges) expect(layer.get(edge.to) ?? 0).toBeGreaterThan(layer.get(edge.from) ?? 0);
    expect(layout.layers).toBe(7);
    expect(layout.final.x).toBe(PROJECT_GRAPH.pad + 7 * (PROJECT_GRAPH.cardWidth + PROJECT_GRAPH.gapX));
    expect(layout.sinks).toEqual(['x2']);
    // x by layer; fixed card size.
    for (const node of layout.nodes) expect(node.x).toBe(PROJECT_GRAPH.pad + node.layer * (PROJECT_GRAPH.cardWidth + PROJECT_GRAPH.gapX));
  });

  it('does not loop on a cycle (never stored; the server refuses one)', () => {
    const layout = projectGraphLayout([step('a', 1), step('b', 2)], [e('a', 'b'), e('b', 'a')]);
    expect(layout.nodes).toHaveLength(2);
  });

  it('handles an empty plan and a single step', () => {
    expect(projectGraphLayout([], []).nodes).toHaveLength(0);
    const one = projectGraphLayout([step('a', 1)], []);
    expect(one.nodes[0]).toMatchObject({ layer: 0, x: PROJECT_GRAPH.pad, y: PROJECT_GRAPH.pad });
    expect(one.sinks).toEqual(['a']);
    expect(one.edges.map((edge) => edge.key)).toEqual(['a>final']);
  });
});

describe('lanes', () => {
  it('groups single-repository steps by repository; several or none go to the neutral lane', () => {
    const { items, edges, repos } = sample();
    const layout = projectGraphLayout(items, edges, repos);
    expect([...layout.lanes.map((lane) => lane.label)].sort()).toEqual(['Several repositories', 'acme-api', 'acme-sdk', 'acme-web']);
    // Each lane keeps its colour (its place in the plan's repositories) whatever order it is drawn in.
    expect(Object.fromEntries(layout.lanes.map((band) => [band.label, band.hue]))).toEqual({ 'acme-api': 0, 'acme-web': 1, 'acme-sdk': 2, 'Several repositories': -1 });
    const lane = new Map(layout.nodes.map((node) => [node.id, node.lane]));
    expect(lane.get('a1')).toBe('acme-api');
    expect(lane.get('s3')).toBe('acme-sdk');
    expect(lane.get('x1')).toBe(SEVERAL_LANE);
    expect(lane.get('x2')).toBe(SEVERAL_LANE);
    // Every card inside its lane's band; bands do not overlap.
    const bands = new Map(layout.lanes.map((band) => [band.key, band]));
    for (const node of layout.nodes) {
      const band = bands.get(node.lane);
      expect(band).toBeDefined();
      expect(node.y).toBeGreaterThanOrEqual((band?.top ?? 0) + PROJECT_GRAPH.laneHead);
      expect(node.y + PROJECT_GRAPH.cardHeight).toBeLessThanOrEqual((band?.top ?? 0) + (band?.height ?? 0));
    }
    for (let i = 1; i < layout.lanes.length; i += 1) expect(layout.lanes[i]?.top ?? 0).toBeGreaterThanOrEqual((layout.lanes[i - 1]?.top ?? 0) + (layout.lanes[i - 1]?.height ?? 0));
  });

  it('keeps the plan’s lane order and the neutral lane last when no order has fewer crossings', () => {
    const items = [step('a', 1, ['acme-api']), step('b', 2, ['acme-web']), step('c', 3, ['acme-sdk']), step('d', 4)];
    expect(projectGraphLayout(items, [], ['acme-api', 'acme-web', 'acme-sdk']).lanes.map((lane) => lane.label)).toEqual(['acme-api', 'acme-web', 'acme-sdk', 'Several repositories']);
    expect(projectGraphLayout(items, [], ['acme-sdk', 'acme-api', 'acme-web']).lanes.map((lane) => lane.label)).toEqual(['acme-sdk', 'acme-api', 'acme-web', 'Several repositories']);
  });

  it('draws no bands when every step is in one lane', () => {
    expect(projectGraphLayout([step('a', 1, ['acme']), step('b', 2, ['acme'])], [e('a', 'b')], ['acme']).lanes).toEqual([]);
    expect(projectGraphLayout([step('a', 1), step('b', 2)], [e('a', 'b')]).lanes).toEqual([]);
  });

  it('a step’s lane and the chips’ short names', () => {
    expect(laneOf({ solutions: ['acme-api'] })).toBe('acme-api');
    expect(laneOf({ solutions: [] })).toBe(SEVERAL_LANE);
    expect(laneOf({ solutions: ['a', 'b'] })).toBe(SEVERAL_LANE);
    expect([...shortRepoNames(['acme-api', 'acme-web-app', 'acme-sdk']).values()]).toEqual(['api', 'web-app', 'sdk']);
    expect([...shortRepoNames(['microfrontends/web-front', 'mobile']).values()]).toEqual(['web-front', 'mobile']);
    expect([...shortRepoNames(['acme']).values()]).toEqual(['acme']);
    expect([...shortRepoNames(['acme', 'acme-web']).values()]).toEqual(['acme', 'acme-web']);
  });
});

describe('crossings', () => {
  const graphs: Record<string, { items: Item[]; edges: PlanEdge[]; repos?: string[] }> = {
    sample: sample(),
    fanOut: { items: [step('r', 1), ...['a', 'b', 'c', 'd', 'e'].map((id, i) => step(id, i + 2))], edges: ['a', 'b', 'c', 'd', 'e'].map((id) => e('r', id)) },
    fanIn: { items: [...['a', 'b', 'c', 'd', 'e'].map((id, i) => step(id, i + 1)), step('z', 9)], edges: ['a', 'b', 'c', 'd', 'e'].map((id) => e(id, 'z')) },
    crossed: {
      // Two chains declared in an order that crosses: a1→b2, a2→b1 (plan order a1 a2 b1 b2).
      items: [step('a1', 1), step('a2', 2), step('b1', 3), step('b2', 4), step('c1', 5), step('c2', 6)],
      edges: [e('a1', 'b2'), e('a2', 'b1'), e('b2', 'c1'), e('b1', 'c2')],
    },
    diamond: { items: [step('a', 1), step('b', 2), step('c', 3), step('d', 4), step('f', 5)], edges: [e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd'), e('a', 'f'), e('f', 'd')] },
  };
  for (const [name, graph] of Object.entries(graphs)) {
    it(`${name}: no more crossings than the classic layout`, () => {
      expect(newCrossings(graph.items, graph.edges, graph.repos)).toBeLessThanOrEqual(oldCrossings(graph.items, graph.edges));
    });
  }

  it('untangles a crossed pair', () => {
    const graph = graphs['crossed'];
    expect(newCrossings(graph?.items ?? [], graph?.edges ?? [])).toBe(0);
  });

  it('counts a crossing of two segments, not of segments sharing a card', () => {
    const seg = (from: string, to: string, y1: number, y2: number) => ({ from, to, start: { x: 0, y: y1 }, end: { x: 10, y: y2 } });
    expect(crossingCount([seg('a', 'b', 0, 10), seg('c', 'd', 10, 0)])).toBe(1);
    expect(crossingCount([seg('a', 'b', 0, 10), seg('a', 'd', 10, 0)])).toBe(0);
    expect(crossingCount([seg('a', 'b', 0, 0), seg('c', 'd', 10, 10)])).toBe(0);
  });
});

describe('determinism and bounds', () => {
  it('gives the same layout for the same input, whatever the input order', () => {
    const { items, edges, repos } = sample();
    const one = projectGraphLayout(items, edges, repos);
    const two = projectGraphLayout([...items].reverse(), [...edges].reverse(), repos);
    const byId = (layout: typeof one) => Object.fromEntries(layout.nodes.map((node) => [node.id, [node.x, node.y, node.lane]]));
    expect(byId(two)).toEqual(byId(one));
    expect(projectGraphLayout(items, edges, repos)).toEqual(one);
  });

  it('keeps every card, the final node and every edge (all along its curve) inside the canvas, cards never overlap', () => {
    for (const graph of [sample(), { items: [step('a', 1), step('b', 2), step('c', 3)], edges: [e('a', 'c')], repos: [] }]) {
      const layout = projectGraphLayout(graph.items, graph.edges, graph.repos);
      for (const node of layout.nodes) {
        expect(node.x).toBeGreaterThanOrEqual(0);
        expect(node.y).toBeGreaterThanOrEqual(0);
        expect(node.x + PROJECT_GRAPH.cardWidth).toBeLessThanOrEqual(layout.width);
        expect(node.y + PROJECT_GRAPH.cardHeight).toBeLessThanOrEqual(layout.height);
      }
      expect(layout.final.x + layout.final.width).toBeLessThanOrEqual(layout.width);
      expect(layout.final.y).toBeGreaterThanOrEqual(0);
      expect(layout.final.y + layout.final.height).toBeLessThanOrEqual(layout.height);
      for (const edge of layout.edges) {
        for (const point of pathPoints(edge.path)) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(layout.width);
          expect(point.y).toBeLessThanOrEqual(layout.height);
        }
        // From a card's right side to the next card's left side.
        expect(edge.end.x).toBeGreaterThan(edge.start.x);
      }
      for (let i = 0; i < layout.nodes.length; i += 1) {
        for (let j = i + 1; j < layout.nodes.length; j += 1) {
          const a = layout.nodes[i];
          const b = layout.nodes[j];
          if (!a || !b) continue;
          const apart = a.x + PROJECT_GRAPH.cardWidth <= b.x || b.x + PROJECT_GRAPH.cardWidth <= a.x || a.y + PROJECT_GRAPH.cardHeight <= b.y || b.y + PROJECT_GRAPH.cardHeight <= a.y;
          expect(apart, `${a.id} and ${b.id} overlap`).toBe(true);
        }
      }
    }
  });
});

describe('the hover path', () => {
  it('lights the step, everything upstream and downstream, and only the edges on those paths', () => {
    const edges = [e('a', 'b'), e('b', 'c'), e('c', 'd'), e('x', 'c'), e('b', 'y'), e('a', 'z')];
    const path = relatedPath('c', edges, ['d', 'y', 'z']);
    expect([...path.nodes].sort()).toEqual(['a', 'b', 'c', 'd', 'final', 'x']);
    expect([...path.edges].sort()).toEqual(['a>b', 'b>c', 'c>d', 'd>final', 'x>c']);
    // A side branch of an ancestor (b → y) and a sibling (a → z) stay dim.
    expect(path.edges.has('b>y')).toBe(false);
    expect(path.nodes.has('z')).toBe(false);
  });

  it('a lone step lights only itself (and its final edge)', () => {
    const path = relatedPath('a', [], ['a']);
    expect([...path.nodes].sort()).toEqual(['a', 'final']);
    expect([...path.edges]).toEqual(['a>final']);
  });
});

describe('fit and zoom', () => {
  it('fits the content into the frame, centred, never above 100 %', () => {
    const view = fitView({ width: 2000, height: 500 }, { width: 1000, height: 600 }, 12);
    expect(view.k).toBeCloseTo((1000 - 24) / 2000);
    expect(view.x).toBeCloseTo((1000 - 2000 * view.k) / 2);
    expect(fitView({ width: 300, height: 100 }, { width: 1000, height: 600 }).k).toBe(1);
  });

  it('zooms around the pointer (the point under it stays put), within the limits', () => {
    const view = { x: 10, y: 20, k: 1 };
    const next = zoomAt(view, 1.2, 300, 200);
    expect((300 - next.x) / next.k).toBeCloseTo((300 - view.x) / view.k);
    expect((200 - next.y) / next.k).toBeCloseTo((200 - view.y) / view.k);
    expect(zoomAt({ x: 0, y: 0, k: 1.9 }, 2, 0, 0).k).toBe(2.5);
    expect(zoomAt({ x: 0, y: 0, k: 0.4 }, 0.5, 0, 0).k).toBe(0.3);
    // Below the limit (a big project fitted) zooming out stays where it is, zooming in works.
    expect(zoomAt({ x: 0, y: 0, k: 0.2 }, 0.5, 0, 0).k).toBe(0.2);
    expect(zoomAt({ x: 0, y: 0, k: 0.2 }, 1.2, 0, 0).k).toBeCloseTo(0.24);
  });

  it('sizes the frame to the fitted graph and the minimap’s room, within limits', () => {
    expect(frameHeight({ width: 500, height: 100 }, 1000)).toBe(260);
    expect(frameHeight({ width: 1000, height: 400 }, 1000, 100)).toBe(Math.round(400 * (976 / 1000) + 24 + 100));
    expect(frameHeight({ width: 1000, height: 2000 }, 1000)).toBe(680);
  });

  it('Fit leaves the reserved room at the bottom free', () => {
    const view = fitView({ width: 1000, height: 600 }, { width: 1000, height: 700 }, 12, 104);
    expect(view.y + 600 * view.k).toBeLessThanOrEqual(700 - 104);
    expect(view.x).toBeGreaterThanOrEqual(0);
  });
});

describe('touch: pinch, double tap, the phone’s opening view', () => {
  it('pinches around the midpoint: the content under it stays under it, and it follows the fingers', () => {
    const start = { view: { x: 20, y: 40, k: 1 }, mx: 200, my: 300, distance: 100 };
    const twice = pinchView(start, 200, 300, 200);
    expect(twice.k).toBe(2);
    expect((200 - twice.x) / twice.k).toBeCloseTo((200 - start.view.x) / start.view.k);
    expect((300 - twice.y) / twice.k).toBeCloseTo((300 - start.view.y) / start.view.k);
    // The midpoint moved 50 px right with the same spread: a pan, no zoom.
    const panned = pinchView(start, 250, 300, 100);
    expect(panned.k).toBe(1);
    expect(panned.x).toBeCloseTo(start.view.x + 50);
    expect(panned.y).toBeCloseTo(start.view.y);
  });

  it('clamps a pinch to 0.3…2.5', () => {
    const start = { view: { x: 0, y: 0, k: 1 }, mx: 0, my: 0, distance: 100 };
    expect(pinchView(start, 0, 0, 1000).k).toBe(ZOOM.max);
    expect(pinchView(start, 0, 0, 10).k).toBe(ZOOM.min);
    expect(pinchView({ ...start, distance: 0 }, 0, 0, 50).k).toBe(ZOOM.max);
  });

  it('a double tap zooms in ×1.6 around the tap, or fits at 1.4 and above', () => {
    const next = doubleTapView({ x: 0, y: 0, k: 0.5 }, 100, 80);
    expect(next?.k).toBeCloseTo(0.8);
    expect((100 - (next?.x ?? 0)) / (next?.k ?? 1)).toBeCloseTo(200);
    expect(doubleTapView({ x: 0, y: 0, k: 1.4 }, 0, 0)).toBeNull();
  });

  it('a narrow canvas opens at 0.55 centred on the first working step, else the first not-done one', () => {
    const items = [
      { id: 'a', position: 1, state: 'done' as const, solutions: [] },
      { id: 'b', position: 2, state: 'waiting' as const, solutions: [] },
      { id: 'c', position: 3, state: 'running' as const, solutions: [] },
    ];
    const layout = projectGraphLayout(items, [e('a', 'b'), e('a', 'c')]);
    const frame = { width: 360, height: 600 };
    const view = openingView(layout, items, frame);
    const c = layout.nodes.find((node) => node.id === 'c');
    expect(view?.k).toBe(0.55);
    expect(((c?.x ?? 0) + PROJECT_GRAPH.cardWidth / 2) * (view?.k ?? 0) + (view?.x ?? 0)).toBeCloseTo(frame.width / 2);
    expect(((c?.y ?? 0) + PROJECT_GRAPH.cardHeight / 2) * (view?.k ?? 0) + (view?.y ?? 0)).toBeCloseTo(frame.height / 2);
    const idle = items.map((item) => (item.id === 'c' ? { ...item, state: 'waiting' as const } : item));
    const b = layout.nodes.find((node) => node.id === 'b');
    const second = openingView(layout, idle, frame);
    expect(((b?.x ?? 0) + PROJECT_GRAPH.cardWidth / 2) * 0.55 + (second?.x ?? 0)).toBeCloseTo(frame.width / 2);
    expect(openingView(projectGraphLayout([], []), [], frame)).toBeNull();
    expect(isNarrowCanvas(390)).toBe(true);
    expect(isNarrowCanvas(560)).toBe(false);
  });
});

describe('the minimap', () => {
  const content = { width: 1800, height: 600 };
  const frame = { width: 900, height: 500 };
  const mini = minimapFrame(content);

  it('fits the content into the minimap, centred', () => {
    expect(mini.s).toBeCloseTo(Math.min(MINIMAP.width / 1800, MINIMAP.height / 600));
    expect(mini.ox).toBeCloseTo(0);
    expect(mini.oy).toBeCloseTo((MINIMAP.height - 600 * mini.s) / 2);
  });

  it('draws the frame’s view as a rectangle: the whole content when fitted, half of it at twice the zoom', () => {
    const whole = minimapViewport({ x: 0, y: 0, k: 0.5 }, frame, mini);
    expect(whole.x).toBeCloseTo(mini.ox);
    expect(whole.width).toBeCloseTo(1800 * mini.s);
    const half = minimapViewport({ x: -900, y: 0, k: 1 }, frame, mini);
    expect(half.x).toBeCloseTo(mini.ox + 900 * mini.s);
    expect(half.width).toBeCloseTo(900 * mini.s);
  });

  it('a click on the minimap centres the frame on that point, at the same zoom', () => {
    const view = { x: 0, y: 0, k: 1 };
    const at = viewAtMinimapPoint(mini.ox + 1200 * mini.s, mini.oy + 300 * mini.s, view, frame, mini);
    expect(at.k).toBe(1);
    // Content (1200, 300) now sits at the frame's centre.
    expect(1200 * at.k + at.x).toBeCloseTo(frame.width / 2);
    expect(300 * at.k + at.y).toBeCloseTo(frame.height / 2);
    // …and the viewport rectangle is centred on the click.
    const rect = minimapViewport(at, frame, mini);
    expect(rect.x + rect.width / 2).toBeCloseTo(mini.ox + 1200 * mini.s);
  });
});

describe('progress and the critical path', () => {
  const NOW = Date.parse('2026-10-27T12:00:00.000Z');
  const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
  type T = Parameters<typeof remainingCriticalPath>[0][number];
  const t = (id: string, position: number, patch: Partial<T> = {}): T => ({ id, position, state: 'waiting', estimateMinutes: 60, startedAt: null, actualMinutes: null, dependsOn: [], ...patch });

  it('measures a step: the time so far against its estimate (at most 0.95), 1 when done, 0 without an estimate', () => {
    expect(stepProgress(t('a', 1, { state: 'done' }), NOW)).toBe(1);
    expect(stepProgress(t('a', 1, { state: 'running', startedAt: ago(30) }), NOW)).toBeCloseTo(0.5);
    expect(stepProgress(t('a', 1, { state: 'running', actualMinutes: 15 }), NOW)).toBeCloseTo(0.25);
    expect(stepProgress(t('a', 1, { state: 'running', startedAt: ago(500) }), NOW)).toBe(0.95);
    expect(stepProgress(t('a', 1, { state: 'running', startedAt: ago(30), estimateMinutes: null }), NOW)).toBe(0);
    expect(stepProgress(t('a', 1), NOW)).toBe(0);
    expect(elapsedMinutes({ startedAt: ago(12), actualMinutes: null }, NOW)).toBe(12);
    expect(elapsedMinutes({ startedAt: null, actualMinutes: null }, NOW)).toBeNull();
  });

  it('counts what is left of a step as the core does', () => {
    expect(minutesLeft(t('a', 1, { state: 'done' }), NOW)).toBe(0);
    expect(minutesLeft(t('a', 1, { state: 'running', startedAt: ago(20) }), NOW)).toBe(40);
    expect(minutesLeft(t('a', 1, { state: 'running', startedAt: ago(90) }), NOW)).toBe(1);
    expect(minutesLeft(t('a', 1, { estimateMinutes: null }), NOW)).toBe(30);
  });

  it('is the longest chain of not-done steps by what is left', () => {
    // a(done) → b(running, 50 left) → d(60) ; a → c(10) → d ; e(100) alone.
    const items = [t('a', 1, { state: 'done' }), t('b', 2, { state: 'running', startedAt: ago(10) }), t('c', 3, { estimateMinutes: 10 }), t('d', 4), t('e', 5, { estimateMinutes: 100 })];
    const edges = [e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')];
    const path = remainingCriticalPath(items, edges, NOW);
    expect(path.ids).toEqual(['b', 'd']);
    expect([...path.edges]).toEqual(['b>d']);
    expect(path.minutes).toBe(110);
    // A lone long step wins when it is longer.
    const longer = remainingCriticalPath([...items.slice(0, 4), t('e', 5, { estimateMinutes: 200 })], edges, NOW);
    expect(longer.ids).toEqual(['e']);
    expect(longer.edges.size).toBe(0);
  });

  it('is empty when every step is done, and does not loop on a cycle', () => {
    expect(remainingCriticalPath([t('a', 1, { state: 'done' })], [], NOW).ids).toEqual([]);
    expect(remainingCriticalPath([t('a', 1), t('b', 2)], [e('a', 'b'), e('b', 'a')], NOW).ids.length).toBeGreaterThan(0);
  });
});

describe('tones', () => {
  it('maps the step states to the graph’s tones (D139 stopped vs failed)', () => {
    const t = (state: PlanItem['state'], patch: Partial<PlanItem> = {}) => graphTone({ state, storedState: 'pending', reason: null, ...patch });
    expect(t('running')).toBe('working');
    expect(t('ready')).toBe('ready');
    expect(t('waiting')).toBe('waiting');
    expect(t('stopped')).toBe('needs');
    expect(t('stopped', { stoppedBy: 'account' })).toBe('needs');
    expect(t('stopped', { stoppedBy: 'error' })).toBe('failed');
    expect(t('blocked')).toBe('failed');
    expect(t('needs-you')).toBe('needs');
    expect(t('ready-to-merge')).toBe('approval');
    expect(t('done')).toBe('done');
  });
});
