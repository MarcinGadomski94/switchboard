import { useEffect, useSyncExternalStore } from 'react';
import type { Tool } from '../../core/api.ts';
import { api } from '../api/client.ts';

/**
 * Reachability of the embedded tools (M8.1), shared by the sidebar's TOOLS rows
 * and the tool view, as in the prototype (`tstate` + `probe`): `unset` (no URL),
 * `idle` (not probed yet), `checking`, `up`, `down`. The probe itself runs on the
 * service (`POST /api/tools/{id}/probe`, a GET with a 3 s timeout), so the page
 * never fetches the tool's origin. States live for the page's lifetime and are
 * keyed by tool id + URL, so a changed URL starts over at `idle`.
 */
export type ToolState = 'unset' | 'idle' | 'checking' | 'up' | 'down';

/** Dot color per state (prototype `tdot`: C.done / C.fail / C.need / #8d8c87 / #5a5955). */
export const TOOL_DOT: Readonly<Record<ToolState, string>> = {
  up: 'var(--status-done)',
  down: 'var(--status-fail)',
  checking: 'var(--status-need)',
  idle: 'var(--muted-2)',
  unset: 'var(--status-idle)',
};

/** The toolbar's state text (prototype `tool.state`). */
export const TOOLBAR_STATE: Readonly<Record<ToolState, string>> = {
  up: 'connected',
  down: 'offline',
  checking: 'checking…',
  idle: '',
  unset: 'not configured',
};

type ProbeTarget = Pick<Tool, 'id' | 'url'>;

const states = new Map<string, ToolState>();
/** D15: keys whose last probe said the tool refuses to be framed and no framing proxy runs for it. */
const refused = new Set<string>();
const latest = new Map<string, number>();
const listeners = new Set<() => void>();
let sequence = 0;

function keyOf(tool: ProbeTarget): string {
  return `${tool.id}\n${tool.url ?? ''}`;
}

function set(key: string, state: ToolState): void {
  states.set(key, state);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The state of `tool` right now. As in the prototype (`tstate[id] || 'idle'`), a
 * tool reads `idle` until it is probed, even without a URL; probing a tool without
 * a URL (opening its view) makes it `unset`.
 */
export function toolState(tool: ProbeTarget | null | undefined): ToolState {
  if (!tool) return 'unset';
  const stored = states.get(keyOf(tool));
  if (!tool.url) return stored === 'unset' ? 'unset' : 'idle';
  return stored ?? 'idle';
}

/**
 * Probes `tool` (prototype `probe(id)`): no URL → `unset` without a request;
 * otherwise `checking`, then `up` / `down` from the service. A failed call counts
 * as `down`. When probes overlap, only the newest one's answer is kept.
 */
export async function probeTool(tool: ProbeTarget): Promise<ToolState> {
  const key = keyOf(tool);
  if (!tool.url) {
    latest.delete(key);
    set(key, 'unset');
    return 'unset';
  }
  const mine = ++sequence;
  latest.set(key, mine);
  set(key, 'checking');
  let result: ToolState;
  let framingRefused = false;
  try {
    const probe = await api.probeTool(tool.id);
    result = probe.state === 'up' ? 'up' : 'down';
    framingRefused = probe.framing === 'refused';
  } catch {
    result = 'down';
  }
  if (latest.get(key) === mine) {
    if (framingRefused) refused.add(key);
    else refused.delete(key);
    set(key, result);
  }
  return toolState(tool);
}

/**
 * D15: `true` when the last probe of `tool` found it up but refusing to be framed
 * (`X-Frame-Options` / `frame-ancestors`) with no framing proxy running for it, so
 * the tool view offers New tab instead of a blank frame. Only a fallback: with its
 * proxy running the service never reports it.
 */
export function toolFramingRefused(tool: ProbeTarget | null | undefined): boolean {
  return !!tool?.url && toolState(tool) === 'up' && refused.has(keyOf(tool));
}

/** Re-renders on every probe change and returns {@link toolFramingRefused} of `tool`. */
export function useToolFramingRefused(tool: ProbeTarget | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => toolFramingRefused(tool));
}

/** Re-renders on every probe change and returns the state of `tool`. */
export function useToolState(tool: ProbeTarget | null | undefined): ToolState {
  return useSyncExternalStore(subscribe, () => toolState(tool));
}

/**
 * Probes each configured tool once per page load (the prototype probes its tools
 * when the app mounts), so the sidebar dots show reachability. Tools already
 * probed (e.g. by the tool view) are left alone.
 */
export function useProbeOnLoad(tools: readonly ProbeTarget[] | null): void {
  useEffect(() => {
    for (const tool of tools ?? []) {
      if (tool.url && !states.has(keyOf(tool))) void probeTool(tool);
    }
  }, [tools]);
}
