import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { openSessions } from '../../core/session-close.ts';
import { type TourStep, pendingTours } from '../../core/tutorial.ts';
import { api } from '../api/client.ts';
import { useModals } from '../modals/ModalHost.tsx';
import { SKIPPED_KEY } from '../modals/setup-wizard.ts';
import { type Route, useRouter } from '../router.tsx';
import { usePanes } from '../shell/Panes.tsx';
import { type Box, type TourRun, endTours, kickerOf, placeCard, sheetEdge, spotBox, startTours, stepsOf, tourRunning, useTourRun } from './tour.ts';
import './tutorial.css';

/**
 * D85 · the interactive tutorial's host (`docs/tutorial.md`): the first-run gate
 * (opens a pending tour once the setup wizard is out of the way) and, while a
 * tour runs, the spotlight and its card in a portal on `document.body` (so the
 * shell's own DOM, which the visual oracle measures, is unchanged).
 */
export function TourHost() {
  const run = useTourRun();
  return (
    <>
      <TourGate />
      {run ? <TourOverlay key={run.key} run={run} /> : null}
    </>
  );
}

/** How long the gate waits for the setup wizard to open (it opens itself after its own read). */
const WIZARD_WAIT_MS = 4_000;
/** How long a step looks for its anchor before it shows its centred card (or is skipped). */
const ANCHOR_WAIT_MS = 1_800;

