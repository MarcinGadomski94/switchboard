import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { MachineState } from '../../../core/peers.ts';
import { api, onDeviceOrigin } from '../../api/client.ts';
import { onHubEvent } from '../../api/useHub.ts';
import { useMachines } from '../../api/useMachines.ts';
import { memoryApi } from '../../memory/api.ts';
import { plansApi } from '../../plans/api.ts';
import { teamApi } from '../../team/api.ts';
import type { AnsweredWhere } from '../glossary.ts';
import type { AnswerAction } from './answer-model.ts';
import { type NeedsItem, itemsOfSession, planIdOf } from './needs-you-model.ts';
import { type NeedsYouSnapshot, type NeedsYouStore, UNDO_WINDOW_MS, createNeedsYouStore } from './needs-you-store.ts';

export { DISMISSED_ALERTS_KEY, UNDO_WINDOW_MS, createNeedsYouStore, errorText, usageAlerts, type NeedsYouDeps, type NeedsYouSnapshot, type NeedsYouStore } from './needs-you-store.ts';

/**
 * D131 · the page's "Needs you" store and its hooks (`docs/v2.md` → *Needs you*;
 * the logic is `needs-you-store.ts`): one live copy of everything waiting for
 * the developer, shared by every v2 view. Answering anywhere answers it
 * everywhere.
 */

// ── The real one ────────────────────────────────────────────────────────

/** Sends an answer through the existing routes (the classic Inbox's, Team's, Memory's, Plans'). */
export async function sendAnswer(item: NeedsItem, action: AnswerAction): Promise<void> {
  const sessionId = item.agent?.sessionId ?? null;
  switch (action.type) {
    case 'questions':
      await api.answerBatch(item.id, { answers: action.answers });
      return;
    case 'permission':
      await api.inboxAction(item.id, action.decision);
      return;
    case 'server':
      await api.inboxAction(item.id, action.actionId);
      return;
    case 'reply':
      if (!sessionId) throw new Error('This item has no agent to reply to.');
      await api.sendMessage(sessionId, action.text);
      if (item.source === 'inbox' && item.inbox?.kind === 'system') await api.inboxAction(item.id, 'dismiss').catch(() => undefined);
      return;
    case 'not-waiting':
      await api.inboxAction(item.id, 'dismiss');
      return;
    case 'retry':
      if (!sessionId) throw new Error('This item has no agent to ask.');
      await api.sendMessage(sessionId, action.text);
      await api.inboxAction(item.id, 'dismiss').catch(() => undefined);
      return;
    case 'send-back': {
      const planId = planIdOf(item.route);
      if (planId && sessionId) {
        const plan = await plansApi.get(planId);
        const step = plan.items.find((candidate) => candidate.runSessionId === sessionId);
        if (step) {
          await plansApi.sendBackItem(planId, step.id, action.comment);
          return;
        }
      }
      if (!sessionId) throw new Error('This item has no agent to send it back to.');
      await api.sendMessage(sessionId, action.comment);
      return;
    }
    case 'team':
      await teamApi.decide(item.id, action.decision, action.charter ? { charter: action.charter } : undefined);
      return;
    case 'note': {
      const notes = memoryApi(item.computer?.id ?? null);
      if (action.decision === 'reject') await notes.reject(item.id);
      else await notes.approve(item.id, action.text !== undefined ? { text: action.text } : {});
      return;
    }
    case 'dismiss-local':
      return;
  }
}

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The page's one store. */
export const needsYouStore: NeedsYouStore = createNeedsYouStore({
  inbox: () => api.inbox(),
  team: () => teamApi.needsYou('all'),
  notes: (scope, machineId) => memoryApi(machineId).entries(scope),
  system: () => api.system(),
  send: sendAnswer,
  now: () => Date.now(),
  storage: browserStorage(),
  undoMs: UNDO_WINDOW_MS,
});

let live: (() => void) | null = null;
let holders = 0;

/** Keeps the store live (hub listeners, the first reads) while a view holds it. */
function hold(): () => void {
  holders += 1;
  if (holders === 1) {
    const release = needsYouStore.retain();
    const reload = (): void => void needsYouStore.reload();
    const offs = [
      onHubEvent('inboxChanged', reload),
      onHubEvent('teamChanged', reload),
      onHubEvent('memoryChanged', reload),
      onHubEvent('planChanged', reload),
      onHubEvent('system', (system) => needsYouStore.usageChanged(system)),
    ];
    void api
      .system()
      .then((system) => needsYouStore.usageChanged(system))
      .catch(() => undefined);
    // An answer still in its Undo window is sent before the page goes away.
    const flush = (): void => {
      if (document.visibilityState === 'hidden') void needsYouStore.flush();
    };
    const hide = (): void => void needsYouStore.flush();
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', hide);
    live = () => {
      release();
      for (const off of offs) off();
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', hide);
    };
  }
  return () => {
    holders -= 1;
    if (holders === 0) {
      live?.();
      live = null;
    }
  };
}

/** The live "needs you" state (every source merged; answered items left out). */
export function useNeedsYou(): NeedsYouSnapshot {
  useEffect(() => hold(), []);
  const machines = useMachines();
  // A stable key: `useMachines` hands out a new array on every render.
  const key = machines.map((m) => `${m.id}=${m.state}`).join('|');
  useEffect(() => needsYouStore.computersChanged(Object.fromEntries(machines.map((m) => [m.id, m.state])) as Record<string, MachineState>), [key]);
  return useSyncExternalStore(needsYouStore.subscribe, needsYouStore.getSnapshot, needsYouStore.getSnapshot);
}

/** How many items wait (the badges). */
export function useNeedsYouCount(): number {
  return useNeedsYou().items.length;
}

/** One agent's items (its chat's answer cards). */
export function useNeedsItemsOf(sessionId: string): NeedsItem[] {
  const { items } = useNeedsYou();
  return useMemo(() => itemsOfSession(items, sessionId), [items, sessionId]);
}

/** Where this page answers from, for the compact card ("on your phone" on a paired phone). */
export function defaultWhere(where: AnsweredWhere): AnsweredWhere {
  return onDeviceOrigin() ? 'phone' : where;
}
