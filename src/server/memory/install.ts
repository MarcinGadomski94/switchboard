import type { FastifyInstance } from 'fastify';
import { defaultProfileId } from '../../core/accounts.ts';
import type { CliProviderId } from '../../core/cli-providers.ts';
import { WARN_AT_KEY, warnAtPct } from '../../core/setup.ts';
import type { AccountService } from '../accounts/service.ts';
import type { Store } from '../db/store.ts';
import type { ApiContext } from '../routes.ts';
import { childEnv } from '../supervisor/argv.ts';
import { type MemoryCheckHost, claudeCheckRunner } from './check.ts';
import { registerMemoryRoutes } from './routes.ts';
import { MemoryService } from './service.ts';

/** What {@link installMemory} needs from the app (the route context it already built). */
export type MemoryAppContext = Pick<ApiContext, 'config' | 'store' | 'bus' | 'supervisor'> & Partial<Pick<ApiContext, 'worktrees' | 'peers' | 'accounts'>>;

const services = new WeakMap<FastifyInstance, MemoryService>();

/** The Project memory service `installMemory` gave `app` (`undefined` before). */
export function memoryServiceOf(app: FastifyInstance): MemoryService | undefined {
  return services.get(app);
}

/** The live part of a usage reading: a window's % while it has not reset (`null` otherwise). */
function livePct(pct: number | null, resetsAt: string | null, now: number): number | null {
  if (pct === null) return null;
  if (resetsAt !== null && !(Date.parse(resetsAt) > now)) return null;
  return pct;
}

/**
 * D136 · what the memory checks need of the app: the CLI command (the supervisor's registry, the
 * same binary resolution as every spawn), the account a new session would start on (D63's pick,
 * its folder variable in the environment) unless usage is paused (D103) or the account is at the
 * developer's warning level ("Warn at", `usage.warnAtPct`), the folder's newest session's CLI and
 * activity, and Insights → Usage for the tokens.
 */
export function appCheckHost(input: {
  readonly store: Store;
  readonly accounts: AccountService | null;
  readonly command: (cli: CliProviderId) => Promise<readonly string[]>;
  readonly dataDir: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
}): MemoryCheckHost {
  const { store, accounts } = input;
  return {
    workDir: input.dataDir,
    command: input.command,
    async account(manual) {
      const base = childEnv(input.baseEnv ?? process.env);
      if (!accounts) return { profileId: defaultProfileId('claude'), env: base };
      const paused = await accounts.creditsPause('claude').catch(() => false as const);
      if (paused) return { blocked: 'usage is paused: every account is out of allowance' };
      const profileId = (await accounts.pick('claude', { check: false }).catch(() => null)) ?? defaultProfileId('claude');
      const record = await store.profiles.get(profileId);
      if (record) {
        const now = Date.now();
        if (record.exhaustedUntil !== null && Date.parse(record.exhaustedUntil) > now) return { blocked: `the account ${record.name} is out of allowance until ${record.exhaustedUntil}` };
        if (!manual) {
          const usage = await accounts.usageOf(record).catch(() => null);
          const warnAt = warnAtPct(await store.settings.get(WARN_AT_KEY).catch(() => null));
          const peak = Math.max(livePct(usage?.fiveHourPct ?? null, usage?.fiveHourResetsAt ?? null, now) ?? -1, livePct(usage?.sevenDayPct ?? null, usage?.sevenDayResetsAt ?? null, now) ?? -1);
          if (peak >= warnAt) return { blocked: `the account ${record.name} is at ${Math.round(peak)}% of its limit (the warning level is ${warnAt}%)` };
        }
      }
      return { profileId, env: { ...base, ...(await accounts.envFor(profileId, 'claude')) } };
    },
    async folderCli(folder) {
      const row = store.db
        .prepare("SELECT provider FROM sessions WHERE kind <> 'chat' AND COALESCE(root, cwd) = ? ORDER BY COALESCE(last_activity_at, created_at) DESC LIMIT 1")
        .get(folder) as { provider?: unknown } | undefined;
      const provider = row?.provider;
      return provider === 'claude' || provider === 'codex' || provider === 'opencode' ? provider : null;
    },
    async lastActivity(folder) {
      const row = store.db.prepare("SELECT MAX(last_activity_at) AS at FROM sessions WHERE kind <> 'chat' AND COALESCE(root, cwd) = ?").get(folder) as { at?: unknown } | undefined;
      return typeof row?.at === 'string' ? row.at : null;
    },
    recordUsage(row) {
      for (const tokens of row.tokens) {
        store.insights.recordBackgroundTurn({
          ts: row.ts,
          kind: 'memory-check',
          provider: row.provider,
          model: tokens.model,
          profileId: row.profileId,
          folder: row.folder,
          input: tokens.input,
          output: tokens.output,
          cacheWrite: tokens.cacheWrite,
          cacheRead: tokens.cacheRead,
          durationMs: row.durationMs,
        });
      }
    },
  };
}

/**
 * D107 · the one place `app.ts` wires Project memory in (`docs/memory-removal.md`): the service
 * (started when the app is ready: it reads the switch and opens `memory.db` only while on), its
 * routes and its close. D136: outside demo mode, with the memory checks.
 */
export async function installMemory(app: FastifyInstance, context: MemoryAppContext): Promise<MemoryService> {
  const registry = context.supervisor.cliRegistry;
  const memory = new MemoryService({
    dataDir: context.config.dataDir,
    store: context.store,
    bus: context.bus,
    supervisor: context.supervisor,
    // D107 follow-up 2026-10-15: the shared repo set (repo scope) and the paired machines (a moved member's memory).
    ...(context.worktrees ? { repos: context.worktrees.repos } : {}),
    ...(context.peers ? { peers: context.peers } : {}),
    // D136: demo mode never runs memory checks.
    ...(context.config.demo
      ? {}
      : {
          check: {
            runner: claudeCheckRunner({ extraArgs: context.config.claudeExtraArgs }),
            host: appCheckHost({ store: context.store, accounts: context.accounts ?? null, command: (cli) => registry.command(cli), dataDir: context.config.dataDir }),
          },
        }),
  });
  app.addHook('onReady', async () => {
    // Demo mode never runs Project memory (the visual oracle is unchanged), except in the v2 layer (`demoV2`, docs/demo.md).
    if (!context.config.demo || context.config.demoV2) await memory.start();
  });
  app.addHook('preClose', async () => {
    await memory.close();
  });
  services.set(app, memory);
  await registerMemoryRoutes(app, memory);
  return memory;
}
