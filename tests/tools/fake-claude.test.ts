import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from '../../tools/fake-claude/fixtures.ts';
import { type JsonObject, parseNdjson } from '../../tools/fake-claude/json.ts';
import {
  BASELINE,
  type FakeEnv,
  type FakeRun,
  delay,
  interruptLine,
  kind,
  listTranscripts,
  makeFakeEnv,
  readTranscript,
  spawnFake,
  transcriptPath,
  userLine,
} from '../helpers/fake-claude.ts';

/** The recorded stdout of a fixture scenario. */
async function raw(name: string): Promise<JsonObject[]> {
  return parseNdjson(await readFile(path.join(FIXTURES_DIR, `${name}.ndjson`), 'utf8'));
}

/** The recorded stdin of a fixture scenario. */
async function rawStdin(name: string): Promise<JsonObject[]> {
  return parseNdjson(await readFile(path.join(FIXTURES_DIR, `${name}.stdin.ndjson`), 'utf8'));
}

function obj(value: unknown): JsonObject {
  return value as JsonObject;
}

function contentOf(line: JsonObject): JsonObject[] {
  return obj(line['message'])['content'] as JsonObject[];
}

function toolResult(line: JsonObject): JsonObject {
  return contentOf(line).find((b) => b['type'] === 'tool_result') as JsonObject;
}

function textOf(line: JsonObject): string {
  const content = obj(line['message'])['content'];
  if (typeof content === 'string') return content;
  return (content as JsonObject[]).map((b) => (typeof b['text'] === 'string' ? b['text'] : '')).join('');
}

const isResult = (l: JsonObject): boolean => l['type'] === 'result';
const isRequest = (l: JsonObject): boolean => l['type'] === 'control_request';
const isRateLimit = (l: JsonObject): boolean => l['type'] === 'rate_limit_event';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SID = '5e0c9a52-0000-4000-8000-00000000c1a0';

let env: FakeEnv;
let runs: FakeRun[] = [];

function start(args: readonly string[], extraEnv: Record<string, string> = {}, cwd?: string): FakeRun {
  const run = spawnFake(args, { cwd: cwd ?? env.cwd, env: { CLAUDE_CONFIG_DIR: env.configDir, ...extraEnv } });
  runs.push(run);
  return run;
}

beforeEach(async () => {
  env = await makeFakeEnv('fake-claude');
  runs = [];
});

afterEach(async () => {
  for (const run of runs) {
    if (run.child.exitCode === null && run.child.signalCode === null) {
      run.kill('SIGKILL');
      await run.exited;
    }
  }
  await env.cleanup();
});

