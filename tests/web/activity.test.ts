import { describe, expect, it } from 'vitest';
import type { BackgroundTask, SessionActivity } from '../../src/core/api.ts';
import { ActivityTracker } from '../../src/core/derive/activity.ts';
import {
  THINKING_VERBS,
  VERB_ROTATE_MS,
  activityLabel,
  backgroundLine,
  backgroundText,
  cardActivityLabel,
  chatActivityLine,
  elapsedMs,
  formatClock,
  formatClockTime,
  formatElapsed,
  formatTokens,
  overviewActivityLabel,
  sessionActivityLabel,
  oldestBackgroundTask,
  thinkingVerb,
  toolText,
} from '../../src/web/activity/activity.ts';

/** D19 live activity copy (`src/web/activity/activity.ts`, `docs/chat.md` → *Live activity line*). */

const START = '2026-09-28T10:00:00.000Z';
const t0 = Date.parse(START);
const at = (seconds: number): number => t0 + seconds * 1000;
const iso = (seconds: number): string => new Date(at(seconds)).toISOString();

function activity(fields: Partial<SessionActivity> = {}): SessionActivity {
  return { turnStartedAt: START, state: 'thinking', since: START, tool: null, summary: null, thinkingTokens: null, agents: {}, background: [], ...fields };
}

describe('elapsed, clock and token formats', () => {
  it('formatElapsed: the turn time as `12s` / `1m 23s` / `2h 5m`', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(59_999)).toBe('59s');
    expect(formatElapsed(60_000)).toBe('1m 0s');
    expect(formatElapsed(83_000)).toBe('1m 23s');
    expect(formatElapsed(3_599_000)).toBe('59m 59s');
    expect(formatElapsed(3_600_000 * 2 + 5 * 60_000 + 30_000)).toBe('2h 5m');
    expect(formatElapsed(-5_000)).toBe('0s');
  });

  it('formatClock: a tool or a wait as `0:42` / `12:05` / `1:02:03`', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(42_900)).toBe('0:42');
    expect(formatClock(725_000)).toBe('12:05');
    expect(formatClock(3_723_000)).toBe('1:02:03');
  });

  it('formatTokens: `850`, `1.2k`, `12k`, rounded down', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(850)).toBe('850');
    expect(formatTokens(1_000)).toBe('1k');
    expect(formatTokens(1_234)).toBe('1.2k');
    expect(formatTokens(1_299)).toBe('1.2k');
    expect(formatTokens(9_999)).toBe('9.9k');
    expect(formatTokens(12_345)).toBe('12k');
    expect(formatTokens(1_560_000)).toBe('1.5M');
  });

  it('elapsedMs: from a server timestamp, never negative, 0 when unreadable', () => {
    expect(elapsedMs(START, at(3))).toBe(3_000);
    expect(elapsedMs(START, at(-3))).toBe(0);
    expect(elapsedMs('not a date', at(3))).toBe(0);
  });
});

describe('thinking verbs', () => {
  it('Switchboard\'s own list of about 20, with the decision\'s examples', () => {
    expect(THINKING_VERBS.length).toBeGreaterThanOrEqual(18);
    expect(THINKING_VERBS.length).toBeLessThanOrEqual(24);
    expect(new Set(THINKING_VERBS).size).toBe(THINKING_VERBS.length);
    for (const verb of ['Pondering…', 'Noodling…', 'Cogitating…']) expect(THINKING_VERBS).toContain(verb);
    for (const verb of THINKING_VERBS) expect(verb.endsWith('…')).toBe(true);
  });

  it('rotates every few seconds, deterministic for an injected clock and the same in every view of the turn', () => {
    const first = thinkingVerb(START, at(0));
    const index = THINKING_VERBS.indexOf(first);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(thinkingVerb(START, at(0) + VERB_ROTATE_MS - 1)).toBe(first);
    expect(thinkingVerb(START, at(0) + VERB_ROTATE_MS)).toBe(THINKING_VERBS[(index + 1) % THINKING_VERBS.length]);
    expect(thinkingVerb(START, at(0) + VERB_ROTATE_MS * THINKING_VERBS.length)).toBe(first);
    // Same inputs, same verb (no randomness); a different turn starts elsewhere in the list.
    expect(thinkingVerb(START, at(9))).toBe(thinkingVerb(START, at(9)));
    const others = ['2026-09-28T10:00:01.000Z', '2026-09-28T11:30:00.000Z', '2026-09-29T08:00:00.000Z'].map((start) =>
      thinkingVerb(start, Date.parse(start)),
    );
    expect(new Set([first, ...others]).size).toBeGreaterThan(1);
  });
});

