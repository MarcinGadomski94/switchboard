import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, keepaliveNow, withKeepalive } from '../../src/web/api/client.ts';
import { readFileSync } from 'node:fs';
import { parseInitializeModels } from '../../src/core/model-choice.ts';
import { DEFAULT_EFFORT_LABEL, DEFAULT_MODEL_LABEL, MODELS_UNKNOWN, modelEffortField, modelName, modelSummary, pickEffort, pickModel, startField } from '../../src/web/v2/shared/model-effort.ts';

/** The fake claude's `initialize` models (the recorded `ctl-init`: 11 models, Haiku without effort levels). */
function fakeClaudeModels() {
  for (const line of readFileSync(new URL('../../tools/fake-claude/fixtures/ctl-init.ndjson', import.meta.url), 'utf8').split('\n')) {
    if (!line.includes('"models"')) continue;
    const reply = (JSON.parse(line) as { response: { response: unknown } }).response.response;
    const models = parseInitializeModels(reply);
    if (models) return models;
  }
  throw new Error('no models in the fixture');
}

/** The fake codex's `model/list` as the service stores it. */
const CODEX = [
  { value: 'gpt-5.5-codex', label: 'GPT-5.5 Codex', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { value: 'gpt-5.5-mini', label: 'GPT-5.5 mini', efforts: ['low', 'medium'] },
];

describe('fixes after 2.0 · Model and Effort (model-effort.ts)', () => {
  const claude = fakeClaudeModels();

  it('lists the engine’s own models by their labels, the CLI’s default first', () => {
    const field = modelEffortField({ model: null, effort: null }, claude);
    expect(field.models[0]).toEqual({ value: 'default', label: DEFAULT_MODEL_LABEL });
    expect(field.models.map((m) => m.label)).toEqual([DEFAULT_MODEL_LABEL, 'Opus 5.5', 'Fable 5.1', 'Sonnet 5', 'Haiku 4.5', 'Opus 5', 'Fable 5', 'Opus 4.8', 'Opus 4.7', 'Opus 4.6', 'Sonnet 4.6']);
    expect(field.model).toBe('default');
    expect(field.disabled).toBe(false);
    // Codex lists no `default` entry: the CLI's default is added in front.
    const codex = modelEffortField({ model: 'gpt-5.5-mini', effort: null }, CODEX);
    expect(codex.models).toEqual([{ value: 'default', label: DEFAULT_MODEL_LABEL }, { value: 'gpt-5.5-codex', label: 'GPT-5.5 Codex' }, { value: 'gpt-5.5-mini', label: 'GPT-5.5 mini' }]);
    expect(codex.efforts?.map((e) => e.label)).toEqual([DEFAULT_EFFORT_LABEL, 'low', 'medium']);
  });

  it('offers the chosen model’s own effort levels by the CLI’s names, and none (with a reason) for a model without', () => {
    expect(modelEffortField({ model: 'opus', effort: 'xhigh' }, claude)).toMatchObject({ effort: 'xhigh', summary: 'Opus 5.5 · xhigh', effortReason: null });
    expect(modelEffortField({ model: 'opus', effort: null }, claude).efforts).toEqual([
      { value: '', label: 'Default' },
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
      { value: 'xhigh', label: 'xhigh' },
      { value: 'max', label: 'max' },
    ]);
    expect(modelEffortField({ model: 'claude-sonnet-4-6', effort: null }, claude).efforts?.map((e) => e.value)).toEqual(['', 'low', 'medium', 'high', 'max']);
    const haiku = modelEffortField({ model: 'haiku', effort: 'high' }, claude);
    expect(haiku.efforts).toBeNull();
    expect(haiku.effort).toBe('');
    expect(haiku.effortReason).toBe('Haiku 4.5 has no effort levels.');
    expect(haiku.summary).toBe('Haiku 4.5');
  });

  it('keeps the effort across a model change only when the new model has it', () => {
    expect(pickModel({ model: 'opus', effort: 'xhigh' }, claude, 'claude-opus-4-6')).toEqual({ model: 'claude-opus-4-6', effort: null });
    expect(pickModel({ model: 'opus', effort: 'high' }, claude, 'sonnet')).toEqual({ model: 'sonnet', effort: 'high' });
    expect(pickModel({ model: 'opus', effort: 'high' }, claude, 'haiku')).toEqual({ model: 'haiku', effort: null });
    expect(pickModel({ model: 'opus', effort: 'high' }, claude, 'default')).toEqual({ model: null, effort: 'high' });
    expect(pickEffort({ model: 'opus', effort: 'high' }, '')).toEqual({ model: 'opus', effort: null });
  });

  it('while the models are unknown: off with a reason, the stored choice still shown', () => {
    const field = modelEffortField({ model: 'opus', effort: 'high' }, null);
    expect(field).toMatchObject({ disabled: true, reason: MODELS_UNKNOWN, model: 'opus', efforts: null });
    expect(field.models).toEqual([{ value: 'default', label: DEFAULT_MODEL_LABEL }, { value: 'opus', label: 'Opus' }]);
  });

  it('a new agent starts on the pick, else the engine’s last choice, per engine (aliases while Claude Code reported none)', () => {
    expect(startField(null, { options: claude, last: { model: 'sonnet', effort: 'max' } }, true, 'claude')).toMatchObject({ model: 'sonnet', effort: 'max' });
    expect(startField({ model: 'opus', effort: 'low' }, { options: claude, last: { model: 'sonnet', effort: 'max' } }, true, 'claude')).toMatchObject({ model: 'opus', effort: 'low' });
    const aliases = startField(null, { options: null, last: null }, true, 'claude');
    expect(aliases.models.map((m) => m.value)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
    expect(aliases.efforts).toBeNull();
    const codex = startField(null, { options: CODEX, last: { model: 'gpt-5.5-codex', effort: 'xhigh' } }, true, 'codex');
    expect(codex).toMatchObject({ model: 'gpt-5.5-codex', effort: 'xhigh' });
    expect(startField(null, { options: null, last: null }, true, 'opencode').models).toEqual([{ value: 'default', label: DEFAULT_MODEL_LABEL }]);
    expect(startField(null, null, false, 'claude').disabled).toBe(true);
  });

  it('agents started with Smart / Fast keep their resolved model, named by its label', () => {
    // Smart sent `opus` (or the first Opus model listed), Fast `sonnet` (else Haiku): stored as is.
    expect(modelSummary({ current: 'opus', effort: null, available: claude })).toBe('Opus 5.5');
    expect(modelSummary({ current: 'sonnet', effort: 'high', available: claude })).toBe('Sonnet 5 · high');
    expect(modelName(null, 'sonnet')).toBe('Sonnet');
    expect(modelName(null, 'claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(modelName(claude, 'claude-opus-4-7')).toBe('Opus 4.7');
    expect(modelName(claude, null)).toBe('Default');
    expect(modelEffortField({ model: 'sonnet', effort: null }, claude).model).toBe('sonnet');
  });
});

describe('lane X · keepalive for the Undo windows', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a request started inside withKeepalive goes out with keepalive', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', (_path: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    expect(keepaliveNow()).toBe(false);
    await withKeepalive(() => api.inbox());
    await api.inbox();
    expect(calls[0]?.keepalive).toBe(true);
    expect(calls[1]?.keepalive).toBeUndefined();
    expect(keepaliveNow()).toBe(false);
  });
});
