import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { usageWindowLabel } from '../core/usage.ts';
import { buildApp, createCliStatus, createSessionServices, createWorktreeManager } from './app.ts';
import { ConfigError, type ServerConfig, loadConfig } from './config.ts';
import { MigrationError } from './db/migrate.ts';
import { type Store, openStore, storeFile } from './db/store.ts';
import { DemoSeedError, assertDemoDataDir, startDemo } from './demo/index.ts';
import { AttachmentService } from './attachments/service.ts';
import { FolderService } from './folders/service.ts';
import { HubBus } from './hub/bus.ts';
import { SystemItemService } from './inbox/system-items.ts';
import { BindRefusedError, listenLoopback } from './listen.ts';
import type { Providers } from './providers.ts';
import { createLoginService } from './service/login-service.ts';
import { loadServiceRedirect } from './service/target.ts';
import { loadUpdateConfig } from './updates/config.ts';
import type { UpdateService } from './updates/service.ts';
import { createUpdateService } from './updates/wire.ts';
import { Scheduler, scheduleRunnerFor } from './schedules/scheduler.ts';
import { SetupService, setupWizardAutoOpen } from './setup/service.ts';
import { LiveSolutions } from './solutions/live.ts';
import { PeerService } from './peers/service.ts';
import { claudeAgentsLister, recoverSessions } from './supervisor/recovery.ts';
import type { SessionSupervisor } from './supervisor/supervisor.ts';
import { SystemProbe } from './system/probe.ts';
import { HOOK_TOKEN_FILE, loadOrCreateToken } from './token.ts';
import { HookService } from './hooks/service.ts';
import { ToolProxies, settingsProxyPorts } from './tools/proxies.ts';
import { createUsageMeter, withAccountUsage, withCliUsage, withUsage } from './usage/wire.ts';
import { loadDemoData } from './demo/data.ts';
import { createFrameHelperOpener } from './tools/frame-helper.ts';
import { demoFolderChecks } from './demo/folders.ts';
import { DeviceService } from './devices/service.ts';

/**
 * The built UI served: `<repo>/dist/web` (the Vite build output). Tests set
 * `SWITCHBOARD_WEB_ROOT` to their own build (`.e2e-dist/web`), so a test run never
 * swaps the UI of a Switchboard the developer is running from the same checkout.
 */
const WEB_ROOT = process.env['SWITCHBOARD_WEB_ROOT']?.trim()
  ? path.resolve(process.env['SWITCHBOARD_WEB_ROOT'].trim())
  : path.resolve(import.meta.dirname, '..', '..', 'dist', 'web');

