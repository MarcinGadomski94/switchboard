import { describe, expect, it } from 'vitest';
import {
  type ContextState,
  DEFAULT_CONTEXT_WINDOW,
  EMPTY_CONTEXT,
  ONE_M_CONTEXT_WINDOW,
  contextBand,
  contextFromTranscript,
  contextPercent,
  contextWindow,
  readContextState,
  reduceContext,
  reportedWindows,
  resolveContext,
  usageContextTokens,
} from '../../src/core/context-meter.ts';
import { parseStreamLine } from '../../src/core/stream-json.ts';

/** D49: the pure context meter (`src/core/context-meter.ts`, `docs/chat.md` → *Context bar*). */

const T0 = '2026-09-29T12:05:00.000Z';
const T1 = '2026-09-29T12:10:00.000Z';
const usage = (input: number, creation: number, read: number, output = 50): Record<string, unknown> => ({
  input_tokens: input,
  cache_creation_input_tokens: creation,
  cache_read_input_tokens: read,
  output_tokens: output,
});

function feed(state: ContextState, ...inputs: Parameters<typeof reduceContext>[1][]): ContextState {
  return inputs.reduce(reduceContext, state);
}

describe('usageContextTokens (the CLI formula: input + cache creation + cache read)', () => {
  it('sums the three input fields, never the output tokens', () => {
    expect(usageContextTokens(usage(10, 29_080, 18_690, 50))).toBe(47_780);
    expect(usageContextTokens(usage(10, 29_080, 18_690, 99_999))).toBe(47_780);
  });

  it('is no reading without an object or when the inputs sum to 0; missing fields count 0', () => {
    expect(usageContextTokens(undefined)).toBeNull();
    expect(usageContextTokens('x')).toBeNull();
    expect(usageContextTokens(usage(0, 0, 0, 12))).toBeNull();
    expect(usageContextTokens({ input_tokens: 5 })).toBe(5);
  });

  it('uses the last non-compaction iteration when the usage has iterations (the CLI kTe)', () => {
    const withIterations = {
      ...usage(100, 100, 100),
      iterations: [
        { type: 'message', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
        { type: 'message', input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 },
        { type: 'compaction', input_tokens: 999, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ],
    };
    expect(usageContextTokens(withIterations)).toBe(60);
    // A malformed last iteration: the top-level sums.
    expect(usageContextTokens({ ...usage(100, 100, 100), iterations: [{ type: 'message', input_tokens: 'x' }] })).toBe(300);
  });
});

describe('reduceContext', () => {
  it('a main usage sets the reading; the same reading again changes nothing (same object)', () => {
    const a = reduceContext(EMPTY_CONTEXT, { kind: 'usage', model: 'claude-opus-4-7', usage: usage(3, 60_000, 64_000), at: T0 });
    expect(a).toMatchObject({ tokens: 124_003, model: 'claude-opus-4-7', updatedAt: T0 });
    expect(reduceContext(a, { kind: 'usage', model: 'claude-opus-4-7', usage: usage(3, 60_000, 64_000, 9), at: T1 })).toBe(a);
  });

  it('ignores the <synthetic> filler and usages without a reading', () => {
    expect(reduceContext(EMPTY_CONTEXT, { kind: 'usage', model: '<synthetic>', usage: usage(1, 2, 3), at: T0 })).toBe(EMPTY_CONTEXT);
    expect(reduceContext(EMPTY_CONTEXT, { kind: 'usage', model: 'm', usage: usage(0, 0, 0), at: T0 })).toBe(EMPTY_CONTEXT);
  });

  it('a result stores its modelUsage windows (only positive numbers)', () => {
    const next = reduceContext(EMPTY_CONTEXT, { kind: 'result', modelUsage: { 'claude-opus-4-7': { contextWindow: 200_000 }, 'claude-haiku-4-5': { contextWindow: 0 }, x: 'no' } });
    expect(next.windows).toEqual({ 'claude-opus-4-7': 200_000 });
    expect(reduceContext(next, { kind: 'result', modelUsage: { 'claude-opus-4-7': { contextWindow: 200_000 } } })).toBe(next);
    expect(reportedWindows(null)).toEqual({});
  });

  it('compaction: the reading resets to post_tokens (or unknown), "compacted" shows until the turn after the compaction starts', () => {
    const before = feed(EMPTY_CONTEXT, { kind: 'turn-start', model: 'claude-opus-4-7' }, { kind: 'usage', model: 'claude-opus-4-7', usage: usage(3, 90_000, 90_000), at: T0 });
    expect(before.tokens).toBe(180_003);
    const compacted = reduceContext(before, { kind: 'compact', trigger: 'auto', preTokens: 180_003, postTokens: 21_000, at: T1 });
    expect(compacted).toMatchObject({ tokens: 21_000, compactedRecently: true, compaction: { at: T1, trigger: 'auto', preTokens: 180_003, postTokens: 21_000 } });
    // The same turn goes on: its next usage replaces the estimate, "compacted" stays.
    const after = feed(compacted, { kind: 'usage', model: 'claude-opus-4-7', usage: usage(3, 10_000, 15_000), at: T1 });
    expect(after).toMatchObject({ tokens: 25_003, compactedRecently: true });
    // An `init` inside the compaction's turn (before its result) keeps it.
    expect(reduceContext(after, { kind: 'turn-start', model: 'claude-opus-4-7' }).compactedRecently).toBe(true);
    const ended = reduceContext(after, { kind: 'result', modelUsage: {} });
    expect(ended.compactedRecently).toBe(true);
    const next = reduceContext(ended, { kind: 'turn-start', model: 'claude-opus-4-7' });
    expect(next).toMatchObject({ compactedRecently: false, tokens: 25_003, compaction: { at: T1 } });
  });

  it('a boundary without post_tokens leaves the reading unknown until the next usage', () => {
    const compacted = feed(EMPTY_CONTEXT, { kind: 'usage', model: 'm', usage: usage(1, 1, 150_000), at: T0 }, { kind: 'compact', trigger: 'manual', preTokens: 150_002, postTokens: null, at: T1 });
    expect(compacted.tokens).toBeNull();
    expect(resolveContext(compacted, null)).toMatchObject({ tokens: null, percent: null, band: 'unknown', compactedRecently: true });
  });
});

describe('the stream (StreamRecorder inputs): sidechain exclusion', () => {
  it('parses system/compact_boundary with its metadata (the binary\'s field names)', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'compact_boundary', session_id: 's', uuid: 'u', compact_metadata: { trigger: 'auto', pre_tokens: 167_000, post_tokens: 18_000, duration_ms: 1 } });
    expect(parseStreamLine(line)).toMatchObject({ kind: 'compact-boundary', trigger: 'auto', preTokens: 167_000, postTokens: 18_000, parentToolUseId: null, uuid: 'u' });
    expect(parseStreamLine(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 5 } }))).toMatchObject({ postTokens: null });
  });
});