describe('fake-claude stream-json turns', () => {
  it('multiturn: one result per stdin message, init per turn, replay echoes, ids rewritten, EOF → exit 0', async () => {
    const recorded = await raw('multiturn');
    const fake = start([...BASELINE, '--session-id', SID, '--replay-user-messages'], { FAKE_CLAUDE_SCENARIO: 'multiturn' });
    fake.send(userLine('Remember the code word: zeppelin. Reply with just OK.'));
    const first = await fake.waitFor(isResult);
    expect(first['result']).toBe('OK');
    expect(first['result_index']).toBe(0);
    fake.send(userLine('What code word?'));
    const second = await fake.waitFor(isResult, 2);
    expect(second['result']).toBe('zeppelin');
    expect(second['result_index']).toBe(1);
    fake.end();
    expect((await fake.exited).code).toBe(0);

    expect(fake.lines.map(kind)).toEqual(recorded.map(kind));
    for (const line of fake.lines) expect(line['session_id']).toBe(SID);
    const inits = fake.lines.filter((l) => kind(l) === 'system/init');
    expect(inits).toHaveLength(2);
    for (const init of inits) {
      expect(init['cwd']).toBe(env.cwd);
      expect(init['permissionMode']).toBe('auto');
      expect(init['tools']).toContain('AskUserQuestion');
    }
    const replays = fake.lines.filter((l) => l['isReplay'] === true);
    expect(replays.map(textOf)).toEqual(['Remember the code word: zeppelin. Reply with just OK.', 'What code word?']);
    const recordedUuids = new Set(recorded.map((l) => l['uuid']));
    for (const line of fake.lines) {
      if (typeof line['uuid'] === 'string') {
        expect(line['uuid']).toMatch(UUID);
        expect(recordedUuids.has(line['uuid'])).toBe(false);
      }
    }
    const msgIds = new Set(fake.lines.filter((l) => l['type'] === 'assistant').map((l) => obj(l['message'])['id']));
    expect(msgIds.size).toBe(2);
    expect(JSON.stringify(fake.lines)).not.toContain('.spike/sandbox');
  });

  it('eof-immediate: stdin closed right after the message → the turn completes, exit 0', async () => {
    const recorded = await raw('eof-immediate');
    const fake = start(BASELINE, { FAKE_CLAUDE_SCENARIO: 'eof-immediate' });
    fake.send(userLine('Reply with exactly the word: pong'));
    fake.end();
    expect((await fake.exited).code).toBe(0);
    expect(fake.lines.map(kind)).toEqual(recorded.map(kind));
    expect(fake.lines.at(-1)?.['result']).toBe('pong');
  });

  it('max-turns: --max-turns 1 cuts a two-message turn with error_max_turns; prompt mode exits 1', async () => {
    const fake = start(['-p', 'go', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--permission-mode', 'acceptEdits'], {
      FAKE_CLAUDE_SCENARIO: 'tool-use',
    });
    expect((await fake.exited).code).toBe(1);
    const last = fake.lines.at(-1) as JsonObject;
    expect(kind(last)).toBe('result/error_max_turns');
    expect(last['errors']).toEqual(['Reached maximum number of turns (1)']);
    expect(last['is_error']).toBe(true);
    expect(fake.lines.some((l) => l['type'] === 'assistant' && textOf(l) === 'DONE')).toBe(false);

    const recorded = await raw('max-turns');
    const replay = start(['-p', 'go', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--permission-mode', 'acceptEdits'], {
      FAKE_CLAUDE_SCENARIO: 'max-turns',
    });
    expect((await replay.exited).code).toBe(1);
    expect(replay.lines.map(kind)).toEqual(recorded.map(kind));
  });
});

