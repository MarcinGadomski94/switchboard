/**
 * Fixes after 2.0 · **Model and Effort in v2** (`docs/v2.md` → *Model and effort*,
 * `docs/design/v2-decisions.md` → *Model and effort instead of Smart / Fast*): the
 * one pure helper behind every v2 model picker (Home's start box, the + New sheet,
 * the agent's "How it works" and its ⓘ line). It shows the CLI's own models with
 * their labels and the CLI's own effort levels with their own names, decided the
 * way classic decides them: D31's `modelChoicePicker` (the header picker) and
 * D42's New-session rules (`src/web/modals/new-session.ts`). No DOM.
 */
import type { ModelSettings, SessionModel, SessionModelOption } from '../../../core/api.ts';
import type { CliProviderId } from '../../../core/cli-providers.ts';
import { CLI_MODEL_ALIASES, DEFAULT_MODEL_CHOICE, DEFAULT_MODEL_VALUE, type ModelChoice, modelOptionFor } from '../../../core/model-choice.ts';
import { MODELS_LOADING, formModel, formModelOptions } from '../../modals/new-session.ts';
import { modelChoicePicker, shortModelLabel } from '../../views/session/session-header.ts';

/** The model item that sends no `--model` (the CLI's own default). */
export const DEFAULT_MODEL_LABEL = 'Default (the CLI’s)';
/** The effort item that sends no `--effort`. */
export const DEFAULT_EFFORT_LABEL = 'Default';
/** Why the pickers are off while an agent's engine has not listed its models. */
export const MODELS_UNKNOWN = 'The models show once the agent has run.';

/** One option of a v2 select (`value` is what the route takes; `''` = the default effort). */
export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
}

/** What a v2 Model + Effort pair shows. */
export interface ModelEffortField {
  /** The models in the CLI's order, the default first (`default` = the CLI's own). */
  readonly models: readonly ChoiceOption[];
  /** The chosen model's value (`default` for the CLI's default). */
  readonly model: string;
  /** Default and the chosen model's levels by their CLI names; `null` when it has none (the Effort select hides). */
  readonly efforts: readonly ChoiceOption[] | null;
  /** The chosen effort (`''` = Default). */
  readonly effort: string;
  /** Why Effort is not offered (shown in its place), `null` while it is. */
  readonly effortReason: string | null;
  /** Off while the models are unknown or loading; {@link reason} says why. */
  readonly disabled: boolean;
  readonly reason: string | null;
  /** The compact text: `Opus 5.5 · high`. */
  readonly summary: string;
}

/** A model's name for a chip or a line: its label (without a trailing note), a known alias's label, else its value. */
export function modelName(available: readonly SessionModelOption[] | null, model: string | null): string {
  if (model === null || model === DEFAULT_MODEL_VALUE) return 'Default';
  const option = modelOptionFor(available, model) ?? CLI_MODEL_ALIASES.find((alias) => alias.value === model) ?? null;
  return option ? shortModelLabel(option.label) : model;
}

/** `Opus 5.5 · high` (the ⓘ line and How it works' summary); `Default` for an agent without model information. */
export function modelSummary(model: SessionModel | null | undefined): string {
  if (!model) return 'Default';
  const name = modelName(model.available, model.current);
  return model.effort ? `${name} · ${model.effort}` : name;
}

/**
 * The Model + Effort pair for `choice` over the models on offer (`null` = not
 * reported yet: both off with {@link MODELS_UNKNOWN}, the stored choice still
 * shown). Classic's rules: the effort items are the chosen model's own levels
 * (all of the CLI's when the model is not in the list); none → Effort hides
 * with a reason.
 */
export function modelEffortField(choice: ModelChoice, available: readonly SessionModelOption[] | null): ModelEffortField {
  const picker = modelChoicePicker({ current: choice.model, effort: choice.effort, available }, '');
  const listed = picker.models.map((item) => ({ value: item.value, label: item.value === DEFAULT_MODEL_VALUE ? DEFAULT_MODEL_LABEL : item.label }));
  const models = [
    ...(listed.some((item) => item.value === DEFAULT_MODEL_VALUE) ? [] : [{ value: DEFAULT_MODEL_VALUE, label: DEFAULT_MODEL_LABEL }]),
    ...listed,
    ...(available === null && choice.model !== null ? [{ value: choice.model, label: modelName(null, choice.model) }] : []),
  ];
  const efforts = picker.efforts?.map((item) => ({ value: item.value ?? '', label: item.value === null ? DEFAULT_EFFORT_LABEL : item.label })) ?? null;
  const effort = efforts?.some((item) => item.value === (choice.effort ?? '')) ? (choice.effort ?? '') : '';
  const name = modelName(available, choice.model);
  return {
    models,
    model: choice.model ?? DEFAULT_MODEL_VALUE,
    efforts,
    effort,
    effortReason: efforts !== null ? null : available === null ? MODELS_UNKNOWN : `${name} has no effort levels.`,
    disabled: available === null,
    reason: available === null ? MODELS_UNKNOWN : null,
    summary: effort ? `${name} · ${effort}` : name,
  };
}

/**
 * The pair a new agent starts with on `provider` (Home's start box and + New):
 * D42's form rules: the developer's pick, else the engine's last choice, else
 * the CLI's default, fitted to the engine's reported models (Claude Code's
 * aliases while none were reported). Off while the models load (`models` `null`
 * and nothing picked).
 */
export function startField(picked: ModelChoice | null, models: ModelSettings | null, loaded: boolean, provider: CliProviderId): ModelEffortField {
  const options = formModelOptions(models, provider);
  const choice = formModel({ model: picked }, models, provider) ?? picked ?? DEFAULT_MODEL_CHOICE;
  const field = modelEffortField(choice, options);
  return !loaded && picked === null ? { ...field, disabled: true, reason: MODELS_LOADING } : field;
}

/** The choice after an effort is picked (`''` = Default). */
export function pickEffort(choice: ModelChoice, value: string): ModelChoice {
  return { model: choice.model, effort: value === '' ? null : value };
}

/** The choice after a model is picked: the effort stays when the new model has it, else Default (classic's rule). */
export function pickModel(choice: ModelChoice, available: readonly SessionModelOption[] | null, value: string): ModelChoice {
  const model = value === DEFAULT_MODEL_VALUE || value === '' ? null : value;
  if (model === choice.model) return choice;
  const next = modelEffortField({ model, effort: choice.effort }, available);
  return { model, effort: next.effort === '' ? null : next.effort };
}
