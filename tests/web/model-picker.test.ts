import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Session, SessionEvent, SessionModel, SessionModelOption } from '../../src/core/api.ts';
import { chatItems, stepMark } from '../../src/web/views/session/chat.ts';
import {
  MODELS_UNKNOWN_REASON,
  MODEL_APPLIES_LATER,
  MODEL_APPLIES_LIVE,
  effortPickBody,
  modelPickBody,
  modelPicker,
  shortModelLabel,
} from '../../src/web/views/session/session-header.ts';
import { eventLines } from '../../src/web/views/session/terminal-tail.ts';

/**
 * D31 in the UI (pure parts; the real path is tests/e2e/model-effort.spec.ts): the
 * header picker's view model (the trigger text, disabled while the models are
 * unknown, the model rows, the effort pills of the chosen model only, hidden when
 * it has none), the request bodies a pick sends, the popover's markup, and the
 * `model` step lines in the chat and the terminal tail.
 */

const LIST: SessionModelOption[] = [
  { value: 'default', label: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', label: 'Opus 5.5', description: 'Most capable for ambitious work', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: ['low', 'medium', 'high', 'max'] },
  { value: 'haiku', label: 'Haiku 4.5', description: 'Fastest for quick answers' },
];

function session(model: SessionModel | null | undefined, live = true): Pick<Session, 'model' | 'live'> {
  return model === undefined ? { live } : { model, live };
}

async function component(file: string, name: string): Promise<(props: object) => unknown> {
  const module = (await import(/* @vite-ignore */ file)) as Record<string, (props: object) => unknown>;
  return module[name] as (props: object) => unknown;
}

describe('the model and effort picker (D31)', () => {
  it('no picker without model information (the demo sessions: model null / absent)', () => {
    expect(modelPicker(session(null))).toBeNull();
    expect(modelPicker(session(undefined))).toBeNull();
  });

  it('the trigger: the short model label, plus the effort when one is chosen', () => {
    expect(modelPicker(session({ current: 'opus', effort: 'high', available: LIST }))?.label).toBe('Opus 5.5 · high');
    expect(modelPicker(session({ current: null, effort: null, available: LIST }))?.label).toBe('Default');
    expect(modelPicker(session({ current: null, effort: 'max', available: LIST }))?.label).toBe('Default · max');
    expect(modelPicker(session({ current: 'haiku', effort: null, available: LIST }))?.label).toBe('Haiku 4.5');
    expect(shortModelLabel('Default (recommended)')).toBe('Default');
    expect(shortModelLabel('Opus 5.5')).toBe('Opus 5.5');
  });

  it('unknown models: disabled with the reason as the tooltip, showing the stored choice', () => {
    const picker = modelPicker(session({ current: 'claude-opus-4-7', effort: 'high', available: null }, false));
    expect(picker).toMatchObject({ label: 'claude-opus-4-7 · high', disabled: true, reason: MODELS_UNKNOWN_REASON, title: MODELS_UNKNOWN_REASON, models: [], efforts: null });
    expect(modelPicker(session({ current: null, effort: null, available: null }))?.label).toBe('Default');
  });

  it('the models in the CLI order, the chosen one selected; a stored model the list lacks is shown too', () => {
    const picker = modelPicker(session({ current: 'opus', effort: null, available: LIST }));
    expect(picker?.disabled).toBe(false);
    expect(picker?.title).toBe(`Model and effort. ${MODEL_APPLIES_LIVE}`);
    expect(picker?.models.map((m) => [m.value, m.label, m.selected])).toEqual([
      ['default', 'Default (recommended)', false],
      ['opus', 'Opus 5.5', true],
      ['claude-sonnet-4-6', 'Sonnet 4.6', false],
      ['haiku', 'Haiku 4.5', false],
    ]);
    expect(picker?.models[1]?.description).toBe('Most capable for ambitious work');
    expect(picker?.models[2]?.description).toBeNull();
    expect(modelPicker(session({ current: null, effort: null, available: LIST }))?.models[0]?.selected).toBe(true);
    const odd = modelPicker(session({ current: 'claude-opus-4-5', effort: null, available: LIST }));
    expect(odd?.models.at(-1)).toEqual({ value: 'claude-opus-4-5', label: 'claude-opus-4-5', description: null, selected: true });
    expect(odd?.efforts?.map((e) => e.value)).toEqual([null, 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(modelPicker(session({ current: 'opus', effort: null, available: LIST }, false))?.note).toBe(MODEL_APPLIES_LATER);
  });

  it('the effort pills are only the chosen model’s levels after Default; none for a model without levels', () => {
    const sonnet = modelPicker(session({ current: 'claude-sonnet-4-6', effort: 'medium', available: LIST }));
    expect(sonnet?.efforts).toEqual([
      { value: null, label: 'Default', selected: false },
      { value: 'low', label: 'low', selected: false },
      { value: 'medium', label: 'medium', selected: true },
      { value: 'high', label: 'high', selected: false },
      { value: 'max', label: 'max', selected: false },
    ]);
    expect(modelPicker(session({ current: 'opus', effort: null, available: LIST }))?.efforts?.[0]).toEqual({ value: null, label: 'Default', selected: true });
    expect(modelPicker(session({ current: 'haiku', effort: null, available: LIST }))?.efforts).toBeNull();
  });

  it('a model pick keeps the effort when the new model has it, else goes back to Default; the same model sends nothing', () => {
    const model: SessionModel = { current: 'opus', effort: 'xhigh', available: LIST };
    expect(modelPickBody(model, 'default')).toEqual({ model: 'default', effort: 'xhigh' });
    expect(modelPickBody(model, 'claude-sonnet-4-6')).toEqual({ model: 'claude-sonnet-4-6', effort: null });
    expect(modelPickBody(model, 'haiku')).toEqual({ model: 'haiku', effort: null });
    expect(modelPickBody(model, 'opus')).toBeNull();
    expect(modelPickBody({ current: null, effort: 'high', available: LIST }, 'default')).toBeNull();
    expect(effortPickBody(model, 'low')).toEqual({ effort: 'low' });
    expect(effortPickBody(model, null)).toEqual({ effort: null });
    expect(effortPickBody(model, 'xhigh')).toBeNull();
  });

  it('the picker markup: a header action with the caret, disabled with the reason; the demo gets nothing', async () => {
    const ModelPicker = await component('../../src/web/views/session/ModelPicker.tsx', 'ModelPicker');
    const html = renderToStaticMarkup(
      createElement(ModelPicker as never, { sessionId: 's', session: { ...session({ current: 'opus', effort: 'high', available: LIST }) }, onChanged: () => undefined }),
    );
    expect(html).toContain('data-testid="session-model"');
    expect(html).toContain('class="sb-button sb-sv-action sb-sv-model-button"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('Opus 5.5 · high<span class="sb-sv-model-caret" aria-hidden="true">▾</span>');
    const disabled = renderToStaticMarkup(createElement(ModelPicker as never, { sessionId: 's', session: session({ current: null, effort: null, available: null }), onChanged: () => undefined }));
    expect(disabled).toContain('disabled=""');
    expect(disabled).toContain(`data-reason="${MODELS_UNKNOWN_REASON.replace(/'/g, '&#x27;')}"`);
    expect(renderToStaticMarkup(createElement(ModelPicker as never, { sessionId: 's', session: session(null), onChanged: () => undefined }))).toBe('');
  });
});

let clock = 0;
function event(id: number, payload: unknown, extra: Partial<SessionEvent> = {}): SessionEvent {
  clock += 1;
  return { id, sessionId: 's', agentId: 'main', ts: `2026-09-28T10:00:${String(clock).padStart(2, '0')}.000Z`, endTs: null, kind: 'text', label: '', payload, ...extra };
}

describe('model step lines (D31)', () => {
  it('a change is ✓, a refusal ✕, in the chat and the terminal tail', () => {
    const changed = event(1, { type: 'model', action: 'changed', model: 'opus', effort: 'high', live: true }, { label: 'Model: Opus 5.5 · effort: high' });
    const failed = event(2, { type: 'model', action: 'failed', model: 'opus', effort: 'high', request: 'set_model', error: 'blocked' }, { kind: 'error', label: 'Could not change the model: blocked' });
    expect(stepMark(changed)).toBe('✓');
    expect(stepMark(failed)).toBe('✕');
    const items = chatItems([changed, failed], [], 'main');
    expect(items).toEqual([
      {
        kind: 'agent',
        key: 'a:1',
        id: 1,
        text: '',
        cut: null,
        steps: [
          { id: 1, mark: '✓', label: 'Model: Opus 5.5 · effort: high' },
          { id: 2, mark: '✕', label: 'Could not change the model: blocked' },
        ],
      },
    ]);
    expect(eventLines(changed)).toEqual(['✓ Model: Opus 5.5 · effort: high']);
    expect(eventLines(failed)).toEqual(['✕ Could not change the model: blocked']);
  });
});
