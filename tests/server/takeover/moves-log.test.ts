import { describe, expect, it } from 'vitest';
import type { MoveRecord, MovesChanged } from '../../../src/core/moves.ts';
import { MOVE_RETENTION_MS } from '../../../src/core/moves.ts';
import { TAKEOVER_STEPS, TAKEOVER_STEP_LABELS, type TakeoverRun, type TakeoverStepId } from '../../../src/core/takeover.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { MOVES_SETTING, MoveLog } from '../../../src/server/takeover/moves.ts';
import type { TakeoverRunListener, TakeoverRunMeta } from '../../../src/server/takeover/runner.ts';

/**
 * D154 · the moves list's own rules, without processes: a record per run with the step,
 * `movesChanged` on each step change (a detail-only change throttled), the outcome, the
 * failure item and its close by a later success, persistence across a restart (a running
 * move becomes interrupted and raises its item), the 24-hour retention, dismiss.
 */

const MAC = 'macmacmacmac';
const PCID = 'pcpcpcpcpcpc';
const SELF = { id: MAC, name: 'mac-laptop' };
const PC = { id: PCID, name: 'pc-office', state: 'online' };

function world(options: { stored?: unknown; now?: () => number } = {}) {
  const settings = new Map<string, unknown>(options.stored === undefined ? [] : [[MOVES_SETTING, options.stored]]);
  const listeners = new Set<TakeoverRunListener>();
  const bus = new HubBus();
  const events: MovesChanged[] = [];
  bus.subscribe((message) => {
    if (message.name === 'movesChanged') events.push(message.payload);
  });
  const raised: Array<Record<string, unknown>> = [];
  const closed: Array<{ keys: readonly string[]; before: string; outcome: string }> = [];
  const log = new MoveLog({
    runner: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      get: () => null,
    },
    store: {
      settings: { get: async (key: string) => settings.get(key), set: async (key: string, value: unknown) => void settings.set(key, value) },
      sessions: { get: async (id: string) => (id === 's1' ? { title: 'Checkout fix', name: 'checkout' } : null) },
    } as never,
    bus,
    peers: {
      self: async () => SELF,
      machines: async () => [PC],
      remoteMoves: () => [],
      remoteSessions: () => [],
      forward: async () => ({ status: 404, body: {} }),
    } as never,
    systemItems: {
      moveFailedNotice: async (input: Record<string, unknown>) => {
        raised.push(input);
        return null;
      },
      closeMoveFailedNotices: async (keys: readonly string[], before: string, outcome: string) => {
        closed.push({ keys, before, outcome });
        return 0;
      },
    } as never,
    // A fixed clock next to the fixtures' 2026-11-05 times: the list prunes old moves by age, so the real clock made these records vanish days later.
    now: options.now ?? (() => Date.parse('2026-11-05T12:30:00.000Z')),
  });
  const emit = (run: TakeoverRun, meta: TakeoverRunMeta): void => {
    for (const listener of listeners) listener(run, meta);
  };
  return { log, settings, events, raised, closed, emit, bus };
}

function meta(overrides: Partial<TakeoverRunMeta> = {}): TakeoverRunMeta {
  return { request: { sessionId: 's1', targetMachine: PCID, placement: { roots: ['/b/code'] }, excludeRepos: ['/a/code/beta'] }, sourceMachineId: MAC, targetMachineId: PCID, rawSessionId: 's1', title: null, startedAt: '2026-11-05T10:00:00.000Z', endedAt: null, ...overrides };
}

function run(state: TakeoverRun['state'], at: TakeoverStepId | null, extra: Partial<TakeoverRun> = {}): TakeoverRun {
  const index = at === null ? TAKEOVER_STEPS.length : TAKEOVER_STEPS.indexOf(at);
  return {
    id: 'run-1',
    state,
    steps: TAKEOVER_STEPS.map((id, i) => ({ id, label: TAKEOVER_STEP_LABELS[id], status: i < index ? 'done' : i === index ? (state === 'failed' ? 'failed' : 'running') : 'pending', detail: null })),
    error: null,
    rolledBack: null,
    rollbackNotes: [],
    result: null,
    leftovers: [],
    log: [],
    stashes: [],
    ...extra,
  };
}

