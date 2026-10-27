import { describe, expect, it } from 'vitest';
import { PROJECT_GRAPH, ZOOM, fitView } from '../../src/web/v2/projects/graph-layout.ts';
import { FULLSCREEN_IDLE_MS, followIds, followKey, followView, fullscreenRefit, fullscreenTitle, mayAutoHide, refitView, shapeKey, showFitPill, wantsNativeFullscreen } from '../../src/web/v2/projects/graph-fullscreen.ts';
import { isClassicOnlyPath, parseV2Route, phoneTabOf, railAreaOf, toClassicPath, toV2Path, v2Path } from '../../src/web/v2/routes.ts';

/** Fixes after 2.0 → *The Project graph in full screen*: the pure rules (`graph-fullscreen.ts`) and the `/projects/:id/graph` route. */

const node = (id: string, x: number, y: number) => ({ id, x, y, layer: 0, lane: '' });
const layout = { nodes: [node('a', 24, 64), node('b', 352, 64), node('c', 352, 188), node('d', 680, 64)] };
const items = [
  { id: 'a', state: 'done' as const, position: 1 },
  { id: 'b', state: 'running' as const, position: 2 },
  { id: 'c', state: 'running' as const, position: 3 },
  { id: 'd', state: 'waiting' as const, position: 4 },
];

describe('fullscreenRefit (when the full-screen canvas moves by itself)', () => {
  it('always fits on entering, even after a manual move', () => {
    for (const moved of [false, true]) for (const follow of [false, true]) expect(fullscreenRefit('enter', { moved, follow })).toBe('fit');
  });

  it('re-fits on resize and on a new shape until the view is moved by hand', () => {
    for (const follow of [false, true]) {
      expect(fullscreenRefit('resize', { moved: false, follow })).toBe('fit');
      expect(fullscreenRefit('layout', { moved: false, follow })).toBe('fit');
      expect(fullscreenRefit('resize', { moved: true, follow })).toBe('none');
      expect(fullscreenRefit('layout', { moved: true, follow })).toBe('none');
    }
  });

  it('progress: Follow re-fits an untouched view and centres a moved one; without Follow nothing moves', () => {
    expect(fullscreenRefit('progress', { moved: false, follow: true })).toBe('fit');
    expect(fullscreenRefit('progress', { moved: true, follow: true })).toBe('follow');
    expect(fullscreenRefit('progress', { moved: false, follow: false })).toBe('none');
    expect(fullscreenRefit('progress', { moved: true, follow: false })).toBe('none');
  });

  it('shows the Fit pill only in full screen after a manual move', () => {
    expect(showFitPill(true, true)).toBe(true);
    expect(showFitPill(true, false)).toBe(false);
    expect(showFitPill(false, true)).toBe(false);
  });
});

describe('Follow', () => {
  it('follows the working steps, else the first not-done one, else nothing', () => {
    expect(followIds(items)).toEqual(['b', 'c']);
    expect(followIds(items.map((item) => (item.state === 'running' ? { ...item, state: 'waiting' as const } : item)))).toEqual(['b']);
    expect(followIds(items.map((item) => ({ ...item, state: 'done' as const })))).toEqual([]);
    // Plan order, not array order.
    expect(followIds([...items].reverse())).toEqual(['b', 'c']);
  });

  it('keys change with the work and with the shape only', () => {
    expect(followKey(items)).toBe('b\nc');
    expect(followKey(items.map((item) => (item.id === 'c' ? { ...item, state: 'done' as const } : item)))).toBe('b');
    expect(shapeKey(layout)).toBe(shapeKey({ nodes: [...layout.nodes].reverse() }));
    expect(shapeKey({ nodes: [...layout.nodes, node('e', 1000, 64)] })).not.toBe(shapeKey(layout));
  });

  it('centres the box of the working steps at the current zoom', () => {
    const frame = { width: 1400, height: 800 };
    const view = followView(layout, ['b', 'c'], { k: 1, x: 0, y: 0 }, frame);
    if (!view) throw new Error('no view');
    expect(view.k).toBe(1);
    const cx = (352 + 352 + PROJECT_GRAPH.cardWidth) / 2;
    const cy = (64 + 188 + PROJECT_GRAPH.cardHeight) / 2;
    expect(view.x + cx * view.k).toBeCloseTo(frame.width / 2);
    expect(view.y + cy * view.k).toBeCloseTo(frame.height / 2);
  });

  it('zooms out just enough when the working steps do not fit, never below the minimum', () => {
    const frame = { width: 300, height: 200 };
    const view = followView(layout, ['a', 'd'], { k: 2, x: 0, y: 0 }, frame);
    if (!view) throw new Error('no view');
    expect(view.k).toBeLessThan(2);
    expect(view.k).toBeGreaterThanOrEqual(ZOOM.min);
    const tiny = followView(layout, ['a', 'd'], { k: 1, x: 0, y: 0 }, { width: 60, height: 40 });
    expect(tiny?.k).toBe(ZOOM.min);
    expect(followView(layout, [], { k: 1, x: 0, y: 0 }, frame)).toBeNull();
    expect(followView(layout, ['b'], { k: 1, x: 0, y: 0 }, { width: 0, height: 0 })).toBeNull();
  });

  it('refitView: fit, follow (or fit when nothing is left), none', () => {
    const content = { width: 1000, height: 400 };
    const frame = { width: 1200, height: 700 };
    const view = { k: 1.5, x: -100, y: -40 };
    expect(refitView('fit', layout, items, content, view, frame)).toEqual(fitView(content, frame));
    expect(refitView('none', layout, items, content, view, frame)).toBeNull();
    expect(refitView('follow', layout, items, content, view, frame)?.k).toBe(1.5);
    const allDone = items.map((item) => ({ ...item, state: 'done' as const }));
    expect(refitView('follow', layout, allDone, content, view, frame)).toEqual(fitView(content, frame));
  });
});