describe('fake-claude questions and permissions (--permission-prompt-tool stdio)', () => {
  it('ask-2q: blocks on can_use_tool until the control_response, then answers from updatedInput.answers', async () => {
    const recorded = await raw('ask-2q');
    const recordedRequest = recorded.find(isRequest) as JsonObject;
    const [, recordedAnswer] = await rawStdin('ask-2q');
    const fake = start(BASELINE, { FAKE_CLAUDE_SCENARIO: 'ask-2q' });
    fake.send(userLine('Ask me two questions.'));
    const request = await fake.waitFor(isRequest);
    const req = obj(request['request']);
    expect(req['subtype']).toBe('can_use_tool');
    expect(req['tool_name']).toBe('AskUserQuestion');
    expect(req['requires_user_interaction']).toBe(true);
    expect(req['input']).toEqual(obj(recordedRequest['request'])['input']);
    expect(request['request_id']).toMatch(UUID);
    expect(request['request_id']).not.toBe(recordedRequest['request_id']);
    const toolUse = fake.lines.flatMap((l) => (l['type'] === 'assistant' ? contentOf(l) : [])).find((b) => b['type'] === 'tool_use');
    expect(req['tool_use_id']).toBe(toolUse?.['id']);

    await delay(300);
    expect(fake.lines.at(-1)).toBe(request);

    const answer = structuredClone(recordedAnswer) as JsonObject;
    obj(answer['response'])['request_id'] = String(request['request_id']);
    fake.send(answer);
    const result = await fake.waitFor(isResult);
    expect(result['result']).toBe('You chose a green button in small size.');
    const answered = fake.lines.find((l) => l['type'] === 'user' && l['tool_use_result'] !== undefined) as JsonObject;
    const recordedTool = recorded.find((l) => l['type'] === 'user' && l['tool_use_result'] !== undefined) as JsonObject;
    expect(toolResult(answered)['content']).toBe(toolResult(recordedTool)['content']);
    expect(toolResult(answered)['tool_use_id']).toBe(req['tool_use_id']);
    expect(obj(answered['tool_use_result'])['answers']).toEqual({
      'Which color should the button be?': 'Green',
      'Which size should it be?': 'Small',
    });
    fake.end();
    expect((await fake.exited).code).toBe(0);
    expect(fake.lines.map(kind)).toEqual(recorded.map(kind));
  });

  it('ask-2q: other answers are reflected in the tool_result', async () => {
    const fake = start(BASELINE, { FAKE_CLAUDE_SCENARIO: 'ask-2q' });
    fake.send(userLine('Ask.'));
    const request = await fake.waitFor(isRequest);
    const input = obj(obj(request['request'])['input']);
    fake.send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: String(request['request_id']),
        response: {
          behavior: 'allow',
          updatedInput: { ...input, answers: { 'Which color should the button be?': 'Blue', 'Which size should it be?': 'Large' } },
        },
      },
    });
    await fake.waitFor(isResult);
    const answered = fake.lines.find((l) => l['type'] === 'user' && l['tool_use_result'] !== undefined) as JsonObject;
    expect(toolResult(answered)['content']).toBe(
      'Your questions have been answered: "Which color should the button be?"="Blue", "Which size should it be?"="Large". You can now continue with these answers in mind.',
    );
    fake.end();
    expect((await fake.exited).code).toBe(0);
  });

  it('perm-allow: allow once runs the tool (tool_result "42")', async () => {
    const recorded = await raw('perm-allow');
    const [, recordedAllow] = await rawStdin('perm-allow');
    const fake = start(BASELINE, { FAKE_CLAUDE_SCENARIO: 'perm-allow' });
    fake.send(userLine('Run node -e.'));
    const request = await fake.waitFor(isRequest);
    const req = obj(request['request']);
    expect(req['tool_name']).toBe('Bash');
    expect(req['decision_reason']).toBe('This command requires approval');
    const allow = structuredClone(recordedAllow) as JsonObject;
    obj(allow['response'])['request_id'] = String(request['request_id']);
    fake.send(allow);
    const result = await fake.waitFor(isResult);
    expect(result['result']).toBe('The command ran successfully and printed 42.');
    const answered = fake.lines.find((l) => l['type'] === 'user' && l['tool_use_result'] !== undefined) as JsonObject;
    expect(toolResult(answered)['content']).toBe('42');
    fake.end();
    expect((await fake.exited).code).toBe(0);
    expect(fake.lines.map(kind)).toEqual(recorded.map(kind));
  });

  it('perm-deny: deny → is_error tool_result carrying the message verbatim', async () => {
    const recorded = await raw('perm-deny');
    const fake = start(BASELINE, { FAKE_CLAUDE_SCENARIO: 'perm-deny' });
    fake.send(userLine('Run node -e.'));
    const request = await fake.waitFor(isRequest);
    fake.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: String(request['request_id']), response: { behavior: 'deny', message: 'No thanks from the test.' } },
    });
    const result = await fake.waitFor(isResult);
    expect(String(result['result'])).toContain('denied');
    const denied = fake.lines.find((l) => l['type'] === 'user' && l['tool_use_result'] !== undefined) as JsonObject;
    expect(toolResult(denied)['is_error']).toBe(true);
    expect(toolResult(denied)['content']).toBe('No thanks from the test.');
    expect(denied['tool_use_result']).toBe('Error: No thanks from the test.');
    fake.end();
    expect((await fake.exited).code).toBe(0);
    expect(fake.lines.map(kind)).toEqual(recorded.map(kind));
  });

  it('perm-allow answered with deny continues with the perm-deny recording', async () => {
    const fake = start(BASELINE, { FAKE_CLAUDE_SCENARIO: 'perm-allow' });
    fake.send(userLine('Run node -e.'));
    const request = await fake.waitFor(isRequest);
    const toolUseId = obj(request['request'])['tool_use_id'];
    fake.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: String(request['request_id']), response: { behavior: 'deny', message: 'The user denied this tool use in Switchboard.' } },
    });
    const result = await fake.waitFor(isResult);
    expect(String(result['result'])).toContain('denied');
    const denied = fake.lines.find((l) => l['type'] === 'user' && l['tool_use_result'] !== undefined) as JsonObject;
    expect(toolResult(denied)['tool_use_id']).toBe(toolUseId);
    expect(toolResult(denied)['is_error']).toBe(true);
    fake.end();
    expect((await fake.exited).code).toBe(0);
  });

  it('perm-noflag: without --permission-prompt-tool stdio no request is sent and the call is denied at once', async () => {
    const recorded = await raw('perm-noflag');
    const args = BASELINE.filter((a, i) => a !== '--permission-prompt-tool' && BASELINE[i - 1] !== '--permission-prompt-tool');
    const fake = start(args, { FAKE_CLAUDE_SCENARIO: 'perm-allow' });
    fake.send(userLine('Run node -e.'));
    await fake.waitFor(isResult);
    fake.end();
    expect((await fake.exited).code).toBe(0);
    expect(fake.lines.some(isRequest)).toBe(false);
    expect(fake.lines.some((l) => kind(l) === 'system/permission_denied')).toBe(true);
    expect(fake.lines.find((l) => kind(l) === 'system/init')?.['tools']).not.toContain('AskUserQuestion');
    expect(fake.lines.map(kind)).toEqual(recorded.map(kind));
  });

  it('ask-interrupt: interrupt while a question is open → control_cancel_request + aborted_tools; EOF → exit 1', async () => {
    const recorded = await raw('ask-interrupt');
    const fake = start([...BASELINE, '--session-id', SID], { FAKE_CLAUDE_SCENARIO: 'ask-interrupt' });
    fake.send(userLine('Ask me one question.'));
    const request = await fake.waitFor(isRequest);
    await fake.waitFor(isRateLimit);
    await delay(200);
    const before = fake.lines.length;
    fake.send(interruptLine('req_pause_7'));
    const result = await fake.waitFor(isResult);
    const tail = fake.lines.slice(before);
    expect(tail.map(kind)).toEqual(['control_cancel_request', 'control_response', 'user', 'user', 'result/error_during_execution']);
    expect(tail[0]?.['request_id']).toBe(request['request_id']);
    expect(obj(tail[1]?.['response'])).toEqual({ subtype: 'success', request_id: 'req_pause_7', response: { still_queued: [] } });
    expect(toolResult(tail[2] as JsonObject)['tool_use_id']).toBe(obj(request['request'])['tool_use_id']);
    expect(textOf(tail[3] as JsonObject)).toBe('[Request interrupted by user for tool use]');
    expect(result['terminal_reason']).toBe('aborted_tools');
    fake.end();
    expect((await fake.exited).code).toBe(1);
    expect(fake.lines.map(kind)).toEqual(recorded.map(kind));
  });

  it('subagent-perm: a background subagent request carries agent_id; the task-notification result follows', async () => {
    const recorded = await raw('subagent-perm');
    const fake = start([...BASELINE, '--forward-subagent-text'], { FAKE_CLAUDE_SCENARIO: 'subagent-perm' });
    fake.send(userLine('Use a subagent.'));
    const first = await fake.waitFor(isResult);
    expect(first['origin']).toBeUndefined();
    const request = await fake.waitFor(isRequest);
    const started = fake.lines.find((l) => kind(l) === 'system/task_started') as JsonObject;
    expect(obj(request['request'])['agent_id']).toBe(started['task_id']);
    fake.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: String(request['request_id']), response: { behavior: 'allow', updatedInput: obj(request['request'])['input'] } },
    });
    const second = await fake.waitFor(isResult, 2);
    expect(obj(second['origin'])['kind']).toBe('task-notification');
    fake.end();
    expect((await fake.exited).code).toBe(0);
    expect(fake.lines.map(kind)).toEqual(recorded.map(kind));
  });
});

