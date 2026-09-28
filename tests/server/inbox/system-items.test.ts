/**
 * M3.3: system Inbox items on the real code path (no demo data, D13). Failed runs
 * are inserted into the schedule tables (the scheduler itself is M7.1) and raised
 * through `sync()` / the scheduler hook; "PR merged" comes from the real
 * WorktreeManager (temp git repos, fake gh) through its `worktreeRemovable` event;
 * the actions go through `POST /api/inbox/{id}/actions/{action}`.
 */
import { randomUUID } from 'node:crypto';
import { rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../src/core/api.ts';
import type { ScheduleRunResult } from '../../../src/core/model.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { ScheduleRecord, ScheduleRunRecord } from '../../../src/server/db/repos/schedules.ts';
import { type HubMessage, HubBus } from '../../../src/server/hub/bus.ts';
import {
  SCHEDULE_RUN_FAILED,
  SystemItemService,
  WORKTREE_REMOVABLE,
  fixSessionPrefill,
  greenStreak,
  kebab,
  streakSentence,
} from '../../../src/server/inbox/system-items.ts';
import type { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type GitWorld, forbiddenGitCalls, makeGitWorld } from '../../helpers/git.ts';
import { until } from '../../helpers/supervisor.ts';

const PORT = 4912; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

interface Rig {
  readonly w: GitWorld;
  readonly m: WorktreeManager;
  readonly bus: HubBus;
  readonly messages: HubMessage[];
  readonly service: SystemItemService;
  readonly app: FastifyInstance;
  readonly token: string;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.service.close();
  await rig?.app.close();
  await rig?.w.cleanup();
  rig = undefined;
});

async function setup(): Promise<Rig> {
  const w = await makeGitWorld();
  const m = w.manager();
  const bus = new HubBus();
  const messages: HubMessage[] = [];
  bus.subscribe((message) => messages.push(message));
  const service = new SystemItemService({ store: w.store, bus, worktrees: m, onError: (error) => w.errors.push(error) });
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
  const config = { ...base, port: PORT };
  await seedFolder(w.store, w.workspace);
  const token = generateToken();
  const app = await buildApp({ config, token, store: w.store, webRoot: w.root, worktrees: m, systemItems: service, bus });
  await app.ready();
  rig = { w, m, bus, messages, service, app, token };
  return rig;
}

function call(r: Rig, method: InjectOptions['method'], url: string) {
  return r.app.inject({ method, url, headers: { host: HOST, cookie: `sb_token=${r.token}` } });
}

async function inbox(r: Rig): Promise<InboxItem[]> {
  const response = await call(r, 'GET', '/api/inbox');
  expect(response.statusCode).toBe(200);
  return response.json() as InboxItem[];
}

function inboxCounts(r: Rig): number[] {
  return r.messages.filter((m) => m.name === 'inboxChanged').map((m) => (m.payload as { count: number }).count);
}

