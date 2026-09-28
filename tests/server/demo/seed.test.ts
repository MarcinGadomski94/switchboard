import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/server/db/store.ts';
import { loadDemoData } from '../../../src/server/demo/data.ts';
import { DemoSeedError, assertDemoDataDir, startDemo } from '../../../src/server/demo/index.ts';
import { DEMO_SEED_KEY, DEMO_SEED_VERSION, seedDemo, solutionOf } from '../../../src/server/demo/seed.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

const NOW = new Date('2026-09-28T12:00:00.000Z');
const BASE = new Date('2026-09-28T10:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await makeTempDir('demo-seed');
  store = await openTempStore(tmp);
});

afterEach(async () => {
  await store.close();
  await removeTempDir(tmp);
});

describe('seedDemo (gap #21)', () => {
  it('loads the prototype sessions with agents, events and open question batches', async () => {
    const data = await loadDemoData();
    expect(await seedDemo(store, data, { now: NOW, timelineBase: BASE })).toEqual({ seeded: true, sessions: 6 });

    const sessions = await store.sessions.list();
    expect(sessions.map((s) => s.name)).toEqual(data.sessions.map((s) => s.name)); // newest activity first
    const free = await store.sessions.get('free-talk-feature');
    expect(free).toMatchObject({
      name: 'free-talk-feature',
      claudeSessionId: '7f3a2c91',
      status: 'need',
      workType: 'feature',
      mode: 'orchestrator',
      phase: 'ui-first',
      solutions: ['acme-app-front', 'mobile'],
      worktrees: true,
      task: 'Free talk screen at 360, web and mobile in parallel. Figma frame is in the AI handoff page.',
      lastActivityAt: minutesAgo(1),
    });
    expect(await store.sessions.get('prod-monitoring')).toMatchObject({ workType: null, mode: null, phase: null, lastActivityAt: minutesAgo(41) });
    expect(await store.sessions.get('qa-free-talk')).toMatchObject({ workType: 'qa', status: 'run' });

    const agents = await store.agents.listBySession('free-talk-feature');
    expect(agents.map((a) => [a.name, a.kind, a.branch, a.status, a.statusText])).toEqual([
      ['orchestrator', 'main', null, 'need', 'needs you'],
      ['web', 'subagent', 'feature/free-talk-360', 'need', 'asked 1'],
      ['mobile', 'subagent', 'feature/free-talk-360', 'need', 'asked 1'],
      ['figma-extractor', 'subagent', null, 'done', 'done'],
    ]);

    const events = await store.events.list('free-talk-feature');
    const byChannel = (channel: string) => events.filter((e) => (e.payload as { channel: string }).channel === channel);
    expect(byChannel('chat').map((e) => e.kind)).toEqual(['text', 'text']);
    expect(byChannel('chat')[1]?.payload).toMatchObject({ role: 'assistant', tools: data.sessions[0]?.messages[1]?.tools });
    expect(byChannel('terminal').map((e) => e.label)).toEqual(data.sessions[0]?.terminal);
    const timeline = byChannel('timeline');
    expect(timeline).toHaveLength(16);
    const first = events.find((e) => e.label === 'task definition');
    expect(first).toMatchObject({ kind: 'plan', ts: '2026-09-28T10:02:00.000Z', endTs: '2026-09-28T10:05:00.000Z' });
    expect(first?.agentId).toBe(agents[0]?.id);

    const batches = await store.questions.listBatches({ states: ['open'] });
    expect(batches.map((b) => b.sessionId).sort()).toEqual(['button-rollout', 'free-talk-feature', 'notifications-integration']);
    const questions = await store.questions.questionsOf('demo-free-talk-feature');
    expect(questions.map((q) => [q.source, q.options.map((o) => o.label)])).toEqual(
      data.sessions[0]?.questions.map((q) => [q.source, q.options]),
    );
  });

  it('loads system items, worktrees, schedules with 14 runs, loops, artifacts and tools', async () => {
    const data = await loadDemoData();
    await seedDemo(store, data, { now: NOW, timelineBase: BASE });

    const items = await store.systemItems.list(['open']);
    expect(items.map((i) => [i.id, i.kind, i.status, i.createdAt])).toEqual([
      ['sys-run', 'schedule-run-failed', 'fail', minutesAgo(38)],
      ['sys-wt', 'worktree-removable', 'done', minutesAgo(20)],
    ].sort((a, b) => String(b[3]).localeCompare(String(a[3]))));
    const sysRun = items.find((i) => i.id === 'sys-run');
    expect(sysRun?.actions.map((a) => a.label)).toEqual(['Open fix session', 'Retry run', 'Dismiss']);
    expect(sysRun?.actions.map((a) => a.id)).toEqual(['open-fix-session', 'retry-run', 'dismiss']);
    // The prototype's "Open fix session" values (ns), in the contract's terms.
    expect(sysRun?.payload).toEqual({
      prefill: {
        name: 'fix-xamlc-acmchip',
        task: 'nightly-build-verify: FreeTalkView.xaml(41) unknown property AcmChip.Size. Fix on feature/free-talk-360.',
        solutions: ['mobile'],
        mode: 'single',
        phase: 'ui-first',
      },
    });
    const nightly = await store.schedules.getByName('nightly-build-verify');
    expect(sysRun?.scheduleId).toBe(nightly?.id);
    const runs = await store.schedules.recentRuns(nightly!.id);
    expect(runs).toHaveLength(14);
    expect(runs.map((r) => r.result)).toEqual(data.schedules[0]?.runs);
    // M7.1: the run ended when its item was raised; the summary without the view's "Failed 38m ago · " prefix.
    expect(runs[13]).toMatchObject({ ts: minutesAgo(43), finishedAt: minutesAgo(38), result: 'fail', summary: 'Android XamlC' });
    expect(sysRun?.scheduleRunId).toBe(runs[13]?.id);
    expect((await store.schedules.list()).map((s) => s.name)).toEqual(data.schedules.map((s) => s.name));

    const merged = await store.worktrees.get(items.find((i) => i.id === 'sys-wt')!.worktreeId!);
    expect(merged).toMatchObject({ repo: 'acme-app-front', branch: 'feature/speaking-page', prNumber: 231, prState: 'MERGED', removable: true });
    const worktrees = await store.worktrees.list();
    expect(worktrees).toHaveLength(10); // 9 from the Solutions rows (in-place branches have none) + the merged one
    expect(worktrees.find((w) => w.path === '../mobile-wt-free-talk-feature')).toMatchObject({ repo: 'mobile', sessionId: 'free-talk-feature' });

    const loops = await store.loops.list();
    expect(loops.map((l) => [l.sessionId, l.kind, l.iteration, l.cap, l.breakerState])).toEqual(
      expect.arrayContaining([
        ['prod-monitoring', '/loop', 17, null, null],
        ['button-rollout', 'Ralph', 9, 12, 'tripped'],
      ]),
    );

    const artifacts = await store.artifacts.list();
    expect(artifacts).toHaveLength(13);
    expect(artifacts.find((a) => a.name === 'Pages/FreeTalk · 6 files')).toMatchObject({
      type: 'DIFF',
      solution: 'acme-app-front',
      branch: 'feature/free-talk-360',
      sessionId: 'free-talk-feature',
      meta: '+284 −12',
      createdAt: minutesAgo(4),
    });

    expect((await store.tools.list()).map((t) => [t.id, t.name, t.url, t.position])).toEqual([
      ['cm', 'Codebase Memory', 'http://localhost:13000', 0],
      ['sw', 'Acme Tool', null, 1],
    ]);
    expect(await store.settings.get(DEMO_SEED_KEY)).toEqual({ version: DEMO_SEED_VERSION, seededAt: NOW.toISOString() });
  });

  it('is a no-op on a database that already holds the seed', async () => {
    const data = await loadDemoData();
    await seedDemo(store, data, { now: NOW });
    expect(await seedDemo(store, data, { now: NOW })).toEqual({ seeded: false, sessions: 0 });
    expect(await store.sessions.list()).toHaveLength(6);
  });

  it('refuses a database with real sessions and writes nothing', async () => {
    await store.sessions.create({ name: 'real-work', claudeSessionId: 'c1' });
    await expect(seedDemo(store, await loadDemoData())).rejects.toBeInstanceOf(DemoSeedError);
    expect((await store.sessions.list()).map((s) => s.name)).toEqual(['real-work']);
    expect(await store.settings.get(DEMO_SEED_KEY)).toBeUndefined();
  });

  it('rolls back everything when a row fails', async () => {
    const data = await loadDemoData();
    const broken = { ...data, artifacts: [...data.artifacts, { ...data.artifacts[0]!, type: 'NOPE' as never }] };
    await expect(seedDemo(store, broken, { now: NOW })).rejects.toThrow();
    expect(await store.sessions.list()).toEqual([]);
    expect(await store.settings.get(DEMO_SEED_KEY)).toBeUndefined();
  });

  it('refuses the real app-data folder and starts on a throwaway one', async () => {
    expect(() => assertDemoDataDir('/home/u/.local/share/switchboard', '/home/u/.local/share/switchboard/')).toThrow(DemoSeedError);
    expect(() => assertDemoDataDir(path.join(tmp, 'data'), '/home/u/.local/share/switchboard')).not.toThrow();
    const started = await startDemo(store, path.join(tmp, 'data'));
    expect(started.seed).toEqual({ seeded: true, sessions: 6 });
    expect(Object.keys(started.providers).sort()).toEqual(['diff', 'history', 'solutions', 'system']);
  });

  it('maps agent folders to solution names', () => {
    expect(solutionOf('microfrontends/acme-app-front')).toBe('acme-app-front');
    expect(solutionOf('mobile/')).toBe('mobile');
    expect(solutionOf('functions/calendar-func')).toBe('calendar-func');
    expect(solutionOf('workspace root')).toBeNull();
    expect(solutionOf('read-only')).toBeNull();
    expect(solutionOf('prod')).toBeNull();
  });
});
