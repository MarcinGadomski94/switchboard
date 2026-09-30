import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpActionResult, McpAuthState, McpServerDefinition, McpView } from '../../../src/core/mcp.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { McpService } from '../../../src/server/mcp/service.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { fakeClaudeCommand } from '../../../tools/fake-claude/command.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D61 oracle: the MCP routes against fake-claude with a temp HOME /
 * CLAUDE_CONFIG_DIR: the exact CLI argv of every action, the helper's control
 * requests, the edit's kept secrets, the OAuth flow, and that no secret value
 * ever reaches a response.
 */

const PORT = 4877;
const HOST = `127.0.0.1:${PORT}`;
const SECRETS = ['s3cretTOKEN', 'k3yVALUE', 'hdrSECRET', 'urlSECRET'];

let tmp: string;
let home: string;
let project: string;
let log: string;
let store: Store;
let app: FastifyInstance;
let token: string;
let folderId: string;

beforeEach(async () => {
  tmp = await makeTempDir('api-mcp');
  home = path.join(tmp, 'home');
  project = path.join(tmp, 'project');
  log = path.join(tmp, 'fake.log');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await mkdir(project, { recursive: true });
  store = await openTempStore(tmp);
  folderId = (await seedFolder(store, project, { kind: 'repo' })).id;
  token = generateToken();
  const env = { PATH: process.env['PATH'] ?? '', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), FAKE_CLAUDE_LOG: log };
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  const mcp = new McpService({ claudeCommand: fakeClaudeCommand(), env, pollMs: 50, settleTimeoutMs: 2_000, authTimeoutMs: 10_000 });
  app = await buildApp({ config, token, store, webRoot: tmp, mcp });
  app.addHook('onClose', async () => mcp.close());
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await store.close();
  await removeTempDir(tmp);
});

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function fakeLog(): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function mcpArgv(): Promise<string[][]> {
  return (await fakeLog()).filter((e) => e['kind'] === 'argv' && (e['argv'] as string[])[0] === 'mcp').map((e) => e['argv'] as string[]);
}

async function controlSubtypes(): Promise<string[]> {
  return (await fakeLog())
    .filter((e) => e['kind'] === 'stdin')
    .map((e) => (JSON.parse(e['line'] as string) as { request?: { subtype?: string } }).request?.subtype ?? '');
}

function noSecrets(body: string): void {
  for (const secret of SECRETS) expect(body, `leaked ${secret}`).not.toContain(secret);
}

async function writeConfig(): Promise<void> {
  const claudeJson = {
    mcpServers: {
      acme: { type: 'stdio', command: 'npx', args: ['acme-mcp', '--token', 's3cretTOKEN'], env: { API_KEY: 'k3yVALUE' } },
    },
    projects: {
      [await realpath(project)]: {
        mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/mcp?access_token=urlSECRET', headers: { Authorization: 'Bearer hdrSECRET' }, oauth: { clientId: 'abc' } } },
      },
    },
  };
  await writeFile(path.join(home, '.claude', '.claude.json'), JSON.stringify(claudeJson));
  await writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'node', args: ['server.js'] } } }));
}

