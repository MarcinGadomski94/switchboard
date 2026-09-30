import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGetOutput, parseListOutput } from '../../src/core/mcp.ts';
import { runCommand } from '../../src/server/exec.ts';
import { McpHelper } from '../../src/server/mcp/helper.ts';
import { fakeClaudeCommand } from '../../tools/fake-claude/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';

/**
 * D61: fake-claude's `mcp` family and MCP control requests model the CLI's shapes:
 * the files it writes, the `mcp get` / `mcp list` text the core parsers read, the
 * `mcp_status` rows, `mcp_toggle` → `disabledMcpServers`, and a helper that ends
 * at EOF.
 */

let tmp: string;
let cwd: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  tmp = await makeTempDir('fake-mcp');
  cwd = path.join(tmp, 'project');
  await mkdir(cwd, { recursive: true });
  cwd = await realpath(cwd);
  env = { PATH: process.env['PATH'] ?? '', HOME: tmp, CLAUDE_CONFIG_DIR: path.join(tmp, 'cfg') };
});

afterEach(async () => {
  await removeTempDir(tmp);
});

const run = (...args: string[]) => runCommand(fakeClaudeCommand(), args, { cwd, env, timeoutMs: 20_000 });

describe('fake-claude mcp (D61)', () => {
  it('add-json / list / get / remove over .claude.json and .mcp.json', async () => {
    expect((await run('mcp', 'add-json', 'acme', JSON.stringify({ type: 'stdio', command: 'npx', args: ['acme'] }), '--scope', 'user')).stdout).toContain('Added stdio MCP server acme to user config');
    expect((await run('mcp', 'add-json', 'docs', JSON.stringify({ type: 'http', url: 'https://mcp.example.com/mcp' }), '-s', 'project')).code).toBe(0);
    expect((await run('mcp', 'add-json', 'bad name', '{}')).stderr).toContain('Names can only contain letters, numbers, hyphens, and underscores.');
    expect(JSON.parse(await readFile(path.join(cwd, '.mcp.json'), 'utf8'))).toEqual({ mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/mcp' } } });
    const list = await run('mcp', 'list');
    expect(parseListOutput(list.stdout)).toEqual([
      { name: 'docs', status: 'pending-approval', error: null },
      { name: 'acme', status: 'connected', error: null },
    ]);
    expect(parseGetOutput((await run('mcp', 'get', 'acme')).stdout)).toEqual({ status: 'connected', error: null });
    expect((await run('mcp', 'get', 'nope')).code).toBe(1);
    const removed = await run('mcp', 'remove', 'acme', '--scope', 'user');
    expect(removed.stdout).toContain('Removed MCP server acme from user config');
    const again = await run('mcp', 'remove', 'acme', '--scope', 'user');
    expect(again.code).toBe(1);
    expect(again.stderr).toBe('No MCP server named "acme" in user scope\n');
  });

  it('prints what CLI 2.1.285 prints for add-json and remove (real run, pre-release 1.3.0)', async () => {
    const added = await run('mcp', 'add-json', 'echo', JSON.stringify({ type: 'stdio', command: 'node', args: ['echo.mjs'] }), '--scope', 'local');
    expect(added.stdout).toBe('Added stdio MCP server echo to local config\n');
    const removed = await run('mcp', 'remove', 'echo', '--scope', 'local');
    expect(removed.stdout).toBe(`Removed MCP server echo from local config\nFile modified: ${path.join(tmp, 'cfg', '.claude.json')} [project: ${cwd}]\n`);
  });

  it('answers mcp_status / mcp_toggle / mcp_authenticate over stream-json and exits at EOF', async () => {
    await run('mcp', 'add-json', 'docs', JSON.stringify({ type: 'http', url: 'https://mcp.example.com/mcp' }), '--scope', 'local');
    const helper = await McpHelper.start({ claudeCommand: fakeClaudeCommand(), cwd, env });
    try {
      const status = await helper.request('mcp_status');
      expect(status).toMatchObject({ ok: true, response: { mcpServers: [{ name: 'docs', status: 'needs-auth', scope: 'local' }] } });
      expect(await helper.request('mcp_toggle', { serverName: 'docs', enabled: false })).toEqual({ ok: true, response: {} });
      const stored = JSON.parse(await readFile(path.join(tmp, 'cfg', '.claude.json'), 'utf8')) as { projects: Record<string, { disabledMcpServers: string[] }> };
      expect(stored.projects[cwd]?.disabledMcpServers).toEqual(['docs']);
      expect(await helper.request('mcp_reconnect', { serverName: 'nope' })).toEqual({ ok: false, error: 'Server not found: nope' });
      const auth = await helper.request('mcp_authenticate', { serverName: 'docs' });
      expect(auth).toMatchObject({ ok: true, response: { requiresUserAction: true, callbackExpected: true, redirectScheme: 'localhost' } });
    } finally {
      await helper.close();
    }
    expect(helper.running).toBe(false);
  });
});
