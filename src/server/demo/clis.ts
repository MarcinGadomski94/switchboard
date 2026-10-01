import type { CliInfo, CliOverview } from '../../core/api.ts';
import { CLI_BIN_ENV, CLI_INSTALL, CLI_LABELS, CLI_PROVIDERS, type CliProviderId } from '../../core/cli-providers.ts';
import { CLI_MODEL_ALIASES } from '../../core/model-choice.ts';

/** D62: the demo's CLIs (gap #21: data only; nothing is run): Claude Code signed in, Codex installed, OpenCode not installed. */
export function demoCliOverview(): CliOverview {
  const at = new Date().toISOString();
  const info = (provider: CliProviderId, installed: boolean, version: string | null): CliInfo => ({
    provider,
    label: CLI_LABELS[provider],
    command: [provider],
    commandSource: 'default',
    envVar: CLI_BIN_ENV[provider],
    path: installed ? `/usr/local/bin/${provider}` : null,
    installed,
    version,
    signedIn: installed ? true : null,
    account: null,
    supported: true,
    available: installed,
    reason: installed ? null : `${CLI_LABELS[provider]} is not installed`,
    models: provider === 'claude' ? CLI_MODEL_ALIASES : null,
    checkedAt: at,
    install: CLI_INSTALL[provider],
  });
  return {
    default: 'claude',
    clis: CLI_PROVIDERS.map((provider) => (provider === 'claude' ? info(provider, true, '2.1.285 (Claude Code)') : provider === 'codex' ? info(provider, true, 'codex-cli 0.159.3') : info(provider, false, null))),
  };
}
