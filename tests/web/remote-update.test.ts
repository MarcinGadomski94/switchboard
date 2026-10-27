import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../src/core/api.ts';
import type { Machine } from '../../src/core/peers.ts';
import { type MachineUpdate, type UpdateStatus, remoteUpdateAbility } from '../../src/core/updates.ts';
import { machineUpdateView, refusalMessage, remoteBlockOf } from '../../src/web/updates/machine-update.ts';
import { cardButtons } from '../../src/web/v2/shared/answer-model.ts';
import { fromInbox } from '../../src/web/v2/shared/needs-you-model.ts';

/**
 * D140 (`docs/updates.md` → *Remote updates*): what a paired computer's card /
 * row shows about its updates, the phone's reason instead of **Update**, and the
 * Update action on a paired computer's "is available" item.
 */

const AT = '2026-10-27T10:00:00.000Z';

const UPDATE: MachineUpdate = {
  current: '2.4.2',
  kind: 'release',
  restart: 'service',
  remote: remoteUpdateAbility('release', 'service'),
  checking: false,
  latest: { version: '2.4.3', tag: 'v2.4.3', url: null },
  available: true,
  lastCheck: { at: AT, ok: true, via: 'api', error: null },
  progress: { phase: 'idle', version: null, message: '', error: null, at: null },
  liveSessions: 2,
  lastRemote: null,
};

function machine(update: Partial<MachineUpdate> | null, state: Machine['state'] = 'online'): Pick<Machine, 'state' | 'update'> {
  return update === null ? { state } : { state, update: { ...UPDATE, ...update } };
}

describe('D140 · a paired computer\'s updates', () => {
  it('available: Update and Check offered while online', () => {
    expect(machineUpdateView(machine({}))).toMatchObject({ stage: 'available', current: '2.4.2', latest: '2.4.3', canUpdate: true, canCheck: true, liveSessions: 2 });
    // Reconnecting: shown, nothing offered.
    expect(machineUpdateView(machine({}, 'reconnecting'))).toMatchObject({ stage: 'available', canUpdate: false, canCheck: false });
  });

  it('a computer that reports nothing (before D140, updater off) shows nothing', () => {
    expect(machineUpdateView(machine(null)).stage).toBe('unknown');
  });

  it('blocked: the reason instead of Update', () => {
    const view = machineUpdateView(machine({ remote: remoteUpdateAbility('git', 'service'), kind: 'git' }));
    expect(view).toMatchObject({ stage: 'blocked', canUpdate: false, canCheck: true });
    expect(view.blocked).toContain("Can't update itself here");
  });

  it('the progress, then "Restarting… reconnects when it\'s back" while it is away', () => {
    expect(machineUpdateView(machine({ progress: { phase: 'installing', version: '2.4.3', message: '', error: null, at: AT } }))).toMatchObject({ stage: 'running', canUpdate: false, canCheck: false, detail: 'Installing dependencies (npm ci --omit=dev)…' });
    expect(machineUpdateView(machine({ progress: { phase: 'restarting', version: '2.4.3', message: '', error: null, at: AT } }, 'offline'))).toMatchObject({ stage: 'restarting', latest: '2.4.3' });
    // Away for another reason: no update state is kept (the server drops it), nothing shown.
    expect(machineUpdateView(machine(null, 'offline')).stage).toBe('unknown');
  });

  it('failed, checking, a failed check, up to date, updated from …', () => {
    expect(machineUpdateView(machine({ progress: { phase: 'failed', version: '2.4.3', message: '', error: 'checksum mismatch', at: AT } }))).toMatchObject({ stage: 'failed', canUpdate: true, detail: 'Update failed: checksum mismatch' });
    expect(machineUpdateView(machine({ available: false, checking: true }))).toMatchObject({ stage: 'checking', canCheck: false });
    expect(machineUpdateView(machine({ available: false, lastCheck: { at: AT, ok: false, via: null, error: "Can't reach releases: HTTP 500." } }))).toMatchObject({ stage: 'check-failed', detail: "Can't reach releases: HTTP 500." });
    expect(machineUpdateView(machine({ current: '2.4.3', available: false }))).toMatchObject({ stage: 'up-to-date', canCheck: true });
    const updated = machineUpdateView(machine({ current: '2.4.3', available: false, lastRemote: { version: '2.4.3', from: '2.4.2', by: { kind: 'peer', id: 'm1', name: 'Marcins-Mac' }, at: AT, outcome: 'updated', error: null } }));
    expect(updated.updatedBy).toBe('Marcins-Mac');
  });

  it('a phone: the reason instead of Update where its computer cannot restart itself (never on the computer itself)', () => {
    const status = { available: true, remote: remoteUpdateAbility('release', 'manual') } as UpdateStatus;
    expect(remoteBlockOf(status, true)).toContain('restart it by hand');
    expect(remoteBlockOf(status, false)).toBeNull();
    expect(remoteBlockOf({ ...status, remote: remoteUpdateAbility('release', 'service') }, true)).toBeNull();
    // A service before D140 says nothing: the button stays (the server decides).
    expect(remoteBlockOf({ available: true } as UpdateStatus, true)).toBeNull();
    expect(refusalMessage({ error: 'rate-limited', message: 'try again in 6 min' }, 'x')).toBe('try again in 6 min');
    expect(refusalMessage(null, 'x')).toBe('x');
  });

  it('a paired computer\'s "is available" item offers Update (to its Computers card\'s confirm); this computer\'s does not', () => {
    const raw = (machineRef: InboxItem['machine']): InboxItem => ({ id: 'r~studio~u1', kind: 'system', sessionId: null, source: 'switchboard', status: 'idle', title: 'Switchboard 2.4.3 is available', label: 'Update available', detail: '', createdAt: AT, branches: [], actions: [{ id: 'whats-new', label: "What's new" }, { id: 'dismiss', label: 'Dismiss' }], ...(machineRef ? { machine: machineRef } : {}) });
    const peer = cardButtons(fromInbox(raw({ id: 'studio', name: 'Studio-PC', state: 'online' })));
    expect(peer.map((button) => `${button.id}:${button.variant}`)).toEqual(['update-computer:primary', 'whats-new:default', 'dismiss:ghost']);
    expect(peer[0]?.intent).toEqual({ type: 'open', target: { type: 'path', path: '/settings/computers?update=studio' } });
    expect(cardButtons(fromInbox(raw(null))).map((button) => button.id)).toEqual(['whats-new', 'dismiss']);
  });
});
