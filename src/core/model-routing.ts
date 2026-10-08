/**
 * D82 · Model by task (`docs/model-routing.md`): an ordered list of rules in
 * Settings → Sessions that picks the CLI, model, effort and account profile a
 * task-like item (a todo) is run with, from its priority and estimate. Pure,
 * shared by the server (storage, validation, the todo run options) and the UI
 * (the rules editor, the "Routed by rule" line). No I/O.
 *
 * The first rule that matches wins; no match (or no rules: the feature is off
 * until the developer adds one) leaves the normal choice untouched.
 */
import type { SessionModelOption, TodoPriority } from './api.ts';
import { CLI_LABELS, CLI_PROVIDERS, type CliProviderId, isCliProviderId } from './cli-providers.ts';
import { CLI_EFFORT_LEVELS, CLI_MODEL_ALIASES, DEFAULT_MODEL_VALUE, MODEL_VALUE_MAX, modelLabel, normalizeEffort, normalizeModel } from './model-choice.ts';
import { TODO_ESTIMATE_MAX, TODO_PRIORITIES } from './todos.ts';

/** What a rule matches on: one priority, or `any`. */
export type RoutingPriority = 'any' | TodoPriority;

/** The priorities a rule can match, `any` first. */
export const ROUTING_PRIORITIES: readonly RoutingPriority[] = ['any', ...TODO_PRIORITIES];

/**
 * What a rule matches in the estimate: `any`; `at-most` N minutes (≤ N); `more-than`
 * N minutes (> N); `unknown` (the item has no estimate). An estimate rule never
 * matches an item without an estimate, and `unknown` never one with an estimate.
 */
export type EstimateMatch =
  | { readonly kind: 'any' }
  | { readonly kind: 'at-most'; readonly minutes: number }
  | { readonly kind: 'more-than'; readonly minutes: number }
  | { readonly kind: 'unknown' };

/** The estimate kinds, in the editor's order. */
export const ESTIMATE_MATCH_KINDS: readonly EstimateMatch['kind'][] = ['any', 'at-most', 'more-than', 'unknown'];

/**
 * One rule (`sessions.modelRules`). Each target is optional: absent = keep the
 * normal choice. A model, an effort or a profile is always given with its CLI
 * (`provider`), since each CLI has its own models and accounts (validation).
 */
export interface ModelRule {
  /** Stable id (the editor's key). */
  readonly id: string;
  readonly priority: RoutingPriority;
  readonly estimate: EstimateMatch;
  /** The CLI to run on. */
  readonly provider?: CliProviderId;
  /** A model value of that CLI (`default` is stored as absent). */
  readonly model?: string;
  /** An effort level of that model. */
  readonly effort?: string;
  /** An account profile id of that CLI (enabled when saved). */
  readonly profileId?: string;
}

/**
 * The settings a session is launched with (the part a rule changes). Lane A's
 * `todoRunOptions` returns a superset of this; {@link applyModelRouting} keeps
 * every other field. `null` = the CLI's default model / effort, the rule of
 * Settings → Accounts for the profile.
 */
export interface LaunchSettings {
  readonly provider: CliProviderId;
  readonly model: string | null;
  readonly effort: string | null;
  readonly profileId: string | null;
}

/** What a rule is matched against: a todo's priority and estimate (minutes, `null` = none). */
export interface RoutableItem {
  readonly priority: TodoPriority;
  readonly estimateMinutes: number | null;
}

/** Most rules the list may hold. */
export const MODEL_RULES_MAX = 50;

/** Longest rule id. */
export const MODEL_RULE_ID_MAX = 64;

/** `true` when `rule` matches `item`. */
export function ruleMatches(rule: ModelRule, item: RoutableItem): boolean {
  if (rule.priority !== 'any' && rule.priority !== item.priority) return false;
  const estimate = item.estimateMinutes;
  switch (rule.estimate.kind) {
    case 'any':
      return true;
    case 'unknown':
      return estimate === null;
    case 'at-most':
      return estimate !== null && estimate <= rule.estimate.minutes;
    case 'more-than':
      return estimate !== null && estimate > rule.estimate.minutes;
  }
}

