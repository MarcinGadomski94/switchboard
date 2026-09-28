import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionActivity } from '../../../src/core/api.ts';
import { ActivityTracker, toolSummary } from '../../../src/core/derive/activity.ts';
import { parseStreamLine } from '../../../src/core/stream-json.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { LatestThrottle, type ThrottleTimers } from '../../../src/server/supervisor/activity-throttle.ts';
import { StreamRecorder } from '../../../src/server/supervisor/recorder.ts';
import { FIXTURES_DIR } from '../../../tools/fake-claude/fixtures.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D19 live activity (`docs/derivations.md` → *Live activity*): the recorder turns
 * the recorded stream-json of M0 (tools/fake-claude/fixtures) into the session's
 * current action: thinking (with the turn's thinking tokens), a running tool,
 * writing, waiting for the developer, idle after the result; each subagent its
 * own. Then the throttle that keeps `activity` notifications to one per second
 * per session, on its own and on the real path (fake-claude).
 */

const T0 = Date.parse('2026-09-28T10:00:00.000Z');

let tmp: string | undefined;
let store: Store | undefined;
let world: SupervisorWorld | undefined;

afterEach(async () => {
  await store?.close();
  store = undefined;
  if (tmp) await removeTempDir(tmp);
  tmp = undefined;
  await world?.cleanup();
  world = undefined;
});

async function fixtureLines(name: string): Promise<string[]> {
  return (await readFile(path.join(FIXTURES_DIR, `${name}.ndjson`), 'utf8')).split('\n').filter((line) => line.trim() !== '');
}

/** A recorder over a temp store whose clock moves one second per stdout line. */
async function recorderWorld() {
  tmp = await makeTempDir('activity');
  store = await openTempStore(tmp);
  const cwd = path.join(tmp, 'ws');
  const session = await store.sessions.create({ name: 'live', claudeSessionId: 'c-1', task: 't', mode: 'single', cwd, status: 'run' });
  const main = await store.agents.create({ sessionId: session.id, kind: 'main', name: 'main', status: 'run' });
  let clock = T0;
  const emitted: Array<SessionActivity | null> = [];
  const recorder = new StreamRecorder({
    store,
    session,
    mainAgentId: main.id,
    onEvent: () => undefined,
    onActivity: (activity) => emitted.push(activity),
    now: () => new Date(clock),
  });
  const s = store;
  return {
    recorder,
    emitted,
    mainId: main.id,
    at: (seconds: number) => new Date(T0 + seconds * 1000).toISOString(),
    /** Feeds the lines, one second apart; an open question is answered (Allow) just before its tool_result. */
    async feed(lines: readonly string[]): Promise<void> {
      const open: string[] = [];
      for (const line of lines) {
        clock += 1000;
        const message = parseStreamLine(line);
        if (message.kind === 'tool-result' && open.length > 0) await recorder.markResponded(open.shift() as string, 'allow');
        await recorder.handle(message);
        if (message.kind === 'can-use-tool') open.push(message.requestId);
      }
    },
    /** Agent id → `main` / the subagent's name. */
    async names(): Promise<Map<string, string>> {
      const agents = await s.agents.listBySession(session.id);
      return new Map(agents.map((a) => [a.id, a.kind === 'main' ? 'main' : a.name]));
    },
  };
}

type Compact = null | { state: string; tool: string | null; summary: string | null; tokens: number | null; agents: Record<string, string> };

function compact(activity: SessionActivity | null, names: Map<string, string>): Compact {
  if (!activity) return null;
  const agents: Record<string, string> = {};
  for (const [id, entry] of Object.entries(activity.agents)) {
    agents[names.get(id) ?? id] = entry.state === 'tool' ? `tool ${entry.tool}: ${entry.summary}` : entry.state;
  }
  return { state: activity.state, tool: activity.tool, summary: activity.summary, tokens: activity.thinkingTokens, agents };
}

const thinking = (tokens: number | null, agents: Record<string, string> = { main: 'thinking' }): Compact => ({ state: 'thinking', tool: null, summary: null, tokens, agents });
const writing = (tokens: number | null, agents: Record<string, string> = { main: 'writing' }): Compact => ({ state: 'writing', tool: null, summary: null, tokens, agents });
const tool = (name: string, summary: string, tokens: number | null, agents?: Record<string, string>): Compact => ({
  state: 'tool',
  tool: name,
  summary,
  tokens,
  agents: agents ?? { main: `tool ${name}: ${summary}` },
});

describe('live activity · the recorder on recorded streams (D19)', () => {
  it('tool-use: thinking ticks add up per turn, each tool runs until its tool_result, text is writing, the result is idle', async () => {
    const w = await recorderWorld();
    const lines = await fixtureLines('tool-use');
    await w.feed(lines);
    const names = await w.names();
    expect(w.emitted.map((a) => compact(a, names))).toEqual([
      thinking(null),
      thinking(50),
      thinking(100),
      thinking(228),
      tool('Write', 'out.txt', 228),
      thinking(228),
      tool('Bash', 'ls', 228),
      thinking(228),
      // A new model message restarts `estimated_tokens` (50, 128): the turn's total keeps growing by the deltas.
      thinking(278),
      thinking(356),
      writing(356),
      null,
    ]);
    // Timestamps come from the lines: the turn from `system/init` (4th line), each tool from its tool_use.
    const initAt = lines.findIndex((l) => l.includes('"subtype":"init"')) + 1;
    const writeAt = lines.findIndex((l) => l.includes('"name":"Write"')) + 1;
    const first = w.emitted[0] as SessionActivity;
    expect(first.turnStartedAt).toBe(w.at(initAt));
    expect(first.since).toBe(w.at(initAt));
    expect(first.agents[w.mainId]).toEqual({ state: 'thinking', since: w.at(initAt), startedAt: w.at(initAt), tool: null, summary: null });
    const running = w.emitted[4] as SessionActivity;
    expect(running.since).toBe(w.at(writeAt));
    expect(running.turnStartedAt).toBe(w.at(initAt));
    expect(running.agents[w.mainId]).toMatchObject({ state: 'tool', since: w.at(writeAt), startedAt: w.at(initAt) });
    expect(w.recorder.activity()).toBeNull();
  });

  it('ask-2q: waiting for you while the question is open, the tool again once answered', async () => {
    const w = await recorderWorld();
    await w.feed(await fixtureLines('ask-2q'));
    const names = await w.names();
    expect(w.emitted.map((a) => compact(a, names))).toEqual([
      thinking(null),
      thinking(50),
      thinking(207),
      tool('AskUserQuestion', 'AskUserQuestion', 207),
      { state: 'waiting', tool: null, summary: null, tokens: 207, agents: { main: 'waiting' } },
      tool('AskUserQuestion', 'AskUserQuestion', 207),
      thinking(207),
      writing(207),
      null,
    ]);
  });

  it('subagent-forward: the subagent keeps its own action by agent id; the main agent runs the Agent tool meanwhile', async () => {
    const w = await recorderWorld();
    await w.feed(await fixtureLines('subagent-forward'));
    const names = await w.names();
    const agent = 'tool Agent: Read hello.txt and return first line';
    expect(w.emitted.map((a) => compact(a, names))).toEqual([
      thinking(null),
      thinking(50),
      thinking(150),
      thinking(405),
      tool('Agent', 'Read hello.txt and return first line', 405, { main: agent, 'general-purpose': 'thinking' }),
      tool('Agent', 'Read hello.txt and return first line', 405, { main: agent, 'general-purpose': 'writing' }),
      tool('Agent', 'Read hello.txt and return first line', 405, { main: agent, 'general-purpose': 'tool Read: hello.txt' }),
      tool('Agent', 'Read hello.txt and return first line', 405, { main: agent, 'general-purpose': 'thinking' }),
      tool('Agent', 'Read hello.txt and return first line', 405, { main: agent, 'general-purpose': 'writing' }),
      // task_updated completed: the subagent's entry goes.
      tool('Agent', 'Read hello.txt and return first line', 405, { main: agent }),
      thinking(405),
      writing(405),
      null,
    ]);
    const sub = [...names].find(([, name]) => name === 'general-purpose')?.[0] as string;
    const withSub = w.emitted[4] as SessionActivity;
    expect(withSub.agents[sub]?.startedAt).toBe(withSub.since);
  });

  it('subagent-ask: lines after the result change nothing; the CLI starting a turn by itself (task notification) is a new turn', async () => {
    const w = await recorderWorld();
    await w.feed(await fixtureLines('subagent-ask'));
    const names = await w.names();
    const emitted = w.emitted.map((a) => compact(a, names));
    const firstNull = emitted.indexOf(null);
    expect(emitted.slice(0, firstNull + 1)).toEqual([
      thinking(null),
      thinking(50),
      thinking(195),
      tool('Agent', 'Ask user to choose environment', 195, { main: 'tool Agent: Ask user to choose environment', 'general-purpose': 'thinking' }),
      // The background agent's launch returns at once: the main agent thinks again, the subagent keeps working.
      thinking(195, { main: 'thinking', 'general-purpose': 'thinking' }),
      thinking(245, { main: 'thinking', 'general-purpose': 'thinking' }),
      thinking(330, { main: 'thinking', 'general-purpose': 'thinking' }),
      writing(330, { main: 'writing', 'general-purpose': 'thinking' }),
      null,
    ]);
    // Then only the CLI's own turn: a fresh turn (no tokens carried over, the finished subagent gone), idle at its result.
    expect(emitted.slice(firstNull + 1)).toEqual([thinking(null), thinking(50), thinking(191), writing(191), null]);
  });

  it('the process ending mid-turn is idle; open requests and running subagents are cleared', async () => {
    const w = await recorderWorld();
    const lines = await fixtureLines('ask-2q');
    const ask = lines.findIndex((l) => l.includes('"type":"control_request"'));
    await w.feed(lines.slice(0, ask + 1));
    expect(w.recorder.activity()?.state).toBe('waiting');
    await w.recorder.closeOpenRequests();
    expect(w.recorder.activity()?.state).toBe('tool');
    w.recorder.endActivity();
    expect(w.recorder.activity()).toBeNull();
    expect(w.emitted.at(-1)).toBeNull();
  });
});

describe('ActivityTracker (pure)', () => {
  it('ignores everything outside a turn; a thinking tick without a delta counts the rise of the estimate', () => {
    let clock = T0;
    const tracker = new ActivityTracker({ mainAgentId: 'main', now: () => new Date(clock) });
    tracker.thinkingTokens('main', 50, 50);
    tracker.toolStarted('main', 't1', 'Bash', { command: 'npm test' });
    tracker.requestOpened('r1', 'main');
    expect(tracker.snapshot()).toBeNull();
    tracker.startTurn();
    tracker.thinkingTokens('main', 40, null);
    tracker.thinkingTokens('main', 100, null);
    tracker.thinkingTokens('main', 30, null); // a new model message
    expect(tracker.snapshot()?.thinkingTokens).toBe(130);
    clock += 5_000;
    tracker.toolStarted('main', 't1', 'Bash', { command: 'npm test\nnpm run e2e' });
    clock += 1_000;
    tracker.toolStarted('main', 't2', 'Grep', { pattern: 'TODO' });
    expect(tracker.snapshot()).toMatchObject({ state: 'tool', tool: 'Grep', summary: 'TODO', since: new Date(T0 + 6_000).toISOString() });
    tracker.toolEnded('t2');
    // The older call still runs: it shows again, with its own start.
    expect(tracker.snapshot()).toMatchObject({ state: 'tool', tool: 'Bash', summary: 'npm test', since: new Date(T0 + 5_000).toISOString() });
    tracker.requestOpened('r1', 'sub');
    expect(tracker.snapshot()).toMatchObject({ state: 'waiting', tool: null });
    expect(tracker.snapshot()?.agents['main']?.state).toBe('tool');
    expect(tracker.snapshot()?.agents['sub']?.state).toBe('waiting');
    tracker.requestClosed('r1');
    tracker.agentEnded('sub');
    tracker.agentEnded('main');
    expect(Object.keys(tracker.snapshot()?.agents ?? {})).toEqual(['main']);
    tracker.endTurn();
    expect(tracker.snapshot()).toBeNull();
  });

  it('toolSummary: D19 literal summaries, else the tool name', () => {
    expect(toolSummary('Bash', { command: '  npm test -- --run\necho done' })).toBe('npm test -- --run');
    expect(toolSummary('Read', { file_path: '/a/b/src/app.ts' })).toBe('app.ts');
    expect(toolSummary('Edit', { file_path: 'C:\\repo\\README.md' })).toBe('README.md');
    expect(toolSummary('Write', { file_path: 'out.txt' })).toBe('out.txt');
    expect(toolSummary('Grep', { pattern: 'useHubEvent\\(' })).toBe('useHubEvent\\(');
    expect(toolSummary('Glob', { pattern: 'src/**/*.tsx' })).toBe('src/**/*.tsx');
    expect(toolSummary('Agent', { description: 'Build the view', subagent_type: 'general-purpose' })).toBe('Build the view');
    expect(toolSummary('Task', { description: 'Check the contract' })).toBe('Check the contract');
    expect(toolSummary('WebFetch', { url: 'https://docs.example.com:8443/a?b=c' })).toBe('docs.example.com:8443');
    expect(toolSummary('WebFetch', { url: 'not a url' })).toBe('WebFetch');
    expect(toolSummary('Bash', {})).toBe('Bash');
    expect(toolSummary('TodoWrite', { todos: [] })).toBe('TodoWrite');
    expect(toolSummary('MultiEdit', { file_path: 'x.ts' })).toBe('MultiEdit');
    const long = toolSummary('Bash', { command: 'x'.repeat(200) });
    expect(long).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);
  });
});

