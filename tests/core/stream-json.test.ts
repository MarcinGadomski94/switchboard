import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LineSplitter, type StreamMessage, parseStreamLine } from '../../src/core/stream-json.ts';
import { controlErrorLine, controlSuccessLine, interruptLine, userMessageLine } from '../../src/core/stdin.ts';
import { FIXTURES_DIR } from '../../tools/fake-claude/fixtures.ts';

async function fixture(name: string): Promise<StreamMessage[]> {
  const text = await readFile(path.join(FIXTURES_DIR, `${name}.ndjson`), 'utf8');
  return text.split('\n').filter((line) => line.trim() !== '').map(parseStreamLine);
}

function only<K extends StreamMessage['kind']>(messages: StreamMessage[], kind: K): Array<Extract<StreamMessage, { kind: K }>> {
  return messages.filter((m): m is Extract<StreamMessage, { kind: K }> => m.kind === kind);
}

describe('parseStreamLine (M0 fixtures)', () => {
  it('parses every line of every recorded stdout fixture without an invalid line', async () => {
    const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.ndjson') && !f.endsWith('.stdin.ndjson'));
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const messages = await fixture(file.replace(/\.ndjson$/, ''));
      expect(messages.filter((m) => m.kind === 'invalid'), file).toEqual([]);
      expect(messages.length, file).toBeGreaterThan(0);
    }
  });

  it('multiturn: init per turn, replays, assistant blocks by message id, results, a rate-limit reading', async () => {
    const messages = await fixture('multiturn');
    const inits = only(messages, 'init');
    expect(inits).toHaveLength(2);
    expect(inits[0]).toMatchObject({ permissionMode: 'acceptEdits', version: '2.1.283', model: 'claude-haiku-4-5-20251001' });
    expect(only(messages, 'replay').map((m) => m.text)).toEqual([
      'Remember the code word: zeppelin. Reply with just OK.',
      'What code word did I ask you to remember? Reply with just the word.',
    ]);
    const assistant = only(messages, 'assistant');
    expect(assistant.map((m) => m.blocks[0]?.type)).toEqual(['thinking', 'text', 'thinking', 'text']);
    expect(assistant[0]?.messageId).toBe(assistant[1]?.messageId);
    const results = only(messages, 'result');
    expect(results.map((r) => [r.subtype, r.isError, r.text, r.terminalReason, r.taskNotification])).toEqual([
      ['success', false, 'OK', 'completed', false],
      ['success', false, 'zeppelin', 'completed', false],
    ]);
    expect(only(messages, 'rate-limit')[0]).toMatchObject({
      status: 'allowed',
      fiveHour: { utilization: 0.08, resetsAt: 1790552400 },
      sevenDay: { utilization: 0.17, resetsAt: 1790859600 },
    });
  });

  it('tool-use: tool_use blocks and tool_result pairs', async () => {
    const messages = await fixture('tool-use');
    const uses = only(messages, 'assistant').flatMap((m) => m.blocks).filter((b) => b.type === 'tool_use');
    expect(uses.map((b) => (b.type === 'tool_use' ? b.name : ''))).toEqual(['Write', 'Bash']);
    const results = only(messages, 'tool-result').flatMap((m) => m.results);
    expect(results.map((r) => r.toolUseId)).toEqual(uses.map((b) => (b.type === 'tool_use' ? b.id : '')));
    expect(results.every((r) => !r.isError && r.text !== '')).toBe(true);
  });

  it('subagent-forward: parent_tool_use_id, task lifecycle, subagent prompt', async () => {
    const messages = await fixture('subagent-forward');
    const started = only(messages, 'task-started')[0];
    expect(started).toMatchObject({ taskType: 'local_agent', subagentType: 'general-purpose', backgrounded: false });
    expect(only(messages, 'task-updated')[0]?.status).toBe('completed');
    expect(only(messages, 'task-notification')[0]).toMatchObject({ status: 'completed', summary: 'alpha line one' });
    const prompt = only(messages, 'user-text').find((m) => m.parentToolUseId);
    expect(prompt?.parentToolUseId).toBe(started?.toolUseId);
    expect(prompt?.interrupt).toBe(false);
    expect(only(messages, 'assistant').filter((m) => m.parentToolUseId === started?.toolUseId).length).toBeGreaterThan(0);
  });

  it('ask-2q / subagent-perm / ask-interrupt: can_use_tool requests and the cancel', async () => {
    const ask = only(await fixture('ask-2q'), 'can-use-tool')[0];
    expect(ask).toMatchObject({ toolName: 'AskUserQuestion', agentId: null });
    expect((ask?.input['questions'] as unknown[]).length).toBe(2);
    expect(ask?.toolUseId).toMatch(/^toolu_/);

    const perm = only(await fixture('subagent-perm'), 'can-use-tool')[0];
    expect(perm).toMatchObject({ toolName: 'Bash', agentId: 'afa78bb7ac165e7b7', decisionReason: 'This command requires approval' });
    const notification = only(await fixture('subagent-perm'), 'result').at(-1);
    expect(notification?.taskNotification).toBe(true);

    const interrupted = await fixture('ask-interrupt');
    const request = only(interrupted, 'can-use-tool')[0];
    expect(only(interrupted, 'control-cancel')[0]?.requestId).toBe(request?.requestId);
    expect(only(interrupted, 'control-response')[0]).toMatchObject({ requestId: 'req_interrupt_1', subtype: 'success' });
    expect(only(interrupted, 'user-text').find((m) => m.interrupt)?.text).toBe('[Request interrupted by user for tool use]');
    expect(only(interrupted, 'result')[0]).toMatchObject({ isError: true, terminalReason: 'aborted_tools' });
  });

  it('perm-auto: permission_denied', async () => {
    const denied = only(await fixture('perm-auto'), 'permission-denied')[0];
    expect(denied?.toolName).toBe('Write');
    expect(denied?.toolUseId).toMatch(/^toolu_/);
  });

  it('tool-use: system/thinking_tokens ticks (D19), the estimate restarting per model message', async () => {
    const ticks = only(await fixture('tool-use'), 'thinking-tokens');
    expect(ticks.map((t) => [t.estimatedTokens, t.estimatedTokensDelta, t.parentToolUseId])).toEqual([
      [50, 50, null],
      [100, 50, null],
      [228, 128, null],
      [50, 50, null],
      [128, 78, null],
    ]);
    expect(parseStreamLine('{"type":"system","subtype":"thinking_tokens","parent_tool_use_id":"toolu_1"}')).toMatchObject({
      kind: 'thinking-tokens',
      estimatedTokens: null,
      estimatedTokensDelta: null,
      parentToolUseId: 'toolu_1',
    });
  });

  it('D43: task_started of any type (is_backgrounded true / false / absent, workflow_name, ambient); task_updated\'s is_backgrounded', async () => {
    expect(only(await fixture('bg-bash'), 'task-started')[0]).toMatchObject({ taskType: 'local_bash', backgrounded: true, workflowName: null, ambient: false });
    const workflow = '{"type":"system","subtype":"task_started","task_id":"wbetnz0pi","tool_use_id":"toolu_1","description":"Audit HubSpot","task_type":"local_workflow","workflow_name":"hubspot-audit","session_id":"s","uuid":"u"}';
    expect(parseStreamLine(workflow)).toMatchObject({ kind: 'task-started', taskId: 'wbetnz0pi', toolUseId: 'toolu_1', taskType: 'local_workflow', description: 'Audit HubSpot', backgrounded: null, workflowName: 'hubspot-audit', ambient: false });
    expect(parseStreamLine('{"type":"system","subtype":"task_started","task_id":"s1","task_type":"monitor_ws","ambient":true}')).toMatchObject({ toolUseId: null, ambient: true });
    expect(parseStreamLine('{"type":"system","subtype":"task_updated","task_id":"b1","patch":{"is_backgrounded":true}}')).toMatchObject({ kind: 'task-updated', taskId: 'b1', status: null, backgrounded: true });
    expect(parseStreamLine('{"type":"system","subtype":"task_updated","task_id":"b1","patch":{"status":"completed"}}')).toMatchObject({ status: 'completed', backgrounded: null });
  });

  it('never throws: non-JSON, arrays and unknown types', () => {
    expect(parseStreamLine('not json').kind).toBe('invalid');
    expect(parseStreamLine('{broken').kind).toBe('invalid');
    expect(parseStreamLine('[1,2]').kind).toBe('invalid');
    expect(parseStreamLine('{"type":"brand_new","x":1}')).toMatchObject({ kind: 'other', type: 'brand_new', subtype: null });
    expect(parseStreamLine('{"type":"control_request","request_id":"r","request":{"subtype":"hook_callback"}}')).toMatchObject({
      kind: 'control-request',
      requestId: 'r',
      subtype: 'hook_callback',
    });
  });
});

describe('LineSplitter', () => {
  it('splits chunks at newlines, drops blank lines, strips CR, flushes a tail', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    splitter.push('{"a":1}\n{"b"');
    splitter.push(':2}\r\n\n{"c":3}');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    splitter.flush();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});

describe('stdin lines', () => {
  it('match the shapes recorded in M0', () => {
    expect(userMessageLine('hi')).toEqual({ type: 'user', message: { role: 'user', content: 'hi' } });
    expect(interruptLine('r1')).toEqual({ type: 'control_request', request_id: 'r1', request: { subtype: 'interrupt' } });
    expect(controlSuccessLine('r2', { behavior: 'deny', message: 'no' })).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r2', response: { behavior: 'deny', message: 'no' } },
    });
    expect(controlErrorLine('r3', 'nope')).toEqual({ type: 'control_response', response: { subtype: 'error', request_id: 'r3', error: 'nope' } });
  });
});
