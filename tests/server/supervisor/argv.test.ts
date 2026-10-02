import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../../../src/server/supervisor/argv.ts';

/**
 * D31 oracle (unit): the spawn argv carries the session's stored model and effort
 * (`--model` / `--effort`) when it has them, and nothing extra when it has not
 * (the CLI's defaults, exactly as before).
 */
const BASE = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--permission-mode', 'auto'];
const TAIL = ['--name', 'Free talk', '--forward-subagent-text', '--replay-user-messages'];

describe('buildClaudeArgs · model and effort (D31)', () => {
  it('without a choice: no --model and no --effort (null or absent)', () => {
    const expected = [...BASE, '--resume', 'c-1', ...TAIL];
    expect(buildClaudeArgs({ start: { kind: 'resume', claudeSessionId: 'c-1' }, name: 'Free talk', permissionMode: 'auto' })).toEqual(expected);
    expect(buildClaudeArgs({ start: { kind: 'resume', claudeSessionId: 'c-1' }, name: 'Free talk', permissionMode: 'auto', model: null, effort: null })).toEqual(expected);
  });

  it('a model and an effort: --model and --effort after the session id, before --name', () => {
    expect(buildClaudeArgs({ start: { kind: 'resume', claudeSessionId: 'c-1' }, name: 'Free talk', permissionMode: 'auto', model: 'opus', effort: 'high' })).toEqual([
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
    expect(buildClaudeArgs({ start: { kind: 'new', claudeSessionId: 'c-2' }, name: 'Free talk', permissionMode: 'auto', model: 'claude-sonnet-4-6' })).toEqual([
      ...BASE,
      '--session-id',
      'c-2',
      '--model',
      'claude-sonnet-4-6',
      ...TAIL,
    ]);
    expect(
      buildClaudeArgs({ start: { kind: 'new', claudeSessionId: 'c-2' }, name: 'Free talk', permissionMode: 'auto', effort: 'xhigh', extraArgs: ['--max-turns', '3'] }),
    ).toEqual([...BASE, '--session-id', 'c-2', '--effort', 'xhigh', ...TAIL, '--max-turns', '3']);
  });
});

describe('buildClaudeArgs · standing instruction (D64)', () => {
  const START = { kind: 'resume', claudeSessionId: 'c-1' } as const;
  it('--append-system-prompt <text> goes before --name, one argv entry, on new and resumed sessions', () => {
    const text = "Ask only about what you wrote. Never say 'above'.";
    expect(buildClaudeArgs({ start: START, name: 'Free talk', permissionMode: 'auto', standingInstruction: text })).toEqual([
      ...BASE,
      '--resume',
      'c-1',
      '--append-system-prompt',
      text,
      ...TAIL,
    ]);
    expect(buildClaudeArgs({ start: { kind: 'new', claudeSessionId: 'c-2' }, name: 'Free talk', permissionMode: 'auto', standingInstruction: text })).toContain(text);
  });

  it('null, empty or absent: no flag', () => {
    const expected = [...BASE, '--resume', 'c-1', ...TAIL];
    for (const standingInstruction of [null, '', undefined]) {
      expect(buildClaudeArgs({ start: START, name: 'Free talk', permissionMode: 'auto', standingInstruction })).toEqual(expected);
    }
  });
});
