import { describe, expect, it } from 'vitest';
import type { Loop, OwnedLoop, SessionListItem } from '../../src/core/api.ts';
import { routineStep } from '../../src/web/v2/agent/chat-model.ts';
import { STALE_AFTER_MS, agentRoutines, cliLast, ownedLast } from '../../src/web/v2/agent/routines-indicator.ts';

/** Fix after 2.0 · the agent view's routines indicator, popover and side panel group (`routines-indicator.ts`), and the chat's routine rows. */
const NOW = new Date(2026, 9, 25, 13, 30).getTime();
const at = (h: number, m = 0, day = 25): string => new Date(2026, 9, day, h, m).toISOString();

function session(over: Partial<SessionListItem> = {}): SessionListItem {
  return { id: 's1', name: 'acme-agent', displayTitle: 'Acme agent', status: 'idle', createdAt: at(8), loops: [], ownedLoops: [], closedAt: null, ...over } as unknown as SessionListItem;
}

function owned(over: Partial<OwnedLoop> = {}): OwnedLoop {
  return {
    id: 'l1',
    sessionId: 's1',
    label: 'Nightly check',
    title: 'Nightly check',
    prompt: 'Check the Acme checkout\nand report',
    schedule: { kind: 'cron', cron: '0 14 * * *' },
    scheduleText: '14:00 daily',
    expiresAt: null,
    maxRuns: null,
    state: 'active',
    endedReason: null,
    runs: 3,
    skipped: 0,
    lastFiredAt: at(13),
    lastError: null,
    nextFireAt: at(14),
    createdBy: 'agent',
    createdAt: at(8),
    updatedAt: at(13),
    ...over,
  };
}

function cli(over: Partial<Loop> = {}): Loop {
  return {
    id: 'c1',
    sessionId: 's1',
    kind: 'CronCreate',
    label: 'cron */30 * * * *',
    iteration: 2,
    cap: null,
    breakerCount: null,
    breakerState: null,
    nextFireAt: at(14, 0),
    expiresAt: null,
    iterations: [
      { result: 'ok', ts: at(12, 30), label: 'OK' },
      { result: 'ok', ts: at(13, 0), label: 'OK' },
    ],
    progressPath: null,
    note: 'Session-only: ends with the CLI process.',
    createdAt: at(9),
    updatedAt: at(13),
    ...over,
  };
}

