import { describe, expect, it } from 'vitest';
import { HybridClock } from '../../src/core/hlc.ts';
import { laterMute, mcpSignInServerOf, mergeMuteRecords, migratedMuteRecords, mutedNames, readMcpSignInWire, readMuteRecords } from '../../src/core/mcp-sign-in.ts';

/** D184 (`docs/mcp.md` → *Synced with paired computers*): the mute records' merge, clocks and tombstones. */
describe('D184 · MCP sign-in mutes synced between paired computers', () => {
  const pc = new HybridClock('pcpcpcpc', () => 1_000);
  const mac = new HybridClock('macmacma', () => 2_000);

  it('the later clock wins per server; an unmute is kept as a tombstone and wins over an older mute', () => {
    const muteOnPc = { name: 'claude.ai Google Drive', muted: true, clock: pc.next() };
    const unmuteOnMac = { name: 'claude.ai Google Drive', muted: false, clock: mac.next() };
    // Would fail if `laterMute` ignored the clock (or an older mute won).
    const onPc = mergeMuteRecords([muteOnPc], [unmuteOnMac]);
    expect(onPc.written).toEqual([unmuteOnMac]);
    expect(mutedNames(onPc.records)).toEqual([]);
    // The tombstone stays a record (so a third computer still muting it learns the unmute).
    expect(onPc.records).toEqual([unmuteOnMac]);
    // The older record back again changes nothing (the pass-on ends).
    expect(mergeMuteRecords(onPc.records, [muteOnPc]).written).toEqual([]);
  });

  it('the same record twice is not written again; the same clock: a mute wins, the same on every computer', () => {
    const record = { name: 'docs', muted: true, clock: pc.next() };
    expect(mergeMuteRecords([record], [record]).written).toEqual([]);
    const clock = mac.next();
    expect(laterMute({ name: 'x', muted: true, clock }, { name: 'x', muted: false, clock })).toBe(true);
    expect(laterMute({ name: 'x', muted: false, clock }, { name: 'x', muted: true, clock })).toBe(false);
  });

  it('a D183 list becomes records older than every synced change (a paired computer’s unmute wins over it)', () => {
    const migrated = migratedMuteRecords(['claude.ai Notion', 'claude.ai Notion', '']);
    expect(migrated).toEqual([{ name: 'claude.ai Notion', muted: true, clock: '' }]);
    expect(mutedNames(mergeMuteRecords(migrated, [{ name: 'claude.ai Notion', muted: false, clock: pc.next() }]).records)).toEqual([]);
  });

  it('reads records and the exchange body; anything malformed is left out', () => {
    expect(readMuteRecords([{ name: 'a', muted: true, clock: '' }, { name: 'b', muted: 'yes', clock: '' }, { name: 'c', muted: true, clock: 'not a clock' }, null])).toEqual([{ name: 'a', muted: true, clock: '' }]);
    expect(readMcpSignInWire({ v: 1, mutes: [{ name: 'a', muted: false, clock: '' }], connectors: [{ name: 'claude.ai Docs', status: 'connected', at: 't' }] })).toEqual({ mutes: [{ name: 'a', muted: false, clock: '' }], connectors: [{ name: 'claude.ai Docs', status: 'connected', at: 't' }] });
    expect(readMcpSignInWire({ v: 2, mutes: [] })).toBeNull();
    expect(readMcpSignInWire(null)).toBeNull();
  });

  it('an Inbox item’s server: its mcpServer, else an older computer’s “Sign in to …” of source mcp', () => {
    expect(mcpSignInServerOf({ source: 'mcp', title: 'Sign in to claude.ai Google Drive', mcpServer: 'claude.ai Google Drive' })).toBe('claude.ai Google Drive');
    // Would fail without the title fallback (a 2.5.5 computer sends no mcpServer).
    expect(mcpSignInServerOf({ source: 'mcp', title: 'Sign in to claude.ai Google Drive' })).toBe('claude.ai Google Drive');
    expect(mcpSignInServerOf({ source: 'schedule', title: 'Sign in to x' })).toBeNull();
  });
});
