import { describe, expect, it } from 'vitest';
import type { Agent, Session, SessionEvent } from '../../src/core/api.ts';
import type { EventKind } from '../../src/core/model.ts';
import {
  EMPTY_SESSION_SOURCE,
  LOG_LIMIT,
  MAIN_LANE_SUB,
  PLAY_MAX,
  formatClock,
  isOpenEvent,
  playStep,
  sessionFetched,
  sessionPushed,
  sessionRefetching,
  shownSession,
  TIMELINE_TURNS,
  isTurnStart,
  timelineModel,
  timelineWindow,
  windowAgents,
} from '../../src/web/views/session/timeline.ts';

/** 10:00 local time on the day of the test (the prototype's clock starts at 10:00 + t0). */
const BASE = new Date(2026, 8, 28, 10, 0, 0, 0).getTime();
const at = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString();

function agent(id: string, name: string, kind: Agent['kind'] = 'subagent', solutionPath: string | null = null): Agent {
  return { id, kind, name, description: null, solutionPath, branch: null, status: 'run', statusText: null };
}

let nextId = 1;
function event(agentId: string | null, kind: EventKind, label: string, start: number, end: number | null, payload: unknown = { type: 'x' }): SessionEvent {
  return { id: nextId++, sessionId: 's', agentId, ts: at(start), endTs: end === null ? null : at(end), kind, label, payload };
}

/** The prototype's `free-talk-feature` timeline (t0 2, dur 46), in the demo seed's shape. */
function prototypeSession(): { agents: Agent[]; events: SessionEvent[] } {
  nextId = 1;
  const agents = [
    agent('o', 'orchestrator', 'main', 'workspace root'),
    agent('w', 'web', 'subagent', 'acme-app-front'),
    agent('m', 'mobile', 'subagent', 'mobile/'),
    agent('f', 'figma-extractor', 'subagent', 'read-only'),
  ];
  const t0 = 2;
  const lanes: Array<[string, Array<[number, number, EventKind, string]>]> = [
    ['o', [[0, 3, 'plan', 'task definition'], [3, 9, 'plan', 'recon · codebase-memory'], [9, 12, 'plan', 'contract lock'], [12, 13, 'impl', 'dispatch'], [30, 33, 'ask', 'relay 3 Qs'], [40, 46, 'ok', 'reconcile']]],
    ['f', [[9, 12, 'plan', 'spec table']]],
    ['w', [[13, 22, 'impl', 'implement FreeTalkPage'], [22, 26, 'loop', 'build self-heal ×2'], [26, 30, 'loop', 'render vs Figma 3/5'], [30, 31, 'ask', '?'], [33, 40, 'impl', 'apply answers']]],
    ['m', [[13, 24, 'impl', 'implement FreeTalkView'], [24, 29, 'loop', 'build self-heal ×1'], [29, 30, 'ask', '?'], [33, 39, 'impl', 'apply answers']]],
  ];
  const events: SessionEvent[] = [
    // chat (text) at the start and the end, terminal lines at the end: not blocks
    event(null, 'text', 'Free talk screen at 360', t0, null, { source: 'demo', channel: 'chat' }),
    event(null, 'text', 'Contract locked', t0 + 46, null, { source: 'demo', channel: 'chat' }),
    event(null, 'tool', '✓ web 13/14 fields match', t0 + 46, null, { source: 'demo', channel: 'terminal' }),
  ];
  for (const [id, blocks] of lanes) {
    for (const [s, e, kind, label] of blocks) events.push(event(id, kind, label, t0 + s, t0 + e, { source: 'demo', channel: 'timeline' }));
  }
  return { agents, events };
}

