import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveSessionStatus } from '../../../src/core/derive/status.ts';
import { parseStreamLine } from '../../../src/core/stream-json.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { StreamRecorder } from '../../../src/server/supervisor/recorder.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * The stuck-`run` bug of 2026-09-29 (`docs/supervisor.md` → *Turn accounting*):
 * session `proj-3013-…` stayed `run` (its main agent too) after its last `result`.
 * Its stream, reduced to the lines that drive the status, in the real order: a
 * background `Workflow` finished, the CLI ran a turn of its own for its
 * notification, the developer sent two messages while that turn ran, the CLI
 * folded both into the running turn (`queued_command` attachments, replayed at
 * once) and ended the whole turn with **one** `result` whose origin is the task
 * notification. Switchboard counted two turns still to come, so every later
 * `result` left the session `run`. No secrets: ids and texts are made up.
 */

const SID = 'c-stuck';
let tmp: string | undefined;
let store: Store | undefined;

afterEach(async () => {
  await store?.close();
  store = undefined;
  if (tmp) await removeTempDir(tmp);
  tmp = undefined;
});

const line = (value: Record<string, unknown>): string => JSON.stringify({ session_id: SID, ...value });
const init = (): string => line({ type: 'system', subtype: 'init', cwd: '/ws', model: 'claude-opus', permissionMode: 'auto', tools: ['Bash', 'Workflow'], claude_code_version: '2.1.284' });
const replay = (text: string, uuid: string): string => line({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid, isReplay: true });
const say = (id: string, text: string): string =>
  line({ type: 'assistant', message: { id, type: 'message', role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid: `a-${id}` });
const result = (text: string, taskNotification = false): string =>
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    terminal_reason: 'completed',
    num_turns: 1,
    duration_ms: 1000,
    total_cost_usd: 0.01,
    ...(taskNotification ? { origin: { kind: 'task-notification' } } : {}),
  });
