import { type Json, type JsonObject, asString, isObject } from './json.ts';

/**
 * fake-claude's model and effort (D31, `docs/fake-claude.md` → *Model and effort*),
 * built to what the D31 probe saw on CLI 2.1.283 (`docs/model-effort.md` → *The
 * CLI's side*): `set_model` answers a bare success or `Model '<x>' not found`
 * (`catalog_unknown`); `apply_flag_settings {effortLevel}` answers a bare success
 * for any string or `null`; `get_settings` → `applied {model, effort, advisor,
 * ultracode}`; `--effort` takes the levels below and only warns about others.
 */

/** `--effort` choices of CLI 2.1.283 (`claude --help`). */
export const FAKE_EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** `FAKE_CLAUDE_MODELS=none`: `initialize` reports no `models` list (a CLI that lists none). Unset / anything else: the recorded list. */
export function modelsListed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['FAKE_CLAUDE_MODELS'] !== 'none';
}

/** `FAKE_CLAUDE_SET_MODEL_ERROR`: every `set_model` request answers an error with this text (unset / empty: none). */
export function setModelError(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env['FAKE_CLAUDE_SET_MODEL_ERROR'];
  return value !== undefined && value !== '' ? value : null;
}

/** `FAKE_CLAUDE_EFFORT_ERROR`: every `apply_flag_settings` request with an `effortLevel` answers an error with this text (unset / empty: none). */
export function effortError(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env['FAKE_CLAUDE_EFFORT_ERROR'];
  return value !== undefined && value !== '' ? value : null;
}

/** The stderr warning for a `--effort` value that is not a level (the CLI warns and goes on). */
export function effortWarning(level: string): string {
  return `Warning: fake-claude: unknown effort level "${level}" (${FAKE_EFFORT_LEVELS.join(', ')}); using the default\n`;
}

/** The inner reply of a control request: a bare success (the CLI sends no body for these) or an error with its text. */
export type ControlReply = { readonly ok: true; readonly response?: JsonObject } | { readonly ok: false; readonly error: string; readonly code?: string };

/**
 * The model and effort of one fake process: `--model` / `--effort` at spawn, then
 * `set_model` and `apply_flag_settings` change them. `null` = the default (the
 * recorded model, no effort).
 */
export class FakeModelState {
  model: string | null;
  effort: string | null;
  readonly #env: NodeJS.ProcessEnv;

  constructor(model: string | null, effort: string | null, env: NodeJS.ProcessEnv) {
    this.model = model;
    this.effort = effort;
    this.#env = env;
  }

  /**
   * `set_model {model}`: `FAKE_CLAUDE_SET_MODEL_ERROR` → that error; a model that
   * is neither `default` / `null` nor a `value` of `models` (the recorded
   * `initialize` list) → `Model '<x>' not found` (`catalog_unknown`, as probed).
   */
  setModel(request: JsonObject, models: readonly JsonObject[]): ControlReply {
    const failure = setModelError(this.#env);
    if (failure !== null) return { ok: false, error: failure };
    const model = request['model'];
    if (model !== undefined && model !== null && typeof model !== 'string') return { ok: false, error: 'set_model: model must be a string', code: 'invalid_request' };
    const value = typeof model === 'string' ? model : 'default';
    if (value !== 'default' && !models.some((entry) => entry['value'] === value)) return { ok: false, error: `Model '${value}' not found`, code: 'catalog_unknown' };
    this.model = value === 'default' ? null : value;
    return { ok: true };
  }

  /**
   * `apply_flag_settings {settings}`: `settings` must be an object (the CLI's
   * text otherwise); `effortLevel` (a string or `null`; not checked, as the CLI)
   * sets the effort unless `FAKE_CLAUDE_EFFORT_ERROR` refuses it; `model` sets the
   * model. Other keys are accepted and ignored.
   */
  applyFlagSettings(request: JsonObject): ControlReply {
    const settings = request['settings'];
    if (!isObject(settings)) {
      const got = settings === null ? 'null' : Array.isArray(settings) ? 'an array' : typeof settings;
      return { ok: false, error: `apply_flag_settings requires \`settings\` to be an object, got ${got}` };
    }
    if ('effortLevel' in settings) {
      const failure = effortError(this.#env);
      if (failure !== null) return { ok: false, error: failure };
      const level: Json | undefined = settings['effortLevel'];
      if (level !== null && typeof level !== 'string') return { ok: false, error: 'apply_flag_settings: effortLevel must be a string or null' };
      this.effort = level;
    }
    if ('model' in settings) {
      const model = asString(settings['model']);
      this.model = model === undefined || model === 'default' ? null : model;
    }
    return { ok: true };
  }

  /** The model the process runs on: the chosen entry's `resolvedModel` (else its value); `null` = the default (the recorded one). */
  resolved(models: readonly JsonObject[]): string | null {
    if (this.model === null) return null;
    const entry = models.find((candidate) => candidate['value'] === this.model);
    return asString(entry?.['resolvedModel']) ?? this.model;
  }

  /** `get_settings` → `{ applied: { model, effort, advisor: null, ultracode: false } }` (the probe's shape); `recorded` = the default model. */
  settings(models: readonly JsonObject[], recorded: string): JsonObject {
    return { applied: { model: this.resolved(models) ?? recorded, effort: this.effort, advisor: null, ultracode: false } };
  }
}
