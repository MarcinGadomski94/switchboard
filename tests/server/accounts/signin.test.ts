import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SignInManager, type SignInState, isLoopbackUrl } from '../../../src/server/accounts/signin.ts';
import { type SupervisorWorld, makeSupervisorWorld, until } from '../../helpers/supervisor.ts';

let world: SupervisorWorld | undefined;
let manager: SignInManager | undefined;

afterEach(async () => {
  await manager?.close();
  await world?.cleanup();
  manager = undefined;
  world = undefined;
});

async function make(timeoutMs = 20_000): Promise<{ w: SupervisorWorld; m: SignInManager }> {
  const w = await makeSupervisorWorld();
  world = w;
  // Folders without a fake auth file are signed OUT in these tests (the fakes otherwise treat a folder as signed in).
  Object.assign(w.env, { FAKE_CLAUDE_AUTH_REQUIRED: '1', FAKE_CODEX_AUTH_REQUIRED: '1', FAKE_OPENCODE_AUTH_REQUIRED: '1', FAKE_CLAUDE_LOGIN_MS: '150', FAKE_CODEX_LOGIN_MS: '150', FAKE_OPENCODE_LOGIN_MS: '150' });
  const m = new SignInManager({ accounts: w.accounts, registry: w.registry, dataDir: w.root, env: w.env, timeoutMs, pollMs: 50 });
  manager = m;
  return { w, m };
}

async function settled(m: SignInManager, id: string): Promise<SignInState> {
  await until(async () => !['starting', 'waiting'].includes(m.get(id).state), `sign-in ${id} to end`, 15_000);
  return m.get(id);
}

