import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../tools/fake-claude/json.ts';
import { REMOTE_CONTROL_UNAVAILABLE, remoteAnswerToken, scenarioToken } from '../../tools/fake-claude/scenarios.ts';
import { BASELINE, type FakeEnv, type FakeRun, delay, makeFakeEnv, spawnFake, userLine } from '../helpers/fake-claude.ts';

/**
 * fake-claude's Remote Control (D24, docs/fake-claude.md → *Remote Control*):
 * `initialize` reports `remote_control_available`, the `remote_control` control
 * request answers with the R.6 reply shape (or an error), and `[fake:remote-answer
 * <ms>]` lets "the phone" answer an open request (`control_cancel_request`).
 */

const SID = '5e0c9a52-0000-4000-8000-00000000c1a0';
const FAKE_ID = `FAKE${SID.replace(/-/g, '')}`;

let env: FakeEnv;
let runs: FakeRun[] = [];

function start(extraEnv: Record<string, string> = {}, args: readonly string[] = [...BASELINE, '--session-id', SID]): FakeRun {
  const run = spawnFake(args, { cwd: env.cwd, env: { CLAUDE_CONFIG_DIR: env.configDir, ...extraEnv } });
  runs.push(run);
  return run;
}

function obj(value: unknown): JsonObject {
  return value as JsonObject;
}

const isResponse = (l: JsonObject): boolean => l['type'] === 'control_response';
const isRequest = (l: JsonObject): boolean => l['type'] === 'control_request';
const isResult = (l: JsonObject): boolean => l['type'] === 'result';

function control(requestId: string, request: JsonObject): JsonObject {
  return { type: 'control_request', request_id: requestId, request };
}

/** The `response` of the control_response to `requestId`. */
async function reply(fake: FakeRun, requestId: string): Promise<JsonObject> {
  const line = await fake.waitFor((l) => isResponse(l) && obj(l['response'])['request_id'] === requestId);
  return obj(line['response']);
}

