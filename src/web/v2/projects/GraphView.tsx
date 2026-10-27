import { type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PlanItem } from '../../../core/plans.ts';
import { modelLabel } from '../../../core/model-choice.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { finalNodeText, shortLabel } from '../../plans/model.ts';
import { useCoarsePointer } from '../../shell/useLayout.ts';
import { Button, Icon, MenuButton, type MenuItem, setFullscreenOverlayHost, useToast } from '../components/index.ts';
import { V2Link } from '../nav.tsx';
import { v2Path } from '../routes.ts';
import { GRAPH_WORDS, PROJECT_WORDS, STATUS } from '../glossary.ts';
import {
  type GraphTone,
  type GraphView as View,
  MINIMAP,
  type PinchStart,
  ZOOM,
  contentOutside,
  doubleTapView,
  elapsedMinutes,
  fitView,
  frameHeight,
  graphTone,
  isNarrowCanvas,
  laneOf,
  minimapFrame,
  openingView,
  pinchView,
  projectGraphLayout,
  relatedPath,
  remainingCriticalPath,
  shortRepoNames,
  stepProgress,
  viewAtMinimapPoint,
  zoomAt,
} from './graph-layout.ts';
import { FULLSCREEN_IDLE_MS, type FullscreenMode, type RefitTrigger, followKey, followView, followIds, fullscreenRefit, fullscreenTitle, mayAutoHide, shapeKey, showFitPill, wantsNativeFullscreen } from './graph-fullscreen.ts';
import { type CardHandlers, type CardModel, type EdgeModel, GraphCard, GraphEdges, GraphFinal, GraphLanes, GraphMinimap, GraphTooltip, Ring, minutesText, toneColour } from './graph-parts.tsx';
import { projectCounts, stepLook, stepName } from './project-model.ts';
import { type ViewProps, stepMenu } from './views.tsx';

/**
 * Fixes after 2.0 → *The Project graph, redrawn* (`docs/design/v2-decisions.md`): a project's Graph
 * view. Layered left → right by dependency depth in repository lanes (`graph-layout.ts`), cards with
 * a progress ring, live edges, the critical path, a minimap; Fit by default (a phone opens readable,
 * on the step being worked on), zoom buttons, ⌘/ctrl-wheel and pinch zoom, drag to pan, a double tap
 * zooms in. Hover or focus a step to light up what it waits on and what waits on it. A click opens
 * the step's agent, or its details when it stopped or failed (D139); ⋯, a right-click, a long press
 * or the context-menu key open the step menu. Motion is off under reduced motion.
 */

const CRITICAL_KEY = 'switchboard.v2.projectGraph.critical';
/** Follow in full screen (on unless turned off in this browser). */
const FOLLOW_KEY = 'switchboard.v2.projectGraph.follow';
const NOW_TICK_MS = 30_000;
const POP_MS = 900;
const ENTER_MS = 900;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 10;

function readCritical(): boolean {
  try {
    return window.localStorage.getItem(CRITICAL_KEY) !== '0';
  } catch {
    return true;
  }
}

function readFollow(): boolean {
  try {
    return window.localStorage.getItem(FOLLOW_KEY) !== '0';
  } catch {
    return true;
  }
}

function storeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // No storage: the choice lasts for this page.
  }
}

/**
 * Full screen for the graph (Fixes after 2.0 → *The Project graph in full screen*): the Fullscreen
 * API on `root` when the browser offers it for elements and lets it; otherwise (iOS Safari, a
 * refusal) a fixed layer over the whole window. `page` (the `/projects/:id/graph` page) already fills
 * the window: entering asks only for the Fullscreen API, and leaving it goes back to the page. Esc
 * leaves the overlay (the browser handles it for the API) unless a menu or dialog takes it first.
 */
