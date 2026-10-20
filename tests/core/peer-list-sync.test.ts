import { describe, expect, it } from 'vitest';
import { type Machine, type MachineState, peerSyncNotes } from '../../src/core/peers.ts';

/** D113: the notes a page that merges a paired machine's list shows (`docs/peers.md` → *List sync (D113)*). */

function machine(state: MachineState, sync?: { artifacts?: { syncing: boolean; syncedAt: string | null }; inbox?: { syncing: boolean; syncedAt: string | null } }): Machine {
  const done = { syncing: false, syncedAt: '2026-10-20T10:00:00.000Z' };
  return {
    id: 'acmepc000001',
    name: 'Acme-PC',
    address: '100.64.0.2:13002',
    state,
    lastError: null,
    lastSeenAt: null,
    pairedAt: '2026-10-01T10:00:00.000Z',
    ...(sync ? { listSync: { artifacts: sync.artifacts ?? done, inbox: sync.inbox ?? done } } : {}),
  };
}

describe('D113 · peerSyncNotes', () => {
  it('online and synced: nothing; an older service (no listSync): nothing', () => {
    expect(peerSyncNotes([machine('online', {})], 'artifacts')).toEqual([]);
    expect(peerSyncNotes([machine('online')], 'inbox')).toEqual([]);
  });

  it('syncing: not in yet, being fetched again, or reconnecting', () => {
    const text = 'Syncing with Acme-PC…';
    expect(peerSyncNotes([machine('online', { artifacts: { syncing: false, syncedAt: null } })], 'artifacts')).toEqual([{ id: 'acmepc000001', name: 'Acme-PC', kind: 'syncing', text }]);
    expect(peerSyncNotes([machine('online', { inbox: { syncing: true, syncedAt: '2026-10-20T10:00:00.000Z' } })], 'inbox').map((note) => note.text)).toEqual([text]);
    // Only the list asked about.
    expect(peerSyncNotes([machine('online', { inbox: { syncing: true, syncedAt: null } })], 'artifacts')).toEqual([]);
    expect(peerSyncNotes([machine('reconnecting')], 'artifacts').map((note) => note.kind)).toEqual(['syncing']);
  });

  it('unreachable: a static note per list, whatever the last sync', () => {
    expect(peerSyncNotes([machine('offline', { artifacts: { syncing: false, syncedAt: null } })], 'artifacts')).toEqual([
      { id: 'acmepc000001', name: 'Acme-PC', kind: 'offline', text: 'Acme-PC is offline — its artifacts may be out of date' },
    ]);
    expect(peerSyncNotes([machine('offline')], 'inbox')[0]?.text).toBe('Acme-PC is offline — its items are not shown until it is back');
    expect(peerSyncNotes([machine('auth-failed')], 'artifacts')[0]).toMatchObject({ kind: 'offline', text: 'Acme-PC refused this pairing — pair again in Settings → Machines — its artifacts may be out of date' });
    expect(peerSyncNotes([machine('no-address')], 'inbox')[0]?.kind).toBe('offline');
  });
});
