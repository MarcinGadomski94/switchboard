import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_TOOLS } from '../../../src/core/memory.ts';
import { PLAN_TOOLS } from '../../../src/core/plans.ts';
import { PLAN_PROPOSE_TOOL } from '../../../src/core/plans-jira.ts';
import { PLAN_JIRA_CONTEXT_TOOL } from '../../../src/core/plans-jira-context.ts';
import { TEAM_TOOLS } from '../../../src/core/team-tools.ts';
import { FeatureTools, ListedToolsTransport } from '../../../src/hook/sb-feature-tools.ts';
import { type AgentApi, type ApiAnswer, createTodoServer } from '../../../src/hook/sb-mcp.ts';
import { AgentToolsRegistry } from '../../../src/server/todos/agent-tools.ts';
import { until } from '../../helpers/supervisor.ts';

/**
 * 2026-10-16 oracle (`docs/mcp.md` → *Tools that appear without a restart*): the helper's
 * feature tools follow Switchboard while the MCP connection lives. Over the SDK's in-memory
 * transport, as a CLI that honours `list_changed` sees it: the tool list before and after a
 * session is adopted into Team, Project memory or Plans is switched on, a member is removed,
 * and a probe that timed out at start; each `tools/list` answer is reported; a call to a
 * tool that is off answers why. And the server side's wake-ups and reports.
 */

const TEAM = [...TEAM_TOOLS.map((tool) => tool.name), 'request_access'].sort();
const MEMORY = MEMORY_TOOLS.map((tool) => tool.name).sort();
const PLANS = [...PLAN_TOOLS.map((tool) => tool.name), PLAN_PROPOSE_TOOL.name, PLAN_JIRA_CONTEXT_TOOL.name].sort();

/** What the probe routes answer (the test flips them); `timeout` throws as an unanswered probe does. */
type Probe = 'on' | 'off' | 'timeout';

interface Rig {
  readonly probes: Record<'team' | 'plans' | 'memory', Probe>;
  readonly api: AgentApi;
  readonly features: FeatureTools;
  readonly reports: string[][];
  readonly notified: string[];
  list(): Promise<string[]>;
  call(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  close(): Promise<void>;
}

let open: Rig | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

const ROUTES: Record<string, 'team' | 'plans' | 'memory'> = { '/agent/v1/team': 'team', '/agent/v1/plans': 'plans', '/agent/v1/memory': 'memory' };
// D132: 2.0 answers only the team one (not a member); the plans / memory ones are what a 1.x Switchboard with the switch off answered.
const OFF_MESSAGES = { team: "this session is not a team member: the Team tools work only in a member's session", plans: 'Plans is off: switch it on in Settings → Experimental', memory: 'Project memory is off: switch it on in Settings → Experimental' };

/** A helper (the todo server + the feature tools) connected to a raw client over the in-memory transport, as `sb-mcp.ts` wires it. */
async function connect(initial: Partial<Record<'team' | 'plans' | 'memory', Probe>> = {}): Promise<Rig> {
  const probes = { team: 'off', plans: 'off', memory: 'off', ...initial } as Record<'team' | 'plans' | 'memory', Probe>;
  const reports: string[][] = [];
  const api: AgentApi = async (method, route, body): Promise<ApiAnswer> => {
    const feature = ROUTES[route];
    if (method === 'GET' && feature) {
      if (probes[feature] === 'timeout') throw new Error('Switchboard did not answer in time');
      return probes[feature] === 'on' ? { status: 200, body: {} } : { status: 404, body: { error: `${feature}-off`, message: OFF_MESSAGES[feature] } };
    }
    if (method === 'POST' && route === '/agent/v1/tools') {
      reports.push([...((body as { tools: string[] }).tools ?? [])].sort());
      return { status: 204, body: null };
    }
    if (method === 'GET' && route === '/agent/v1/team/members') return { status: 200, body: { text: 'Builder (you)' } };
    return { status: 404, body: { error: 'not-found', message: `no route ${route}` } };
  };
  const server = createTodoServer(api);
  const features = new FeatureTools(server, api);
  await features.refresh();
  const [client, inner] = InMemoryTransport.createLinkedPair();
  await server.connect(new ListedToolsTransport(inner, (tools) => void api('POST', '/agent/v1/tools', { tools }), (name) => features.unavailable(name)));
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  const notified: string[] = [];
  client.onmessage = (message: JSONRPCMessage) => {
    const answer = message as Record<string, unknown>;
    if (typeof answer['id'] === 'number') waiting.get(answer['id'])?.(answer);
    else if (typeof answer['method'] === 'string') notified.push(answer['method']);
  };
  await client.start();
  let next = 0;
  const rpc = (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    next += 1;
    const id = next;
    const answered = new Promise<Record<string, unknown>>((resolve) => waiting.set(id, resolve));
    void client.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) } as JSONRPCMessage);
    return answered;
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  const rig: Rig = {
    probes,
    api,
    features,
    reports,
    notified,
    list: async () => (((await rpc('tools/list'))['result'] as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)),
    call: async (name, args) => (await rpc('tools/call', { name, arguments: args }))['result'] as { content: Array<{ text: string }>; isError?: boolean },
    close: () => server.close(),
  };
  open = rig;
  return rig;
}

