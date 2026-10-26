import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../../../src/server/db/migrate.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { SystemItemService } from '../../../src/server/inbox/system-items.ts';
import { MEMORY_DB_FILE, MEMORY_MIGRATIONS, MemoryDb } from '../../../src/server/memory/db.ts';
import { MEMORY_COPY_ITEM, MEMORY_COPY_KEEP, MEMORY_COPY_RETRY, memoryPeerChanged } from '../../../src/server/memory/hooks.ts';
import { MEMORY_COPY_BACKOFF_MS, MemoryError, MemoryService } from '../../../src/server/memory/service.ts';
import { type TeamMemberRef, registerTeamHooks } from '../../../src/server/team/hooks.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D107 follow-up 2026-10-16 · a moved member's memory that the other machine could not take:
 * kept as a pending copy on the old machine, retried with backoff, when the machine comes online
 * (`machineState`) and when its Project memory changes (a peer's `memoryChanged`); after three
 * failures (or an hour) an Inbox item "<member> is missing its memory on <PC>" with Retry / Keep
 * on this PC. Two real services ("Mac" and "Windows PC") joined by a scripted peer link.
 */

interface Machine {
  readonly root: string;
  readonly store: Store;
  readonly bus: HubBus;
  memory: MemoryService;
  readonly workspace: string;
  members: TeamMemberRef[];
  /** The service's options (a restart builds a new one over the same memory.db). */
  readonly options: ConstructorParameters<typeof MemoryService>[0];
}

/** The scripted link from the Mac to the PC: `offline` throws like an unreachable peer; `legacyOff` answers like a 1.x PC with Project memory switched off. */
interface Link {
  offline: boolean;
  legacyOff?: boolean;
  calls: number;
}

const machines: Machine[] = [];
const clock = { now: new Date('2026-10-16T09:00:00.000Z') };

afterEach(async () => {
  for (const machine of machines.splice(0)) {
    await machine.memory.close();
    await machine.store.close();
    await removeTempDir(machine.root);
  }
  clock.now = new Date('2026-10-16T09:00:00.000Z');
});

async function machine(label: string, peers?: ConstructorParameters<typeof MemoryService>[0]['peers']): Promise<Machine> {
  const root = await realpath(await makeTempDir(label));
  const store = await openTempStore(path.join(root, 'data'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const bus = new HubBus();
  const options: ConstructorParameters<typeof MemoryService>[0] = { dataDir: path.join(root, 'data'), store, bus, supervisor: { instructionSettingChanged: async () => undefined }, ...(peers ? { peers } : {}), now: () => clock.now, onError: () => undefined };
  const memory = new MemoryService(options);
  const m: Machine = { root, store, bus, memory, workspace, members: [], options };
  registerTeamHooks(store, {
    charterFor: async () => null,
    roleOf: () => null,
    memberOf: (sessionId) => m.members.find((member) => member.sessionId === sessionId && member.here) ?? null,
    memberList: () => m.members,
  });
  await memory.start();
  machines.push(m);
  return m;
}

async function session(m: Machine, name: string): Promise<string> {
  return (await m.store.sessions.create({ name, claudeSessionId: `c-${name}`, attached: true, title: name, root: m.workspace, rootKind: 'workspace', cwd: m.workspace })).id;
}

/** The Mac (Builder runs there with two member entries) and the PC (its session after the move), linked by `link`. */
async function world() {
  const link: Link = { offline: false, calls: 0 };
  let pc: Machine | null = null;
  const mac = await machine('memory-retry-mac', {
    forward: async (machineId, method, route, body) => {
      link.calls += 1;
      if (link.offline || !pc || machineId !== 'pc') throw new Error('peer unreachable');
      expect(`${method} ${route}`).toBe('POST /api/memory/import');
      if (link.legacyOff) return { status: 404, body: { error: 'memory-off', message: 'Project memory is off: switch it on in Settings → Experimental' } };
      try {
        return { status: 200, body: await pc.memory.importMember(body) };
      } catch (error) {
        if (error instanceof MemoryError) return { status: error.status, body: error.body() };
        throw error;
      }
    },
    machines: async () => [{ id: 'pc', name: 'Windows PC' }],
  });
  pc = await machine('memory-retry-pc');
  const builderHere = await session(mac, 'builder');
  mac.members.push({ id: 'm-builder', name: 'Builder', teamId: 'team', sessionId: builderHere, machineId: 'mac', here: true, paused: false });
  const approved = await mac.memory.propose(builderHere, { title: 'Builder release steps', text: 'TAG-THEN-PUBLISH' });
  await mac.memory.approve(approved.id, {});
  await mac.memory.propose(builderHere, { title: 'Builder waiting proposal', text: 'WAITING' });
  // The move: Builder now runs on the PC.
  const builderThere = await session(pc, 'builder-there');
  mac.members = [{ id: 'm-builder', name: 'Builder', teamId: 'team', sessionId: builderThere, machineId: 'pc', here: false, paused: false }];
  pc.members = [{ id: 'm-builder', name: 'Builder', teamId: 'team', sessionId: builderThere, machineId: 'pc', here: true, paused: false }];
  const move = { memberId: 'm-builder', machineId: 'pc', sessionId: builderThere };
  return { mac, pc: pc as Machine, link, move, builderThere };
}

function memberTitles(m: Machine): string[] {
  return m.memory.entries({ kind: 'member' }).map((entry) => entry.title);
}

function later(ms: number): void {
  clock.now = new Date(clock.now.getTime() + ms);
}

async function openCopyItems(m: Machine) {
  return (await m.store.systemItems.list(['open'])).filter((item) => item.kind === MEMORY_COPY_ITEM);
}

describe('D107 follow-up · a moved member’s memory is retried until it arrives', () => {
  it('offline at the move: kept as a pending copy with a timer; the PC coming online copies it', async () => {
    const { mac, pc, link, move, builderThere } = await world();
    link.offline = true;
    await mac.memory.memberMoved(move);
    expect(memberTitles(mac)).toEqual(['Builder release steps', 'Builder waiting proposal']);
    expect(mac.memory.pendingCopies()).toMatchObject([{ memberId: 'm-builder', machineId: 'pc', attempts: 1, nextAttemptAt: '2026-10-16T09:01:00.000Z', itemId: null }]);
    expect(mac.memory.activeTimers()).toBe(1);
    // The PC comes online (the peer link's machineState event).
    link.offline = false;
    mac.bus.publish('machineState', { id: 'pc', name: 'Windows PC', state: 'online' } as never);
    await expect.poll(() => memberTitles(pc)).toEqual(['Builder release steps', 'Builder waiting proposal']);
    await expect.poll(() => memberTitles(mac)).toEqual([]);
    await expect.poll(() => mac.memory.pendingCopies()).toEqual([]);
    await expect.poll(() => mac.memory.activeTimers()).toBe(0);
    expect(pc.memory.entries({ kind: 'member' }).map((entry) => entry.status)).toEqual(['approved', 'proposed']);
    expect(await pc.memory.blockFor({ id: builderThere, kind: 'session', root: pc.workspace })).toContain('TAG-THEN-PUBLISH');
  });

  it('a 1.x PC with Project memory off (404 memory-off), then switched on there: its memoryChanged retries and the copy succeeds', async () => {
    const { mac, pc, link, move } = await world();
    link.legacyOff = true;
    await mac.memory.memberMoved(move);
    expect(mac.memory.pendingCopies()[0]?.lastError).toBe('Project memory is off there');
    // Switched on there: its memoryChanged reaches the Mac through the peer stream.
    link.legacyOff = false;
    memoryPeerChanged(mac.store, 'pc');
    await expect.poll(() => memberTitles(pc)).toEqual(['Builder release steps', 'Builder waiting proposal']);
    await expect.poll(() => mac.memory.pendingCopies()).toEqual([]);
    expect(memberTitles(mac)).toEqual([]);
  });

  it('backoff 1, 5, 30 minutes then hourly; the third failure raises the item; Retry while still offline refuses, then succeeds and resolves it', async () => {
    expect(MEMORY_COPY_BACKOFF_MS).toEqual([60_000, 300_000, 1_800_000, 3_600_000]);
    const { mac, pc, link, move } = await world();
    const inbox = new SystemItemService({ store: mac.store, bus: mac.bus, onError: () => undefined });
    link.offline = true;
    await mac.memory.memberMoved(move);
    // Not due yet: nothing is tried.
    await mac.memory.retryCopies({ due: true });
    expect(link.calls).toBe(1);
    later(60_000);
    await mac.memory.retryCopies({ due: true });
    expect(mac.memory.pendingCopies()[0]).toMatchObject({ attempts: 2, nextAttemptAt: '2026-10-16T09:06:00.000Z', itemId: null });
    expect(await openCopyItems(mac)).toHaveLength(0);
    later(5 * 60_000);
    await mac.memory.retryCopies({ due: true });
    const pending = mac.memory.pendingCopies()[0];
    expect(pending).toMatchObject({ attempts: 3, nextAttemptAt: '2026-10-16T09:36:00.000Z' });
    const [item] = await openCopyItems(mac);
    expect(item?.title).toBe('Builder is missing its memory on Windows PC');
    expect(item?.actions.map((action) => action.label)).toEqual(['Retry', 'Keep on this PC']);
    expect(pending?.itemId).toBe(item?.id);
    // A fourth failure refreshes the same item (no second one).
    later(30 * 60_000);
    await mac.memory.retryCopies({ due: true });
    expect(await openCopyItems(mac)).toHaveLength(1);
    expect(mac.memory.pendingCopies()[0]?.nextAttemptAt).toBe('2026-10-16T10:36:00.000Z');
    // Retry while the PC is still away: refused, the item stays open.
    await expect(inbox.act(item?.id as string, MEMORY_COPY_RETRY)).rejects.toMatchObject({ code: 'refused' });
    expect(await openCopyItems(mac)).toHaveLength(1);
    // Back: Retry copies, deletes here, resolves the item.
    link.offline = false;
    const closed = await inbox.act(item?.id as string, MEMORY_COPY_RETRY);
    expect(closed.state).not.toBe('open');
    expect(await openCopyItems(mac)).toHaveLength(0);
    expect(memberTitles(pc)).toHaveLength(2);
    expect(memberTitles(mac)).toEqual([]);
    expect(mac.memory.pendingCopies()).toEqual([]);
  });

  it('an hour after the first failure raises the item even before the third failure', async () => {
    const { mac, link, move } = await world();
    link.offline = true;
    await mac.memory.memberMoved(move);
    later(61 * 60_000);
    await mac.memory.retryCopies({ due: true });
    expect(mac.memory.pendingCopies()[0]?.attempts).toBe(2);
    expect(await openCopyItems(mac)).toHaveLength(1);
  });

  it('Keep on this PC: retrying stops, the entries stay here, the item closes', async () => {
    const { mac, pc, link, move } = await world();
    const inbox = new SystemItemService({ store: mac.store, bus: mac.bus, onError: () => undefined });
    link.offline = true;
    await mac.memory.memberMoved(move);
    for (const wait of [60_000, 5 * 60_000]) {
      later(wait);
      await mac.memory.retryCopies({ due: true });
    }
    const [item] = await openCopyItems(mac);
    const kept = await inbox.act(item?.id as string, MEMORY_COPY_KEEP);
    expect(kept.state).not.toBe('open');
    expect(mac.memory.pendingCopies()).toEqual([]);
    expect(mac.memory.activeTimers()).toBe(0);
    // Online again: nothing is copied any more.
    link.offline = false;
    mac.bus.publish('machineState', { id: 'pc', name: 'Windows PC', state: 'online' } as never);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(memberTitles(mac)).toHaveLength(2);
    expect(memberTitles(pc)).toEqual([]);
  });

  it('a member that moved back here needs no copy: the pending one is dropped and its item resolved', async () => {
    const { mac, link, move } = await world();
    link.offline = true;
    await mac.memory.memberMoved(move);
    mac.members = [{ ...(mac.members[0] as TeamMemberRef), machineId: 'mac', here: true }];
    await mac.memory.retryCopies();
    expect(mac.memory.pendingCopies()).toEqual([]);
    expect(memberTitles(mac)).toHaveLength(2);
  });

  it('the pending copy survives a restart (stored in memory.db) and is retried after it', async () => {
    const { mac, link, move } = await world();
    link.offline = true;
    await mac.memory.memberMoved(move);
    await mac.memory.close();
    expect(mac.memory.activeTimers()).toBe(0);
    mac.memory = new MemoryService(mac.options);
    await mac.memory.start();
    expect(mac.memory.pendingCopies()).toHaveLength(1);
    expect(mac.memory.activeTimers()).toBe(1);
  });
});

describe('D107 follow-up · migration 3', () => {
  it('adds memory_pending_copies; migrations 1 and 2 are byte-identical', async () => {
    expect(MEMORY_MIGRATIONS.map((m) => [m.version, m.name, m.checksum])).toEqual([
      [1, 'memory', '6d1bf0aedc3a169a1215c62bf859c6d8e4e8f7aaa272d885ec21b34baf615c13'],
      [2, 'memory_scopes', '72a7166af3aaa3098e9374cf2d1dc374bc5d7d234d181cfd71619d3a715e3af1'],
      // D135: migration 3 as released (its checksum pinned once migration 4 followed).
      [3, 'memory_pending_copies', 'f3ded3785f77bc19dc499888fbcbabb5877114b0f591e507bf37cd0497091b48'],
      // D136: migration 4 as released in 2.2.0 (its checksum pinned once migration 5 followed).
      [4, 'memory_changes', 'e271b6a93973c0a7a1b8ff46dea8dc8f0d0e13145c08d862855b546b36e02c3f'],
      [5, 'memory_checks', expect.any(String)],
    ]);
    const root = await realpath(await makeTempDir('memory-migrate-3'));
    try {
      // A memory.db as 1.22.0 left it (migrations 1 and 2), with an entry.
      const raw = new DatabaseSync(path.join(root, MEMORY_DB_FILE));
      migrate(raw, MEMORY_MIGRATIONS.slice(0, 2));
      raw
        .prepare(`INSERT INTO memory_entries (id, scope, title, text, tags, author_kind, status, pinned, created_at, updated_at, scope_kind, scope_key, scope_label) VALUES ('m1', '/w', 'Kept', 'As approved.', '[]', 'developer', 'approved', 0, 't', 't', 'member', 'm-x', 'X')`)
        .run();
      raw.close();
      const db = await MemoryDb.open(root);
      expect(db.get('m1')).toMatchObject({ title: 'Kept', scopeKind: 'member', scopeKey: 'm-x' });
      expect(db.pendingCopies()).toEqual([]);
      db.putPendingCopy({ memberId: 'm-x', memberLabel: 'X', machineId: 'pc', sessionId: 's', attempts: 1, firstFailedAt: 'a', nextAttemptAt: 'b', lastError: null, itemId: null });
      expect(db.pendingCopy('m-x')?.machineId).toBe('pc');
      db.close();
    } finally {
      await removeTempDir(root);
    }
  });
});
