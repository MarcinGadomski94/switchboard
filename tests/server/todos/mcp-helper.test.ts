import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_MCP_INSTRUCTIONS, AGENT_TOKEN_ENV, TODO_TOOLS } from '../../../src/core/todos.ts';
import { type AgentApi, type ApiAnswer, callTool, handleMessage, serve } from '../../../src/hook/sb-mcp.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { generateToken } from '../../../src/server/token.ts';
import { REPO_ROOT, freeTestPorts, makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D68 oracle: the `switchboard` MCP helper (`src/hook/sb-mcp.ts`): its MCP
 * handshake and tools against a stand-in API, and the real script over stdio
 * against a listening Switchboard (a test port), scoped by the agent token.
 */

function stubApi(answers: Record<string, ApiAnswer>, calls: Array<[string, string, unknown]> = []): AgentApi {
  return async (method, route, body) => {
    calls.push([method, route, body]);
    return answers[`${method} ${route}`] ?? { status: 404, body: { error: 'not-found', message: `no todo in this session` } };
  };
}

const LIST = {
  sessionId: 's1',
  openCount: 1,
  doneCount: 1,
  todos: [
    { id: 'aaa111', sessionId: 's1', title: 'Fix the login test', text: 'Fix the login test', description: 'Retries hide a race.', plan: '1. Find the race\n2. Fix it', priority: 'high', estimateMinutes: 45, state: 'open', addedBy: 'developer', position: 0, createdAt: '', updatedAt: '', doneAt: null, removeAt: null },
    { id: 'bbb222', sessionId: 's1', title: 'Write docs', text: 'Write docs', description: null, plan: 'No plan', priority: 'medium', estimateMinutes: null, state: 'done', addedBy: 'agent', position: 1, createdAt: '', updatedAt: '', doneAt: 'x', removeAt: 'y' },
  ],
};

describe('MCP messages', () => {
  it('initialize answers the asked version (else the newest), tools, and serverInfo switchboard; notifications get no answer', async () => {
    const api = stubApi({});
    const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, api, '1.6.1');
    expect(init).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'switchboard', version: '1.6.1' } } });
    expect((await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, api))?.['result']).toMatchObject({ protocolVersion: '2025-06-18' });
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, api)).toBeNull();
    expect(await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, api)).toEqual({ jsonrpc: '2.0', id: 3, result: { tools: TODO_TOOLS } });
    expect(TODO_TOOLS.map((tool) => tool.name)).toEqual(['todo_list', 'todo_get', 'todo_add', 'todo_update', 'todo_done', 'todo_remove']);
    // All four MCP behavior hints are declared (as booleans) on every tool, and a title.
    for (const tool of TODO_TOOLS) {
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) expect(typeof tool.annotations[hint]).toBe('boolean');
      expect(tool.annotations.title).not.toBe('');
      expect(tool.annotations.openWorldHint).toBe(false);
    }
    expect(TODO_TOOLS.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual(['todo_list', 'todo_get']);
    expect(TODO_TOOLS.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name)).toEqual(['todo_update', 'todo_remove']);
    // D69: the instructions explain the fields and that the agent fills them; D70: the plan's "No plan: <reason>", the priority levels, the estimate, revising.
    const instructions = String((init?.['result'] as Record<string, unknown>)['instructions']);
    expect(instructions).toBe(AGENT_MCP_INSTRUCTIONS);
    for (const words of ['title', 'description', 'plan', 'without this conversation', 'acceptance criteria', 'fill all of them', 'todo_get', 'No plan: <reason>', 'urgent = blocking', 'low = nice-to-have', 'minutes an AI agent', 'revise the priority and estimate']) expect(instructions).toContain(words);
    expect(await handleMessage({ jsonrpc: '2.0', id: 4, method: 'ping' }, api)).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
    expect(await handleMessage({ jsonrpc: '2.0', id: 5, method: 'nope' }, api)).toMatchObject({ error: { code: -32601 } });
  });

  it('D69 / D70: every tool and every field has a description; add requires plan, priority and estimate; update revises them; list stays compact', () => {
    for (const tool of TODO_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      const properties = (tool.inputSchema['properties'] ?? {}) as Record<string, { description?: string }>;
      for (const [name, property] of Object.entries(properties)) expect(property.description, `${tool.name}.${name}`).toBeTruthy();
    }
    const byName = new Map(TODO_TOOLS.map((tool) => [tool.name, tool]));
    const add = byName.get('todo_add')!;
    // D70: the agent's tool requires the plan, a priority and an estimate (the server still accepts older callers without).
    expect(add.inputSchema).toMatchObject({ required: ['title', 'plan', 'priority', 'estimate_minutes'], additionalProperties: false });
    expect(Object.keys(add.inputSchema['properties'] as object)).toEqual(['title', 'description', 'plan', 'priority', 'estimate_minutes']);
    expect(add.description).toContain('No plan: <reason>');
    const update = byName.get('todo_update')!;
    expect(update.inputSchema).toMatchObject({ required: ['id'] });
    expect(Object.keys(update.inputSchema['properties'] as object)).toEqual(['id', 'title', 'description', 'plan', 'priority', 'estimate_minutes']);
    expect(update.description).toContain('cannot be emptied');
    const props = add.inputSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['priority']).toMatchObject({ type: 'string', enum: ['urgent', 'high', 'medium', 'low'] });
    for (const words of ['urgent = blocking', 'production down', 'data loss', 'high = important', 'medium = a normal task', 'low = nice-to-have', 'todo_update']) expect(String(props['priority']!['description'])).toContain(words);
    expect(props['estimate_minutes']).toMatchObject({ type: 'integer', minimum: 1, maximum: 10_080 });
    for (const words of ['minutes', 'AI agent', 'development time', 'Rough is fine']) expect(String(props['estimate_minutes']!['description'])).toContain(words);
    expect(String(props['plan']!['description'])).toContain('Required');
    expect(String(props['plan']!['description'])).toContain('No plan: <one-line reason>');
    expect(byName.get('todo_get')!.inputSchema).toMatchObject({ required: ['id'] });
    const plan = (add.inputSchema['properties'] as Record<string, { description: string }>)['plan']!.description;
    for (const words of ['AI agent', 'WITHOUT this conversation', 'relevant files', 'steps', 'acceptance criteria']) expect(plan).toContain(words);
    expect((add.inputSchema['properties'] as Record<string, { description: string }>)['description']!.description).toContain('For the developer');
    expect(byName.get('todo_list')!.description).toContain('not their text');
  });

  it('each tool calls the agent route it should and prints the list', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const api = stubApi(
      {
        'GET /agent/v1/todos': { status: 200, body: LIST },
        'POST /agent/v1/todos': { status: 201, body: { todo: LIST.todos[0], list: LIST } },
        'PUT /agent/v1/todos/aaa111': { status: 200, body: { todo: { ...LIST.todos[0], state: 'done' }, list: LIST } },
        'GET /agent/v1/todos/aaa111': { status: 200, body: LIST.todos[0] },
        'DELETE /agent/v1/todos/aaa111': { status: 200, body: LIST },
      },
      calls,
    );
    const list = await callTool(api, 'todo_list', {});
    expect(list.isError).toBeUndefined();
    // D69: compact: the title and which notes exist, never their text; D70: the priority and estimate (`~?` = none); No plan is not a plan.
    expect(list.content[0]?.text).toBe(
      'Open (1):\n[aaa111] ☐ HIGH ~45m Fix the login test (added by the developer) · has description, plan\nDone (1, removed an hour after done):\n[bbb222] ☑ MEDIUM ~? Write docs\n(todo_get shows an item\'s description and plan.)',
    );
    expect(list.content[0]?.text).not.toContain('Retries hide');
    expect((await callTool(api, 'todo_get', { id: 'aaa111' })).content[0]?.text).toBe(
      '[aaa111] ☐ open · added by the developer\nTitle: Fix the login test\nPriority: High\nEstimate: ~45m (45 minutes for an AI agent)\n\nDescription:\nRetries hide a race.\n\nPlan:\n1. Find the race\n2. Fix it',
    );
    expect((await callTool(api, 'todo_add', { title: 'Fix the login test', description: 'Retries hide a race.', plan: '1. Find the race', priority: 'high', estimate_minutes: 45 })).content[0]?.text).toMatch(/^Added \[aaa111\]/);
    await callTool(api, 'todo_add', { text: 'Old-style text', plan: 'No plan: a one-line rename', priority: 'low', estimate_minutes: 5 });
    // D70: the tool requires a plan, a priority and an estimate: the helper says what is missing and sends nothing.
    const missing = await callTool(api, 'todo_add', { title: 'No sizing' });
    expect(missing.isError).toBe(true);
    for (const words of ['a plan', 'No plan: <one-line reason>', 'a priority', 'estimate_minutes']) expect(missing.content[0]?.text).toContain(words);
    expect((await callTool(api, 'todo_add', { title: 'Bad', plan: 'p', priority: 'asap', estimate_minutes: 1.5 })).content[0]?.text).toMatch(/priority.*estimate_minutes/);
    expect((await callTool(api, 'todo_done', { id: '[aaa111]' })).content[0]?.text).toMatch(/^Done: \[aaa111\] ☑/);
    await callTool(api, 'todo_done', { id: 'aaa111', done: false });
    await callTool(api, 'todo_update', { id: 'aaa111', title: 'Fix both login tests', plan: '' });
    await callTool(api, 'todo_update', { id: 'aaa111', priority: 'urgent', estimate_minutes: 90 });
    expect((await callTool(api, 'todo_remove', { id: 'aaa111' })).content[0]?.text).toMatch(/^Removed\./);
    expect(calls).toEqual([
      ['GET', '/agent/v1/todos', undefined],
      ['GET', '/agent/v1/todos/aaa111', undefined],
      ['POST', '/agent/v1/todos', { title: 'Fix the login test', description: 'Retries hide a race.', plan: '1. Find the race', priority: 'high', estimateMinutes: 45 }],
      ['POST', '/agent/v1/todos', { title: 'Old-style text', plan: 'No plan: a one-line rename', priority: 'low', estimateMinutes: 5 }],
      ['PUT', '/agent/v1/todos/aaa111', { state: 'done' }],
      ['PUT', '/agent/v1/todos/aaa111', { state: 'open' }],
      ['PUT', '/agent/v1/todos/aaa111', { title: 'Fix both login tests', plan: '' }],
      ['PUT', '/agent/v1/todos/aaa111', { priority: 'urgent', estimateMinutes: 90 }],
      ['DELETE', '/agent/v1/todos/aaa111', undefined],
    ]);
  });

  it('a refusal, a missing id or an unreachable Switchboard is a tool error, not a crash', async () => {
    const api = stubApi({});
    expect(await callTool(api, 'todo_done', { id: 'zzz' })).toEqual({ content: [{ type: 'text', text: 'no todo in this session' }], isError: true });
    expect((await callTool(api, 'todo_remove', {})).isError).toBe(true);
    expect((await callTool(api, 'todo_add', {})).isError).toBe(true);
    expect((await callTool(api, 'todo_update', { id: 'aaa111' })).isError).toBe(true);
    expect((await callTool(api, 'todo_get', {})).isError).toBe(true);
    expect((await callTool(api, 'todo_fly', {})).isError).toBe(true);
    const down: AgentApi = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:1');
    };
    expect((await callTool(down, 'todo_list', {})).content[0]?.text).toContain('could not be reached');
    expect((await callTool(stubApi({ 'GET /agent/v1/todos': { status: 401, body: { error: 'unauthorized' } } }), 'todo_list', {})).content[0]?.text).toContain('token does not match');
  });

  it('serve answers line by line in order and a bad line with a parse error', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => lines.push(...chunk.toString('utf8').split('\n').filter(Boolean)));
    const done = serve(stubApi({ 'GET /agent/v1/todos': { status: 200, body: LIST } }), input, output);
    input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"todo_list","arguments":{}}}\n{oops}\n');
    input.end('{"jsonrpc":"2.0","id":2,"method":"ping"}');
    await done;
    const parsed = lines.map((line) => JSON.parse(line) as { id: unknown; error?: { code: number } });
    expect(parsed.map((m) => m.id)).toEqual([null, 1, 2]);
    expect(parsed[0]?.error?.code).toBe(-32700);
  });
});