describe('D63 · signing in from Switchboard', () => {
  it('Claude Code: runs `claude auth login --claudeai --email …` with the profile folder; the URL is captured; the status oracle ends it', async () => {
    const { w, m } = await make();
    const profile = await w.accounts.create({ cli: 'claude', name: 'Work' });
    expect(await w.accounts.check(profile.id)).toEqual({ signIn: 'signed-out', account: null });
    const started = await m.start(profile.id, { email: 'me@example.test' });
    // The page to open, from the CLI's own output (the UI opens it in a new tab).
    expect(started).toMatchObject({ state: 'waiting', cli: 'claude', profileId: profile.id, canPasteBack: true });
    expect(started.url).toMatch(/^https:\/\/login\.fake-claude\.example\.test\/oauth\/authorize\?client=fake&state=/);
    expect(started.command).toBe(`CLAUDE_CONFIG_DIR=${profile.dir} claude auth login --claudeai`);
    const done = await settled(m, started.id);
    expect(done).toMatchObject({ state: 'done', error: null });
    // The CLI's status now says signed in, with the account it reports.
    expect(await w.accounts.check(profile.id, { refresh: true })).toEqual({ signIn: 'signed-in', account: 'me@example.test · max' });
    // What ran: the fake's argv log (login, the folder, no BROWSER-less surprises).
    const log = (await readFile(w.logFile, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv?: string[]; env?: Record<string, string> });
    const login = log.find((entry) => entry.argv?.[0] === 'auth' && entry.argv[1] === 'login');
    expect(login?.argv).toEqual(['auth', 'login', '--claudeai', '--email', 'me@example.test']);
    expect(login?.env?.['CLAUDE_CONFIG_DIR']).toBe(profile.dir);
    // The sign-in wrote only the fake's own state file: the Default's folder is untouched.
    await expect(stat(path.join(w.configDir, '.fake-auth.json'))).rejects.toThrow();
  });

  it('the Default profile (the developer\'s own login) is never signed in or out here', async () => {
    const { m } = await make();
    await expect(m.start('default-claude')).rejects.toMatchObject({ status: 409, code: 'builtin' });
    await expect(m.signOut('default-claude')).rejects.toMatchObject({ status: 409, code: 'builtin' });
  });

  it('times out after the limit with clear instructions (the terminal command) and stops the CLI', async () => {
    const { w, m } = await make(500);
    w.env['FAKE_CLAUDE_LOGIN_MODE'] = 'never';
    const profile = await w.accounts.create({ cli: 'claude', name: 'Slow' });
    const started = await m.start(profile.id);
    expect(started.state).toBe('waiting');
    const ended = await settled(m, started.id);
    expect(ended.state).toBe('timeout');
    expect(ended.error).toContain('Run this in a terminal instead:');
    expect(ended.error).toContain(`CLAUDE_CONFIG_DIR=${profile.dir} claude auth login --claudeai`);
    expect(ended.canPasteBack).toBe(false);
    expect((await w.accounts.check(profile.id, { refresh: true })).signIn).toBe('signed-out');
  });

  it('cancel stops the login; a failed login says what the CLI said', async () => {
    const { w, m } = await make();
    w.env['FAKE_CLAUDE_LOGIN_MODE'] = 'never';
    const a = await w.accounts.create({ cli: 'claude', name: 'A' });
    const started = await m.start(a.id);
    expect((await m.cancel(started.id)).state).toBe('cancelled');
    w.env['FAKE_CLAUDE_LOGIN_MODE'] = 'fail';
    const b = await w.accounts.create({ cli: 'claude', name: 'B' });
    const failed = await settled(m, (await m.start(b.id)).id);
    expect(failed.state).toBe('failed');
    expect(failed.error).toContain('Login failed: the fake refused.');
  });

  it('paste-back: a code goes to the CLI\'s stdin; a loopback redirect URL is delivered from this machine; anything else is refused', async () => {
    const { w, m } = await make();
    w.env['FAKE_CLAUDE_LOGIN_MODE'] = 'code';
    const profile = await w.accounts.create({ cli: 'claude', name: 'Remote' });
    const started = await m.start(profile.id);
    await expect(m.paste(started.id, 'https://example.test/not-loopback')).rejects.toMatchObject({ status: 422 });
    await expect(m.paste(started.id, '   ')).rejects.toMatchObject({ status: 422 });
    await m.paste(started.id, 'abc123#state');
    expect((await settled(m, started.id)).state).toBe('done');
    await expect(m.paste(started.id, 'abc')).rejects.toMatchObject({ status: 409 });
    expect(isLoopbackUrl('http://localhost:1455/auth/callback?code=x')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:3000/cb')).toBe(true);
    expect(isLoopbackUrl('https://evil.example.test/localhost')).toBe(false);
    expect(isLoopbackUrl('file:///etc/passwd')).toBe(false);
  });

  it('sign out runs the CLI\'s logout for the profile and the status follows', async () => {
    const { w, m } = await make();
    const profile = await w.accounts.create({ cli: 'claude', name: 'Work' });
    await settled(m, (await m.start(profile.id)).id);
    expect((await w.accounts.check(profile.id, { refresh: true })).signIn).toBe('signed-in');
    expect(await m.signOut(profile.id)).toMatchObject({ ok: true });
    expect((await w.accounts.check(profile.id, { refresh: true })).signIn).toBe('signed-out');
  });

  it('Codex: `codex login` (and --device-auth with the code) with CODEX_HOME; sign out', async () => {
    const { w, m } = await make();
    const profile = await w.accounts.create({ cli: 'codex', name: 'Work' });
    expect((await w.accounts.check(profile.id)).signIn).toBe('signed-out');
    const started = await m.start(profile.id);
    expect(started).toMatchObject({ state: 'waiting', code: null });
    expect(started.url).toMatch(/^https:\/\/auth\.fake-codex\.example\.test\/oauth\/authorize\?state=/);
    expect((await settled(m, started.id)).state).toBe('done');
    expect((await w.accounts.check(profile.id, { refresh: true })).signIn).toBe('signed-in');
    const log = await readFile(w.codexLog, 'utf8');
    expect(log).toContain(JSON.stringify(profile.dir));
    expect(await m.signOut(profile.id)).toMatchObject({ ok: true });
    expect((await w.accounts.check(profile.id, { refresh: true })).signIn).toBe('signed-out');
    // The device-code flow: the verification page and the one-time code.
    const device = await m.start(profile.id, { deviceCode: true });
    await until(async () => m.get(device.id).code !== null, 'the device code');
    expect(m.get(device.id)).toMatchObject({ code: 'ABCD-12345', url: 'https://auth.fake-codex.example.test/codex/device' });
    expect((await settled(m, device.id)).state).toBe('done');
  });

  it('OpenCode: through `opencode serve` on the profile\'s data folder: the provider\'s OAuth page, then done; an API key goes to the server only; sign out removes the credentials', async () => {
    const { w, m } = await make();
    const profile = await w.accounts.create({ cli: 'opencode', name: 'Work' });
    expect((await w.accounts.check(profile.id)).signIn).toBe('signed-out');
    await expect(m.start(profile.id, {})).resolves.toMatchObject({ state: 'failed' });
    const started = await m.start(profile.id, { provider: 'anthropic' });
    expect(started).toMatchObject({ state: 'waiting', instructions: 'Complete the sign-in in your browser', canPasteBack: false });
    expect(started.url).toContain('https://login.fake-opencode.example.test/authorize?provider=anthropic');
    expect((await settled(m, started.id)).state).toBe('done');
    expect((await w.accounts.check(profile.id, { refresh: true })).signIn).toBe('signed-in');
    expect(await m.signOut(profile.id)).toMatchObject({ ok: true, message: 'Signed out of anthropic.' });
    expect((await w.accounts.check(profile.id, { refresh: true })).signIn).toBe('signed-out');
    // An API key: sent to the profile's own server, never stored or logged by Switchboard (or the fake).
    const key = 'sk-test-key-never-logged';
    const keyed = await m.start(profile.id, { provider: 'openai', apiKey: key });
    expect(keyed.state).toBe('done');
    expect((await w.accounts.check(profile.id, { refresh: true })).signIn).toBe('signed-in');
    expect(await readFile(w.opencodeLog, 'utf8')).not.toContain(key);
    await writeFile(path.join(w.root, 'noop'), '');
  });

  it('OpenCode "code" providers: the pasted code completes the sign-in', async () => {
    const { w, m } = await make();
    w.env['FAKE_OPENCODE_OAUTH_METHOD'] = 'code';
    const profile = await w.accounts.create({ cli: 'opencode', name: 'Code' });
    const started = await m.start(profile.id, { provider: 'anthropic' });
    expect(started).toMatchObject({ state: 'waiting', canPasteBack: true });
    await m.paste(started.id, 'the-code');
    expect((await settled(m, started.id)).state).toBe('done');
  });
});