async function main(): Promise<void> {
  const config = loadConfig();
  // M9.1 test redirects of the per-user service (docs/service.md); refused unless set together.
  const serviceRedirect = loadServiceRedirect();
  // D55 (docs/updates.md): the updater's variables (off, repo, test redirects).
  const updateConfig = loadUpdateConfig(process.env, { serviceRedirect: serviceRedirect !== null });
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
    const systemItems = new SystemItemService({ store, bus, worktrees, sessions: supervisor });
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
      : new ToolProxies({
          switchboardPort: config.port,
          // Each tool keeps its proxy port across restarts (its origin, and what it stores in the frame).
          ports: settingsProxyPorts(store.settings),
          onError: (error, toolId) => console.error(`switchboard tool proxy (${toolId}):`, error),
        });
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
            ...(supervisor.accounts ? { accounts: supervisor.accounts } : {}),
            onWarning: (warning) => console.warn(`switchboard usage: Max ${usageWindowLabel(warning)} at ${warning.pct}% (warning at ${warning.threshold}%)`),
            onError: (error) => console.error('switchboard usage:', error),
          });
    if (usage) providers = withUsage(providers, usage);
    // D62 P7: another CLI's own usage windows (Codex's rate limits) next to Claude Code's.
    if (!config.demo) providers = withCliUsage(providers, supervisor);
    // D63: each account profile's usage while a CLI has more than one; D66: with its windows (the footer grid's lines).
    if (!config.demo && supervisor.accounts) providers = withAccountUsage(providers, supervisor.accounts, Date.now, usage ? (id) => usage.profileWindows(id) : undefined);
    // D35 (docs/frame-helper.md → Guided setup): the setup's OS openers, in demo mode too (they run only on a click);
    // SWITCHBOARD_OPEN_COMMAND puts tests' fake opener in front of them.
    providers = { ...providers, frameHelperOpener: createFrameHelperOpener({ prefix: config.openCommand }) };
    // D55 (docs/updates.md): GitHub releases, the Inbox item and banner, and (release installs) the update + restart.
    // The restart closes this Switchboard the SIGTERM way (installShutdown below), also on Windows where there are no signals.
    let requestExit: () => void = () => undefined;
    const updates: UpdateService | null =
      config.demo || !updateConfig.enabled
        ? null
        : await createUpdateService({
            config,
            update: updateConfig,
            settings: store.settings,
            bus,
            items: systemItems,
            loginService,
            redirect: serviceRedirect,
            liveSessions: () => supervisor.liveCount,
            exit: () => requestExit(),
          });
    if (updates) providers = { ...providers, updates };
    // M7.1 (docs/schedules.md): cron runs from templates; "Retry run" of the failed-run items goes through it.
    // D62: the CLIs' status (Settings → CLIs, the forms' CLI row); scheduled runs check theirs too.
    const clis = createCliStatus(config, store, supervisor.cliRegistry);
    const scheduler = new Scheduler({ store, sessions: { store, providers, supervisor, worktrees, folders, clis }, updates: supervisor, bus, systemItems });
    systemItems.useScheduleRunner(scheduleRunnerFor(scheduler));
    // D48 (docs/peers.md): paired machines and the optional peer listener; started once the UI port is ours. The demo has none.
    const peers = new PeerService({ config, store, bus, token });
    // D48 P4 (docs/peers.md → Hooked terminal sessions): the hook token (0600) the installed hook script presents.
    const hookToken = await loadOrCreateToken(config.dataDir, HOOK_TOKEN_FILE);
    const hooks = new HookService({ config, store, bus, questions, hookTokenFile: path.join(config.dataDir, HOOK_TOKEN_FILE) });
    // D73 (docs/devices.md): paired phones / tablets, the device listener (off by default) and web push. The demo has none.
    const devices = new DeviceService({ config, store, bus, machineName: async () => (await peers.self()).name, remoteInbox: () => peers.remoteInbox() });
    app = await buildApp({ config, token, store, webRoot: WEB_ROOT, providers, supervisor, questions, worktrees, systemItems, bus, folders, setup, scheduler, peers, hooks, hookToken, clis, devices, ...(usage ? { usage } : {}), logger: true });
    // D7 / M2.4 restart recovery runs once the port is ours (a second instance that
    // cannot bind must never touch the first one's processes); session commands wait for it.
    const releaseCommands = config.demo ? null : supervisor.holdCommands();
    let recovering: Promise<void> = Promise.resolve();
    app.addHook('onClose', async () => {
      // Recovery may still be spawning; let it finish so shutdown sees every process.
      await recovering;
      // Live claude processes are stopped (their status kept for M2.4) before the database closes.
      await updates?.close();
      await devices.close();
      await peers.close();
      await hooks.close();
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
    requestExit = installShutdown(app);
    await listenLoopback(app, { port: config.port });
    // Items for failed runs / removable worktrees that have none yet, now and every 30 s
    // (docs/system-items.md); only once the port is ours. The demo seeds its own items.
    if (!config.demo) systemItems.startWatching();
    // The cron timer (M7.1), only once the port is ours; the demo's schedules never fire.
    if (!config.demo) scheduler.start();
    // D48: the peer listener (when switched on) and the connections to paired machines.
    if (!config.demo) await peers.start().catch((error: unknown) => app.log.error(error, 'peers failed to start'));
    // D73: device access (when switched on: the device listener and `tailscale serve`) and the push notifier.
    if (!config.demo) await devices.start().catch((error: unknown) => app.log.error(error, 'devices failed to start'));
    // D48 P4: the hooked sessions' transcript and liveness polls.
    if (!config.demo) hooks.start();
    // D55: check GitHub releases now and every hour.
    updates?.start();
    // Resume the sessions that were live (docs/supervisor.md → Restart recovery). The demo's sessions are not real.
    if (releaseCommands) {
      recovering = recover(app, config, store, supervisor).finally(releaseCommands);
      await recovering;
    }
    // Usage readings start once the resumed sessions are back (it reads only while a /hub client is connected).
    usage?.start();
    // D57 (ASSUMED D57-retention): attachments older than 30 days, and files of sessions that are gone, are removed.
    void new AttachmentService({ dataDir: config.dataDir, store })
      .cleanup((error) => app.log.error(error, 'attachments cleanup'))
      .then(({ removed }) => {
        if (removed > 0) app.log.info({ removed }, 'attachments cleaned up');
      });
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
    // D62 P5: a CLI switch the restart cut short is over (failed); the session runs on whichever CLI it was stored on.
    for (const running of await store.providers.runningSwitches()) {
      await store.providers.updateSwitch(running.id, { status: 'failed', error: 'Switchboard stopped during the switch', finishedAt: new Date().toISOString() });
    }
  } catch (error) {
    app.log.error(error, 'restart recovery failed');
  }
}

/**
 * SIGINT / SIGTERM close the app (and the database with it), then exit 0.
 * @returns the same shutdown, for D55's restart after an update.
 */
function installShutdown(app: FastifyInstance): () => void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals | 'update'): void => {
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
  return () => shutdown('update');
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof BindRefusedError || error instanceof MigrationError || error instanceof DemoSeedError) {
    console.error(`switchboard: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
