import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { HybridClock } from '../../../src/core/hlc.ts';
import type { TeamMember, TeamNeedsYouItem } from '../../../src/core/team.ts';
import {
  ACCESS_KEYCHAIN_SERVICE,
  type TeamAccessEntryView,
  type TeamAccessView,
  accessStatus,
  checkSetupValues,
  hostWarning,
  isAccessEnvName,
  maskSecrets,
  normalizeHost,
  readAccessRecord,
  readAccessRequest,
  urlOnHost,
} from '../../../src/core/team-access.ts';
import { ACCESS_CATALOG, catalogEntry } from '../../../src/core/team-access-catalog.ts';
import { REQUEST_ACCESS_DESCRIPTION } from '../../../src/core/team-access-tools.ts';
import { registerTeamToolsIfMember } from '../../../src/core/team-tools.ts';
import { readTeamSyncMessage } from '../../../src/core/team-sync.ts';
import { type AgentApi, createTodoServer } from '../../../src/hook/sb-mcp.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { markDeviceRequest } from '../../../src/server/devices/mark.ts';
import { isLocalOnly } from '../../../src/server/devices/local-only.ts';
import { PEER_REQUEST_HEADER, peerApiAllowed } from '../../../src/server/peers/service.ts';
import { MacKeychain, MemorySecretStore, type SecretRunner, SecretToolStore, WindowsCredentialStore, defaultSecretStore, windowsCredentialScript } from '../../../src/server/team/access/secret-store.ts';
import { TEAM_DB_FILE } from '../../../src/server/team/db.ts';
import { ACCESS_MCP_SCRIPT, teamAccessEnv, withTeamAccessServers } from '../../../src/server/team/hooks.ts';
import { teamServiceOf } from '../../../src/server/team/install.ts';
import { agentMcpLaunch, claudeMcpConfig, codexMcpArgs } from '../../../src/server/todos/agent-mcp.ts';
import { configContent } from '../../../src/server/cli/opencode/bridge.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { generateToken } from '../../../src/server/token.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D100-T2 oracle (`docs/team.md` → *Access requests*): the rules (request checks,
 * host warning, masking, keychain command lines that never carry a value on an argv),
 * and the whole path over the real routes with the in-memory keychain: request →
 * Needs you → set up → stored only in the fake keychain → given only to that member
 * (environment, MCP config) → masked → revoked; rate limit; phones and peers cannot
 * write values; the records sync to a paired machine without any value ("set up here
 * too"), and after a move the access needs setup on the target.
 */

const KEY = 'acme-live-7f3a9c1e5b2d4f60';

interface Rig {
  readonly root: string;
  readonly store: Store;
  readonly app: FastifyInstance;
  readonly token: string;
  readonly host: string;
}

const rigs: Rig[] = [];

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.app.close();
    await r.store.close();
    await removeTempDir(r.root);
  }
});

async function setup(port = 4961): Promise<Rig> {
  const root = await makeTempDir('team-access');
  const dataDir = path.join(root, 'data');
  const store = await openTempStore(dataDir);
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: dataDir }, platform: 'linux', home: root, cwd: root }), port };
  const token = generateToken();
  const app = await buildApp({ config, token, store, webRoot: root, agentTools: false });
  // Tests: a request with this header is treated as arriving on the device listener (D73).
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-test-device'] === '1') markDeviceRequest(request.raw);
  });
  await app.ready();
  const rig = { root, store, app, token, host: `127.0.0.1:${port}` };
  rigs.push(rig);
  return rig;
}