describe('contextWindow (the window follows the model)', () => {
  const opus: ContextState = { ...EMPTY_CONTEXT, tokens: 124_000, model: 'claude-opus-4-7', windows: { 'claude-opus-4-7': 200_000 } };

  it('the reported modelUsage window of the reading\'s model', () => {
    expect(contextWindow(opus, 'opus')).toEqual({ window: 200_000, source: 'reported' });
    expect(contextWindow({ ...opus, windows: { 'claude-opus-4-7': 1_000_000 } }, null)).toEqual({ window: 1_000_000, source: 'reported' });
  });

  it('without a reported window: [1m] in the choice (or the init model) → 1M, else 200k', () => {
    const bare = { ...opus, windows: {} };
    expect(contextWindow(bare, null)).toEqual({ window: DEFAULT_CONTEXT_WINDOW, source: 'model' });
    expect(contextWindow(bare, 'opus[1m]')).toEqual({ window: ONE_M_CONTEXT_WINDOW, source: 'model' });
    expect(contextWindow(bare, 'claude-opus-4-7[1M]')).toEqual({ window: ONE_M_CONTEXT_WINDOW, source: 'model' });
    expect(contextWindow({ ...bare, initModel: 'claude-opus-4-7[1m]' }, null)).toEqual({ window: ONE_M_CONTEXT_WINDOW, source: 'model' });
    expect(contextWindow({ ...bare, initModel: 'claude-opus-4-7[1m]' }, 'default')).toEqual({ window: ONE_M_CONTEXT_WINDOW, source: 'model' });
  });

  it('a model change: the choice toggles [1m] → the stale 200k report no longer counts; back again → it counts', () => {
    expect(contextWindow(opus, 'opus[1m]')).toEqual({ window: ONE_M_CONTEXT_WINDOW, source: 'model' });
    const both = { ...opus, windows: { 'claude-opus-4-7': 200_000, 'claude-opus-4-7[1m]': 1_000_000 } };
    expect(contextWindow(both, 'opus[1m]')).toEqual({ window: 1_000_000, source: 'reported' });
    expect(contextWindow(both, 'opus')).toEqual({ window: 200_000, source: 'reported' });
    // Only the [1m] key and a choice without it: derived.
    expect(contextWindow({ ...opus, windows: { 'claude-opus-4-7[1m]': 1_000_000 } }, 'opus')).toEqual({ window: 200_000, source: 'model' });
  });

  it('a model change to another model: the next reading\'s model picks its own window', () => {
    const switched = feed(
      { ...opus, windows: { 'claude-opus-4-7': 200_000, 'claude-sonnet-4-6': 1_000_000 } },
      { kind: 'usage', model: 'claude-sonnet-4-6', usage: usage(3, 100_000, 100_000), at: T1 },
    );
    expect(resolveContext(switched, 'sonnet')).toMatchObject({ model: 'claude-sonnet-4-6', window: 1_000_000, percent: 20, band: 'ok' });
  });
});