/**
 * D82: the launch settings for `item`: the first rule (in order) that matches
 * changes the fields it sets; no match = `defaults` unchanged (the same object).
 *
 * A rule that moves to another CLI starts from that CLI's defaults (model, effort
 * and profile `null`), since the defaults' values belong to the first CLI; a rule
 * that changes the model without an effort drops the effort to the CLI's default
 * (the default effort may not exist for the new model). Every field of `defaults`
 * a rule does not know about is kept.
 */
export function applyModelRouting<T extends LaunchSettings>(defaults: T, item: RoutableItem, rules: readonly ModelRule[]): { readonly settings: T; readonly rule: ModelRule | null } {
  const rule = rules.find((candidate) => ruleMatches(candidate, item)) ?? null;
  if (!rule) return { settings: defaults, rule: null };
  let next: T = defaults;
  if (rule.provider !== undefined && rule.provider !== defaults.provider) {
    next = { ...next, provider: rule.provider, model: null, effort: null, profileId: null };
  }
  if (rule.model !== undefined) {
    const model = normalizeModel(rule.model);
    next = { ...next, model, effort: model === next.model ? next.effort : null };
  }
  if (rule.effort !== undefined) next = { ...next, effort: normalizeEffort(rule.effort) };
  if (rule.profileId !== undefined) next = { ...next, profileId: rule.profileId };
  return { settings: next, rule };
}

/** The match part of the explanation: `low ≤30 min`, `any priority`, `high · no estimate`. */
export function ruleMatchText(rule: Pick<ModelRule, 'priority' | 'estimate'>): string {
  const priority = rule.priority === 'any' ? null : rule.priority;
  let estimate: string | null = null;
  switch (rule.estimate.kind) {
    case 'at-most':
      estimate = `≤${rule.estimate.minutes} min`;
      break;
    case 'more-than':
      estimate = `>${rule.estimate.minutes} min`;
      break;
    case 'unknown':
      estimate = 'no estimate';
      break;
    case 'any':
      break;
  }
  if (priority && estimate) return `${priority} ${estimate}`;
  return priority ?? (estimate ? `any priority ${estimate}` : 'any task');
}

/** How the explanation names a rule's targets (labels the caller knows: the model list, the profile names). */
export interface RuleLabels {
  /** The model list of the rule's CLI (for `Sonnet` instead of `sonnet`); absent = the value. */
  readonly models?: readonly SessionModelOption[] | null;
  /** A profile's name by id; absent / `null` = the id. */
  readonly profileName?: (profileId: string) => string | null;
}

/** The target part of the explanation: `Codex CLI · gpt-5 · high · Work account`; `normal choice` for a rule that sets nothing. */
export function ruleTargetText(rule: ModelRule, labels: RuleLabels = {}): string {
  const parts: string[] = [];
  if (rule.provider !== undefined) parts.push(CLI_LABELS[rule.provider]);
  if (rule.model !== undefined) {
    const model = normalizeModel(rule.model);
    parts.push(model === null ? 'default model' : modelLabel(labels.models ?? null, model));
  }
  if (rule.effort !== undefined) parts.push(`effort ${rule.effort}`);
  if (rule.profileId !== undefined) parts.push(labels.profileName?.(rule.profileId) ?? rule.profileId);
  // A model names its CLI well enough: `Sonnet` alone reads better than `Claude Code · Sonnet`.
  if (rule.provider === 'claude' && rule.model !== undefined && parts.length > 1) parts.shift();
  return parts.length > 0 ? parts.join(' · ') : 'normal choice';
}

/** D82: the line the UI shows for a routed run: `Routed by rule: low ≤30 min → Sonnet`. */
export function routingExplanation(rule: ModelRule, labels: RuleLabels = {}): string {
  return `Routed by rule: ${ruleMatchText(rule)} → ${ruleTargetText(rule, labels)}`;
}

/**
 * The models a rule may name for `provider`: the list its CLI reported last
 * (`models.options[.<cli>]`), else the fallback the New-session form offers
 * (Claude Code's aliases; another CLI only its default).
 */