function ui(r: Rig, method: InjectOptions['method'], url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return r.app.inject({
    method,
    url,
    headers: { host: r.host, cookie: `sb_token=${r.token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

function agent(r: Rig, sessionId: string): AgentApi {
  return async (method, url, body) => {
    const answer = await r.app.inject({
      method,
      url,
      headers: { host: r.host, 'x-switchboard-session': sessionId, authorization: `Bearer ${agentTokenFor(r.token, sessionId)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return { status: answer.statusCode, body: answer.body ? (answer.json() as unknown) : null };
  };
}

async function toolNames(api: AgentApi): Promise<string[]> {
  const server = createTodoServer(api);
  await registerTeamToolsIfMember(server, api);
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  const answered = new Promise<Record<string, unknown>>((resolve) => {
    client.onmessage = (message: JSONRPCMessage) => {
      if ((message as Record<string, unknown>)['id'] === 1) resolve(message as Record<string, unknown>);
    };
  });
  await client.start();
  await client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' } as JSONRPCMessage);
  const result = (await answered)['result'] as { tools: Array<{ name: string }> };
  await server.close();
  return result.tools.map((tool) => tool.name);
}

async function session(r: Rig, name: string): Promise<string> {
  return (await r.store.sessions.create({ name, title: name, claudeSessionId: randomUUID(), attached: true, cwd: r.root })).id;
}

async function member(r: Rig, sessionId: string, name: string): Promise<TeamMember> {
  const answer = await ui(r, 'POST', '/api/team/members', { sessionId, name });
  expect(answer.statusCode, answer.body).toBe(201);
  return answer.json() as TeamMember;
}

const KEY_REQUEST = {
  kind: 'api-key',
  service: 'Acme Analytics',
  host: 'api.acme.example',
  why: 'Fetch the weekly traffic report for the marketing summary.',
  scope: 'read-only, reports',
  fields: [{ name: 'ACME_ANALYTICS_KEY', label: 'API key', secret: true, help: 'Settings → API keys, a read-only key.', helpUrl: 'https://acme.example/docs/keys' }],
};

function memory(r: Rig): MemorySecretStore {
  const store = teamServiceOf(r.app)?.access.secretStore;
  if (!(store instanceof MemorySecretStore)) throw new Error('tests use the in-memory keychain');
  return store;
}

describe('D100-T2 · the rules', () => {
  it('reads a request: reserved variables, hosts, test URLs on the declared host only, the catalog decides what runs', () => {
    expect(['ACME_ANALYTICS_KEY', 'SLACK_BOT_TOKEN'].map(isAccessEnvName)).toEqual([true, true]);
    expect(['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'HTTPS_PROXY', 'ANTHROPIC_API_KEY', 'SWITCHBOARD_TODO_TOKEN', 'lower', 'A'].map(isAccessEnvName)).toEqual(Array(8).fill(false));
    expect([normalizeHost('https://API.Acme.example/v1?x=1'), normalizeHost('api.acme.example:8443'), normalizeHost('https://u:p@acme.example'), normalizeHost('not a host')]).toEqual(['api.acme.example', 'api.acme.example:8443', null, null]);
    expect([urlOnHost('https://api.acme.example/ping', 'api.acme.example'), urlOnHost('https://evil.example/ping', 'api.acme.example'), urlOnHost('http://api.acme.example/', 'api.acme.example')]).toEqual(['https://api.acme.example/ping', null, null]);

    const ok = readAccessRequest({ ...KEY_REQUEST, testUrl: 'https://api.acme.example/v1/ping', testHeader: { name: 'Authorization', value: 'Bearer {ACME_ANALYTICS_KEY}' } }, catalogEntry);
    expect(ok.ok && ok.input.test).toEqual({ url: 'https://api.acme.example/v1/ping', header: { name: 'Authorization', value: 'Bearer {ACME_ANALYTICS_KEY}' } });
    const bad = readAccessRequest({ ...KEY_REQUEST, fields: [{ name: 'NODE_OPTIONS', label: 'x', secret: true, help: '' }], testUrl: 'https://elsewhere.example/' }, catalogEntry);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors.map((e) => e.field)).toEqual(['fields[0]', 'fields', 'testUrl']);
    // A catalog request runs the catalog's command with the catalog's fields, whatever the agent wrote.
    const github = readAccessRequest({ kind: 'mcp', source: 'catalog', catalogId: 'github', service: 'GitHub', host: 'api.github.com', why: 'Read issues', scope: 'read-only', fields: [{ name: 'OTHER_TOKEN', label: 'x', secret: true, help: '' }], server: { command: 'rm' } }, catalogEntry);
    expect(github.ok && [github.input.mcp?.command, github.input.fields.map((f) => f.name)]).toEqual(['docker', ['GITHUB_PERSONAL_ACCESS_TOKEN']]);
    expect(hostWarning('evil.example', 'api.github.com')).toMatch(/declared evil\.example, but this catalog entry talks to api\.github\.com/);
    expect(hostWarning('api.github.com', 'api.github.com')).toBeNull();
    // The catalog: every known entry runs without a value on its argv.
    for (const entry of ACCESS_CATALOG) for (const arg of entry.server?.args ?? []) expect(arg).not.toMatch(/\{[A-Z_]+\}/);
    expect(REQUEST_ACCESS_DESCRIPTION).toMatch(/ONLY when you are actually blocked/);
    expect(REQUEST_ACCESS_DESCRIPTION).toMatch(/NEVER ask for passwords, tokens or keys in chat/);
    expect(REQUEST_ACCESS_DESCRIPTION).toMatch(/MINIMUM/);
    // Setup values: required, one line, long enough to be masked, and the pattern.
    const values = checkSetupValues([{ name: 'SLACK_BOT_TOKEN', label: 'Bot token', secret: true, help: '', helpUrl: null, pattern: 'xoxb-.+' }], { SLACK_BOT_TOKEN: 'xoxp-123456' });
    expect(values.ok).toBe(false);
  });

  it('masks a value as written and inside JSON (a tool result echoing the key)', () => {
    const secrets = [{ name: 'ACME_ANALYTICS_KEY', value: KEY }];
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `${KEY}\n` }] } });
    const masked = maskSecrets(line, secrets);
    expect(masked).not.toContain(KEY);
    expect((JSON.parse(masked) as { message: { content: Array<{ content: string }> } }).message.content[0]?.content).toBe('•••• (ACME_ANALYTICS_KEY)\n');
    const quoted = 'p"a\\ss-word-1';
    expect(maskSecrets(JSON.stringify({ text: `got ${quoted}` }), [{ name: 'PW', value: quoted }])).toBe(JSON.stringify({ text: 'got •••• (PW)' }));
    // Too short to mask safely: left as is (setup refuses such secrets).
    expect(maskSecrets('abc', [{ name: 'X', value: 'abc' }])).toBe('abc');
  });

  it('the keychain command lines never carry a value on an argv; tests never get an OS keychain', async () => {
    const calls: Array<{ command: string; args: readonly string[]; input: string | null }> = [];
    const run: SecretRunner = async (command, args, input) => {
      calls.push({ command, args, input });
      return { code: 0, stdout: Buffer.from('v').toString('base64'), stderr: '', error: null };
    };
    const ref = { service: ACCESS_KEYCHAIN_SERVICE, account: 'm1/a1/ACME_ANALYTICS_KEY' };
    await new MacKeychain(run).set(ref, KEY);
    await new SecretToolStore(run).set(ref, KEY);
    await new WindowsCredentialStore(run).set(ref, KEY);
    for (const call of calls) expect(call.args.join(' ')).not.toContain(KEY);
    expect(calls[0]).toMatchObject({ command: '/usr/bin/security', args: ['-i'] });
    expect(calls[0]?.input).toBe(`add-generic-password -U -s "Switchboard Team" -a "m1/a1/ACME_ANALYTICS_KEY" -l "Switchboard Team · m1/a1/ACME_ANALYTICS_KEY" -X ${Buffer.from(KEY).toString('hex')}\n`);
    expect(calls[1]).toMatchObject({ command: 'secret-tool', args: ['store', '--label', 'Switchboard Team · m1/a1/ACME_ANALYTICS_KEY', 'service', 'Switchboard Team', 'account', 'm1/a1/ACME_ANALYTICS_KEY'], input: KEY });
    expect(calls[2]?.command).toBe('powershell.exe');
    expect(calls[2]?.input).toBe(Buffer.from(KEY).toString('base64'));
    expect(Buffer.from(calls[2]?.args.at(-1) as string, 'base64').toString('utf16le')).toBe(windowsCredentialScript('write', 'Switchboard Team:m1/a1/ACME_ANALYTICS_KEY', 'm1/a1/ACME_ANALYTICS_KEY'));
    expect(windowsCredentialScript('write', 't', 'u')).not.toContain(KEY);
    // Under Vitest the default store is the in-memory one, on every platform.
    for (const platform of ['darwin', 'win32', 'linux'] as const) expect(defaultSecretStore(process.env, platform)).toBeInstanceOf(MemorySecretStore);
  });

  it('an access server joins each CLI\'s MCP config next to switchboard (stdio everywhere, http in Claude Code only); none for a plain launch', () => {
    const base = agentMcpLaunch({ nodePath: '/opt/node', port: 4961, sessionId: 's-1', token: 'T'.repeat(43) });
    const launch = {
      ...base,
      extraServers: [
        { name: 'access-acme-abc123', transport: 'stdio' as const, command: '/opt/node', args: [ACCESS_MCP_SCRIPT, '--switchboard-access', '4961', 's-1', 'a1'], env: { SWITCHBOARD_TODO_TOKEN: 'T'.repeat(43) } },
        { name: 'access-web-def456', transport: 'http' as const, url: 'https://mcp.acme.example/mcp', headers: { Authorization: 'Bearer ${ACME_TOKEN}' } },
      ],
    };
    expect(Object.keys(claudeMcpConfig(launch).mcpServers).sort()).toEqual(['access-acme-abc123', 'access-web-def456', 'switchboard']);
    expect(claudeMcpConfig(launch).mcpServers['access-web-def456']).toEqual({ type: 'http', url: 'https://mcp.acme.example/mcp', headers: { Authorization: 'Bearer ${ACME_TOKEN}' } });
    const codex = codexMcpArgs(launch).join(' ');
    expect(codex).toContain('mcp_servers.access-acme-abc123.command="/opt/node"');
    expect(codex).not.toContain('access-web-def456');
    const opencode = JSON.parse(configContent(undefined, launch)) as { mcp: Record<string, unknown> };
    expect(Object.keys(opencode.mcp).sort()).toEqual(['access-acme-abc123', 'switchboard']);
    expect(Object.keys(claudeMcpConfig(base).mcpServers)).toEqual(['switchboard']);
  });

  it('a record never reads a value field, and the statuses read as the tab shows them', () => {
    const clock = new HybridClock('m-a', () => Date.parse('2026-10-13T10:00:00Z')).next();
    const record = readAccessRecord({ id: 'a1', teamId: 'team', memberId: 'm1', clock, kind: 'api-key', state: 'active', service: 'Acme Analytics', host: 'api.acme.example', fields: KEY_REQUEST.fields, setUpOn: ['m-a'], value: KEY, values: { ACME_ANALYTICS_KEY: KEY } });
    expect(JSON.stringify(record)).not.toContain(KEY);
    const names = (id: string): string => ({ 'm-a': 'Mac', 'm-b': 'PC' })[id] ?? id;
    const now = Date.parse('2026-10-13T11:00:00Z');
    if (!record) throw new Error('readable');
    expect(accessStatus(record, { memberMachineId: 'm-a', selfId: 'm-a', names, now }).statusText).toBe('Ready on Mac');
    expect(accessStatus(record, { memberMachineId: 'm-a', selfId: 'm-b', names, now }).statusText).toBe('Set up on Mac only');
    expect(accessStatus(record, { memberMachineId: 'm-b', selfId: 'm-b', names, now })).toEqual({ status: 'needs-setup', statusText: 'Set up on Mac only: needs setup on PC' });
  });
});

