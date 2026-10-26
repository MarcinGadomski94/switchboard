import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARCHIVE_SINCE_SETTING, readArchiveSweep } from '../../../src/core/session-archive.ts';
import { CleanupService } from '../../../src/server/cleanup/service.ts';
import type { WorktreeRecord } from '../../../src/server/db/repos/worktrees.ts';
import { registerPlanHooks } from '../../../src/server/plans/hooks.ts';
import { ArchiveService } from '../../../src/server/sessions/archive.ts';
import { toSession } from '../../../src/server/sessions/wire.ts';
import { registerTeamHooks } from '../../../src/server/team/hooks.ts';
import { GIT_SPY_COMMAND, type GitWorld, makeGitWorld } from '../../helpers/git.ts';

/**
 * D137 · the archive (`src/server/sessions/archive.ts`, `docs/cleanup.md` → *The archive*):
 * the deadline (the upgrade grace, a restore resets it, the period incl. Never), every kept
 * reason, the worktree conditions (clean + merged removed; dirty, unmerged, local-only
 * commits, shared kept), the sweep's idempotence and its record.
 */

const DAY = 86_400_000;
let world: GitWorld | undefined;
const services: ArchiveService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  await world?.cleanup();
  world = undefined;
});

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

interface Rig {
  readonly w: GitWorld;
  readonly dataDir: string;
  readonly archive: ArchiveService;
  readonly clock: { now: number };
  readonly live: Set<string>;
  readonly lines: string[];
}

async function rig(): Promise<Rig> {
  world = await makeGitWorld();
  const w = world;
  const dataDir = path.join(w.root, 'data');
  await mkdir(dataDir, { recursive: true });
  const clock = { now: Date.now() };
  const live = new Set<string>();
  const lines: string[] = [];
  const cleanup = new CleanupService({ store: w.store, dataDir, gitCommand: GIT_SPY_COMMAND, env: w.env, now: () => new Date(clock.now), isLive: (id) => live.has(id) });
  const archive = new ArchiveService({ store: w.store, cleanup, isLive: (id) => live.has(id), now: () => new Date(clock.now), log: (line) => lines.push(line), onError: (error) => w.errors.push(error) });
  services.push(archive);
  return { w, dataDir, archive, clock, live, lines };
}

async function session(w: GitWorld, name: string, closedAt: number | null, extra: { cwd?: string } = {}): Promise<string> {
  const created = await w.store.sessions.create({ name, claudeSessionId: randomUUID(), solutions: ['web-front'], worktrees: true, root: w.workspace, rootKind: 'workspace', cwd: extra.cwd ?? w.workspace });
  if (closedAt !== null) await w.store.sessions.update(created.id, { closedAt: new Date(closedAt).toISOString() });
  return created.id;
}

/** A Switchboard worktree (`session/<name>`) of web-front for a session, with one commit. */
async function sessionWorktree(w: GitWorld, name: string, sessionId: string): Promise<WorktreeRecord> {
  const m = w.manager();
  const [record] = await m.createForSession(name, ['web-front'], w.folder);
  await m.assign([record as WorktreeRecord], sessionId);
  await w.commit((record as WorktreeRecord).path, `${name}.txt`, `${name}\n`);
  return (await w.store.worktrees.get((record as WorktreeRecord).id)) as WorktreeRecord;
}

/** A store where the grace is long past, so a session's period counts from its `closedAt`. */
async function pastGrace(r: Rig): Promise<void> {
  await r.w.store.settings.set(ARCHIVE_SINCE_SETTING, new Date(r.clock.now - 400 * DAY).toISOString());
}