function useGraphFullscreen(root: RefObject<HTMLDivElement | null>, page: boolean): { readonly mode: FullscreenMode; readonly enter: () => Promise<void>; readonly exit: () => void } {
  const [mode, setMode] = useState<FullscreenMode>(page ? 'page' : 'off');
  const rest: FullscreenMode = page ? 'page' : 'off';

  useEffect(() => {
    const onChange = (): void => {
      const el = root.current;
      if (el && document.fullscreenElement === el) setMode('native');
      else setMode((current) => (current === 'native' ? rest : current));
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [root, rest]);

  // Esc leaves; a menu, a popover or a dialog closes first (they prevent the key's default). With the
  // Fullscreen API the browser may take Esc itself; where the Keyboard Lock API exists the page gets
  // a short press first (so Esc closes a menu without leaving), and a long press still leaves.
  useEffect(() => {
    if (mode !== 'overlay' && mode !== 'native') return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('.sb2 [aria-modal="true"], .sb2 [role="menu"]')) return;
      event.preventDefault();
      const el = root.current;
      if (el && document.fullscreenElement === el) void document.exitFullscreen().catch(() => undefined);
      setMode(rest);
    };
    document.addEventListener('keydown', onKey);
    const keyboard = (navigator as Navigator & { keyboard?: { lock?: (codes: string[]) => Promise<void>; unlock?: () => void } }).keyboard;
    if (mode === 'native') void keyboard?.lock?.(['Escape']).catch(() => undefined);
    // Nothing scrolls behind the overlay.
    const html = document.documentElement;
    const before = html.style.overflow;
    if (mode === 'overlay') html.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      if (mode === 'native') keyboard?.unlock?.();
      html.style.overflow = before;
    };
  }, [mode, rest, root]);

  // Leaving the view (another project view, another page) leaves the API's full screen too.
  useEffect(
    () => () => {
      if (root.current && document.fullscreenElement === root.current) void document.exitFullscreen?.().catch(() => undefined);
    },
    [root],
  );

  const enter = useCallback(async (): Promise<void> => {
    const el = root.current;
    if (!el) return;
    if (wantsNativeFullscreen({ api: typeof el.requestFullscreen === 'function', enabled: document.fullscreenEnabled === true })) {
      try {
        await el.requestFullscreen({ navigationUI: 'hide' });
        setMode('native');
        return;
      } catch {
        // Refused (no user gesture, a policy): the overlay.
      }
    }
    if (!page) setMode('overlay');
  }, [root, page]);

  const exit = useCallback((): void => {
    if (root.current && document.fullscreenElement === root.current) void document.exitFullscreen().catch(() => undefined);
    setMode(rest);
  }, [root, rest]);

  return { mode, enter, exit };
}

/**
 * In full screen: `true` after {@link FULLSCREEN_IDLE_MS} without a pointer move or a key (the top
 * bar fades, the pointer hides); never on a touch screen or while the keyboard is in the top bar.
 */
function useIdle(active: boolean, root: RefObject<HTMLDivElement | null>, bar: RefObject<HTMLDivElement | null>): boolean {
  const coarse = useCoarsePointer();
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    setIdle(false);
    const el = root.current;
    if (!active || coarse || !el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      setIdle(false);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const focusInBar = bar.current?.contains(document.activeElement) ?? false;
        if (mayAutoHide({ coarse, focusInBar })) setIdle(true);
      }, FULLSCREEN_IDLE_MS);
    };
    arm();
    el.addEventListener('pointermove', arm);
    el.addEventListener('pointerdown', arm);
    el.addEventListener('keydown', arm);
    el.addEventListener('focusin', arm);
    return () => {
      if (timer) clearTimeout(timer);
      el.removeEventListener('pointermove', arm);
      el.removeEventListener('pointerdown', arm);
      el.removeEventListener('keydown', arm);
      el.removeEventListener('focusin', arm);
    };
  }, [active, coarse, root, bar]);
  return idle;
}