/** A schedule with `results` as its runs (oldest first, 1 hour apart, ending at 02:05); returns the runs. */
async function scheduleWithRuns(
  r: Rig,
  name: string,
  results: readonly ScheduleRunResult[],
  options: { template?: unknown; lastSummary?: string | null; lastSessionId?: string | null } = {},
): Promise<{ schedule: ScheduleRecord; runs: ScheduleRunRecord[] }> {
  const schedule = await r.w.store.schedules.create({
    name,
    description: 'Builds every solution at night',
    cron: '0 2 * * *',
    template: options.template ?? { name, task: 'Build everything.', solutions: ['mobile'], mode: 'single', phase: 'integration', coordination: 'none', worktrees: false, ultracode: false },
  });
  const runs: ScheduleRunRecord[] = [];
  for (const [index, result] of results.entries()) {
    const hour = 24 - results.length + index;
    const ts = new Date(Date.UTC(2026, 8, 27, hour, 0)).toISOString();
    const last = index === results.length - 1;
    runs.push(
      await r.w.store.schedules.addRun({
        scheduleId: schedule.id,
        ts,
        finishedAt: result === 'running' ? null : new Date(Date.UTC(2026, 8, 27, hour, 5)).toISOString(),
        result,
        summary: last ? (options.lastSummary === undefined ? 'Android build failed at XamlC' : options.lastSummary) : result === 'ok' ? 'OK' : null,
        sessionId: last ? (options.lastSessionId ?? null) : null,
        triggeredBy: 'cron',
      }),
    );
  }
  return { schedule, runs };
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

describe('M3.3 · failed scheduled run → Inbox item (inserted into the schedule tables)', () => {
  it('sync() raises one item per failed run with real data only; idempotent; inboxChanged', async () => {
    const r = await setup();
    const ok: ScheduleRunResult[] = Array.from({ length: 13 }, () => 'ok');
    const { schedule, runs } = await scheduleWithRuns(r, 'nightly-build-verify', [...ok, 'fail']);
    const failed = runs[13]!;

    const raised = await r.service.sync();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: SCHEDULE_RUN_FAILED, scheduleId: schedule.id, scheduleRunId: failed.id, state: 'open' });
    expect(inboxCounts(r)).toEqual([1]);

    const [item] = await inbox(r);
    expect(item).toEqual({
      id: raised[0]!.id,
      kind: 'system',
      sessionId: null,
      source: 'nightly-build-verify',
      status: 'fail',
      title: 'Android build failed at XamlC',
      label: 'Scheduled run failed',
      detail: 'The previous 13 runs were green.',
      createdAt: failed.finishedAt,
      branches: [],
      actions: [
        { id: 'open-fix-session', label: 'Open fix session' },
        { id: 'retry-run', label: 'Retry run' },
        { id: 'dismiss', label: 'Dismiss' },
      ],
      prefill: {
        name: 'fix-nightly-build-verify',
        task: 'nightly-build-verify: Android build failed at XamlC.',
        workType: 'feature',
        mode: 'single',
        solutions: ['mobile'],
        phase: 'integration',
        coordination: 'none',
        worktrees: false,
        ultracode: false,
      },
    });

    // Nothing new on a second sync or through the hook; ok / running runs never raise.
    expect(await r.service.sync()).toEqual([]);
    expect(await r.service.scheduleRunFinished(failed.id)).toBeNull();
    expect(await r.service.scheduleRunFinished(runs[0]!.id)).toBeNull();
    expect(await r.service.scheduleRunFinished('missing')).toBeNull();
    expect(await inbox(r)).toHaveLength(1);
    expect(inboxCounts(r)).toEqual([1]);

    // A dismissed item is not raised again.
    expect((await call(r, 'POST', `/api/inbox/${item!.id}/actions/dismiss`)).statusCode).toBe(204);
    expect(await r.service.sync()).toEqual([]);
    expect(await inbox(r)).toEqual([]);
  });

  it('the scheduler hook raises at once; startWatching picks up a run inserted later; branches + "Fix on" from the run session', async () => {
    const r = await setup();
    const session = await r.w.store.sessions.create({ name: 'nightly-run-7', claudeSessionId: randomUUID(), solutions: ['mobile'], worktrees: true });
    await r.w.store.worktrees.create({ repo: 'mobile', repoPath: r.w.mobile, branch: 'feature/free-talk-360', path: `${r.w.mobile}-wt-x`, sessionId: session.id });
    const { schedule, runs } = await scheduleWithRuns(r, 'Nightly Build', ['fail', 'ok', 'fail'], {
      template: { task: 'no session fields' },
      lastSummary: null,
      lastSessionId: session.id,
    });

    // The M7.1 hook: only the given run.
    const hooked = await r.service.scheduleRunFinished(runs[2]!.id);
    expect(hooked).toMatchObject({ source: 'Nightly Build', title: 'Nightly Build failed', detail: 'The previous run was green.', sessionId: session.id });
    expect(hooked?.branches).toEqual([{ solution: 'mobile', branch: 'feature/free-talk-360' }]);
    expect(hooked?.payload).toEqual({
      prefill: {
        name: 'fix-nightly-build',
        task: 'Nightly Build: Nightly Build failed. Fix on feature/free-talk-360.',
        workType: 'feature',
        mode: 'single',
        solutions: [],
        phase: 'ui-first',
      },
    });
    expect(inboxCounts(r)).toEqual([1]);

    // The older failed run has no item yet: the watcher raises it (and later inserts) without any hook call.
    r.service.startWatching({ intervalMs: 50 });
    await until(async () => ((await r.w.store.systemItems.list(['open'])).length === 2 ? true : undefined), 'the older run item');
    const later = await r.w.store.schedules.addRun({ scheduleId: schedule.id, result: 'fail', summary: 'Timed out', finishedAt: new Date().toISOString() });
    await until(async () => ((await r.w.store.systemItems.list(['open'])).some((i) => i.scheduleRunId === later.id) ? true : undefined), 'the inserted run item');
    await r.service.stopWatching();
    const items = await inbox(r);
    expect(items.map((i) => i.title)).toEqual(['Nightly Build failed', 'Nightly Build failed', 'Timed out']);
    expect(items.map((i) => i.detail)).toEqual(['', 'The previous run was green.', '']);
    expect(inboxCounts(r).at(-1)).toBe(3);
  });

  it('actions: Open fix session and Dismiss close it; Retry run needs the scheduler (501 until M7.1) then runs it; refusals', async () => {
    const r = await setup();
    await scheduleWithRuns(r, 'first', ['fail']);
    await scheduleWithRuns(r, 'second', ['fail']);
    const { schedule: third } = await scheduleWithRuns(r, 'third', ['fail']);
    await r.service.sync();
    const [first, second, thirdItem] = await inbox(r);
    expect([first?.source, second?.source, thirdItem?.source]).toEqual(['first', 'second', 'third']);

    expect((await call(r, 'POST', '/api/inbox/nope/actions/dismiss')).statusCode).toBe(404);
    const unknown = await call(r, 'POST', `/api/inbox/${first!.id}/actions/remove-worktree`);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: 'unknown-action' });

    expect((await call(r, 'POST', `/api/inbox/${first!.id}/actions/open-fix-session`)).statusCode).toBe(204);
    expect(await r.w.store.systemItems.get(first!.id)).toMatchObject({ state: 'closed', closedAction: 'open-fix-session' });
    const again = await call(r, 'POST', `/api/inbox/${first!.id}/actions/dismiss`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'not-open' });

    // Retry run without a scheduler: refused, the item stays.
    const noScheduler = await call(r, 'POST', `/api/inbox/${second!.id}/actions/retry-run`);
    expect(noScheduler.statusCode).toBe(501);
    expect(noScheduler.json()).toEqual({ error: 'not-implemented', item: 'M7.1', message: 'the scheduler is not available yet' });
    expect(await r.w.store.systemItems.get(second!.id)).toMatchObject({ state: 'open' });

    const ran: string[] = [];
    r.service.useScheduleRunner({ runNow: async (id) => void ran.push(id) });
    expect((await call(r, 'POST', `/api/inbox/${second!.id}/actions/retry-run`)).statusCode).toBe(204);
    expect(ran).toEqual([(await r.w.store.systemItems.get(second!.id))!.scheduleId]);
    expect(await r.w.store.systemItems.get(second!.id)).toMatchObject({ state: 'closed', closedAction: 'retry-run' });

    // A scheduler that fails: refused, the item stays.
    r.service.useScheduleRunner({ runNow: async () => Promise.reject(new Error('boom')) });
    expect((await call(r, 'POST', `/api/inbox/${thirdItem!.id}/actions/retry-run`)).statusCode).toBe(500);
    expect(await r.w.store.systemItems.get(thirdItem!.id)).toMatchObject({ state: 'open' });

    // The schedule is gone (its runs with it): Retry is refused, Dismiss still closes.
    await r.w.store.schedules.delete(third.id);
    const gone = await call(r, 'POST', `/api/inbox/${thirdItem!.id}/actions/retry-run`);
    expect(gone.statusCode).toBe(409);
    expect(gone.json()).toMatchObject({ error: 'gone' });
    expect((await call(r, 'POST', `/api/inbox/${thirdItem!.id}/actions/dismiss`)).statusCode).toBe(204);
    expect(await inbox(r)).toEqual([]);
    expect(inboxCounts(r).at(-1)).toBe(0);
  });
});