describe('entering full screen and the ambient touches', () => {
  it('tries the Fullscreen API only when it exists and is enabled (else the overlay)', () => {
    expect(wantsNativeFullscreen({ api: true, enabled: true })).toBe(true);
    // iOS Safari: no element full screen.
    expect(wantsNativeFullscreen({ api: false, enabled: false })).toBe(false);
    // A policy (an iframe without allowfullscreen).
    expect(wantsNativeFullscreen({ api: true, enabled: false })).toBe(false);
  });

  it('hides the chrome after 3 s, but never on touch screens or with the keyboard in the top bar', () => {
    expect(FULLSCREEN_IDLE_MS).toBe(3000);
    expect(mayAutoHide({ coarse: false, focusInBar: false })).toBe(true);
    expect(mayAutoHide({ coarse: true, focusInBar: false })).toBe(false);
    expect(mayAutoHide({ coarse: false, focusInBar: true })).toBe(false);
  });

  it('titles the tab with the state, the % done and the name', () => {
    const plan = { title: 'Acme orders', state: 'running' as const, progress: { done: 9, total: 20 } };
    expect(fullscreenTitle(plan)).toBe('▶ 45% · Acme orders');
    expect(fullscreenTitle({ ...plan, state: 'paused' })).toBe('⏸ 45% · Acme orders');
    expect(fullscreenTitle({ ...plan, state: 'done', progress: { done: 20, total: 20 } })).toBe('✓ 100% · Acme orders');
    expect(fullscreenTitle({ ...plan, state: 'draft', progress: { done: 0, total: 0 } })).toBe('0% · Acme orders');
  });
});

describe('the /projects/:id/graph route', () => {
  it('parses and prints', () => {
    expect(parseV2Route('/projects/p1/graph')).toEqual({ area: 'project-graph', id: 'p1' });
    expect(parseV2Route('/projects/a%20b/graph')).toEqual({ area: 'project-graph', id: 'a b' });
    expect(v2Path({ area: 'project-graph', id: 'a b' })).toBe('/projects/a%20b/graph');
    expect(parseV2Route(v2Path({ area: 'project-graph', id: 'p1' }))).toEqual({ area: 'project-graph', id: 'p1' });
    // Other third segments are not a page.
    expect(parseV2Route('/projects/p1/board')).toEqual({ area: 'home' });
    expect(parseV2Route('/projects/p1/graph/x')).toEqual({ area: 'home' });
    expect(parseV2Route('/projects/p1')).toEqual({ area: 'project', id: 'p1' });
  });

  it('belongs to Projects, and classic opens the plan page', () => {
    expect(railAreaOf({ area: 'project-graph', id: 'p1' })).toBe('projects');
    expect(phoneTabOf({ area: 'project-graph', id: 'p1' })).toBe('more');
    expect(toClassicPath('/projects/p1/graph')).toBe('/plans/p1');
    expect(toV2Path('/projects/p1/graph')).toBe('/projects/p1/graph');
    expect(isClassicOnlyPath('/projects/p1/graph')).toBe(false);
  });
});