describe('timelineModel on the prototype data', () => {
  it('reproduces the prototype axis, lanes and log at the end', () => {
    const { agents, events } = prototypeSession();
    const model = timelineModel({ events, agents, status: 'need', now: BASE, play: PLAY_MAX });
    expect(model.empty).toBe(false);
    expect(model.range).toBe('10:02 – 10:48');
    expect(model.ticks).toEqual(['10:02', '10:10', '10:17', '10:25', '10:33', '10:40', '10:48']);
    expect(model.now).toBe('10:48');
    expect(model.head).toBe(100);
    expect(model.ticking).toBe(false);
    expect(model.lanes.map((lane) => [lane.name, lane.sub])).toEqual([
      ['orchestrator', 'workspace root'],
      ['figma-extractor', 'read-only'],
      ['web', 'acme-app-front'],
      ['mobile', 'mobile/'],
    ]);
    const orchestrator = model.lanes[0]!;
    expect(orchestrator.blocks.map((b) => [b.kind, b.label])).toEqual([
      ['plan', 'task definition'],
      ['plan', 'recon · codebase-memory'],
      ['plan', 'contract lock'],
      ['impl', 'dispatch'],
      ['ask', 'relay 3 Qs'],
      ['ok', 'reconcile'],
    ]);
    const recon = orchestrator.blocks[1]!;
    expect(recon.left).toBeCloseTo((3 / 46) * 100, 6);
    expect(recon.width).toBeCloseTo((6 / 46) * 100, 6);
    expect(model.lanes.flatMap((lane) => lane.blocks).every((b) => !b.dim)).toBe(true);
    expect(model.log.map((x) => `${x.time} ${x.who} · ${x.label} (${x.kind})`)).toEqual([
      '10:26 mobile · build self-heal ×1 (loop)',
      '10:28 web · render vs Figma 3/5 (loop)',
      '10:31 mobile · ? (ask)',
      '10:32 orchestrator · relay 3 Qs (ask)',
      '10:32 web · ? (ask)',
      '10:35 web · apply answers (impl)',
      '10:35 mobile · apply answers (impl)',
      '10:42 orchestrator · reconcile (ok)',
    ]);
  });

  it('moves the playhead, dims later blocks and cuts the log at the scrubber', () => {
    const { agents, events } = prototypeSession();
    const model = timelineModel({ events, agents, status: 'need', now: BASE, play: 500 });
    expect(model.head).toBe(50);
    expect(model.now).toBe('10:25');
    const blocks = model.lanes.flatMap((lane) => lane.blocks);
    for (const block of blocks) expect(block.dim).toBe(block.start > BASE + 25 * 60_000);
    expect(model.log.at(-1)?.label).toBe('build self-heal ×2');
    expect(model.log.every((x) => x.time <= '10:25')).toBe(true);
    expect(model.log).toHaveLength(LOG_LIMIT);

    const start = timelineModel({ events, agents, status: 'need', now: BASE, play: 0 });
    expect(start.now).toBe('10:02');
    expect(start.log.map((x) => x.label)).toEqual(['task definition']);
  });
});

