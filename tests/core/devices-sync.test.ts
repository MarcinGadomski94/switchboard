import { describe, expect, it } from 'vitest';
import { DEVICES_SYNC_VERSION, type SharedDevice, newestTombstones, planDevicesMerge, readDeviceOrigin, readDevicesWire } from '../../src/core/devices-sync.ts';
import { phoneComputerRows, storedComputers } from '../../src/web/v2/settings/phone-computers.ts';

/**
 * D189 (docs/devices.md → One pairing for all your computers): the phones exchange between paired
 * computers — what it reads, the merge (a revoke always wins; else the later clock), and the
 * phone's list of computers.
 */

const A = 'aaaaaaaaaaaa';
const CLOCK_1 = '00000000a.0000.node1';
const CLOCK_2 = '00000000b.0000.node2';

function device(over: Partial<SharedDevice> = {}): SharedDevice {
  return { id: 'phonephone22', name: 'Acme phone', userAgent: null, tailscaleLogin: null, userProfileId: 'default-aaaaaaaaaaaa', pairedAt: '2026-11-24T10:00:00.000Z', pairedOn: A, clock: CLOCK_1, ...over };
}

describe('D189 · the phones exchange', () => {
  it('reads a body; malformed entries are left out; a credential in the input never comes out', () => {
    const wire = readDevicesWire({
      v: DEVICES_SYNC_VERSION,
      origin: 'https://pc.example.ts.net:8443',
      devices: [{ ...device(), credentialHash: 'should-not-pass', secret: 'x' }, { id: 'bad' }],
      tombstones: [{ id: 'phonephone33', clock: CLOCK_2, revokedAt: '2026-11-24T11:00:00.000Z' }, { id: 'x' }],
    });
    expect(wire?.origin).toBe('https://pc.example.ts.net:8443');
    expect(wire?.devices).toHaveLength(1);
    expect(Object.keys(wire?.devices[0] ?? {}).sort()).toEqual(['clock', 'id', 'name', 'pairedAt', 'pairedOn', 'tailscaleLogin', 'userAgent', 'userProfileId']);
    expect(JSON.stringify(wire)).not.toContain('should-not-pass');
    expect(wire?.tombstones).toEqual([{ id: 'phonephone33', clock: CLOCK_2, revokedAt: '2026-11-24T11:00:00.000Z' }]);
    expect(readDevicesWire({ v: 2, origin: null, devices: [], tombstones: [] })).toBeNull();
    // Past the cap the rest is left out, never the whole body (a long list of revokes must not stop the sync).
    expect(readDevicesWire({ v: 1, origin: null, devices: new Array(201).fill(device()), tombstones: [] })?.devices).toHaveLength(200);
    const many = Array.from({ length: 250 }, (_, i) => ({ id: 'phonephone33', clock: CLOCK_1, revokedAt: `2026-11-0${i % 9 + 1}T00:00:00.000Z` }));
    expect(readDevicesWire({ v: 1, origin: null, devices: [], tombstones: many })?.tombstones).toHaveLength(200);
    expect(newestTombstones([...many, { id: 'phonephone44', clock: CLOCK_2, revokedAt: '2026-11-24T00:00:00.000Z' }])[0]?.id).toBe('phonephone44');
    // A profile id is a link id: never a pattern such as '*'.
    for (const userProfileId of ['*', 'a b', '', 'x'.repeat(65)]) expect(readDevicesWire({ v: 1, origin: null, devices: [device({ userProfileId })], tombstones: [] })?.devices).toEqual([]);
  });

  it('an origin is https on a ts.net name (or the tests’ loopback, only when allowed), nothing more', () => {
    expect(readDeviceOrigin('https://pc.example.ts.net')).toBe('https://pc.example.ts.net');
    expect(readDeviceOrigin('https://pc.example.ts.net:8443')).toBe('https://pc.example.ts.net:8443');
    expect(readDeviceOrigin('https://evil.example.com')).toBeNull();
    expect(readDeviceOrigin('https://ts.net.evil.com')).toBeNull();
    expect(readDeviceOrigin('http://localhost:13003')).toBeNull();
    expect(readDeviceOrigin('http://localhost:13003', true)).toBe('http://localhost:13003');
    expect(readDeviceOrigin('http://pc.example.ts.net')).toBeNull();
    expect(readDeviceOrigin('https://pc.example.ts.net/path')).toBeNull();
    expect(readDeviceOrigin('https://user:pw@pc.example.ts.net')).toBeNull();
    expect(readDeviceOrigin('javascript:alert(1)')).toBeNull();
  });

  it('merge: new devices come in; a later clock wins; an older or equal one does not', () => {
    const empty = { devices: new Map(), tombstones: new Set<string>() };
    expect(planDevicesMerge(empty, { devices: [device()], tombstones: [] }).upserts).toHaveLength(1);
    const known = { devices: new Map([['phonephone22', { clock: CLOCK_1 }]]), tombstones: new Set<string>() };
    expect(planDevicesMerge(known, { devices: [device({ name: 'Renamed', clock: CLOCK_2 })], tombstones: [] }).upserts.map((d) => d.name)).toEqual(['Renamed']);
    expect(planDevicesMerge(known, { devices: [device({ name: 'Same clock' })], tombstones: [] }).upserts).toEqual([]);
    const later = { devices: new Map([['phonephone22', { clock: CLOCK_2 }]]), tombstones: new Set<string>() };
    expect(planDevicesMerge(later, { devices: [device({ name: 'Older' })], tombstones: [] }).upserts).toEqual([]);
  });

  it('merge: a revoke always wins — a revoked phone never comes back, whatever its clock', () => {
    const revokedHere = { devices: new Map(), tombstones: new Set(['phonephone22']) };
    expect(planDevicesMerge(revokedHere, { devices: [device({ clock: '00000zzzz.0000.node9' })], tombstones: [] }).upserts).toEqual([]);
    const known = { devices: new Map([['phonephone22', { clock: CLOCK_2 }]]), tombstones: new Set<string>() };
    const plan = planDevicesMerge(known, { devices: [device({ clock: '00000zzzz.0000.node9' })], tombstones: [{ id: 'phonephone22', clock: CLOCK_1, revokedAt: '2026-11-24T11:00:00.000Z' }] });
    expect(plan.upserts).toEqual([]);
    expect(plan.revokes.map((t) => t.id)).toEqual(['phonephone22']);
    // A revoke of a phone never known here is not kept.
    expect(planDevicesMerge({ devices: new Map(), tombstones: new Set<string>() }, { devices: [], tombstones: [{ id: 'phonephone22', clock: CLOCK_1, revokedAt: 'x' }] }).revokes).toEqual([]);
    // A revoke already known here is not applied twice.
    expect(planDevicesMerge(revokedHere, { devices: [], tombstones: [{ id: 'phonephone22', clock: CLOCK_1, revokedAt: 'x' }] }).revokes).toEqual([]);
  });

  it('the phone’s computers: this one first, Switch only where it works, and what the offline page may link to', () => {
    const rows = phoneComputerRows([
      { id: 'b', name: 'Mac', origin: 'https://mac.example.ts.net', current: false, synced: true },
      { id: 'c', name: 'Old box', origin: null, current: false, synced: false },
      { id: 'a', name: 'PC', origin: 'https://pc.example.ts.net', current: true, synced: true },
      { id: 'd', name: 'Laptop', origin: null, current: false, synced: true },
    ]);
    expect(rows.map((r) => [r.name, r.canSwitch])).toEqual([['PC', false], ['Laptop', false], ['Mac', true], ['Old box', false]]);
    expect(rows.find((r) => r.name === 'Old box')?.note).toContain('Update Switchboard');
    expect(storedComputers([
      { id: 'a', name: 'PC', origin: 'https://pc.example.ts.net', current: true, synced: true },
      { id: 'b', name: 'Mac', origin: 'https://mac.example.ts.net', current: false, synced: true },
      { id: 'e', name: 'Evil', origin: 'javascript:alert(1)', current: false, synced: true },
    ])).toEqual([{ name: 'Mac', origin: 'https://mac.example.ts.net' }]);
  });
});