describe('percent and band', () => {
  it('rounds like the CLI, clamps to 0–100', () => {
    expect(contextPercent(124_000, 200_000)).toBe(62);
    expect(contextPercent(119_000, 200_000)).toBe(60); // 59.5 → 60
    expect(contextPercent(500_000, 200_000)).toBe(100);
    expect(contextPercent(10, 0)).toBe(0);
  });

  it('green below 60, yellow from 60, red from 80 (on the shown percentage)', () => {
    expect([contextBand(null), contextBand(0), contextBand(59), contextBand(60), contextBand(79), contextBand(80), contextBand(100)]).toEqual([
      'unknown',
      'ok',
      'ok',
      'warn',
      'warn',
      'high',
      'high',
    ]);
  });

  it('resolveContext: 1M window', () => {
    const state = feed(EMPTY_CONTEXT, { kind: 'usage', model: 'claude-opus-4-7', usage: usage(3, 400_000, 420_000), at: T0 }, { kind: 'result', modelUsage: { 'claude-opus-4-7': { contextWindow: 1_000_000 } } });
    expect(resolveContext(state, 'opus[1m]')).toEqual({
      tokens: 820_003,
      window: 1_000_000,
      windowSource: 'reported',
      model: 'claude-opus-4-7',
      percent: 82,
      band: 'high',
      updatedAt: T0,
      compaction: null,
      compactedRecently: false,
    });
  });
});

describe('readContextState (stored JSON, read leniently)', () => {
  it('round-trips a state and drops junk', () => {
    const state: ContextState = {
      ...EMPTY_CONTEXT,
      tokens: 5,
      model: 'm',
      initModel: 'm[1m]',
      windows: { m: 1_000_000 },
      updatedAt: T0,
      compaction: { at: T0, trigger: 'auto', preTokens: 9, postTokens: null },
      compactedRecently: true,
      compactTurnEnded: true,
    };
    expect(readContextState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(readContextState(null)).toEqual(EMPTY_CONTEXT);
    expect(readContextState({ tokens: -1, windows: { a: 'x', b: 7 }, compactedRecently: true })).toEqual({ ...EMPTY_CONTEXT, windows: { b: 7 } });
  });
});

describe('contextFromTranscript (a terminal\'s turns, Attach here)', () => {
  const assistant = (uuid: string, model: string, u: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: 'assistant',
    uuid,
    isSidechain: false,
    timestamp: T0,
    message: { id: `m-${uuid}`, model, usage: u, content: [] },
    ...extra,
  });
  const prompt = (uuid: string, text: string) => ({ type: 'user', uuid, isSidechain: false, timestamp: T0, message: { role: 'user', content: text } });

  it('takes the last main usage; sidechain lines never count', () => {
    const chain = [
      prompt('p1', 'go'),
      assistant('a1', 'claude-opus-4-7', usage(3, 50_000, 50_000)),
      assistant('s1', 'claude-haiku-4-5', usage(3, 190_000, 0), { isSidechain: true }),
    ];
    const from = { ...EMPTY_CONTEXT, windows: { 'claude-opus-4-7': 200_000 } };
    expect(contextFromTranscript(from, chain)).toMatchObject({ tokens: 100_003, model: 'claude-opus-4-7', windows: { 'claude-opus-4-7': 200_000 } });
  });

  it('a compact boundary resets; the next prompt ends "compacted"; nothing seen → the stored state unchanged', () => {
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null, logicalParentUuid: 'a1', timestamp: T1, compactMetadata: { trigger: 'manual', preTokens: 100_003, postTokens: 12_000 } };
    const compacted = contextFromTranscript(EMPTY_CONTEXT, [prompt('p1', 'go'), assistant('a1', 'm', usage(3, 50_000, 50_000)), prompt('p2', '/compact'), boundary]);
    expect(compacted).toMatchObject({ tokens: 12_000, compactedRecently: true, compactTurnEnded: true, compaction: { at: T1, trigger: 'manual', preTokens: 100_003, postTokens: 12_000 } });
    const later = contextFromTranscript(EMPTY_CONTEXT, [boundary, { type: 'user', uuid: 'cs', isCompactSummary: true, message: { role: 'user', content: 'summary' } }, prompt('p3', 'next'), assistant('a3', 'm', usage(3, 7_000, 7_000))]);
    expect(later).toMatchObject({ tokens: 14_003, compactedRecently: false, compaction: { trigger: 'manual' } });
    const stored = { ...EMPTY_CONTEXT, tokens: 42 };
    expect(contextFromTranscript(stored, [prompt('p1', 'hi')])).toBe(stored);
  });
});