/** Manual timers for the throttle. */
class ManualTimers implements ThrottleTimers {
  t = 0;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();
  #seq = 0;
  now(): number {
    return this.t;
  }
  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.t + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = [...this.#timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due || due[1].at > target) break;
      this.#timers.delete(due[0]);
      this.t = due[1].at;
      due[1].callback();
    }
    this.t = target;
  }
  get pending(): number {
    return this.#timers.size;
  }
}

describe('activity throttle (D19: at most one `activity` per second per session)', () => {
  it('sends the first change at once, folds a burst into one trailing send of the newest value, never two within the interval', () => {
    const timers = new ManualTimers();
    const sent: Array<{ at: number; value: number | null }> = [];
    const throttle = new LatestThrottle<number | null>({ intervalMs: 1_000, timers, send: (value) => sent.push({ at: timers.t, value }) });
    throttle.push(1);
    for (let i = 2; i <= 40; i += 1) {
      timers.advance(25); // thinking ticks every 25 ms
      throttle.push(i);
    }
    timers.advance(2_000);
    throttle.push(null);
    timers.advance(10);
    throttle.push(7);
    timers.advance(5_000);
    expect(sent).toEqual([
      { at: 0, value: 1 },
      { at: 1_000, value: 40 },
      { at: 2_975, value: null },
      { at: 3_975, value: 7 },
    ]);
    for (let i = 1; i < sent.length; i += 1) expect(sent[i]!.at - sent[i - 1]!.at).toBeGreaterThanOrEqual(1_000);
    expect(timers.pending).toBe(0);
  });

  it('drops a trailing value equal to the last one sent; cancel drops a pending send', () => {
    const timers = new ManualTimers();
    const sent: Array<string | null> = [];
    const throttle = new LatestThrottle<string | null>({ intervalMs: 1_000, timers, send: (value) => sent.push(value) });
    throttle.push('a');
    throttle.push('b');
    throttle.push('a');
    timers.advance(1_000);
    expect(sent).toEqual(['a']);
    throttle.push('c');
    timers.advance(500);
    throttle.push('d');
    throttle.cancel();
    timers.advance(5_000);
    expect(sent).toEqual(['a', 'c']);
  });

  it('real path: a fake-claude turn streams `activity` at most once per interval, ends with null, and `Session.activity` stays current', async () => {
    world = await makeSupervisorWorld({ scenario: 'tool-use' });
    const w = world;
    const seen: Array<{ at: number; sessionId: string; activity: SessionActivity | null }> = [];
    w.supervisor.on('activity', (payload) => seen.push({ at: Date.now(), ...payload }));
    const session = await w.supervisor.start(newSession(), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    expect(w.supervisor.activity(session.id)).toBeNull();
    // The whole turn arrives in a burst: one leading value, then the trailing one (idle) about a second later.
    const deadline = Date.now() + 5_000;
    while (seen.at(-1)?.activity !== null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((s) => s.sessionId === session.id)).toBe(true);
    expect(seen[0]?.activity?.state).toBe('thinking');
    expect(seen.at(-1)?.activity).toBeNull();
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]!.at - seen[i - 1]!.at).toBeGreaterThanOrEqual(950);
  });
});