function only(names: readonly string[], set: readonly string[]): string[] {
  return names.filter((name) => set.includes(name)).sort();
}

describe('2026-10-16 · feature tools without a restart (the helper)', () => {
  it('a session started before it was adopted gets the Team tools with list_changed; the CLI\'s new list is reported', async () => {
    const r = await connect();
    const before = await r.list();
    expect(only(before, TEAM)).toEqual([]);
    expect(before).toContain('todo_list');
    expect(r.reports.at(-1)).toEqual([...before].sort());

    // Adopted into Team: the next probe answers 200.
    r.probes.team = 'on';
    expect(await r.features.refresh()).toBe(true);
    await until(async () => r.notified.includes('notifications/tools/list_changed') || undefined, 'list_changed');
    const after = await r.list();
    expect(only(after, TEAM)).toEqual(TEAM);
    expect(r.reports.at(-1)).toEqual([...after].sort());
    expect(r.features.active()).toEqual(['team']);
    // A second refresh with nothing new changes nothing.
    r.notified.length = 0;
    expect(await r.features.refresh()).toBe(false);
    expect(r.notified).toEqual([]);
    // And the tools work.
    expect((await r.call('team_members', {})).content[0]?.text).toBe('Builder (you)');
  });

  it.each([
    ['Project memory', 'memory', MEMORY],
    ['Plans', 'plans', PLANS],
  ] as const)('%s switched on after the session started: its tools appear with list_changed', async (_label, feature, tools) => {
    const r = await connect();
    expect(only(await r.list(), tools)).toEqual([]);
    r.probes[feature] = 'on';
    expect(await r.features.refresh()).toBe(true);
    await until(async () => r.notified.includes('notifications/tools/list_changed') || undefined, 'list_changed');
    expect(only(await r.list(), tools)).toEqual([...tools]);
    expect(r.features.active()).toEqual([feature]);
  });

  it('a removed member loses the Team tools; a call that still comes is answered with why, not "not found"', async () => {
    const r = await connect({ team: 'on' });
    expect(only(await r.list(), TEAM)).toEqual(TEAM);
    r.probes.team = 'off';
    expect(await r.features.refresh()).toBe(true);
    await until(async () => r.notified.includes('notifications/tools/list_changed') || undefined, 'list_changed');
    const after = await r.list();
    expect(only(after, TEAM)).toEqual([]);
    expect(after).toContain('todo_list');
    // A CLI that has not re-listed may still call one: a tool error that says why and what to do.
    const answer = await r.call('team_propose_charter', { owns: 'x', produces: 'y', neverDoes: 'z' });
    expect(answer.isError).toBe(true);
    expect(answer.content[0]?.text).toBe(
      "team_propose_charter is not available in this session: this session is not a team member: the Team tools work only in a member's session. The Team tools appear here by themselves once this session gets them (no restart needed); do not retry until then.",
    );
    // Any other unknown tool is the SDK's own answer.
    expect(r.features.unavailable('todo_list')).toBeNull();
  });

  it('a probe that timed out at start is retried: the tools come with the next check', async () => {
    const r = await connect({ team: 'timeout', memory: 'timeout' });
    expect(only(await r.list(), [...TEAM, ...MEMORY])).toEqual([]);
    // Still no answer: nothing changes (and nothing is removed on a failed probe).
    expect(await r.features.refresh()).toBe(false);
    r.probes.team = 'on';
    r.probes.memory = 'on';
    expect(await r.features.refresh()).toBe(true);
    await until(async () => r.notified.includes('notifications/tools/list_changed') || undefined, 'list_changed');
    expect(only(await r.list(), [...TEAM, ...MEMORY])).toEqual([...TEAM, ...MEMORY].sort());
    // A probe that times out later keeps the tools it has.
    r.probes.team = 'timeout';
    expect(await r.features.refresh()).toBe(false);
    expect(r.features.active()).toEqual(['team', 'memory']);
  });

  it('watch: each wake-up (or the periodic answer) makes the helper probe again; it stops when told', async () => {
    const r = await connect();
    const registry = new AgentToolsRegistry();
    const watchApi: AgentApi = async (method, route) => {
      const since = Number(new URL(route, 'http://x').searchParams.get('since'));
      return { status: 200, body: await registry.watch('s1', since, 200) };
    };
    const stop = new AbortController();
    const watching = r.features.watch(watchApi, stop.signal, 50);
    r.probes.plans = 'on';
    registry.nudge('s1');
    await until(async () => r.features.active().includes('plans') || undefined, 'plans after the wake-up');
    // No wake-up: the periodic answer (here 200 ms) still re-probes.
    r.probes.memory = 'on';
    await until(async () => r.features.active().includes('memory') || undefined, 'memory at the periodic check');
    stop.abort();
    registry.close();
    await watching;
  });
});

