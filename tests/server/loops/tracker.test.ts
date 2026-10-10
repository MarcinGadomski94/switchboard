import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HubEventName, HubEvents } from '../../../src/core/api.ts';
import { CRON_EXPIRY_MS, SESSION_ONLY_NOTE } from '../../../src/core/derive/loops.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { toLoop } from '../../../src/server/loops/wire.ts';
import { findLoopProgress, sessionWorkingFolders } from '../../../src/server/loops/progress.ts';
import { LoopTracker, loopRowId } from '../../../src/server/loops/tracker.ts';
import { toSession } from '../../../src/server/sessions/wire.ts';
import { openTempStore } from '../../helpers/store.ts';
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

    // D93: pausing ends the process: the session-only schedule is gone, and so is its card (row deleted, published).
    await w.supervisor.pause(session.id);
    await until(async () => {
      await tracker?.idle();
      return (await loopsOf(w, session.id)).length === 0 ? true : undefined;
    }, 'the stop');
    const after = seen.filter((e) => e.name === 'sessionUpdated').map((e) => e.payload as HubEvents['sessionUpdated']);
    expect(after.at(-1)?.loops).toEqual([]);
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

  it('sweep() re-derives tracker rows whose process ended while no tracker listened (D93: they are deleted); demo-seeded rows are left alone', async () => {
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
    expect(await w.store.loops.get(loopRowId(session.id, 'loop'))).toBeNull();
    expect(await w.store.loops.get(seeded.id)).toEqual(seeded);
  });
});

describe('LoopTracker · D93 stale rows', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('the start sweep deletes the rows of loops that ended (cancelled, expired, an earlier process), in time order even when imported turns were stored late, and keeps the live one-shot', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sb-loops-d93-'));
    const store = await openTempStore(dir);
    const silent = { on: () => () => undefined };
    try {
      const session = await store.sessions.create({ name: 'monitor', claudeSessionId: 'c-monitor', solutions: [], root: dir, rootKind: 'repo', cwd: dir });
      const tool = (ts: string, toolUseId: string, name: string, input: Record<string, unknown>, result: string, isError = false) =>
        store.events.append({ sessionId: session.id, kind: 'tool', ts, label: name, toolUseId, payload: { type: 'tool', name, toolUseId, input, result, isError } });
      const created = (id: string) => `Scheduled recurring job ${id} (Every 30 minutes). Session-only. Auto-expires after 7 days.`;
      // The process change and the current process's one-shot were stored first; the earlier (imported) turns after them.
      await store.events.append({ sessionId: session.id, kind: 'text', ts: '2026-10-05T08:44:26.000Z', label: 'Continued in Switchboard', payload: { type: 'lifecycle', action: 'continued' } });
      await tool('2026-10-09T19:20:53.000Z', 'tu-5', 'CronCreate', { cron: '22 18 13 10 *', recurring: false }, 'Scheduled one-shot job c5555555.');
      await tool('2026-09-29T18:24:57.000Z', 'tu-2', 'CronCreate', { cron: '7,37 * * * *' }, created('e2222222'));
      await tool('2026-10-03T19:35:02.000Z', 'tu-3', 'CronCreate', { cron: '10,40 * * * *' }, created('a3333333'));
      await tool('2026-10-05T07:07:25.000Z', 'tu-d', 'CronDelete', { id: 'a3333333' }, 'Cancelled job a3333333');
      await tool('2026-10-05T07:08:22.000Z', 'tu-4', 'CronCreate', { cron: '10,40 * * * *' }, created('b4444444'));
      // Rows a pre-D93 build left behind for those jobs.
      for (const key of ['cron-tu-2', 'cron-tu-3', 'cron-tu-4']) {
        await store.loops.create({ id: loopRowId(session.id, key), sessionId: session.id, kind: 'CronCreate', label: 'cron stale', nextFireAt: null, expiresAt: null });
      }
      const seeded = await store.loops.create({ sessionId: session.id, kind: '/loop', label: 'seeded' });

      tracker = new LoopTracker({ store, events: silent, now: () => new Date('2026-10-09T20:00:00.000Z'), debounceMs: 20 });
      await tracker.sweep();
      const rows = await store.loops.list(session.id);
      expect(rows.map((row) => [row.id, row.label])).toEqual([
        [seeded.id, 'seeded'],
        [loopRowId(session.id, 'cron-tu-5'), 'cron 22 18 13 10 *'],
      ]);
    } finally {
      await tracker?.close();
      tracker = undefined;
      await store.close();
    }
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

describe('LoopTracker · unlisted schedules', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('a supervised session: the CLI-written prompts come from its transcript, the turns and the process from its stored events; the row goes with the process', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sb-loops-unlisted-'));
    const store = await openTempStore(dir);
    const transcript = path.join(dir, 'c-watch.jsonl');
    const prompt = 'Production monitoring shift: sweep the error logs.';
    // Relative to the wall clock: `toSession` hides a series that stopped by the real time.
    const base = Date.now() - 100 * 60_000;
    const times = [0, 30, 60, 90].map((m) => new Date(base + m * 60_000).toISOString());
    const lines = times.map((timestamp, i) => ({
      parentUuid: i === 0 ? null : `u${i - 1}`,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: prompt },
      promptSource: 'system',
      uuid: `u${i}`,
      timestamp,
      entrypoint: 'sdk-cli',
      cwd: dir,
      sessionId: 'c-watch',
    }));
    await writeFile(transcript, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    let clock = new Date(base + 95 * 60_000);
    try {
      const session = await store.sessions.create({ name: 'watch', claudeSessionId: 'c-watch', solutions: [], root: dir, rootKind: 'repo', cwd: dir });
      await store.events.append({ sessionId: session.id, kind: 'text', ts: new Date(base - 10 * 60_000).toISOString(), label: 'Continued in Switchboard', payload: { type: 'lifecycle', action: 'continued' } });
      for (const ts of times) {
        const end = new Date(Date.parse(ts) + 40_000).toISOString();
        await store.events.append({ sessionId: session.id, kind: 'ok', ts: end, label: 'Nothing new.', payload: { type: 'result', isError: false, taskNotification: false } });
      }
      tracker = new LoopTracker({ store, events: { on: () => () => undefined }, now: () => clock, debounceMs: 20 });
      tracker.useTranscripts(async (record) => (record.claudeSessionId === 'c-watch' ? transcript : null));
      const [row] = await tracker.refresh(session.id);
      expect(row).toMatchObject({ kind: 'Unlisted', label: 'Unlisted schedule in the CLI', iteration: 4, nextFireAt: null, expiresAt: null });
      expect(row?.iterations.map((it) => it.label)).toEqual(['Nothing new.', 'Nothing new.', 'Nothing new.', 'Nothing new.']);
      expect(row?.note).toMatch(/^Prompt: "Production monitoring shift: sweep the error logs\."\. Started by the CLI itself about every 30 min;/);
      // The API shape carries it while the series runs, not after it stopped.
      const record = await store.sessions.get(session.id);
      expect((await toSession(store, record!)).loops.map((loop) => loop.kind)).toEqual(['Unlisted']);

      // Pause: the process ended, the row goes.
      await store.events.append({ sessionId: session.id, kind: 'text', ts: new Date(base + 96 * 60_000).toISOString(), label: 'Paused', payload: { type: 'lifecycle', action: 'paused' } });
      clock = new Date(base + 97 * 60_000);
      expect(await tracker.refresh(session.id)).toEqual([]);
    } finally {
      await tracker?.close();
      tracker = undefined;
      await store.close();
    }
  });
});

