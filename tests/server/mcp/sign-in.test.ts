import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem, Session } from '../../../src/core/api.ts';
import type { McpAuthState } from '../../../src/core/mcp.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { McpService } from '../../../src/server/mcp/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { fakeClaudeCommand } from '../../../tools/fake-claude/command.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D163 oracle (`docs/mcp.md` → *Sign-in where it happens*): a supervised fake-claude session
 * whose `init` reports MCP servers that need a sign-in exposes them as `Session.mcpSignIn`
 * and raises one "Sign in to <server>" Needs-you item each; a claude.ai connector is refused
 * by the local sign-in; Reconnect tells the running CLI `mcp_reconnect` and the item closes;
 * the D61 sign-in started from the agent reconnects the agent by itself when it finishes.
 */

const PORT = 4874;
const HOST = `127.0.0.1:${PORT}`;
const SERVERS = JSON.stringify([
  { name: 'docs', status: 'needs-auth', source: 'user' },
  { name: 'claude.ai Google Drive', status: 'needs-auth', source: 'claudeai' },
  { name: 'rider', status: 'connected', source: 'user' },
]);

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let mcp: McpService | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await mcp?.close();
  await world?.cleanup();
  app = undefined;
  mcp = undefined;
  world = undefined;
});

async function setup(): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld();
  world.env['FAKE_CLAUDE_INIT_MCP_SERVERS'] = SERVERS;
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
  await seedFolder(world.store, world.workspace);
  mcp = new McpService({ claudeCommand: fakeClaudeCommand(), env: world.env, pollMs: 50, settleTimeoutMs: 2_000, authTimeoutMs: 10_000 });
  app = await buildApp({ config: { ...base, port: PORT }, token, store: world.store, webRoot: world.root, supervisor: world.supervisor, mcp });
  await app.ready();
  return world;
}

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({ method, url, headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
}

async function session(id: string): Promise<Session> {
  return (await call('GET', `/api/sessions/${id}`)).json() as Session;
}

async function signInItems(): Promise<InboxItem[]> {
  return ((await call('GET', '/api/inbox')).json() as InboxItem[]).filter((item) => item.title.startsWith('Sign in to '));
}

async function sessionControls(w: SupervisorWorld): Promise<string[]> {
  const text = await readFile(w.logFile, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry['kind'] === 'stdin')
    .map((entry) => (JSON.parse(String(entry['line'])) as { request?: { subtype?: string } }).request?.subtype ?? '');
}

describe('D163 · MCP sign-in where it happens', () => {
  it('exposes the servers that need a sign-in, raises one item each, refuses a claude.ai connector, and Reconnect clears one', async () => {
    const w = await setup();
    const started = await w.supervisor.start(newSession({ task: 'Say hi.' }), w.place);
    await waitForStatus(w.store, started.id, ['done', 'idle']);

    expect((await session(started.id)).mcpSignIn).toEqual([
      { name: 'claude.ai Google Drive', claudeAi: true },
      { name: 'docs', claudeAi: false },
    ]);
    await until(async () => (await signInItems()).length === 2, 'two sign-in items', 10_000);
    const items = await signInItems();
    expect(items.map((item) => item.title).sort()).toEqual(['Sign in to claude.ai Google Drive', 'Sign in to docs']);
    expect(items.find((item) => item.title === 'Sign in to docs')?.detail).toContain('can’t use docs until you sign in again');

    // A claude.ai connector is signed in on claude.ai, not here.
    const refused = await call('POST', `/api/sessions/${started.id}/mcp-sign-in/${encodeURIComponent('claude.ai Google Drive')}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'claude-ai' });
    expect((await call('POST', `/api/sessions/${started.id}/mcp-sign-in/rider`)).statusCode).toBe(404);

    // Reconnect: the running CLI gets mcp_reconnect; docs leaves the list and its item closes.
    const reconnect = await call('POST', `/api/sessions/${started.id}/mcp-sign-in/docs/reconnect`);
    expect(reconnect.json()).toEqual({ server: 'docs', reconnected: [started.id], failed: [] });
    expect(await sessionControls(w)).toContain('mcp_reconnect');
    expect((await session(started.id)).mcpSignIn).toEqual([{ name: 'claude.ai Google Drive', claudeAi: true }]);
    await until(async () => (await signInItems()).map((item) => item.title).join() === 'Sign in to claude.ai Google Drive', 'the docs item closed', 10_000);
    const closed = (await w.store.systemItems.list(['closed'])).filter((item) => item.kind === 'mcp-sign-in');
    expect(closed.map((item) => item.closedAction)).toEqual(['resolved']);

    // The next turn's init says docs is connected now: it stays off the list.
    await w.supervisor.sendMessage(started.id, 'Again.');
    await waitForStatus(w.store, started.id, ['done', 'idle']);
    expect((await session(started.id)).mcpSignIn).toEqual([{ name: 'claude.ai Google Drive', claudeAi: true }]);
  }, 60_000);

  it('Sign in from the agent runs the D61 sign-in in its folder; when it finishes the agent reconnects by itself', async () => {
    const w = await setup();
    // The fake's `docs`: an HTTP server that needs a sign-in until signed in (user scope, the world's config dir).
    await writeFile(path.join(w.configDir, '.claude.json'), JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/mcp' } } }));
    const started = await w.supervisor.start(newSession({ task: 'Say hi.' }), w.place);
    await waitForStatus(w.store, started.id, ['done', 'idle']);
    expect((await session(started.id)).mcpSignIn?.map((need) => need.name)).toContain('docs');

    const flow = (await call('POST', `/api/sessions/${started.id}/mcp-sign-in/docs`)).json() as McpAuthState;
    expect(flow).toMatchObject({ server: 'docs', state: 'waiting', callbackExpected: true });
    // The browser opens the URL (the fake's /authorize redirects to its localhost callback).
    expect(await (await fetch(flow.authUrl as string)).text()).toContain('Authentication successful');
    await until(async () => ((await call('GET', `/api/mcp/auth/${flow.id}`)).json() as McpAuthState).state === 'done', 'the sign-in done', 10_000);

    // Signed in: the running agent was told to reconnect, and no longer lists docs.
    await until(async () => !((await session(started.id)).mcpSignIn ?? []).some((need) => need.name === 'docs'), 'docs reconnected', 10_000);
    expect(await sessionControls(w)).toContain('mcp_reconnect');
    await until(async () => !(await signInItems()).some((item) => item.title === 'Sign in to docs'), 'the docs item closed', 10_000);
  }, 60_000);
});