describe('the real helper over stdio against a listening Switchboard', () => {
  let tmp: string | undefined;
  let store: Store | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    await store?.close();
    if (tmp) await removeTempDir(tmp);
    app = undefined;
    store = undefined;
    tmp = undefined;
  });

  async function run(port: number, sessionId: string, token: string, requests: readonly object[]): Promise<Array<Record<string, unknown>>> {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'src', 'hook', 'sb-mcp.ts'), '--switchboard-mcp', String(port), sessionId], {
      env: { PATH: process.env['PATH'] ?? '', [AGENT_TOKEN_ENV]: token },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
    expect(code).toBe(0);
    return out.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("adds and lists through the session's own token; another session's token is refused", async () => {
    tmp = await makeTempDir('mcp-helper');
    store = await openTempStore(tmp);
    const secret = generateToken();
    // Another test file may take a test port meanwhile: try the free ones from the end of the range.
    let port = 0;
    for (const candidate of (await freeTestPorts()).reverse()) {
      const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: candidate };
      const built = await buildApp({ config, token: secret, store, webRoot: tmp });
      try {
        await built.listen({ host: '127.0.0.1', port: candidate });
        app = built;
        port = candidate;
        break;
      } catch {
        await built.close();
      }
    }
    if (port === 0) throw new Error('no free test port');
    const a = (await store.sessions.create({ name: 'a', claudeSessionId: randomUUID() })).id;
    const b = (await store.sessions.create({ name: 'b', claudeSessionId: randomUUID() })).id;

    const answers = await run(port, a, agentTokenFor(secret, a), [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'todo_add', arguments: { title: 'Check the migration', description: 'Make sure 0027 keeps the rows.', plan: 'Run the migration test.', priority: 'high', estimate_minutes: 20 } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'todo_list', arguments: {} } },
    ]);
    expect(answers.map((m) => m['id'])).toEqual([1, 2, 3]);
    const listText = ((answers[2]?.['result'] as { content: Array<{ text: string }> }).content[0] as { text: string }).text;
    expect(listText).toMatch(/^Open \(1\):\n\[[0-9a-f]{12}\] ☐ HIGH ~20m Check the migration · has description, plan\n/);
    expect((await store.todos.list(a)).map((t) => [t.title, t.description, t.plan, t.priority, t.estimateMinutes, t.addedBy])).toEqual([['Check the migration', 'Make sure 0027 keeps the rows.', 'Run the migration test.', 'high', 20, 'agent']]);
    // D69: todo_get through the real helper and route.
    const itemId = (await store.todos.list(a))[0]!.id;
    const got = await run(port, a, agentTokenFor(secret, a), [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'todo_get', arguments: { id: itemId } } }]);
    expect(((got[0]?.['result'] as { content: Array<{ text: string }> }).content[0] as { text: string }).text).toContain('Plan:\nRun the migration test.');

    // Session A's token, presented as session B: refused, nothing written.
    const refused = await run(port, b, agentTokenFor(secret, a), [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'todo_add', arguments: { text: 'sneaky', plan: 'No plan: test', priority: 'low', estimate_minutes: 1 } } }]);
    expect(refused[0]?.['result']).toMatchObject({ isError: true });
    expect(await store.todos.list(b)).toEqual([]);
  });
});
