/**
 * Model and effort of a supervised session (D31, `docs/model-effort.md`): the
 * pure part, shared by the server (the `initialize` reply, the route's checks, the
 * chat step line) and the UI (the pickers). The CLI's shapes were probed on
 * CLI 2.1.283; every reply is still read defensively: unknown fields are ignored
 * and an entry without a usable `value` is skipped.
 */
import type { SessionModelOption } from './api.ts';

/** The `value` of the CLI's default model in `initialize` (`Default (recommended)`); stored as `null` (no `--model`). */
export const DEFAULT_MODEL_VALUE = 'default';

/**
 * `--effort` choices of CLI 2.1.283 (`claude --help`: "low, medium, high, xhigh,
 * max"). Used to check an effort only while the session's model list is unknown;
 * once it is known, the chosen model's own levels decide.
 */
export const CLI_EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Longest model name or effort level the route accepts. */
export const MODEL_VALUE_MAX = 100;

/**
 * A model name the CLI could take while its list is unknown: letters and digits
 * first (never a leading `-`, which argv would read as a flag), then letters,
 * digits and `. _ : - [ ] / @` (e.g. `claude-opus-4-7`, `claude-opus-5-5[1m]`).
 */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]/@]*$/;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The models of an `initialize` reply's inner `response` (`models[]`: `value`,
 * `displayName`, `description`, `supportsEffort`, `supportedEffortLevels`, …; the
 * recorded `ctl-init` and the D31 probe). Each entry becomes `{ value, label,
 * description?, efforts? }`: `label` = `displayName`, else the value; `efforts` =
 * the `supportedEffortLevels` strings (in order, no duplicates) unless
 * `supportsEffort` is `false`, left out when there are none. Entries without a
 * string `value`, and repeated values, are skipped. `null` when the reply has no
 * `models` array or no usable entry: the list is unknown.
 */
export function parseInitializeModels(initializeResponse: unknown): SessionModelOption[] | null {
  if (!isRecord(initializeResponse) || !Array.isArray(initializeResponse['models'])) return null;
  const out: SessionModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of initializeResponse['models']) {
    if (!isRecord(entry)) continue;
    const value = text(entry['value']);
    if (value === null || seen.has(value)) continue;
    seen.add(value);
    const description = text(entry['description']);
    const levels = entry['supportsEffort'] === false || !Array.isArray(entry['supportedEffortLevels']) ? [] : entry['supportedEffortLevels'];
    const efforts = [...new Set(levels.map(text).filter((level): level is string => level !== null))];
    out.push({
      value,
      label: text(entry['displayName']) ?? value,
      ...(description !== null ? { description } : {}),
      ...(efforts.length > 0 ? { efforts } : {}),
    });
  }
  return out.length > 0 ? out : null;
}

/** The stored model for a requested one: trimmed; blank or `default` = `null` (the CLI's default, no `--model`). */
export function normalizeModel(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' || trimmed === DEFAULT_MODEL_VALUE ? null : trimmed;
}

/** The stored effort for a requested one: trimmed; blank = `null` (the CLI's default, no `--effort`). */
export function normalizeEffort(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** The list's entry for a stored model (`null` = the CLI's default = the `default` entry); `null` when the list has none. */
export function modelOptionFor(available: readonly SessionModelOption[] | null, model: string | null): SessionModelOption | null {
  const value = model ?? DEFAULT_MODEL_VALUE;
  return available?.find((option) => option.value === value) ?? null;
}

/**
 * The effort levels of a stored model: its entry's `efforts` (`[]` when it has
 * none); `null` when that is unknown (no list, or the model is not in it).
 */
export function effortLevelsFor(available: readonly SessionModelOption[] | null, model: string | null): readonly string[] | null {
  const option = modelOptionFor(available, model);
  return option ? (option.efforts ?? []) : null;
}

/** How a stored model is named: its entry's label, else the value, else `default`. */
export function modelLabel(available: readonly SessionModelOption[] | null, model: string | null): string {
  return modelOptionFor(available, model)?.label ?? model ?? DEFAULT_MODEL_VALUE;
}

/** A session's model and effort as stored (`null` = the CLI's default). */
export interface ModelChoice {
  readonly model: string | null;
  readonly effort: string | null;
}

/** Why a choice is refused (the route's 422, `{ field, message }`). */
export interface ModelChoiceProblem {
  readonly field: 'model' | 'effort';
  readonly message: string;
}

/**
 * Checks a choice before anything is sent or stored (the route's 422):
 * - a model must be one of the listed values while the session's list is known;
 *   while it is unknown, any model name (`MODEL_NAME`, at most
 *   {@link MODEL_VALUE_MAX} characters) is taken and the CLI decides;
 * - an effort must be one of the chosen model's levels while those are known (a
 *   model without levels takes none); otherwise one of {@link CLI_EFFORT_LEVELS}.
 * `null` for either is always fine (the CLI's default). The CLI does not check an
 * effort itself (an unknown level is a silent success), so this is the only check.
 */
export function checkModelChoice(choice: ModelChoice, available: readonly SessionModelOption[] | null): ModelChoiceProblem | null {
  const { model, effort } = choice;
  if (model !== null) {
    if (model.length > MODEL_VALUE_MAX || !MODEL_NAME.test(model)) return { field: 'model', message: `"${model}" is not a model name` };
    if (available && !available.some((option) => option.value === model)) {
      return { field: 'model', message: `claude does not offer the model "${model}" here: pick one of ${available.map((option) => option.value).join(', ')}` };
    }
  }
  if (effort !== null) {
    const levels = effortLevelsFor(available, model);
    if (levels === null) {
      if (!CLI_EFFORT_LEVELS.includes(effort)) return { field: 'effort', message: `"${effort}" is not an effort level (${CLI_EFFORT_LEVELS.join(', ')})` };
    } else if (levels.length === 0) {
      return { field: 'effort', message: `${modelLabel(available, model)} has no effort levels: set the effort to null (the CLI's default)` };
    } else if (!levels.includes(effort)) {
      return { field: 'effort', message: `${modelLabel(available, model)} supports the effort levels ${levels.join(', ')}: "${effort}" is not one of them` };
    }
  }
  return null;
}

/** The chat step line of a change (D31): `Model: Opus 5.5 · effort: high` (`default` for the CLI's default effort). */
export function modelStepLabel(choice: ModelChoice, available: readonly SessionModelOption[] | null): string {
  return `Model: ${modelLabel(available, choice.model)} · effort: ${choice.effort ?? 'default'}`;
}
