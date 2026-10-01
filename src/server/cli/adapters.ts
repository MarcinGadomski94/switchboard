import type { CliProviderId } from '../../core/cli-providers.ts';
import { parseInitializeModels } from '../../core/model-choice.ts';
import { runCommand } from '../exec.ts';
import type { CliAdapter } from './adapter.ts';
import { codexAdapter } from './codex/adapter.ts';
import { listCodexModels } from './codex/bridge.ts';
import { opencodeAdapter } from './opencode/adapter.ts';
import { listOpencodeModels } from './opencode/bridge.ts';
import type { ModelLister } from './status.ts';

/** D62: the adapters this Switchboard has beyond Claude Code (built into the registry). */
export function cliAdapters(): Partial<Record<CliProviderId, CliAdapter>> {
  return { codex: codexAdapter, opencode: opencodeAdapter };
}

/** D62: how Settings → CLIs reads each CLI's models without a session. */
export function cliModelListers(): Partial<Record<CliProviderId, ModelLister>> {
  return {
    codex: async (command, env, cwd) => parseInitializeModels({ models: await listCodexModels(command, env, cwd) }),
    opencode: async (command, env, cwd) => parseInitializeModels({ models: await listOpencodeModels(command, env, cwd, runCommand) }),
  };
}
