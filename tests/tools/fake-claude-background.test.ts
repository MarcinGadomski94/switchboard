import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../tools/fake-claude/json.ts';
import {
  GH_WAIT_COMMAND,
  RECORDED_BACKGROUND_TASK,
  WAKEUP_REASON,
  backgroundToken,
  toolResultText,
} from '../../tools/fake-claude/scenarios.ts';
import { BASELINE, type FakeEnv, type FakeRun, makeFakeEnv, spawnFake, userLine } from '../helpers/fake-claude.ts';

/**
 * D30 background tokens (`docs/fake-claude.md` → *Scenarios*): a background Bash
 * whose end the fake reports later, like the CLI does (the `bg-bash` probe), and a
 * ScheduleWakeup that fires a turn of its own.
 */
const SID = '0b7e6c1d-3030-4222-8333-44445555d030';

let env: FakeEnv;
let runs: FakeRun[] = [];

beforeEach(async () => {
  env = await makeFakeEnv('fake-background');
});

afterEach(async () => {
  for (const run of runs) run.kill('SIGKILL');
  runs = [];
  await env.cleanup();
});

function start(): FakeRun {
  const run = spawnFake([...BASELINE, '--replay-user-messages', '--session-id', SID], { cwd: env.cwd, env: { CLAUDE_CONFIG_DIR: env.configDir } });
  runs.push(run);
  return run;
}

const isResult = (l: JsonObject): boolean => l['type'] === 'result';
const isNotification = (l: JsonObject): boolean => l['type'] === 'system' && l['subtype'] === 'task_notification';
const origin = (l: JsonObject): unknown => (l['origin'] as JsonObject | undefined)?.['kind'] ?? null;

function toolUses(lines: readonly JsonObject[]): JsonObject[] {
  return lines
    .filter((l) => l['type'] === 'assistant')
    .flatMap((l) => ((l['message'] as JsonObject)['content'] as JsonObject[]).filter((b) => b['type'] === 'tool_use'));
}

function toolResultOf(lines: readonly JsonObject[], id: unknown): { block: JsonObject; line: JsonObject } {
  for (const line of lines) {
    if (line['type'] !== 'user') continue;
    const content = (line['message'] as JsonObject)['content'];
    if (!Array.isArray(content)) continue;
    const block = (content as JsonObject[]).find((b) => b['type'] === 'tool_result' && b['tool_use_id'] === id);
    if (block) return { block, line };
  }
  throw new Error(`no tool_result for ${String(id)}`);
}

describe('fake-claude · background tokens (parser)', () => {
  it('[fake:background <s> <cmd>], [fake:background-gh <s>], [fake:wakeup <s>]', () => {
    expect(backgroundToken('Wait [fake:background 5 npm run e2e -- --grep "x y"]')).toEqual({ kind: 'bash', seconds: 5, command: 'npm run e2e -- --grep "x y"' });
    expect(backgroundToken('[fake:background 0.5 gh run view 42]')).toEqual({ kind: 'bash', seconds: 0.5, command: 'gh run view 42' });
    expect(backgroundToken('CI [fake:background-gh 12]')).toEqual({ kind: 'bash', seconds: 12, command: GH_WAIT_COMMAND });
    expect(backgroundToken('[fake:wakeup 90]')).toEqual({ kind: 'wakeup', seconds: 90 });
    expect(backgroundToken('[fake:wakeup 999999]')).toEqual({ kind: 'wakeup', seconds: 3600 });
    expect(backgroundToken('no token [fake:bg-bash]')).toBeNull();
    expect(backgroundToken('[fake:background]')).toMatchObject({ error: expect.any(String) });
    expect(backgroundToken('[fake:background 5]')).toMatchObject({ error: expect.any(String) });
    expect(backgroundToken('[fake:wakeup soon]')).toMatchObject({ error: expect.any(String) });
  });
});

