import type { CliProviderId } from '../../core/cli-providers.ts';
import type { CliAdapter } from './adapter.ts';
import type { ModelLister } from './status.ts';

/**
 * D62: the adapters this Switchboard has beyond Claude Code (built into the
 * registry). Codex CLI and OpenCode are added by their modules.
 */
export function cliAdapters(): Partial<Record<CliProviderId, CliAdapter>> {
  return {};
}

/** D62: how Settings → CLIs reads each CLI's models without a session. */
export function cliModelListers(): Partial<Record<CliProviderId, ModelLister>> {
  return {};
}