describe('/api/mcp (D61)', () => {
  it('lists user, local and project servers per folder, masked; refuses a cookie-less call', async () => {
    await writeConfig();
    const response = await call('GET', `/api/mcp?folder=${folderId}`);
    expect(response.statusCode).toBe(200);
    noSecrets(response.body);
    const view = response.json() as McpView;
    expect(view.folder.path).toBe(path.resolve(project));
    expect(view.servers.map((s) => [s.scope, s.name, s.status])).toEqual([
      ['local', 'docs', 'unchecked'],
      ['project', 'shared', 'pending-approval'],
      ['user', 'acme', 'unchecked'],
    ]);
    const acme = view.servers.find((s) => s.name === 'acme');
    expect(acme).toMatchObject({ transport: 'stdio', command: 'npx', args: ['acme-mcp', '--token', '••••'], envNames: ['API_KEY'], editable: true, canAuthenticate: false });
    const docs = view.servers.find((s) => s.name === 'docs');
    expect(docs).toMatchObject({ transport: 'http', url: 'https://mcp.example.com/mcp?access_token=••••', headerNames: ['Authorization'], canAuthenticate: true });
    const anonymous = await app.inject({ method: 'GET', url: '/api/mcp', headers: { host: HOST } });
    expect(anonymous.statusCode).toBe(401);
    expect(await mcpArgv()).toEqual([]); // listing reads the files only
  });

  it('checks one server with `claude mcp get <name>` in the folder, and all with the helper (mcp_status: tools counted)', async () => {
    await writeConfig();
    const one = await call('POST', `/api/mcp/check?folder=${folderId}`, { name: 'docs' });
    expect(one.statusCode).toBe(200);
    noSecrets(one.body);
    const result = one.json() as McpActionResult;
    expect(result.commands).toEqual(['claude mcp get docs']);
    expect(result.view.servers.find((s) => s.name === 'docs')).toMatchObject({ status: 'needs-auth' });
    expect(result.view.servers.find((s) => s.name === 'docs')?.checkedAt).toEqual(expect.any(String));
    const entries = (await fakeLog()).filter((e) => e['kind'] === 'argv');
    expect(entries[0]).toMatchObject({ argv: ['mcp', 'get', 'docs'] });
    expect(await realpath(entries[0]?.['cwd'] as string)).toBe(await realpath(project));

    const all = await call('POST', `/api/mcp/check?folder=${folderId}`, {});
    noSecrets(all.body);
    const allView = (all.json() as McpActionResult).view;
    expect(allView.checkedAt).toEqual(expect.any(String));
    expect(allView.servers.find((s) => s.name === 'acme')).toMatchObject({ status: 'connected', tools: 3 });
    const helperArgv = (await fakeLog()).filter((e) => e['kind'] === 'argv').map((e) => e['argv'] as string[]);
    expect(helperArgv[1]).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio']);
    expect(await controlSubtypes()).toEqual(['initialize', 'mcp_status']);
  });

  it('shows plugin servers the check found as read-only rows', async () => {
    await writeConfig();
    await writeFile(path.join(home, '.claude', 'fake-mcp-state.json'), JSON.stringify({ plugins: [{ name: 'plugin:acme:search', status: 'connected' }] }));
    const view = ((await call('POST', `/api/mcp/check?folder=${folderId}`, {})).json() as McpActionResult).view;
    expect(view.servers.find((s) => s.name === 'plugin:acme:search')).toMatchObject({ scope: 'plugin', editable: false, status: 'connected', tools: 1 });
    const refused = await call('DELETE', `/api/mcp/servers/${encodeURIComponent('plugin:acme:search')}?folder=${folderId}&scope=plugin`);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: 'read-only' });
  });

  it('adds with `claude mcp add-json … --scope`, edits keeping secrets server-side, removes; exact argv; no secret in any answer', async () => {
    const added = await call('POST', `/api/mcp/servers?folder=${folderId}`, {
      name: 'files',
      scope: 'user',
      transport: 'stdio',
      command: 'npx',
      args: ['files-mcp', '--api-key', 's3cretTOKEN'],
      env: [{ name: 'API_KEY', value: 'k3yVALUE' }],
    });
    expect(added.statusCode).toBe(201);
    noSecrets(added.body);
    const addResult = added.json() as McpActionResult;
    expect(addResult.commands[0]).toBe(`claude mcp add-json files '{"type":"stdio","command":"npx","args":["files-mcp","--api-key","••••"],"env":{"API_KEY":"••••"}}' --scope user`);
    expect((await mcpArgv())[0]).toEqual(['mcp', 'add-json', 'files', JSON.stringify({ type: 'stdio', command: 'npx', args: ['files-mcp', '--api-key', 's3cretTOKEN'], env: { API_KEY: 'k3yVALUE' } }), '--scope', 'user']);
    expect(addResult.view.changedAt).toEqual(expect.any(String));

    const definition = (await call('GET', `/api/mcp/servers/files?folder=${folderId}&scope=user`)).json() as McpServerDefinition;
    expect(definition).toEqual({ name: 'files', scope: 'user', transport: 'stdio', command: 'npx', args: ['files-mcp', '--api-key', '••••'], url: null, env: [{ name: 'API_KEY', set: true }], headers: [] });

    // Edit: a new arg, the masked one posted back unchanged, the env value kept.
    const edited = await call('PUT', `/api/mcp/servers/files?folder=${folderId}&scope=user`, {
      name: 'files',
      scope: 'user',
      transport: 'stdio',
      command: 'npx',
      args: ['files-mcp', '--api-key', '••••', '--verbose'],
      env: [{ name: 'API_KEY', keep: true }, { name: 'LOG', value: 'debug' }],
    });
    expect(edited.statusCode).toBe(200);
    noSecrets(edited.body);
    const argv = await mcpArgv();
    expect(argv[1]).toEqual(['mcp', 'remove', 'files', '--scope', 'user']);
    expect(argv[2]).toEqual(['mcp', 'add-json', 'files', JSON.stringify({ type: 'stdio', command: 'npx', args: ['files-mcp', '--api-key', 's3cretTOKEN', '--verbose'], env: { API_KEY: 'k3yVALUE', LOG: 'debug' } }), '--scope', 'user']);
    const stored = JSON.parse(await readFile(path.join(home, '.claude', '.claude.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(stored.mcpServers['files']).toMatchObject({ env: { API_KEY: 'k3yVALUE', LOG: 'debug' } });

    // Rename + move to local: add the new one first, then remove the old one.
    const moved = await call('PUT', `/api/mcp/servers/files?folder=${folderId}&scope=user`, { name: 'files2', scope: 'local', transport: 'stdio', command: 'npx', args: ['files-mcp'], env: [{ name: 'API_KEY', keep: true }] });
    expect(moved.statusCode).toBe(200);
    expect((await mcpArgv()).slice(3).map((a) => a.slice(0, 3))).toEqual([
      ['mcp', 'add-json', 'files2'],
      ['mcp', 'remove', 'files'],
    ]);
    expect((moved.json() as McpActionResult).view.servers.map((s) => [s.scope, s.name])).toEqual([['local', 'files2']]);

    const removed = await call('DELETE', `/api/mcp/servers/files2?folder=${folderId}&scope=local`);
    expect(removed.statusCode).toBe(200);
    expect((await mcpArgv()).at(-1)).toEqual(['mcp', 'remove', 'files2', '--scope', 'local']);
    expect((removed.json() as McpActionResult).view.servers).toEqual([]);
  });

  it('validates like the CLI (422) and shows the CLI error verbatim (409); a failed edit restores the old definition', async () => {
    const bad = await call('POST', `/api/mcp/servers?folder=${folderId}`, { name: 'bad name', scope: 'global', transport: 'stdio' });
    expect(bad.statusCode).toBe(422);
    expect((bad.json() as { errors: Array<{ field: string }> }).errors.map((e) => e.field)).toEqual(['name', 'scope', 'command']);
    expect(await mcpArgv()).toEqual([]);

    await writeConfig();
    const duplicate = await call('POST', `/api/mcp/servers?folder=${folderId}`, { name: 'acme', scope: 'user', transport: 'stdio', command: 'x' });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: 'cli-failed', message: 'MCP server acme already exists in user config' });

    await writeFile(path.join(home, '.claude', 'fake-mcp-state.json'), JSON.stringify({ failAdd: true }));
    const failed = await call('PUT', `/api/mcp/servers/acme?folder=${folderId}&scope=user`, { name: 'acme', scope: 'user', transport: 'stdio', command: 'npx', args: ['acme-mcp', '--token', '••••'], env: [{ name: 'API_KEY', keep: true }] });
    expect(failed.statusCode).toBe(409);
    noSecrets(failed.body);
    expect((failed.json() as { message: string }).message).toContain('fake-claude was told to refuse add-json');
    // failAdd also refuses the restore in the fake, so the answer says so; the argv shows the attempt.
    expect((await mcpArgv()).slice(-3).map((a) => a.slice(0, 3))).toEqual([
      ['mcp', 'remove', 'acme'],
      ['mcp', 'add-json', 'acme'],
      ['mcp', 'add-json', 'acme'],
    ]);
  });

  it('reconnects and disables / enables through the helper (mcp_reconnect, mcp_toggle → disabledMcpServers)', async () => {
    await writeConfig();
    const reconnect = await call('POST', `/api/mcp/servers/acme/reconnect?folder=${folderId}`);
    expect(reconnect.statusCode).toBe(200);
    expect(reconnect.json()).toMatchObject({ message: 'Reconnected acme' });
    expect((reconnect.json() as McpActionResult).view.servers.find((s) => s.name === 'acme')).toMatchObject({ status: 'connected', tools: 3 });

    const off = await call('POST', `/api/mcp/servers/acme/toggle?folder=${folderId}`, { enabled: false });
    expect(off.statusCode).toBe(200);
    expect((off.json() as McpActionResult).view.servers.find((s) => s.name === 'acme')?.status).toBe('disabled');
    const stored = JSON.parse(await readFile(path.join(home, '.claude', '.claude.json'), 'utf8')) as { projects: Record<string, { disabledMcpServers?: string[] }> };
    expect(Object.values(stored.projects).some((p) => p.disabledMcpServers?.includes('acme'))).toBe(true);

    const on = await call('POST', `/api/mcp/servers/acme/toggle?folder=${folderId}`, { enabled: true });
    expect((on.json() as McpActionResult).view.servers.find((s) => s.name === 'acme')?.status).toBe('connected');
    expect(await controlSubtypes()).toEqual(['initialize', 'mcp_reconnect', 'mcp_status', 'initialize', 'mcp_toggle', 'initialize', 'mcp_toggle', 'mcp_status']);
  });

  it('signs in: mcp_authenticate returns the URL; opening it completes the sign-in; the helper then exits', async () => {
    await writeConfig();
    const started = await call('POST', `/api/mcp/servers/docs/auth?folder=${folderId}`, {});
    expect(started.statusCode).toBe(200);
    const flow = started.json() as McpAuthState;
    expect(flow).toMatchObject({ server: 'docs', state: 'waiting', callbackExpected: true });
    expect(flow.authUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/authorize\?/);
    // The browser opens the URL (the fake's /authorize redirects to its localhost callback).
    const page = await fetch(flow.authUrl as string);
    expect(await page.text()).toContain('Authentication successful');
    let state: McpAuthState = flow;
    for (let i = 0; i < 100 && state.state === 'waiting'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      state = (await call('GET', `/api/mcp/auth/${flow.id}`)).json() as McpAuthState;
    }
    expect(state.state).toBe('done');
    const view = (await call('GET', `/api/mcp?folder=${folderId}`)).json() as McpView;
    expect(view.servers.find((s) => s.name === 'docs')).toMatchObject({ status: 'connected', tools: 2 });
    expect(await controlSubtypes()).toContain('mcp_authenticate');
  });

  it('re-authenticates by clearing first; takes a pasted redirect URL; refuses stdio; cancels', async () => {
    await writeConfig();
    const flow = (await call('POST', `/api/mcp/servers/docs/auth?folder=${folderId}`, { reset: true })).json() as McpAuthState;
    expect((await controlSubtypes()).slice(0, 3)).toEqual(['initialize', 'mcp_clear_auth', 'mcp_authenticate']);
    const state = new URL(flow.authUrl as string).searchParams.get('state');
    const wrong = await call('POST', `/api/mcp/auth/${flow.id}/callback`, { callbackUrl: 'http://localhost:1/callback?state=nope' });
    expect(wrong.statusCode).toBe(422);
    const pasted = await call('POST', `/api/mcp/auth/${flow.id}/callback`, { callbackUrl: `http://localhost:1/callback?code=abc&state=${state}` });
    expect(pasted.statusCode).toBe(200);
    let current = pasted.json() as McpAuthState;
    for (let i = 0; i < 100 && current.state === 'waiting'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      current = (await call('GET', `/api/mcp/auth/${flow.id}`)).json() as McpAuthState;
    }
    expect(current.state).toBe('done');

    const stdio = (await call('POST', `/api/mcp/servers/acme/auth?folder=${folderId}`, {})).json() as McpAuthState;
    expect(stdio).toMatchObject({ state: 'failed', authUrl: null });
    expect(stdio.error).toContain('no OAuth sign-in');

    await writeFile(path.join(home, '.claude', 'fake-mcp-state.json'), JSON.stringify({ authenticated: [] }));
    const again = (await call('POST', `/api/mcp/servers/docs/auth?folder=${folderId}`, {})).json() as McpAuthState;
    const cancelled = await call('DELETE', `/api/mcp/auth/${again.id}`);
    expect(cancelled.json()).toMatchObject({ state: 'cancelled' });
  });

  it('is on the peer API (D48): a paired machine manages this machine\'s servers', () => {
    expect(peerApiAllowed('GET', '/api/mcp?folder=x')).toBe(true);
    expect(peerApiAllowed('POST', '/api/mcp/check')).toBe(true);
    expect(peerApiAllowed('PUT', '/api/mcp/servers/acme')).toBe(true);
    expect(peerApiAllowed('POST', '/api/mcp/servers/acme/auth')).toBe(true);
    expect(peerApiAllowed('POST', '/api/mcp/auth/abc/callback')).toBe(true);
    expect(peerApiAllowed('POST', '/api/mcp/servers/acme/other')).toBe(false);
  });
});
