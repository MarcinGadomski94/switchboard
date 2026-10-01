import type { AccountUsageRow, CliUsageWindow, SystemInfo, UsageWarning } from '../../core/api.ts';
import type { ProviderUsage } from '../cli/bridge-common.ts';
import type { ServerConfig } from '../config.ts';
import type { Store } from '../db/store.ts';
import type { Providers, SystemProvider } from '../providers.ts';
import type { AccountService } from '../accounts/service.ts';
import { defaultProfileId } from '../../core/accounts.ts';
import { UsageMeter, type UsageProfiles, type UsageSessions } from './meter.ts';
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
  /** D63: the account profiles: readings per Claude Code profile. */
  readonly accounts?: AccountService;
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
  const accounts = input.accounts;
  const profiles: UsageProfiles | undefined = accounts
    ? {
        claudeProfiles: async () => (await input.store.profiles.list('claude')).filter((p) => p.enabled).map((p) => p.id),
        pollerFor: (profileId) =>
          profileId === defaultProfileId('claude')
            ? poller
            : {
                async getUsage() {
                  // The profile's own folder in the environment: its own account's numbers.
                  const env = { ...process.env, ...(await accounts.envFor(profileId, 'claude')) };
                  return new UsagePoller({ claudeCommand: input.config.claudeCommand, extraArgs: input.config.claudeExtraArgs, cwd: input.config.dataDir, env }).getUsage();
                },
              },
        active: async () => (await accounts.pick('claude')) ?? (await input.store.profiles.list('claude')).find((p) => p.enabled)?.id ?? defaultProfileId('claude'),
      }
    : undefined;
  return new UsageMeter({
    store: input.store,
    sessions: input.sessions,
    poller,
    ...(profiles ? { profiles } : {}),
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


/**
 * D63: `providers.system` with each account profile's usage (`SystemInfo.accountUsage`,
 * the footer's "A 62% · B 10%" line), only while a CLI has more than one enabled profile.
 * Claude Code profiles have their readings, Codex profiles the windows their sessions reported.
 */
export function withAccountUsage(providers: Providers, accounts: AccountService, now: () => number = Date.now): Providers {
  const base = providers.system;
  if (!base) return providers;
  const system: SystemProvider = {
    async system(...args: Parameters<SystemProvider['system']>): Promise<SystemInfo> {
      const info = await base.system(...args);
      const rows: AccountUsageRow[] = [];
      for (const cli of ['claude', 'codex'] as const) {
        const list = (await accounts.list({ check: false })).filter((p) => p.cli === cli && p.enabled);
        if (list.length < 2) continue;
        const active = await accounts.pick(cli);
        for (const profile of list) {
          const usage = profile.usage;
          const live = (iso: string | null): boolean => iso !== null && Date.parse(iso) > now();
          const values = [live(usage?.fiveHourResetsAt ?? null) ? usage?.fiveHourPct : null, live(usage?.sevenDayResetsAt ?? null) ? usage?.sevenDayPct : null].filter((v): v is number => typeof v === 'number');
          rows.push({
            profileId: profile.id,
            cli,
            name: profile.name,
            active: (active ?? list[0]?.id) === profile.id,
            pct: values.length > 0 ? Math.round(Math.max(...values)) : null,
            exhaustedUntil: profile.exhausted?.until ?? null,
          });
        }
      }
      return rows.length > 0 ? { ...info, accountUsage: rows } : info;
    }
  };
  return { ...providers, system };
}