describe('the archive · deadline (D137)', () => {
  it('upgrade grace: a session archived before the first run counts from that run, so nothing goes on upgrade day', async () => {
    const r = await rig();
    const old = await session(r.w, 'old-one', r.clock.now - 40 * DAY);
    const first = await r.archive.sweep();
    expect(first.lastDeleted).toBeNull();
    expect(await r.w.store.sessions.get(old)).not.toBeNull();
    const since = await r.w.store.settings.get(ARCHIVE_SINCE_SETTING);
    expect(since).toBe(new Date(r.clock.now).toISOString());
    expect((await r.archive.info({ id: old, closedAt: new Date(r.clock.now - 40 * DAY).toISOString() })).deletesAt).toBe(new Date(r.clock.now + 14 * DAY).toISOString());
    // The grace is written once: a later run keeps it.
    r.clock.now += 13 * DAY;
    await r.archive.sweep();
    expect(await r.w.store.settings.get(ARCHIVE_SINCE_SETTING)).toBe(since);
    expect(await r.w.store.sessions.get(old)).not.toBeNull();
    r.clock.now += DAY + 60_000;
    await r.archive.sweep();
    expect(await r.w.store.sessions.get(old)).toBeNull();
  });

  it('counts from closedAt once the grace is past; a restore resets the countdown when archived again; open sessions never go', async () => {
    const r = await rig();
    await pastGrace(r);
    const due = await session(r.w, 'due-one', r.clock.now - 15 * DAY);
    const notYet = await session(r.w, 'not-yet', r.clock.now - 13 * DAY);
    const restored = await session(r.w, 'restored', r.clock.now - 20 * DAY);
    const open = await session(r.w, 'still-open', null);
    // Restored and archived again today: a new period.
    await r.w.store.sessions.update(restored, { closedAt: null });
    await r.w.store.sessions.update(restored, { closedAt: new Date(r.clock.now).toISOString() });
    await r.archive.sweep();
    expect(await r.w.store.sessions.get(due)).toBeNull();
    for (const id of [notYet, restored, open]) expect(await r.w.store.sessions.get(id)).not.toBeNull();
    const record = await r.w.store.sessions.get(notYet);
    expect(await r.archive.info(record as { id: string; closedAt: string })).toEqual({ deletesAt: new Date(r.clock.now + DAY).toISOString(), keptReason: null });
    expect(await r.archive.info({ id: open, closedAt: null })).toEqual({ deletesAt: null, keptReason: null });
  });

  it('the period follows the setting; Never keeps every archived session (no deadline)', async () => {
    const r = await rig();
    await pastGrace(r);
    const eight = await session(r.w, 'eight-days', r.clock.now - 8 * DAY);
    const old = await session(r.w, 'year-old', r.clock.now - 300 * DAY);
    await r.w.store.settings.set('sessions.archiveDays', 0);
    expect((await r.archive.info({ id: old, closedAt: new Date(r.clock.now - 300 * DAY).toISOString() })).deletesAt).toBeNull();
    await r.archive.sweep();
    expect(await r.w.store.sessions.get(old)).not.toBeNull();
    await r.w.store.settings.set('sessions.archiveDays', 30);
    await r.archive.sweep();
    expect(await r.w.store.sessions.get(old)).toBeNull();
    expect(await r.w.store.sessions.get(eight)).not.toBeNull();
    await r.w.store.settings.set('sessions.archiveDays', 7);
    await r.archive.sweep();
    expect(await r.w.store.sessions.get(eight)).toBeNull();
  });

  it('toSession sends deletesAt / keptReason on an archived session only', async () => {
    const r = await rig();
    await pastGrace(r);
    const closedAt = r.clock.now - 3 * DAY;
    const archived = await session(r.w, 'archived', closedAt);
    const open = await session(r.w, 'open', null);
    const a = await toSession(r.w.store, (await r.w.store.sessions.get(archived))!);
    expect(a.deletesAt).toBe(new Date(closedAt + 14 * DAY).toISOString());
    expect(a.keptReason).toBeNull();
    const o = await toSession(r.w.store, (await r.w.store.sessions.get(open))!);
    expect('deletesAt' in o).toBe(false);
    expect('keptReason' in o).toBe(false);
  });
});