describe('M3.3 · PR merged → worktree removable (real git, fake gh)', () => {
  it('worktreeRemovable raises one item; Remove worktree is refused while uncommitted, then removes the folder and keeps the branch', async () => {
    const r = await setup();
    const session = await r.w.store.sessions.create({ name: 'speaking-page', claudeSessionId: randomUUID(), solutions: ['web-front'], worktrees: true });
    const [record] = await r.m.createForSession('speaking-page', ['web-front'], r.w.folder, session.id);
    if (!record) throw new Error('no worktree');
    await r.w.setPullRequests({ 'session/speaking-page': { number: 231, state: 'MERGED', url: 'https://github.com/acme/web-front/pull/231' } });

    await r.m.checkPullRequests();
    const [item] = await until(async () => {
      const items = await inbox(r);
      return items.length > 0 ? items : undefined;
    }, 'the PR merged item');
    expect(item).toEqual({
      id: expect.any(String),
      kind: 'system',
      sessionId: session.id,
      source: 'worktrees',
      status: 'done',
      title: 'PR #231 merged, so the worktree can be removed',
      label: 'PR merged',
      detail: `${path.join('..', 'web-front-wt-speaking-page')} · branch session/speaking-page was merged on GitHub (checked through gh). No uncommitted changes.`,
      createdAt: (await r.w.store.worktrees.get(record.id))!.prCheckedAt,
      branches: [{ solution: 'web-front', branch: 'session/speaking-page' }],
      actions: [
        { id: 'remove-worktree', label: 'Remove worktree' },
        { id: 'keep', label: 'Keep' },
      ],
    });
    expect((await r.w.store.systemItems.get(item!.id))?.worktreeId).toBe(record.id);
    expect(inboxCounts(r)).toEqual([1]);

    // Checked again: no second event, no second item; sync finds nothing either.
    await r.m.checkPullRequests();
    expect(await r.service.sync()).toEqual([]);
    expect(await inbox(r)).toHaveLength(1);

    // Gap #3: refused while it holds uncommitted work; nothing removed, the item stays.
    await writeFile(path.join(record.path, 'leftover.txt'), 'not committed\n');
    const refused = await call(r, 'POST', `/api/inbox/${item!.id}/actions/remove-worktree`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'uncommitted', message: `${record.path} has 1 uncommitted change` });
    expect(await exists(record.path)).toBe(true);
    expect(await r.w.store.systemItems.get(item!.id)).toMatchObject({ state: 'open' });

    await rm(path.join(record.path, 'leftover.txt'));
    expect((await call(r, 'POST', `/api/inbox/${item!.id}/actions/remove-worktree`)).statusCode).toBe(204);
    expect(await exists(record.path)).toBe(false);
    expect(await r.w.git(r.w.web, 'branch', '--list', 'session/speaking-page')).not.toBe('');
    expect((await r.w.store.worktrees.get(record.id))?.removedAt).not.toBeNull();
    expect(await r.w.store.systemItems.get(item!.id)).toMatchObject({ state: 'closed', closedAction: 'remove-worktree' });
    expect(await inbox(r)).toEqual([]);
    expect(inboxCounts(r).at(-1)).toBe(0);
    expect(forbiddenGitCalls(await r.w.gitCalls())).toEqual([]);
    expect(r.w.errors).toEqual([]);
  });

  it('Keep closes the item and leaves the worktree; sync raises a removable worktree that has no item; an already removed folder counts as done', async () => {
    const r = await setup();
    const [kept] = await r.m.createForSession('kept', ['web-front'], r.w.folder);
    const [gone] = await r.m.createForSession('gone', ['mobile'], r.w.folder);
    if (!kept || !gone) throw new Error('no worktree');
    // Flagged removable without the event (e.g. the service stopped right after the check).
    await r.w.store.worktrees.update(kept.id, { prNumber: 7, prState: 'MERGED', removable: true });
    await r.w.store.worktrees.update(gone.id, { prState: 'MERGED', removable: true });

    const raised = await r.service.sync();
    expect(raised.map((i) => [i.kind, i.worktreeId, i.title])).toEqual([
      [WORKTREE_REMOVABLE, kept.id, 'PR #7 merged, so the worktree can be removed'],
      [WORKTREE_REMOVABLE, gone.id, 'The PR was merged, so the worktree can be removed'],
    ]);
    expect(await r.service.worktreeRemovable(kept.id)).toBeNull();

    const [keptItem, goneItem] = await inbox(r);
    expect((await call(r, 'POST', `/api/inbox/${keptItem!.id}/actions/keep`)).statusCode).toBe(204);
    expect(await exists(kept.path)).toBe(true);
    expect((await r.w.store.worktrees.get(kept.id))?.removedAt).toBeNull();
    expect(await r.service.sync()).toEqual([]);

    // Removed meanwhile (outside the Inbox): the action still closes the item.
    await r.m.remove(gone.id);
    expect((await call(r, 'POST', `/api/inbox/${goneItem!.id}/actions/remove-worktree`)).statusCode).toBe(204);
    expect(await r.w.store.systemItems.get(goneItem!.id)).toMatchObject({ state: 'closed', closedAction: 'remove-worktree' });
    expect(await inbox(r)).toEqual([]);
  });
});

