import type { AccountProfile } from '../../../core/accounts.ts';
import type { ModelSettings, SessionModelOption } from '../../../core/api.ts';
import { CLI_LABELS, CLI_PROVIDERS, type CliProviderId } from '../../../core/cli-providers.ts';
import { readModelOptions } from '../../../core/model-choice.ts';
import { type EstimateMatch, type ModelRule, type RoutingPriority, ruleEffortLevels, routingExplanation, routingModelOptions } from '../../../core/model-routing.ts';

/**
 * D82 · the *Model by task* editor (Settings → Sessions, `docs/model-routing.md`):
 * the draft's rules and the edits on them. Pure, for the unit tests.
 */

/** The row's label and description. */
export const MODEL_RULES_LABEL = 'Model by task';
export const MODEL_RULES_DESCRIPTION =
  'Run a todo on another CLI, model, effort or account by its priority and estimate. The first matching rule wins; no match keeps the normal choice. Off until you add a rule.';

/** The editor's empty state. */
export const MODEL_RULES_EMPTY = 'No rules: todos run with the normal choice.';

/** "Keep" in a target select (the rule leaves that part alone). */
export const KEEP = '';

/** The priority select's options. */
export const PRIORITY_LABELS: Readonly<Record<RoutingPriority, string>> = { any: 'any priority', urgent: 'urgent', high: 'high', medium: 'medium', low: 'low' };

/** The estimate select's options. */
export const ESTIMATE_LABELS: Readonly<Record<EstimateMatch['kind'], string>> = { any: 'any estimate', 'at-most': '≤', 'more-than': '>', unknown: 'no estimate' };

/** The minutes a new ≤ / > estimate starts with. */
export const DEFAULT_RULE_MINUTES = 30;

/** A new rule: low priority, ≤ 30 min, Claude Code (the developer picks the rest). */
export function newRule(id: string): ModelRule {
  return { id, priority: 'low', estimate: { kind: 'at-most', minutes: DEFAULT_RULE_MINUTES }, provider: 'claude' };
}

/** The list with `rule` moved by `delta` places (unchanged at an end). */
export function moveRule(rules: readonly ModelRule[], id: string, delta: -1 | 1): ModelRule[] {
  const index = rules.findIndex((rule) => rule.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= rules.length) return [...rules];
  const next = [...rules];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved as ModelRule);
  return next;
}

/** The estimate for a kind picked in the select (minutes kept when it stays ≤ / >). */
export function estimateFor(kind: EstimateMatch['kind'], current: EstimateMatch): EstimateMatch {
  if (kind === 'any' || kind === 'unknown') return { kind };
  const minutes = current.kind === 'at-most' || current.kind === 'more-than' ? current.minutes : DEFAULT_RULE_MINUTES;
  return { kind, minutes };
}

/** A rule without one target (`undefined` drops it). */
function without<K extends 'provider' | 'model' | 'effort' | 'profileId'>(rule: ModelRule, key: K): ModelRule {
  const { [key]: _dropped, ...rest } = rule;
  return rest as ModelRule;
}

/** The rule with its CLI set (`KEEP` = none): a new CLI clears the model, effort and account (each CLI has its own). */
export function withProvider(rule: ModelRule, value: string): ModelRule {
  const provider = (CLI_PROVIDERS as readonly string[]).includes(value) ? (value as CliProviderId) : undefined;
  if (provider === rule.provider) return rule;
  const cleared = without(without(without(without(rule, 'provider'), 'model'), 'effort'), 'profileId');
  return provider ? { ...cleared, provider } : cleared;
}

/** The rule with its model set (`KEEP` = none): a new model clears an effort it may not have. */
export function withModel(rule: ModelRule, value: string): ModelRule {
  const model = value === KEEP ? undefined : value;
  if (model === rule.model) return rule;
  const cleared = without(without(rule, 'model'), 'effort');
  return model ? { ...cleared, model } : cleared;
}

/** The rule with one of effort / profile set (`KEEP` = none). */
export function withTarget(rule: ModelRule, key: 'effort' | 'profileId', value: string): ModelRule {
  const cleared = without(rule, key);
  return value === KEEP ? cleared : { ...cleared, [key]: value };
}

/** The models offered for a rule's CLI: its reported list, else the fallback. */
export function ruleModelOptions(provider: CliProviderId, models: ModelSettings | null | undefined): readonly SessionModelOption[] {
  return routingModelOptions(provider, readModelOptions(models?.options ?? null));
}

/** The efforts offered for a rule (its CLI, its model if any). */
export function ruleEfforts(rule: ModelRule, models: ModelSettings | null | undefined): readonly string[] {
  if (!rule.provider) return [];
  return ruleEffortLevels(rule.provider, readModelOptions(models?.options ?? null), rule.model);
}

/** The accounts offered for a rule's CLI: its enabled profiles, in their order. */
export function ruleProfiles(provider: CliProviderId | undefined, profiles: readonly AccountProfile[]): AccountProfile[] {
  if (!provider) return [];
  return profiles.filter((profile) => profile.cli === provider && profile.enabled).sort((a, b) => a.position - b.position);
}

/** The preview under a rule ("Routed by rule: low ≤30 min → Sonnet"). */
export function rulePreview(rule: ModelRule, models: Partial<Record<CliProviderId, ModelSettings | null>>, profiles: readonly AccountProfile[]): string {
  const list = rule.provider ? ruleModelOptions(rule.provider, models[rule.provider]) : null;
  return routingExplanation(rule, { models: list, profileName: (id) => profiles.find((profile) => profile.id === id)?.name ?? null });
}

/** The CLI select's options: keep, then every CLI. */
export function cliOptions(): Array<{ readonly value: string; readonly label: string }> {
  return [{ value: KEEP, label: 'keep CLI' }, ...CLI_PROVIDERS.map((id) => ({ value: id, label: CLI_LABELS[id] }))];
}

/** `true` when the draft differs from what is stored. */
export function rulesDirty(stored: readonly ModelRule[], draft: readonly ModelRule[]): boolean {
  return JSON.stringify(stored) !== JSON.stringify(draft);
}

/**
 * A 422's errors as the editor shows them: by rule index (`sessions.modelRules[2].model` → rule 2),
 * and the ones about the whole list (`-1`).
 */
export function ruleErrors(body: unknown): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const errors = typeof body === 'object' && body !== null && Array.isArray((body as { errors?: unknown }).errors) ? ((body as { errors: unknown[] }).errors) : [];
  for (const error of errors) {
    if (typeof error !== 'object' || error === null) continue;
    const { field, message } = error as { field?: unknown; message?: unknown };
    if (typeof message !== 'string') continue;
    const match = typeof field === 'string' ? /^sessions\.modelRules\[(\d+)\]/.exec(field) : null;
    const index = match ? Number(match[1]) : -1;
    out.set(index, [...(out.get(index) ?? []), message]);
  }
  return out;
}
