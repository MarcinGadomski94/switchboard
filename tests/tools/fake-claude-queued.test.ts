import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../tools/fake-claude/json.ts';
import { MAX_HOLD_SECONDS, MAX_STARTUP_MS, absorbable, holdToken, startupDelayMs } from '../../tools/fake-claude/scenarios.ts';
import { BASELINE, type FakeEnv, type FakeRun, makeFakeEnv, spawnFake, userLine } from '../helpers/fake-claude.ts';

/**
 * D44: what fake-claude does with a message written while a turn runs, as the real
 * CLI does it (`docs/derivations.md` → *Queued messages*): the message waits in
 * the queue and nothing is echoed for it while the turn runs; at the turn's next
 * tool boundary the turn absorbs it (echoed there, no turn of its own), else after
 * the turn's `result` its own turn starts (`system/init`) and its `isReplay` echo
 * comes in that turn, before the first assistant line. `[fake:hold]` holds a turn
 * without a tool boundary. And `FAKE_CLAUDE_STARTUP_MS`: the process takes up
 * messages only once it has "started" (the CLI's hooks and MCP servers), answering
 * control requests meanwhile.
 */

const SID = '0b7e6c1d-7777-4222-8333-44445555d44d';

let env: FakeEnv;
let runs: FakeRun[] = [];

beforeEach(async () => {
  env = await makeFakeEnv('fake-queued');
});

afterEach(async () => {
  for (const run of runs) run.kill('SIGKILL');
  runs = [];
  await env.cleanup();
});

function start(extraEnv: Record<string, string> = {}): FakeRun {
  const run = spawnFake([...BASELINE, '--replay-user-messages', '--session-id', SID], {
    cwd: env.cwd,
    env: { CLAUDE_CONFIG_DIR: env.configDir, ...extraEnv },
  });
  runs.push(run);
  return run;
}

/** A compact trace of the stdout lines: `init`, `replay:<text>`, `assistant`, `result`, `request`, … */
function trace(lines: readonly JsonObject[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const type = line['type'];
    if (type === 'system' && line['subtype'] === 'init') out.push('init');
    else if (type === 'user' && line['isReplay'] === true) out.push(`replay:${String((line['message'] as JsonObject)['content'])}`);
    else if (type === 'assistant' && line['parent_tool_use_id'] === null) out.push('assistant');
    else if (type === 'result') out.push('result');
    else if (type === 'control_request') out.push('request');
  }
  return out.filter((entry, i, all) => entry !== 'assistant' || all[i - 1] !== 'assistant');
}

const isResult = (l: JsonObject): boolean => l['type'] === 'result';
const isRequest = (l: JsonObject): boolean => l['type'] === 'control_request';