describe('fake-claude interrupts, signals and EOF (D7)', () => {
  it('interrupt between tool calls → aborted_streaming; the process stays alive for the next message', async () => {
    const recorded = await raw('interrupt');
    const fake = start(BASELINE.filter((a) => a !== 'stdio' && a !== '--permission-prompt-tool'), { FAKE_CLAUDE_SCENARIO: 'interrupt' });
    fake.send(userLine('Run sleep 25.'));
    await fake.waitFor(isRateLimit);
    await delay(150);
    expect(fake.lines.some(isResult)).toBe(false);
    fake.send(interruptLine());
    const interrupted = await fake.waitFor(isResult);
    expect(interrupted['terminal_reason']).toBe('aborted_streaming');
    fake.send(userLine('Reply with exactly: resumed-ok'));
    const next = await fake.waitFor(isResult, 2);
    expect(next['result']).toBe('resumed-ok');
    expect(next['result_index']).toBe(1);
    fake.end();
    expect((await fake.exited).code).toBe(0);
    expect(fake.lines.map(kind)).toEqual(recorded.map(kind));
    const marker = fake.lines.find((l) => l['type'] === 'user' && textOf(l).startsWith('[Request interrupted'));
    expect(textOf(marker as JsonObject)).toBe('[Request interrupted by user]');
  });

  it('interrupt-tool: interrupt while a foreground tool runs → rejected tool_result + aborted_tools', async () => {
    const recorded = await raw('interrupt-tool');
    const fake = start(BASELINE, { FAKE_CLAUDE_SCENARIO: 'interrupt-tool' });
    fake.send(userLine('Run node -e setTimeout.'));
    await fake.waitFor(isRateLimit);
    fake.send(interruptLine());
    const interrupted = await fake.waitFor(isResult);
    expect(interrupted['terminal_reason']).toBe('aborted_tools');
    fake.send(userLine('Reply with exactly: resumed-ok'));
    await fake.waitFor(isResult, 2);
    fake.end();
    expect((await fake.exited).code).toBe(0);
    expect(fake.lines.map(kind)).toEqual(recorded.map(kind));
  });

  it('handoff-start: an idle interrupt gets only the control_response; EOF → exit 0', async () => {
    const recorded = await raw('handoff-start');
    const fake = start([...BASELINE, '--replay-user-messages', '--session-id', SID, '--name', 'sb-handoff'], {
      FAKE_CLAUDE_SCENARIO: 'handoff-start',
    });
    fake.send(userLine('Remember the code word: tangerine. Reply with just OK.'));
    await fake.waitFor(isResult);
    fake.send(interruptLine('req_pause_1'));
    await fake.waitFor((l) => l['type'] === 'control_response');
    await delay(300);
    expect(kind(fake.lines.at(-1) as JsonObject)).toBe('control_response');
    fake.end();
    expect((await fake.exited).code).toBe(0);
    expect(fake.lines.map(kind)).toEqual(recorded.map(kind));
  });

  it('handoff-midturn: pause mid-tool → aborted_tools, EOF → exit 1; a later resume adds the synthetic line', async () => {
    const recorded = await raw('handoff-midturn');
    const args = [...BASELINE, '--replay-user-messages', '--session-id', SID, '--name', 'sb-handoff-mid'];
    const fake = start(args, { FAKE_CLAUDE_SCENARIO: 'handoff-midturn' });
    fake.send(userLine('Remember the code word: marigold. Then run a long command.'));
    await fake.waitFor(isRateLimit);
    fake.send(interruptLine('req_pause_1'));
    const result = await fake.waitFor(isResult);
    expect(result['terminal_reason']).toBe('aborted_tools');
    fake.end();
    expect((await fake.exited).code).toBe(1);
    expect(fake.lines.map(kind)).toEqual(recorded.map(kind));

    const file = transcriptPath(env.configDir, env.cwd, SID);
    const afterPause = await readTranscript(file);
    const marker = afterPause.filter((e) => e['type'] === 'user').at(-1) as JsonObject;
    expect(textOf(marker)).toBe('[Request interrupted by user for tool use]');

    const terminal = start(['-p', '--resume', SID, 'What code word did I ask you to remember?']);
    expect((await terminal.exited).code).toBe(0);
    expect(terminal.stdout()).toBe('OK\n');
    const entries = await readTranscript(file);
    const added = entries.slice(afterPause.length);
    const synthetic = added.find((e) => e['type'] === 'assistant') as JsonObject;
    expect(obj(synthetic['message'])['model']).toBe('<synthetic>');
    expect(textOf(synthetic)).toBe('No response requested.');
    expect(synthetic['parentUuid']).toBe(marker['uuid']);
    const prompt = added.find((e) => e['type'] === 'user') as JsonObject;
    expect(prompt['parentUuid']).toBe(synthetic['uuid']);
    expect(added.map((e) => e['type'])).toContain('mode');
    expect(added.at(-1)?.['type']).toBe('cost-state');
    expect(added.some((e) => e['type'] === 'custom-title')).toBe(false);
  });

  it('sigint: SIGINT mid-turn → the interrupted result, then exit 0', async () => {
    const recorded = await raw('sigint');
    const fake = start(BASELINE, { FAKE_CLAUDE_SCENARIO: 'sigint' });
    fake.send(userLine('Run sleep 25.'));
    await fake.waitFor((l) => l['type'] === 'user' && l['tool_use_result'] !== undefined);
    await delay(150);
    fake.kill('SIGINT');
    const exit = await fake.exited;
    expect(exit.code).toBe(0);
    expect(fake.lines.map(kind)).toEqual(recorded.map(kind));
    expect(fake.lines.find(isResult)?.['terminal_reason']).toBe('aborted_streaming');
  });

  it('hang: no result until signalled; an interrupt ends the turn and the process keeps running', async () => {
    const fake = start(BASELINE, { FAKE_CLAUDE_SCENARIO: 'hang' });
    fake.send(userLine('Take forever.'));
    await fake.waitFor((l) => kind(l) === 'system/init');
    await delay(400);
    expect(fake.lines.some(isResult)).toBe(false);
    fake.send(interruptLine('req_hang_1'));
    const result = await fake.waitFor(isResult);
    expect(result['terminal_reason']).toBe('aborted_streaming');
    const ack = fake.lines.find((l) => l['type'] === 'control_response') as JsonObject;
    expect(obj(ack['response'])['request_id']).toBe('req_hang_1');
    fake.send(userLine('Now answer.'));
    const next = await fake.waitFor(isResult, 2);
    expect(next['result']).toBe('OK');
    fake.end();
    expect((await fake.exited).code).toBe(0);
  });

  it('hang: EOF does not end a hanging turn; SIGINT does (exit 0)', async () => {
    const fake = start(BASELINE, { FAKE_CLAUDE_SCENARIO: 'hang' });
    fake.send(userLine('Take forever.'));
    await fake.waitFor((l) => kind(l) === 'system/init');
    fake.end();
    await delay(400);
    expect(fake.child.exitCode).toBeNull();
    fake.kill('SIGINT');
    expect((await fake.exited).code).toBe(0);
    expect(fake.lines.find(isResult)?.['terminal_reason']).toBe('aborted_streaming');
  });

  it('crash: exits 1 unasked, without a result', async () => {
    const fake = start(BASELINE, { FAKE_CLAUDE_SCENARIO: 'crash' });
    fake.send(userLine('Go.'));
    expect((await fake.exited).code).toBe(1);
    expect(fake.lines.some(isResult)).toBe(false);
    expect(fake.stderr()).toContain('simulated crash');
  });
});