describe('v2 agent routines · the indicator', () => {
  it('is empty without loops or schedules', () => {
    const none = agentRoutines(session(), NOW);
    expect(none.count).toBe(0);
    expect(none.text).toBe('');
    expect(none.next).toBeNull();
    expect(agentRoutines(null, NOW).count).toBe(0);
  });

  it('picks the soonest next run among active items and counts all', () => {
    const r = agentRoutines(session({ ownedLoops: [owned({ nextFireAt: at(14, 0) })], loops: [cli({ nextFireAt: at(13, 45) })] }), NOW);
    expect(r.count).toBe(2);
    expect(r.next?.source).toBe('cli');
    expect(r.text).toBe('Next: CLI schedule 13:45 · 2 routines');
    expect(r.short).toBe('13:45 · 2');
    // Switchboard loops first, then the CLI's.
    expect(r.items.map((i) => i.source)).toEqual(['loop', 'cli']);
  });

  it('a single routine says its name and time only', () => {
    const r = agentRoutines(session({ ownedLoops: [owned()] }), NOW);
    expect(r.text).toBe('Next: Nightly check 14:00');
    expect(r.short).toBe('14:00');
    expect(r.items[0]?.scheduleText).toBe('Every day at 14:00');
  });

  it('a paused loop has no next time; all paused reads "paused"', () => {
    const r = agentRoutines(session({ ownedLoops: [owned({ state: 'paused', nextFireAt: null })] }), NOW);
    expect(r.next).toBeNull();
    expect(r.items[0]?.state).toBe('paused');
    expect(r.items[0]?.stateText).toBe('Paused');
    expect(r.text).toBe('1 routine · paused');
    // A paused one is skipped for "next", an active one wins.
    const mixed = agentRoutines(session({ ownedLoops: [owned({ id: 'a', state: 'paused', nextFireAt: at(13, 40) }), owned({ id: 'b', label: 'Later', title: 'Later', nextFireAt: at(15), createdAt: at(9) })] }), NOW);
    expect(mixed.next?.name).toBe('Later');
  });

  it('leaves out ended loops, Workflow cards and expired CLI loops', () => {
    const r = agentRoutines(
      session({
        ownedLoops: [owned({ state: 'ended', endedReason: 'expired', nextFireAt: null })],
        loops: [cli({ kind: 'Workflow', label: 'Workflow · audit', nextFireAt: null }), cli({ id: 'old', expiresAt: at(10) })],
      }),
      NOW,
    );
    expect(r.count).toBe(0);
  });

  it('a CLI schedule whose time passed is stale, not next; the indicator turns amber', () => {
    const due = new Date(NOW - STALE_AFTER_MS - 60_000).toISOString();
    const r = agentRoutines(session({ loops: [cli({ nextFireAt: due })] }), NOW);
    expect(r.items[0]?.state).toBe('stale');
    expect(r.items[0]?.stateText).toMatch(/^Stale: due at \d\d:\d\d, not seen since$/);
    expect(r.next).toBeNull();
    expect(r.tone).toBe('amber');
  });

  it('a wake-up reads as one, once at its time; CLI actions are disabled with the reason', () => {
    const r = agentRoutines(session({ loops: [cli({ kind: 'ScheduleWakeup', label: 'ScheduleWakeup', nextFireAt: at(18, 40), iterations: [], note: null })] }), NOW);
    const item = r.items[0];
    expect(item?.name).toBe('Wake-up');
    expect(item?.kindText).toBe('Wake-up');
    expect(item?.scheduleText).toBe('Once, at 18:40');
    expect(item?.last).toBeNull();
    for (const action of Object.values(item?.routine.actions ?? {})) expect(action).toEqual({ ok: false, reason: 'Managed by the AI engine: Switchboard can only watch it.' });
  });

  it('a Switchboard loop allows every action', () => {
    const item = agentRoutines(session({ ownedLoops: [owned()] }), NOW).items[0];
    expect(Object.values(item?.routine.actions ?? {}).every((a) => a.ok)).toBe(true);
  });
});

describe('v2 agent routines · last result', () => {
  it('a Switchboard loop: sent, skipped, skipped while waiting for you', () => {
    expect(ownedLast(owned(), NOW)).toEqual({ tone: 'ok', text: 'sent at 13:00 (run 3)' });
    expect(ownedLast(owned({ lastError: 'the previous firing has not been taken up yet' }), NOW)).toEqual({ tone: 'skip', text: 'skipped — the previous firing has not been taken up yet' });
    expect(ownedLast(owned({ lastError: 'the session is waiting for your answer' }), NOW)).toEqual({ tone: 'need', text: 'skipped — waiting for you' });
    expect(ownedLast(owned({ lastFiredAt: null, runs: 0 }), NOW)).toBeNull();
    expect(agentRoutines(session({ ownedLoops: [owned({ lastError: 'the session is waiting for your answer' })] }), NOW).tone).toBe('amber');
  });

  it('a CLI loop: its last iteration', () => {
    expect(cliLast(cli(), NOW)).toEqual({ tone: 'ok', text: 'passed at 13:00' });
    expect(cliLast(cli({ iterations: [{ result: 'fail', ts: at(13), label: null }] }), NOW)?.tone).toBe('fail');
    expect(cliLast(cli({ iterations: [] }), NOW)).toBeNull();
  });
});

describe('v2 agent routines · chat rows', () => {
  it('names the steps that make, change or remove a loop or schedule', () => {
    expect(routineStep('mcp__switchboard__loop_create · Check the Acme queue')).toEqual({ icon: 'routine', text: 'Set up a routine: Check the Acme queue' });
    expect(routineStep('mcp__switchboard__loop_pause')).toEqual({ icon: 'routine', text: 'Paused a routine' });
    expect(routineStep('switchboard_loop_cancel')).toEqual({ icon: 'routine', text: 'Cancelled a routine' });
    expect(routineStep('CronCreate · check the build')).toEqual({ icon: 'clock', text: 'Scheduled in the CLI: check the build' });
    expect(routineStep('ScheduleWakeup · check again')).toEqual({ icon: 'clock', text: 'Scheduled a wake-up: check again' });
    expect(routineStep('mcp__switchboard__loop_list')).toBeNull();
    expect(routineStep('Bash · npm test')).toBeNull();
  });
});
