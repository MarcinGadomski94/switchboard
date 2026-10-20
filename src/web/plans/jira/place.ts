import { type CliProviderId, isCliProviderId } from '../../../core/cli-providers.ts';
import type { ModelChoice } from '../../../core/model-choice.ts';

/**
 * D112 · where an import from Jira runs when it starts its own session (the dialog's
 * **Where it runs**): the machine (`null` = this one), the saved folder (that machine's id),
 * the CLI, the model and effort (`null` = the CLI's last choice), the account (`null` =
 * automatic), a workspace's solution repos and the plan's base branch. The last one used is
 * kept in this browser, like the Todos page's view (`localStorage`), and pre-fills the next
 * import.
 */
export interface JiraImportPlace {
  readonly machine: string | null;
  readonly folder: string | null;
  readonly provider: CliProviderId | null;
  readonly model: ModelChoice | null;
  readonly profileId: string | null;
  readonly repos: readonly string[];
  readonly baseBranch: string;
  /**
   * D119: the sidebar folder the developer last put a plan of each working folder in, keyed
   * {@link sidebarChoiceKey} (machine and saved folder): a sidebar folder id, `null` = the root.
   */
  readonly sidebarFolders: Readonly<Record<string, string | null>>;
}

/** D119: the key of a working folder (that machine's saved folder) in {@link JiraImportPlace.sidebarFolders}. */
export function sidebarChoiceKey(machine: string | null, folder: string): string {
  return `${machine ?? ''}|${folder}`;
}

/** The `localStorage` key of the last import's place. */
export const LAST_PLACE_KEY = 'switchboard.plans.jiraImport.place';

/** A first import: this machine, the default folder, the default CLI and model, `dev`. */
export const DEFAULT_PLACE: JiraImportPlace = { machine: null, folder: null, provider: null, model: null, profileId: null, repos: [], baseBranch: 'dev', sidebarFolders: {} };

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Reads a stored place (anything malformed falls back to {@link DEFAULT_PLACE}, field by field). */
export function parsePlace(raw: string | null): JiraImportPlace {
  if (!raw) return DEFAULT_PLACE;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_PLACE;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_PLACE;
  const record = value as Record<string, unknown>;
  const model = record['model'];
  const choice: ModelChoice | null =
    typeof model === 'object' && model !== null && !Array.isArray(model)
      ? { model: text((model as Record<string, unknown>)['model']), effort: text((model as Record<string, unknown>)['effort']) }
      : null;
  const repos = Array.isArray(record['repos']) ? record['repos'].filter((name): name is string => typeof name === 'string' && name !== '') : [];
  return {
    machine: text(record['machine']),
    folder: text(record['folder']),
    provider: isCliProviderId(record['provider']) ? record['provider'] : null,
    model: choice,
    profileId: text(record['profileId']),
    repos: [...new Set(repos)],
    baseBranch: text(record['baseBranch']) ?? DEFAULT_PLACE.baseBranch,
    sidebarFolders: sidebarChoices(record['sidebarFolders']),
  };
}

/** D119: the remembered sidebar folders (anything that is not a folder id or `null` is dropped). */
function sidebarChoices(value: unknown): Record<string, string | null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string | null> = {};
  for (const [key, choice] of Object.entries(value as Record<string, unknown>)) if (choice === null || (typeof choice === 'string' && choice !== '')) out[key] = choice;
  return out;
}

/** The last import's place (this browser). */
export function loadLastPlace(): JiraImportPlace {
  try {
    return parsePlace(globalThis.localStorage?.getItem(LAST_PLACE_KEY) ?? null);
  } catch {
    return DEFAULT_PLACE;
  }
}

/** Keeps the place of an import that succeeded. */
export function saveLastPlace(place: JiraImportPlace): void {
  try {
    globalThis.localStorage?.setItem(LAST_PLACE_KEY, JSON.stringify(place));
  } catch {
    // A browser without storage simply starts from the defaults next time.
  }
}