describe('the chat line (D19)', () => {
  it('thinking: a verb, the time since the turn started, `· ↓ n tokens` once known', () => {
    expect(chatActivityLine(activity(), at(12))).toEqual({ state: 'thinking', glyph: 'spinner', text: thinkingVerb(START, at(12)), time: '12s', tokens: null });
    expect(chatActivityLine(activity({ thinkingTokens: 1234, since: iso(80) }), at(83))).toMatchObject({ time: '1m 23s', tokens: '↓ 1.2k tokens' });
  });

  it('a running tool reads literally with the time since that tool started; writing and waiting in the same style', () => {
    expect(chatActivityLine(activity({ state: 'tool', tool: 'Bash', summary: 'npm test', since: iso(18), thinkingTokens: 900 }), at(60))).toEqual({
      state: 'tool',
      glyph: '●',
      text: 'Bash: npm test',
      time: '0:42',
      tokens: null,
    });
    expect(chatActivityLine(activity({ state: 'tool', tool: 'TodoWrite', summary: 'TodoWrite', since: iso(0) }), at(5)).text).toBe('TodoWrite');
    expect(chatActivityLine(activity({ state: 'writing', since: iso(30) }), at(95))).toEqual({ state: 'writing', glyph: 'spinner', text: 'Writing…', time: '1m 35s', tokens: null });
    expect(chatActivityLine(activity({ state: 'waiting', since: iso(10) }), at(75))).toEqual({ state: 'waiting', glyph: '⏸', text: 'Waiting for you', time: '1:05', tokens: null });
  });

  it('summaries from real tool inputs (the server derivation feeding the line)', () => {
    let clock = at(0);
    const tracker = new ActivityTracker({ mainAgentId: 'main', now: () => new Date(clock) });
    tracker.startTurn();
    const line = (name: string, input: Record<string, unknown>): string => {
      tracker.toolStarted('main', name, name, input);
      clock += 1000;
      const text = chatActivityLine(tracker.snapshot() as SessionActivity, clock).text;
      tracker.toolEnded(name);
      return text;
    };
    expect(line('Bash', { command: 'npm test\nnpm run e2e' })).toBe('Bash: npm test');
    expect(line('Read', { file_path: '/repo/src/web/shell/Sidebar.tsx' })).toBe('Read: Sidebar.tsx');
    expect(line('Edit', { file_path: '/repo/docs/chat.md' })).toBe('Edit: chat.md');
    expect(line('Write', { file_path: '/repo/out.txt' })).toBe('Write: out.txt');
    expect(line('Grep', { pattern: 'activity' })).toBe('Grep: activity');
    expect(line('Glob', { pattern: '**/*.css' })).toBe('Glob: **/*.css');
    expect(line('Agent', { description: 'Read hello.txt and return first line' })).toBe('Agent: Read hello.txt and return first line');
    expect(line('WebFetch', { url: 'https://nodejs.org/api/sqlite.html' })).toBe('WebFetch: nodejs.org');
    expect(line('NotebookEdit', { notebook_path: 'a.ipynb' })).toBe('NotebookEdit');
    expect(toolText(null, null)).toBe('Tool');
  });
});

