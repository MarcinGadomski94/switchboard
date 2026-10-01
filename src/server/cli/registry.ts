import { CLI_DEFAULT_COMMAND, CLI_LABELS, type CliProviderId } from '../../core/cli-providers.ts';
import type { SettingRepository } from '../db/repos/settings.ts';
import type { CliAdapter } from './adapter.ts';
import { claudeAdapter } from './claude.ts';

/** D62: the settings row of a provider's command override (`string[]`, an argv prefix); Claude Code has none (env only). */
export function cliCommandKey(provider: CliProviderId): string {
  return `cli.${provider}.command`;
}

/** D62: the settings row of the default CLI for new sessions (`CliProviderId`). */
export const CLI_DEFAULT_KEY = 'cli.default';

/** Options of {@link CliRegistry}. */
export interface CliRegistryOptions {
  /** The configured argv prefixes (`SWITCHBOARD_<X>_BIN`); a provider left out is its bare name (`codex`, `opencode`). */
  readonly commands: Partial<Record<CliProviderId, readonly string[]>>;
  /** The settings table: Codex / OpenCode command overrides from Settings → CLIs. Without it only the configured commands count. */
  readonly settings?: SettingRepository;
  /** The adapters; Claude Code's is built in. A provider without one cannot start sessions (tests, or before its adapter exists). */
  readonly adapters?: Partial<Record<CliProviderId, CliAdapter>>;
}

/** A provider has no adapter (not built into this Switchboard). */
export class MissingAdapterError extends Error {
  override name = 'MissingAdapterError';
}

/**
 * D62: the CLIs Switchboard can start sessions on, their commands and adapters
 * (`docs/providers.md` → *Design*). Claude Code's command is the environment's
 * (`SWITCHBOARD_CLAUDE_BIN`, unchanged); Codex CLI and OpenCode take
 * `SWITCHBOARD_CODEX_BIN` / `SWITCHBOARD_OPENCODE_BIN`, overridden by
 * Settings → CLIs (`cli.<id>.command`).
 */
export class CliRegistry {
  readonly #commands: Partial<Record<CliProviderId, readonly string[]>>;
  readonly #settings: SettingRepository | null;
  readonly #adapters: Partial<Record<CliProviderId, CliAdapter>>;

  constructor(options: CliRegistryOptions) {
    this.#commands = options.commands;
    this.#settings = options.settings ?? null;
    this.#adapters = { claude: claudeAdapter, ...options.adapters };
  }

  /** The configured command (env), without the settings override. */
  configuredCommand(provider: CliProviderId): readonly string[] {
    return this.#commands[provider] ?? [CLI_DEFAULT_COMMAND[provider]];
  }

  /** The settings override of `provider`, `null` when none (always `null` for Claude Code). */
  async overrideCommand(provider: CliProviderId): Promise<readonly string[] | null> {
    if (provider === 'claude' || !this.#settings) return null;
    return readCommandOverride(await this.#settings.get(cliCommandKey(provider)));
  }

  /** The command a spawn uses now: the settings override, else the configured one. */
  async command(provider: CliProviderId): Promise<readonly string[]> {
    return (await this.overrideCommand(provider)) ?? this.configuredCommand(provider);
  }

  /** The adapter of `provider`. @throws {MissingAdapterError} when this build has none. */
  adapter(provider: CliProviderId): CliAdapter {
    const adapter = this.#adapters[provider];
    if (!adapter) throw new MissingAdapterError(`${CLI_LABELS[provider]} is not supported by this Switchboard`);
    return adapter;
  }

  /** `true` when `provider` has an adapter. */
  hasAdapter(provider: CliProviderId): boolean {
    return this.#adapters[provider] !== undefined;
  }
}

/** A stored command override: a non-empty array of non-empty strings, else `null`. */
export function readCommandOverride(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((part) => typeof part === 'string' && part.trim() !== '')) return null;
  return value as string[];
}
