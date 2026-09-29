import type { ModelSettings, SessionModelOption } from '../../core/api.ts';
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

/** D42: `GET /api/models`: both settings, read defensively (`null` while unset or unreadable). */
export async function readModelSettings(settings: SettingRepository): Promise<ModelSettings> {
  return {
    options: readModelOptions(await settings.get(MODELS_OPTIONS_KEY)),
    last: readModelChoice(await settings.get(MODELS_LAST_KEY)),
  };
}

/** D42: the latest reported list (`null` until a process reported one); what a new session's model is checked against. */
export async function readModelOptionsSetting(settings: SettingRepository): Promise<SessionModelOption[] | null> {
  return readModelOptions(await settings.get(MODELS_OPTIONS_KEY));
}

/** D42: stores `choice` as the last choice (a start with a model or effort, a header pick that was stored). */
export async function rememberModelChoice(settings: SettingRepository, choice: ModelChoice): Promise<void> {
  await settings.set(MODELS_LAST_KEY, { model: choice.model, effort: choice.effort });
}

/** D42: stores the list a claude process reported in `initialize` (where D31 stores the session's `model_options`). */
export async function rememberModelOptions(settings: SettingRepository, options: readonly SessionModelOption[]): Promise<void> {
  await settings.set(MODELS_OPTIONS_KEY, options);
}
