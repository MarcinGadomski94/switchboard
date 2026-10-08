import { describe, expect, it } from 'vitest';
import {
  type LaunchSettings,
  type ModelRule,
  applyModelRouting,
  checkRuleTargets,
  parseModelRules,
  readModelRules,
  routingExplanation,
  routingModelOptions,
  ruleMatches,
} from '../../src/core/model-routing.ts';
import { CLI_MODEL_ALIASES } from '../../src/core/model-choice.ts';

const DEFAULTS: LaunchSettings = { provider: 'claude', model: 'opus', effort: 'xhigh', profileId: 'work' };

const low30: ModelRule = { id: 'a', priority: 'low', estimate: { kind: 'at-most', minutes: 30 }, provider: 'claude', model: 'sonnet' };
const urgent: ModelRule = { id: 'b', priority: 'urgent', estimate: { kind: 'any' }, provider: 'claude', model: 'opus', effort: 'max' };
const long: ModelRule = { id: 'c', priority: 'any', estimate: { kind: 'more-than', minutes: 120 }, provider: 'codex', model: 'gpt-5', profileId: 'codex-team' };
const unknown: ModelRule = { id: 'd', priority: 'any', estimate: { kind: 'unknown' }, provider: 'claude', effort: 'high' };

describe('D82 · ruleMatches', () => {
  it('matches the priority (or any) and the estimate (≤ N, > N, unknown, any)', () => {
    expect(ruleMatches(low30, { priority: 'low', estimateMinutes: 30 })).toBe(true);
    expect(ruleMatches(low30, { priority: 'low', estimateMinutes: 31 })).toBe(false);
    expect(ruleMatches(low30, { priority: 'medium', estimateMinutes: 10 })).toBe(false);
    // An estimate rule never matches an item without one.
    expect(ruleMatches(low30, { priority: 'low', estimateMinutes: null })).toBe(false);
    expect(ruleMatches(long, { priority: 'high', estimateMinutes: 121 })).toBe(true);
    expect(ruleMatches(long, { priority: 'high', estimateMinutes: 120 })).toBe(false);
    expect(ruleMatches(unknown, { priority: 'medium', estimateMinutes: null })).toBe(true);
    expect(ruleMatches(unknown, { priority: 'medium', estimateMinutes: 5 })).toBe(false);
    expect(ruleMatches(urgent, { priority: 'urgent', estimateMinutes: 9999 })).toBe(true);
  });
});

describe('D82 · applyModelRouting', () => {
  it('no rules, or no match: the defaults unchanged (the same object), no rule', () => {
    expect(applyModelRouting(DEFAULTS, { priority: 'low', estimateMinutes: 10 }, [])).toEqual({ settings: DEFAULTS, rule: null });
    const none = applyModelRouting(DEFAULTS, { priority: 'medium', estimateMinutes: 60 }, [low30, urgent]);
    expect(none.rule).toBeNull();
    expect(none.settings).toBe(DEFAULTS);
  });

  it('the first match wins, in order', () => {
    const item = { priority: 'low' as const, estimateMinutes: 15 };
    expect(applyModelRouting(DEFAULTS, item, [low30, unknown]).rule).toBe(low30);
    const anyLow: ModelRule = { id: 'z', priority: 'low', estimate: { kind: 'any' }, provider: 'claude', model: 'haiku' };
    expect(applyModelRouting(DEFAULTS, item, [anyLow, low30]).rule).toBe(anyLow);
  });

  it('a new model drops the default effort; the account and other fields are kept', () => {
    const routed = applyModelRouting({ ...DEFAULTS, extra: 42 }, { priority: 'low', estimateMinutes: 15 }, [low30]);
    expect(routed.settings).toEqual({ provider: 'claude', model: 'sonnet', effort: null, profileId: 'work', extra: 42 });
  });

  it('the same model keeps the effort; a rule effort replaces it', () => {
    const same: ModelRule = { id: 's', priority: 'any', estimate: { kind: 'any' }, provider: 'claude', model: 'opus' };
    expect(applyModelRouting(DEFAULTS, { priority: 'high', estimateMinutes: null }, [same]).settings.effort).toBe('xhigh');
    expect(applyModelRouting(DEFAULTS, { priority: 'urgent', estimateMinutes: null }, [urgent]).settings).toEqual({ ...DEFAULTS, model: 'opus', effort: 'max' });
    expect(applyModelRouting(DEFAULTS, { priority: 'medium', estimateMinutes: null }, [unknown]).settings).toEqual({ ...DEFAULTS, effort: 'high' });
  });

  it('another CLI starts from its own defaults (no model, effort or account of the first CLI)', () => {
    const cliOnly: ModelRule = { id: 'o', priority: 'any', estimate: { kind: 'any' }, provider: 'opencode' };
    expect(applyModelRouting(DEFAULTS, { priority: 'low', estimateMinutes: 1 }, [cliOnly]).settings).toEqual({ provider: 'opencode', model: null, effort: null, profileId: null });
    expect(applyModelRouting(DEFAULTS, { priority: 'low', estimateMinutes: 500 }, [long]).settings).toEqual({ provider: 'codex', model: 'gpt-5', effort: null, profileId: 'codex-team' });
  });

  it('a rule naming `default` sets the CLI default model (null)', () => {
    const def: ModelRule = { id: 'd', priority: 'any', estimate: { kind: 'any' }, provider: 'claude', model: 'default' };
    expect(applyModelRouting(DEFAULTS, { priority: 'low', estimateMinutes: 1 }, [def]).settings.model).toBeNull();
  });
});