describe('the archive · kept past the period (D137)', () => {
  it('running, a crew member, a plan, a plan step, an active routine, a CLI schedule and a pin keep a due session; each is re-checked every sweep', async () => {
    const r = await rig();
    await pastGrace(r);
    const at = r.clock.now - 30 * DAY;
    const running = await session(r.w, 'running', at);
    const member = await session(r.w, 'member', at);
    const owner = await session(r.w, 'plan-owner', at);
    const step = await session(r.w, 'plan-step', at);
    const routine = await session(r.w, 'routine', at);
    const ended = await session(r.w, 'ended-routine', at);
    const cli = await session(r.w, 'cli-schedule', at);
    const pinned = await session(r.w, 'pinned', at);
    const plain = await session(r.w, 'plain', at);
    r.live.add(running);
    registerTeamHooks(r.w.store, {
      charterFor: async () => null,
      roleOf: () => null,
      memberOf: (id) => (id === member ? { id: 'm1', name: 'Reviewer', teamId: 't1', sessionId: id, machineId: 'here', here: true, paused: false } : null),
    });
    let planHolds: Map<string, 'plan' | 'plan-step'> | null = new Map([
      [owner, 'plan'],
      [step, 'plan-step'],
    ]);
    registerPlanHooks(r.w.store, { sessionContinued: async () => undefined, inboxMerge: async () => null, outcomes: async () => null, itemsOfTodos: async () => [], archiveHolds: async () => planHolds });
    const loop = { label: null, prompt: 'check', schedule: { kind: 'every' as const, minutes: 30 }, expiresAt: null, maxRuns: null, nextFireAt: null, createdBy: 'developer' as const };
    await r.w.store.sessionLoops.create({ ...loop, id: 'aaaaaaaaaa', sessionId: routine });
    await r.w.store.sessionLoops.create({ ...loop, id: 'bbbbbbbbbb', sessionId: ended, state: 'ended' });
    await r.w.store.loops.create({ sessionId: cli, kind: 'CronCreate', label: 'nightly', expiresAt: null });
    await r.w.store.sidebar.update((layout) => ({ ...layout, pinned: [...layout.pinned, pinned] }));

    const holds = await r.archive.holds();
    expect(Object.fromEntries(holds)).toEqual({ [running]: 'running', [member]: 'crew', [owner]: 'plan', [step]: 'plan-step', [routine]: 'routine', [cli]: 'cli-schedule', [pinned]: 'pinned' });
    expect(await r.archive.info({ id: pinned, closedAt: new Date(at).toISOString() })).toEqual({ deletesAt: null, keptReason: 'pinned' });
    await r.archive.sweep();
    for (const id of [running, member, owner, step, routine, cli, pinned]) expect(await r.w.store.sessions.get(id)).not.toBeNull();
    for (const id of [ended, plain]) expect(await r.w.store.sessions.get(id)).toBeNull();

    // The holds go: the next sweep deletes them.
    r.live.delete(running);
    planHolds = new Map();
    await r.w.store.sidebar.update((layout) => ({ ...layout, pinned: layout.pinned.filter((id) => id !== pinned) }));
    await r.archive.sweep();
    for (const id of [running, owner, step, pinned]) expect(await r.w.store.sessions.get(id)).toBeNull();
    for (const id of [member, routine, cli]) expect(await r.w.store.sessions.get(id)).not.toBeNull();
  });

  it('deletes nothing while Plans cannot say which sessions it needs (plans.db not open)', async () => {
    const r = await rig();
    await pastGrace(r);
    const due = await session(r.w, 'due', r.clock.now - 30 * DAY);
    registerPlanHooks(r.w.store, { sessionContinued: async () => undefined, inboxMerge: async () => null, outcomes: async () => null, itemsOfTodos: async () => [], archiveHolds: async () => null });
    await r.archive.sweep();
    expect(await r.w.store.sessions.get(due)).not.toBeNull();
    expect(r.lines.join('\n')).toContain('skipped');
  });
});

describe('the archive · the session’s worktrees (D137, choice 4)', () => {
  it('a clean, merged worktree goes with its session; the branch stays', async () => {
    const r = await rig();
    await pastGrace(r);
    const id = await session(r.w, 'merged', r.clock.now - 20 * DAY);
    const wt = await sessionWorktree(r.w, 'merged', id);
    await r.w.git(r.w.web, 'merge', '-q', '--ff-only', 'session/merged');
    const record = await r.archive.sweep();
    expect(await r.w.store.sessions.get(id)).toBeNull();
    expect(await exists(wt.path)).toBe(false);
    expect((await r.w.store.worktrees.get(wt.id))?.removedAt).not.toBeNull();
    expect(await r.w.git(r.w.web, 'branch', '--list', 'session/merged')).toContain('session/merged');
    expect(record.lastDeleted).toMatchObject({ sessions: 1, worktrees: 1, keptWorktrees: [] });
    // Never forced.
    expect((await r.w.gitCalls()).some((call) => call.argv.includes('--force'))).toBe(false);
  });

  it('kept: uncommitted changes, unmerged commits, a merged PR with commits only on this computer, and a worktree another session uses; a merged PR whose commits are pushed goes', async () => {
    const r = await rig();
    await pastGrace(r);
    const at = r.clock.now - 20 * DAY;
    const dirty = await session(r.w, 'dirty', at);
    const dirtyWt = await sessionWorktree(r.w, 'dirty', dirty);
    await r.w.git(r.w.web, 'merge', '-q', '--ff-only', 'session/dirty');
    await writeFile(path.join(dirtyWt.path, 'notes.txt'), 'not committed\n');
    const unmerged = await session(r.w, 'unmerged', at);
    const unmergedWt = await sessionWorktree(r.w, 'unmerged', unmerged);
    const local = await session(r.w, 'local-only', at);
    const localWt = await sessionWorktree(r.w, 'local-only', local);
    await r.w.store.worktrees.update(localWt.id, { prState: 'MERGED' });
    const pushed = await session(r.w, 'pushed', at);
    const pushedWt = await sessionWorktree(r.w, 'pushed', pushed);
    await r.w.git(pushedWt.path, 'push', '-q', 'origin', 'session/pushed');
    await r.w.store.worktrees.update(pushedWt.id, { prState: 'MERGED' });
    const shared = await session(r.w, 'shared', at);
    const sharedWt = await sessionWorktree(r.w, 'shared', shared);
    await r.w.git(r.w.web, 'merge', '-q', '--ff-only', 'session/shared');
    await session(r.w, 'neighbour', null, { cwd: sharedWt.path });

    const record = await r.archive.sweep();
    for (const id of [dirty, unmerged, local, pushed, shared]) expect(await r.w.store.sessions.get(id)).toBeNull();
    for (const wt of [dirtyWt, unmergedWt, localWt, sharedWt]) {
      expect(await exists(wt.path), wt.path).toBe(true);
      expect((await r.w.store.worktrees.get(wt.id))?.removedAt ?? null).toBeNull();
    }
    expect(await exists(pushedWt.path)).toBe(false);
    const reasons = Object.fromEntries((record.lastDeleted?.keptWorktrees ?? []).map((kept) => [kept.path, kept.reason]));
    expect(reasons[dirtyWt.path]).toBe('1 uncommitted change');
    expect(reasons[unmergedWt.path]).toMatch(/^not merged into /);
    expect(reasons[localWt.path]).toBe('1 commit only on this computer');
    expect(reasons[sharedWt.path]).toBe('also used by neighbour');
    expect(record.lastDeleted).toMatchObject({ sessions: 5, worktrees: 1 });
    expect(r.lines.filter((line) => line.startsWith('[archive] kept worktree'))).toHaveLength(4);
    expect((await r.w.gitCalls()).some((call) => call.argv.includes('--force'))).toBe(false);
  });
});

