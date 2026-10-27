import type { AccountsOverview } from '../../core/api.ts';
import { overallChoiceOf } from '../../core/accounts.ts';
import { CLI_LABELS, CLI_PROVIDERS, type CliProviderId } from '../../core/cli-providers.ts';

/** D138: one CLI's row of the account picker. */
export interface CliAccountChoice {
  readonly cli: CliProviderId;
  /** `Claude Code`, `Codex CLI`, `OpenCode`. */
  readonly label: string;
  /** Its enabled accounts in switching order (`out`: known out of usage now). */
  readonly options: ReadonlyArray<{ readonly id: string; readonly name: string; readonly out: boolean }>;
  /** The overall choice (`null` = Automatic). */
  readonly chosen: string | null;
}

/**
 * D138 (`docs/accounts.md` → *Choosing the account*): the picker's rows: every CLI with more
 * than one enabled account on this computer (with one there is nothing to choose).
 */
export function accountChoiceRows(overview: AccountsOverview | null, now: number = Date.now()): CliAccountChoice[] {
  if (!overview) return [];
  const out: CliAccountChoice[] = [];
  for (const cli of CLI_PROVIDERS) {
    const mine = overview.profiles.filter((p) => p.cli === cli && p.enabled).sort((a, b) => a.position - b.position);
    if (mine.length < 2) continue;
    const chosen = overallChoiceOf(overview.settings, cli);
    out.push({
      cli,
      label: CLI_LABELS[cli],
      options: mine.map((p) => ({ id: p.id, name: p.name, out: p.exhausted !== null && Date.parse(p.exhausted.until) > now })),
      chosen: chosen && mine.some((p) => p.id === chosen) ? chosen : null,
    });
  }
  return out;
}
