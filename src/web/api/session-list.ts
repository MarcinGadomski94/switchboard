import { useSyncExternalStore } from 'react';
import type { SessionListItem } from '../../core/api.ts';
import { api } from './client.ts';
import { SessionListStore, type SessionListVariant } from './session-list-store.ts';
import type { ApiState } from './useApi.ts';
import { currentHubStatus, onHubEvent, onHubStatus } from './useHub.ts';

/**
 * D95 follow-up 2 (`docs/performance.md` → *Session list in memory*): one in-memory
 * copy of `GET /api/sessions` per page (and one of `?closed=include` while a view
 * needs it), shared by every view that lists sessions (sidebar, palette, folder
 * switcher, loop cards, the New-session form, settings…). It is read once when the
 * first view subscribes and then **patched from `/hub`** instead of read again on
 * every `sessionUpdated` (which carries the whole session, this machine's and the
 * paired machines'). It is read again only to resynchronize: when the hub stream
 * reopens (events may have been missed), when a paired machine's state changes
 * (its sessions come or go), and shortly after an update names a session the list
 * does not hold (so a new one also lands in the server's order). Agents are not
 * kept: the list route leaves them out (`include=agents` asks for them) and an
 * update's agents are dropped, so the copy holds the same shape either way.
 */

export { SESSION_LIST_RESYNC_MS, SessionListStore, type SessionListVariant, listItem, patchSessionList } from './session-list-store.ts';

interface Shared {
  readonly store: SessionListStore;
  readers: number;
  release: (() => void) | null;
  /** Stable (`useSyncExternalStore` subscribes again whenever it changes). */
  readonly subscribe: (listener: () => void) => () => void;
}

const shared = new Map<SessionListVariant, Shared>();

function sharedOf(variant: SessionListVariant): Shared {
  let entry = shared.get(variant);
  if (!entry) {
    const store = new SessionListStore(variant, () => api.listSessions(variant === 'all' ? { closed: 'include' } : {}));
    const created: Shared = {
      store,
      readers: 0,
      release: null,
      subscribe: (listener) => {
        const off = store.subscribe(listener);
        const release = retain(created);
        return () => {
          off();
          release();
        };
      },
    };
    entry = created;
    shared.set(variant, entry);
  }
  return entry;
}

/** The first reader starts the copy (a read + the hub listeners); the last one stops it. */
function retain(entry: Shared): () => void {
  entry.readers += 1;
  if (entry.readers === 1) {
    const { store } = entry;
    const machines = new Map<string, string>();
    // Read before the stream opened: what was published in between is read again once it opens. Afterwards, after a drop.
    let missed = currentHubStatus() !== 'open';
    const offs = [
      onHubEvent('sessionUpdated', (session) => store.update(session)),
      onHubEvent('machineState', (machine) => {
        // A paired machine's sessions come or go with its state (not with every attempt).
        const state = machine.removed ? 'removed' : machine.state;
        if (machines.get(machine.id) === state) return;
        machines.set(machine.id, state);
        store.resyncSoon();
      }),
      onHubStatus((status) => {
        if (status !== 'open') {
          missed = true;
          return;
        }
        if (missed) store.load();
        missed = false;
      }),
    ];
    store.load();
    entry.release = () => {
      for (const off of offs) off();
      store.clear();
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.readers -= 1;
    if (entry.readers === 0) {
      entry.release?.();
      entry.release = null;
    }
  };
}

/**
 * The page's shared session list (`open`: `GET /api/sessions`; `all`: with the closed
 * ones), kept current from `/hub`; `reload()` reads it again (after an action whose
 * result the hub does not announce).
 */
export function useSessionListOf(variant: SessionListVariant = 'open'): ApiState<SessionListItem[]> {
  const entry = sharedOf(variant);
  return useSyncExternalStore(entry.subscribe, entry.store.getState);
}
