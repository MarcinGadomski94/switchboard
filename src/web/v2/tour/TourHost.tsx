import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { openSessions } from '../../../core/session-close.ts';
import { type TutorialState, V2_WELCOME_ID, coveredByWelcome, v2AutoTours } from '../../../core/tutorial.ts';
import { api } from '../../api/client.ts';
import { useLayout } from '../../shell/useLayout.ts';
import { type Box, placeCard, sheetEdge, spotBox } from '../../tutorial/tour.ts';
import { Button, Portal } from '../components/index.ts';
import { TOUR_WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { type V2TourRun, endV2Tours, missingMove, nextLabel, startV2Tours, useV2TourRun, v2KickerOf, v2PathOf, v2StepsOf, v2TourRunning } from './tour-model.ts';
import './tour.css';

/**
 * D131 · lane X · the v2 theme's tour host (`docs/tutorial.md` → *Two themes*):
 * the gate (opens "Welcome to Switchboard 2" once per machine on the first v2
 * load) and, while a v2 tour runs, the dimmed page with a rounded cutout over a
 * `data-tour` anchor of a v2 page and the card next to it (a bottom sheet on
 * phones), rendered through the v2 `Portal`. Mounted by `shell/Shell.tsx`.
 */
export function V2TourHost() {
  const run = useV2TourRun();
  return (
    <>
      <V2TourGate />
      {run ? <V2TourOverlay key={run.key} run={run} /> : null}
    </>
  );
}

/** How long a step looks for its anchor before its centred card (or a skip). */
const ANCHOR_WAIT_MS = 1_800;
/** How long the gate waits for an open dialog to close before it tries again. */
const GATE_RETRY_MS = 500;

/** `true` while a v2 dialog, sheet or the palette is open (the tour never opens over one). */
function modalOpen(): boolean {
  return document.querySelector('.sb2 [aria-modal="true"]') !== null;
}

/**
 * Reads `GET /api/tutorial` once per page load and opens the v2 tours due
 * (`v2AutoTours`): the welcome tour when it was never shown on this machine, or
 * a pending v2 tour. Waits for open dialogs; never on the share page. Renders nothing.
 */
function V2TourGate() {
  const { pathname } = useV2Router();
  const [due, setDue] = useState<{ readonly tours: string[]; readonly state: TutorialState } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.tutorial().then(
      (state) => {
        const tours = v2AutoTours(state);
        if (!cancelled && tours.length > 0) setDue({ tours, state });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!due) return undefined;
    if (pathname.startsWith('/share') || v2TourRunning() || modalOpen()) {
      const timer = setTimeout(() => setTick((n) => n + 1), GATE_RETRY_MS);
      return () => clearTimeout(timer);
    }
    setDue(null);
    startV2Tours(due.tours, { replay: false, covers: due.tours.includes(V2_WELCOME_ID) ? coveredByWelcome(due.state) : [] });
    return undefined;
  }, [due, pathname, tick]);

  return null;
}