export function routingModelOptions(provider: CliProviderId, reported: readonly SessionModelOption[] | null): readonly SessionModelOption[] {
  if (reported && reported.length > 0) return reported;
  return provider === 'claude' ? CLI_MODEL_ALIASES : [{ value: DEFAULT_MODEL_VALUE, label: 'Default', description: `${CLI_LABELS[provider]}'s default model` }];
}

/**
 * The effort levels a rule may set for `provider` (and `model`, when it sets one):
 * while the CLI's list is unknown, the CLI's effort levels; else the model's own
 * levels, or (no model in the rule) any listed model's.
 */
export function ruleEffortLevels(provider: CliProviderId, reported: readonly SessionModelOption[] | null, model: string | undefined): readonly string[] {
  if (!reported || reported.length === 0) return CLI_EFFORT_LEVELS;
  if (model !== undefined) return reported.find((option) => option.value === model)?.efforts ?? [];
  return [...new Set(routingModelOptions(provider, reported).flatMap((option) => option.efforts ?? []))];
}

/** A field of a refused rule list (`422`'s `errors`: `sessions.modelRules[2].model`). */
export interface RuleProblem {
  readonly field: string;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The field name of rule `index`'s `part`. */
export function ruleField(index: number, part?: string): string {
  return `sessions.modelRules[${index}]${part ? `.${part}` : ''}`;
}

function parseEstimate(value: unknown): EstimateMatch | string {
  if (!isRecord(value)) return 'estimate must be { kind: any | at-most | more-than | unknown, minutes? }';
  const kind = value['kind'];
  if (kind === 'any' || kind === 'unknown') return { kind };
  if (kind === 'at-most' || kind === 'more-than') {
    const minutes = value['minutes'];
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > TODO_ESTIMATE_MAX) return `minutes must be a whole number from 1 to ${TODO_ESTIMATE_MAX}`;
    return { kind, minutes };
  }
  return 'estimate kind must be any, at-most, more-than or unknown';
}

/**
 * The shape check of `sessions.modelRules` (`PUT /api/settings`): at most
 * {@link MODEL_RULES_MAX} rules, each with a unique id, a priority, an estimate
 * match, and at least one target; a model, effort or profile needs its CLI.
 * Whether the model exists and the profile is enabled is the server's second,
 * async check ({@link checkRuleTargets}).
 */
