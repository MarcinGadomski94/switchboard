import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Machine, MachineStateEvent, SessionMachine } from '../../core/peers.ts';
import { api } from './client.ts';
import { useHubEvent } from './useHub.ts';

/**
 * Fix · peer reconnects (`docs/peers.md` → *Connection states*): the paired
 * machines' connection status as the page knows it, shared by every note, tag
 * and Settings row: loaded from `GET /api/machines`, then kept live by the
 * `/hub` event `machineState` (and by the answers of Reconnect now).
 */

const machines = new Map<string, Machine>();
const listeners = new Set<() => void>();
let version = 0;
let loading: Promise<void> | null = null;
let loadedAt = 0;

/** A fresh list is fetched when a component asks for a machine and the last one is older than this. */
const STALE_MS = 5_000;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Keeps `machine` as the newest known status (a `machineState` event, a Reconnect now answer); a removed one is forgotten. */
export function rememberMachine(machine: MachineStateEvent): void {
  // Every mounted note / tag hears the same event object: keep (and re-render for) it once.
  if (machines.get(machine.id) === machine) return;
  if (machine.removed) machines.delete(machine.id);
  else machines.set(machine.id, machine);
  notify();
}

/**
 * Calls `onChange` when a paired machine's **state** changes (or it is removed),
 * not on every attempt: lists that carry the state (schedules, loops) read again.
 */
export function useMachineStateChange(onChange: () => void): void {
  const seen = useRef(new Map<string, string>());
  const callback = useRef(onChange);
  callback.current = onChange;
  useHubEvent('machineState', (machine) => {
    const state = machine.removed ? 'removed' : machine.state;
    // (The first event of a machine counts as a change: the list may not have its state yet.)
    if (seen.current.get(machine.id) === state) return;
    seen.current.set(machine.id, state);
    callback.current();
  });
}

/** Keeps a whole `GET /api/machines` list (machines no longer paired are forgotten). */
export function rememberMachines(list: readonly Machine[]): void {
  machines.clear();
  for (const machine of list) machines.set(machine.id, machine);
  loadedAt = Date.now();
  notify();
}

function load(): void {
  if (loading || Date.now() - loadedAt < STALE_MS) return;
  loading = api
    .machines()
    .then((view) => rememberMachines(view.machines))
    .catch(() => undefined)
    .finally(() => {
      loading = null;
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The known status of machine `id` (`null` for this machine, or before it is loaded); live while mounted. */
export function useMachineStatus(id: string | null | undefined): Machine | null {
  useHubEvent('machineState', rememberMachine);
  useEffect(() => {
    if (id) load();
  }, [id]);
  useSyncExternalStore(subscribe, () => version);
  return id ? (machines.get(id) ?? null) : null;
}

/**
 * A session's (or item's) machine with its state brought up to date from the
 * live status, so a block lifts the moment the machine is back (before the
 * session itself is read again). `null` / `undefined` stay as they are.
 */
export function useLiveMachine<T extends SessionMachine | null | undefined>(machine: T): T {
  const status = useMachineStatus(machine?.id);
  if (!machine || !status || status.state === machine.state) return machine;
  return { ...machine, state: status.state } as T;
}

/** The current time, ticking every `ms` while `active` (countdowns). */
export function useNow(active: boolean, ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [active, ms]);
  return now;
}
