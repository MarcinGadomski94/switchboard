import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliRegistry, cliCommandKey } from '../../../src/server/cli/registry.ts';
import { CliStatusService, codexSignIn, opencodeSignIn } from '../../../src/server/cli/status.ts';
import { claudeAdapter } from '../../../src/server/cli/claude.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { fakeClaudeCommand } from '../../../tools/fake-claude/command.ts';
import { fakeCodexCommand } from '../../../tools/fake-codex/command.ts';
import { fakeOpencodeCommand } from '../../../tools/fake-opencode/command.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await makeTempDir('cli-status');
  store = await openTempStore(dir);
});
afterEach(async () => {
  await store.close();
  await removeTempDir(dir);
});

const result = (code: number, stdout = '', stderr = '') => ({ code, signal: null, stdout, stderr, error: null, timedOut: false });

function service(env: NodeJS.ProcessEnv, commands: Record<string, readonly string[]> = {}, adapters = { codex: { ...claudeAdapter, id: 'codex' as const }, opencode: { ...claudeAdapter, id: 'opencode' as const } }) {
  const registry = new CliRegistry({
    commands: { claude: fakeClaudeCommand(), codex: fakeCodexCommand(), opencode: fakeOpencodeCommand(), ...commands },
    settings: store.settings,
    adapters,
  });
  return new CliStatusService({ registry, settings: store.settings, cwd: dir, env: { PATH: process.env['PATH'] ?? '', ...env } });
}

describe('D62 CLI status (Settings → CLIs)', () => {
  it('reads each CLI the CLI\'s own way: installed, version, signed in', async () => {
    const overview = await service({}).overview();
    expect(overview.default).toBe('claude');
    const [claude, codex, opencode] = overview.clis;
    expect(claude).toMatchObject({ provider: 'claude', label: 'Claude Code', installed: true, signedIn: true, available: true, reason: null, envVar: 'SWITCHBOARD_CLAUDE_BIN' });
    expect(codex).toMatchObject({ provider: 'codex', installed: true, version: 'codex-cli 0.159.3', signedIn: true, account: 'Logged in using ChatGPT', available: true, supported: true });
    expect(opencode).toMatchObject({ provider: 'opencode', installed: true, version: '1.18.34', signedIn: true, account: '1 credential', available: true });
    expect(codex?.install.docs).toMatch(/^https:\/\//);
  });

  it('not installed: cannot be chosen, with the reason; Claude Code stays choosable as before', async () => {
    const missing = path.join(dir, 'no-such-cli');
    const status = service({}, { claude: [missing], codex: [missing], opencode: [missing] });
    const overview = await status.overview();
    for (const cli of overview.clis) expect(cli).toMatchObject({ installed: false, version: null, signedIn: null, path: null });
    expect(overview.clis[0]?.available).toBe(true);
    expect(overview.clis[1]).toMatchObject({ available: false });
    expect(overview.clis[1]?.reason).toMatch(/^Codex CLI is not installed/);
    expect(await status.refusal('codex')).toMatch(/not installed/);
    expect(await status.refusal('claude')).toBeNull();
  });

  it('signed out: Codex is refused with its sign-in hint; OpenCode with no credentials is "unknown" (a local model needs none)', async () => {
    const status = service({ FAKE_CODEX_SIGNED_OUT: '1', FAKE_OPENCODE_SIGNED_OUT: '1' });
    const codex = await status.info('codex');
    expect(codex).toMatchObject({ installed: true, signedIn: false, available: false, account: 'Not logged in' });
    expect(codex.reason).toBe('Codex CLI is signed out: Run `codex login` in a terminal (ChatGPT account or an API key).');
    const opencode = await status.info('opencode');
    expect(opencode).toMatchObject({ installed: true, signedIn: null, available: true, account: '0 credentials' });
  });

  it('a Settings override wins over the environment for Codex / OpenCode; a provider without an adapter is not supported', async () => {
    const script = path.join(dir, 'other-codex.mjs');
    await writeFile(script, "process.stdout.write('codex-cli 9.9.9\\n');\n");
    await store.settings.set(cliCommandKey('codex'), [process.execPath, script]);
    const status = service({}, {}, {} as never);
    const codex = await status.info('codex', { refresh: true });
    expect(codex).toMatchObject({ commandSource: 'settings', version: 'codex-cli 9.9.9', supported: false, available: false, reason: 'Codex CLI is not supported by this Switchboard' });
    expect(codex.command).toEqual([process.execPath, script]);
  });

  it('caches a check and refreshes on demand; the default CLI is a settings row', async () => {
    const status = service({});
    const first = await status.info('opencode');
    expect(await status.info('opencode')).toBe(first);
    expect(await status.info('opencode', { refresh: true })).not.toBe(first);
    await status.setDefaultProvider('codex');
    expect((await status.overview()).default).toBe('codex');
  });

  it('parses the sign-in outputs defensively', () => {
    expect(codexSignIn(result(0, '', 'Logged in using an API key - sk-…\n'), {})).toEqual({ signedIn: true, account: 'Logged in using an API key - sk-…' });
    expect(codexSignIn(result(1, '', 'Not logged in\n'), {})).toEqual({ signedIn: false, account: 'Not logged in' });
    expect(codexSignIn(result(1, '', 'Not logged in\n'), { OPENAI_API_KEY: 'x' })).toEqual({ signedIn: null, account: 'an API key in the environment' });
    expect(opencodeSignIn(result(0, '┌  Credentials\n└  2 credentials\n'))).toEqual({ signedIn: true, account: '2 credentials' });
    expect(opencodeSignIn(result(0, '└  0 credentials\n┌  Environment\n└  1 environment variable\n'))).toEqual({ signedIn: true, account: '0 credentials, 1 environment variable' });
    expect(opencodeSignIn(result(1, ''))).toEqual({ signedIn: null, account: null });
  });
});