describe('D82 · routingExplanation', () => {
  it('names the match and the targets ("Routed by rule: low ≤30 min → Sonnet")', () => {
    expect(routingExplanation(low30, { models: CLI_MODEL_ALIASES })).toBe('Routed by rule: low ≤30 min → Sonnet');
    expect(routingExplanation(low30)).toBe('Routed by rule: low ≤30 min → sonnet');
    expect(routingExplanation(urgent, { models: CLI_MODEL_ALIASES })).toBe('Routed by rule: urgent → Opus · effort max');
    expect(routingExplanation(long, { profileName: (id) => (id === 'codex-team' ? 'Team' : null) })).toBe('Routed by rule: any priority >120 min → Codex CLI · gpt-5 · Team');
    expect(routingExplanation(unknown)).toBe('Routed by rule: any priority no estimate → Claude Code · effort high');
    expect(routingExplanation({ id: 'q', priority: 'any', estimate: { kind: 'any' }, provider: 'codex' })).toBe('Routed by rule: any task → Codex CLI');
  });
});

describe('D82 · parseModelRules / readModelRules', () => {
  it('keeps a valid list in order (trimmed values, nulls left out)', () => {
    const parsed = parseModelRules([
      { id: 'a', priority: 'low', estimate: { kind: 'at-most', minutes: 30 }, provider: 'claude', model: ' sonnet ', effort: null },
      { id: 'b', priority: 'any', estimate: { kind: 'unknown' }, provider: 'codex' },
    ]);
    expect(parsed).toEqual({
      ok: true,
      rules: [
        { id: 'a', priority: 'low', estimate: { kind: 'at-most', minutes: 30 }, provider: 'claude', model: 'sonnet' },
        { id: 'b', priority: 'any', estimate: { kind: 'unknown' }, provider: 'codex' },
      ],
    });
  });

  it('refuses bad shapes with the rule and field named', () => {
    const fields = (value: unknown): string[] => {
      const parsed = parseModelRules(value);
      return parsed.ok ? [] : parsed.errors.map((error) => error.field);
    };
    expect(fields('x')).toEqual(['sessions.modelRules']);
    expect(fields([{ id: 'a', priority: 'soon', estimate: { kind: 'any' }, provider: 'claude' }])).toEqual(['sessions.modelRules[0].priority']);
    expect(fields([{ id: 'a', priority: 'low', estimate: { kind: 'more-than', minutes: 1.5 }, provider: 'claude' }])).toEqual(['sessions.modelRules[0].estimate']);
    expect(fields([{ id: 'a', priority: 'low', estimate: { kind: 'any' }, provider: 'gemini' }])).toEqual(['sessions.modelRules[0].provider']);
    expect(fields([{ id: 'a', priority: 'low', estimate: { kind: 'any' }, profileId: 'p' }])).toEqual(['sessions.modelRules[0].profileId']);
    expect(
      fields([
        { id: 'a', priority: 'low', estimate: { kind: 'any' }, provider: 'claude' },
        { id: 'a', priority: 'low', estimate: { kind: 'any' }, provider: 'claude' },
      ]),
    ).toEqual(['sessions.modelRules[1].id']);
    expect(fields(Array.from({ length: 51 }, (_, i) => ({ id: `r${i}`, priority: 'any', estimate: { kind: 'any' }, provider: 'claude' })))).toEqual(['sessions.modelRules']);
  });

  it('a stored oddity reads as no rules (routing off)', () => {
    expect(readModelRules(undefined)).toEqual([]);
    expect(readModelRules([{ nope: true }])).toEqual([]);
  });
});

describe('D82 · checkRuleTargets', () => {
  const lookup = {
    models: async (provider: string) => (provider === 'claude' ? [{ value: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] }, { value: 'haiku', label: 'Haiku' }] : null),
    profile: async (id: string) => (id === 'p1' ? { cli: 'claude' as const, name: 'Work', enabled: true } : null),
  };

  it('accepts listed models, their efforts and an enabled profile of the CLI', async () => {
    expect(await checkRuleTargets([{ id: 'a', priority: 'any', estimate: { kind: 'any' }, provider: 'claude', model: 'sonnet', effort: 'high', profileId: 'p1' }], lookup)).toEqual([]);
    // Without a model the effort is one of any listed model's levels.
    expect(await checkRuleTargets([{ id: 'a', priority: 'any', estimate: { kind: 'any' }, provider: 'claude', effort: 'low' }], lookup)).toEqual([]);
  });

  it('a CLI without a reported list offers the fallback; any CLI effort level is taken while levels are unknown', async () => {
    expect(routingModelOptions('codex', null).map((o) => o.value)).toEqual(['default']);
    expect(routingModelOptions('claude', null)).toBe(CLI_MODEL_ALIASES);
    expect(await checkRuleTargets([{ id: 'a', priority: 'any', estimate: { kind: 'any' }, provider: 'codex', model: 'default', effort: 'max' }], lookup)).toEqual([]);
    const refused = await checkRuleTargets([{ id: 'a', priority: 'any', estimate: { kind: 'any' }, provider: 'codex', effort: 'turbo' }], lookup);
    expect(refused.map((p) => p.field)).toEqual(['sessions.modelRules[0].effort']);
  });
});