describe('fake-claude · background tokens (process)', () => {
  it('[fake:background]: the turn ends with the task running; seconds later its task_notification and the CLI\'s own turn', async () => {
    const run = start();
    run.send(userLine('Run the e2e suite in the background [fake:background 1 npm run e2e]'));
    const first = await run.waitFor(isResult, 1);
    const firstAt = Date.now();
    expect(origin(first)).toBeNull();
    const [call] = toolUses(run.lines);
    expect(call).toMatchObject({ name: 'Bash', input: { command: 'npm run e2e', run_in_background: true } });
    const { block, line } = toolResultOf(run.lines, call?.['id']);
    const id = /Command running in background with ID: ([A-Za-z0-9]+)\./.exec(String(block['content']))?.[1];
    expect(id).toBeTruthy();
    expect(id).not.toBe(RECORDED_BACKGROUND_TASK);
    expect(line['tool_use_result']).toMatchObject({ backgroundTaskId: id });
    const started = run.lines.find((l) => l['type'] === 'system' && l['subtype'] === 'task_started');
    expect(started).toMatchObject({ task_id: id, tool_use_id: call?.['id'], task_type: 'local_bash', is_backgrounded: true, description: 'npm run e2e' });
    expect(run.lines.some(isNotification)).toBe(false);

    const notification = await run.waitFor(isNotification, 1, 5_000);
    // One second after the turn (a margin for a loaded machine seeing the result late).
    expect(Date.now() - firstAt).toBeGreaterThanOrEqual(500);
    expect(notification).toMatchObject({ task_id: id, tool_use_id: call?.['id'], status: 'completed', summary: 'Background command "npm run e2e" completed (exit code 0)' });
    const second = await run.waitFor(isResult, 2, 5_000);
    expect(origin(second)).toBe('task-notification');
    // Like the CLI: no user line for the notification on stdout, init opens the CLI's turn, one replay only (the message).
    const after = run.lines.slice(run.lines.indexOf(notification));
    expect(after.map((l) => `${String(l['type'])}${l['subtype'] ? `/${String(l['subtype'])}` : ''}`)).toEqual([
      'system/task_notification',
      'system/init',
      'assistant',
      'assistant',
      'result/success',
    ]);
    expect(run.lines.filter((l) => l['type'] === 'user' && l['isReplay'] === true)).toHaveLength(1);
    run.end();
    expect((await run.exited).code).toBe(0);
  });

  it('[fake:background-gh]: the GitHub Actions wait command; [fake:wakeup]: a ScheduleWakeup, then a turn of its own', async () => {
    const run = start();
    run.send(userLine('Watch CI [fake:background-gh 0.2]'));
    await run.waitFor(isNotification, 1, 5_000);
    expect(toolUses(run.lines)[0]).toMatchObject({ name: 'Bash', input: { command: GH_WAIT_COMMAND, run_in_background: true } });
    await run.waitFor(isResult, 2, 5_000);

    run.send(userLine('Check back later [fake:wakeup 0.3]'));
    await run.waitFor(isResult, 3, 5_000);
    const wake = toolUses(run.lines).at(-1);
    expect(wake).toMatchObject({ name: 'ScheduleWakeup', input: { delaySeconds: 0.3, reason: WAKEUP_REASON } });
    expect(toolResultOf(run.lines, wake?.['id']).block).toMatchObject({ content: toolResultText('ScheduleWakeup') });
    // The wake-up: a turn without a stdin message behind it (no replay, no origin).
    const fired = await run.waitFor(isResult, 4, 5_000);
    expect(origin(fired)).toBeNull();
    expect(run.lines.filter((l) => l['type'] === 'user' && l['isReplay'] === true)).toHaveLength(2);
    run.end();
    expect((await run.exited).code).toBe(0);
  });

  it('EOF before the task ends: the process exits, nothing more is reported; a bad token exits 1', async () => {
    const run = start();
    run.send(userLine('[fake:background 2 npm run dev]'));
    await run.waitFor(isResult, 1);
    run.end();
    expect((await run.exited).code).toBe(0);
    expect(run.lines.filter(isResult)).toHaveLength(1);
    expect(run.lines.some(isNotification)).toBe(false);

    const bad = start();
    bad.send(userLine('[fake:background 5]'));
    expect((await bad.exited).code).toBe(1);
    expect(bad.stderr()).toContain('[fake:background <seconds> <cmd>]');
  });
});