describe('D100-T2 · over the routes (in-memory keychain)', () => {
  it('request → Needs you → set up → only in the keychain → only that member gets it (env, MCP config) → masked → revoked', async () => {
    const r = await setup();
    const marketing = await session(r, 'marketing-session');
    const tracker = await session(r, 'tracker-session');
    const plain = await session(r, 'plain-session');
    // Off: nobody has request_access.
    expect(await toolNames(agent(r, marketing))).not.toContain('request_access');
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    const m = await member(r, marketing, 'Marketing monitoring');
    await member(r, tracker, 'Tracker');
    expect(await toolNames(agent(r, marketing))).toContain('request_access');
    expect(await toolNames(agent(r, plain))).not.toContain('request_access');
    expect((await agent(r, plain)('POST', '/agent/v1/team/access', KEY_REQUEST)).status).toBe(404);

    // The agent asks.
    const asked = await agent(r, marketing)('POST', '/agent/v1/team/access', KEY_REQUEST);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect((asked.body as { text: string }).text).toMatch(/^Asked the developer for Acme Analytics on api\.acme\.example \(read-only, reports\)\. .*Do not ask for the value in chat/);
    const accessId = (asked.body as { access: { id: string } }).access.id;
    // Asking again reuses the open request.
    const again = await agent(r, marketing)('POST', '/agent/v1/team/access', KEY_REQUEST);
    expect([again.status, (again.body as { access: { id: string } }).access.id]).toEqual([201, accessId]);

    // Needs you: the exact service and host; never auto-approved.
    const needs = ((await ui(r, 'GET', '/api/team/needs-you')).json() as TeamNeedsYouItem[]).filter((item) => item.kind === 'access');
    expect(needs.map((item) => [item.label, item.title, item.access?.host, item.request?.state])).toEqual([
      ['Marketing monitoring · access', 'Marketing monitoring asks for Acme Analytics (read-only, reports)', 'api.acme.example', 'open'],
    ]);
    expect(needs[0]?.detail).toContain('Service: Acme Analytics · Host: api.acme.example · API key (ACME_ANALYTICS_KEY) · Scope: read-only, reports');

    // The Access tab: one section with exactly the declared field.
    const before = (await ui(r, 'GET', `/api/team/members/${m.id}/access`)).json() as TeamAccessView;
    expect(before.entries.map((e) => [e.service, e.status, e.fields.map((f) => [f.name, f.secret]), e.canSetUp])).toEqual([['Acme Analytics', 'requested', [['ACME_ANALYTICS_KEY', true]], true]]);

    // Set up: the value goes to the keychain only.
    const set = await ui(r, 'POST', `/api/team/access/${accessId}/setup`, { values: { ACME_ANALYTICS_KEY: KEY } });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.body).not.toContain(KEY);
    expect(memory(r).entries()).toEqual([{ service: 'Switchboard Team', account: `${m.id}/${accessId}/ACME_ANALYTICS_KEY`, value: KEY }]);
    const view = (await ui(r, 'GET', `/api/team/members/${m.id}/access`)).json() as TeamAccessView;
    const entry = view.entries[0] as TeamAccessEntryView;
    expect([entry.status, entry.here, entry.ready, entry.secretRefs]).toEqual(['ready', true, true, [{ field: 'ACME_ANALYTICS_KEY', service: 'Switchboard Team', account: `${m.id}/${accessId}/ACME_ANALYTICS_KEY` }]]);
    expect(entry.audit.map((a) => a.what)).toEqual(['asked', 'set-up']);
    // Not in team.db, the main database, the API answers or the sync message.
    expect((await readFile(path.join(r.root, 'data', TEAM_DB_FILE))).includes(KEY)).toBe(false);
    for (const url of ['/api/team', `/api/team/members/${m.id}/access`, '/api/team/needs-you', '/api/settings']) expect((await ui(r, 'GET', url)).body).not.toContain(KEY);
    expect((await ui(r, 'POST', '/api/team/sync', {})).body).not.toContain(KEY);
    // The request is settled (no longer in Needs you).
    expect(((await ui(r, 'GET', '/api/team/needs-you')).json() as TeamNeedsYouItem[]).filter((item) => item.kind === 'access')).toEqual([]);

    // Delivery: only that member's session gets the variable and the masking.
    const forMember = await teamAccessEnv(r.store, marketing);
    expect(forMember.env).toEqual({ ACME_ANALYTICS_KEY: KEY });
    for (const other of [tracker, plain]) expect((await teamAccessEnv(r.store, other)).env).toEqual({});
    const echoed = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: `ACME_ANALYTICS_KEY=${KEY}` }] } });
    expect(forMember.mask(echoed)).toContain('ACME_ANALYTICS_KEY=•••• (ACME_ANALYTICS_KEY)');
    expect(forMember.mask(echoed)).not.toContain(KEY);
    expect((await teamAccessEnv(r.store, plain)).mask(echoed)).toBe(echoed);
    // Used: recorded (last used, audit).
    const used = ((await ui(r, 'GET', `/api/team/members/${m.id}/access`)).json() as TeamAccessView).entries[0];
    expect([used?.lastUsedAt !== null, used?.audit.at(-1)?.what]).toEqual([true, 'used']);
    // The charter names it (never the value).
    const instruction = await import('../../../src/server/team/hooks.ts').then((h) => h.withTeamCharter(r.store, marketing, null));
    expect(instruction).toMatch(/Access the developer set up for you .*Acme Analytics \(ACME_ANALYTICS_KEY\)/);
    expect(instruction).not.toContain(KEY);

    // Revoke: gone from the keychain and from the member.
    const revoked = await ui(r, 'POST', `/api/team/access/${accessId}/revoke`);
    expect([revoked.statusCode, (revoked.json() as TeamAccessEntryView).status]).toEqual([200, 'revoked']);
    expect(memory(r).entries()).toEqual([]);
    expect((await teamAccessEnv(r.store, marketing)).env).toEqual({});
    // A value seen once stays masked in that session's output.
    expect((await teamAccessEnv(r.store, marketing)).mask(KEY)).toBe('•••• (ACME_ANALYTICS_KEY)');
    expect((await ui(r, 'POST', `/api/team/access/${accessId}/setup`, { values: { ACME_ANALYTICS_KEY: KEY } })).statusCode).toBe(409);
  });

  it('an MCP access joins only the member\'s MCP config (no value in it); the launcher gets it from Switchboard; deny and not now', async () => {
    const r = await setup();
    const marketing = await session(r, 'marketing-session');
    const plain = await session(r, 'plain-session');
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    const m = await member(r, marketing, 'Marketing monitoring');
    const asked = await agent(r, marketing)('POST', '/agent/v1/team/access', {
      kind: 'mcp',
      source: 'custom',
      service: 'Acme Reports',
      host: 'reports.acme.example',
      why: 'List the weekly reports.',
      scope: 'read-only',
      fields: [{ name: 'ACME_REPORTS_TOKEN', label: 'Token', secret: true, help: 'A read-only token.' }],
      server: { transport: 'stdio', command: 'acme-reports-mcp', args: ['--read-only'] },
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const accessId = (asked.body as { access: { id: string } }).access.id;
    // A custom server's command is confirmed by the developer at setup.
    const set = await ui(r, 'POST', `/api/team/access/${accessId}/setup`, { values: { ACME_REPORTS_TOKEN: KEY }, server: { transport: 'stdio', command: 'acme-reports-mcp', args: ['--read-only'] } });
    expect(set.statusCode, set.body).toBe(200);
    const launch = agentMcpLaunch({ nodePath: '/opt/node', port: 4961, sessionId: marketing, token: 'T'.repeat(43) });
    const withAccess = withTeamAccessServers(r.store, launch, marketing);
    const config = claudeMcpConfig(withAccess);
    const names = Object.keys(config.mcpServers);
    expect(names).toHaveLength(2);
    const extra = config.mcpServers[names.find((n) => n !== 'switchboard') as string] as { command: string; args: string[] };
    expect(extra.command).toBe('/opt/node');
    expect(extra.args).toEqual([ACCESS_MCP_SCRIPT, '--switchboard-access', '4961', marketing, accessId]);
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(withTeamAccessServers(r.store, agentMcpLaunch({ nodePath: '/opt/node', port: 4961, sessionId: plain, token: 'x' }), plain).extraServers).toBeUndefined();
    // The launcher (the member's own session only) gets the command and the value.
    const started = await agent(r, marketing)('GET', `/agent/v1/team/access/${accessId}/launch`);
    expect([started.status, started.body]).toEqual([200, { command: 'acme-reports-mcp', args: ['--read-only'], env: { ACME_REPORTS_TOKEN: KEY } }]);
    expect((await agent(r, plain)('GET', `/agent/v1/team/access/${accessId}/launch`)).status).toBe(404);
    expect(((await ui(r, 'GET', `/api/team/members/${m.id}/access`)).json() as TeamAccessView).entries[0]?.lastUsedAt).not.toBeNull();

    // Deny and Not now from Needs you.
    const second = await agent(r, marketing)('POST', '/agent/v1/team/access', { ...KEY_REQUEST, service: 'Acme CRM', host: 'crm.acme.example' });
    const third = await agent(r, marketing)('POST', '/agent/v1/team/access', { ...KEY_REQUEST, service: 'Acme Ads', host: 'ads.acme.example' });
    const needs = ((await ui(r, 'GET', '/api/team/needs-you')).json() as TeamNeedsYouItem[]).filter((item) => item.kind === 'access');
    const byService = (service: string): string => needs.find((item) => item.access?.service === service)?.id as string;
    expect((await ui(r, 'POST', `/api/team/requests/${byService('Acme CRM')}/decline`)).statusCode).toBe(200);
    expect((await ui(r, 'POST', `/api/team/requests/${byService('Acme Ads')}/dismiss`)).statusCode).toBe(200);
    const states = ((await ui(r, 'GET', `/api/team/members/${m.id}/access`)).json() as TeamAccessView).entries.map((e) => [e.service, e.status]);
    expect(states).toEqual(expect.arrayContaining([['Acme CRM', 'denied'], ['Acme Ads', 'not-now']]));
    expect([second.status, third.status]).toEqual([201, 201]);
    // A catalog request with another host carries the warning on its card.
    const warned = await agent(r, marketing)('POST', '/agent/v1/team/access', { kind: 'mcp', source: 'catalog', catalogId: 'github', service: 'GitHub', host: 'gh.evil.example', why: 'Read issues', scope: 'read-only' });
    expect(warned.status).toBe(201);
    const card = ((await ui(r, 'GET', '/api/team/needs-you')).json() as TeamNeedsYouItem[]).find((item) => item.access?.service === 'GitHub');
    expect(card?.access?.warning).toMatch(/declared gh\.evil\.example, but this catalog entry talks to api\.github\.com/);
    expect(card?.detail).toMatch(/Warning:/);
  });

  it('Test connection: an MCP server is started with its values and lists its tools; a key is tried on its declared host only', async () => {
    const r = await setup();
    const s = await session(r, 'marketing-session');
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    await member(r, s, 'Marketing');
    const fixture = path.join(REPO_ROOT, 'tests', 'fixtures', 'team-access', 'mcp-server.ts');
    const mcp = await agent(r, s)('POST', '/agent/v1/team/access', {
      kind: 'mcp',
      source: 'custom',
      service: 'Acme Reports',
      host: 'reports.acme.example',
      why: 'List the weekly reports.',
      scope: 'read-only',
      fields: [{ name: 'ACME_REPORTS_TOKEN', label: 'Token', secret: true, help: 'A read-only token.' }],
    });
    const mcpId = (mcp.body as { access: { id: string } }).access.id;
    // Not set up here yet: nothing to test.
    expect((await ui(r, 'POST', `/api/team/access/${mcpId}/test`)).statusCode).toBe(409);
    expect((await ui(r, 'POST', `/api/team/access/${mcpId}/setup`, { values: { ACME_REPORTS_TOKEN: KEY } })).statusCode).toBe(422);
    expect((await ui(r, 'POST', `/api/team/access/${mcpId}/setup`, { values: { ACME_REPORTS_TOKEN: KEY }, server: { transport: 'stdio', command: process.execPath, args: [fixture] } })).statusCode).toBe(200);
    const tested = await ui(r, 'POST', `/api/team/access/${mcpId}/test`);
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json()).toEqual({ ok: true, detail: 'Connected: 1 tool', tools: ['acme_report'] });

    // A key: one HEAD to the declared test URL (loopback here), with the header it declared.
    const seen: Array<{ method: string; url: string; auth: string | undefined }> = [];
    const stub = http.createServer((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
      res.writeHead(req.headers.authorization === `Bearer ${KEY}` ? 204 : 401).end();
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    try {
      const host = `127.0.0.1:${(stub.address() as AddressInfo).port}`;
      const key = await agent(r, s)('POST', '/agent/v1/team/access', { ...KEY_REQUEST, host, testUrl: `http://${host}/v1/ping`, testHeader: { name: 'Authorization', value: 'Bearer {ACME_ANALYTICS_KEY}' } });
      expect(key.status, JSON.stringify(key.body)).toBe(201);
      const keyId = (key.body as { access: { id: string } }).access.id;
      await ui(r, 'POST', `/api/team/access/${keyId}/setup`, { values: { ACME_ANALYTICS_KEY: KEY } });
      const result = await ui(r, 'POST', `/api/team/access/${keyId}/test`);
      expect(result.json()).toEqual({ ok: true, detail: `HTTP 204 from ${host}`, tools: [] });
      expect(seen).toEqual([{ method: 'HEAD', url: '/v1/ping', auth: `Bearer ${KEY}` }]);
      const audit = ((await ui(r, 'GET', `/api/team/members/${(await teamServiceOf(r.app)?.view())?.members[0]?.id}/access`)).json() as TeamAccessView).entries.flatMap((e) => e.audit.map((a) => a.what));
      expect(audit.filter((what) => what === 'tested')).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });

  it('rate limit: at most 5 new requests per member per hour', async () => {
    const r = await setup();
    const s = await session(r, 'busy-session');
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    await member(r, s, 'Busy');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await agent(r, s)('POST', '/agent/v1/team/access', { ...KEY_REQUEST, service: `Acme ${i}`, host: `api${i}.acme.example` })).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    expect(((await ui(r, 'GET', '/api/team/needs-you')).json() as TeamNeedsYouItem[]).filter((item) => item.kind === 'access')).toHaveLength(5);
  });

  it('phones read the tab but never write values; peers get metadata only; every route is classified', async () => {
    const r = await setup();
    const s = await session(r, 'marketing-session');
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    const m = await member(r, s, 'Marketing');
    const asked = await agent(r, s)('POST', '/agent/v1/team/access', KEY_REQUEST);
    const accessId = (asked.body as { access: { id: string } }).access.id;
    // A phone: the tab is read-only; setup is refused ("set this up on a computer"); Deny / Not now stay possible.
    const onPhone = (await ui(r, 'GET', `/api/team/members/${m.id}/access`, undefined, { 'x-test-device': '1' })).json() as TeamAccessView;
    expect(onPhone.device).toBe(true);
    const refused = await ui(r, 'POST', `/api/team/access/${accessId}/setup`, { values: { ACME_ANALYTICS_KEY: KEY } }, { 'x-test-device': '1' });
    expect([refused.statusCode, refused.json().message]).toEqual([403, 'Set this up on a computer: secrets are never typed on a phone.']);
    // Through the peer API: refused too (values never travel).
    expect((await ui(r, 'POST', `/api/team/access/${accessId}/setup`, { values: { ACME_ANALYTICS_KEY: KEY } }, { [PEER_REQUEST_HEADER]: 'm-other' })).statusCode).toBe(403);
    expect(memory(r).entries()).toEqual([]);
    for (const [method, url] of [
      ['GET', '/api/team/members/m1/access'],
      ['GET', '/api/team/members/m1/access/shareable'],
      ['GET', '/api/team/access/catalog'],
      ['POST', '/api/team/requests/q1/decline'],
      ['POST', '/api/team/requests/q1/dismiss'],
    ] as const) expect(isLocalOnly(method, url), `${method} ${url}`).toBe(false);
    for (const [method, url] of [
      ['POST', '/api/team/access/a1/setup'],
      ['POST', '/api/team/access/a1/test'],
      ['POST', '/api/team/access/a1/revoke'],
      ['PUT', '/api/team/access/a1'],
    ] as const) {
      expect(isLocalOnly(method, url), `${method} ${url}`).toBe(true);
      expect(peerApiAllowed(method, url), `${method} ${url}`).toBe(false);
    }
    expect(peerApiAllowed('GET', '/api/team/members/m1/access')).toBe(true);
    expect(peerApiAllowed('GET', '/api/team/access/catalog')).toBe(true);
  });

  it('paired machines: the record syncs without the value ("set up on <A> only", Set up here too); after a move it needs setup on the target', async () => {
    const a = await setup(4962);
    const b = await setup(4963);
    for (const r of [a, b]) await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    const s = await session(a, 'marketing-session');
    const m = await member(a, s, 'Marketing');
    const accessId = ((await agent(a, s)('POST', '/agent/v1/team/access', KEY_REQUEST)).body as { access: { id: string } }).access.id;
    expect((await ui(a, 'POST', `/api/team/access/${accessId}/setup`, { values: { ACME_ANALYTICS_KEY: KEY } })).statusCode).toBe(200);
    // A → B: A's message (what the exchange sends), received by B as a peer request.
    const fromA = (await ui(a, 'POST', '/api/team/sync', {})).json();
    expect(JSON.stringify(fromA)).not.toContain(KEY);
    expect(readTeamSyncMessage(fromA)?.snapshot.access.map((x) => x.id)).toEqual([accessId]);
    expect((await ui(b, 'POST', '/api/team/sync', fromA, { [PEER_REQUEST_HEADER]: 'a' })).statusCode).toBe(200);
    const onB = (await ui(b, 'GET', `/api/team/members/${m.id}/access`)).json() as TeamAccessView;
    const seen = onB.entries[0] as TeamAccessEntryView;
    expect([seen.status, seen.here, seen.canSetUp, seen.statusText]).toEqual(['ready', false, true, `Set up on ${onB.member.machineName} only`]);
    expect(memory(b).entries()).toEqual([]);
    // "Set up here too" on B: B's own keychain; the record now names both machines.
    expect((await ui(b, 'POST', `/api/team/access/${accessId}/setup`, { values: { ACME_ANALYTICS_KEY: `${KEY}-b` } })).statusCode).toBe(200);
    expect(memory(b).entries().map((e) => e.value)).toEqual([`${KEY}-b`]);
    expect(memory(a).entries().map((e) => e.value)).toEqual([KEY]);
    const fromB = (await ui(b, 'POST', '/api/team/sync', {})).json();
    expect(JSON.stringify(fromB)).not.toContain(KEY);
    await ui(a, 'POST', '/api/team/sync', fromB, { [PEER_REQUEST_HEADER]: 'b' });
    const both = ((await ui(a, 'GET', `/api/team/members/${m.id}/access`)).json() as TeamAccessView).entries[0];
    expect(both?.setUpOn).toHaveLength(2);

    // A move (the core points the member at the target; D65's take-over does the rest): B gets the member on a session of its own.
    const c = await setup(4964);
    await ui(c, 'PUT', '/api/settings', { 'experimental.team': true });
    const target = await session(c, 'moved-session');
    const message = readTeamSyncMessage((await ui(a, 'POST', '/api/team/sync', {})).json());
    if (!message) throw new Error('a sync message');
    const self = (await ui(c, 'POST', '/api/team/sync', {})).json() as { machine: { id: string } };
    const clock = new HybridClock(message.machine.id, () => Date.now() + 60_000).next();
    const moved = { ...message, snapshot: { ...message.snapshot, members: message.snapshot.members.map((x) => (x.id === m.id ? { ...x, machineId: self.machine.id, sessionId: target, clock } : x)) } };
    expect((await ui(c, 'POST', '/api/team/sync', moved, { [PEER_REQUEST_HEADER]: 'a' })).statusCode).toBe(200);
    const onC = (await ui(c, 'GET', `/api/team/members/${m.id}/access`)).json() as TeamAccessView;
    expect([onC.member.local, onC.entries[0]?.status, onC.entries[0]?.ready]).toEqual([true, 'needs-setup', false]);
    expect(onC.entries[0]?.statusText).toMatch(/only: needs setup on /);
    expect((await teamAccessEnv(c.store, target)).env).toEqual({});
    const charter = await import('../../../src/server/team/hooks.ts').then((h) => h.withTeamCharter(c.store, target, null));
    expect(charter).toMatch(/Access that needs setting up on this machine before you use it: Acme Analytics\./);
  });
});