describe('LoopTracker · D95 incremental refresh', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('a refresh reads only the events written since the last one (the whole history once), and derives the same loops', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sb-loops-d95-'));
    const store = await openTempStore(dir);
    const silent = { on: () => () => undefined };
    try {
      const session = await store.sessions.create({ name: 'long', claudeSessionId: 'c-long', solutions: [], root: dir, rootKind: 'repo', cwd: dir });
      const base = Date.parse('2026-10-10T08:00:00.000Z');
      let n = 0;
      const ts = (): string => new Date(base + (n += 1) * 1000).toISOString();
      for (let i = 0; i < 300; i += 1) {
        await store.events.append({ sessionId: session.id, kind: 'plan', ts: ts(), label: 'Read', toolUseId: `tu-${i}`, payload: { type: 'tool', name: 'Read', toolUseId: `tu-${i}`, input: { file_path: '/a' }, result: 'x'.repeat(2000) } });
      }
      await store.events.append({ sessionId: session.id, kind: 'loop', ts: ts(), label: 'CronCreate', toolUseId: 'tu-cron', payload: { type: 'tool', name: 'CronCreate', toolUseId: 'tu-cron', input: { cron: '*/30 * * * *', prompt: 'check' }, result: 'Scheduled recurring job c0ffee00' } });
      const reads = { list: 0, byIds: [] as number[][] };
      const list = store.events.list.bind(store.events);
      const byIds = store.events.byIds.bind(store.events);
      store.events.list = async (...args) => {
        reads.list += 1;
        return list(...args);
      };
      store.events.byIds = async (sessionId, ids) => {
        reads.byIds.push([...ids]);
        return byIds(sessionId, ids);
      };
      tracker = new LoopTracker({ store, events: silent, now: () => new Date(base + 3_600_000), debounceMs: 20 });
      const first = await tracker.refresh(session.id);
      expect(first.map((loop) => loop.label)).toEqual(['cron */30 * * * *']);
      expect(reads).toEqual({ list: 1, byIds: [] });

      // Nothing written: nothing read.
      await tracker.refresh(session.id);
      expect(reads).toEqual({ list: 1, byIds: [] });

      // Two new events and an update: only those three are read.
      const result = await store.events.append({ sessionId: session.id, kind: 'ok', ts: ts(), label: 'fired', payload: { type: 'result', subtype: 'success', isError: false, text: 'ok', terminalReason: null, errors: [], taskNotification: false, numTurns: 1, durationMs: 1, costUsd: 0 } });
      const text = await store.events.append({ sessionId: session.id, agentId: null, kind: 'text', ts: ts(), label: 'checking', payload: { type: 'assistant', text: 'checking', messageId: 'm1' } });
      await store.events.update(text.id, { payload: { type: 'assistant', text: 'checking, more', messageId: 'm1' } });
      const again = await tracker.refresh(session.id);
      expect(reads.list).toBe(1);
      expect(reads.byIds.map((ids) => [...ids].sort((a, b) => a - b))).toEqual([[result.id, text.id]]);
      expect(again[0]?.iteration).toBe((first[0]?.iteration ?? 0) + 1);
    } finally {
      await tracker?.close();
      tracker = undefined;
      await store.close();
    }
  });
});
