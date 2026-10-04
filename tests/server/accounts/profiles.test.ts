import { lstat, mkdir, readFile, readdir, readlink, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountProfile } from '../../../src/core/accounts.ts';
import type { AccountsOverview } from '../../../src/core/api.ts';
import { AccountError } from '../../../src/server/accounts/service.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
});

async function make(): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld();
  return world;
}

describe('D63 · profiles: CRUD and folders', () => {
  it('a fresh store has the three built-in Default profiles (no folder override); a session before 0024 is on its Default', async () => {
    const w = await make();
    const list = await w.store.profiles.list();
    expect(list.map((p) => [p.id, p.cli, p.name, p.dir, p.builtin])).toEqual([
      ['default-claude', 'claude', 'Default', null, true],
      ['default-codex', 'codex', 'Default', null, true],
      ['default-opencode', 'opencode', 'Default', null, true],
    ]);
    expect(await w.accounts.envFor('default-claude', 'claude')).toEqual({});
    expect(await w.accounts.envFor(null, 'codex')).toEqual({});
  });

  it('creates a profile with its own folder (0700) under the data folder; the CLI variable points at it', async () => {
    const w = await make();
    const claude = await w.accounts.create({ cli: 'claude', name: '  Work  ' });
    expect(claude).toMatchObject({ name: 'Work', cli: 'claude', builtin: false, enabled: true, position: 1, shareSettings: true });
    expect(claude.dir).toBe(path.join(w.root, 'profiles', 'claude', claude.id));
    expect(((await stat(claude.dir as string)).mode & 0o777).toString(8)).toBe('700');
    expect(await w.accounts.envFor(claude.id, 'claude')).toEqual({ CLAUDE_CONFIG_DIR: claude.dir });
    const codex = await w.accounts.create({ cli: 'codex', name: 'Work' });
    expect(await w.accounts.envFor(codex.id, 'codex')).toEqual({ CODEX_HOME: codex.dir });
    const opencode = await w.accounts.create({ cli: 'opencode', name: 'Work' });
    expect(await w.accounts.envFor(opencode.id, 'opencode')).toEqual({ XDG_DATA_HOME: opencode.dir });
    // A profile id of another CLI gives no override.
    expect(await w.accounts.envFor(codex.id, 'claude')).toEqual({});
  });

  it('refuses a bad or duplicate name, renames, disables, reorders', async () => {
    const w = await make();
    await expect(w.accounts.create({ cli: 'claude', name: '' })).rejects.toMatchObject({ status: 422, field: 'name' });
    await expect(w.accounts.create({ cli: 'claude', name: 'x'.repeat(41) })).rejects.toMatchObject({ status: 422 });
    const a = await w.accounts.create({ cli: 'claude', name: 'Alpha' });
    const b = await w.accounts.create({ cli: 'claude', name: 'Beta' });
    await expect(w.accounts.create({ cli: 'claude', name: 'alpha' })).rejects.toMatchObject({ status: 409 });
    await w.accounts.create({ cli: 'codex', name: 'Alpha' });
    expect(await w.accounts.update(a.id, { name: 'Gamma', enabled: false })).toMatchObject({ name: 'Gamma', enabled: false });
    // D67: the built-in account can be renamed too (still unique per CLI); it stays the built-in one.
    await expect(w.accounts.update('default-claude', { name: 'beta' })).rejects.toMatchObject({ status: 409 });
    expect(await w.accounts.update('default-claude', { name: 'Mine' })).toMatchObject({ name: 'Mine', builtin: true });
    await expect(w.accounts.update(b.id, { enabled: 'yes' })).rejects.toMatchObject({ status: 422 });
    await w.accounts.reorder('claude', [b.id, 'default-claude', a.id]);
    expect((await w.store.profiles.list('claude')).map((p) => p.name)).toEqual(['Beta', 'Mine', 'Gamma']);
    await expect(w.accounts.reorder('claude', [b.id, 'nope'])).rejects.toBeInstanceOf(AccountError);
    expect((await w.accounts.list({ check: false })).filter((p) => p.cli === 'claude').map((p) => p.position)).toEqual([0, 1, 2]);
  });

  it('delete: never the Default, never while a process runs on it; sessions go back to the Default; a folder only with removeFiles and only inside profiles/', async () => {
    const w = await make();
    await expect(w.accounts.remove('default-claude', { live: () => false })).rejects.toMatchObject({ code: 'builtin' });
    const p = await w.accounts.create({ cli: 'claude', name: 'Work' });
    await expect(w.accounts.remove(p.id, { live: () => true })).rejects.toMatchObject({ code: 'in-use' });
    const session = await w.store.sessions.create({ name: 's1', claudeSessionId: 'c1', profileId: p.id });
    await w.accounts.remove(p.id, { live: () => false });
    expect((await w.store.sessions.get(session.id))?.profileId).toBeNull();
    // The folder stayed (no removeFiles).
    expect((await stat(p.dir as string)).isDirectory()).toBe(true);
    const q = await w.accounts.create({ cli: 'claude', name: 'Other' });
    await w.accounts.remove(q.id, { removeFiles: true, live: () => false });
    await expect(stat(q.dir as string)).rejects.toThrow();
    // A folder outside profiles/ (a hand-edited row) is never deleted.
    const outside = path.join(w.root, 'precious');
    await mkdir(outside);
    const r = await w.store.profiles.create({ cli: 'claude', name: 'Odd', dir: outside });
    await w.accounts.remove(r.id, { removeFiles: true, live: () => false });
    expect((await stat(outside)).isDirectory()).toBe(true);
  });
});