describe('2026-10-16 · the reports and wake-ups (the server)', () => {
  it('watch answers at once for a wake-up it missed, else at the next one meant for its session (or every session), else after the wait', async () => {
    const registry = new AgentToolsRegistry();
    expect(await registry.watch('a', 0, 20)).toEqual({ generation: 0, nudged: false });
    registry.nudge('a');
    expect(await registry.watch('a', 0, 20)).toEqual({ generation: 1, nudged: true });
    // b was not meant.
    expect(await registry.watch('b', 0, 20)).toEqual({ generation: 1, nudged: false });
    const waiting = registry.watch('b', 1, 5_000);
    registry.nudge('a');
    registry.nudge();
    expect(await waiting).toEqual({ generation: 3, nudged: true });
    // Closing answers every held watch.
    const held = registry.watch('a', 3, 5_000);
    registry.close();
    expect((await held).nudged).toBe(false);
  });

  it('waitForTool resolves with the report that lists the tool; forget drops a process\'s report', async () => {
    const registry = new AgentToolsRegistry();
    expect(registry.listed('s')).toBeNull();
    registry.report('s', ['todo_list']);
    expect(await registry.waitForTool('s', 'team_report', 20)).toBe(false);
    const waiting = registry.waitForTool('s', 'team_report', 5_000);
    registry.report('s', ['todo_list', 'memory_list']);
    registry.report('s', ['todo_list', 'team_report']);
    expect(await waiting).toBe(true);
    expect([...(registry.listed('s')?.tools ?? [])]).toEqual(['todo_list', 'team_report']);
    registry.forget('s');
    expect(registry.listed('s')).toBeNull();
  });
});