describe('M3.3 · item builders', () => {
  const run = (id: string, result: ScheduleRunResult): ScheduleRunRecord => ({
    id,
    scheduleId: 's',
    ts: id,
    finishedAt: null,
    result,
    summary: null,
    sessionId: null,
    triggeredBy: 'cron',
  });

  it('green streak and its sentence', () => {
    const recent = [run('a', 'ok'), run('b', 'fail'), run('c', 'ok'), run('d', 'ok'), run('e', 'fail')];
    expect(greenStreak(recent[4]!, recent)).toBe(2);
    expect(greenStreak(recent[1]!, recent)).toBe(1);
    expect(greenStreak(recent[0]!, recent)).toBe(0);
    expect(greenStreak(run('x', 'fail'), recent)).toBeNull();
    expect([streakSentence(null), streakSentence(0), streakSentence(1), streakSentence(13)]).toEqual([
      '',
      '',
      'The previous run was green.',
      'The previous 13 runs were green.',
    ]);
  });

  it('fix-session prefill: kebab name within 64 characters, task sentence, template fields only when valid', () => {
    const schedule = (name: string, template: unknown): ScheduleRecord => ({
      id: 's',
      name,
      description: '',
      cron: '0 2 * * *',
      template,
      folderId: null,
      paused: false,
      createdAt: '',
      updatedAt: '',
    });
    expect(kebab('  Nightly Build · Verify!  ')).toBe('nightly-build-verify');
    const long = fixSessionPrefill(schedule('x'.repeat(70), null), 'Broke.', []);
    expect(long.name).toBe(`fix-${'x'.repeat(60)}`);
    expect(long.task).toBe(`${'x'.repeat(70)}: Broke.`);
    expect(
      fixSessionPrefill(schedule('qa-sweep', { workType: 'qa', mode: 'orchestrator', solutions: ['web', 7, ''], phase: 'later', coordination: 'bogus', worktrees: 'yes' }), 'Failed', [
        { solution: 'web', branch: 'main' },
      ]),
    ).toEqual({ name: 'fix-qa-sweep', task: 'qa-sweep: Failed. Fix on main.', workType: 'feature', mode: 'orchestrator', solutions: ['web'], phase: 'ui-first' });
    // D14: the fix session starts in the schedule's folder (its column, else the template's).
    expect(fixSessionPrefill({ ...schedule('in-repo', { folder: 'from-template' }), folderId: 'repo-folder' }, 'Failed', []).folder).toBe('repo-folder');
    expect(fixSessionPrefill(schedule('in-repo', { folder: 'from-template' }), 'Failed', []).folder).toBe('from-template');
  });
});
