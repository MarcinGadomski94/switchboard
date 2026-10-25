import { useSyncExternalStore } from 'react';
import { type TourStep, type WhatsNewFeature, WHATS_NEW, isV2Tour } from '../../../core/tutorial.ts';

/**
 * D131 · lane X · the v2 theme's tour runs (`docs/tutorial.md` → *Two themes*):
 * which v2 tours run, whether it is a replay, and the classic tours to record
 * with the welcome's outcome. A small external store (the classic one,
 * `src/web/tutorial/tour.ts`, never runs v2 tours), plus the pure rules the host
 * uses. DOM-free: unit-tested in `tests/web/v2-tour.test.ts`.
 */

/** A v2 tour run. */
export interface V2TourRun {
  /** The v2 tours, in order. */
  readonly tours: readonly string[];
  /** Started from Settings or ⌘K: nothing is recorded. */
  readonly replay: boolean;
  /** Classic tours recorded with the welcome's outcome when it opened by itself (`coveredByWelcome`). */
  readonly covers: readonly string[];
  /** Changes with every start, so the same tours restart. */
  readonly key: number;
}

let run: V2TourRun | null = null;
let counter = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The v2 tours among `ids` (unknown and classic ids dropped). */
export function v2ToursOf(ids: readonly string[], registry: readonly WhatsNewFeature[] = WHATS_NEW): string[] {
  return ids.filter((id) => isV2Tour(id, registry));
}

/** Starts the v2 tours among `tours` (none = nothing starts). */
export function startV2Tours(tours: readonly string[], options: { readonly replay: boolean; readonly covers?: readonly string[] }): void {
  const known = v2ToursOf(tours);
  if (known.length === 0) return;
  counter += 1;
  run = { tours: known, replay: options.replay, covers: options.replay ? [] : (options.covers ?? []), key: counter };
  notify();
}

/** Ends the running v2 tour (if any). */
export function endV2Tours(): void {
  if (run === null) return;
  run = null;
  notify();
}

/** The running v2 tour, live. */
export function useV2TourRun(): V2TourRun | null {
  return useSyncExternalStore(subscribe, () => run);
}

/** `true` while a v2 tour runs. */
export function v2TourRunning(): boolean {
  return run !== null;
}

/** A v2 tour's steps (`[]` for an unknown or classic id). */
export function v2StepsOf(id: string, registry: readonly WhatsNewFeature[] = WHATS_NEW): readonly TourStep[] {
  return registry.find((feature) => feature.id === id && feature.ui === 'v2')?.steps ?? [];
}

/** The v2 tours of the registry (Settings › Advanced › What's new tours lists them). */
export function v2Features(registry: readonly WhatsNewFeature[] = WHATS_NEW): WhatsNewFeature[] {
  return registry.filter((feature) => feature.ui === 'v2');
}

/** The small line over the card's title: "What's new · <tour>" (with its place in a chain of several). */
export function v2KickerOf(id: string, index: number, count: number, registry: readonly WhatsNewFeature[] = WHATS_NEW): string {
  const title = registry.find((feature) => feature.id === id)?.title ?? id;
  return count > 1 ? `What’s new · ${title} (${index + 1} of ${count})` : `What’s new · ${title}`;
}

/**
 * Where a step goes first: a v2 path, `'none'` when it wants the newest open
 * agent and there is none, or `null` (stay). `newestAgent` is the newest open
 * agent's id (`null` = none).
 */
export function v2PathOf(step: TourStep, newestAgent: string | null): string | 'none' | null {
  const target = step.v2Route;
  if (!target) return null;
  if (target === 'agent') return newestAgent ? `/agents/${encodeURIComponent(newestAgent)}` : 'none';
  return target;
}

/** What a step does when its anchor is not on screen: a centred card (`missing` text) or skip it in the direction of travel. */
export type MissingMove = { readonly kind: 'centre' } | { readonly kind: 'step'; readonly index: number } | { readonly kind: 'end' };

/** The move for a step without its anchor (`index` of `count`, travelling `direction`). */
export function missingMove(step: TourStep, index: number, count: number, direction: 1 | -1): MissingMove {
  if (step.missing !== null) return { kind: 'centre' };
  if (direction === -1 && index > 0) return { kind: 'step', index: index - 1 };
  if (index + 1 < count) return { kind: 'step', index: index + 1 };
  return { kind: 'end' };
}

/** The main button's word: Next, Next tour (a chain), or Done. */
export function nextLabel(stepIndex: number, stepCount: number, moreTours: number, words: { readonly next: string; readonly nextTour: string; readonly done: string }): string {
  if (stepIndex + 1 < stepCount) return words.next;
  return moreTours > 0 ? words.nextTour : words.done;
}