/** `true` when the user asked for less motion. */
function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The first `data-tour` element of `names` on screen (laid out, not inside an inert or hidden part, not inside the tour itself). */
export function findV2Anchor(names: readonly string[]): HTMLElement | null {
  for (const name of names) {
    for (const element of document.querySelectorAll<HTMLElement>(`.sb2 [data-tour="${CSS.escape(name)}"]`)) {
      if (element.closest('[inert], [aria-hidden="true"], .v2-tour')) continue;
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

/** The newest open agent's id (`null` = none). */
async function newestAgent(): Promise<string | null> {
  const sessions = await api.listSessions().catch(() => []);
  return openSessions(sessions)[0]?.id ?? null;
}

type Resolved = { readonly state: 'looking' } | { readonly state: 'spot'; readonly element: HTMLElement } | { readonly state: 'centre' };

/**
 * The running v2 tour: Back · Next (Done) · Skip tour (Skip all in a chain),
 * → ← Esc, focus kept in the card and given back at the end, the page and its
 * address restored, a polite live region per step.
 */
function V2TourOverlay({ run }: { readonly run: V2TourRun }) {
  const { pathname, search, navigate } = useV2Router();
  const layout = useLayout();
  const phone = layout === 'phone';
  const viewport = useViewport();

  const [tourIndex, setTourIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [resolved, setResolved] = useState<Resolved>({ state: 'looking' });
  const [box, setBox] = useState<Box | null>(null);
  const direction = useRef<1 | -1>(1);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [cardSize, setCardSize] = useState({ width: 380, height: 280 });

  const start = useRef({ path: `${pathname}${search}`, focus: document.activeElement as HTMLElement | null });
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const tourId = run.tours[tourIndex] ?? run.tours[0] ?? V2_WELCOME_ID;
  const steps = v2StepsOf(tourId);
  const step = steps[stepIndex];

  const finish = useCallback(() => {
    const before = start.current;
    navigateRef.current(before.path);
    endV2Tours();
    requestAnimationFrame(() => before.focus?.focus?.({ preventScroll: true }));
  }, []);

  const record = useCallback(
    (id: string, status: 'completed' | 'skipped') => {
      if (run.replay) return;
      void api.recordTour(id, { status }).catch(() => undefined);
      // The welcome tells what these classic tours would (D132's graduation, the theme switch).
      if (id === V2_WELCOME_ID) for (const covered of run.covers) void api.recordTour(covered, { status }).catch(() => undefined);
    },
    [run.covers, run.replay],
  );

  const endTour = useCallback(
    (status: 'completed' | 'skipped') => {
      record(tourId, status);
      if (tourIndex + 1 < run.tours.length) {
        direction.current = 1;
        setTourIndex(tourIndex + 1);
        setStepIndex(0);
        setResolved({ state: 'looking' });
      } else finish();
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

  // Go to the step's page, then look for its anchor.
  useEffect(() => {
    if (!step) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const missing = (): void => {
      if (cancelled) return;
      const move = missingMove(step, stepIndex, steps.length, direction.current);
      if (move.kind === 'centre') setResolved({ state: 'centre' });
      else if (move.kind === 'end') endTour('completed');
      else {
        setStepIndex(move.index);
        setResolved({ state: 'looking' });
      }
    };
    void (async () => {
      const target = v2PathOf(step, step.v2Route === 'agent' ? await newestAgent() : null);
      if (cancelled) return;
      if (target === 'none') {
        missing();
        return;
      }
      if (target) navigateRef.current(target);
      const deadline = Date.now() + ANCHOR_WAIT_MS;
      const look = (): void => {
        if (cancelled) return;
        const element = findV2Anchor(step.anchors);
        if (element) {
          element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
          setResolved({ state: 'spot', element });
          return;
        }
        if (Date.now() >= deadline) missing();
        else timer = setTimeout(look, 80);
      };
      timer = setTimeout(look, 60);
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // A step's identity is (tour, step).
  }, [tourIndex, stepIndex]);

  // Follow the element every frame (scrolling, a resize, a page settling).
  useLayoutEffect(() => {
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

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    if (Math.abs(rect.width - cardSize.width) > 1 || Math.abs(rect.height - cardSize.height) > 1) setCardSize({ width: rect.width, height: rect.height });
  });

  useEffect(() => {
    if (resolved.state === 'looking') return;
    nextRef.current?.focus({ preventScroll: true });
  }, [resolved, tourIndex, stepIndex]);

  // → ← Esc while the tour runs, before the shell's own keys (⌘K, ?, ⌘. do not reach the page).
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
      } else if ((event.metaKey || event.ctrlKey) && /^[k.\\]$/i.test(event.key)) {
        event.preventDefault();
      } else return;
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
  const moreTours = run.tours.length - tourIndex - 1;
  const progress = TOUR_WORDS.step(stepIndex + 1, steps.length);
  const kicker = v2KickerOf(tourId, tourIndex, run.tours.length);

  let cardStyle: CSSProperties | undefined;
  let placement = 'centre';
  if (phone) placement = `sheet-${sheetEdge(centre ? null : spot, viewport.height)}`;
  else if (!centre && spot) {
    const placed = placeCard(spot, cardSize, viewport);
    cardStyle = { top: placed.top, left: placed.left };
    placement = placed.placement;
  }

  return (
    <Portal>
      <div className="v2-tour" data-testid="v2-tour" data-tour-id={tourId} data-step={step.id} data-state={resolved.state} data-layout={layout}>
        {/* Explain-only: the page under the tour takes no clicks. */}
        <div className="v2-tour-blocker" data-dim={spot && !centre ? undefined : 'true'} aria-hidden="true" />
        {spot && !centre ? <div className="v2-tour-spot" data-testid="v2-tour-spot" aria-hidden="true" style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }} /> : null}
        <div
          ref={cardRef}
          className="v2-tour-card"
          data-testid="v2-tour-card"
          data-placement={placement}
          data-mode={centre ? 'centre' : 'spot'}
          data-looking={resolved.state === 'looking' ? 'true' : undefined}
          role="dialog"
          aria-modal="true"
          aria-labelledby="v2-tour-title"
          aria-describedby="v2-tour-body"
          style={cardStyle}
          onKeyDown={trapFocus}
        >
          <div className="v2-tour-kicker" data-testid="v2-tour-kicker">
            {kicker}
          </div>
          <h2 className="v2-tour-title" id="v2-tour-title" data-testid="v2-tour-title">
            {step.title}
          </h2>
          <div id="v2-tour-body">
            <p className="v2-tour-what">{step.what}</p>
            {centre && step.missing ? (
              <p className="v2-tour-missing" data-testid="v2-tour-missing">
                {step.missing}
              </p>
            ) : null}
            <div className="v2-tour-label">{TOUR_WORDS.whatToDo}</div>
            <ol className="v2-tour-todo">
              {step.todo.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          </div>
          <div className="v2-tour-foot">
            <span className="v2-tour-progress" data-testid="v2-tour-progress">
              {progress}
            </span>
            <span className="v2-tour-actions">
              {moreTours > 0 ? (
                <Button variant="ghost" size="sm" onClick={skipAll} data-testid="v2-tour-skip-all">
                  {TOUR_WORDS.skipAll}
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => endTour('skipped')} data-testid="v2-tour-skip">
                {TOUR_WORDS.skip}
              </Button>
              <Button size="sm" disabled={stepIndex === 0} onClick={back} data-testid="v2-tour-back">
                {TOUR_WORDS.back}
              </Button>
              <Button ref={nextRef} size="sm" variant="primary" onClick={next} data-testid="v2-tour-next">
                {nextLabel(stepIndex, steps.length, moreTours, TOUR_WORDS)}
              </Button>
            </span>
          </div>
        </div>
        <div className="v2-tour-live" aria-live="polite" data-testid="v2-tour-live">
          {resolved.state === 'looking' ? '' : TOUR_WORDS.live(kicker, stepIndex + 1, steps.length, step.title)}
        </div>
      </div>
    </Portal>
  );
}

/** Replays v2 tours (Settings › Advanced › What's new tours, ⌘K). Records nothing. */
export function replayV2Tours(ids: readonly string[]): void {
  startV2Tours(ids, { replay: true });
}
