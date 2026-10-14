import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_PROPOSE_PER_HOUR, MEMORY_TOOLS, type MemoryEntry, type MemoryScope, type MemoryState } from '../../../src/core/memory.ts';
import { type AgentApi, createTodoServer } from '../../../src/hook/sb-mcp.ts';
import { memoryList, memoryPropose, registerMemoryToolsIfOn } from '../../../src/hook/sb-memory-tools.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { DEVICE_ALLOWED, DEVICE_REFUSED, isLocalOnly, matchesRule } from '../../../src/server/devices/local-only.ts';
import { MEMORY_DB_FILE } from '../../../src/server/memory/db.ts';
import { memoryServiceOf } from '../../../src/server/memory/install.ts';
import { MEMORY_PROPOSALS_ITEM } from '../../../src/server/memory/service.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D107 · Project memory over the real app (`inject`): off by default (no `memory.db`, 404
 * `memory-off`, no MCP memory tools), switched on through `PUT /api/settings`; the agent's
 * proposal (its own token) lands in the review queue and an Inbox item, never in the agent's
 * list until approved; edit-then-approve stores the edit; reject; the rate limit and the duplicate
 * check; a broken `memory.db`; the routes' classification for devices and paired machines.
 */

const PORT = 4947; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

interface Rig {
  readonly root: string;
  readonly dataDir: string;
  readonly workspace: string;
  readonly store: Store;
  readonly app: FastifyInstance;
  readonly token: string;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.app.close();
  await rig?.store.close();
  if (rig) await removeTempDir(rig.root);
  rig = undefined;
});

async function setup(before?: (dataDir: string) => Promise<void>): Promise<Rig> {
  const root = await makeTempDir('memory-switch');
  const dataDir = path.join(root, 'data');
  const store = await openTempStore(dataDir);
  await before?.(dataDir);
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: dataDir }, platform: 'linux', home: root, cwd: root }), port: PORT };
  const token = generateToken();
  const app = await buildApp({ config, token, store, webRoot: root, agentTools: false });
  await app.ready();
  rig = { root, dataDir, workspace: path.join(root, 'acme-workspace'), store, app, token };
  return rig;
}