export function parseModelRules(value: unknown): { readonly ok: true; readonly rules: ModelRule[] } | { readonly ok: false; readonly errors: RuleProblem[] } {
  if (!Array.isArray(value)) return { ok: false, errors: [{ field: 'sessions.modelRules', message: 'sessions.modelRules must be a list of rules' }] };
  if (value.length > MODEL_RULES_MAX) return { ok: false, errors: [{ field: 'sessions.modelRules', message: `at most ${MODEL_RULES_MAX} rules` }] };
  const errors: RuleProblem[] = [];
  const rules: ModelRule[] = [];
  const ids = new Set<string>();
  value.forEach((raw, index) => {
    const fail = (part: string | undefined, message: string): void => {
      errors.push({ field: ruleField(index, part), message });
    };
    if (!isRecord(raw)) {
      fail(undefined, 'a rule must be an object');
      return;
    }
    const id = raw['id'];
    if (typeof id !== 'string' || id.trim() === '' || id.length > MODEL_RULE_ID_MAX) return fail('id', `id must be text of 1–${MODEL_RULE_ID_MAX} characters`);
    if (ids.has(id)) return fail('id', `the id ${id} is used twice`);
    ids.add(id);
    const priority = raw['priority'];
    if (typeof priority !== 'string' || !(ROUTING_PRIORITIES as readonly string[]).includes(priority)) return fail('priority', `priority must be one of ${ROUTING_PRIORITIES.join(', ')}`);
    const estimate = parseEstimate(raw['estimate']);
    if (typeof estimate === 'string') return fail('estimate', estimate);
    const rule: { -readonly [K in keyof ModelRule]: ModelRule[K] } = { id, priority: priority as RoutingPriority, estimate };
    const provider = raw['provider'];
    if (provider !== undefined && provider !== null) {
      if (!isCliProviderId(provider)) return fail('provider', `provider must be one of ${CLI_PROVIDERS.join(', ')}`);
      rule.provider = provider;
    }
    for (const part of ['model', 'effort', 'profileId'] as const) {
      const field = raw[part];
      if (field === undefined || field === null) continue;
      if (typeof field !== 'string' || field.trim() === '' || field.length > MODEL_VALUE_MAX) return fail(part, `${part} must be text of 1–${MODEL_VALUE_MAX} characters`);
      if (rule.provider === undefined) return fail(part, `a rule that sets the ${part === 'profileId' ? 'account' : part} also sets the CLI (each CLI has its own)`);
      rule[part] = field.trim();
    }
    if (rule.provider === undefined && rule.model === undefined && rule.effort === undefined && rule.profileId === undefined) {
      return fail(undefined, 'a rule sets at least one of CLI, model, effort or account');
    }
    rules.push(rule);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, rules };
}

/** A stored `sessions.modelRules` read defensively (anything unreadable is the empty list: routing off). */
export function readModelRules(value: unknown): ModelRule[] {
  const parsed = parseModelRules(value);
  return parsed.ok ? parsed.rules : [];
}

/** What {@link checkRuleTargets} reads: a CLI's reported model list, a profile. */
export interface RuleTargetLookup {
  /** The list `provider` reported last (`null` while none did: the fallback of {@link routingModelOptions} applies). */
  readonly models: (provider: CliProviderId) => Promise<readonly SessionModelOption[] | null>;
  /** A profile by id (`null`: none). */
  readonly profile: (id: string) => Promise<{ readonly cli: CliProviderId; readonly name: string; readonly enabled: boolean } | null>;
}

/**
 * D82 validation of each rule's targets: the model must be one its CLI offers
 * (the CLI's model list, else the New-session form's fallback); the effort one of
 * that model's levels while the CLI's list says which (a rule without a model:
 * one of any listed model's levels), else one of the CLI's effort levels; the
 * profile one of that CLI's enabled profiles.
 */
export async function checkRuleTargets(rules: readonly ModelRule[], lookup: RuleTargetLookup): Promise<RuleProblem[]> {
  const errors: RuleProblem[] = [];
  for (const [index, rule] of rules.entries()) {
    const provider = rule.provider;
    if (!provider) continue;
    if (rule.model !== undefined || rule.effort !== undefined) {
      const reported = await lookup.models(provider);
      const options = routingModelOptions(provider, reported);
      const option = rule.model === undefined ? null : (options.find((candidate) => candidate.value === rule.model) ?? null);
      if (rule.model !== undefined && !option) {
        errors.push({ field: ruleField(index, 'model'), message: `${CLI_LABELS[provider]} does not offer the model "${rule.model}": pick one of ${options.map((o) => o.value).join(', ')}` });
        continue;
      }
      if (rule.effort !== undefined) {
        const levels = ruleEffortLevels(provider, reported, rule.model);
        if (!levels.includes(rule.effort)) {
          errors.push({
            field: ruleField(index, 'effort'),
            message:
              levels.length === 0
                ? `${option?.label ?? CLI_LABELS[provider]} has no effort levels to choose`
                : `${option?.label ?? CLI_LABELS[provider]} supports the effort levels ${levels.join(', ')}: "${rule.effort}" is not one of them`,
          });
        }
      }
    }
    if (rule.profileId !== undefined) {
      const profile = await lookup.profile(rule.profileId);
      if (!profile) errors.push({ field: ruleField(index, 'profileId'), message: 'no such account profile' });
      else if (profile.cli !== provider) errors.push({ field: ruleField(index, 'profileId'), message: `the account ${profile.name} belongs to ${CLI_LABELS[profile.cli]}, not ${CLI_LABELS[provider]}` });
      else if (!profile.enabled) errors.push({ field: ruleField(index, 'profileId'), message: `the account ${profile.name} is disabled for ${CLI_LABELS[provider]}` });
    }
  }
  return errors;
}