describe('fake-claude scenario selection and writes', () => {
  it('a [fake:<scenario>] token in a message selects the scenario; an unknown one exits 1', async () => {
    const fake = start(BASELINE);
    fake.send(userLine('Hello'));
    expect((await fake.waitFor(isResult))['result']).toBe('OK');
    fake.send(userLine('[fake:perm-allow] run it'));
    const request = await fake.waitFor(isRequest);
    expect(obj(request['request'])['tool_name']).toBe('Bash');
    fake.send(userLine('[fake:no-such-scenario] hi'));
    fake.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: String(request['request_id']), response: { behavior: 'allow', updatedInput: obj(request['request'])['input'] } },
    });
    expect((await fake.exited).code).toBe(1);
    expect(fake.stderr()).toContain('unknown scenario "no-such-scenario"');
  });

  it('an unknown FAKE_CLAUDE_SCENARIO exits 1 before any output', async () => {
    const fake = start(BASELINE, { FAKE_CLAUDE_SCENARIO: 'nope' });
    expect((await fake.exited).code).toBe(1);
    expect(fake.lines).toHaveLength(0);
    expect(fake.stderr()).toContain('unknown scenario "nope"');
  });

  it('[fake:write <path>] performs a real Write under the cwd (a Write turn on stdout)', async () => {
    const fake = start(BASELINE);
    fake.send(userLine('Please [fake:write src/new file.txt] now'));
    const result = await fake.waitFor(isResult);
    expect(result['result']).toBe('DONE');
    const target = path.join(env.cwd, 'src', 'new file.txt');
    expect(await readFile(target, 'utf8')).toBe('written by fake-claude\n');
    const toolUse = fake.lines.flatMap((l) => (l['type'] === 'assistant' ? contentOf(l) : [])).find((b) => b['name'] === 'Write') as JsonObject;
    expect(obj(toolUse['input'])).toEqual({ file_path: target, content: 'written by fake-claude\n' });
    const written = fake.lines.find((l) => l['type'] === 'user' && l['tool_use_result'] !== undefined) as JsonObject;
    expect(obj(written['tool_use_result'])['filePath']).toBe(target);
    expect(obj(written['tool_use_result'])['type']).toBe('create');
    fake.end();
    expect((await fake.exited).code).toBe(0);
  });

  it('[fake:write] refuses a path outside the cwd', async () => {
    const fake = start(BASELINE);
    fake.send(userLine('[fake:write ../outside.txt]'));
    expect((await fake.exited).code).toBe(1);
    expect(fake.stderr()).toContain('leaves the cwd');
    await expect(readFile(path.join(env.root, 'outside.txt'), 'utf8')).rejects.toThrow();
  });
});