describe('D63 · sharing the Default\'s settings', () => {
  async function seedDefault(w: SupervisorWorld): Promise<void> {
    const d = w.configDir;
    await writeFile(path.join(d, 'settings.json'), '{"permissions":{}}');
    await writeFile(path.join(d, 'CLAUDE.md'), '# rules');
    await mkdir(path.join(d, 'agents'));
    await writeFile(path.join(d, 'agents', 'helper.md'), 'agent');
    await mkdir(path.join(d, 'projects', 'slug'), { recursive: true });
    await writeFile(path.join(d, 'projects', 'slug', 'c.jsonl'), '{}');
    await writeFile(path.join(d, '.credentials.json'), '{"never":"shared"}');
    await writeFile(path.join(d, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@example.test' }, mcpServers: { shared: { command: 'node' } } }));
  }

  it('Claude Code: settings, CLAUDE.md, agents are linked; the MCP servers merged; credentials, conversations and the account identity never', async () => {
    const w = await make();
    await seedDefault(w);
    const p = await w.accounts.create({ cli: 'claude', name: 'Work' });
    const dir = p.dir as string;
    expect((await lstat(path.join(dir, 'settings.json'))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(dir, 'settings.json'))).toBe(path.join(w.configDir, 'settings.json'));
    expect(await readFile(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('# rules');
    expect((await lstat(path.join(dir, 'agents'))).isSymbolicLink()).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(['.claude.json', 'CLAUDE.md', 'agents', 'settings.json']);
    const claudeJson = JSON.parse(await readFile(path.join(dir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(claudeJson).toEqual({ mcpServers: { shared: { command: 'node' } } });
  });

  it('shareSettings off: the folder stays empty; turning it on later links them; a profile\'s own file is never overwritten', async () => {
    const w = await make();
    await seedDefault(w);
    const p = await w.accounts.create({ cli: 'claude', name: 'Solo', shareSettings: false });
    expect(await readdir(p.dir as string)).toEqual([]);
    await writeFile(path.join(p.dir as string, 'CLAUDE.md'), 'own rules');
    await w.accounts.update(p.id, { shareSettings: true });
    expect(await readFile(path.join(p.dir as string, 'CLAUDE.md'), 'utf8')).toBe('own rules');
    expect((await lstat(path.join(p.dir as string, 'settings.json'))).isSymbolicLink()).toBe(true);
  });

  it('Codex: config.toml and AGENTS.md linked, auth.json and sessions never; OpenCode shares its config already (nothing to link)', async () => {
    const w = await make();
    await writeFile(path.join(w.codexHome, 'config.toml'), 'model = "x"');
    await writeFile(path.join(w.codexHome, 'AGENTS.md'), 'rules');
    await writeFile(path.join(w.codexHome, 'auth.json'), '{"never":"shared"}');
    await mkdir(path.join(w.codexHome, 'sessions'));
    const p = await w.accounts.create({ cli: 'codex', name: 'Work' });
    expect((await readdir(p.dir as string)).sort()).toEqual(['AGENTS.md', 'config.toml']);
    const oc = await w.accounts.create({ cli: 'opencode', name: 'Work' });
    expect(await readdir(oc.dir as string)).toEqual([]);
  });
});

describe('D63 · routes', () => {
  const PORT = 4873;
  const HOST = `127.0.0.1:${PORT}`;
  let token = '';

  async function setup(): Promise<void> {
    const w = await make();
    token = generateToken();
    const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
    await seedFolder(w.store, w.workspace);
    app = await buildApp({ config: { ...base, port: PORT }, token, store: w.store, webRoot: w.root, supervisor: w.supervisor });
    await app.ready();
  }

  function call(method: InjectOptions['method'], url: string, payload?: unknown) {
    return (app as FastifyInstance).inject({
      method,
      url,
      headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }

  it('lists, creates, edits, orders, deletes profiles and validates the rules', async () => {
    await setup();
    const first = (await call('GET', '/api/accounts')).json() as AccountsOverview;
    expect(first.profiles.map((p) => p.id)).toEqual(['default-claude', 'default-codex', 'default-opencode']);
    expect(first.settings.enabled).toBe(true);
    const created = await call('POST', '/api/accounts/profiles', { cli: 'claude', name: 'Work' });
    expect(created.statusCode).toBe(201);
    const profile = created.json() as AccountProfile;
    expect(profile).toMatchObject({ name: 'Work', builtin: false, signIn: 'unknown', sessions: 0 });
    expect(profile.signInCommand).toBe(`CLAUDE_CONFIG_DIR=${profile.dir} claude auth login --claudeai`);
    expect((await call('POST', '/api/accounts/profiles', { cli: 'nope', name: 'x' })).statusCode).toBe(422);
    expect((await call('POST', '/api/accounts/profiles', { cli: 'claude', name: 'Work' })).statusCode).toBe(409);
    expect((await call('PUT', `/api/accounts/profiles/${profile.id}`, { enabled: false })).json()).toMatchObject({ enabled: false });
    expect((await call('PUT', '/api/accounts/order', { cli: 'claude', order: [profile.id, 'default-claude'] })).json().profiles.filter((p: AccountProfile) => p.cli === 'claude').map((p: AccountProfile) => p.name)).toEqual(['Work', 'Default']);
    const rules = await call('PUT', '/api/accounts/settings', { enabled: false, thresholds: { fiveHourPct: 90 }, exhausted: { action: 'switch-cli', cli: 'codex' } });
    expect(rules.json()).toMatchObject({ enabled: false, thresholds: { enabled: true, fiveHourPct: 90, weeklyPct: 98 }, exhausted: { action: 'switch-cli', cli: 'codex' } });
    expect((await call('PUT', '/api/accounts/settings', { exhausted: { action: 'switch-cli', cli: null } })).statusCode).toBe(422);
    expect((await call('DELETE', '/api/accounts/profiles/default-claude')).statusCode).toBe(409);
    expect((await call('DELETE', `/api/accounts/profiles/${profile.id}`)).statusCode).toBe(204);
    expect((await call('GET', '/api/accounts')).json().profiles).toHaveLength(3);
  });

  it('a new session takes a profile: named (checked), else the rule\'s pick; the session carries it; the pin is stored', async () => {
    await setup();
    const w = world as SupervisorWorld;
    const profile = (await call('POST', '/api/accounts/profiles', { cli: 'claude', name: 'Work' })).json() as AccountProfile;
    const codexProfile = (await call('POST', '/api/accounts/profiles', { cli: 'codex', name: 'Work' })).json() as AccountProfile;
    const bad = await call('POST', '/api/sessions', { ...newSession({ name: 'bad' }), profileId: codexProfile.id });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0].field).toBe('profileId');
    // The rule's pick: the Default is first with allowance.
    const plain = await call('POST', '/api/sessions', newSession({ name: 'plain' }));
    expect(plain.statusCode).toBe(201);
    expect(plain.json()).toMatchObject({ profileId: 'default-claude', profileName: 'Default', profilePinned: false, accountSwitching: false });
    // Named: runs with that profile's folder.
    const named = await call('POST', '/api/sessions', { ...newSession({ name: 'named' }), profileId: profile.id });
    expect(named.statusCode).toBe(201);
    expect(named.json()).toMatchObject({ profileId: profile.id, profileName: 'Work' });
    await waitForStatus(w.store, named.json().id, ['done']);
    const log = await readFile(w.logFile, 'utf8');
    expect(log).toContain(JSON.stringify(profile.dir));
    const pinned = await call('PUT', `/api/sessions/${named.json().id}/profile-pin`, { pinned: true });
    expect(pinned.json()).toMatchObject({ profilePinned: true });
    expect((await call('PUT', `/api/sessions/${named.json().id}/profile-pin`, { pinned: 'x' })).statusCode).toBe(422);
    await until(async () => (await w.store.sessions.get(named.json().id))?.profilePinned === true, 'the pin');
  });
});
