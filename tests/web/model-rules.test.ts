import { describe, expect, it } from 'vitest';
import type { AccountProfile } from '../../src/core/accounts.ts';
import type { ModelRule } from '../../src/core/model-routing.ts';
import { estimateFor, moveRule, newRule, ruleEfforts, ruleErrors, ruleModelOptions, rulePreview, ruleProfiles, rulesDirty, withModel, withProvider, withTarget } from '../../src/web/views/settings/model-rules.ts';

const profile = (id: string, cli: AccountProfile['cli'], enabled: boolean, position: number): AccountProfile =>
  ({ id, cli, name: id.toUpperCase(), dir: null, builtin: false, enabled, position, shareSettings: false, signIn: 'signed-in', account: null, usage: null, exhausted: null, signInCommand: '', sessions: 0 }) as AccountProfile;

describe('D82 · the Model by task editor', () => {
  it('a new rule is low ≤30 min on Claude Code; moving keeps the list at its ends', () => {
    const a = newRule('a');
    expect(a).toEqual({ id: 'a', priority: 'low', estimate: { kind: 'at-most', minutes: 30 }, provider: 'claude' });
    const b = newRule('b');
    expect(moveRule([a, b], 'b', -1).map((r) => r.id)).toEqual(['b', 'a']);
    expect(moveRule([a, b], 'a', -1).map((r) => r.id)).toEqual(['a', 'b']);
    expect(moveRule([a, b], 'b', 1).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('the estimate keeps its minutes between ≤ and >', () => {
    expect(estimateFor('more-than', { kind: 'at-most', minutes: 45 })).toEqual({ kind: 'more-than', minutes: 45 });
    expect(estimateFor('at-most', { kind: 'any' })).toEqual({ kind: 'at-most', minutes: 30 });
    expect(estimateFor('unknown', { kind: 'at-most', minutes: 45 })).toEqual({ kind: 'unknown' });
  });

  it('a new CLI clears model, effort and account; a new model clears the effort; keep drops a target', () => {
    const rule: ModelRule = { id: 'a', priority: 'low', estimate: { kind: 'any' }, provider: 'claude', model: 'sonnet', effort: 'low', profileId: 'p' };
    expect(withProvider(rule, 'codex')).toEqual({ id: 'a', priority: 'low', estimate: { kind: 'any' }, provider: 'codex' });
    expect(withProvider(rule, '')).toEqual({ id: 'a', priority: 'low', estimate: { kind: 'any' } });
    expect(withProvider(rule, 'claude')).toBe(rule);
    expect(withModel(rule, 'opus')).toEqual({ id: 'a', priority: 'low', estimate: { kind: 'any' }, provider: 'claude', model: 'opus', profileId: 'p' });
    expect(withTarget(rule, 'profileId', '')).toEqual({ id: 'a', priority: 'low', estimate: { kind: 'any' }, provider: 'claude', model: 'sonnet', effort: 'low' });
  });

  it('offers the CLI’s models (else the fallback), the model’s efforts and the CLI’s enabled accounts', () => {
    const models = { options: [{ value: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] }], last: null };
    expect(ruleModelOptions('claude', models).map((o) => o.value)).toEqual(['sonnet']);
    expect(ruleModelOptions('claude', null).map((o) => o.value)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
    expect(ruleEfforts({ id: 'a', priority: 'any', estimate: { kind: 'any' }, provider: 'claude', model: 'sonnet' }, models)).toEqual(['low', 'high']);
    expect(ruleEfforts({ id: 'a', priority: 'any', estimate: { kind: 'any' } }, models)).toEqual([]);
    const profiles = [profile('b', 'claude', true, 1), profile('a', 'claude', true, 0), profile('c', 'claude', false, 2), profile('d', 'codex', true, 0)];
    expect(ruleProfiles('claude', profiles).map((p) => p.id)).toEqual(['a', 'b']);
    expect(ruleProfiles(undefined, profiles)).toEqual([]);
  });

  it('previews the line a routed run shows; tracks dirty; maps 422 errors to rules', () => {
    const rule: ModelRule = { id: 'a', priority: 'low', estimate: { kind: 'at-most', minutes: 30 }, provider: 'claude', model: 'sonnet' };
    expect(rulePreview(rule, {}, [])).toBe('Routed by rule: low ≤30 min → Sonnet');
    expect(rulesDirty([rule], [rule])).toBe(false);
    expect(rulesDirty([rule], [])).toBe(true);
    const errors = ruleErrors({ errors: [{ field: 'sessions.modelRules[1].model', message: 'no' }, { field: 'sessions.modelRules', message: 'too many' }] });
    expect(errors.get(1)).toEqual(['no']);
    expect(errors.get(-1)).toEqual(['too many']);
  });
});
