import { describe, expect, it } from 'vitest';
import { CHAT_DISALLOWED_TOOLS, CHAT_PERMISSION_MODE, CHAT_SWITCHBOARD_TOOLS_LINE, chatInstruction, isSwitchboardTool } from '../../../src/core/chats.ts';
import { buildClaudeArgs } from '../../../src/server/supervisor/argv.ts';
import { agentMcpLaunch, claudeMcpArgs } from '../../../src/server/todos/agent-mcp.ts';

/**
 * D31 oracle (unit): the spawn argv carries the session's stored model and effort
 * (`--model` / `--effort`) when it has them, and nothing extra when it has not
 * (the CLI's defaults, exactly as before).
 */
const BASE = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--permission-mode', 'auto'];
const TAIL = ['--name', 'Checkout', '--forward-subagent-text', '--replay-user-messages'];

describe('buildClaudeArgs · model and effort (D31)', () => {
  it('without a choice: no --model and no --effort (null or absent)', () => {
    const expected = [...BASE, '--resume', 'c-1', ...TAIL];
    expect(buildClaudeArgs({ start: { kind: 'resume', claudeSessionId: 'c-1' }, name: 'Checkout', permissionMode: 'auto' })).toEqual(expected);
    expect(buildClaudeArgs({ start: { kind: 'resume', claudeSessionId: 'c-1' }, name: 'Checkout', permissionMode: 'auto', model: null, effort: null })).toEqual(expected);
  });

  it('a model and an effort: --model and --effort after the session id, before --name', () => {
    expect(buildClaudeArgs({ start: { kind: 'resume', claudeSessionId: 'c-1' }, name: 'Checkout', permissionMode: 'auto', model: 'opus', effort: 'high' })).toEqual([
      ...BASE,
      '--resume',
      'c-1',
      '--model',
      'opus',
      '--effort',
      'high',
      ...TAIL,
    ]);
  });

  it('each one alone, on a new session too; dev-only extra args still come last', () => {
    expect(buildClaudeArgs({ start: { kind: 'new', claudeSessionId: 'c-2' }, name: 'Checkout', permissionMode: 'auto', model: 'claude-sonnet-4-6' })).toEqual([
      ...BASE,
      '--session-id',
      'c-2',
      '--model',
      'claude-sonnet-4-6',
      ...TAIL,
    ]);
    expect(
      buildClaudeArgs({ start: { kind: 'new', claudeSessionId: 'c-2' }, name: 'Checkout', permissionMode: 'auto', effort: 'xhigh', extraArgs: ['--max-turns', '3'] }),
    ).toEqual([...BASE, '--session-id', 'c-2', '--effort', 'xhigh', ...TAIL, '--max-turns', '3']);
  });
});

describe('buildClaudeArgs · standing instruction (D64)', () => {
  const START = { kind: 'resume', claudeSessionId: 'c-1' } as const;
  it('--append-system-prompt <text> goes before --name, one argv entry, on new and resumed sessions', () => {
    const text = "Ask only about what you wrote. Never say 'above'.";
    expect(buildClaudeArgs({ start: START, name: 'Checkout', permissionMode: 'auto', standingInstruction: text })).toEqual([
      ...BASE,
      '--resume',
      'c-1',
      '--append-system-prompt',
      text,
      ...TAIL,
    ]);
    expect(buildClaudeArgs({ start: { kind: 'new', claudeSessionId: 'c-2' }, name: 'Checkout', permissionMode: 'auto', standingInstruction: text })).toContain(text);
  });

  it('null, empty or absent: no flag', () => {
    const expected = [...BASE, '--resume', 'c-1', ...TAIL];
    for (const standingInstruction of [null, '', undefined]) {
      expect(buildClaudeArgs({ start: START, name: 'Checkout', permissionMode: 'auto', standingInstruction })).toEqual(expected);
    }
  });
});

/**
 * D106 follow-up (2026-10-28, "chats should have access to write artifacts"): a chat's exact
 * argv pre-approves Switchboard's whole MCP server (`mcp__switchboard` covers artifact_save and
 * the todo tools) next to the web tools, keeps plan mode and the disallowed editors / shells, and
 * its instruction says Switchboard's tools are allowed (artifacts are not files in a project).
 */
describe('buildClaudeArgs · a chat (D106) keeps the switchboard MCP tools', () => {
  const launch = agentMcpLaunch({ nodePath: '/usr/bin/node', port: 4600, sessionId: 's-chat', token: 't' });
  const mcpArgs = claudeMcpArgs(launch);
  const instruction = chatInstruction(['/work/repo']);

  it('the exact argv: plan mode, the instruction, the MCP config, --allowedTools mcp__switchboard,WebFetch,WebSearch, --disallowedTools, --add-dir', () => {
    expect(buildClaudeArgs({ start: { kind: 'new', claudeSessionId: 'c-9' }, name: 'Chat', permissionMode: CHAT_PERMISSION_MODE, standingInstruction: instruction, mcpArgs, readOnly: { lookAt: ['/work/repo'] } })).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      'plan',
      '--session-id',
      'c-9',
      '--append-system-prompt',
      instruction,
      '--mcp-config',
      mcpArgs[1],
      '--allowedTools',
      'mcp__switchboard,WebFetch,WebSearch',
      '--disallowedTools',
      CHAT_DISALLOWED_TOOLS.join(','),
      '--add-dir',
      '/work/repo',
      ...TAIL.map((arg) => (arg === 'Checkout' ? 'Chat' : arg)),
    ]);
    // None of Switchboard's tools is disallowed.
    expect(CHAT_DISALLOWED_TOOLS.some((tool) => tool.startsWith('mcp__'))).toBe(false);
  });

  it('the instruction allows artifact_save (content) and the todo tools, says artifacts are not files, and keeps the read-only rules', () => {
    expect(instruction).toContain(CHAT_SWITCHBOARD_TOOLS_LINE);
    expect(instruction).toContain('artifact_save');
    expect(instruction).toContain('as content');
    expect(instruction).toContain('todo tools');
    expect(instruction).toContain('not as files in a project');
    expect(instruction).toContain('never edit or write files');
    expect(instruction).toContain('You have no shell');
    expect(instruction).not.toContain('loop_create');
  });

  it("isSwitchboardTool: only Switchboard's own MCP tools (Claude Code / Codex and OpenCode names)", () => {
    for (const name of ['mcp__switchboard__artifact_save', 'mcp__switchboard__todo_add', 'switchboard_artifact_save']) expect(isSwitchboardTool(name)).toBe(true);
    for (const name of ['Write', 'Bash', 'ExitPlanMode', 'mcp__other__save', 'mcp__switchboard-x__save', 'mcp__switchboard__', 'mcp__switchboard', 'WebFetch']) expect(isSwitchboardTool(name)).toBe(false);
  });
});
