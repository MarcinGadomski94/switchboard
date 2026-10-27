import type { PlanItem, PlanState } from '../../../core/plans.ts';
import { type GraphView, PROJECT_GRAPH, type ProjectGraphLayout, ZOOM, fitView } from './graph-layout.ts';

/**
 * Fixes after 2.0 → *The Project graph in full screen* (`docs/design/v2-decisions.md`): the pure
 * rules of the graph's full-screen mode (`GraphView.tsx`), DOM-free and unit-tested in
 * `tests/web/v2-project-graph-fullscreen.test.ts`: when the canvas re-fits or follows the work by
 * itself, where Follow centres, how full screen is entered (the Fullscreen API or the window-filling
 * overlay), and the page title while it shows.
 */

/** How the graph fills the screen: `native` = the Fullscreen API; `overlay` = a fixed layer over the window; `page` = the `/projects/:id/graph` page. */
export type FullscreenMode = 'off' | 'native' | 'overlay' | 'page';

/** What made the canvas ask whether to move its view by itself. */
export type RefitTrigger =
  /** Full screen was entered (or the full-screen page opened). */
  | 'enter'
  /** The canvas changed size (a window resize, a monitor change, the top bar). */
  | 'resize'
  /** Steps were added or removed (the layout's shape changed). */
  | 'layout'
  /** The project moved on: the steps being worked on changed. */
  | 'progress';

/** What the canvas does about a {@link RefitTrigger}: fit the whole graph, centre on the work at the current zoom, or leave the view. */
export type RefitAction = 'fit' | 'follow' | 'none';

/**
 * The full-screen canvas's rule. Entering always fits (and forgets any manual move). Otherwise,
 * while the view was not moved by hand, a resize, a new shape and (with Follow) progress re-fit;
 * once it was zoomed or panned by hand only Follow moves it, centring on the work as the project
 * progresses (the Fit pill offers the rest).
 */
export function fullscreenRefit(trigger: RefitTrigger, state: { readonly moved: boolean; readonly follow: boolean }): RefitAction {
  if (trigger === 'enter') return 'fit';
  if (!state.moved) return trigger === 'progress' && !state.follow ? 'none' : 'fit';
  return trigger === 'progress' && state.follow ? 'follow' : 'none';
}

/** The Fit pill shows in full screen while the view was moved by hand (a click re-fits and resumes the automatic fit). */
export function showFitPill(fullscreen: boolean, moved: boolean): boolean {
  return fullscreen && moved;
}

/**
 * The steps Follow keeps in view: the ones being worked on (running), else the first not-done one
 * in plan order; none when everything is done (then Follow fits).
 */
export function followIds(items: readonly Pick<PlanItem, 'id' | 'state' | 'position'>[]): string[] {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const working = sorted.filter((item) => item.state === 'running').map((item) => item.id);
  if (working.length > 0) return working;
  const next = sorted.find((item) => item.state !== 'done');
  return next ? [next.id] : [];
}

/** A key that changes when {@link followIds} change (the `progress` trigger). */
export function followKey(items: readonly Pick<PlanItem, 'id' | 'state' | 'position'>[]): string {
  return followIds(items).join('\n');
}

/** A key that changes when steps are added or removed (the `layout` trigger). */
export function shapeKey(layout: Pick<ProjectGraphLayout, 'nodes'>): string {
  return layout.nodes
    .map((node) => node.id)
    .sort()
    .join('\n');
}

/**
 * Follow's view: the current zoom, centred on the box around {@link followIds}; when that box does
 * not fit at this zoom, the zoom drops just enough (never below {@link ZOOM.min}). `null` when there
 * is nothing to follow (fit instead).
 */
export function followView(layout: Pick<ProjectGraphLayout, 'nodes'>, ids: readonly string[], view: GraphView, frame: { readonly width: number; readonly height: number }, margin = 24): GraphView | null {
  const wanted = new Set(ids);
  const nodes = layout.nodes.filter((node) => wanted.has(node.id));
  if (nodes.length === 0 || frame.width <= 0 || frame.height <= 0) return null;
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + PROJECT_GRAPH.cardWidth));
  const bottom = Math.max(...nodes.map((node) => node.y + PROJECT_GRAPH.cardHeight));
  const room = Math.min((frame.width - margin * 2) / Math.max(1, right - left), (frame.height - margin * 2) / Math.max(1, bottom - top));
  const k = Math.max(Math.min(ZOOM.min, view.k), Math.min(view.k, room));
  return { k, x: frame.width / 2 - ((left + right) / 2) * k, y: frame.height / 2 - ((top + bottom) / 2) * k };
}

/** The view a {@link RefitAction} leads to (`null`: leave the view as it is). */
export function refitView(action: RefitAction, layout: Pick<ProjectGraphLayout, 'nodes'>, items: readonly Pick<PlanItem, 'id' | 'state' | 'position'>[], content: { readonly width: number; readonly height: number }, view: GraphView, frame: { readonly width: number; readonly height: number }): GraphView | null {
  if (action === 'none' || frame.width <= 0 || frame.height <= 0) return null;
  if (action === 'follow') {
    const next = followView(layout, followIds(items), view, frame);
    if (next) return next;
  }
  return fitView(content, frame);
}

/** What the browser offers for an element's full screen. */
export interface FullscreenSupport {
  /** `Element.prototype.requestFullscreen` exists. */
  readonly api: boolean;
  /** `document.fullscreenEnabled` (an iframe without `allowfullscreen`, a policy: `false`). */
  readonly enabled: boolean;
}

/** Whether to try the Fullscreen API first; otherwise (iOS Safari for elements, a refusing policy) the overlay fills the window. */
export function wantsNativeFullscreen(support: FullscreenSupport): boolean {
  return support.api && support.enabled;
}

/** The idle time (ms) after which, in full screen, the top bar fades and the pointer hides (a move brings them back). */
export const FULLSCREEN_IDLE_MS = 3000;

/**
 * Whether the full-screen chrome may hide when idle: never with a touch screen (no hover to bring it
 * back), nor while the keyboard focus is in the top bar. Under reduced motion it hides without a fade.
 */
export function mayAutoHide(state: { readonly coarse: boolean; readonly focusInBar: boolean }): boolean {
  return !state.coarse && !state.focusInBar;
}

/** The page title while the graph fills the screen: "▶ 45% · Acme orders" (⏸ on hold, ✓ done; no mark otherwise). */
export function fullscreenTitle(plan: { readonly title: string; readonly state: PlanState; readonly progress: { readonly done: number; readonly total: number } }): string {
  const percent = plan.progress.total === 0 ? 0 : Math.round((plan.progress.done / plan.progress.total) * 100);
  const mark = plan.state === 'running' ? '▶ ' : plan.state === 'paused' ? '⏸ ' : plan.state === 'done' ? '✓ ' : '';
  return `${mark}${percent}% · ${plan.title}`;
}
