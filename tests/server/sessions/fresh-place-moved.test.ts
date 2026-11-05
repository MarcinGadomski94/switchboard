import { describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { inheritPlace, type SidebarLayout } from '../../../src/core/sidebar-layout.ts';
import type { SidebarLayoutRepository } from '../../../src/server/db/repos/sidebar.ts';
import type { HubBus, HubMessage } from '../../../src/server/hub/bus.ts';
import { FreshPlaces } from '../../../src/server/sessions/fresh-place.ts';

/**
 * 2026-11-05 (`docs/peers.md` → *Taking a session over*): a moved agent keeps its
 * sidebar folder on both computers. Its `movedFrom` names the raw id on the computer
 * it came from: that id here (it came from us) or `r~<machine>~<id>` (a peer's).
 */

function world(layout: SidebarLayout) {
  let current = layout;
  const listeners: Array<(message: HubMessage) => void> = [];
  const bus = { subscribe: (fn: (message: HubMessage) => void) => (listeners.push(fn), () => undefined), publish: () => undefined } as unknown as HubBus;
  const sidebar = {
    change: async (fn: (l: SidebarLayout) => SidebarLayout | null) => {
      const next = fn(current);
      if (!next) return null;
      current = next;
      return { layout: next, changes: { folders: [], places: [] } };
    },
  } as unknown as SidebarLayoutRepository;
  const places = new FreshPlaces({ bus, sidebar, synced: () => undefined, selfId: async () => 'pc' });
  places.start();
  const send = (session: Partial<Session>) => listeners.forEach((fn) => fn({ name: 'sessionUpdated', payload: { closedAt: null, ...session } as Session } as HubMessage));
  return { places, send, layout: () => current };
}

const folder = (sessionIds: string[]): SidebarLayout => ({ pinned: [], folders: [{ id: 'f1', name: 'Work', parentId: null, collapsed: false, sessionIds }], loose: [] }) as unknown as SidebarLayout;

describe('a moved agent keeps its sidebar folder', () => {
  it('on the computer it left: the new session (a peer\'s, r~mac~new) takes the old one\'s place', async () => {
    const w = world(folder(['other', 'old']));
    w.send({ id: 'r~mac~new', movedFrom: { machineId: 'pc', machineName: 'pc', sessionId: 'old', at: '' } });
    await w.places.stop();
    expect(w.layout().folders[0]?.sessionIds).toEqual(['other', 'r~mac~new']);
  });

  it('on the computer it moved to: the old one is the peer\'s r~pc~old', async () => {
    const w = world(folder(['r~mac~old']));
    w.send({ id: 'new', movedFrom: { machineId: 'mac', machineName: 'mac', sessionId: 'old', at: '' } });
    await w.places.stop();
    expect(w.layout().folders[0]?.sessionIds).toEqual(['new']);
  });

  it('an agent that was not in a folder, or one placed since, stays where it is', async () => {
    const w = world(folder(['old', 'new']));
    w.send({ id: 'new', movedFrom: { machineId: 'mac', machineName: 'mac', sessionId: 'old', at: '' } });
    await w.places.stop();
    expect(w.layout()).toEqual(folder(['old', 'new']));
    expect(inheritPlace(folder([]), 'old', 'new')).toBeNull();
  });
});
