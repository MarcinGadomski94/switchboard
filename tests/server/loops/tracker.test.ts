import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HubEventName, HubEvents } from '../../../src/core/api.ts';
import { CRON_EXPIRY_MS, SESSION_ONLY_NOTE } from '../../../src/core/derive/loops.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { toLoop } from '../../../src/server/loops/wire.ts';
import { findLoopProgress, sessionWorkingFolders } from '../../../src/server/loops/progress.ts';
import { LoopTracker, loopRowId } from '../../../src/server/loops/tracker.ts';
import { toSession } from '../../../src/server/sessions/wire.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * LoopTracker (M7.2, D9) on the real path: the SessionSupervisor runs fake-claude,
 * the tracker hears its events, derives the loops and stores them; cap + breaker
 * come from a `.loop/progress.md` in the session's solution folder.
 */
let world: SupervisorWorld | undefined;
let tracker: LoopTracker | undefined;

afterEach(async () => {
  await tracker?.close();
  tracker = undefined;
  await world?.cleanup();
  world = undefined;
});

const PROGRESS = ['## Current', 'item: M3.2', 'attempt: 2/5', '## Done', '- M3.1 ✓', '## Breaker', 'consecutive_blocked: 1', ''].join('\n');

function recorder(bus: HubBus): Array<{ name: HubEventName; payload: unknown }> {
  const seen: Array<{ name: HubEventName; payload: unknown }> = [];
  bus.subscribe((message) => seen.push({ name: message.name, payload: message.payload }));
  return seen;
}

async function loopsOf(w: SupervisorWorld, sessionId: string) {
  return (await w.store.loops.list(sessionId)).map(toLoop);
}

