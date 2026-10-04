import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_TOKEN_ENV, TODO_TOOLS } from '../../../src/core/todos.ts';
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
    { id: 'aaa111', sessionId: 's1', text: 'Fix the login test', state: 'open', addedBy: 'developer', position: 0, createdAt: '', updatedAt: '', doneAt: null, removeAt: null },
    { id: 'bbb222', sessionId: 's1', text: 'Write docs', state: 'done', addedBy: 'agent', position: 1, createdAt: '', updatedAt: '', doneAt: 'x', removeAt: 'y' },
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
    expect(TODO_TOOLS.map((tool) => tool.name)).toEqual(['todo_list', 'todo_add', 'todo_update', 'todo_done', 'todo_remove']);
    expect(await handleMessage({ jsonrpc: '2.0', id: 4, method: 'ping' }, api)).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
    expect(await handleMessage({ jsonrpc: '2.0', id: 5, method: 'nope' }, api)).toMatchObject({ error: { code: -32601 } });
  });

  it('each tool calls the agent route it should and prints the list', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const api = stubApi(
      {
        'GET /agent/v1/todos': { status: 200, body: LIST },
        'POST /agent/v1/todos': { status: 201, body: { todo: LIST.todos[0], list: LIST } },
        'PUT /agent/v1/todos/aaa111': { status: 200, body: { todo: { ...LIST.todos[0], state: 'done' }, list: LIST } },
        'DELETE /agent/v1/todos/aaa111': { status: 200, body: LIST },
      },
      calls,
    );
    const list = await callTool(api, 'todo_list', {});
    expect(list.isError).toBeUndefined();
    expect(list.content[0]?.text).toBe('Open (1):\n[aaa111] ☐ Fix the login test (added by the developer)\nDone (1, removed an hour after done):\n[bbb222] ☑ Write docs');
    expect((await callTool(api, 'todo_add', { text: 'Fix the login test' })).content[0]?.text).toMatch(/^Added \[aaa111\]/);
    expect((await callTool(api, 'todo_done', { id: '[aaa111]' })).content[0]?.text).toMatch(/^Done: \[aaa111\] ☑/);
    await callTool(api, 'todo_done', { id: 'aaa111', done: false });
    await callTool(api, 'todo_update', { id: 'aaa111', text: 'Fix both login tests' });
    expect((await callTool(api, 'todo_remove', { id: 'aaa111' })).content[0]?.text).toMatch(/^Removed\./);
    expect(calls).toEqual([
      ['GET', '/agent/v1/todos', undefined],
      ['POST', '/agent/v1/todos', { text: 'Fix the login test' }],
      ['PUT', '/agent/v1/todos/aaa111', { state: 'done' }],
      ['PUT', '/agent/v1/todos/aaa111', { state: 'open' }],
      ['PUT', '/agent/v1/todos/aaa111', { text: 'Fix both login tests' }],
      ['DELETE', '/agent/v1/todos/aaa111', undefined],
    ]);
  });

  it('a refusal, a missing id or an unreachable Switchboard is a tool error, not a crash', async () => {
    const api = stubApi({});
    expect(await callTool(api, 'todo_done', { id: 'zzz' })).toEqual({ content: [{ type: 'text', text: 'no todo in this session' }], isError: true });
    expect((await callTool(api, 'todo_remove', {})).isError).toBe(true);
    expect((await callTool(api, 'todo_add', {})).isError).toBe(true);
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
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'todo_add', arguments: { text: 'Check the migration' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'todo_list', arguments: {} } },
    ]);
    expect(answers.map((m) => m['id'])).toEqual([1, 2, 3]);
    const listText = ((answers[2]?.['result'] as { content: Array<{ text: string }> }).content[0] as { text: string }).text;
    expect(listText).toMatch(/^Open \(1\):\n\[[0-9a-f]{12}\] ☐ Check the migration$/);
    expect((await store.todos.list(a)).map((t) => [t.text, t.addedBy])).toEqual([['Check the migration', 'agent']]);

    // Session A's token, presented as session B: refused, nothing written.
    const refused = await run(port, b, agentTokenFor(secret, a), [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'todo_add', arguments: { text: 'sneaky' } } }]);
    expect(refused[0]?.['result']).toMatchObject({ isError: true });
    expect(await store.todos.list(b)).toEqual([]);
  });
});