describe('fake-claude control requests (usage, initialize)', () => {
  it('usage-ctl: get_usage / get_session_cost answered with the recorded payloads; no transcript', async () => {
    const recorded = await raw('usage-ctl');
    const fake = start(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio']);
    fake.send({ type: 'control_request', request_id: 'u1', request: { subtype: 'get_usage', skip_behaviors: true } });
    fake.send({ type: 'control_request', request_id: 'u2', request: { subtype: 'get_session_cost' } });
    await fake.waitFor((l) => l['type'] === 'control_response', 2);
    fake.end();
    expect((await fake.exited).code).toBe(0);
    expect(fake.lines.map(kind)).toEqual(recorded.map(kind));
    const responses = fake.lines.filter((l) => l['type'] === 'control_response').map((l) => obj(l['response']));
    const recordedResponses = recorded.filter((l) => l['type'] === 'control_response').map((l) => obj(l['response']));
    expect(responses.map((r) => r['request_id'])).toEqual(['u1', 'u2']);
    expect(responses[0]?.['response']).toEqual(recordedResponses[0]?.['response']);
    expect(responses[1]?.['response']).toEqual(recordedResponses[1]?.['response']);
    expect(obj(obj(responses[0]?.['response'])['rate_limits'])['five_hour']).toMatchObject({ utilization: 10 });
    expect(await listTranscripts(env.configDir)).toEqual([]);
  });

  it('usage-turn: a turn brings a rate_limit_event; get_usage afterwards returns the post-turn payload', async () => {
    const recorded = await raw('usage-turn');
    const recordedStdin = await rawStdin('usage-turn');
    const lastUsageId = recordedStdin.filter((l) => obj(l['request'] ?? {})['subtype'] === 'get_usage').at(-1)?.['request_id'];
    const recordedAfter = recorded.find((l) => l['type'] === 'control_response' && obj(l['response'])['request_id'] === lastUsageId) as JsonObject;
    const fake = start(BASELINE, { FAKE_CLAUDE_SCENARIO: 'usage-turn' });
    fake.send(userLine('Reply with exactly the word: pong'));
    await fake.waitFor(isResult);
    const event = fake.lines.find(isRateLimit) as JsonObject;
    expect(obj(obj(obj(event['rate_limit_info'])['unifiedWindows'])['five_hour'])['utilization']).toBe(0.1);
    fake.send({ type: 'control_request', request_id: 'after', request: { subtype: 'get_usage', skip_behaviors: true } });
    const response = await fake.waitFor((l) => l['type'] === 'control_response');
    expect(obj(response['response'])['response']).toEqual(obj(recordedAfter['response'])['response']);
    fake.end();
    expect((await fake.exited).code).toBe(0);
  });

  it('ctl-init: initialize, set_permission_mode auto (error auto_mode_model) and acceptEdits (success)', async () => {
    // A model without auto mode (Haiku, as M0 recorded).
    const fake = start(BASELINE, { FAKE_CLAUDE_AUTO_MODE: 'unsupported' });
    fake.send({ type: 'control_request', request_id: 'i1', request: { subtype: 'initialize', hooks: null } });
    fake.send({ type: 'control_request', request_id: 'i2', request: { subtype: 'set_permission_mode', mode: 'auto' } });
    fake.send({ type: 'control_request', request_id: 'i3', request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } });
    await fake.waitFor((l) => l['type'] === 'control_response', 3);
    fake.end();
    expect((await fake.exited).code).toBe(0);
    const [init, auto, accept] = fake.lines.filter((l) => l['type'] === 'control_response').map((l) => obj(l['response']));
    expect(init?.['request_id']).toBe('i1');
    expect(obj(init?.['response'])['models']).toBeInstanceOf(Array);
    expect(auto).toMatchObject({ subtype: 'error', request_id: 'i2', error_code: 'auto_mode_model' });
    expect(accept).toEqual({ subtype: 'success', request_id: 'i3', response: { mode: 'acceptEdits' } });
  });

  it('auto mode on a model that has it (the default): set_permission_mode auto succeeds', async () => {
    const fake = start(BASELINE);
    fake.send({ type: 'control_request', request_id: 'a1', request: { subtype: 'set_permission_mode', mode: 'auto' } });
    await fake.waitFor((l) => l['type'] === 'control_response', 1);
    fake.end();
    expect((await fake.exited).code).toBe(0);
    const [auto] = fake.lines.filter((l) => l['type'] === 'control_response').map((l) => obj(l['response']));
    expect(auto).toEqual({ subtype: 'success', request_id: 'a1', response: { mode: 'auto' } });
  });

  it('perm-auto keeps the recorded init.permissionMode "default" (the silent auto fallback)', async () => {
    const fake = start(BASELINE, { FAKE_CLAUDE_SCENARIO: 'perm-auto' });
    fake.send(userLine('Write a file.'));
    const init = await fake.waitFor((l) => kind(l) === 'system/init');
    expect(init['permissionMode']).toBe('default');
    await fake.waitFor(isResult);
    fake.end();
    await fake.exited;
  });
});