describe('timelineModel on real events', () => {
  const agents = [agent('main', 'acme-app-front', 'main'), agent('sub', 'general-purpose')];
  const t = (seconds: number): number => BASE + seconds * 1_000;
  const iso = (seconds: number): string => new Date(t(seconds)).toISOString();
  function real(agentId: string | null, kind: EventKind, label: string, start: number, end: number | null, payload: unknown): SessionEvent {
    return { id: nextId++, sessionId: 's', agentId, ts: iso(start), endTs: end === null ? null : iso(end), kind, label, payload };
  }

  it('draws plan/impl/loop/ask/ok/error blocks per agent and leaves text and other tools out', () => {
    nextId = 100;
    const events = [
      real('main', 'text', 'Build it', 0, null, { type: 'user', text: 'Build it', origin: 'task', delivered: true }),
      real('main', 'impl', 'Write · a.md', 5, 10, { type: 'tool', name: 'Write', toolUseId: 't1', input: {}, result: 'ok' }),
      real('main', 'tool', 'Agent · general-purpose · read', 10, 40, { type: 'tool', name: 'Agent', toolUseId: 't2', input: {} }),
      real('sub', 'plan', 'Read · hello.txt', 12, 14, { type: 'tool', name: 'Read', toolUseId: 't3', input: {}, result: 'x' }),
      real('main', 'text', 'Done reading', 41, null, { type: 'assistant', text: 'Done reading', messageId: 'm' }),
      real('main', 'ok', 'Done', 42, null, { type: 'result', subtype: 'success', isError: false }),
      real('main', 'loop', '/loop 5m check', 50, null, { type: 'user', text: '/loop 5m check', origin: 'user', delivered: true }),
      real(null, 'error', 'Not resumed after the restart: busy', 55, null, { type: 'lifecycle', action: 'not-resumed' }),
      real('ghost', 'ask', 'Permission · Bash · rm', 60, null, { type: 'request', state: 'responded' }),
    ];
    const model = timelineModel({ events, agents, status: 'done', now: t(999), play: PLAY_MAX });
    expect(model.range).toBe('10:00:00 – 10:01:00');
    expect(model.ticks[1]).toBe('10:00:10');
    expect(model.lanes.map((lane) => [lane.name, lane.sub])).toEqual([
      ['acme-app-front', MAIN_LANE_SUB],
      ['general-purpose', ''],
    ]);
    // D14: a repo session's main lane names its repo instead of the workspace root.
    expect(timelineModel({ events, agents, status: 'done', now: t(999), play: PLAY_MAX, root: 'switchboard' }).lanes[0]?.sub).toBe('switchboard');
    expect(model.lanes[0]!.blocks.map((b) => [b.kind, b.label])).toEqual([
      ['impl', 'Write · a.md'],
      ['ok', 'Done'],
      ['loop', '/loop 5m check'],
      ['error', 'Not resumed after the restart: busy'],
      ['ask', 'Permission · Bash · rm'],
    ]);
    expect(model.lanes[1]!.blocks.map((b) => b.kind)).toEqual(['plan']);
    const done = model.lanes[0]!.blocks[1]!;
    expect(done.width).toBe(0);
    expect(done.left).toBeCloseTo((42 / 60) * 100, 6);
    expect(model.log.map((x) => x.who)).toEqual(['acme-app-front', 'general-purpose', 'acme-app-front', 'acme-app-front', 'acme-app-front', 'acme-app-front']);
  });

  it('lets an open tool call run to now while the session is live, and stops at the last event otherwise', () => {
    nextId = 200;
    const events = [
      real('main', 'text', 'go', 0, null, { type: 'user', text: 'go', origin: 'task', delivered: true }),
      real('main', 'ask', '2 questions · Which?', 10, null, { type: 'tool', name: 'AskUserQuestion', toolUseId: 'q', input: {}, requestState: 'open' }),
      real('main', 'impl', 'Bash · sleep 100', 12, null, { type: 'tool', name: 'Bash', toolUseId: 'b', input: { command: 'sleep 100' } }),
    ];
    expect(isOpenEvent(events[1]!)).toBe(true);
    const live = timelineModel({ events, agents, status: 'need', now: t(40), play: PLAY_MAX });
    expect(live.ticking).toBe(true);
    expect(live.range).toBe('10:00:00 – 10:00:40');
    const [ask, bash] = live.lanes[0]!.blocks;
    expect(ask!.open).toBe(true);
    expect(ask!.left + ask!.width).toBeCloseTo(100, 6);
    expect(bash!.end).toBe(t(40));

    const paused = timelineModel({ events, agents, status: 'paused', now: t(40), play: PLAY_MAX });
    expect(paused.ticking).toBe(false);
    expect(paused.range).toBe('10:00:00 – 10:00:12');
    expect(paused.lanes[0]!.blocks.every((b) => !b.open)).toBe(true);
  });

  it('has no axis without events, keeps idle agents as empty lanes and puts the main agent first', () => {
    const model = timelineModel({ events: [], agents: [agent('sub', 'explorer'), agent('main', 'main', 'main')], status: 'run', now: BASE, play: PLAY_MAX });
    expect(model.empty).toBe(true);
    expect(model.range).toBe('');
    expect(model.ticks).toEqual([]);
    expect(model.now).toBe('—');
    expect(model.lanes.map((lane) => lane.name)).toEqual(['main', 'explorer']);
    expect(model.log).toEqual([]);
  });
});

describe('helpers', () => {
  it('formats the clock like the prototype (hours unpadded, rounded)', () => {
    expect(formatClock(BASE + 2 * 60_000)).toBe('10:02');
    expect(formatClock(BASE + 7.67 * 60_000)).toBe('10:08');
    expect(formatClock(new Date(2026, 8, 28, 9, 5, 29).getTime())).toBe('9:05');
    expect(formatClock(new Date(2026, 8, 28, 9, 5, 29, 600).getTime(), true)).toBe('9:05:30');
  });

  it('plays 8 steps per tick and stops at the end', () => {
    expect(playStep(0)).toEqual({ play: 8, playing: true });
    expect(playStep(990)).toEqual({ play: 998, playing: true });
    expect(playStep(992)).toEqual({ play: PLAY_MAX, playing: false });
  });
});

