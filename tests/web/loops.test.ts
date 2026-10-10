import { describe, expect, it } from 'vitest';
import type { Loop, Session } from '../../src/core/api.ts';
import { MAX_STRIP_CELLS, NEED_BORDER, formatBreaker, formatExpiry, formatNextFire, loopCards, loopFacts, stripCells, unlistedFacts } from '../../src/web/views/loops.ts';
import { LOOP_WIRE_ITERATIONS, loopShown, wireLoop } from '../../src/core/derive/loops.ts';
import { UNLISTED_KIND, UNLISTED_LABEL } from '../../src/core/derive/unlisted-loops.ts';

// Monday 2026-09-28 14:03 local.
const NOW = new Date(2026, 8, 28, 14, 3, 0);

function loop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: 'loop:s1:loop',
    sessionId: 's1',
    kind: '/loop',
    label: '/loop 1h',
    iteration: 3,
    cap: null,
    breakerCount: null,
    breakerState: null,
    nextFireAt: null,
    expiresAt: null,
    iterations: [
      { result: 'ok', ts: null, label: null },
      { result: 'ok', ts: null, label: null },
      { result: 'fail', ts: null, label: null },
    ],
    progressPath: null,
    note: null,
    createdAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-28T10:00:00.000Z',
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    origin: 'switchboard',
    id: 's1',
    name: 'prod-monitoring',
    claudeSessionId: 'c1',
    status: 'done',
    workType: null,
    mode: null,
    phase: null,
    coordination: null,
    qaStack: null,
    ultracode: false,
    worktrees: false,
    solutions: [],
    attached: true,
    createdAt: '2026-09-28T09:00:00.000Z',
    lastActivityAt: null,
    agents: [],
    openQuestionCount: 0,
    cwd: null,
    folder: null,
    folderPath: null,
    folderKind: null,
    live: false,
    activity: null,
    resumeCommand: 'claude --resume c1',
    chips: [],
    loops: [loop()],
    ...overrides,
  };
}

describe('loops view · formatting (local time, "—" when unknown)', () => {
  it('next firing: clock today, tomorrow, weekday within a week, else month-day', () => {
    expect(formatNextFire(null, NOW)).toBe('—');
    expect(formatNextFire('not a date', NOW)).toBe('—');
    expect(formatNextFire(new Date(2026, 8, 28, 15, 0).toISOString(), NOW)).toBe('15:00');
    expect(formatNextFire(new Date(2026, 8, 29, 2, 0).toISOString(), NOW)).toBe('tomorrow 02:00');
    expect(formatNextFire(new Date(2026, 9, 1, 7, 5).toISOString(), NOW)).toBe('Thu 07:05');
    expect(formatNextFire(new Date(2026, 9, 12, 8, 30).toISOString(), NOW)).toBe('10-12 08:30');
    // An overdue firing still shows its time.
    expect(formatNextFire(new Date(2026, 8, 28, 13, 7).toISOString(), NOW)).toBe('13:07');
  });

  it('expiry: days, hours, minutes, expired', () => {
    const inMs = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
    expect(formatExpiry(null, NOW)).toBe('—');
    expect(formatExpiry(inMs(7 * 86_400_000 - 5_000), NOW)).toBe('in 7 days');
    expect(formatExpiry(inMs(6 * 86_400_000 - 30_000), NOW)).toBe('in 6 days');
    expect(formatExpiry(inMs(86_400_000 + 3_600_000), NOW)).toBe('in 1 day');
    expect(formatExpiry(inMs(5 * 3_600_000 + 1), NOW)).toBe('in 5 h');
    expect(formatExpiry(inMs(12 * 60_000 + 10_000), NOW)).toBe('in 13 min');
    expect(formatExpiry(inMs(10_000), NOW)).toBe('in 1 min');
    expect(formatExpiry(inMs(-1), NOW)).toBe('expired');
  });

  it('breaker: state + count, count only, or "—"', () => {
    expect(formatBreaker({ breakerState: 'tripped', breakerCount: 2 })).toBe('tripped (2)');
    expect(formatBreaker({ breakerState: 'reset', breakerCount: null })).toBe('reset');
    expect(formatBreaker({ breakerState: null, breakerCount: 0 })).toBe('0 in a row');
    expect(formatBreaker({ breakerState: null, breakerCount: null })).toBe('—');
  });

  it('three facts: Iteration / cap · Next / expires · Breaker', () => {
    expect(loopFacts(loop(), NOW)).toEqual([
      { k: 'Iteration / cap', v: '3 / —' },
      { k: 'Next / expires', v: '— / —' },
      { k: 'Breaker', v: '—' },
    ]);
    const known = loop({
      cap: 5,
      breakerCount: 1,
      nextFireAt: new Date(2026, 8, 28, 15, 7).toISOString(),
      expiresAt: new Date(NOW.getTime() + 6 * 86_400_000 + 3_600_000).toISOString(),
    });
    expect(loopFacts(known, NOW).map((f) => f.v)).toEqual(['3 / 5', '15:07 / in 6 days', '1 in a row']);
    expect(loopFacts(loop({ iteration: null }), NOW)[0].v).toBe('— / —');
  });
});

