import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { USAGE_WINDOW_LABELS } from '../core/usage.ts';
import { buildApp, createSessionServices, createWorktreeManager } from './app.ts';
import { ConfigError, type ServerConfig, loadConfig } from './config.ts';
import { MigrationError } from './db/migrate.ts';
import { type Store, openStore, storeFile } from './db/store.ts';
import { DemoSeedError, assertDemoDataDir, startDemo } from './demo/index.ts';
import { FolderService } from './folders/service.ts';
import { HubBus } from './hub/bus.ts';
import { SystemItemService } from './inbox/system-items.ts';
import { BindRefusedError, listenLoopback } from './listen.ts';
import type { Providers } from './providers.ts';
import { createLoginService } from './service/login-service.ts';
import { loadServiceRedirect } from './service/target.ts';
import { Scheduler, scheduleRunnerFor } from './schedules/scheduler.ts';
import { SetupService, setupWizardAutoOpen } from './setup/service.ts';
import { LiveSolutions } from './solutions/live.ts';
import { claudeAgentsLister, recoverSessions } from './supervisor/recovery.ts';
import type { SessionSupervisor } from './supervisor/supervisor.ts';
import { SystemProbe } from './system/probe.ts';
import { loadOrCreateToken } from './token.ts';
import { ToolProxies } from './tools/proxies.ts';
import { createUsageMeter, withUsage } from './usage/wire.ts';
import { loadDemoData } from './demo/data.ts';
import { demoFolderChecks } from './demo/folders.ts';

/** `<repo>/dist/web`, the Vite build output served as the UI. */
const WEB_ROOT = path.resolve(import.meta.dirname, '..', '..', 'dist', 'web');