const workflowCall = (): string =>
  line({
    type: 'assistant',
    message: { id: 'm-wf', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_wf', name: 'Workflow', input: { script: 'export const meta = {}' } }] },
    parent_tool_use_id: null,
    uuid: 'a-wf',
  });
const workflowLaunched = (): string =>
  line({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_wf', content: 'Workflow launched in background. Task ID: wtask1\nSummary: Read-only audit' }] },
    parent_tool_use_id: null,
    uuid: 'u-wf',
    tool_use_result: { status: 'async_launched', taskId: 'wtask1', taskType: 'local_workflow' },
  });
const workflowStarted = (): string =>
  line({ type: 'system', subtype: 'task_started', task_id: 'wtask1', tool_use_id: 'toolu_wf', description: 'Read-only audit', task_type: 'local_workflow', uuid: 's-1' });
const workflowEnded = (): string[] => [
  line({ type: 'system', subtype: 'task_updated', task_id: 'wtask1', patch: { status: 'completed' }, uuid: 's-2' }),
  line({ type: 'system', subtype: 'task_notification', task_id: 'wtask1', tool_use_id: 'toolu_wf', status: 'completed', summary: 'done', uuid: 's-3' }),
];

async function world() {
  tmp = await makeTempDir('stuck-running');
  store = await openTempStore(tmp);
  const session = await store.sessions.create({ name: 'stuck', claudeSessionId: SID, task: 't', mode: 'orchestrator', cwd: path.join(tmp, 'ws'), status: 'run' });
  const main = await store.agents.create({ sessionId: session.id, kind: 'main', name: 'orchestrator', status: 'run' });
  const recorder = new StreamRecorder({ store, session, mainAgentId: main.id, onEvent: () => undefined });
  return {
    recorder,
    async feed(...lines: readonly string[]): Promise<void> {
      for (const l of lines) await recorder.handle(parseStreamLine(l));
    },
    /** Switchboard writes a stdin message (the supervisor's `#send`). */
    async send(text: string): Promise<void> {
      await recorder.recordUserMessage(text, 'user');
    },
    status: () => deriveSessionStatus(recorder.statusInput()),
  };
}

describe('stuck run (2026-09-29): a result ends the turn and every message it took up', () => {
  it('the proj-3013 sequence: two messages folded into a task-notification turn; every later result is done', async () => {
    const w = await world();
    // 06:19: a message → its turn launches a background Workflow and ends.
    await w.send('move into the task');
    expect(w.status()).toBe('run');
    await w.feed(init(), replay('move into the task', 'u-1'), workflowCall(), workflowLaunched(), workflowStarted(), say('m-1', 'While the audit runs…'), result('While the audit runs…'));
    expect(w.status()).toBe('done');
    // 06:41: the workflow ends → the CLI's own turn (origin task-notification).
    await w.feed(...workflowEnded(), init(), say('m-2', 'The implementation workflow is done.'));
    expect(w.status()).toBe('run');
    // 06:58: two messages sent while that turn runs; the CLI folds both into it (replayed at once).
    await w.send('1. banner is now created');
    await w.feed(replay('1. banner is now created', 'u-2'), say('m-3', 'Launching the fix round.'));
    await w.send('remember to stay within the scope');
    await w.feed(replay('remember to stay within the scope', 'u-3'), say('m-4', 'The live check matches.'));
    expect(w.status()).toBe('run');
    // 07:03: ONE result for the whole turn, with the task-notification origin.
    await w.feed(result('The live check matches.', true));
    expect(w.status()).toBe('done');
    expect(w.recorder.turnBusy()).toBe(false);
    // 07:35: "is there some orchestrator working?" → "No, nothing is running." → done, not run.
    await w.send('is there some kind of orchestrator working right now?');
    await w.feed(init(), replay('is there some kind of orchestrator working right now?', 'u-4'), say('m-5', 'No, nothing is running.'), result('No, nothing is running.'));
    expect(w.status()).toBe('done');
    expect(w.recorder.activity()).toBeNull();
  });

  it('a message queued while a turn runs and taken up after its result keeps the session running until its own result', async () => {
    const w = await world();
    await w.send('first');
    await w.feed(init(), replay('first', 'u-1'), say('m-1', 'working'));
    await w.send('second');
    await w.feed(result('first done'));
    // Not taken up yet: still work to come.
    expect(w.status()).toBe('run');
    await w.feed(init(), replay('second', 'u-2'), say('m-2', 'ok'));
    expect(w.status()).toBe('run');
    await w.feed(result('second done'));
    expect(w.status()).toBe('done');
  });

  it('a message folded into a turn the user started ends with that turn', async () => {
    const w = await world();
    await w.send('first');
    await w.feed(init(), replay('first', 'u-1'));
    await w.send('also this');
    await w.feed(replay('also this', 'u-2'), result('both done'));
    expect(w.status()).toBe('done');
  });

  it('a message written just before a task-notification turn opens, then folded into it, ends with that turn', async () => {
    const w = await world();
    await w.send('first');
    await w.feed(init(), replay('first', 'u-1'), workflowCall(), workflowLaunched(), workflowStarted(), result('launched'));
    expect(w.status()).toBe('done');
    // The developer sends a message as the workflow ends: the CLI's own turn opens before it takes the message up.
    await w.send('are you there?');
    await w.feed(...workflowEnded(), init(), say('m-2', 'The workflow is done.'), replay('are you there?', 'u-2'), say('m-3', 'Yes.'));
    expect(w.status()).toBe('run');
    await w.feed(result('Yes.', true));
    expect(w.status()).toBe('done');
  });

  it('without replay echoes a result still answers the oldest message (not a task-notification one)', async () => {
    const w = await world();
    await w.send('one');
    await w.feed(init(), result('one done'));
    expect(w.status()).toBe('done');
    await w.send('two');
    await w.feed(...workflowEnded(), init(), result('own turn', true));
    // The CLI's own turn did not take up "two": it is still to come.
    expect(w.status()).toBe('run');
    await w.feed(init(), result('two done'));
    expect(w.status()).toBe('done');
  });
});