describe('loops view · strip', () => {
  it('shows the iterations, pads to a known cap with empty cells, keeps the newest 30', () => {
    expect(stripCells(loop())).toEqual(['ok', 'ok', 'fail']);
    expect(stripCells(loop({ cap: 5 }))).toEqual(['ok', 'ok', 'fail', 'none', 'none']);
    expect(stripCells(loop({ cap: 2 }))).toEqual(['ok', 'ok', 'fail']);
    const many = Array.from({ length: 40 }, (_, i) => ({ result: i === 39 ? ('run' as const) : ('ok' as const), ts: null, label: null }));
    const cells = stripCells(loop({ iterations: many, cap: 50 }));
    // More iterations than cells: the newest 30, the running one last (no padding then).
    expect(cells).toHaveLength(30);
    expect(cells.at(-1)).toBe('run');
    expect(stripCells(loop({ iterations: [] }))).toEqual([]);
  });
});

describe('D95-q3 · the wire carries the newest iterations only', () => {
  it('a 100-iteration loop cut to the wire draws the same strip, facts and visibility', () => {
    expect(LOOP_WIRE_ITERATIONS).toBeGreaterThanOrEqual(MAX_STRIP_CELLS);
    const base = NOW.getTime() - 100 * 30 * 60_000;
    const iterations = Array.from({ length: 100 }, (_, i) => ({ result: i % 7 === 0 ? ('fail' as const) : ('ok' as const), ts: new Date(base + i * 30 * 60_000).toISOString(), label: `run ${i}` }));
    for (const whole of [loop({ iterations, iteration: 100, cap: 120 }), loop({ kind: UNLISTED_KIND, label: UNLISTED_LABEL, iterations, iteration: 100 })]) {
      const cut = wireLoop(whole);
      expect(cut.iterations).toHaveLength(LOOP_WIRE_ITERATIONS);
      expect(cut.iterations.at(-1)).toEqual(whole.iterations.at(-1));
      expect(stripCells(cut)).toEqual(stripCells(whole));
      expect(loopFacts(cut, NOW)).toEqual(loopFacts(whole, NOW));
      expect(unlistedFacts(cut, NOW)).toEqual(unlistedFacts(whole, NOW));
      expect(loopShown(cut, NOW)).toBe(loopShown(whole, NOW));
    }
    const short = loop();
    expect(wireLoop(short)).toBe(short);
  });
});

