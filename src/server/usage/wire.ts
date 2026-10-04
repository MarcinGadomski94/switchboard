import type { AccountUsageRow, AccountUsageWindow, ActiveAccount, CliUsageWindow, SystemInfo, UsageWarning, UsageWindow } from '../../core/api.ts';
import type { ProviderUsage } from '../cli/bridge-common.ts';
import type { ServerConfig } from '../config.ts';
import type { Store } from '../db/store.ts';
import type { Providers, SystemProvider } from '../providers.ts';
import type { AccountService } from '../accounts/service.ts';
import { type ProfileUsage, defaultProfileId } from '../../core/accounts.ts';
import { USAGE_ROW_LABELS } from '../../core/usage.ts';
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
        active: async () => (await accounts.pick('claude', { check: false })) ?? (await input.store.profiles.list('claude')).find((p) => p.enabled)?.id ?? defaultProfileId('claude'),
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

/**
 * Codex's windows as footer rows: `Codex 5h` (300 minutes), `Codex week` (10 080), else `Codex <n>h`.
 * D66: each with its `key` (`session` up to 10 hours, `week` longer, as `AccountService.usageOf` splits them).
 */
export function cliUsageWindows(usage: ProviderUsage | null, now: number): CliUsageWindow[] {
  if (!usage) return [];
  return usage.windows
    .filter((window) => window.resetsAt === null || Date.parse(window.resetsAt) > now)
    .map((window) => ({
      provider: usage.provider,
      label: `Codex ${window.minutes === 10_080 ? 'week' : window.minutes === null ? 'limit' : `${Math.round(window.minutes / 60)}h`}`,
      pct: Math.max(0, Math.min(100, window.pct)),
      resetsAt: window.resetsAt,
      key: window.minutes === null ? 'model' : window.minutes <= 600 ? 'session' : 'week',
    }));
}


/**
 * D66: a profile's Session and Week windows from its latest usage (a Codex profile's,
 * or a Claude Code one's without the meter); a window that has reset is left out.
 */
export function profileUsageWindows(usage: ProfileUsage | null, now: number): AccountUsageWindow[] {
  if (!usage) return [];
  const out: AccountUsageWindow[] = [];
  const add = (key: 'session' | 'week', pct: number | null, resetsAt: string | null): void => {
    if (pct === null || (resetsAt !== null && !(Date.parse(resetsAt) > now))) return;
    out.push({ key, label: USAGE_ROW_LABELS[key], pct: Math.max(0, Math.min(100, pct)), resetsAt });
  };
  add('session', usage.fiveHourPct, usage.fiveHourResetsAt);
  add('week', usage.sevenDayPct, usage.sevenDayResetsAt);
  return out;
}

/**
 * D63: `providers.system` with each account profile's usage (`SystemInfo.accountUsage`),
 * only while a CLI has more than one enabled profile. Claude Code profiles have their
 * readings, Codex profiles the windows their sessions reported. D66: each row also
 * lists its `windows` (the footer grid's two bars per account); `windowsOf` (the
 * meter's `profileWindows`) gives a Claude Code profile's, model limits included;
 * `activeAccounts` names each CLI's active account, also while it has only one.
 */
export function withAccountUsage(
  providers: Providers,
  accounts: AccountService,
  now: () => number = Date.now,
  windowsOf?: (profileId: string) => Promise<readonly UsageWindow[]>,
): Providers {
  const base = providers.system;
  if (!base) return providers;
  const system: SystemProvider = {
    async system(...args: Parameters<SystemProvider['system']>): Promise<SystemInfo> {
      const info = await base.system(...args);
      const rows: AccountUsageRow[] = [];
      const actives: ActiveAccount[] = [];
      for (const cli of ['claude', 'codex'] as const) {
        const list = (await accounts.list({ check: false })).filter((p) => p.cli === cli && p.enabled);
        if (list.length === 0) continue;
        const active = await accounts.pick(cli, { check: false });
        // D66: the active account's name, also with a single one (the footer grid's line label).
        const current = list.find((p) => p.id === active) ?? list[0];
        if (current) actives.push({ cli, profileId: current.id, name: current.name });
        if (list.length < 2) continue;
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
            windows: cli === 'claude' && windowsOf ? await windowsOf(profile.id) : profileUsageWindows(usage, now()),
          });
        }
      }
      return { ...info, ...(rows.length > 0 ? { accountUsage: rows } : {}), ...(actives.length > 0 ? { activeAccounts: actives } : {}) };
    }
  };
  return { ...providers, system };
}
