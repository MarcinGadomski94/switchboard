import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliInfo, CliOverview, Session } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { CliStatusService } from '../../../src/server/cli/status.ts';
import { CliRegistry } from '../../../src/server/cli/registry.ts';
import { claudeAdapter } from '../../../src/server/cli/claude.ts';
import { fakeClaudeCommand } from '../../../tools/fake-claude/command.ts';
import { fakeCodexCommand } from '../../../tools/fake-codex/command.ts';
import { fakeOpencodeCommand } from '../../../tools/fake-opencode/command.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

const PORT = 4872;
const HOST = `127.0.0.1:${PORT}`;

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

async function setup(statusEnv: NodeJS.ProcessEnv = {}): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld({ scenario: 'default' });
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
  await seedFolder(world.store, world.workspace);
  // The status service's registry has an adapter for every CLI (the routes' rules, whatever this build's adapters are).
  const registry = new CliRegistry({
    commands: { claude: fakeClaudeCommand(), codex: fakeCodexCommand(), opencode: fakeOpencodeCommand() },
    settings: world.store.settings,
    adapters: { codex: { ...claudeAdapter, id: 'codex' }, opencode: { ...claudeAdapter, id: 'opencode' } },
  });
  const clis = new CliStatusService({ registry, settings: world.store.settings, cwd: world.root, env: { ...world.env, ...statusEnv } });
  app = await buildApp({ config: { ...base, port: PORT }, token, store: world.store, webRoot: world.root, supervisor: world.supervisor, clis });
  await app.ready();
  return world;
}

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
});

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

describe('D62 /api/clis', () => {
  it('lists the three CLIs with their state; the default is Claude Code on a fresh install', async () => {
    await setup();
    const response = await call('GET', '/api/clis');
    expect(response.statusCode).toBe(200);
    const overview = response.json() as CliOverview;
    expect(overview.default).toBe('claude');
    expect(overview.clis.map((cli) => [cli.provider, cli.installed])).toEqual([
      ['claude', true],
      ['codex', true],
      ['opencode', true],
    ]);
  });

  it('PUT default: a known, available CLI is stored; an unknown or unavailable one is a 422 with the reason', async () => {
    await setup({ FAKE_CODEX_SIGNED_OUT: '1' });
    expect((await call('PUT', '/api/clis/default', { provider: 'gpt' })).statusCode).toBe(422);
    const refused = await call('PUT', '/api/clis/default', { provider: 'codex' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().errors[0]).toEqual({ field: 'provider', message: expect.stringMatching(/^Codex CLI is signed out/) });
    const stored = await call('PUT', '/api/clis/default', { provider: 'opencode' });
    expect(stored.statusCode).toBe(200);
    expect((stored.json() as CliOverview).default).toBe('opencode');
    expect((await call('GET', '/api/clis')).json().default).toBe('opencode');
  });

  it('PUT command: an override for Codex / OpenCode (null resets it); Claude Code\'s stays the environment\'s', async () => {
    const w = await setup();
    const claude = await call('PUT', '/api/clis/claude/command', { command: ['x'] });
    expect(claude.statusCode).toBe(422);
    expect(claude.json().errors[0].message).toContain('SWITCHBOARD_CLAUDE_BIN');
    expect((await call('PUT', '/api/clis/codex/command', { command: 'codex' })).statusCode).toBe(422);
    expect((await call('PUT', '/api/clis/codex/command', { command: [''] })).statusCode).toBe(422);
    expect((await call('PUT', '/api/clis/nope/command', { command: ['x'] })).statusCode).toBe(404);
    const missing = await call('PUT', '/api/clis/codex/command', { command: [`${w.root}/missing-codex`] });
    expect(missing.statusCode).toBe(200);
    expect(missing.json() as CliInfo).toMatchObject({ commandSource: 'settings', installed: false, available: false });
    const reset = await call('PUT', '/api/clis/codex/command', { command: null });
    expect(reset.json() as CliInfo).toMatchObject({ installed: true, available: true });
  });

  it('POST check runs the checks again; GET /api/models takes ?provider=', async () => {
    await setup();
    const checked = await call('POST', '/api/clis/opencode/check');
    expect(checked.statusCode).toBe(200);
    expect((checked.json() as CliInfo).provider).toBe('opencode');
    expect((await call('GET', '/api/models?provider=codex')).json()).toEqual({ options: null, last: null });
    expect((await call('GET', '/api/models?provider=nope')).statusCode).toBe(422);
    expect((await call('GET', '/api/models')).json()).toEqual({ options: null, last: null });
  });

  it('POST /api/sessions: provider is validated; a session started without one runs on the default CLI and says so', async () => {
    await setup();
    const unknown = await call('POST', '/api/sessions', { ...newSession(), provider: 'gpt' });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().errors).toEqual([{ field: 'provider', message: 'provider must be claude, codex or opencode' }]);
    const started = await call('POST', '/api/sessions', newSession({ name: 'on-claude' }));
    expect(started.statusCode).toBe(201);
    expect((started.json() as Session).provider).toBe('claude');
  });

  it('POST /api/sessions on Codex: 201, the session says codex, its terminal command is `codex resume <thread>`; a signed-out Codex is a 422 with the reason', async () => {
    const w = await setup();
    const started = await call('POST', '/api/sessions', { ...newSession({ name: 'on-codex' }), provider: 'codex' });
    expect(started.statusCode).toBe(201);
    const session = started.json() as Session;
    expect(session.provider).toBe('codex');
    await waitForStatus(w.store, session.id, ['done']);
    const thread = await w.store.providers.nativeId(session.id, 'codex');
    expect((await call('GET', `/api/sessions/${session.id}`)).json().resumeCommand).toBe(`codex resume ${thread}`);
    // D42 per CLI: a start that names a model is Codex's last choice, not Claude Code's.
    const picked = await call('POST', '/api/sessions', { ...newSession({ name: 'codex-model' }), provider: 'codex', model: 'gpt-5.5-mini', effort: 'low' });
    expect(picked.statusCode).toBe(201);
    expect((await call('GET', '/api/models?provider=codex')).json().last).toEqual({ model: 'gpt-5.5-mini', effort: 'low' });
    expect((await call('GET', '/api/models')).json().last).toBeNull();
  });
});