describe('loops view · cards', () => {
  it('one card per loop of every session, oldest loop first; dot + border from the session status; label or kind; note', () => {
    const sessions = [
      session({
        id: 's2',
        name: 'button-rollout',
        status: 'need',
        loops: [loop({ id: 'b', sessionId: 's2', kind: 'Workflow', label: null, createdAt: '2026-09-28T11:00:00.000Z', note: '  ' })],
      }),
      session({ loops: [loop({ note: 'Session-only schedule.' })] }),
      session({ id: 's3', name: 'no-loops', loops: [] }),
    ];
    const cards = loopCards(sessions, NOW);
    expect(cards.map((c) => [c.sessionName, c.kind, c.dot, c.border, c.note])).toEqual([
      ['prod-monitoring', '/loop 1h', 'var(--status-done)', 'var(--border-card)', 'Session-only schedule.'],
      ['button-rollout', 'Workflow', 'var(--status-need)', NEED_BORDER, null],
    ]);
    expect(loopCards([session({ status: 'paused' })], NOW)[0]?.dot).toBe('var(--status-idle)');
    expect(loopCards([], NOW)).toEqual([]);
  });

  it('loops that started together follow their sessions\' start, then the server order (deterministic)', () => {
    const same = '2026-09-28T12:00:00.000Z';
    const newer = session({ id: 's2', name: 'newer', createdAt: '2026-09-28T11:00:00.000Z', loops: [loop({ id: 'z', sessionId: 's2', createdAt: same })] });
    const older = session({
      id: 's1',
      name: 'older',
      createdAt: '2026-09-28T08:00:00.000Z',
      loops: [loop({ id: 'y', createdAt: same }), loop({ id: 'a', kind: 'Workflow', label: null, createdAt: same })],
    });
    expect(loopCards([newer, older], NOW).map((c) => c.id)).toEqual(['y', 'a', 'z']);
  });

  it('D93: a loop whose expiry has passed has no card (a page left open past it, or a row not refreshed yet)', () => {
    const live = loop({ id: 'loop:s1:cron-a', expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString() });
    const gone = loop({ id: 'loop:s1:cron-b', expiresAt: new Date(NOW.getTime() - 1).toISOString() });
    expect(loopCards([session({ loops: [live, gone] })], NOW).map((card) => card.id)).toEqual(['loop:s1:cron-a']);
  });

  it('an unlisted schedule: iteration count, the estimated interval and last prompt, an expected next marked as an estimate; gone once the series stops', () => {
    const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
    const unlisted = loop({
      id: 'loop:s1:unlisted-abc',
      kind: UNLISTED_KIND,
      label: UNLISTED_LABEL,
      iteration: 3,
      iterations: [70, 40, 10].map((m) => ({ result: 'ok' as const, ts: at(m), label: null })),
      note: 'Prompt: "Sweep the logs.". Started by the CLI itself about every 30 min.',
    });
    const [card] = loopCards([session({ loops: [unlisted] })], NOW);
    expect(card?.kind).toBe(UNLISTED_LABEL);
    expect(card?.facts).toEqual([
      { k: 'Iteration', v: '3' },
      { k: 'Every / last', v: '~30 min / 13:53' },
      { k: 'Expected next', v: '~14:23 (estimate)' },
    ]);
    // Late (past the estimate, within two intervals): no expected time is claimed.
    expect(loopFacts(unlisted, new Date(NOW.getTime() + 25 * 60_000))[2]).toEqual({ k: 'Expected next', v: '—' });
    // Stopped (no prompt for more than two intervals): no card.
    expect(loopCards([session({ loops: [unlisted] })], new Date(NOW.getTime() + 51 * 60_000))).toEqual([]);
  });

  it('reads a session without the additive field (older server) as no loops', () => {
    const { loops: _loops, ...old } = session();
    expect(loopCards([old as unknown as Session], NOW)).toEqual([]);
  });
});

describe('D52 · a peer\'s loops and terminal sessions\' loops', () => {
  const PEER = { id: 'abcdefghijkl', name: 'pc-office', state: 'online' as const };

  it('a peer session\'s loop carries its machine; "Open session" is never blocked (the snapshot opens offline)', () => {
    const cards = loopCards([session({ id: 'r~abcdefghijkl~s1', loops: [loop({ sessionId: 'r~abcdefghijkl~s1' })], machine: { ...PEER, state: 'offline' } })], NOW);
    expect(cards[0]).toMatchObject({ machine: { id: PEER.id, state: 'offline' }, terminalId: null, blocked: null });
  });

  it('a terminal loop: named after the terminal (else its folder), dot from its status words, Hook into… blocked while its machine is offline', () => {
    const entry = {
      loop: loop({ id: 'r~abcdefghijkl~term:cs1:loop', sessionId: 'cs1', createdAt: '2026-09-28T11:00:00.000Z' }),
      terminal: { id: 'cs1', name: null, cwd: '/Users/dev/repo-a', status: 'busy', pid: 42, startedAt: '2026-09-28T10:59:00.000Z' },
      machine: PEER,
    };
    const [card] = loopCards([], NOW, [entry]);
    expect(card).toMatchObject({ sessionId: 'cs1', sessionName: 'Terminal · repo-a', status: 'run', terminalId: 'cs1', machine: PEER, blocked: null });
    const [offline] = loopCards([], NOW, [{ ...entry, terminal: { ...entry.terminal, name: 'pc-loop', status: 'waiting' }, machine: { ...PEER, state: 'offline' as const } }]);
    expect(offline).toMatchObject({ sessionName: 'pc-loop', status: 'need', border: NEED_BORDER, blocked: 'pc-office is unreachable' });
    // Sorted with the sessions' loops by start.
    const both = loopCards([session({ loops: [loop({ createdAt: '2026-09-28T12:00:00.000Z' })] })], NOW, [entry]);
    expect(both.map((c) => c.terminalId)).toEqual(['cs1', null]);
  });
});
