/**
 * D132 (`docs/decisions.md`): Team, Plans and Project memory graduated from Settings →
 * Experimental to general release in 2.0. Their old switches are gone from the known settings
 * (`src/core/settings.ts`) and nothing reads them any more, whatever value an install stored:
 * the features are on. These are the keys 1.x stored; {@link forgetGraduatedSwitches} deletes
 * them once at start (idempotent: a key that is not there is left alone).
 */
export const GRADUATED_SWITCH_KEYS = ['experimental.team', 'experimental.plans', 'experimental.memory'] as const;

/** What {@link forgetGraduatedSwitches} needs of the settings repository. */
export interface GraduatedSettings {
  delete(key: string): Promise<boolean>;
}

/**
 * Deletes the stored 1.x switches of the graduated features (D132). Answers the keys that were
 * there. Never throws: a failed delete leaves a row nothing reads.
 */
export async function forgetGraduatedSwitches(settings: GraduatedSettings): Promise<string[]> {
  const removed: string[] = [];
  for (const key of GRADUATED_SWITCH_KEYS) {
    try {
      if (await settings.delete(key)) removed.push(key);
    } catch {
      // Harmless: an unknown settings key is never read.
    }
  }
  return removed;
}
