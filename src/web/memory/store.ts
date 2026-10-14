import { useSyncExternalStore } from 'react';
import type { MemoryScope } from '../../core/memory.ts';
import { onHubEvent, onHubStatus } from '../api/useHub.ts';
import { memoryApi } from './api.ts';

/**
 * D107 · what the page knows of Project memory on this machine: the switch
 * (`GET /api/memory/state`, answered while off too) and, while on, the folders with their counts
 * (`GET /api/memory/scopes`). Shared by the nav's Memory cell (its badge: proposals to review) and
 * the session panel's "Memory: N entries"; read again on `memoryChanged` (coalesced), after the hub
 * reconnects and after Settings changed the switch ({@link reloadMemory}). While off nothing of
 * Project memory renders, so every other page is as it was.
 */
export interface MemoryStoreState {
  readonly on: boolean;
  readonly scopes: readonly MemoryScope[];
  readonly loaded: boolean;
}

const OFF: MemoryStoreState = { on: false, scopes: [], loaded: false };

let current: MemoryStoreState = OFF;
let started = false;
let inFlight: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const local = memoryApi(null);

function set(next: MemoryStoreState): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

async function readOnce(): Promise<void> {
  try {
    const state = await local.state();
    if (!state.enabled || !state.available) {
      set({ on: false, scopes: [], loaded: true });
      return;
    }
    set({ on: true, scopes: await local.scopes(), loaded: true });
  } catch (error) {
    // Off meanwhile, or a build without Project memory (404): nothing of it shows.
    if ((error as { status?: number }).status === 404) set({ on: false, scopes: [], loaded: true });
    else if (!current.loaded) set({ ...current, loaded: true });
  }
}

/** Reads the switch and the folders again (coalesced). */
export function reloadMemory(): Promise<void> {
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
        void reloadMemory();
      }
    }
  })();
  return inFlight;
}

function start(): void {
  if (started) return;
  started = true;
  void reloadMemory();
  onHubEvent('memoryChanged', () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void reloadMemory();
    }, 200);
  });
  onHubStatus((status) => {
    if (status === 'open') void reloadMemory();
  });
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The switch and this machine's folders, live. */
export function useMemory(): MemoryStoreState {
  return useSyncExternalStore(subscribe, () => current, () => OFF);
}

/** Proposals waiting for review on this machine (the nav badge). */
export function proposalCount(scopes: readonly MemoryScope[]): number {
  return scopes.reduce((sum, scope) => sum + scope.proposed, 0);
}
