import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliRegistry } from '../../../src/server/cli/registry.ts';
import { CliStatusService } from '../../../src/server/cli/status.ts';
import { CliMcpError, CliMcpService, codexAddArgs, parseCliMcpInput, parseCodexMcpList, parseOpencodeMcpList } from '../../../src/server/mcp/cli-mcp.ts';
import { cliUsageWindows } from '../../../src/server/usage/wire.ts';
import { fakeClaudeCommand } from '../../../tools/fake-claude/command.ts';
import { fakeCodexCommand } from '../../../tools/fake-codex/command.ts';
import { fakeOpencodeCommand } from '../../../tools/fake-opencode/command.ts';
import { runCommand } from '../../../src/server/exec.ts';
import { type SupervisorWorld, makeSupervisorWorld } from '../../helpers/supervisor.ts';

let world: SupervisorWorld | undefined;
afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

describe('D62 P7 · parity pieces', () => {
  it('usage: Codex\'s rate-limit windows become footer rows while they have not reset', () => {
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    const usage = {
      provider: 'codex' as const,
      at: '',
      windows: [
        { pct: 12, minutes: 300, resetsAt: '2026-10-01T14:00:00.000Z' },
        { pct: 40, minutes: 10_080, resetsAt: '2026-10-04T00:00:00.000Z' },
        { pct: 99, minutes: 60, resetsAt: '2026-10-01T11:00:00.000Z' },
      ],
    };
    expect(cliUsageWindows(usage, now)).toEqual([
      { provider: 'codex', label: 'Codex 5h', pct: 12, resetsAt: '2026-10-01T14:00:00.000Z' },
      { provider: 'codex', label: 'Codex week', pct: 40, resetsAt: '2026-10-04T00:00:00.000Z' },
    ]);
    expect(cliUsageWindows(null, now)).toEqual([]);
  });

  it('MCP: Codex lists, adds and removes through `codex mcp` (secrets masked, env names only); OpenCode lists, Add / Remove are marked', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const registry = new CliRegistry({ commands: { claude: fakeClaudeCommand(), codex: fakeCodexCommand(), opencode: fakeOpencodeCommand() } });
    const clis = new CliStatusService({ registry, settings: w.store.settings, cwd: w.root, env: w.env });
    const mcp = new CliMcpService({ registry, clis, env: w.env });
    expect(await mcp.view('codex', w.workspace)).toMatchObject({ provider: 'codex', available: true, servers: [], canEdit: true });
    const added = await mcp.add('codex', { name: 'docs', command: 'node', args: ['server.js', '--token', 'abc123'], env: { API_KEY: 'secret' } }, w.workspace);
    expect(added.servers).toEqual([{ name: 'docs', transport: 'stdio', target: 'node server.js --token ••••', envNames: ['API_KEY'], enabled: true, status: null }]);
    expect(JSON.stringify(added)).not.toContain('secret');
    const remote = await mcp.add('codex', { name: 'remote', url: 'https://example.com/mcp?token=abc' }, w.workspace);
    expect(remote.servers.find((server) => server.name === 'remote')).toMatchObject({ transport: 'http', target: 'https://example.com/mcp?token=••••' });
    expect((await mcp.remove('codex', 'docs', w.workspace)).servers.map((server) => server.name)).toEqual(['remote']);
    await expect(mcp.remove('codex', 'nope', w.workspace)).rejects.toMatchObject({ status: 409, code: 'cli-failed' });

    expect(await mcp.view('opencode', w.workspace)).toMatchObject({ available: true, servers: [], canEdit: false });
    await runCommand(fakeOpencodeCommand(), ['mcp', '__fake-add', 'fs', JSON.stringify({ type: 'local', command: ['npx', 'fs-server'], enabled: true })], { cwd: w.root, env: w.env });
    expect((await mcp.view('opencode', w.workspace)).servers).toEqual([{ name: 'fs', transport: 'stdio', target: 'npx fs-server', envNames: [], enabled: true, status: 'connected' }]);
    await expect(mcp.add('opencode', { name: 'x', command: 'y' }, w.workspace)).rejects.toBeInstanceOf(CliMcpError);
    const missing = new CliMcpService({ registry: new CliRegistry({ commands: { codex: [path.join(w.root, 'nope')] } }), clis: new CliStatusService({ registry: new CliRegistry({ commands: { codex: [path.join(w.root, 'nope')] } }), settings: w.store.settings, cwd: w.root }), env: w.env });
    expect(await missing.view('codex', w.workspace)).toMatchObject({ available: false, reason: expect.stringMatching(/not installed/) });
  });

  it('MCP parsers and input', () => {
    expect(parseCodexMcpList('nope')).toBeNull();
    expect(parseOpencodeMcpList('\u001b[32m✓\u001b[39m fs connected\n    npx fs-server\n○ off disabled\n    https://x.test/mcp\n')).toEqual([
      { name: 'fs', transport: 'stdio', target: 'npx fs-server', envNames: [], enabled: true, status: 'connected' },
      { name: 'off', transport: 'http', target: 'https://x.test/mcp', envNames: [], enabled: false, status: 'disabled' },
    ]);
    expect(codexAddArgs({ name: 'a', command: 'node', args: ['s.js'], env: { K: 'v' } })).toEqual(['mcp', 'add', 'a', '--env', 'K=v', '--', 'node', 's.js']);
    expect(codexAddArgs({ name: 'b', url: 'https://x' })).toEqual(['mcp', 'add', 'b', '--url', 'https://x']);
    expect(() => parseCliMcpInput({ name: '-x', command: 'y' })).toThrow(CliMcpError);
    expect(() => parseCliMcpInput({ name: 'x' })).toThrow(/either a command/);
    expect(() => parseCliMcpInput({ name: 'x', url: 'ftp://y' })).toThrow(/http/);
    expect(parseCliMcpInput({ name: 'x', command: 'node', args: ['a'], env: { A: 'b' } })).toEqual({ name: 'x', command: 'node', args: ['a'], env: { A: 'b' } });
  });
});
