import { readFile, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_STANDING_INSTRUCTION, PREVIOUS_DEFAULT_STANDING_INSTRUCTIONS, currentStandingInstruction, readKnownSettings } from '../../../src/core/settings.ts';
import { AGENT_MCP_SCRIPT, agentMcpLaunch, claudeMcpArgs, codexMcpArgs, withClaudeConfigFile } from '../../../src/server/todos/agent-mcp.ts';
import { configContent } from '../../../src/server/cli/opencode/bridge.ts';
import { standingInstructionFor } from '../../../src/server/settings/settings.ts';
import { buildClaudeArgs } from '../../../src/server/supervisor/argv.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D68 oracle: every session Switchboard starts or resumes gets the built-in
 * `switchboard` MCP server, each CLI its own way, against the fakes (fake-claude's
 * argv, fake-codex's argv, fake-opencode's `OPENCODE_CONFIG_CONTENT`); the
 * developer's own configuration is added to, never replaced. Plus the standing
 * instruction's todo sentence.
 */
let world: SupervisorWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

const TOKEN = 'T'.repeat(43);

async function jsonLines(file: string): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function withAgentTools(w: SupervisorWorld): void {
  w.supervisor.useAgentMcp(async (session) => withClaudeConfigFile(w.root, session.id, agentMcpLaunch({ nodePath: '/usr/bin/node', port: 4981, sessionId: session.id, token: TOKEN })));
}

describe('the launch per CLI (pure)', () => {
  const launch = agentMcpLaunch({ nodePath: '/opt/node', port: 13001, sessionId: 's-1', token: TOKEN });

  it('runs the helper script with the port and session on the argv and the token in the environment', () => {
    expect(launch).toEqual({ name: 'switchboard', command: '/opt/node', args: [AGENT_MCP_SCRIPT, '--switchboard-mcp', '13001', 's-1'], env: { SWITCHBOARD_TODO_TOKEN: TOKEN }, claudeConfigFile: null });
    expect(AGENT_MCP_SCRIPT.endsWith('src/hook/sb-mcp.ts')).toBe(true);
  });

  it('Claude Code: --mcp-config (inline only without a file) and the allow rule, after the standing instruction', () => {
    const args = buildClaudeArgs({ start: { kind: 'new', claudeSessionId: 'c' }, name: 'n', permissionMode: 'auto', mcpArgs: claudeMcpArgs({ ...launch, claudeConfigFile: '/data/agent-mcp/s-1.json' }) });
    expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 4)).toEqual(['--mcp-config', '/data/agent-mcp/s-1.json', '--allowedTools', 'mcp__switchboard']);
    expect(args).not.toContain('--strict-mcp-config');
    expect(JSON.parse(claudeMcpArgs(launch)[1] as string)).toEqual({ mcpServers: { switchboard: { type: 'stdio', command: '/opt/node', args: launch.args, env: { SWITCHBOARD_TODO_TOKEN: TOKEN } } } });
  });

  it('Codex CLI: -c overrides with env_vars (the token stays off the argv)', () => {
    const args = codexMcpArgs(launch);
    expect(args).toEqual([
      '-c',
      'mcp_servers.switchboard.command="/opt/node"',
      '-c',
      `mcp_servers.switchboard.args=[${JSON.stringify(AGENT_MCP_SCRIPT)}, "--switchboard-mcp", "13001", "s-1"]`,
      '-c',
      'mcp_servers.switchboard.env_vars=["SWITCHBOARD_TODO_TOKEN"]',
    ]);
    expect(args.join(' ')).not.toContain(TOKEN);
  });

  it("OpenCode: an mcp.switchboard entry merged next to the environment's own servers and permissions", () => {
    const merged = JSON.parse(configContent('{"mcp":{"mine":{"type":"remote","url":"https://x.example"}},"permission":{"read":"deny"}}', launch)) as Record<string, Record<string, unknown>>;
    expect(merged['mcp']).toEqual({
      mine: { type: 'remote', url: 'https://x.example' },
      switchboard: { type: 'local', command: ['/opt/node', ...launch.args], environment: { SWITCHBOARD_TODO_TOKEN: TOKEN }, enabled: true },
    });
    expect(merged['permission']?.['read']).toBe('deny');
    expect(JSON.parse(configContent(undefined))).not.toHaveProperty('mcp');
  });
});