describe('D62 /api/sessions with a CLI that cannot be chosen', () => {
  it('422 on field provider with the reason', async () => {
    await setup({ FAKE_CODEX_SIGNED_OUT: '1' });
    const refused = await call('POST', '/api/sessions', { ...newSession({ name: 'signed-out' }), provider: 'codex' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().errors).toEqual([{ field: 'provider', message: expect.stringMatching(/^Codex CLI is signed out/) }]);
  });
});

describe('D62 P5 POST /api/sessions/{id}/provider', () => {
  it('202 with the switch started; the session ends on the new CLI; 422 / 404 / 409 refusals', async () => {
    const w = await setup();
    const started = await call('POST', '/api/sessions', newSession({ name: 'to-switch' }));
    const session = started.json() as Session;
    await waitForStatus(w.store, session.id, ['done']);
    expect((await call('POST', `/api/sessions/${session.id}/provider`, { provider: 'gpt' })).statusCode).toBe(422);
    expect((await call('POST', '/api/sessions/nope/provider', { provider: 'codex' })).statusCode).toBe(404);
    const same = await call('POST', `/api/sessions/${session.id}/provider`, { provider: 'claude' });
    expect(same.statusCode).toBe(409);
    expect(same.json()).toMatchObject({ error: 'switching', message: 'to-switch already runs on Claude Code' });
    const switched = await call('POST', `/api/sessions/${session.id}/provider`, { provider: 'codex' });
    expect(switched.statusCode).toBe(202);
    expect(switched.json()).toMatchObject({ session: { id: session.id, providerSwitch: { from: 'claude', to: 'codex', step: 'handover' } }, switchId: expect.any(String) });
    await until(async () => ((await call('GET', `/api/sessions/${session.id}`)).json() as Session).provider === 'codex', 'the switch');
    await until(async () => ((await call('GET', `/api/sessions/${session.id}`)).json() as Session).providerSwitch === null, 'the switch to finish');
  });
});