async function main(): Promise<void> {
  const config = loadConfig();
  // M9.1 test redirects of the per-user service (docs/service.md); refused unless set together.
  const serviceRedirect = loadServiceRedirect();
  if (config.demo) assertDemoDataDir(config.dataDir);
  const token = await loadOrCreateToken(config.dataDir);
  const store = await openStore(storeFile(config.dataDir));
  let app: FastifyInstance;
  try {
    // D14 (docs/folders.md): no workspace root. The saved folders (reconciled with the disk
    // here) say where each session, scan and schedule works; the wizard only offers to add one.
    // Demo mode answers the check of its own (prototype) folder, which is not on this machine.
    const folders = await FolderService.open({ store, ...(config.demo ? { knownChecks: demoFolderChecks(await loadDemoData()) } : {}) });
    const setup = new SetupService({ store, folders, autoOpen: setupWizardAutoOpen() });
    // `/hub` events (docs/hub.md): services created here that publish take this bus.
    const bus = new HubBus();
    // The question pipeline (M3.1) is the supervisor's control-request handler, so it
    // also hears about requests a crash left open (restart recovery below).
    const { supervisor, questions } = createSessionServices(config, store, bus);
    const worktrees = createWorktreeManager(config, store, supervisor);
    // System Inbox items (M3.3): "PR merged" from the manager's worktreeRemovable, "Scheduled run failed" from schedule_runs.
    const systemItems = new SystemItemService({ store, bus, worktrees });
    // Real providers are added here by their items (docs/lanes.md); demo mode swaps in the demo ones.
    // Solutions of one folder at a time (a scanner per workspace folder); sessions' solutions resolve in their own folders.
    const solutions = new LiveSolutions({
      store,
      diff: worktrees,
      resolveRepo: (solution, folder) => worktrees.resolveRepo(solution, folder),
      onError: (error) => console.error('switchboard solutions:', error),
    });
    // "Start at login" (M9.1): the per-user service definition of this OS (docs/service.md).
    const loginService = createLoginService({ config, settings: store.settings, redirect: serviceRedirect });
    // CLI / gh sign-in + machine metrics (M5.3, gap #11) through the configured commands.
    const system = new SystemProbe({ claudeCommand: config.claudeCommand, ghCommand: config.ghCommand, cwd: config.dataDir, processCount: () => supervisor.liveCount });
    // D15 (docs/tools.md → Framing proxy): each tool with a URL behind its own loopback framing proxy; the demo runs none.
    const toolProxies = config.demo
      ? null
      : new ToolProxies({ switchboardPort: config.port, onError: (error, toolId) => console.error(`switchboard tool proxy (${toolId}):`, error) });
    let providers: Providers = { diff: worktrees, solutions, system, loginService, ...(toolProxies ? { toolFrames: toolProxies } : {}) };
    if (config.demo) providers = (await startDemo(store, config.dataDir)).providers;
    // PR state of the registered worktrees (gh pr view); the demo's worktrees are not real.
    else worktrees.startPolling();
    // Max usage meter (M9.2, docs/usage.md): usagePct + warnings on providers.system, so on
    // GET /api/system and the `system` hub event. Normal runs only (the demo's usage is prototype
    // data), and only with a system provider to report through (M5.3's SystemProbe).
    const usage =
      config.demo || !providers.system
        ? null
        : createUsageMeter({
            config,
            store,
            sessions: supervisor,
            onWarning: (warning) => console.warn(`switchboard usage: Max ${USAGE_WINDOW_LABELS[warning.window]} at ${warning.pct}% (warning at ${warning.threshold}%)`),
            onError: (error) => console.error('switchboard usage:', error),
          });
    if (usage) providers = withUsage(providers, usage);
    // M7.1 (docs/schedules.md): cron runs from templates; "Retry run" of the failed-run items goes through it.
    const scheduler = new Scheduler({ store, sessions: { store, providers, supervisor, worktrees, folders }, updates: supervisor, bus, systemItems });
    systemItems.useScheduleRunner(scheduleRunnerFor(scheduler));
    app = await buildApp({ config, token, store, webRoot: WEB_ROOT, providers, supervisor, questions, worktrees, systemItems, bus, folders, setup, scheduler, ...(usage ? { usage } : {}), logger: true });
    // D7 / M2.4 restart recovery runs once the port is ours (a second instance that
    // cannot bind must never touch the first one's processes); session commands wait for it.
    const releaseCommands = config.demo ? null : supervisor.holdCommands();
    let recovering: Promise<void> = Promise.resolve();
    app.addHook('onClose', async () => {
      // Recovery may still be spawning; let it finish so shutdown sees every process.
      await recovering;
      // Live claude processes are stopped (their status kept for M2.4) before the database closes.
      await worktrees.stopPolling();
      await scheduler.close();
      await systemItems.close();
      await usage?.stop();
      await toolProxies?.close();
      await supervisor.shutdown();
      await store.close();
    });
    // The saved tools' framing proxies, before the first request can ask for a `frameUrl`.
    await toolProxies?.sync(await store.tools.list());
    // Installed before listening: a signal right after "Server listening" (tests stop
    // the server immediately) must still close cleanly with exit 0.
    installShutdown(app);
    await listenLoopback(app, { port: config.port });
    // Items for failed runs / removable worktrees that have none yet, now and every 30 s
    // (docs/system-items.md); only once the port is ours. The demo seeds its own items.
    if (!config.demo) systemItems.startWatching();
    // The cron timer (M7.1), only once the port is ours; the demo's schedules never fire.
    if (!config.demo) scheduler.start();
    // Resume the sessions that were live (docs/supervisor.md → Restart recovery). The demo's sessions are not real.
    if (releaseCommands) {
      recovering = recover(app, config, store, supervisor).finally(releaseCommands);
      await recovering;
    }
    // Usage readings start once the resumed sessions are back (it reads only while a /hub client is connected).
    usage?.start();
  } catch (error) {
    await store.close();
    throw error;
  }
}

/** Restart recovery; a failure is logged and the service starts anyway. */
async function recover(
  app: FastifyInstance,
  config: ServerConfig,
  store: Store,
  supervisor: SessionSupervisor,
): Promise<void> {
  try {
    const report = await recoverSessions({
      store,
      supervisor,
      // D14: asked once per session cwd (sessions run in their own folders).
      listLive: claudeAgentsLister({ claudeCommand: config.claudeCommand }),
      onError: (error) => app.log.error(error),
    });
    if (report.sessions.length > 0) app.log.info({ recovery: report.sessions }, 'restart recovery');
  } catch (error) {
    app.log.error(error, 'restart recovery failed');
  }
}

/** SIGINT / SIGTERM close the app (and the database with it), then exit 0. */
function installShutdown(app: FastifyInstance): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error(error);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof BindRefusedError || error instanceof MigrationError || error instanceof DemoSeedError) {
    console.error(`switchboard: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
