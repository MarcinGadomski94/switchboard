import type { CliInfo, CliOverview } from '../../core/api.ts';
import { CLI_LABELS, CLI_PROVIDERS, type CliProviderId } from '../../core/cli-providers.ts';

/**
 * D62 (`docs/providers.md`): what the CLI pickers show (the New-session forms'
 * CLI choice, the sidebar's default-CLI switcher, the header's switcher). Pure.
 */

/** One option of a CLI picker. */
export interface CliChoice {
  readonly provider: CliProviderId;
  /** `Codex CLI`, or `Codex CLI (not installed)` / `(signed out)` / `(not supported)`. */
  readonly label: string;
  readonly disabled: boolean;
  /** The reason it cannot be chosen (the option's tooltip and the note under the picker). */
  readonly reason: string | null;
}

/** A short state word for an unavailable CLI. */
export function cliStateWord(cli: CliInfo): string | null {
  if (cli.available) return null;
  if (!cli.supported) return 'not supported';
  if (!cli.installed) return 'not installed';
  if (cli.signedIn === false) return 'signed out';
  return 'unavailable';
}

/** The picker's options; while the overview is unknown every CLI is listed and only Claude Code can be chosen. */
export function cliChoices(overview: CliOverview | null): CliChoice[] {
  return CLI_PROVIDERS.map((provider) => {
    const cli = overview?.clis.find((entry) => entry.provider === provider) ?? null;
    if (!cli) return { provider, label: CLI_LABELS[provider], disabled: provider !== 'claude', reason: provider === 'claude' ? null : 'Checking the CLI…' };
    const word = cliStateWord(cli);
    return { provider, label: word ? `${cli.label} (${word})` : cli.label, disabled: !cli.available, reason: cli.reason };
  });
}

/** The CLI a form starts on: its pick, else the default CLI when it can be chosen, else Claude Code. */
export function effectiveCli(picked: CliProviderId | null, overview: CliOverview | null): CliProviderId {
  if (picked) return picked;
  const fallback = overview?.default ?? 'claude';
  const cli = overview?.clis.find((entry) => entry.provider === fallback);
  return cli && !cli.available ? 'claude' : fallback;
}
