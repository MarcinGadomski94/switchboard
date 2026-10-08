import { useSyncExternalStore } from 'react';
import { MAIN_TOUR_ID, WHATS_NEW, type TourRecord, type TourStep, tourSteps } from '../../core/tutorial.ts';

/**
 * D85 · the running tour (`docs/tutorial.md`): which tours run (the main tour,
 * or a chain of What's-new mini-tours) and whether it is a replay. A small
 * external store, so Settings, the ⌘K palette and the first-run gate start a
 * tour without a provider around the app. Plus the pure geometry of the card.
 */

/** A tour run: the tours in order (each recorded when it ends, unless `replay`). */
export interface TourRun {
  readonly tours: readonly string[];
  /** Started from Settings or ⌘K: nothing is recorded (the stored state stays what it was). */
  readonly replay: boolean;
  /** Changes with every start, so starting the same tours again restarts them. */
  readonly key: number;
}

let run: TourRun | null = null;
let counter = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Starts `tours` (unknown ids are dropped; none left = nothing starts). */
export function startTours(tours: readonly string[], options: { readonly replay: boolean }): void {
  const known = tours.filter((id) => tourSteps(id) !== null);
  if (known.length === 0) return;
  counter += 1;
  run = { tours: known, replay: options.replay, key: counter };
  notify();
}

/** Ends the running tour (if any). */
export function endTours(): void {
  if (run === null) return;
  run = null;
  notify();
}

/** The running tour, live. */
export function useTourRun(): TourRun | null {
  return useSyncExternalStore(subscribe, () => run);
}

/** `true` while a tour runs (outside React). */
export function tourRunning(): boolean {
  return run !== null;
}

/** The steps of a tour id (the main tour for an unknown one, which {@link startTours} never lets through). */
export function stepsOf(id: string): readonly TourStep[] {
  return tourSteps(id) ?? [];
}

/** The small line over a card's title: "Tour", or "What's new · <feature>" (with its place in a chain of several). */
export function kickerOf(id: string, index: number, count: number): string {
  if (id === MAIN_TOUR_ID) return 'Tour';
  const title = WHATS_NEW.find((feature) => feature.id === id)?.title ?? id;
  return count > 1 ? `What's new · ${title} (${index + 1} of ${count})` : `What's new · ${title}`;
}

/** How a tour's stored state reads in its Settings row. */
export function tourStatusText(record: TourRecord | null): string {
  switch (record?.status ?? null) {
    case 'completed':
      return 'seen';
    case 'skipped':
      return 'skipped';
    case 'pending':
      return 'not seen yet';
    default:
      return 'not shown on this machine';
  }
}

// ── geometry ──────────────────────────────────────────────────────────

/** A box in viewport pixels. */
export interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** Room around the highlighted element inside the cutout. */
export const SPOT_PADDING = 6;
/** Gap between the cutout and the card. */
export const CARD_GAP = 14;
/** Distance the card keeps from the window's edges. */
export const EDGE = 12;

/** The cutout around `target`: padded, kept inside the window. */
export function spotBox(target: Box, viewport: { readonly width: number; readonly height: number }): Box {
  const top = Math.max(2, target.top - SPOT_PADDING);
  const left = Math.max(2, target.left - SPOT_PADDING);
  const bottom = Math.min(viewport.height - 2, target.top + target.height + SPOT_PADDING);
  const right = Math.min(viewport.width - 2, target.left + target.width + SPOT_PADDING);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Where the card sits next to the cutout. */
export type Placement = 'right' | 'left' | 'below' | 'above' | 'over';

/**
 * The card's place next to `spot` (a `card`-sized box): to its right, else its
 * left, else below, else above; `over` (bottom-right corner of the window) when
 * none fits. Always inside the window.
 */
export function placeCard(spot: Box, card: { readonly width: number; readonly height: number }, viewport: { readonly width: number; readonly height: number }): { readonly top: number; readonly left: number; readonly placement: Placement } {
  const clampTop = (top: number): number => Math.min(Math.max(EDGE, top), Math.max(EDGE, viewport.height - card.height - EDGE));
  const clampLeft = (left: number): number => Math.min(Math.max(EDGE, left), Math.max(EDGE, viewport.width - card.width - EDGE));
  const midTop = spot.top + spot.height / 2 - card.height / 2;
  const midLeft = spot.left + spot.width / 2 - card.width / 2;
  if (spot.left + spot.width + CARD_GAP + card.width + EDGE <= viewport.width) {
    return { top: clampTop(midTop), left: spot.left + spot.width + CARD_GAP, placement: 'right' };
  }
  if (spot.left - CARD_GAP - card.width >= EDGE) {
    return { top: clampTop(midTop), left: spot.left - CARD_GAP - card.width, placement: 'left' };
  }
  if (spot.top + spot.height + CARD_GAP + card.height + EDGE <= viewport.height) {
    return { top: spot.top + spot.height + CARD_GAP, left: clampLeft(midLeft), placement: 'below' };
  }
  if (spot.top - CARD_GAP - card.height >= EDGE) {
    return { top: spot.top - CARD_GAP - card.height, left: clampLeft(midLeft), placement: 'above' };
  }
  return { top: clampTop(viewport.height - card.height - EDGE), left: clampLeft(viewport.width - card.width - EDGE), placement: 'over' };
}

/** A phone's bottom sheet moves to the top when the highlighted element sits in the lower part of the screen. */
export function sheetEdge(spot: Box | null, viewportHeight: number): 'bottom' | 'top' {
  if (!spot) return 'bottom';
  return spot.top + spot.height / 2 > viewportHeight * 0.5 ? 'top' : 'bottom';
}
