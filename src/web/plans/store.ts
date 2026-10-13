import { useSyncExternalStore } from 'react';
import type { Plan } from '../../core/plans.ts';
import { onHubEvent, onHubStatus } from '../api/useHub.ts';
import { isPlansOff, plansApi } from './api.ts';

/**
 * D99 · what the page knows of Plans: the switch (Settings → Experimental → Plans, off by
 * default) and the plans list (`GET /api/plans`, which answers 404 `plans-off` while the
 * switch is off). One read shared by the nav's Plans item, the Plans list, the session's
 * Plan tab and the What's-new tour; read again on `planChanged` (coalesced), after the hub
 * reconnects and after Settings changed the switch ({@link reloadPlans}). While off,
 * nothing of Plans renders, so every other page is as it was.
 */
export interface PlansState {
  /** Plans is on (the page, its nav entry, the session's Plan tab show). */
  readonly on: boolean;
  /** The plans (this machine's, then the paired machines'); empty while off. */
  readonly plans: readonly Plan[];
  /** The first read is over. */
  readonly loaded: boolean;
}

const OFF: PlansState = { on: false, plans: [], loaded: false };

let current: PlansState = OFF;
let started = false;
let inFlight: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

/** `planChanged` events reload the list at most this often. */
const RELOAD_MS = 250;

function set(next: PlansState): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

async function readOnce(): Promise<void> {
  try {
    const plans = await plansApi.list();
    set({ on: true, plans: Array.isArray(plans) ? plans : [], loaded: true });
  } catch (error) {
    // Off (404 plans-off, or a build without Plans: any 404) → nothing of Plans shows.
    if (isPlansOff(error) || (error as { status?: number }).status === 404) set({ on: false, plans: [], loaded: true });
    else if (!current.loaded) set({ ...current, loaded: true });
  }
}

/** Reads the switch and the list again (coalesced: one more read after a running one). */
export function reloadPlans(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      await readOnce();
    } finally {
      inFlight = null;
      if (again) {
        again = false;
        void reloadPlans();
      }
    }
  })();
  return inFlight;
}

function soon(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void reloadPlans();
  }, RELOAD_MS);
}

function start(): void {
  if (started) return;
  started = true;
  void reloadPlans();
  onHubEvent('planChanged', soon);
  onHubStatus((status) => {
    if (status === 'open') void reloadPlans();
  });
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The switch and the plans, live. */
export function usePlans(): PlansState {
  return useSyncExternalStore(subscribe, () => current, () => OFF);
}

/** Puts a plan the server answered into the list at once (the next read confirms it). */
export function putPlan(plan: Plan): void {
  const at = current.plans.findIndex((candidate) => candidate.id === plan.id);
  const plans = at < 0 ? [...current.plans, plan] : current.plans.map((candidate, index) => (index === at ? plan : candidate));
  set({ ...current, plans });
}

/** Drops a deleted plan from the list at once. */
export function dropPlan(id: string): void {
  set({ ...current, plans: current.plans.filter((plan) => plan.id !== id) });
}
