import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionModelOption } from '../../src/core/api.ts';
import {
  CLI_EFFORT_LEVELS,
  checkModelChoice,
  effortLevelsFor,
  modelLabel,
  modelOptionFor,
  modelStepLabel,
  normalizeEffort,
  normalizeModel,
  parseInitializeModels,
} from '../../src/core/model-choice.ts';
import { effortLine, setModelLine } from '../../src/core/stdin.ts';
import { FIXTURES_DIR } from '../../tools/fake-claude/fixtures.ts';

/**
 * D31 (docs/model-effort.md): the `initialize` reply's models list as Switchboard
 * keeps it (the recorded `ctl-init` reply, CLI 2.1.283), the checks the route makes
 * before anything is sent or stored, the chat step line, and the stdin lines.
 */

/** The inner `response` of the recorded `initialize` reply. */
async function recordedInitialize(): Promise<Record<string, unknown>> {
  const lines = (await readFile(path.join(FIXTURES_DIR, 'ctl-init.ndjson'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const reply = lines.find((line) => line['type'] === 'control_response' && (line['response'] as { request_id?: string }).request_id === 'req_init_1');
  return (reply?.['response'] as { response: Record<string, unknown> }).response;
}

const LIST: SessionModelOption[] = [
  { value: 'default', label: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: ['low', 'medium', 'high', 'max'] },
  { value: 'haiku', label: 'Haiku 4.5' },
];

describe('parseInitializeModels (D31)', () => {
  it('reads the recorded initialize reply: value, displayName as label, description, supported effort levels (none for Haiku)', async () => {
    const models = parseInitializeModels(await recordedInitialize());
    expect(models?.map((m) => m.value)).toEqual([
      'default',
      'opus',
      'claude-fable-5-1',
      'sonnet',
      'haiku',
      'claude-opus-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ]);
    expect(models?.[0]).toEqual({ value: 'default', label: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    expect(models?.find((m) => m.value === 'haiku')).toEqual({ value: 'haiku', label: 'Haiku 4.5', description: 'Fastest for quick answers' });
    expect(models?.find((m) => m.value === 'claude-opus-4-6')?.efforts).toEqual(['low', 'medium', 'high', 'max']);
    // Only the four fields: resolvedModel, supportsAutoMode, … are not kept.
    for (const model of models ?? []) expect(Object.keys(model).every((key) => ['value', 'label', 'description', 'efforts'].includes(key))).toBe(true);
  });

  it('reads defensively: no list, an empty one or no usable entry → null; bad entries, repeats and blank levels skipped', () => {
    expect(parseInitializeModels(null)).toBeNull();
    expect(parseInitializeModels({})).toBeNull();
    expect(parseInitializeModels({ models: 'opus' })).toBeNull();
    expect(parseInitializeModels({ models: [] })).toBeNull();
    expect(parseInitializeModels({ models: [{ displayName: 'No value' }, 7, null] })).toBeNull();
    expect(
      parseInitializeModels({
        models: [
          { value: ' opus ', displayName: '', supportedEffortLevels: ['low', 'low', '', 3, 'high'] },
          { value: 'opus', displayName: 'Again' },
          { value: 'sonnet', supportsEffort: false, supportedEffortLevels: ['low'] },
          { value: 'haiku', supportedEffortLevels: [] },
        ],
      }),
    ).toEqual([
      { value: 'opus', label: 'opus', efforts: ['low', 'high'] },
      { value: 'sonnet', label: 'sonnet' },
      { value: 'haiku', label: 'haiku' },
    ]);
  });
});

describe('the stored choice (D31)', () => {
  it('normalizes: blank or default model = null (the CLI default), blank effort = null', () => {
    expect(normalizeModel(null)).toBeNull();
    expect(normalizeModel('  ')).toBeNull();
    expect(normalizeModel('default')).toBeNull();
    expect(normalizeModel(' opus ')).toBe('opus');
    expect(normalizeEffort(null)).toBeNull();
    expect(normalizeEffort('')).toBeNull();
    expect(normalizeEffort(' high ')).toBe('high');
  });

  it('finds the entry of a model (null = the default entry), its effort levels and its label', () => {
    expect(modelOptionFor(LIST, null)?.value).toBe('default');
    expect(modelOptionFor(LIST, 'opus')?.label).toBe('Opus 5.5');
    expect(modelOptionFor(LIST, 'nope')).toBeNull();
    expect(modelOptionFor(null, 'opus')).toBeNull();
    expect(effortLevelsFor(LIST, 'claude-sonnet-4-6')).toEqual(['low', 'medium', 'high', 'max']);
    expect(effortLevelsFor(LIST, 'haiku')).toEqual([]);
    expect(effortLevelsFor(LIST, 'nope')).toBeNull();
    expect(effortLevelsFor(null, null)).toBeNull();
    expect(modelLabel(LIST, 'opus')).toBe('Opus 5.5');
    expect(modelLabel(LIST, null)).toBe('Default (recommended)');
    expect(modelLabel(null, 'claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(modelLabel(null, null)).toBe('default');
  });

  it('the step line: Model: <label> · effort: <level | default>', () => {
    expect(modelStepLabel({ model: 'opus', effort: 'high' }, LIST)).toBe('Model: Opus 5.5 · effort: high');
    expect(modelStepLabel({ model: null, effort: null }, LIST)).toBe('Model: Default (recommended) · effort: default');
    expect(modelStepLabel({ model: 'claude-opus-4-7', effort: 'max' }, null)).toBe('Model: claude-opus-4-7 · effort: max');
  });
});

describe('checkModelChoice (D31: the 422 before anything is sent)', () => {
  it('with the list known: a model must be listed; the effort must be one of that model’s levels; null is always fine', () => {
    expect(checkModelChoice({ model: 'opus', effort: 'xhigh' }, LIST)).toBeNull();
    expect(checkModelChoice({ model: null, effort: 'max' }, LIST)).toBeNull();
    expect(checkModelChoice({ model: 'haiku', effort: null }, LIST)).toBeNull();
    expect(checkModelChoice({ model: 'gpt-4', effort: null }, LIST)).toEqual({
      field: 'model',
      message: 'claude does not offer the model "gpt-4" here: pick one of default, opus, claude-sonnet-4-6, haiku',
    });
    expect(checkModelChoice({ model: 'claude-sonnet-4-6', effort: 'xhigh' }, LIST)).toEqual({
      field: 'effort',
      message: 'Sonnet 4.6 supports the effort levels low, medium, high, max: "xhigh" is not one of them',
    });
    expect(checkModelChoice({ model: 'haiku', effort: 'low' }, LIST)).toEqual({
      field: 'effort',
      message: "Haiku 4.5 has no effort levels: set the effort to null (the CLI's default)",
    });
  });

  it('with the list unknown: any model name, and an effort of the CLI’s --effort choices', () => {
    expect(CLI_EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(checkModelChoice({ model: 'claude-opus-5-5[1m]', effort: 'high' }, null)).toBeNull();
    expect(checkModelChoice({ model: 'opus', effort: 'turbo' }, null)).toEqual({ field: 'effort', message: '"turbo" is not an effort level (low, medium, high, xhigh, max)' });
    // Never something argv would read as a flag, never spaces.
    expect(checkModelChoice({ model: '--dangerously-skip-permissions', effort: null }, null)?.field).toBe('model');
    expect(checkModelChoice({ model: 'opus 5', effort: null }, null)?.field).toBe('model');
    expect(checkModelChoice({ model: 'x'.repeat(101), effort: null }, null)?.field).toBe('model');
    // A stored model the list does not have: its effort is checked against the CLI's choices.
    expect(checkModelChoice({ model: null, effort: 'low' }, [{ value: 'opus', label: 'Opus' }])).toBeNull();
  });
});

describe('stdin lines (D31, probed on CLI 2.1.283)', () => {
  it('set_model and apply_flag_settings {effortLevel}', () => {
    expect(setModelLine('m1', 'opus')).toEqual({ type: 'control_request', request_id: 'm1', request: { subtype: 'set_model', model: 'opus' } });
    expect(effortLine('e1', 'high')).toEqual({ type: 'control_request', request_id: 'e1', request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } } });
    expect(JSON.stringify(effortLine('e2', null))).toBe('{"type":"control_request","request_id":"e2","request":{"subtype":"apply_flag_settings","settings":{"effortLevel":null}}}');
  });
});