describe('session source (the /hub copy over the fetched detail)', () => {
  /** Only the agents matter here. */
  const session = (...agents: Agent[]): Session => ({ id: 's', agents }) as unknown as Session;
  const main = agent('m', 'orchestrator', 'main');
  const sub = agent('a', 'general-purpose');

  it('keeps the newest /hub copy while a refetch runs, so a lane it shows does not blink', () => {
    const stale = session(main);
    let source = sessionPushed(EMPTY_SESSION_SOURCE, session(main, sub));
    source = sessionRefetching(source);
    // The refetch is on its way: the copy with the subagent still draws its lane.
    expect(shownSession(source, stale)?.agents).toEqual([main, sub]);
    // Its answer lands: the copy asked about gives way to it.
    const fresh = session(main, sub);
    source = sessionFetched(source);
    expect(source.pushed).toBeNull();
    expect(shownSession(source, fresh)).toBe(fresh);
  });

  it('keeps a copy that arrived after the refetch was asked for', () => {
    let source = sessionRefetching(sessionPushed(EMPTY_SESSION_SOURCE, session(main)));
    const newer = session(main, sub);
    source = sessionPushed(source, newer);
    source = sessionFetched(source);
    expect(shownSession(source, session(main))).toBe(newer);
    expect(source.reloadFrom).toBeNull();
  });

  it('ignores detail changes without a pending refetch and shows the detail without a copy', () => {
    const fetched = session(main);
    expect(shownSession(EMPTY_SESSION_SOURCE, fetched)).toBe(fetched);
    const pushed = sessionPushed(EMPTY_SESSION_SOURCE, session(main, sub));
    expect(sessionFetched(pushed)).toBe(pushed);
  });
});

describe('D95 follow-up · the windowed Timeline (timelineWindow, windowAgents)', () => {
  /** `turns` turns: a user message, then a block of `agentOf(turn)` a minute later. */
  function history(turns: number, agentOf: (turn: number) => string | null = () => null): SessionEvent[] {
    nextId = 1;
    const events: SessionEvent[] = [event(null, 'text', 'session start', 0, null, { type: 'lifecycle' })];
    for (let turn = 0; turn < turns; turn++) {
      events.push(event(null, 'text', `turn ${turn}`, 1 + turn * 2, null, { type: 'user', text: `turn ${turn}` }));
      events.push(event(agentOf(turn), 'impl', `work ${turn}`, 2 + turn * 2, 2.5 + turn * 2));
    }
    return events;
  }

  it('a turn starts at a user message', () => {
    expect(isTurnStart(event(null, 'text', 'hi', 0, null, { type: 'user', text: 'hi' }))).toBe(true);
    expect(isTurnStart(event(null, 'text', 'reply', 0, null, { type: 'assistant', text: 'reply' }))).toBe(false);
    expect(TIMELINE_TURNS).toBe(50);
  });

  it('shows the last n turns of a complete history, from the n-th newest user message; all of a short one', () => {
    const events = history(5);
    const window = timelineWindow([...events].reverse(), true, 3);
    expect(window.shown.map((e) => e.label)).toEqual(['turn 2', 'work 2', 'turn 3', 'work 3', 'turn 4', 'work 4']);
    expect(window).toMatchObject({ earlier: true, needMore: false });
    // As many turns as the history has (or more): everything, the session start included; nothing earlier.
    expect(timelineWindow(events, true, 5)).toMatchObject({ earlier: false, needMore: false });
    expect(timelineWindow(events, true, 5).shown).toHaveLength(events.length);
    expect(timelineWindow(events, true, 50)).toMatchObject({ earlier: false, needMore: false });
  });

  it('an incomplete history with too few turns loaded asks for the page before; with enough, it does not', () => {
    const events = history(5);
    const page = events.slice(-6);
    expect(timelineWindow(page, false, 5)).toMatchObject({ earlier: true, needMore: true });
    const enough = timelineWindow(page, false, 2);
    expect(enough).toMatchObject({ earlier: true, needMore: false });
    expect(enough.shown.map((e) => e.label)).toEqual(['turn 3', 'work 3', 'turn 4', 'work 4']);
  });

  it('lanes: the main agent, the agents active in the window and the ones still working, in the session order', () => {
    const agents = [agent('main', 'main', 'main'), agent('old', 'old'), agent('recent', 'recent'), agent('live', 'live'), agent('idle', 'idle')].map((a) =>
      a.id === 'live' ? a : { ...a, status: 'done' as const },
    );
    const events = history(4, (turn) => (turn === 0 ? 'old' : turn === 3 ? 'recent' : null));
    const window = timelineWindow(events, true, 2);
    expect(windowAgents(agents, window.shown).map((a) => a.id)).toEqual(['main', 'recent', 'live']);
    expect(windowAgents(agents, events).map((a) => a.id)).toEqual(['main', 'old', 'recent', 'live']);
    const model = timelineModel({ events: window.shown, agents: windowAgents(agents, window.shown), status: 'done', now: BASE, play: PLAY_MAX });
    expect(model.lanes.map((lane) => lane.id)).toEqual(['main', 'recent', 'live']);
    // The axis starts at the window's first turn.
    expect(model.range.startsWith(formatClock(BASE + 5 * 60_000, false))).toBe(true);
  });
});
