import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../tools/fake-claude/json.ts';
import { sayToken } from '../../tools/fake-claude/scenarios.ts';
import { BASELINE, type FakeEnv, type FakeRun, makeFakeEnv, readTranscript, spawnFake, transcriptPath, userLine } from '../helpers/fake-claude.ts';

/** `[fake:say "<json string>"]` (D20): the default turn with a given reply text, for chat rendering tests. */
const SID = '0b7e6c1d-7777-4222-8333-44445555d20d';

let env: FakeEnv;
let runs: FakeRun[] = [];

beforeEach(async () => {
  env = await makeFakeEnv('fake-say');
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

/** The main agent's reply texts on stdout. */
function replyTexts(lines: readonly JsonObject[]): string[] {
  return lines
    .filter((l) => l['type'] === 'assistant' && l['parent_tool_use_id'] === null)
    .flatMap((l) => ((l['message'] as JsonObject)['content'] as JsonObject[]).filter((b) => b['type'] === 'text').map((b) => String(b['text'])));
}

const REPLY = '## Plan\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = "y";\n```\n<script>alert(1)</script>';

describe('fake-claude · [fake:say] (parser)', () => {
  it('reads one JSON string (escapes included), refuses anything else', () => {
    expect(sayToken(`Show it. [fake:say ${JSON.stringify(REPLY)}]`)).toEqual({ text: REPLY });
    expect(sayToken('[fake:say "a ] b \\"quoted\\" [x](https://example.com)"]')).toEqual({ text: 'a ] b "quoted" [x](https://example.com)' });
    expect(sayToken('no token')).toBeNull();
    expect(sayToken('[fake:default]')).toBeNull();
    expect(sayToken('[fake:say]')).toMatchObject({ error: expect.any(String) });
    expect(sayToken('[fake:say plain]')).toMatchObject({ error: expect.any(String) });
    expect(sayToken('[fake:say "bad \\q escape"]')).toMatchObject({ error: expect.stringContaining('not JSON') });
  });
});

describe('fake-claude · [fake:say] (process)', () => {
  it('replies with the given text (stdout, result, transcript); the next message gets the default reply', async () => {
    const run = start();
    run.send(userLine(`Show it. [fake:say ${JSON.stringify(REPLY)}]`));
    await run.waitFor(isResult, 1);
    expect(replyTexts(run.lines)).toEqual([REPLY]);
    expect(run.lines.find(isResult)).toMatchObject({ is_error: false, result: REPLY });

    run.send(userLine('And now?'));
    await run.waitFor(isResult, 2);
    expect(replyTexts(run.lines)).toEqual([REPLY, 'OK']);
    run.end();
    expect((await run.exited).code).toBe(0);

    const transcript = await readTranscript(transcriptPath(env.configDir, env.cwd, SID));
    const texts = transcript
      .filter((e) => e['type'] === 'assistant')
      .flatMap((e) => ((e['message'] as JsonObject)['content'] as JsonObject[]).filter((b) => b['type'] === 'text').map((b) => String(b['text'])));
    expect(texts).toEqual([REPLY, 'OK']);
  });

  it('a bad [fake:say] token exits 1', async () => {
    const bad = start();
    bad.send(userLine('[fake:say not-json]'));
    expect((await bad.exited).code).toBe(1);
    expect(bad.stderr()).toContain('[fake:say]');
  });
});
