import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../tools/fake-claude/json.ts';
import { fireToken, toolResultText, toolToken } from '../../tools/fake-claude/scenarios.ts';
import { BASELINE, type FakeEnv, type FakeRun, makeFakeEnv, spawnFake, userLine } from '../helpers/fake-claude.ts';

/** `[fake:tool]` and `[fake:fire]` (M7.2): loop tool calls and turns the fake runs on its own. */
const SID = '0b7e6c1d-7777-4222-8333-44445555f00d';

let env: FakeEnv;
let runs: FakeRun[] = [];

beforeEach(async () => {
  env = await makeFakeEnv('fake-loop');
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

function toolUses(lines: readonly JsonObject[]): JsonObject[] {
  return lines
    .filter((l) => l['type'] === 'assistant')
    .flatMap((l) => ((l['message'] as JsonObject)['content'] as JsonObject[]).filter((b) => b['type'] === 'tool_use'));
}

describe('fake-claude · loop tokens (parsers)', () => {
  it('[fake:tool <Name> {json}] and [fake:fire <n> <ms>]', () => {
    expect(toolToken('/loop 5m x [fake:tool CronCreate {"cron":"*/5 * * * *","prompt":"x","recurring":true}] [fake:fire 2 100]')).toEqual({
      name: 'CronCreate',
      input: { cron: '*/5 * * * *', prompt: 'x', recurring: true },
    });
    expect(toolToken('[fake:tool Workflow {"a":{"b":1}}]')).toEqual({ name: 'Workflow', input: { a: { b: 1 } } });
    expect(toolToken('no token')).toBeNull();
    // The `tool-use` scenario token is not a [fake:tool] token.
    expect(toolToken('Write a file [fake:tool-use]')).toBeNull();
    expect(toolToken('[fake:tool CronCreate {nope}]')).toMatchObject({ error: expect.stringContaining('not JSON') });
    expect(toolToken('[fake:tool CronCreate]')).toMatchObject({ error: expect.any(String) });
    expect(fireToken('[fake:fire 2 150]')).toEqual({ count: 2, everyMs: 150 });
    expect(fireToken('[fake:fire 500 1]')).toEqual({ count: 100, everyMs: 10 });
    expect(fireToken('[fake:fire]')).toBeNull();
  });
});

describe('fake-claude · loop tokens (process)', () => {
  it('plays the tool call with the given input and an invented result, then turns of its own without a stdin message', async () => {
    const run = start();
    run.send(userLine('/loop 5m check [fake:tool CronCreate {"cron":"*/5 * * * *","prompt":"check"}] [fake:fire 2 100]'));
    await run.waitFor(isResult, 1);
    const [call] = toolUses(run.lines);
    expect(call).toMatchObject({ name: 'CronCreate', input: { cron: '*/5 * * * *', prompt: 'check' } });
    const toolResult = run.lines.find((l) => l['type'] === 'user' && JSON.stringify(l).includes('tool_result')) as JsonObject;
    const block = ((toolResult['message'] as JsonObject)['content'] as JsonObject[])[0] as JsonObject;
    expect(block).toMatchObject({ type: 'tool_result', tool_use_id: call?.['id'], content: toolResultText('CronCreate') });
    expect(toolResult['tool_use_result']).toBe(toolResultText('CronCreate'));

    // Two more results arrive with no stdin message behind them, and no replay echo.
    await run.waitFor(isResult, 3, 5_000);
    const replays = run.lines.filter((l) => l['type'] === 'user' && l['isReplay'] === true);
    expect(replays).toHaveLength(1);
    expect(run.lines.filter(isResult).map((l) => l['is_error'])).toEqual([false, false, false]);
    // Nothing more fires.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(run.lines.filter(isResult)).toHaveLength(3);
    run.end();
    expect((await run.exited).code).toBe(0);
  });

  it('EOF stops pending firings; a bad [fake:tool] token exits 1', async () => {
    const run = start();
    run.send(userLine('go [fake:fire 3 400]'));
    await run.waitFor(isResult, 1);
    run.end();
    expect((await run.exited).code).toBe(0);
    expect(run.lines.filter(isResult)).toHaveLength(1);

    const bad = start();
    bad.send(userLine('[fake:tool CronCreate {oops}]'));
    expect((await bad.exited).code).toBe(1);
    expect(bad.stderr()).toContain('[fake:tool]');
  });
});
