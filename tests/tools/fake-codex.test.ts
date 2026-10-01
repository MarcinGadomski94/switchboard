import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeCodexCommand } from '../../tools/fake-codex/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';

let home: string;
beforeEach(async () => {
  home = await makeTempDir('fake-codex');
});
afterEach(async () => {
  await removeTempDir(home);
});

function run(args: readonly string[], env: Record<string, string> = {}, stdin = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const [cmd, ...prefix] = fakeCodexCommand();
  return new Promise((resolve) => {
    const child = spawn(cmd as string, [...prefix, ...args], { env: { PATH: process.env['PATH'] ?? '', CODEX_HOME: home, ...env }, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

describe('tools/fake-codex', () => {
  it('--version, login status (signed in / out on stderr, exit 0 / 1)', async () => {
    expect(await run(['--version'])).toMatchObject({ code: 0, stdout: 'codex-cli 0.159.3\n' });
    expect(await run(['login', 'status'])).toMatchObject({ code: 0, stderr: 'Logged in using ChatGPT\n' });
    expect(await run(['login', 'status'], { FAKE_CODEX_SIGNED_OUT: '1' })).toMatchObject({ code: 1, stderr: 'Not logged in\n' });
  });

  it('mcp add / list --json / get / remove keep the servers in CODEX_HOME', async () => {
    expect(JSON.parse((await run(['mcp', 'list', '--json'])).stdout)).toEqual([]);
    expect((await run(['mcp', 'add', 'docs', '--env', 'TOKEN=x', '--', 'node', 'server.js'])).code).toBe(0);
    expect((await run(['mcp', 'add', 'remote', '--url', 'https://example.com/mcp'])).code).toBe(0);
    const listed = JSON.parse((await run(['mcp', 'list', '--json'])).stdout) as Array<{ name: string; transport: Record<string, unknown> }>;
    expect(listed.map((server) => [server.name, server.transport['type']])).toEqual([
      ['docs', 'stdio'],
      ['remote', 'streamable_http'],
    ]);
    expect(listed[0]?.transport).toMatchObject({ command: 'node', args: ['server.js'], env: { TOKEN: 'x' } });
    expect((await run(['mcp', 'remove', 'docs'])).code).toBe(0);
    expect((await run(['mcp', 'get', 'docs'])).code).toBe(1);
  });

  it('app-server: requests before initialize are refused; no jsonrpc field is needed; unknown methods answer -32601', async () => {
    const lines = [
      { id: 1, method: 'model/list', params: {} },
      { id: 2, method: 'initialize', params: { clientInfo: { name: 't', title: null, version: '0' } } },
      { method: 'initialized' },
      { id: 3, method: 'no/such', params: {} },
      { id: 4, method: 'thread/resume', params: { threadId: 'nope' } },
    ];
    const { stdout, code } = await run(['app-server'], {}, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    expect(code).toBe(0);
    const answers = stdout.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(answers.find((answer) => answer['id'] === 1)).toEqual({ id: 1, error: { code: -32002, message: 'Not initialized' } });
    expect(answers.find((answer) => answer['id'] === 2)).toMatchObject({ result: { userAgent: 'codex_cli_rs/0.159.3 (fake-codex)' } });
    expect(answers.find((answer) => answer['id'] === 3)).toEqual({ id: 3, error: { code: -32601, message: 'Method not found: no/such' } });
    expect(answers.find((answer) => answer['id'] === 4)).toMatchObject({ error: { message: 'no rollout found for thread id nope' } });
  });
});