function ui(r: Rig, method: InjectOptions['method'], url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  return r.app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${r.token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

function helperApi(r: Rig, sessionId: string): AgentApi {
  return async (method, url, body) => {
    const answer = await r.app.inject({
      method,
      url,
      headers: { host: HOST, 'x-switchboard-session': sessionId, authorization: `Bearer ${agentTokenFor(r.token, sessionId)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return { status: answer.statusCode, body: answer.body ? (answer.json() as unknown) : null };
  };
}

async function toolsOf(api: AgentApi): Promise<string[]> {
  const server = createTodoServer(api);
  await registerMemoryToolsIfOn(server, api);
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  const answered = new Promise<Record<string, unknown>>((resolve) => {
    client.onmessage = (message: JSONRPCMessage) => {
      const answer = message as Record<string, unknown>;
      if (answer['id'] === 1) resolve(answer);
    };
  });
  await client.start();
  await client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' } as JSONRPCMessage);
  const result = (await answered)['result'] as { tools: Array<{ name: string }> };
  await server.close();
  return result.tools.map((tool) => tool.name);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function agentSession(r: Rig, name = 'agent', kind: 'session' | 'chat' = 'session'): Promise<string> {
  return (await r.store.sessions.create({ name, claudeSessionId: `c-${name}`, attached: true, title: `Acme ${name}`, root: r.workspace, rootKind: 'workspace', cwd: r.workspace, ...(kind === 'chat' ? { kind } : {}) })).id;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? '').join('');
}

describe('D107 · the Project memory switch', () => {
  it('off by default: only the state answers, no memory.db, no memory tools, nothing for the agent', async () => {
    const r = await setup();
    expect((await ui(r, 'GET', '/api/settings')).json()['experimental.memory']).toBe(false);
    expect((await ui(r, 'GET', '/api/memory/state')).json()).toEqual<MemoryState>({ enabled: false, available: false, problem: null });
    for (const [method, url] of [
      ['GET', '/api/memory/scopes'],
      ['GET', '/api/memory/entries'],
      ['POST', '/api/memory/entries'],
      ['POST', '/api/memory/entries/abc/approve'],
      ['GET', '/api/memory/settings'],
    ] as const) {
      const answer = await ui(r, method, url, method === 'POST' ? {} : undefined);
      expect([method, url, answer.statusCode, answer.json().error]).toEqual([method, url, 404, 'memory-off']);
    }
    expect(await exists(path.join(r.dataDir, MEMORY_DB_FILE))).toBe(false);
    expect(memoryServiceOf(r.app)?.activeTimers()).toBe(0);
    const sessionId = await agentSession(r);
    expect((await helperApi(r, sessionId)('GET', '/agent/v1/memory')).status).toBe(404);
    expect((await helperApi(r, sessionId)('POST', '/agent/v1/memory', { title: 'Build', text: 'npm ci' })).status).toBe(404);
    expect((await toolsOf(helperApi(r, sessionId))).filter((name) => name.startsWith('memory_'))).toEqual([]);
  });

  it('on: memory.db appears and the tools are registered (not for a chat); off again: they go', async () => {
    const r = await setup();
    expect((await ui(r, 'PUT', '/api/settings', { 'experimental.memory': true })).statusCode).toBe(200);
    expect((await ui(r, 'GET', '/api/memory/state')).json()).toEqual<MemoryState>({ enabled: true, available: true, problem: null });
    expect(await exists(path.join(r.dataDir, MEMORY_DB_FILE))).toBe(true);
    const sessionId = await agentSession(r);
    expect((await toolsOf(helperApi(r, sessionId))).filter((name) => name.startsWith('memory_'))).toEqual(MEMORY_TOOLS.map((tool) => tool.name));
    const chatId = await agentSession(r, 'chat', 'chat');
    expect((await toolsOf(helperApi(r, chatId))).filter((name) => name.startsWith('memory_'))).toEqual([]);

    expect((await ui(r, 'PUT', '/api/settings', { 'experimental.memory': false })).statusCode).toBe(200);
    expect((await ui(r, 'GET', '/api/memory/entries')).statusCode).toBe(404);
    expect((await toolsOf(helperApi(r, sessionId))).filter((name) => name.startsWith('memory_'))).toEqual([]);
    expect(await exists(path.join(r.dataDir, MEMORY_DB_FILE))).toBe(true);
  });

  it('a broken memory.db: the memory routes answer 503, everything else works', async () => {
    const r = await setup(async (dataDir) => {
      await writeFile(path.join(dataDir, MEMORY_DB_FILE), 'not a database, Acme notes\n'.repeat(200));
    });
    expect((await ui(r, 'PUT', '/api/settings', { 'experimental.memory': true })).statusCode).toBe(200);
    const state = (await ui(r, 'GET', '/api/memory/state')).json() as MemoryState;
    expect(state).toMatchObject({ enabled: true, available: false });
    expect(state.problem).toMatch(/^memory\.db could not be opened: /);
    const list = await ui(r, 'GET', '/api/memory/entries');
    expect([list.statusCode, list.json().error]).toEqual([503, 'memory-unavailable']);
    expect((await ui(r, 'GET', '/api/sessions')).statusCode).toBe(200);
    const sessionId = await agentSession(r);
    expect((await toolsOf(helperApi(r, sessionId))).filter((name) => name.startsWith('memory_'))).toEqual([]);
  });
});

describe('D107 · the review gate over the routes', () => {
  it('a proposal is queued (never listed to agents), raises one Inbox item per folder, and edit-then-approve stores the edit', async () => {
    const r = await setup();
    await ui(r, 'PUT', '/api/settings', { 'experimental.memory': true });
    const sessionId = await agentSession(r);
    const api = helperApi(r, sessionId);

    const proposed = await memoryPropose(api, { title: 'Run the tests with the test ports', text: 'SWITCHBOARD_TEST_PORTS=4900-4909 npx vitest run <file>', tags: ['Tests'] });
    expect(proposed.isError).toBeUndefined();
    expect(text(proposed)).toMatch(/^Proposed "Run the tests with the test ports" \[[0-9a-f]{10}\]/);
    await memoryPropose(api, { title: 'Where the migrations live', text: 'src/server/db/migrations; never edit an applied one.' });

    // Not listed to the agent while proposed.
    expect(text(await memoryList(api))).toMatch(/^No approved project memory for acme-workspace yet/);
    const entries = (await ui(r, 'GET', `/api/memory/entries?scope=${encodeURIComponent(r.workspace)}`)).json() as MemoryEntry[];
    expect(entries.map((entry) => [entry.title, entry.status, entry.authorKind, entry.authorSessionId, entry.authorLabel, entry.tags])).toEqual([
      ['Run the tests with the test ports', 'proposed', 'agent', sessionId, 'Acme agent', ['tests']],
      ['Where the migrations live', 'proposed', 'agent', sessionId, 'Acme agent', []],
    ]);
    const scopes = (await ui(r, 'GET', '/api/memory/scopes')).json() as MemoryScope[];
    expect(scopes).toEqual([{ scope: r.workspace, label: 'acme-workspace', saved: false, approved: 0, proposed: 2 }]);

    // One Inbox item for the folder, its count in the title.
    const items = async () => (await r.store.systemItems.list(['open'])).filter((item) => item.kind === MEMORY_PROPOSALS_ITEM);
    expect((await items()).map((item) => [item.title, item.actions.map((action) => action.label)])).toEqual([['2 memory proposals for acme-workspace', ['Review', 'Dismiss']]]);
    const inbox = (await ui(r, 'GET', '/api/inbox')).json() as Array<{ kind: string; label: string; title: string; route?: string }>;
    expect(inbox.find((item) => item.label === 'Memory')).toMatchObject({ kind: 'system', title: '2 memory proposals for acme-workspace', route: `/memory?scope=${encodeURIComponent(r.workspace)}` });

    // Edit… then approve: the edited text is the approved one; the agent's words are kept as the record.
    const [first, second] = entries as [MemoryEntry, MemoryEntry];
    const approved = (await ui(r, 'POST', `/api/memory/entries/${first.id}/approve`, { text: 'SWITCHBOARD_TEST_PORTS=4900-4909, port-hungry files one by one.' })).json() as MemoryEntry;
    expect(approved).toMatchObject({ status: 'approved', text: 'SWITCHBOARD_TEST_PORTS=4900-4909, port-hungry files one by one.', decidedBy: 'developer', proposedText: 'SWITCHBOARD_TEST_PORTS=4900-4909 npx vitest run <file>' });
    expect((await items()).map((item) => item.title)).toEqual(['1 memory proposal for acme-workspace']);
    const listed = text(await memoryList(api));
    expect(listed).toContain('SWITCHBOARD_TEST_PORTS=4900-4909, port-hungry files one by one.');
    expect(listed).not.toContain('npx vitest run <file>');
    expect(listed).not.toContain('Where the migrations live');

    // Reject: the queue empties, the item closes, the entry never lists.
    expect((await ui(r, 'POST', `/api/memory/entries/${second.id}/reject`, {})).json()).toMatchObject({ status: 'rejected' });
    expect(await items()).toEqual([]);
    expect(text(await memoryList(api))).not.toContain('Where the migrations live');
    // Approving it twice is refused; rejecting an approved entry too.
    expect((await ui(r, 'POST', `/api/memory/entries/${first.id}/approve`, {})).statusCode).toBe(409);
    expect((await ui(r, 'POST', `/api/memory/entries/${first.id}/reject`, {})).statusCode).toBe(409);

    // Pin, edit, delete; the developer's own entry is approved at once.
    const mine = await ui(r, 'POST', '/api/memory/entries', { scope: r.workspace, title: 'Acme release notes', text: 'Two lines, no version bump.', pinned: true });
    expect(mine.statusCode).toBe(201);
    expect(mine.json()).toMatchObject({ status: 'approved', authorKind: 'developer', pinned: true });
    expect((await ui(r, 'PUT', `/api/memory/entries/${first.id}`, { pinned: true })).json()).toMatchObject({ pinned: true });
    expect((await ui(r, 'DELETE', `/api/memory/entries/${(mine.json() as MemoryEntry).id}`)).statusCode).toBe(204);
    expect(((await ui(r, 'GET', '/api/memory/entries?status=approved')).json() as MemoryEntry[]).map((entry) => entry.title)).toEqual(['Run the tests with the test ports']);
  });

  it(`rate limit (${MEMORY_PROPOSE_PER_HOUR} per hour per session) and near-identical titles`, async () => {
    const r = await setup();
    await ui(r, 'PUT', '/api/settings', { 'experimental.memory': true });
    const sessionId = await agentSession(r);
    const api = helperApi(r, sessionId);
    expect((await api('POST', '/agent/v1/memory', { title: 'Build command', text: 'npm run build' })).status).toBe(201);
    for (const twin of ['Build commands', 'build-command', 'BUILD COMMAND!']) {
      const answer = await api('POST', '/agent/v1/memory', { title: twin, text: 'npm run build again' });
      expect([twin, answer.status, (answer.body as { error: string }).error]).toEqual([twin, 409, 'duplicate']);
    }
    for (let i = 1; i < MEMORY_PROPOSE_PER_HOUR; i++) expect((await api('POST', '/agent/v1/memory', { title: `Acme fact number ${i} about area ${'xyz'.repeat(i)}`, text: 'a fact' })).status).toBe(201);
    const limited = await api('POST', '/agent/v1/memory', { title: 'One more distinct Acme fact', text: 'too many' });
    expect([limited.status, (limited.body as { error: string }).error]).toEqual([429, 'rate-limited']);
    // Another session of the folder is not limited by this one's proposals.
    const other = await agentSession(r, 'other');
    expect((await helperApi(r, other)('POST', '/agent/v1/memory', { title: 'One more distinct Acme fact', text: 'fine' })).status).toBe(201);
    // Too long is refused with the field.
    const long = await api('POST', '/agent/v1/memory', { title: 'x'.repeat(81), text: 'a' });
    expect(long.status).toBe(422);
  });
});

describe('D107 · route classification', () => {
  it('phones read and review (approve / reject / edit / pin); adding, deleting and the cap stay on the desktop; paired machines reach all of it', () => {
    const allowed: Array<[string, string]> = [
      ['GET', '/api/memory/state'],
      ['GET', '/api/memory/scopes'],
      ['GET', '/api/memory/entries'],
      ['GET', '/api/memory/settings'],
      ['PUT', '/api/memory/entries/abc'],
      ['POST', '/api/memory/entries/abc/approve'],
      ['POST', '/api/memory/entries/abc/reject'],
    ];
    const refused: Array<[string, string]> = [
      ['POST', '/api/memory/entries'],
      ['DELETE', '/api/memory/entries/abc'],
      ['PUT', '/api/memory/settings'],
    ];
    for (const [method, url] of allowed) {
      expect([method, url, isLocalOnly(method, url)]).toEqual([method, url, false]);
      expect(matchesRule(DEVICE_REFUSED, method, url)).toBe(false);
    }
    for (const [method, url] of refused) {
      expect([method, url, isLocalOnly(method, url)]).toEqual([method, url, true]);
      expect(matchesRule(DEVICE_ALLOWED, method, url)).toBe(false);
      expect(matchesRule(DEVICE_REFUSED, method, url)).toBe(true);
    }
    for (const [method, url] of [...allowed, ...refused]) expect([method, url, peerApiAllowed(method, url)]).toEqual([method, url, true]);
    // Through a paired machine's proxy, judged by the rest.
    expect(isLocalOnly('POST', '/api/machines/m-1/api/memory/entries/abc/approve')).toBe(false);
    expect(isLocalOnly('DELETE', '/api/machines/m-1/api/memory/entries/abc')).toBe(true);
  });
});
