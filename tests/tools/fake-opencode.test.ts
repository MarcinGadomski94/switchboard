import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeOpencodeCommand } from '../../tools/fake-opencode/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';

let data: string;
beforeEach(async () => {
  data = await makeTempDir('fake-opencode');
});
afterEach(async () => {
  await removeTempDir(data);
});

function run(args: readonly string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const [cmd, ...prefix] = fakeOpencodeCommand();
  return new Promise((resolve) => {
    const child = spawn(cmd as string, [...prefix, ...args], { env: { PATH: process.env['PATH'] ?? '', XDG_DATA_HOME: data, ...env }, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('tools/fake-opencode', () => {
  it('--version, auth list (N credentials), models, session list / export, mcp list', async () => {
    expect(await run(['--version'])).toMatchObject({ code: 0, stdout: '1.18.34\n' });
    expect((await run(['auth', 'list'])).stdout).toMatch(/└ {2}1 credentials\n$/);
    expect((await run(['auth', 'list'], { FAKE_OPENCODE_SIGNED_OUT: '1' })).stdout).toMatch(/0 credentials/);
    expect((await run(['models'])).stdout).toBe('anthropic/claude-sonnet-5\nopenai/gpt-5.5\n');
    expect(await run(['models', 'nope'])).toMatchObject({ code: 1, stderr: 'Provider not found: nope\n' });
    expect(JSON.parse((await run(['session', 'list', '--format', 'json'])).stdout)).toEqual([]);
    expect(await run(['export', 'ses_x'])).toMatchObject({ code: 1 });
    expect((await run(['mcp', 'list'])).stdout).toBe('No MCP servers configured\n');
  });

  it('serve: refuses requests without the password; prints its address', async () => {
    const [cmd, ...prefix] = fakeOpencodeCommand();
    const child = spawn(cmd as string, [...prefix, 'serve', '--hostname', '127.0.0.1', '--port', '0'], { env: { PATH: process.env['PATH'] ?? '', XDG_DATA_HOME: data, OPENCODE_SERVER_PASSWORD: 'pw' }, shell: false });
    try {
      const url = await new Promise<string>((resolve) => {
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          const found = /opencode server listening on (\S+)/.exec(chunk);
          if (found?.[1]) resolve(found[1]);
        });
      });
      expect((await fetch(`${url}/global/health`)).status).toBe(401);
      const ok = await fetch(`${url}/global/health`, { headers: { authorization: `Basic ${Buffer.from('opencode:pw').toString('base64')}` } });
      expect(await ok.json()).toEqual({ healthy: true, version: '1.18.34' });
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
    }
  });
});