describe('the moves list (D154)', () => {
  it('keeps one record per run with the step, publishes each step change, and raises the failure item once', async () => {
    const w = world();
    await w.log.start();
    w.emit(run('running', 'checks'), meta());
    w.emit(run('running', 'transfer'), meta({ title: 'Checkout fix' }));
    await w.log.idle();
    let [move] = await w.log.list(false);
    expect(move).toMatchObject({ id: 'run-1', kind: 'agent', title: 'Checkout fix', state: 'running', step: { id: 'transfer' }, source: { id: MAC, name: 'mac-laptop', sessionId: 's1' }, target: { id: PCID, name: 'pc-office', sessionId: null }, agentSessionId: 's1', endedAt: null });
    expect(move?.choices).toEqual({ placement: { roots: ['/b/code'] }, clonePaths: {}, workspaceFiles: null, excludeRepos: ['/a/code/beta'], stashTargets: [] });
    expect(w.events.map((event) => event.move.step?.id)).toEqual(['checks', 'transfer']);

    // A detail-only change (the transfer's KB) is published once, a moment later.
    const detail = run('running', 'transfer');
    w.emit({ ...detail, steps: detail.steps.map((step) => (step.id === 'transfer' ? { ...step, detail: '10 of 20 KB' } : step)) }, meta({ title: 'Checkout fix' }));
    w.emit({ ...detail, steps: detail.steps.map((step) => (step.id === 'transfer' ? { ...step, detail: '20 of 20 KB' } : step)) }, meta({ title: 'Checkout fix' }));
    await w.log.idle();
    expect(w.events).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(w.events).toHaveLength(3);
    expect(w.events[2]?.move.step?.detail).toBe('20 of 20 KB');

    const failed = run('failed', 'apply', { error: { step: 'apply', message: 'alpha: the branch feature/x has commits the original does not have' }, rolledBack: true, stashes: [{ path: '/b/code/alpha', machine: 'pc-office', message: 'switchboard: before moving', files: 2, commit: null }] });
    w.emit(failed, meta({ title: 'Checkout fix', endedAt: '2026-11-05T10:05:00.000Z' }));
    w.emit(failed, meta({ title: 'Checkout fix', endedAt: '2026-11-05T10:05:00.000Z' }));
    await w.log.idle();
    [move] = await w.log.list(false);
    expect(move).toMatchObject({ state: 'failed', step: { id: 'apply' }, error: { step: 'apply' }, rolledBack: true, endedAt: '2026-11-05T10:05:00.000Z' });
    expect(w.raised).toHaveLength(1);
    expect(w.raised[0]).toMatchObject({ moveId: 'run-1', title: 'Couldn’t move Checkout fix to pc-office', source: 'Checkout fix', sessionId: 's1', keys: [`session:${MAC}:s1`], at: '2026-11-05T10:05:00.000Z' });
    expect(w.raised[0]?.['detail']).toBe(
      'Restoring the working tree here failed: alpha: the branch feature/x has commits the original does not have. Everything was undone. Checkout fix still runs on mac-laptop. Stashed 2 uncommitted files in /b/code/alpha on pc-office as "switchboard: before moving". It is kept there: run git stash list in that folder to find it, then git stash apply stash@{N} (or git stash pop) to restore it.',
    );
    expect((w.raised[0]?.['move'] as { choices: unknown }).choices).toEqual(move?.choices);
    // Kept at once when it ended.
    await w.log.close();
    expect((w.settings.get(MOVES_SETTING) as MoveRecord[])[0]).toMatchObject({ id: 'run-1', state: 'failed' });
  });

  it('a success closes the earlier failure items of the same agent (here, and from a paired machine)', async () => {
    const w = world();
    await w.log.start();
    w.emit(run('done', null, { result: { sessionId: `r~${PCID}~s9`, machineName: 'pc-office', machineId: PCID, local: false } }), meta({ title: 'Checkout fix', endedAt: '2026-11-05T11:00:00.000Z' }));
    await w.log.idle();
    expect(w.closed).toEqual([{ keys: [`session:${MAC}:s1`, `session:${PCID}:s9`], before: '2026-11-05T11:00:00.000Z', outcome: 'moved' }]);
    const [move] = await w.log.list(false);
    // Done: the agent is the new session on the target, as this machine names it.
    expect(move).toMatchObject({ state: 'done', step: null, target: { sessionId: 's9' }, agentSessionId: `r~${PCID}~s9` });
    // A paired machine's success (its movesChanged, republished here) closes this machine's items too.
    w.bus.publish('movesChanged', { move: { ...(move as MoveRecord), id: `r~${PCID}~run-2`, machine: PC, member: { id: 'm1', name: 'Dev', teamId: 't1', teamName: 'Core' }, endedAt: '2026-11-05T12:00:00.000Z' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.closed[1]).toEqual({ keys: [`session:${MAC}:s1`, `session:${PCID}:s9`, 'member:m1'], before: '2026-11-05T12:00:00.000Z', outcome: 'moved' });
    await w.log.close();
  });

  it('names a crew member and its crew', async () => {
    const w = world();
    w.log.useMembers((machineId, sessionId) => (machineId === MAC && sessionId === 's1' ? { id: 'm1', name: 'Developer', teamId: 't1', teamName: 'Core' } : null));
    await w.log.start();
    w.emit(run('running', 'stop'), meta());
    await w.log.idle();
    expect((await w.log.list(false))[0]).toMatchObject({ kind: 'teammate', member: { id: 'm1', name: 'Developer', teamId: 't1', teamName: 'Core' } });
    await w.log.close();
  });

  it('survives a restart: a finished move is kept, a running one becomes interrupted (failed, with its item); past 24 hours they go', async () => {
    let now = Date.parse('2026-11-05T12:00:00.000Z');
    const first = world({ now: () => now });
    await first.log.start();
    first.emit(run('running', 'capture'), meta({ title: 'Checkout fix' }));
    await first.log.idle();
    const second = { ...run('failed', 'checks', { error: { step: 'checks', message: 'blocked' } }), id: 'run-0' };
    first.emit(second, meta({ title: 'Older', rawSessionId: 's0', startedAt: '2026-11-05T09:00:00.000Z', endedAt: '2026-11-05T09:01:00.000Z' }));
    await first.log.idle();
    await first.log.close();
    const stored = first.settings.get(MOVES_SETTING) as MoveRecord[];
    expect(stored.map((record) => [record.id, record.state])).toEqual([
      ['run-1', 'running'],
      ['run-0', 'failed'],
    ]);

    // The service restarts: the move that was running never finished here.
    const restarted = world({ stored, now: () => now });
    await restarted.log.start();
    const listed = await restarted.log.list(false);
    expect(listed.map((record) => [record.id, record.state, record.interrupted])).toEqual([
      ['run-1', 'failed', true],
      ['run-0', 'failed', false],
    ]);
    expect(listed[0]?.error?.step).toBe('capture');
    expect(listed[0]?.error?.message).toContain('restarted during the move');
    expect(restarted.raised.map((item) => item['moveId'])).toEqual(['run-1']);
    expect((restarted.settings.get(MOVES_SETTING) as MoveRecord[])[0]).toMatchObject({ id: 'run-1', state: 'failed', interrupted: true });

    // 24 hours after it ended, a move leaves the list.
    now = Date.parse('2026-11-05T09:01:00.000Z') + MOVE_RETENTION_MS + 1;
    expect((await restarted.log.list(false)).map((record) => record.id)).toEqual(['run-1']);
    now = Date.parse('2026-11-05T12:00:00.000Z') + MOVE_RETENTION_MS + 1;
    expect(await restarted.log.list(false)).toEqual([]);
    await restarted.log.close();
  });

  it('dismiss removes a finished move (published as removed) and refuses a running one', async () => {
    const w = world();
    await w.log.start();
    w.emit(run('running', 'checks'), meta());
    await w.log.idle();
    await expect(w.log.dismiss('run-1')).rejects.toMatchObject({ status: 409, code: 'running' });
    w.emit(run('failed', 'checks', { error: { step: 'checks', message: 'blocked' } }), meta({ endedAt: '2026-11-05T10:01:00.000Z' }));
    await w.log.idle();
    await w.log.dismiss('run-1');
    expect(await w.log.list(false)).toEqual([]);
    expect(w.events.at(-1)).toMatchObject({ removed: true, move: { id: 'run-1' } });
    await expect(w.log.dismiss('run-1')).rejects.toMatchObject({ status: 404 });
    await w.log.close();
    expect(w.settings.get(MOVES_SETTING)).toEqual([]);
  });
});