function setupSkippedInThisTab(): boolean {
  try {
    return sessionStorage.getItem(SKIPPED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Opens the pending tours once per page load (`GET /api/tutorial` → `autoOpen`
 * and what is pending): after the setup wizard when it opens by itself, and
 * never over another modal. Renders nothing.
 */
function TourGate() {
  const { modal } = useModals();
  const { route } = useRouter();
  const [pending, setPending] = useState<string[] | null>(null);
  const [wizard, setWizard] = useState<'none' | 'waiting' | 'open'>('none');

  useEffect(() => {
    let cancelled = false;
    // The first-run check is asked only when a tour is pending and the wizard was not closed in this tab
    // (a tab where it was skipped never asks `GET /api/setup` again: setup-wizard.spec).
    api.tutorial().then(
      async (state) => {
        const tours = pendingTours(state);
        if (cancelled || tours.length === 0) return;
        const setup = setupSkippedInThisTab() ? null : await api.setup().catch(() => null);
        if (cancelled) return;
        setWizard(setup?.autoOpen ? 'waiting' : 'none');
        setPending(tours);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (wizard !== 'waiting') return undefined;
    // The wizard did not open (another modal was up): stop waiting for it.
    const timer = setTimeout(() => setWizard((current) => (current === 'waiting' ? 'none' : current)), WIZARD_WAIT_MS);
    return () => clearTimeout(timer);
  }, [wizard]);

  useEffect(() => {
    if (!pending) return;
    if (modal === 'setup-wizard') {
      setWizard('open');
      return;
    }
    if (wizard === 'waiting' || modal !== null || route.view === 'share' || tourRunning()) return;
    setPending(null);
    startTours(pending, { replay: false });
  }, [pending, modal, wizard, route.view]);

  return null;
}

/** `true` when the user asked for less motion. */
function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The first `data-tour` element of `names` that is on screen (laid out, not inside an inert or hidden pane). */
export function findAnchor(names: readonly string[]): HTMLElement | null {
  for (const name of names) {
    for (const element of document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(name)}"]`)) {
      if (element.closest('[inert], [aria-hidden="true"]')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return element;
    }
  }
  return null;
}

function boxOf(element: HTMLElement): Box {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function sameBox(a: Box | null, b: Box | null): boolean {
  return a === b || (!!a && !!b && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5);
}

function useViewport(): { readonly width: number; readonly height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = (): void => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

/** Where a step stands: looking for its element, spotlighting it, or a centred card (no element). */
type Resolved = { readonly state: 'looking' } | { readonly state: 'spot'; readonly element: HTMLElement } | { readonly state: 'centre' };

/** The route a step goes to (`session` = the newest open session; `null` = none to go to). */
async function routeOf(step: TourStep): Promise<Route | 'none' | null> {
  const target = step.route;
  if (!target) return null;
  if (target.view === 'session') {
    const sessions = await api.listSessions().catch(() => []);
    const first = openSessions(sessions)[0];
    return first ? { view: 'session', id: first.id, tab: 'chat' } : 'none';
  }
  if (target.view === 'settings') return { view: 'settings', section: target.section };
  return { view: target.view };
}

/**
 * The running tour: a dimmed page with a rounded cutout over the step's element
 * (moving smoothly between steps unless reduced motion is asked for) and the
 * card next to it (a bottom sheet on phones), or a centred card when the
 * element is not there. Back · Next · Skip tour, → ← Esc; focus stays in the
 * card; a live region reads each step.
 */
function TourOverlay({ run }: { readonly run: TourRun }) {
  const { route, navigate } = useRouter();
  const panes = usePanes();
  const viewport = useViewport();
  const phone = panes.layout === 'phone';

  const [tourIndex, setTourIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [resolved, setResolved] = useState<Resolved>({ state: 'looking' });
  const [box, setBox] = useState<Box | null>(null);
  const direction = useRef<1 | -1>(1);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [cardSize, setCardSize] = useState({ width: 360, height: 260 });

  // What to give back when the tour ends: the page, the sidebar, the focus.
  const start = useRef({ route, sidebarHidden: panes.state.sidebarHidden, focus: document.activeElement as HTMLElement | null });
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const tourId = run.tours[tourIndex] ?? run.tours[0] ?? 'main';
  const steps = stepsOf(tourId);
  const step = steps[stepIndex];

  const finish = useCallback(() => {
    const before = start.current;
    navigateRef.current(before.route);
    const { compact, setHidden, state } = panesRef.current;
    if (compact) {
      if (!state.sidebarHidden) setHidden('sidebar', true);
    } else if (state.sidebarHidden !== before.sidebarHidden) {
      setHidden('sidebar', before.sidebarHidden);
    }
    endTours();
    requestAnimationFrame(() => before.focus?.focus?.({ preventScroll: true }));
  }, []);

  const record = useCallback(
    (id: string, status: 'completed' | 'skipped') => {
      if (!run.replay) void api.recordTour(id, { status }).catch(() => undefined);
    },
    [run.replay],
  );

  /** Ends the current tour (`status`) and moves to the next one in the chain, or finishes. */
  const endTour = useCallback(
    (status: 'completed' | 'skipped') => {
      record(tourId, status);
      if (tourIndex + 1 < run.tours.length) {
        direction.current = 1;
        setTourIndex(tourIndex + 1);
        setStepIndex(0);
        setResolved({ state: 'looking' });
      } else {
        finish();
      }
    },
    [finish, record, run.tours.length, tourId, tourIndex],
  );

  const next = useCallback(() => {
    direction.current = 1;
    if (stepIndex + 1 < steps.length) {
      setStepIndex(stepIndex + 1);
      setResolved({ state: 'looking' });
    } else endTour('completed');
  }, [endTour, stepIndex, steps.length]);

  const back = useCallback(() => {
    if (stepIndex === 0) return;
    direction.current = -1;
    setStepIndex(stepIndex - 1);
    setResolved({ state: 'looking' });
  }, [stepIndex]);

  const skipAll = useCallback(() => {
    for (const id of run.tours.slice(tourIndex)) record(id, 'skipped');
    finish();
  }, [finish, record, run.tours, tourIndex]);

  // Go where the step is, open or close the drawer, then look for its element.
  useEffect(() => {
    if (!step) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const skipOrCentre = (): void => {
      if (cancelled) return;
      if (step.missing !== null) {
        setResolved({ state: 'centre' });
        return;
      }
      // An optional step without its element is skipped in the direction of travel.
      if (direction.current === -1 && stepIndex > 0) setStepIndex(stepIndex - 1);
      else if (stepIndex + 1 < steps.length) setStepIndex(stepIndex + 1);
      else {
        endTour('completed');
        return;
      }
      setResolved({ state: 'looking' });
    };
    void (async () => {
      const target = await routeOf(step);
      if (cancelled) return;
      const { compact, setHidden, state } = panesRef.current;
      if (step.drawer) {
        if (state.sidebarHidden) setHidden('sidebar', false);
      } else if (compact && !state.sidebarHidden) {
        setHidden('sidebar', true);
      }
      if (target === 'none') {
        skipOrCentre();
        return;
      }
      if (target) navigateRef.current(target);
      const deadline = Date.now() + ANCHOR_WAIT_MS;
      const look = (): void => {
        if (cancelled) return;
        const element = findAnchor(step.anchors);
        if (element) {
          element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
          setResolved({ state: 'spot', element });
          return;
        }
        if (Date.now() >= deadline) skipOrCentre();
        else timer = setTimeout(look, 80);
      };
      // Let the route and the drawer render first.
      timer = setTimeout(look, 60);
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // The step's identity is (tour, step); `endTour` and `steps` change with them.
  }, [tourIndex, stepIndex]);

  // Follow the element (scrolling, a drawer sliding in, a resize) every frame.
  useLayoutEffect(() => {
    // While the next step looks for its element the cutout stays where it was, then moves there.
    if (resolved.state === 'looking') return undefined;
    if (resolved.state === 'centre') {
      setBox(null);
      return undefined;
    }
    let frame = 0;
    const tick = (): void => {
      const next = resolved.element.isConnected ? boxOf(resolved.element) : null;
      setBox((current) => (sameBox(current, next) ? current : next));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [resolved]);

  // The card's own size, for placing it.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    if (Math.abs(rect.width - cardSize.width) > 1 || Math.abs(rect.height - cardSize.height) > 1) setCardSize({ width: rect.width, height: rect.height });
  });

  // Focus the card's main button on each step (the card keeps it: a focus trap below).
  useEffect(() => {
    if (resolved.state === 'looking') return;
    nextRef.current?.focus({ preventScroll: true });
  }, [resolved, tourIndex, stepIndex]);

  // → ← Esc anywhere while the tour runs (before the app's own keys: ⌘K and Esc do not reach the page).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (resolved.state !== 'looking') next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (resolved.state !== 'looking') back();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        endTour('skipped');
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
      } else {
        return;
      }
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [back, endTour, next, resolved.state]);

  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab' || !cardRef.current) return;
    const focusable = [...cardRef.current.querySelectorAll<HTMLElement>('button:not([disabled])')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!step) return null;
  const spot = box ? spotBox(box, viewport) : null;
  const centre = resolved.state === 'centre' || (resolved.state === 'spot' && !spot);
  const last = stepIndex + 1 === steps.length;
  const moreTours = run.tours.length - tourIndex - 1;
  const progress = `${stepIndex + 1} of ${steps.length}`;
  const kicker = kickerOf(tourId, tourIndex, run.tours.length);
  const titleId = 'sb-tour-title';
  const bodyId = 'sb-tour-body';

  let cardStyle: CSSProperties | undefined;
  let placement = 'centre';
  if (phone) {
    placement = `sheet-${sheetEdge(centre ? null : spot, viewport.height)}`;
  } else if (!centre && spot) {
    const placed = placeCard(spot, cardSize, viewport);
    cardStyle = { top: placed.top, left: placed.left };
    placement = placed.placement;
  }

  return createPortal(
    <div className="sb-tour" data-testid="tour" data-tour-id={tourId} data-step={step.id} data-state={resolved.state} data-layout={panes.layout} data-motion={reducedMotion() ? 'reduced' : 'full'}>
      {/* Explain-only: the page under the tour takes no clicks. */}
      <div className="sb-tour-blocker" data-dim={spot && !centre ? undefined : 'true'} aria-hidden="true" />
      {spot && !centre ? <div className="sb-tour-spot" data-testid="tour-spot" aria-hidden="true" style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }} /> : null}
      <div
        ref={cardRef}
        className="sb-tour-card"
        data-testid="tour-card"
        data-placement={placement}
        data-mode={centre ? 'centre' : 'spot'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-looking={resolved.state === 'looking' ? 'true' : undefined}
        style={cardStyle}
        onKeyDown={trapFocus}
      >
        <div className="sb-tour-kicker" data-testid="tour-kicker">
          {kicker}
        </div>
        <h2 className="sb-tour-title" id={titleId} data-testid="tour-title">
          {step.title}
        </h2>
        <div id={bodyId}>
          <p className="sb-tour-what" data-testid="tour-what">
            {step.what}
          </p>
          {centre && step.missing ? (
            <p className="sb-tour-missing" data-testid="tour-missing">
              {step.missing}
            </p>
          ) : null}
          <div className="sb-tour-label">What to do</div>
          <ol className="sb-tour-todo" data-testid="tour-todo">
            {step.todo.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </div>
        <div className="sb-tour-foot">
          <span className="sb-tour-progress" data-testid="tour-progress">
            {progress}
          </span>
          <span className="sb-tour-actions">
            {moreTours > 0 ? (
              <button type="button" className="sb-button sb-tour-link" data-testid="tour-skip-all" onClick={skipAll}>
                Skip all
              </button>
            ) : null}
            <button type="button" className="sb-button sb-tour-link" data-testid="tour-skip" onClick={() => endTour('skipped')}>
              Skip tour
            </button>
            <button type="button" className="sb-button sb-tour-outlined" data-testid="tour-back" disabled={stepIndex === 0} onClick={back}>
              Back
            </button>
            <button type="button" ref={nextRef} className="sb-button sb-tour-primary" data-testid="tour-next" onClick={next}>
              {last ? (moreTours > 0 ? 'Next tour' : 'Done') : 'Next'}
            </button>
          </span>
        </div>
      </div>
      <div className="sb-visually-hidden" aria-live="polite" data-testid="tour-live">
        {resolved.state === 'looking' ? '' : `${kicker}, step ${progress}: ${step.title}`}
      </div>
    </div>,
    document.body,
  );
}