describe('LoopTracker', () => {
  it('stores a /loop with its CronCreate, firings, progress-file cap + breaker, and publishes sessionUpdated; a pause stops it', async () => {
    world = await makeSupervisorWorld({ extraArgs: ['--replay-user-messages'] });
    const w = world;
    const folder = path.join(w.workspace, 'other', 'loopy');
    await mkdir(path.join(folder, '.loop'), { recursive: true });
    await writeFile(path.join(folder, '.loop', 'progress.md'), PROGRESS);
    const bus = new HubBus();
    const seen = recorder(bus);
    tracker = new LoopTracker({ store: w.store, events: w.supervisor, bus, debounceMs: 20 });

    const session = await w.supervisor.start(newSession({ name: 'loopy', task: 'Hello', solutions: ['other/loopy'] }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await tracker.idle();
    expect(await w.store.loops.list(session.id)).toEqual([]);

    await w.supervisor.sendMessage(session.id, '/loop 5m check the build [fake:tool CronCreate {"cron":"*/5 * * * *","prompt":"check the build","recurring":true}] [fake:fire 2 150]');
    const loops = await until(async () => {
      await tracker?.idle();
      const rows = await loopsOf(w, session.id);
      return rows[0]?.iteration === 3 ? rows : undefined;
    }, 'three iterations');
    expect(loops).toHaveLength(1);
    const [loop] = loops;
    expect(loop).toMatchObject({
      id: loopRowId(session.id, 'loop'),
      sessionId: session.id,
      kind: '/loop',
      label: '/loop 5m',
      iteration: 3,
      cap: 5,
      breakerCount: 1,
      breakerState: null,
      progressPath: 'other/loopy/.loop/progress.md',
      note: `${SESSION_ONLY_NOTE} Last iteration: OK. Cap and breaker from other/loopy/.loop/progress.md.`,
    });
    expect(loop?.iterations.map((it) => it.result)).toEqual(['ok', 'ok', 'ok']);
    const cronEvent = (await w.store.events.list(session.id)).find((e) => (e.payload as { name?: string }).name === 'CronCreate');
    expect(loop?.expiresAt).toBe(new Date(Date.parse(cronEvent?.ts ?? '') + CRON_EXPIRY_MS).toISOString());
    expect(Date.parse(loop?.nextFireAt ?? '')).toBeGreaterThan(Date.now() - 1000);
    expect(new Date(loop?.nextFireAt ?? '').getMinutes() % 5).toBe(0);

    // The API shape carries it, and the hub heard about it.
    const record = await w.store.sessions.get(session.id);
    expect((await toSession(w.store, record!)).loops).toEqual(loops);
    const updates = seen.filter((e) => e.name === 'sessionUpdated').map((e) => e.payload as HubEvents['sessionUpdated']);
    expect(updates.at(-1)?.loops[0]).toMatchObject({ iteration: 3, cap: 5 });

    // Pausing ends the process: the session-only schedule is gone.
    await w.supervisor.pause(session.id);
    const stopped = await until(async () => {
      await tracker?.idle();
      const [row] = await loopsOf(w, session.id);
      return row?.nextFireAt === null ? row : undefined;
    }, 'the stop');
    expect(stopped).toMatchObject({ iteration: 3, expiresAt: null, cap: 5 });
    expect(stopped.note).toBe("Stopped: the session's claude process ended. Last iteration: OK. Cap and breaker from other/loopy/.loop/progress.md.");
  });

  it('ScheduleWakeup and Workflow sessions; no progress file → cap and breaker stay null; other sessions get no rows', async () => {
    world = await makeSupervisorWorld({ extraArgs: ['--replay-user-messages'] });
    const w = world;
    tracker = new LoopTracker({ store: w.store, events: w.supervisor, debounceMs: 20 });

    const plain = await w.supervisor.start(newSession({ name: 'plain', task: 'Just reply' }), w.place);
    const wake = await w.supervisor.start(newSession({ name: 'wake', task: '/loop watch the queue [fake:tool ScheduleWakeup {"delaySeconds":1200,"reason":"next check"}]' }), w.place);
    const flow = await w.supervisor.start(newSession({ name: 'flow', task: 'Roll out [fake:tool Workflow {"name":"button rollout"}]' }), w.place);
    for (const id of [plain.id, wake.id, flow.id]) await waitForStatus(w.store, id, ['done']);

    const [wakeLoop] = await until(async () => {
      await tracker?.idle();
      const rows = await loopsOf(w, wake.id);
      return rows[0]?.iterations[0]?.result === 'ok' ? rows : undefined;
    }, 'the wake-up loop');
    const wakeCall = (await w.store.events.list(wake.id)).find((e) => (e.payload as { name?: string }).name === 'ScheduleWakeup');
    expect(wakeLoop).toMatchObject({ kind: '/loop', label: '/loop', iteration: 1, cap: null, breakerCount: null, expiresAt: null, progressPath: null });
    expect(wakeLoop?.nextFireAt).toBe(new Date(Date.parse(wakeCall?.ts ?? '') + 1_200_000).toISOString());

    const [flowLoop] = await until(async () => {
      await tracker?.idle();
      const rows = await loopsOf(w, flow.id);
      return rows[0]?.iterations[0]?.result === 'ok' ? rows : undefined;
    }, 'the workflow card');
    expect(flowLoop).toMatchObject({ kind: 'Workflow', label: 'Workflow · button rollout', iteration: 1, nextFireAt: null, expiresAt: null });
    expect(flowLoop?.note).toBe('Last iteration: fake-claude: Workflow done.');

    await tracker.idle();
    expect(await w.store.loops.list(plain.id)).toEqual([]);
  });

  it('sweep() re-derives tracker rows whose process ended while no tracker listened; demo-seeded rows are left alone', async () => {
    world = await makeSupervisorWorld({ extraArgs: ['--replay-user-messages'] });
    const w = world;
    tracker = new LoopTracker({ store: w.store, events: w.supervisor, debounceMs: 20 });
    const session = await w.supervisor.start(newSession({ name: 'sweepy', task: '/loop 1h sweep [fake:tool CronCreate {"cron":"7 * * * *","prompt":"sweep"}]' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const [live] = await until(async () => {
      await tracker?.idle();
      const rows = await loopsOf(w, session.id);
      return rows[0]?.nextFireAt ? rows : undefined;
    }, 'the scheduled loop');
    expect(live?.expiresAt).not.toBeNull();
    const seeded = await w.store.loops.create({ sessionId: session.id, kind: '/loop', label: 'seeded', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });

    // The service stops listening, then the process ends (as on a service stop).
    await tracker.close();
    await w.supervisor.pause(session.id);
    await waitForStatus(w.store, session.id, ['paused']);
    expect((await w.store.loops.get(loopRowId(session.id, 'loop')))?.nextFireAt).not.toBeNull();

    tracker = new LoopTracker({ store: w.store, events: w.supervisor, debounceMs: 20 });
    await tracker.sweep();
    const row = await w.store.loops.get(loopRowId(session.id, 'loop'));
    expect(row).toMatchObject({ nextFireAt: null, expiresAt: null });
    expect(await w.store.loops.get(seeded.id)).toEqual(seeded);
  });
});

describe('loop progress in the session\'s own folder (D14)', () => {
  it('a repo session: its worktree, the repo and its cwd; the shown path is relative to its folder', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const repo = path.join(w.root, 'solo');
    const worktree = path.join(w.root, 'solo-wt-loopy');
    await mkdir(path.join(repo, '.loop'), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(repo, '.loop', 'progress.md'), PROGRESS);
    const session = await w.store.sessions.create({ name: 'loopy', claudeSessionId: 'c-loopy', solutions: ['solo'], root: repo, rootKind: 'repo', cwd: worktree });
    await w.store.worktrees.create({ repo: 'solo', repoPath: repo, branch: 'session/loopy', path: worktree, sessionId: session.id });
    const folders = await sessionWorkingFolders(w.store, session);
    expect(folders).toEqual([worktree, repo]);
    const found = await findLoopProgress(folders, repo);
    expect(found).toMatchObject({ file: path.join(repo, '.loop', 'progress.md'), shown: '.loop/progress.md' });
    // A workspace session: its solutions under its own root (not any other folder).
    const ws = await w.store.sessions.create({ name: 'in-ws', claudeSessionId: 'c-in-ws', solutions: ['other/loopy'], root: w.workspace, rootKind: 'workspace', cwd: w.workspace });
    expect(await sessionWorkingFolders(w.store, ws)).toEqual([path.join(w.workspace, 'other', 'loopy'), w.workspace]);
  });
});