beforeEach(async () => {
  env = await makeFakeEnv('fake-remote');
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

describe('fake-claude · initialize and remote_control (D24)', () => {
  it('initialize reports remote_control_available: true (the recording); FAKE_CLAUDE_REMOTE_CONTROL=unavailable → false', async () => {
    const on = start();
    on.send(control('i1', { subtype: 'initialize', hooks: null }));
    expect(obj((await reply(on, 'i1'))['response'])).toMatchObject({ remote_control_available: true, remote_control_auto_enable: false });
    const off = start({ FAKE_CLAUDE_REMOTE_CONTROL: 'unavailable' });
    off.send(control('i2', { subtype: 'initialize', hooks: null }));
    expect(obj((await reply(off, 'i2'))['response'])).toMatchObject({ remote_control_available: false });
  });

  it('enabled: true → the R.6 reply for session_FAKE<id> / cse_FAKE<id>; reattach keeps the given id; enabled: false → {}', async () => {
    const fake = start();
    fake.send(control('r1', { subtype: 'remote_control', enabled: true, name: 'Remote e2e', keep_session_on_exit: true }));
    expect(await reply(fake, 'r1')).toEqual({
      subtype: 'success',
      request_id: 'r1',
      response: {
        session_url: `https://claude.ai/code/session_${FAKE_ID}`,
        connect_url: `https://claude.ai/code?environment=env_${FAKE_ID}`,
        environment_id: `env_${FAKE_ID}`,
        bridge_epoch: 1,
        bridge_session_id: `cse_${FAKE_ID}`,
      },
    });
    fake.send(control('r2', { subtype: 'remote_control', enabled: false }));
    expect(await reply(fake, 'r2')).toEqual({ subtype: 'success', request_id: 'r2', response: {} });
    fake.send(control('r3', { subtype: 'remote_control', enabled: true, name: 'x', reattach_session_id: 'cse_Kept01', keep_session_on_exit: true }));
    expect(obj((await reply(fake, 'r3'))['response'])).toMatchObject({
      session_url: 'https://claude.ai/code/session_Kept01',
      bridge_session_id: 'cse_Kept01',
      bridge_epoch: 2,
    });
    fake.send(control('r4', { subtype: 'remote_control', enabled: true, reattach_session_id: 'session_Kept01' }));
    expect(await reply(fake, 'r4')).toMatchObject({ subtype: 'error', error: 'fake-claude: reattach_session_id must be a cse_… id, got "session_Kept01"' });
  });

  it('FAKE_CLAUDE_REMOTE_CONTROL_ERROR answers every remote_control with that text; unavailable and no-url', async () => {
    const failing = start({ FAKE_CLAUDE_REMOTE_CONTROL_ERROR: 'Remote Control cannot be enabled from inside a remote session' });
    failing.send(control('e1', { subtype: 'remote_control', enabled: true, name: 'x' }));
    expect(await reply(failing, 'e1')).toEqual({ subtype: 'error', request_id: 'e1', error: 'Remote Control cannot be enabled from inside a remote session' });
    failing.send(control('e2', { subtype: 'remote_control', enabled: false }));
    expect(await reply(failing, 'e2')).toMatchObject({ subtype: 'error', error: 'Remote Control cannot be enabled from inside a remote session' });

    const unavailable = start({ FAKE_CLAUDE_REMOTE_CONTROL: 'unavailable' });
    unavailable.send(control('u1', { subtype: 'remote_control', enabled: true, name: 'x' }));
    expect(await reply(unavailable, 'u1')).toEqual({ subtype: 'error', request_id: 'u1', error: REMOTE_CONTROL_UNAVAILABLE });

    const noUrl = start({ FAKE_CLAUDE_REMOTE_CONTROL: 'no-url' });
    noUrl.send(control('n1', { subtype: 'remote_control', enabled: true, name: 'x' }));
    const body = obj((await reply(noUrl, 'n1'))['response']);
    expect(body).toEqual({ bridge_session_id: `cse_${FAKE_ID}`, bridge_epoch: 1 });
  });
});

describe('fake-claude · [fake:remote-answer <ms>] (D24)', () => {
  it('the token needs its milliseconds (alone it would be a scenario name) and never selects a scenario', () => {
    expect(remoteAnswerToken('[fake:ask-2q] [fake:remote-answer 250] Ask me.')).toBe(250);
    expect(remoteAnswerToken('[fake:remote-answer]')).toBeNull();
    expect(remoteAnswerToken('[fake:remote-answer 99999999]')).toBe(600_000);
    expect(scenarioToken('[fake:ask-2q] [fake:remote-answer 250]')).toBe('ask-2q');
    expect(scenarioToken('[fake:remote-answer 250] then [fake:ask-2q]')).toBe('ask-2q');
  });

  it('with Remote Control on: control_cancel_request for the open question, then the turn goes on with the first options', async () => {
    const fake = start();
    fake.send(control('r1', { subtype: 'remote_control', enabled: true, name: 'x', keep_session_on_exit: true }));
    await reply(fake, 'r1');
    fake.send(userLine('[fake:ask-2q] [fake:remote-answer 100] Ask me two questions.'));
    const request = await fake.waitFor(isRequest);
    const requestId = String(request['request_id']);
    const cancel = await fake.waitFor((l) => l['type'] === 'control_cancel_request');
    expect(cancel).toEqual({ type: 'control_cancel_request', request_id: requestId });
    const result = await fake.waitFor(isResult);
    expect(result['is_error']).toBe(false);
    const questions = obj(obj(request['request'])['input'])['questions'] as JsonObject[];
    const firstOptions = Object.fromEntries(questions.map((q) => [q['question'], obj((q['options'] as JsonObject[])[0])['label']]));
    const answered = fake.lines.find((l) => l['type'] === 'user' && l['tool_use_result'] !== undefined) as JsonObject;
    expect(obj(answered['tool_use_result'])['answers']).toEqual(firstOptions);
    // The cancel comes after the request and before the answer's tool_result.
    const order = fake.lines.map((l) => String(l['type']));
    expect(order.indexOf('control_cancel_request')).toBeGreaterThan(order.indexOf('control_request'));
    expect(fake.lines.indexOf(cancel)).toBeLessThan(fake.lines.indexOf(answered));
    fake.end();
    expect((await fake.exited).code).toBe(0);
  });

  it('a permission request answered "remotely" runs the tool (allowed)', async () => {
    const fake = start();
    fake.send(control('r1', { subtype: 'remote_control', enabled: true, name: 'x' }));
    await reply(fake, 'r1');
    fake.send(userLine('[fake:perm-allow] [fake:remote-answer 50] Run it.'));
    const request = await fake.waitFor(isRequest);
    expect(await fake.waitFor((l) => l['type'] === 'control_cancel_request')).toEqual({ type: 'control_cancel_request', request_id: request['request_id'] });
    const result = await fake.waitFor(isResult);
    expect(result['is_error']).toBe(false);
    fake.end();
    expect((await fake.exited).code).toBe(0);
  });

  it('with Remote Control off the request stays open (a stderr note) and the host can still answer it', async () => {
    const fake = start();
    fake.send(userLine('[fake:perm-allow] [fake:remote-answer 30] Run it.'));
    const request = await fake.waitFor(isRequest);
    await delay(250);
    expect(fake.lines.some((l) => l['type'] === 'control_cancel_request')).toBe(false);
    expect(fake.stderr()).toContain('[fake:remote-answer]: Remote Control is off');
    fake.send({ type: 'control_response', response: { subtype: 'success', request_id: request['request_id'], response: { behavior: 'allow', updatedInput: obj(obj(request['request'])['input']) } } });
    expect((await fake.waitFor(isResult))['is_error']).toBe(false);
    fake.end();
    expect((await fake.exited).code).toBe(0);
  });

  it('the host answering first wins: no cancel follows', async () => {
    const fake = start();
    fake.send(control('r1', { subtype: 'remote_control', enabled: true, name: 'x' }));
    await reply(fake, 'r1');
    fake.send(userLine('[fake:perm-allow] [fake:remote-answer 300] Run it.'));
    const request = await fake.waitFor(isRequest);
    fake.send({ type: 'control_response', response: { subtype: 'success', request_id: request['request_id'], response: { behavior: 'allow', updatedInput: obj(obj(request['request'])['input']) } } });
    await fake.waitFor(isResult);
    await delay(450);
    expect(fake.lines.some((l) => l['type'] === 'control_cancel_request')).toBe(false);
    fake.end();
    expect((await fake.exited).code).toBe(0);
  });
});
