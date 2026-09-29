import { describe, expect, it } from 'vitest';
import type { ModelSettings, SessionModelOption } from '../../src/core/api.ts';
import { CLI_MODEL_ALIASES, fitModelChoice, readModelChoice, readModelOptions } from '../../src/core/model-choice.ts';
import { cronPreview, scheduleSummaryLines, toScheduleInput } from '../../src/web/modals/schedule-form.ts';
import {
  DEFAULT_FORM,
  MODELS_LOADING,
  MODEL_APPLIES_AT_START,
  NO_MODEL_SETTINGS,
  type NewSessionForm,
  formFromPrefill,
  formModel,
  formModelOptions,
  formModelPicker,
  modelSummaryLine,
  pickFormEffort,
  pickFormModel,
  repoSummaryLines,
  summaryLines,
  toStartBody,
  withFormModel,
} from '../../src/web/modals/new-session.ts';

/**
 * D42 in the UI (pure parts; the real path is tests/e2e/model-at-start.spec.ts):
 * the Model row's options (the reported list, else the CLI's aliases), its start
 * (the last choice, else the CLI's default; a prefill's; fitted to the list), the
 * effort levels per model, the picks, the summary's `model` line and the bodies.
 */

const LIST: SessionModelOption[] = [
  { value: 'default', label: 'Default (recommended)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: ['low', 'medium', 'high', 'max'] },
  { value: 'haiku', label: 'Haiku 4.5' },
];

function form(patch: Partial<NewSessionForm> = {}): NewSessionForm {
  return { ...DEFAULT_FORM, ...patch };
}

const reported = (last: ModelSettings['last'] = null): ModelSettings => ({ options: LIST, last });

describe('the Model row: options and default (D42)', () => {
  it('offers the reported list, else the CLI aliases without effort levels', () => {
    expect(formModelOptions(reported())).toEqual(LIST);
    expect(formModelOptions(NO_MODEL_SETTINGS)).toBe(CLI_MODEL_ALIASES);
    expect(formModelOptions(null)).toBe(CLI_MODEL_ALIASES);
    expect(CLI_MODEL_ALIASES.map((o) => o.value)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
    expect(CLI_MODEL_ALIASES.every((o) => o.efforts === undefined)).toBe(true);
  });

  it('starts on the last choice, else the CLI default; nothing while the settings load', () => {
    expect(formModel(form(), reported({ model: 'opus', effort: 'high' }))).toEqual({ model: 'opus', effort: 'high' });
    expect(formModel(form(), reported())).toEqual({ model: null, effort: null });
    expect(formModel(form(), NO_MODEL_SETTINGS)).toEqual({ model: null, effort: null });
    expect(formModel(form(), null)).toBeNull();
    // A pick (or a prefill) wins over the last choice.
    expect(formModel(form({ model: { model: 'haiku', effort: null } }), reported({ model: 'opus', effort: 'high' }))).toEqual({ model: 'haiku', effort: null });
  });

  it('fits the choice to what is on offer: an unknown model and a level the model lacks fall back to the defaults', () => {
    expect(formModel(form(), reported({ model: 'gpt-4', effort: 'high' }))).toEqual({ model: null, effort: 'high' });
    expect(formModel(form(), reported({ model: 'claude-sonnet-4-6', effort: 'xhigh' }))).toEqual({ model: 'claude-sonnet-4-6', effort: null });
    expect(formModel(form(), reported({ model: 'haiku', effort: 'low' }))).toEqual({ model: 'haiku', effort: null });
    // The aliases have no levels: a remembered effort is dropped.
    expect(formModel(form(), { options: null, last: { model: 'opus', effort: 'high' } })).toEqual({ model: 'opus', effort: null });
    expect(fitModelChoice({ model: 'claude-opus-4-7', effort: 'max' }, CLI_MODEL_ALIASES)).toEqual({ model: null, effort: null });
  });

  it('the picker: the chosen model’s effort levels only, none for a model without levels; disabled while loading', () => {
    const opus = formModelPicker(form(), reported({ model: 'opus', effort: 'high' }));
    expect(opus.label).toBe('Opus 5.5 · high');
    expect(opus.note).toBe(MODEL_APPLIES_AT_START);
    expect(opus.disabled).toBe(false);
    expect(opus.efforts?.map((e) => e.value)).toEqual([null, 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(formModelPicker(form({ model: { model: 'claude-sonnet-4-6', effort: null } }), reported()).efforts?.map((e) => e.value)).toEqual([null, 'low', 'medium', 'high', 'max']);
    expect(formModelPicker(form({ model: { model: 'haiku', effort: null } }), reported()).efforts).toBeNull();
    const aliases = formModelPicker(form(), NO_MODEL_SETTINGS);
    expect(aliases.models.map((m) => [m.value, m.selected])).toEqual([
      ['default', true],
      ['opus', false],
      ['sonnet', false],
      ['haiku', false],
    ]);
    expect(aliases.efforts).toBeNull();
    expect(aliases.label).toBe('Default');
    expect(formModelPicker(form(), null)).toMatchObject({ disabled: true, reason: MODELS_LOADING, label: 'Default' });
  });

  it('a model pick keeps the effort when the new model has it, else Default; an effort pick sets it', () => {
    const choice = { model: 'opus', effort: 'xhigh' };
    expect(pickFormModel(choice, LIST, 'claude-sonnet-4-6')).toEqual({ model: 'claude-sonnet-4-6', effort: null });
    expect(pickFormModel({ model: 'opus', effort: 'high' }, LIST, 'claude-sonnet-4-6')).toEqual({ model: 'claude-sonnet-4-6', effort: 'high' });
    expect(pickFormModel(choice, LIST, 'default')).toEqual({ model: null, effort: 'xhigh' });
    expect(pickFormModel(choice, LIST, 'opus')).toBe(choice);
    expect(pickFormModel({ model: null, effort: null }, CLI_MODEL_ALIASES, 'sonnet')).toEqual({ model: 'sonnet', effort: null });
    expect(pickFormEffort(choice, 'low')).toEqual({ model: 'opus', effort: 'low' });
    expect(pickFormEffort(choice, null)).toEqual({ model: 'opus', effort: null });
  });
});

describe('the summary line and the bodies (D42)', () => {
  it('the summary: `model     <model> · <effort>` right after ultracode, as the trigger reads', () => {
    const lines = summaryLines(withFormModel(form({ name: 'x', solutions: ['mobile'] }), reported({ model: 'opus', effort: 'high' })), '/ws', [], null, 'start', LIST).map((l) => l.text);
    const at = lines.indexOf('ultracode off');
    expect(lines[at + 1]).toBe('model     Opus 5.5 · high');
    expect(lines[at + 2]).toBe(' ');
    expect(modelSummaryLine({ model: null, effort: null }, LIST)).toEqual({ text: 'model     Default', tone: 'value' });
    expect(modelSummaryLine({ model: 'haiku', effort: null }, LIST).text).toBe('model     Haiku 4.5');
    expect(modelSummaryLine({ model: 'sonnet', effort: null }, CLI_MODEL_ALIASES).text).toBe('model     Sonnet');
    // No line before the form has a choice (the modal fills it in first).
    expect(summaryLines(form({ name: 'x', solutions: ['mobile'] }), '/ws', []).some((l) => l.text.startsWith('model'))).toBe(false);
    const repo = { id: 'f', path: '/src/app', name: 'app', displayName: 'app', kind: 'repo' as const };
    const repoLines = repoSummaryLines(form({ name: 'x', branch: 'PROJ-1-x', model: { model: 'opus', effort: null } }), repo, [], 'start', LIST).map((l) => l.text);
    expect(repoLines[repoLines.indexOf('ultracode off') + 1]).toBe('model     Opus 5.5');
  });

  it('Start sends model / effort (null = the default); nothing before a choice exists', () => {
    const body = toStartBody(withFormModel(form({ name: 'x', worktrees: false }), reported({ model: 'opus', effort: 'high' })), null, []);
    expect(body).toMatchObject({ model: 'opus', effort: 'high' });
    expect(toStartBody(withFormModel(form({ name: 'x', worktrees: false }), NO_MODEL_SETTINGS), null, [])).toMatchObject({ model: null, effort: null });
    expect('model' in toStartBody(form({ name: 'x', worktrees: false }), null, [])).toBe(false);
  });

  it('schedules: the template carries the choice; its Edit (the prefill) starts on it; the schedule line follows the model line', () => {
    const scheduled = withFormModel(form({ name: 'nightly', task: 'Check.', solutions: ['mobile'] }), reported({ model: 'haiku', effort: null }));
    expect(toScheduleInput(scheduled, '0 2 * * *', undefined).template).toMatchObject({ model: 'haiku', effort: null });
    const lines = scheduleSummaryLines(scheduled, '/ws', cronPreview('0 2 * * *', new Date(2026, 8, 29, 10)), [], null, LIST).map((l) => l.text);
    const at = lines.indexOf('ultracode off');
    expect(lines.slice(at, at + 3)).toEqual(['ultracode off', 'model     Haiku 4.5', 'schedule  02:00 daily']);
    expect(formFromPrefill({ name: 'nightly', model: 'opus', effort: 'high' }).model).toEqual({ model: 'opus', effort: 'high' });
    expect(formFromPrefill({ name: 'nightly', model: 'default' }).model).toEqual({ model: null, effort: null });
    expect(formFromPrefill({ name: 'nightly' }).model).toBeNull();
    expect(formFromPrefill({ model: 5 as unknown as string }).model).toBeNull();
  });
});

describe('reading the stored settings (D42)', () => {
  it('readModelChoice / readModelOptions are defensive', () => {
    expect(readModelChoice({ model: 'default', effort: ' ' })).toEqual({ model: null, effort: null });
    expect(readModelChoice({ model: 'opus', effort: 'high', other: 1 })).toEqual({ model: 'opus', effort: 'high' });
    expect(readModelChoice({ model: 1, effort: null })).toBeNull();
    expect(readModelChoice(null)).toBeNull();
    expect(readModelOptions([{ value: 'opus', label: 'Opus 5.5', efforts: ['high', 'high', 3] }, { label: 'no value' }, { value: 'opus' }, { value: 'haiku' }])).toEqual([
      { value: 'opus', label: 'Opus 5.5', efforts: ['high'] },
      { value: 'haiku', label: 'haiku' },
    ]);
    expect(readModelOptions([])).toBeNull();
    expect(readModelOptions('x')).toBeNull();
  });
});