describe('injection at spawn, against the fakes', () => {
  it('Claude Code: a new session and its resume carry --mcp-config <0600 file> and --allowedTools mcp__switchboard', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    withAgentTools(w);
    const session = await w.supervisor.start(newSession({ task: 'first' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    await w.supervisor.resume(session.id);
    await waitForStatus(w.store, session.id, ['done']);
    const spawns = await until(async () => {
      const found = (await spawnedArgv(w.logFile)).filter((line) => line.argv?.includes('-p'));
      return found.length >= 2 ? found : undefined;
    }, 'two spawns');
    for (const spawn of spawns) {
      const argv = spawn.argv ?? [];
      const file = argv[argv.indexOf('--mcp-config') + 1] as string;
      expect(file).toBe(`${w.root}/agent-mcp/${session.id}.json`);
      expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('mcp__switchboard');
      expect(argv.join(' ')).not.toContain(TOKEN);
    }
    const file = `${w.root}/agent-mcp/${session.id}.json`;
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ mcpServers: { switchboard: { command: '/usr/bin/node', args: [AGENT_MCP_SCRIPT, '--switchboard-mcp', '4981', session.id], env: { SWITCHBOARD_TODO_TOKEN: TOKEN } } } });
  });

  it('without agent tools (none set): no flag', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await w.supervisor.start(newSession({ task: 'first' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const spawns = (await spawnedArgv(w.logFile)).filter((line) => line.argv?.includes('-p'));
    expect(spawns[0]?.argv).not.toContain('--mcp-config');
  });

  it('a launch that fails is reported and the session starts without it', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    w.supervisor.useAgentMcp(async () => {
      throw new Error('disk full');
    });
    const session = await w.supervisor.start(newSession({ task: 'first' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    expect((await spawnedArgv(w.logFile)).filter((line) => line.argv?.includes('-p'))[0]?.argv).not.toContain('--mcp-config');
    expect(w.errors.map(String)).toContain('Error: disk full');
  });

  it('Codex CLI: the overrides come before app-server', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    withAgentTools(w);
    const session = await w.supervisor.start({ ...newSession({ task: 'first' }), provider: 'codex' }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const argv = (await jsonLines(w.codexLog)).filter((line) => line['kind'] === 'argv').map((line) => line['argv'] as string[]).find((a) => a.includes('app-server'));
    expect(argv?.slice(0, 2)).toEqual(['-c', 'mcp_servers.switchboard.command="/usr/bin/node"']);
    expect(argv?.at(-1)).toBe('app-server');
    expect(argv).toContain('mcp_servers.switchboard.env_vars=["SWITCHBOARD_TODO_TOKEN"]');
  });

  it('OpenCode: OPENCODE_CONFIG_CONTENT carries mcp.switchboard', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    withAgentTools(w);
    const session = await w.supervisor.start({ ...newSession({ task: 'first' }), provider: 'opencode' }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const serve = (await jsonLines(w.opencodeLog)).find((line) => line['kind'] === 'argv' && (line['argv'] as string[]).includes('serve'));
    const content = JSON.parse(String((serve?.['env'] as Record<string, string>)['OPENCODE_CONFIG_CONTENT'])) as { mcp: Record<string, unknown> };
    expect(content.mcp['switchboard']).toEqual({ type: 'local', command: ['/usr/bin/node', AGENT_MCP_SCRIPT, '--switchboard-mcp', '4981', session.id], environment: { SWITCHBOARD_TODO_TOKEN: TOKEN }, enabled: true });
  });
});

describe('the standing instruction (D64 + D68 + D69 + D70 + D75)', () => {
  it('the default tells the agent to use the switchboard todo tools and fill every field, in one short sentence', () => {
    // D69: the bound went from 400 to 450 characters for the title / description / handover plan words; D70: to 510 for the plan / priority / estimate words (502);
    // D75: to 560 for "always mark an item in progress when you start it and done when you finish it" (550).
    expect(DEFAULT_STANDING_INSTRUCTION).toContain(
      "Todo list: when asked to add to it, use the switchboard todo tools with a title, short description, handover plan (or 'No plan: reason'), priority and estimate (minutes); revise those as you learn more; always mark an item in progress when you start it and done when you finish it; check it when asked what's left.",
    );
    expect(DEFAULT_STANDING_INSTRUCTION.length).toBeLessThan(560);
    expect(DEFAULT_STANDING_INSTRUCTION.startsWith(PREVIOUS_DEFAULT_STANDING_INSTRUCTIONS[0] as string)).toBe(true);
  });

  it('a stored earlier default reads as the new default; an edited text stays the developer’s', async () => {
    const old = PREVIOUS_DEFAULT_STANDING_INSTRUCTIONS[0] as string;
    expect(currentStandingInstruction(old)).toBe(DEFAULT_STANDING_INSTRUCTION);
    expect(currentStandingInstruction(`  ${old}  `)).toBe(DEFAULT_STANDING_INSTRUCTION);
    expect(currentStandingInstruction('My own rule.')).toBe('My own rule.');
    // D69: 1.7.0's default (D68's sentence) is a default too: it gets the new sentence.
    const d68 = PREVIOUS_DEFAULT_STANDING_INSTRUCTIONS[1] as string;
    expect(d68).toContain('use the switchboard todo tools; mark items done');
    expect(currentStandingInstruction(d68)).toBe(DEFAULT_STANDING_INSTRUCTION);
    expect(currentStandingInstruction(`${d68} And mine.`)).toBe(`${d68} And mine.`);
    // D70: 1.8.0's default (D69's sentence) is a default too: it gets the priority and estimate.
    const d69 = PREVIOUS_DEFAULT_STANDING_INSTRUCTIONS[2] as string;
    expect(d69).toContain('and fill a title, a short description and a handover plan from the conversation; mark items done');
    expect(currentStandingInstruction(d69)).toBe(DEFAULT_STANDING_INSTRUCTION);
    expect(currentStandingInstruction(`${d69}\nAlso be brief.`)).toBe(`${d69}\nAlso be brief.`);
    expect(readKnownSettings({ 'agents.standingInstruction': d69 })['agents.standingInstruction']).toBe(DEFAULT_STANDING_INSTRUCTION);
    expect(readKnownSettings({ 'agents.standingInstruction': old })['agents.standingInstruction']).toBe(DEFAULT_STANDING_INSTRUCTION);
    world = await makeSupervisorWorld({ standingInstruction: true });
    await world.store.settings.set('agents.standingInstruction', old);
    expect(await standingInstructionFor(world.store.settings)).toBe(DEFAULT_STANDING_INSTRUCTION);
    await world.store.settings.set('agents.standingInstruction', 'Mine.');
    expect(await standingInstructionFor(world.store.settings)).toBe('Mine.');
  });
});
