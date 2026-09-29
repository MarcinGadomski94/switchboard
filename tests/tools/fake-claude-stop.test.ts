import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../tools/fake-claude/json.ts';
import { ignoresInterrupt } from '../../tools/fake-claude/scenarios.ts';
import { BASELINE, type FakeEnv, type FakeRun, delay, makeFakeEnv, spawnFake, userLine } from '../helpers/fake-claude.ts';

/**
 * D50: fake-claude honours an `interrupt` control request mid-turn the way CLI
 * 2.1.284 does (`docs/fake-claude.md` → *Interrupts*): the receipt
 * (`control_response` `{still_queued, cancelled?}`) comes first, then the
 * `[Request interrupted by user…]` marker and the aborted `result`; the process
 * stays alive. With `cancel_queued: true` the stdin messages still queued are
 * dropped (never run); without it they survive and run after the interrupt.
 * Only messages the host stamped with a `uuid` are listed in the receipt.
 */

const SID = '0b7e6c1d-5050-4222-8333-44445555d50d';

let env: FakeEnv;
let runs: FakeRun[] = [];

beforeEach(async () => {
  env = await makeFakeEnv('fake-stop');
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

function interrupt(requestId: string, cancelQueued: boolean): JsonObject {
  return { type: 'control_request', request_id: requestId, request: cancelQueued ? { subtype: 'interrupt', cancel_queued: true } : { subtype: 'interrupt' } };
}

const isResult = (l: JsonObject): boolean => l['type'] === 'result';
const isReplay = (l: JsonObject): boolean => l['type'] === 'user' && l['isReplay'] === true;
const receiptOf = (run: FakeRun, id: string): JsonObject | undefined =>
  run.lines.find((l) => l['type'] === 'control_response' && (l['response'] as JsonObject)['request_id'] === id);

function marker(line: JsonObject): string | null {
  if (line['type'] !== 'user' || line['isReplay'] === true) return null;
  const content = (line['message'] as JsonObject)['content'];
  if (!Array.isArray(content)) return null;
  const text = (content as JsonObject[]).find((block) => block['type'] === 'text')?.['text'];
  return typeof text === 'string' && text.startsWith('[Request interrupted') ? text : null;
}

describe('fake-claude · interrupt mid-turn (D50)', () => {
  it('cancel_queued: the receipt, then the marker and the aborted result; the queued messages never run; the next message runs', async () => {
    const run = start();
    run.send(userLine('[fake:hold 5] Think for a while.'));
    await run.waitFor(isReplay);
    run.send({ ...userLine('First queued.'), uuid: 'aaaaaaaa-0000-4000-8000-000000000001' });
    run.send(userLine('Second queued (no uuid).'));
    await delay(150);
    run.send(interrupt('stop-1', true));
    const result = await run.waitFor(isResult);
    expect(result).toMatchObject({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' });
    const receipt = receiptOf(run, 'stop-1');
    // The host-stamped message is listed as cancelled; the one without a uuid is dropped too, unlisted.
    expect((receipt?.['response'] as JsonObject)['response']).toEqual({ still_queued: [], cancelled: ['aaaaaaaa-0000-4000-8000-000000000001'] });
    const order = run.lines.map((l) => (l === receipt ? 'receipt' : marker(l) ? 'marker' : isResult(l) ? 'result' : null)).filter(Boolean);
    expect(order).toEqual(['receipt', 'marker', 'result']);
    expect(run.lines.map(marker).filter(Boolean)).toEqual(['[Request interrupted by user]']);

    // Nothing more runs: the queued messages are gone.
    await delay(600);
    expect(run.lines.filter(isResult)).toHaveLength(1);
    expect(run.lines.filter(isReplay)).toHaveLength(1);

    // The process is alive: the next message runs normally.
    run.send(userLine('Reply with exactly: resumed-ok'));
    const next = await run.waitFor(isResult, 2);
    expect(next).toMatchObject({ subtype: 'success', is_error: false });
    expect(run.lines.filter(isReplay).map((l) => (l['message'] as JsonObject)['content'])).toEqual(['[fake:hold 5] Think for a while.', 'Reply with exactly: resumed-ok']);
  });

  it('a plain interrupt keeps the queued messages: listed under still_queued (host-stamped only), and they run afterwards', async () => {
    const run = start();
    run.send(userLine('[fake:hold 5] Think for a while.'));
    await run.waitFor(isReplay);
    run.send({ ...userLine('Queued.'), uuid: 'aaaaaaaa-0000-4000-8000-000000000002' });
    await delay(150);
    run.send(interrupt('plain-1', false));
    await run.waitFor(isResult);
    expect(((receiptOf(run, 'plain-1')?.['response'] as JsonObject)['response'])).toEqual({ still_queued: ['aaaaaaaa-0000-4000-8000-000000000002'] });
    // The queued message's own turn follows; its echo carries the host's uuid.
    const second = await run.waitFor(isResult, 2);
    expect(second).toMatchObject({ subtype: 'success' });
    expect(run.lines.filter(isReplay).at(-1)).toMatchObject({ uuid: 'aaaaaaaa-0000-4000-8000-000000000002' });
  });

  it('at a tool boundary ([fake:interrupt-tool]): the tool is rejected, then "[Request interrupted by user for tool use]" and aborted_tools', async () => {
    const run = start();
    run.send(userLine('[fake:interrupt-tool] Run the long command.'));
    await run.waitFor((l) => l['type'] === 'assistant' && JSON.stringify(l).includes('"tool_use"'));
    run.send(interrupt('stop-tool', true));
    const result = await run.waitFor(isResult);
    expect(result).toMatchObject({ is_error: true, terminal_reason: 'aborted_tools' });
    expect(run.lines.map(marker).filter(Boolean)).toEqual(['[Request interrupted by user for tool use]']);
    expect(((receiptOf(run, 'stop-tool')?.['response'] as JsonObject)['response'])).toEqual({ still_queued: [], cancelled: [] });
  });

  it('with no turn running the interrupt is only acknowledged (no result)', async () => {
    const run = start();
    run.send(interrupt('idle-1', true));
    await run.waitFor((l) => l['type'] === 'control_response');
    await delay(200);
    expect(run.lines.filter(isResult)).toHaveLength(0);
  });

  it('FAKE_CLAUDE_IGNORE_INTERRUPT=1: no receipt, the turn goes on to its own end', async () => {
    expect(ignoresInterrupt({ FAKE_CLAUDE_IGNORE_INTERRUPT: '1' })).toBe(true);
    expect(ignoresInterrupt({})).toBe(false);
    const run = start({ FAKE_CLAUDE_IGNORE_INTERRUPT: '1' });
    run.send(userLine('[fake:hold 1] Think for a while.'));
    await run.waitFor(isReplay);
    run.send(interrupt('ignored-1', true));
    const result = await run.waitFor(isResult);
    expect(result).toMatchObject({ subtype: 'success' });
    expect(receiptOf(run, 'ignored-1')).toBeUndefined();
  });

  it('stop_task ends a pending background task at once (killed / stopped), empty success; an unknown id is a success too, no task_id an error', async () => {
    const run = start();
    run.send(userLine('Start it. [fake:background 60 npm run dev]'));
    await run.waitFor(isResult);
    const started = run.lines.find((l) => l['type'] === 'system' && l['subtype'] === 'task_started') as JsonObject;
    const taskId = started['task_id'] as string;
    run.send({ type: 'control_request', request_id: 'st-1', request: { subtype: 'stop_task', task_id: taskId } });
    const note = await run.waitFor((l) => l['type'] === 'system' && l['subtype'] === 'task_notification');
    expect(note).toMatchObject({ task_id: taskId, status: 'stopped' });
    expect(run.lines.find((l) => l['type'] === 'system' && l['subtype'] === 'task_updated')).toMatchObject({ task_id: taskId, patch: { status: 'killed' } });
    expect(receiptOf(run, 'st-1')?.['response']).toEqual({ subtype: 'success', request_id: 'st-1' });
    run.send({ type: 'control_request', request_id: 'st-2', request: { subtype: 'stop_task', task_id: 'b-unknown' } });
    run.send({ type: 'control_request', request_id: 'st-3', request: { subtype: 'stop_task' } });
    await run.waitFor((l) => l['type'] === 'control_response' && (l['response'] as JsonObject)['request_id'] === 'st-3');
    expect((receiptOf(run, 'st-2')?.['response'] as JsonObject)['subtype']).toBe('success');
    expect(receiptOf(run, 'st-3')?.['response']).toMatchObject({ subtype: 'error', error: 'stop_task: task_id must be a string' });
    await delay(300);
    expect(run.lines.filter(isResult)).toHaveLength(1);
  });
});