describe('sidebar row and agent card labels (D19)', () => {
  it('the action and its time: Thinking… / Writing… timed from the agent\'s start, a tool or a wait from its own start', () => {
    const entry = { state: 'thinking' as const, since: iso(50), startedAt: iso(20), tool: null, summary: null };
    expect(activityLabel(entry, at(62))).toEqual({ state: 'thinking', text: 'Thinking…', time: '42s' });
    expect(activityLabel({ ...entry, state: 'writing' }, at(100))).toEqual({ state: 'writing', text: 'Writing…', time: '1m 20s' });
    expect(activityLabel({ ...entry, state: 'tool', tool: 'Read', summary: 'hello.txt' }, at(53))).toEqual({ state: 'tool', text: 'Read: hello.txt', time: '0:03' });
    expect(activityLabel({ ...entry, state: 'waiting' }, at(125))).toEqual({ state: 'waiting', text: 'Waiting for you', time: '1:15' });
  });

  it('the session row times thinking and writing from the turn start, like the chat line', () => {
    expect(sessionActivityLabel(activity({ since: iso(40) }), at(45))).toEqual({ state: 'thinking', text: 'Thinking…', time: '45s' });
    expect(sessionActivityLabel(activity({ state: 'tool', tool: 'Bash', summary: 'ls', since: iso(40) }), at(45))).toEqual({ state: 'tool', text: 'Bash: ls', time: '0:05' });
  });
});

describe('agent card label (D21 ruling: the same verb as the chat line)', () => {
  it("the main agent's card thinks with the chat line's verb and the turn's time; a subagent's card and other states read as before", () => {
    const main = { state: 'thinking' as const, since: iso(50), startedAt: START, tool: null, summary: null };
    expect(cardActivityLabel(main, START, at(83))).toEqual({ state: 'thinking', text: thinkingVerb(START, at(83)), time: '1m 23s' });
    expect(cardActivityLabel(main, START, at(83)).text).toBe(chatActivityLine(activity(), at(83)).text);
    const sub = { ...main, startedAt: iso(20) };
    expect(cardActivityLabel(sub, null, at(62))).toEqual({ state: 'thinking', text: 'Thinking…', time: '42s' });
    expect(cardActivityLabel({ ...main, state: 'tool', tool: 'Bash', summary: 'ls' }, START, at(53))).toEqual({ state: 'tool', text: 'Bash: ls', time: '0:03' });
  });
});

describe('agent overview Status cell (D21)', () => {
  const entry = { state: 'thinking' as const, since: iso(50), startedAt: iso(20), tool: null, summary: null };

  it('a running tool and a wait read like the chat line (● / ⏸ in front of the card\'s action), timed from their own start', () => {
    expect(overviewActivityLabel({ ...entry, state: 'tool', tool: 'Bash', summary: 'npm test' }, START, at(92))).toEqual({ state: 'tool', text: '● Bash: npm test', time: '0:42' });
    expect(overviewActivityLabel({ ...entry, state: 'waiting' }, null, at(62))).toEqual({ state: 'waiting', text: '⏸ Waiting for you', time: '0:12' });
  });

  it("the main agent thinks with the chat line's verb and the turn's time; a subagent reads Thinking…; writing as on the card", () => {
    const main = { ...entry, startedAt: START };
    expect(overviewActivityLabel(main, START, at(83))).toEqual({ state: 'thinking', text: thinkingVerb(START, at(83)), time: '1m 23s' });
    expect(overviewActivityLabel(main, START, at(83)).text).toBe(chatActivityLine(activity(), at(83)).text);
    expect(overviewActivityLabel(entry, null, at(62))).toEqual({ state: 'thinking', text: 'Thinking…', time: '42s' });
    expect(overviewActivityLabel({ ...entry, state: 'writing' }, START, at(100))).toEqual({ state: 'writing', text: 'Writing…', time: '1m 20s' });
  });
});

