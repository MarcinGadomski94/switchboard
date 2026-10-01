import type { CliUsageWindow, SystemInfo, UsageWarning } from '../../core/api.ts';
import type { ProviderUsage } from '../cli/bridge-common.ts';
import type { ServerConfig } from '../config.ts';
import type { Store } from '../db/store.ts';
import type { Providers, SystemProvider } from '../providers.ts';
import { UsageMeter, type UsageSessions } from './meter.ts';
import { UsagePoller } from './poller.ts';

/**
 * `providers.system` with the meter's usage fields (M9.2): `usagePct` and
 * `usageResetsAt` only when the meter knows them (anything the base provider
 * said about usage is dropped, never mixed in), plus the warnings in force as
 * `usageWarnings` and (D17) the windows known now as `usageWindows`. The route and the `system` hub event both read
 * `providers.system`, so both carry them. Without a base provider (M5.3's
 * `SystemProbe` not wired yet) the providers are returned unchanged.
 */
export function withUsage(providers: Providers, meter: Pick<UsageMeter, 'systemFields'>): Providers {
  const base = providers.system;
  if (!base) return providers;
  const system: SystemProvider = {
    async system(...args: Parameters<SystemProvider['system']>): Promise<SystemInfo> {
      const { usagePct, usageResetsAt, usageWarnings, usageWindows, ...info } = await base.system(...args);
      return { ...info, ...(await meter.systemFields()) };
    },
  };
  return { ...providers, system };
}

/** Input of {@link createUsageMeter}. */
export interface CreateUsageMeterInput {
  readonly config: Pick<ServerConfig, 'claudeCommand' | 'claudeExtraArgs' | 'dataDir'>;
  readonly store: Store;
  /** The supervisor (live sessions + stdin control requests). */
  readonly sessions: UsageSessions;
  readonly onWarning?: (warning: UsageWarning) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * The meter of a normal run: the poller runs the configured CLI (with the
 * dev-only extra args, like every spawn) in the app-data folder with the
 * service's environment scrubbed (M2.1).
 */
export function createUsageMeter(input: CreateUsageMeterInput): UsageMeter {
  const poller = new UsagePoller({
    claudeCommand: input.config.claudeCommand,
    extraArgs: input.config.claudeExtraArgs,
    cwd: input.config.dataDir,
  });
  return new UsageMeter({
    store: input.store,
    sessions: input.sessions,
    poller,
    ...(input.onWarning ? { onWarning: input.onWarning } : {}),
    ...(input.onError ? { onError: input.onError } : {}),
  });
}

/**
 * D62 P7: `providers.system` with another CLI's own usage windows
 * (`SystemInfo.cliUsage`: Codex's rate limits, as its bridges last read them).
 * The windows that reset already are left out.
 */
export function withCliUsage(providers: Providers, source: { providerUsage(provider: 'codex' | 'opencode'): ProviderUsage | null }, now: () => number = Date.now): Providers {
  const base = providers.system;
  if (!base) return providers;
  const system: SystemProvider = {
    async system(...args: Parameters<SystemProvider['system']>): Promise<SystemInfo> {
      const info = await base.system(...args);
      const windows = cliUsageWindows(source.providerUsage('codex'), now());
      return windows.length > 0 ? { ...info, cliUsage: windows } : info;
    },
  };
  return { ...providers, system };
}

/** Codex's windows as footer rows: `Codex 5h` (300 minutes), `Codex week` (10 080), else `Codex <n>h`. */
export function cliUsageWindows(usage: ProviderUsage | null, now: number): CliUsageWindow[] {
  if (!usage) return [];
  return usage.windows
    .filter((window) => window.resetsAt === null || Date.parse(window.resetsAt) > now)
    .map((window) => ({
      provider: usage.provider,
      label: `Codex ${window.minutes === 10_080 ? 'week' : window.minutes === null ? 'limit' : `${Math.round(window.minutes / 60)}h`}`,
      pct: Math.max(0, Math.min(100, window.pct)),
      resetsAt: window.resetsAt,
    }));
}