describe('fake-claude · a message written while a turn runs (D44)', () => {
  it('[fake:hold]: no tool boundary, so the second message waits for the result; its own turn (init, replay, reply) follows', async () => {
    const run = start();
    const sentAt = Date.now();
    run.send(userLine('[fake:hold 1] Think for a while.'));
    await run.waitFor((l) => l['type'] === 'user' && l['isReplay'] === true);
    run.send(userLine('Keep it short.'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Held: nothing but the turn's start so far, and nothing echoed for the second message.
    expect(trace(run.lines)).toEqual(['init', 'replay:[fake:hold 1] Think for a while.']);
    await run.waitFor(isResult, 2);
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(1000);
    expect(trace(run.lines)).toEqual([
      'init',
      'replay:[fake:hold 1] Think for a while.',
      'assistant',
      'result',
      'init',
      'replay:Keep it short.',
      'assistant',
      'result',
    ]);
    expect(run.lines.filter(isResult).map((l) => l['result'])).toEqual(['OK', 'OK']);
  });

  it('[fake:hold]: an interrupt during the hold ends the turn like hang (ack, aborted result); a malformed token exits 1', async () => {
    const run = start();
    run.send(userLine('[fake:hold 30] Think.'));
    await run.waitFor((l) => l['type'] === 'user' && l['isReplay'] === true);
    run.send({ type: 'control_request', request_id: 'req_interrupt_9', request: { subtype: 'interrupt' } });
    const result = await run.waitFor(isResult);
    expect(result).toMatchObject({ subtype: 'error_during_execution' });
    expect(run.lines.some((l) => l['type'] === 'control_response' && (l['response'] as JsonObject)['request_id'] === 'req_interrupt_9')).toBe(true);

    const bad = start();
    bad.send(userLine('[fake:hold soon]'));
    expect((await bad.exited).code).toBe(1);
    expect(bad.stderr()).toContain('[fake:hold]');
  });

  it('ask-2q: a plain message written while the question holds the turn is absorbed at the next tool boundary (echoed mid-turn, no turn of its own); a [fake:…] message keeps its turn', async () => {
    const run = start();
    run.send(userLine('[fake:ask-2q] Ask me two questions.'));
    const request = await run.waitFor(isRequest);
    run.send(userLine('Keep it short.'));
    run.send(userLine('[fake:say "Second turn."] Then this.'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Nothing is echoed while the turn waits for the answer.
    expect(trace(run.lines)).toEqual(['init', 'replay:[fake:ask-2q] Ask me two questions.', 'assistant', 'request']);

    const input = (request['request'] as JsonObject)['input'] as JsonObject;
    const answers = { 'Which color should the button be?': 'Green', 'Which size should it be?': 'Small' };
    run.send({ type: 'control_response', response: { subtype: 'success', request_id: request['request_id'], response: { behavior: 'allow', updatedInput: { ...input, answers } } } });
    await run.waitFor(isResult, 2);
    expect(trace(run.lines)).toEqual([
      'init',
      'replay:[fake:ask-2q] Ask me two questions.',
      'assistant',
      'request',
      // The AskUserQuestion result is the tool boundary: the plain message is echoed there, inside the running turn.
      'replay:Keep it short.',
      'assistant',
      'result',
      'init',
      'replay:[fake:say "Second turn."] Then this.',
      'assistant',
      'result',
    ]);
    const boundary = run.lines.findIndex((l) => l['type'] === 'user' && JSON.stringify(l).includes('"tool_result"'));
    const echo = run.lines.findIndex((l) => l['isReplay'] === true && (l['message'] as JsonObject)['content'] === 'Keep it short.');
    expect(echo).toBe(boundary + 1);
  });
});

describe('fake-claude · D44 token parsers', () => {
  it('[fake:hold <seconds>] → milliseconds (capped); malformed → error; absent → null; only plain messages are absorbable', () => {
    expect(holdToken('Think. [fake:hold 4]')).toBe(4000);
    expect(holdToken('[fake:hold 0.5]')).toBe(500);
    expect(holdToken('[fake:hold 99999]')).toBe(MAX_HOLD_SECONDS * 1000);
    expect(holdToken('[fake:hold]')).toMatchObject({ error: expect.any(String) });
    expect(holdToken('[fake:hold soon]')).toMatchObject({ error: expect.any(String) });
    expect(holdToken('[fake:hang]')).toBeNull();
    expect(absorbable('Keep it short.')).toBe(true);
    expect(absorbable('[fake:hang] Keep going.')).toBe(false);
  });
});

describe('fake-claude · FAKE_CLAUDE_STARTUP_MS (D44)', () => {
  it('reads a whole number of milliseconds (0 when unset), refuses anything else', () => {
    expect(startupDelayMs({})).toBe(0);
    expect(startupDelayMs({ FAKE_CLAUDE_STARTUP_MS: '' })).toBe(0);
    expect(startupDelayMs({ FAKE_CLAUDE_STARTUP_MS: '1500' })).toBe(1500);
    expect(startupDelayMs({ FAKE_CLAUDE_STARTUP_MS: String(MAX_STARTUP_MS) })).toBe(MAX_STARTUP_MS);
    for (const bad of ['-1', '1.5', 'soon', String(MAX_STARTUP_MS + 1)]) {
      expect(startupDelayMs({ FAKE_CLAUDE_STARTUP_MS: bad })).toMatchObject({ error: expect.stringContaining('FAKE_CLAUDE_STARTUP_MS') });
    }
  });

  it('a message written at spawn is taken up (init, replay) only once the startup is over; a control request is answered at once', async () => {
    const spawnedAt = Date.now();
    const run = start({ FAKE_CLAUDE_STARTUP_MS: '700' });
    run.send({ type: 'control_request', request_id: 'req_init_1', request: { subtype: 'initialize', hooks: null } });
    run.send(userLine('Hello.'));
    await run.waitFor((l) => l['type'] === 'control_response');
    expect(run.lines.some((l) => l['type'] === 'system' && l['subtype'] === 'init')).toBe(false);
    await run.waitFor((l) => l['type'] === 'system' && l['subtype'] === 'init');
    expect(Date.now() - spawnedAt).toBeGreaterThanOrEqual(650);
    await run.waitFor(isResult);
    expect(trace(run.lines)).toEqual(['init', 'replay:Hello.', 'assistant', 'result']);
  });

  it('an unreadable value exits 1 before any output', async () => {
    const run = start({ FAKE_CLAUDE_STARTUP_MS: 'soon' });
    const exit = await run.exited;
    expect(exit.code).toBe(1);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toContain('FAKE_CLAUDE_STARTUP_MS');
  });
});