/** `prefers-reduced-motion`, live. */
function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const on = (): void => setReduced(list.matches);
    list.addEventListener('change', on);
    return () => list.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** The clock, a tick every `ms` (the working steps' time so far). */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** Ids that just appeared in `ids` (empty on the first render), for `ms` milliseconds. */
function useFresh(ids: readonly string[], ms: number): ReadonlySet<string> {
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const key = ids.join('\n');
  useEffect(() => {
    const before = known.current;
    known.current = new Set(ids);
    if (before === null) return;
    const added = ids.filter((id) => !before.has(id));
    if (added.length === 0) return;
    setFresh(new Set(added));
    const timer = setTimeout(() => setFresh(new Set()), ms);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
  return fresh;
}

/** Captures a pointer when it can (a pointer that is no longer active cannot be). */
export function capture(element: Element, pointerId: number): void {
  try {
    element.setPointerCapture?.(pointerId);
  } catch {
    // Not an active pointer: the moves still bubble to the frame.
  }
}

/** The segments of the header's bar, in this order. */
const SEGMENTS: readonly GraphTone[] = ['done', 'working', 'needs', 'approval', 'failed', 'ready', 'waiting'];

/** The header: the % done ring, "N of M done · K working · J need you", the bar by state, Critical path. */
function GraphHeader({
  done,
  total,
  working,
  needs,
  tones,
  critical,
  onCritical,
  title,
  barRef,
  children,
}: {
  readonly done: number;
  readonly total: number;
  readonly working: number;
  readonly needs: number;
  readonly tones: ReadonlyMap<string, GraphTone>;
  readonly critical: boolean;
  readonly onCritical: () => void;
  /** Full screen: the compact top bar with the project's title. */
  readonly title?: ReactNode;
  readonly barRef?: RefObject<HTMLDivElement | null>;
  /** After Critical path: Full screen, Follow, Exit, the ⋯ menu. */
  readonly children?: ReactNode;
}) {
  const compact = title !== undefined;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const count = (tone: GraphTone): number => [...tones.values()].filter((value) => value === tone).length;
  return (
    <div className="v2-p-ghead" ref={barRef} data-compact={compact || undefined} data-testid={compact ? 'v2-graph-fs-bar' : undefined}>
      {title}
      <Ring value={percent / 100} size={compact ? 40 : 56} stroke={compact ? 5 : 6} className="v2-p-ghead-ring">
        <span className="v2-p-ghead-pct">{percent}%</span>
      </Ring>
      <div className="v2-p-ghead-main">
        <b className="v2-p-ghead-sum" data-testid="v2-graph-summary">
          {GRAPH_WORDS.summary(done, total, working, needs)}
        </b>
        <div className="v2-p-gbar" data-testid="v2-graph-bar" role="img" aria-label={GRAPH_WORDS.percentDone(percent)}>
          {SEGMENTS.map((tone) => {
            const n = count(tone);
            return n > 0 ? <span key={tone} data-tone={tone} style={{ width: `${(n / Math.max(1, total)) * 100}%` }} /> : null;
          })}
        </div>
        {compact ? null : (
        <div className="v2-p-gbar-legend">
          {SEGMENTS.map((tone) => {
            const n = count(tone);
            return n > 0 ? (
              <span key={tone} data-tone={tone}>
                <i style={{ background: toneColour(tone) }} />
                {n} {GRAPH_WORDS.segments[tone]}
              </span>
            ) : null;
          })}
        </div>
        )}
      </div>
      <Button size="sm" icon="diagram" aria-pressed={critical} title={GRAPH_WORDS.criticalPathHint} onClick={onCritical} data-testid="v2-graph-critical" className="v2-p-gcrit">
        {GRAPH_WORDS.criticalPath}
      </Button>
      {children}
    </div>
  );
}

/** The canvas: the frame with its dotted grid, the stage it pans and zooms, the zoom buttons and the minimap. */
function GraphCanvas({
  content,
  label,
  dim,
  frameRef,
  opening,
  minimap,
  tip,
  full,
  follow,
  shape,
  progress,
  followTo,
  extra,
  children,
}: {
  readonly content: { readonly width: number; readonly height: number };
  readonly label: string;
  readonly dim: boolean;
  readonly frameRef: RefObject<HTMLDivElement | null>;
  readonly opening: (frame: { readonly width: number; readonly height: number }) => View | null;
  readonly minimap: (view: View, frame: { readonly width: number; readonly height: number }, size: { readonly width: number; readonly height: number }, onView: (next: View) => void) => ReactNode;
  readonly tip: ReactNode;
  /** The graph fills the screen: the canvas takes all the room, re-fits by itself and follows the work ({@link fullscreenRefit}). */
  readonly full: boolean;
  /** Follow (full screen): keep the work in view as the project progresses. */
  readonly follow: boolean;
  /** Changes when steps are added or removed ({@link shapeKey}). */
  readonly shape: string;
  /** Changes when the steps being worked on change ({@link followKey}). */
  readonly progress: string;
  /** Follow's view at this view and frame (`null`: fit). */
  readonly followTo: (view: View, frame: { readonly width: number; readonly height: number }) => View | null;
  /** More buttons at the end of the zoom stack (Full screen). */
  readonly extra?: ReactNode;
  readonly children: ReactNode;
}) {
  const [frame, setFrame] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [animate, setAnimate] = useState(false);
  const [panning, setPanning] = useState(false);
  const moved = useRef(false);
  // `moved` as state: the Fit pill shows while the view was moved by hand (full screen).
  const [manual, setManual] = useState(false);
  const setMoved = useCallback((value: boolean): void => {
    moved.current = value;
    setManual(value);
  }, []);
  const opened = useRef(false);
  // Full screen's own triggers (graph-fullscreen.ts): what it last saw.
  const seen = useRef<{ full: boolean; shape: string; progress: string; follow: boolean }>({ full, shape, progress, follow });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [mapOpen, setMapOpen] = useState(false);
  const narrow = frame.width > 0 && isNarrowCanvas(frame.width);
  const mapSize = narrow ? { width: MINIMAP.phoneWidth, height: MINIMAP.phoneHeight } : { width: MINIMAP.width, height: MINIMAP.height };
  // The minimap: on a desktop while some steps are outside the view; on a phone only when asked for (Map).
  const showMap = frame.width > 0 && (narrow ? mapOpen : contentOutside(view, content, frame));
  // Fit keeps the minimap's corner free only while it is asked to show (a phone's Map).
  const reserve = narrow && mapOpen ? mapSize.height + MINIMAP.inset : 0;

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const read = (): void => setFrame({ width: el.clientWidth, height: el.clientHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [frameRef]);

  const fit = useCallback(
    (smooth: boolean): void => {
      const el = frameRef.current;
      const size = el ? { width: el.clientWidth, height: el.clientHeight } : frame;
      if (size.width === 0) return;
      setAnimate(smooth);
      setView(fitView(content, size, 12, reserve));
    },
    [content, frame, reserve, frameRef],
  );

  // Full screen (graph-fullscreen.ts → fullscreenRefit): entering fits; a resize, a new shape and
  // (with Follow) progress re-fit until the view is moved by hand; after that only Follow moves it.
  // Leaving full screen opens the normal canvas again (Fit, or a phone's opening view).
  // The normal canvas: the opening view; later a desktop resize or a new layout re-fits until the
  // view was moved by hand. A phone (a narrow canvas) never resets on a resize (its address bar).
  useEffect(() => {
    if (frame.width === 0 || frame.height === 0) return;
    // The element's own size now: the narrow canvas's height (70svh) may not be measured yet.
    const el = frameRef.current;
    const real = el ? { width: el.clientWidth, height: el.clientHeight } : frame;
    const before = seen.current;
    seen.current = { full, shape, progress, follow };
    if (full) {
      const trigger: RefitTrigger = !before.full || !opened.current ? 'enter' : before.shape !== shape ? 'layout' : before.progress !== progress || (follow && !before.follow) ? 'progress' : 'resize';
      opened.current = true;
      if (trigger === 'enter') setMoved(false);
      // A phone (a narrow canvas): fitting a whole project makes its cards unreadable, so full screen
      // opens on the work like the normal phone view, and a resize (its address bar) never resets it.
      if (narrow && (trigger === 'enter' || trigger === 'resize')) {
        const first = trigger === 'enter' ? opening(real) : null;
        if (first) {
          setAnimate(false);
          setView(first);
          setMoved(true);
        } else if (trigger === 'enter') fit(false);
        return;
      }
      const action = fullscreenRefit(trigger, { moved: trigger === 'enter' ? false : moved.current, follow });
      if (action === 'fit') fit(trigger === 'progress');
      else if (action === 'follow') {
        const next = followTo(viewRef.current, real);
        if (next) {
          setAnimate(true);
          setView(next);
        } else fit(true);
      }
      return;
    }
    if (before.full) {
      opened.current = false;
      setMoved(false);
    }
    if (!opened.current) {
      opened.current = true;
      const first = narrow ? opening(real) : null;
      if (first) {
        setAnimate(false);
        setView(first);
        setMoved(true);
      } else fit(false);
      return;
    }
    if (moved.current || narrow) return;
    fit(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame.width, frame.height, content.width, content.height, full, shape, progress, follow]);

  const change = useCallback(
    (next: View, smooth = false): void => {
      if (!moved.current) setMoved(true);
      setAnimate(smooth);
      setView(next);
    },
    [setMoved],
  );

  // ⌘/ctrl-wheel (and a trackpad pinch, which arrives as ctrl-wheel) zooms around the pointer.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = el.getBoundingClientRect();
      change(zoomAt(viewRef.current, event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - box.left, event.clientY - box.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [frameRef, change]);

  // Pointers: one drags (empty canvas), two pinch (anywhere), a double tap zooms in.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<PinchStart | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; id: number } | null>(null);
  const tap = useRef<{ at: number; x: number; y: number } | null>(null);
  const down = useRef<{ x: number; y: number } | null>(null);
  const swallowClick = useRef(0);
  const local = (event: { readonly clientX: number; readonly clientY: number }): { x: number; y: number } => {
    const box = frameRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };
  const onControl = (target: EventTarget | null): boolean => target instanceof Element && target.closest('[data-graph-node], .v2-p-gzoom, .v2-p-gmini, .v2-p-gfinal, .v2-p-gfit-pill') !== null;
  const midpoint = (): { mx: number; my: number; distance: number } | null => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return null;
    return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const at = local(event);
    // A new gesture: the click a pinch's last finger may cause is no longer pending.
    if (pointers.current.size === 0) swallowClick.current = 0;
    pointers.current.set(event.pointerId, at);
    if (pointers.current.size === 2) {
      const mid = midpoint();
      if (mid) pinch.current = { view: viewRef.current, ...mid };
      drag.current = null;
      setPanning(false);
      return;
    }
    if (onControl(event.target)) return;
    down.current = at;
    drag.current = { x: event.clientX, y: event.clientY, vx: viewRef.current.x, vy: viewRef.current.y, id: event.pointerId };
    capture(event.currentTarget, event.pointerId);
    setPanning(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, local(event));
    if (pinch.current && pointers.current.size >= 2) {
      const mid = midpoint();
      if (mid) change(pinchView(pinch.current, mid.mx, mid.my, mid.distance));
      return;
    }
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    change({ k: viewRef.current.k, x: start.vx + event.clientX - start.x, y: start.vy + event.clientY - start.y });
  };
  const lift = (event: ReactPointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(event.pointerId);
    if (pinch.current && pointers.current.size < 2) {
      pinch.current = null;
      // The finger left on the glass does not turn into a drag or a tap.
      swallowClick.current = Date.now() + 400;
      drag.current = null;
      tap.current = null;
      return;
    }
    if (drag.current?.id === event.pointerId) {
      drag.current = null;
      setPanning(false);
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const wasPinch = pinch.current !== null;
    const start = down.current;
    down.current = null;
    lift(event);
    if (wasPinch || event.pointerType !== 'touch' || onControl(event.target) || !start) return;
    const at = local(event);
    if (Math.hypot(at.x - start.x, at.y - start.y) > TAP_SLOP) {
      tap.current = null;
      return;
    }
    const last = tap.current;
    const now = Date.now();
    if (last && now - last.at < DOUBLE_TAP_MS && Math.hypot(at.x - last.x, at.y - last.y) < 30) {
      tap.current = null;
      const next = doubleTapView(viewRef.current, at.x, at.y);
      if (next) change(next, true);
      else {
        setMoved(false);
        fit(true);
      }
    } else tap.current = { at: now, ...at };
  };

  const transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  const style: CSSProperties | undefined = full ? undefined : narrow ? { height: '70svh' } : { height: frameHeight(content, frame.width || 800, reserve) };
  return (
    <div
      ref={frameRef}
      className="v2-p-gframe"
      style={style}
      role="group"
      aria-label={label}
      data-testid="v2-graph-canvas"
      data-dim={dim || undefined}
      data-panning={panning || undefined}
      data-narrow={narrow || undefined}
      data-full={full || undefined}
      data-moved={manual || undefined}
      data-zoom={view.k.toFixed(3)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={lift}
      onClickCapture={(event) => {
        if (Date.now() < swallowClick.current) {
          event.stopPropagation();
          event.preventDefault();
        }
      }}
    >
      <div className="v2-p-gstage" data-testid="v2-graph-stage" data-anim={animate || undefined} style={{ width: content.width, height: content.height, transform }}>
        {children}
      </div>
      <div className="v2-p-gzoom">
        <Button size="sm" aria-label={GRAPH_WORDS.zoomIn} title={GRAPH_WORDS.zoomIn} onClick={() => change(zoomAt(view, ZOOM.step, frame.width / 2, frame.height / 2), true)} data-testid="v2-graph-zoom-in">
          +
        </Button>
        <Button size="sm" aria-label={GRAPH_WORDS.zoomOut} title={GRAPH_WORDS.zoomOut} onClick={() => change(zoomAt(view, 1 / ZOOM.step, frame.width / 2, frame.height / 2), true)} data-testid="v2-graph-zoom-out">
          −
        </Button>
        <Button
          size="sm"
          title={GRAPH_WORDS.fitHint}
          onClick={() => {
            setMoved(false);
            fit(true);
          }}
          data-testid="v2-graph-fit"
        >
          {GRAPH_WORDS.fit}
        </Button>
        {narrow ? (
          <Button size="sm" aria-pressed={mapOpen} title={GRAPH_WORDS.mapHint} onClick={() => setMapOpen((open) => !open)} data-testid="v2-graph-map" className="v2-p-gmap-btn">
            {GRAPH_WORDS.map}
          </Button>
        ) : null}
        {extra}
      </div>
      {showFitPill(full, manual) ? (
        <button
          type="button"
          className="v2-p-gfit-pill"
          title={GRAPH_WORDS.fitAgainHint}
          onClick={() => {
            setMoved(false);
            fit(true);
          }}
          data-testid="v2-graph-fit-pill"
        >
          {GRAPH_WORDS.fitAgain}
        </button>
      ) : null}
      {showMap ? minimap(view, frame, mapSize, (next) => change(next)) : null}
      {tip}
    </div>
  );
}

/** The Graph view of a project; `page` = the `/projects/:id/graph` page (the graph alone, filling the window). */
export function GraphView({ plan, actions, onDetails, page = false }: ViewProps & { readonly page?: boolean }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const screen = useGraphFullscreen(rootRef, page);
  const full = screen.mode !== 'off';
  const idle = useIdle(full, rootRef, barRef);
  const [follow, setFollow] = useState(readFollow);
  // Menus, dialogs, tooltips and toasts render inside the element that fills the screen.
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!full || !layer) return;
    setFullscreenOverlayHost(layer);
    return () => setFullscreenOverlayHost(null);
  }, [full, layer]);
  // The tab's title says how far the project is ("▶ 45% · Acme orders").
  const title = fullscreenTitle(plan);
  useEffect(() => {
    if (!full) return;
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [full, title]);
  const now = useNow(NOW_TICK_MS);
  const reduced = useReducedMotion();
  const sessions = useSessionListOf();
  const idPrefix = `v2g${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [critical, setCritical] = useState(readCritical);
  const [focus, setFocus] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null);

  const layout = useMemo(() => projectGraphLayout(plan.items, plan.edges, plan.repos), [plan.items, plan.edges, plan.repos]);
  const path = useMemo(() => (critical ? remainingCriticalPath(plan.items, plan.edges, now) : null), [critical, plan.items, plan.edges, now]);
  const onPath = useMemo(() => new Set(path?.ids ?? []), [path]);
  const tones = useMemo(() => new Map(plan.items.map((item) => [item.id, graphTone(item)])), [plan.items]);
  const byId = useMemo(() => new Map(plan.items.map((item) => [item.id, item])), [plan.items]);
  const hot = useMemo(() => (focus ? relatedPath(focus, plan.edges, layout.sinks) : null), [focus, plan.edges, layout.sinks]);

  // The chips: short names, coloured like their lane (the plan's repository order).
  const chipOf = useMemo(() => {
    const repos = [...new Set([...plan.repos, ...plan.items.flatMap((item) => item.solutions)])];
    const short = shortRepoNames(repos);
    const order = [...new Set([...plan.repos.filter((repo) => repos.includes(repo)), ...repos.filter((repo) => !plan.repos.includes(repo)).sort()])];
    const hues = new Map(layout.lanes.map((lane) => [lane.key, lane.hue]));
    return (item: PlanItem): CardModel['chip'] => {
      if (item.solutions.length > 1) return { text: GRAPH_WORDS.repos(item.solutions.length), hue: -1 };
      const repo = laneOf(item);
      if (!repo) return null;
      return { text: short.get(repo) ?? repo, hue: hues.get(repo) ?? order.indexOf(repo) };
    };
  }, [plan.repos, plan.items, layout.lanes]);

  const models = useMemo(() => {
    const at = new Map(layout.nodes.map((node) => [node.id, node]));
    const sessionById = new Map((sessions.data ?? []).map((session) => [session.id, session]));
    return plan.items.flatMap((item): CardModel[] => {
      const node = at.get(item.id);
      if (!node) return [];
      const look = stepLook(item, plan.items);
      const tone = tones.get(item.id) ?? 'waiting';
      const elapsed = elapsedMinutes(item, now);
      const session = item.runSessionId ? sessionById.get(item.runSessionId) : undefined;
      const current = session?.model?.current ?? null;
      const model = tone === 'working' && current ? modelLabel(session?.model?.available ?? null, current).replace(/\s*\([^)]*\)\s*$/, '').trim() || null : null;
      let meta: string = look.label;
      if (tone === 'working' && elapsed !== null) meta = `${look.label} · ${minutesText(elapsed)}`;
      else if (look.kind === 'waiting') meta = look.detail ?? look.label;
      else if (look.kind === 'stopped' && item.stoppedBy !== undefined) meta = `${item.stoppedBy === 'account' ? PROJECT_WORDS.stoppedAccount : STATUS.stopped.label} — ${GRAPH_WORDS.openToRestart}`;
      else if (tone === 'done' && item.actualMinutes !== null) meta = `${look.label} · ${minutesText(item.actualMinutes)}`;
      const progress = stepProgress(item, now);
      const name = stepName(item);
      return [
        {
          item,
          look,
          tone,
          name,
          title: item.title.replace(item.key ?? '\u0000', '').trim() || item.title,
          chip: chipOf(item),
          meta,
          model,
          progress,
          eta: tone === 'working' && item.estimateMinutes !== null && elapsed !== null ? progress : null,
          critical: onPath.has(item.id),
          menu: stepMenu(plan, item, actions),
          x: node.x,
          y: node.y,
        },
      ];
    });
  }, [plan, layout.nodes, tones, now, sessions.data, chipOf, onPath, actions]);

  const edgeModels = useMemo(
    (): EdgeModel[] =>
      layout.edges.map((edge) => {
        const from = byId.get(edge.from);
        const to = edge.toFinal ? undefined : byId.get(edge.to);
        const fromTone = tones.get(edge.from) ?? 'waiting';
        const toTone = edge.toFinal ? 'done' : (tones.get(edge.to) ?? 'waiting');
        const kind = edge.toFinal ? 'final' : toTone === 'working' ? 'live' : fromTone === 'done' && toTone === 'done' ? 'done' : 'wait';
        return { edge, kind, fromKey: from?.key ?? edge.from, toKey: edge.toFinal ? 'final' : (to?.key ?? edge.to), fromTone, toTone, critical: path?.edges.has(edge.key) ?? false };
      }),
    [layout.edges, byId, tones, path],
  );

  // Motion: a check pops when a step becomes done; new edges draw in; new cards fade in.
  const doneIds = useMemo(() => plan.items.filter((item) => item.state === 'done').map((item) => item.id), [plan.items]);
  const pops = useFresh(doneIds, POP_MS);
  const enterEdges = useFresh(
    layout.edges.map((edge) => edge.key),
    ENTER_MS,
  );
  const enterNodes = useFresh(
    layout.nodes.map((node) => node.id),
    ENTER_MS,
  );

  const activate = useCallback(
    (item: PlanItem): void => {
      if (!actions.open(item)) onDetails(item);
    },
    [actions, onDetails],
  );
  const tipFor = useCallback(
    (id: string, x: number, y: number): { x: number; y: number; title: string; lines: string[] } | null => {
      const item = byId.get(id);
      if (!item) return null;
      const look = stepLook(item, plan.items);
      const deps = item.dependsOn.map((dep) => byId.get(dep)).filter((dep): dep is PlanItem => dep !== undefined);
      const lines = [look.label];
      if (look.detail && look.kind !== 'waiting') lines.push(look.detail);
      if (item.estimateMinutes !== null) lines.push(GRAPH_WORDS.estimate(minutesText(item.estimateMinutes)));
      if (deps.length > 0) lines.push(GRAPH_WORDS.after(deps.map((dep) => shortLabel(dep, plan.items)).join(', ')));
      if (onPath.has(id)) lines.push(GRAPH_WORDS.onCriticalPath);
      const width = frameRef.current?.clientWidth ?? 800;
      return { x: Math.max(8, Math.min(x, width - 270)), y, title: item.key ? `${item.key} · ${item.title.replace(item.key, '').trim() || item.title}` : item.title, lines };
    },
    [byId, plan.items, onPath],
  );
  const handlers: CardHandlers = useMemo(
    () => ({
      activate,
      focus: (id, at) => {
        setFocus(id);
        if (id === null || at === undefined) {
          setTip(null);
          return;
        }
        const box = frameRef.current?.getBoundingClientRect();
        if (!box) return;
        if (at instanceof HTMLElement) {
          const rect = at.getBoundingClientRect();
          setTip(tipFor(id, rect.left - box.left, rect.bottom - box.top + 6));
        } else setTip(tipFor(id, at.x - box.left + 14, at.y - box.top + 16));
      },
      move: (event: ReactMouseEvent) => {
        const box = frameRef.current?.getBoundingClientRect();
        if (!box) return;
        const width = box.width;
        setTip((current) => (current ? { ...current, x: Math.max(8, Math.min(event.clientX - box.left + 14, width - 270)), y: event.clientY - box.top + 16 } : current));
      },
    }),
    [activate, tipFor],
  );

  const laneProgress = useMemo(() => {
    const out = new Map<string, { done: number; total: number }>();
    for (const node of layout.nodes) {
      const entry = out.get(node.lane) ?? { done: 0, total: 0 };
      entry.total += 1;
      if (byId.get(node.id)?.state === 'done') entry.done += 1;
      out.set(node.lane, entry);
    }
    return out;
  }, [layout.nodes, byId]);

  const counts = projectCounts(plan);
  const percent = plan.progress.total === 0 ? 0 : Math.round((plan.progress.done / plan.progress.total) * 100);
  const content = useMemo(() => ({ width: layout.width, height: layout.height }), [layout.width, layout.height]);
  const opening = useCallback((frame: { readonly width: number; readonly height: number }) => openingView(layout, plan.items, frame), [layout, plan.items]);
  const mini = useMemo(() => minimapFrame(content), [content]);
  const shape = useMemo(() => shapeKey(layout), [layout]);
  const progressKey = followKey(plan.items);
  const followTo = useCallback((view: View, frame: { readonly width: number; readonly height: number }) => followView(layout, followIds(plan.items), view, frame), [layout, plan.items]);
  const toast = useToast();
  const graphPath = v2Path({ area: 'project-graph', id: plan.id });
  const graphMenu: MenuItem[] = [
    ...(page
      ? []
      : [
          {
            id: 'window',
            label: GRAPH_WORDS.openInWindow,
            icon: 'external',
            onSelect: () => {
              window.open(graphPath, `switchboard-graph-${plan.id}`, 'popup,width=1280,height=800');
            },
          },
        ]),
    {
      id: 'copy',
      label: GRAPH_WORDS.copyLink,
      icon: 'copy',
      onSelect: async () => {
        try {
          await navigator.clipboard.writeText(new URL(graphPath, window.location.origin).href);
          toast({ text: GRAPH_WORDS.linkCopied });
        } catch (e) {
          toast({ text: e instanceof Error ? e.message : String(e), tone: 'error' });
        }
      },
    },
  ];
  const fullButton =
    screen.mode === 'native' || screen.mode === 'overlay' ? (
      <Button size="sm" icon="shrink" onClick={screen.exit} title={GRAPH_WORDS.exitFullScreen} aria-label={GRAPH_WORDS.exitFullScreen} data-testid="v2-graph-exit">
        {GRAPH_WORDS.exit}
      </Button>
    ) : (
      <Button size="sm" icon="expand" onClick={() => void screen.enter()} title={GRAPH_WORDS.fullScreenHint} data-testid="v2-graph-fullscreen" data-tour="v2-graph-fullscreen">
        {GRAPH_WORDS.fullScreen}
      </Button>
    );

  if (plan.items.length === 0) return <div className="v2-card v2-p-steps-empty">No steps yet.</div>;

  const finalHot = hot === null ? undefined : hot.nodes.has('final');
  return (
    <div
      ref={rootRef}
      className="v2-card v2-p-graph"
      data-testid="v2-project-graph"
      data-tour="v2-project-graph"
      data-motion={reduced ? 'reduced' : undefined}
      data-fs={full ? screen.mode : undefined}
      data-idle={(full && idle) || undefined}
      role={full ? 'region' : undefined}
      aria-label={full ? GRAPH_WORDS.graphOf(plan.title) : undefined}
    >
      <GraphHeader
        barRef={barRef}
        title={
          full ? (
            <div className="v2-p-gfs-title">
              {page ? (
                <V2Link to={{ area: 'project', id: plan.id }} className="v2-p-gfs-back" title={GRAPH_WORDS.backToProject} aria-label={GRAPH_WORDS.backToProject} data-testid="v2-graph-back">
                  <Icon name="back" size="s" />
                </V2Link>
              ) : null}
              <h2 data-testid="v2-graph-fs-title">{plan.title}</h2>
            </div>
          ) : undefined
        }
        done={plan.progress.done}
        total={plan.progress.total}
        working={counts.running}
        needs={counts.needsYou}
        tones={tones}
        critical={critical}
        onCritical={() => {
          setCritical((value) => {
            try {
              window.localStorage.setItem(CRITICAL_KEY, value ? '0' : '1');
            } catch {
              // No storage: the choice lasts for this page.
            }
            return !value;
          });
        }}
      >
        {full ? (
          <Button
            size="sm"
            icon="eye"
            aria-pressed={follow}
            title={GRAPH_WORDS.followHint}
            onClick={() => {
              setFollow((value) => {
                storeFlag(FOLLOW_KEY, !value);
                return !value;
              });
            }}
            data-testid="v2-graph-follow"
            className="v2-p-gcrit"
          >
            {GRAPH_WORDS.follow}
          </Button>
        ) : null}
        {fullButton}
        <MenuButton items={graphMenu} label={GRAPH_WORDS.graphMenu} testId="v2-graph-menu" />
      </GraphHeader>
      <GraphCanvas
        content={content}
        label={GRAPH_WORDS.graphOf(plan.title)}
        dim={hot !== null}
        frameRef={frameRef}
        opening={opening}
        full={full}
        follow={follow}
        shape={shape}
        progress={progressKey}
        followTo={followTo}
        extra={
          screen.mode === 'native' || screen.mode === 'overlay' ? (
            <Button size="sm" icon="shrink" aria-label={GRAPH_WORDS.exitFullScreen} title={GRAPH_WORDS.exitFullScreen} onClick={screen.exit} data-testid="v2-graph-zoom-fullscreen" />
          ) : (
            <Button size="sm" icon="expand" aria-label={GRAPH_WORDS.fullScreen} title={GRAPH_WORDS.fullScreenHint} onClick={() => void screen.enter()} data-testid="v2-graph-zoom-fullscreen" />
          )
        }
        tip={<GraphTooltip tip={tip} />}
        minimap={(view, frame, size, onView) => {
          const scaled = size.width === MINIMAP.width ? mini : minimapFrame(content, size);
          return <GraphMinimap layout={layout} tones={tones} view={view} frame={frame} mini={scaled} size={size} onPoint={(x, y) => onView(viewAtMinimapPoint(x, y, view, frame, scaled))} />;
        }}
      >
        <GraphLanes layout={layout} progress={laneProgress} />
        <GraphEdges layout={layout} edges={edgeModels} hot={hot?.edges ?? null} enter={enterEdges} particles={!reduced} idPrefix={idPrefix} />
        {models.map((model) => (
          <GraphCard key={model.item.id} model={model} hot={hot === null ? undefined : hot.nodes.has(model.item.id)} pop={pops.has(model.item.id)} enter={enterNodes.has(model.item.id)} on={handlers} />
        ))}
        <GraphFinal layout={layout} percent={percent} text={capitalise(finalNodeText(plan))} hot={finalHot} />
      </GraphCanvas>
      {full ? null : (
        <p className="v2-muted v2-p-graph-legend">
          {GRAPH_WORDS.legend} {GRAPH_WORDS.legendMotion}
        </p>
      )}
      {full ? <div ref={setLayer} className="v2-overlays v2-p-gfs-layer" /> : null}
    </div>
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