describe('background work (D30)', () => {
  const GH = 'gh run view 4242 --json status --jq .status';
  const task = (fields: Partial<BackgroundTask> = {}): BackgroundTask => ({
    id: 'b1',
    toolUseId: 'toolu_1',
    kind: 'bash',
    summary: GH,
    startedAt: iso(0),
    github: true,
    ...fields,
  });
  /** The activity the service sends while no turn runs and `tasks` are pending (the oldest shows). */
  const waiting = (tasks: BackgroundTask[]): SessionActivity => {
    const oldest = [...tasks].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0] as BackgroundTask;
    const tool = oldest.kind === 'wakeup' ? 'ScheduleWakeup' : 'Bash';
    return activity({
      state: 'background',
      turnStartedAt: oldest.startedAt,
      since: oldest.startedAt,
      tool,
      summary: oldest.summary,
      agents: { main: { state: 'background', since: oldest.startedAt, startedAt: oldest.startedAt, tool, summary: oldest.summary } },
      background: tasks,
    });
  };
  /** `18:40` local time as ISO. */
  const localAt = (hours: number, minutes: number): string => new Date(2026, 8, 28, hours, minutes, 30).toISOString();

  it('the words: a GitHub wait, any other background task, a wake-up at its local time', () => {
    expect(backgroundText(task())).toBe(`Waiting for GitHub Actions: ${GH}`);
    expect(backgroundText(task({ github: false, summary: 'npm run e2e' }))).toBe('Waiting for a background task: npm run e2e');
    expect(backgroundText(task({ kind: 'agent', github: false, summary: 'Review the diff' }))).toBe('Waiting for a background task: Review the diff');
    expect(backgroundText(task({ kind: 'wakeup', github: false, summary: 'Check CI', wakeAt: localAt(18, 40) }))).toBe('Waking up at 18:40');
    expect(backgroundText(task({ kind: 'wakeup', github: false, summary: 'Check CI', wakeAt: localAt(7, 5) }))).toBe('Waking up at 07:05');
    expect(formatClockTime('not a date')).toBe('');
  });

  it('the chat line: ⏳, the oldest task\'s words, the time since it started (a clock), no tokens', () => {
    expect(chatActivityLine(waiting([task()]), at(201))).toEqual({ state: 'background', glyph: '⏳', text: `Waiting for GitHub Actions: ${GH}`, time: '3:21', tokens: null });
    const wake = task({ kind: 'wakeup', github: false, summary: 'Check CI', startedAt: iso(30), wakeAt: localAt(18, 40) });
    expect(chatActivityLine(waiting([wake]), at(42))).toEqual({ state: 'background', glyph: '⏳', text: 'Waking up at 18:40', time: '0:12', tokens: null });
  });

  it('several tasks: the oldest shows (whatever the order) and `+N more`', () => {
    const tasks = [task({ id: 'b2', toolUseId: 't2', github: false, summary: 'npm run dev', startedAt: iso(60) }), task(), task({ id: 'a3', kind: 'agent', github: false, summary: 'Review', startedAt: iso(90) })];
    expect(oldestBackgroundTask(tasks)?.id).toBe('b1');
    expect(oldestBackgroundTask([])).toBeNull();
    expect(chatActivityLine(waiting(tasks), at(125))).toEqual({
      state: 'background',
      glyph: '⏳',
      text: `Waiting for GitHub Actions: ${GH}`,
      time: '2:05',
      tokens: null,
      more: '+2 more',
    });
    expect(backgroundLine(tasks.slice(0, 2), { since: iso(0), tool: 'Bash', summary: null }, at(10))).toEqual({ text: `Waiting for GitHub Actions: ${GH}`, more: '+1 more', time: '0:10' });
  });

  it('without the list (an older payload) the activity\'s own summary and time stand in', () => {
    expect(chatActivityLine(activity({ state: 'background', since: iso(5), tool: 'Bash', summary: 'npm run dev', background: [] }), at(65))).toEqual({
      state: 'background',
      glyph: '⏳',
      text: 'Waiting for a background task: npm run dev',
      time: '1:00',
      tokens: null,
    });
  });

  it('the sidebar row, the main agent\'s card and its overview cell show the same wait (the overview with ⏳)', () => {
    const tasks = [task(), task({ id: 'b2', toolUseId: 't2', github: false, summary: 'npm run dev', startedAt: iso(60) })];
    const session = waiting(tasks);
    const main = session.agents['main']!;
    expect(sessionActivityLabel(session, at(201))).toEqual({ state: 'background', text: `Waiting for GitHub Actions: ${GH}`, time: '3:21', more: '+1 more' });
    expect(cardActivityLabel(main, session.turnStartedAt, at(201), session.background)).toEqual({ state: 'background', text: `Waiting for GitHub Actions: ${GH}`, time: '3:21', more: '+1 more' });
    expect(overviewActivityLabel(main, session.turnStartedAt, at(201), session.background)).toEqual({
      state: 'background',
      text: `⏳ Waiting for GitHub Actions: ${GH}`,
      time: '3:21',
      more: '+1 more',
    });
    expect(activityLabel(main, at(201), [task({ github: false, summary: 'npm run dev' })])).toEqual({ state: 'background', text: 'Waiting for a background task: npm run dev', time: '3:21' });
  });

  it('while a turn runs the pending list changes nothing in the line', () => {
    const running = activity({ state: 'tool', tool: 'Bash', summary: 'npm test', since: iso(18), background: [task()] });
    expect(chatActivityLine(running, at(60))).toEqual({ state: 'tool', glyph: '●', text: 'Bash: npm test', time: '0:42', tokens: null });
    expect(sessionActivityLabel(running, at(60))).toEqual({ state: 'tool', text: 'Bash: npm test', time: '0:42' });
  });

  it('D43: a workflow reads `Running a workflow: <summary>`, a task the CLI reported `Waiting for a background task: <summary>`, in every view', () => {
    const AUDIT = 'Read-only audit of HubSpot contacts and deals';
    const workflow = task({ id: 'wbetnz0pi', toolUseId: 't9', kind: 'workflow', github: false, summary: AUDIT });
    const reported = task({ id: 'k7', toolUseId: 'k7', kind: 'task', github: false, summary: 'Export the quarterly report', startedAt: iso(30) });
    expect(backgroundText(workflow)).toBe(`Running a workflow: ${AUDIT}`);
    expect(backgroundText(reported)).toBe('Waiting for a background task: Export the quarterly report');
    const both = activity({
      state: 'background',
      turnStartedAt: iso(0),
      since: iso(0),
      tool: 'Workflow',
      summary: AUDIT,
      agents: { main: { state: 'background', since: iso(0), startedAt: iso(0), tool: 'Workflow', summary: AUDIT } },
      background: [reported, workflow],
    });
    expect(chatActivityLine(both, at(75))).toEqual({ state: 'background', glyph: '⏳', text: `Running a workflow: ${AUDIT}`, time: '1:15', tokens: null, more: '+1 more' });
    expect(sessionActivityLabel(both, at(75))).toEqual({ state: 'background', text: `Running a workflow: ${AUDIT}`, time: '1:15', more: '+1 more' });
    const main = both.agents['main']!;
    expect(cardActivityLabel(main, both.turnStartedAt, at(75), both.background)).toEqual({ state: 'background', text: `Running a workflow: ${AUDIT}`, time: '1:15', more: '+1 more' });
    expect(overviewActivityLabel(main, both.turnStartedAt, at(75), both.background)).toEqual({ state: 'background', text: `⏳ Running a workflow: ${AUDIT}`, time: '1:15', more: '+1 more' });
    // Only the reported task left (the workflow ended): its words and its own time.
    const alone = activity({ state: 'background', turnStartedAt: iso(30), since: iso(30), tool: null, summary: reported.summary, background: [reported] });
    expect(chatActivityLine(alone, at(75))).toEqual({ state: 'background', glyph: '⏳', text: 'Waiting for a background task: Export the quarterly report', time: '0:45', tokens: null });
  });
});
