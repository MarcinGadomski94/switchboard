import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextFromTranscript, EMPTY_CONTEXT, usageContextTokens } from '../../src/core/context-meter.ts';
import { newestChain } from '../../src/core/transcript-sync.ts';
import type { JsonObject } from '../../tools/fake-claude/json.ts';
import { compactToken, usageToken } from '../../tools/fake-claude/scenarios.ts';
import { BASELINE, type FakeEnv, type FakeRun, makeFakeEnv, readTranscript, spawnFake, transcriptPath, userLine } from '../helpers/fake-claude.ts';

/** D49 `[fake:usage]` / `[fake:compact]`: the context size and a compaction, for the context bar on the real path. */
const SID = '0b7e6c1d-7777-4222-8333-44445555d49d';

let env: FakeEnv;
let runs: FakeRun[] = [];

beforeEach(async () => {
  env = await makeFakeEnv('fake-context');
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
const mainUsages = (lines: readonly JsonObject[]): Array<number | null> =>
  lines.filter((l) => l['type'] === 'assistant' && l['parent_tool_use_id'] === null).map((l) => usageContextTokens((l['message'] as JsonObject)['usage']));

describe('fake-claude · [fake:usage] / [fake:compact] (parsers)', () => {
  it('reads the numbers, refuses malformed tokens', () => {
    expect(usageToken('go [fake:usage 124000]')).toEqual({ tokens: 124_000, window: null });
    expect(usageToken('[fake:usage 820000 1000000]')).toEqual({ tokens: 820_000, window: 1_000_000 });
    expect(usageToken('plain')).toBeNull();
    expect(usageToken('[fake:usage]')).toMatchObject({ error: expect.any(String) });
    expect(usageToken('[fake:usage lots]')).toMatchObject({ error: expect.any(String) });
    expect(compactToken('[fake:compact auto 170000 18000]')).toEqual({ trigger: 'auto', preTokens: 170_000, postTokens: 18_000 });
    expect(compactToken('[fake:compact manual 5000]')).toEqual({ trigger: 'manual', preTokens: 5_000, postTokens: null });
    expect(compactToken('[fake:compact sometimes 1]')).toMatchObject({ error: expect.any(String) });
    expect(compactToken('nothing')).toBeNull();
  });
});

describe('fake-claude · [fake:usage] / [fake:compact] (process)', () => {
  it('usage on every main assistant line and the reported window; a boundary after init, in the transcript too', async () => {
    const run = start();
    run.send(userLine('Fill it. [fake:usage 124000 1000000]'));
    await run.waitFor(isResult, 1);
    expect(mainUsages(run.lines).every((t) => t === 124_000)).toBe(true);
    const first = run.lines.find(isResult) as JsonObject;
    expect(Object.values(first['modelUsage'] as JsonObject).map((m) => (m as JsonObject)['contextWindow'])).toEqual([1_000_000]);

    run.send(userLine('Compact. [fake:compact auto 124000 18000] [fake:usage 25000]'));
    await run.waitFor(isResult, 2);
    const initAt = run.lines.findLastIndex((l) => l['type'] === 'system' && l['subtype'] === 'init');
    const boundary = run.lines[initAt + 1] as JsonObject;
    expect(boundary).toMatchObject({ type: 'system', subtype: 'compact_boundary', session_id: SID, compact_metadata: { trigger: 'auto', pre_tokens: 124_000, post_tokens: 18_000 } });
    expect(typeof boundary['uuid']).toBe('string');
    expect(mainUsages(run.lines).at(-1)).toBe(25_000);
    run.end();
    expect((await run.exited).code).toBe(0);

    const transcript = await readTranscript(transcriptPath(env.configDir, env.cwd, SID));
    const entry = transcript.find((e) => e['subtype'] === 'compact_boundary');
    expect(entry).toMatchObject({ type: 'system', content: 'Conversation compacted', parentUuid: null, uuid: boundary['uuid'], compactMetadata: { trigger: 'auto', preTokens: 124_000, postTokens: 18_000 } });
    expect(typeof entry?.['logicalParentUuid']).toBe('string');
    // The chain goes through the boundary (logicalParentUuid), and the meter reads it like the stream.
    const context = contextFromTranscript(EMPTY_CONTEXT, newestChain(transcript));
    expect(context).toMatchObject({ tokens: 25_000, compaction: { trigger: 'auto', preTokens: 124_000, postTokens: 18_000 }, compactedRecently: true });
  });

  it('a bad token exits 1', async () => {
    const bad = start();
    bad.send(userLine('[fake:compact never 1]'));
    expect((await bad.exited).code).toBe(1);
    expect(bad.stderr()).toContain('[fake:compact]');
  });
});