describe('the archive · the sweep (D137)', () => {
  it('is idempotent, keeps its record (last run, last deletions), removes the session’s data and leaves artifacts without a session', async () => {
    const r = await rig();
    await pastGrace(r);
    const id = await session(r.w, 'gone', r.clock.now - 20 * DAY);
    await session(r.w, 'stays', r.clock.now - 2 * DAY);
    const folder = path.join(r.dataDir, 'attachments', id);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'a.png'), 'x');
    const first = await r.archive.sweep();
    expect(first).toEqual({ lastRunAt: new Date(r.clock.now).toISOString(), lastDeleted: { at: new Date(r.clock.now).toISOString(), sessions: 1, worktrees: 0, keptWorktrees: [] } });
    expect(await exists(folder)).toBe(false);
    expect(r.lines.some((line) => line.startsWith('[archive] deleted archived session gone'))).toBe(true);
    r.clock.now += 60 * 60_000;
    const second = await r.archive.sweep();
    expect(second.lastRunAt).toBe(new Date(r.clock.now).toISOString());
    expect(second.lastDeleted).toEqual(first.lastDeleted);
    expect(readArchiveSweep(await r.w.store.settings.get('sessions.archiveSweep'))).toEqual(second);
    // Two sweeps at once are one.
    const [a, b] = await Promise.all([r.archive.sweep(), r.archive.sweep()]);
    expect(a).toBe(b);
  });
});

describe('the archive · Clean-up’s Archived sessions group (D137)', () => {
  it('with a period it lists only archived sessions past it (a kept one unticked, with its reason); Never keeps Clean-up’s own limit', async () => {
    const r = await rig();
    await pastGrace(r);
    const cleanup = new CleanupService({ store: r.w.store, dataDir: r.dataDir, gitCommand: GIT_SPY_COMMAND, env: r.w.env, now: () => new Date(r.clock.now) });
    cleanup.useArchive(r.archive);
    const due = await session(r.w, 'due', r.clock.now - 20 * DAY);
    const pinned = await session(r.w, 'pinned', r.clock.now - 20 * DAY);
    const recent = await session(r.w, 'recent', r.clock.now - 5 * DAY);
    await r.w.store.sidebar.update((layout) => ({ ...layout, pinned: [pinned] }));
    const scan = await cleanup.scan();
    expect(scan.archiveDays).toBe(14);
    const items = scan.items.filter((item) => item.group === 'sessions');
    expect(items.map((item) => [item.id, item.selected, item.reasons])).toEqual(
      expect.arrayContaining([
        [`ses:${due}`, true, ['archive-due']],
        [`ses:${pinned}`, false, ['archive-due']],
      ]),
    );
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.id === `ses:${pinned}`)?.keeps[0]).toBe('Kept by the archive: pinned');
    expect(items.some((item) => item.id === `ses:${recent}`)).toBe(false);
    // Never: Clean-up's own limit (30 days by default) applies again, and its stored value is untouched.
    await r.w.store.settings.set('sessions.archiveDays', 0);
    await r.w.store.settings.set('cleanup.closedSessionDays', 3);
    const never = await cleanup.scan();
    expect(never.archiveDays).toBeNull();
    expect(never.items.filter((item) => item.group === 'sessions').map((item) => item.id).sort()).toEqual([`ses:${due}`, `ses:${pinned}`, `ses:${recent}`].sort());
    expect(await r.w.store.settings.get('cleanup.closedSessionDays')).toBe(3);
  });
});
