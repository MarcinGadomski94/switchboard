import type { ModelSettings, SessionModelOption } from '../../core/api.ts';
import type { CliProviderId } from '../../core/cli-providers.ts';
import { type ModelChoice, readModelChoice, readModelOptions } from '../../core/model-choice.ts';
import type { SettingRepository } from '../db/repos/settings.ts';

/**
 * D42 (`docs/model-effort.md` → *At session start (D42)*): the service's own
 * model settings, rows of the `settings` table that `GET/PUT /api/settings` do
 * not carry (the service writes them; `GET /api/models` reads them).
 */

/** D42: the last model and effort the developer chose (`{ model, effort }`, `null` = the CLI's default). */
export const MODELS_LAST_KEY = 'models.last';

/** D42: the latest model list any claude process reported in its `initialize` reply (`SessionModelOption[]`). */
export const MODELS_OPTIONS_KEY = 'models.options';

/**
 * D62: the settings row of `provider`'s model list: Claude Code keeps D42's
 * `models.options`; Codex / OpenCode have their own (`models.options.codex`, …),
 * since each CLI names its models differently.
 */
export function modelOptionsKey(provider: CliProviderId): string {
  return provider === 'claude' ? MODELS_OPTIONS_KEY : `${MODELS_OPTIONS_KEY}.${provider}`;
}

/** D62: the settings row of `provider`'s last model choice (Claude Code: D42's `models.last`). */
export function modelLastKey(provider: CliProviderId): string {
  return provider === 'claude' ? MODELS_LAST_KEY : `${MODELS_LAST_KEY}.${provider}`;
}

/** D42: `GET /api/models`: both settings, read defensively (`null` while unset or unreadable). D62: of `provider` (default Claude Code). */
export async function readModelSettings(settings: SettingRepository, provider: CliProviderId = 'claude'): Promise<ModelSettings> {
  return {
    options: readModelOptions(await settings.get(modelOptionsKey(provider))),
    last: readModelChoice(await settings.get(modelLastKey(provider))),
  };
}

/** D42: the latest reported list (`null` until a process reported one); what a new session's model is checked against. D62: of `provider`. */
export async function readModelOptionsSetting(settings: SettingRepository, provider: CliProviderId = 'claude'): Promise<SessionModelOption[] | null> {
  return readModelOptions(await settings.get(modelOptionsKey(provider)));
}

/** D42: stores `choice` as the last choice (a start with a model or effort, a header pick that was stored). D62: of `provider`. */
export async function rememberModelChoice(settings: SettingRepository, choice: ModelChoice, provider: CliProviderId = 'claude'): Promise<void> {
  await settings.set(modelLastKey(provider), { model: choice.model, effort: choice.effort });
}

/** D42: stores the list a claude process reported in `initialize` (where D31 stores the session's `model_options`). D62: of `provider`. */
export async function rememberModelOptions(settings: SettingRepository, options: readonly SessionModelOption[], provider: CliProviderId = 'claude'): Promise<void> {
  await settings.set(modelOptionsKey(provider), options);
}
