import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, createSupervisor, createWorktreeManager } from './app.ts';
import { ConfigError, type ServerConfig, loadConfig } from './config.ts';
import { MigrationError } from './db/migrate.ts';
import { type Store, openStore, storeFile } from './db/store.ts';
import { DemoSeedError, assertDemoDataDir, startDemo } from './demo/index.ts';
import { HubBus } from './hub/bus.ts';
import { BindRefusedError, listenLoopback } from './listen.ts';
import type { Providers } from './providers.ts';
import { WorkspaceScanner } from './solutions/scanner.ts';
import { claudeAgentsLister, recoverSessions } from './supervisor/recovery.ts';
import type { SessionSupervisor } from './supervisor/supervisor.ts';
import { loadOrCreateToken } from './token.ts';

/** `<repo>/dist/web`, the Vite build output served as the UI. */
const WEB_ROOT = path.resolve(import.meta.dirname, '..', '..', 'dist', 'web');

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.demo) assertDemoDataDir(config.dataDir);
  const token = await loadOrCreateToken(config.dataDir);
  const store = await openStore(storeFile(config.dataDir));
  let app: FastifyInstance;
  try {
    const supervisor = createSupervisor(config, store);
    const worktrees = createWorktreeManager(config, store, supervisor);
    // `/hub` events (docs/hub.md): services created here that publish take this bus.
    const bus = new HubBus();
    // Real providers are added here by their items (docs/lanes.md); demo mode swaps in the demo ones.
    let providers: Providers = { diff: worktrees, solutions: new WorkspaceScanner({ workspaceRoot: config.workspaceRoot }) };
    if (config.demo) providers = (await startDemo(store, config.dataDir)).providers;
    // PR state of the registered worktrees (gh pr view); the demo's worktrees are not real.
    else worktrees.startPolling();
    app = await buildApp({ config, token, store, webRoot: WEB_ROOT, providers, supervisor, worktrees, bus, logger: true });
    // D7 / M2.4 restart recovery runs once the port is ours (a second instance that
    // cannot bind must never touch the first one's processes); session commands wait for it.
    const releaseCommands = config.demo ? null : supervisor.holdCommands();
    let recovering: Promise<void> = Promise.resolve();
    app.addHook('onClose', async () => {
      // Recovery may still be spawning; let it finish so shutdown sees every process.
      await recovering;
      // Live claude processes are stopped (their status kept for M2.4) before the database closes.
      await worktrees.stopPolling();
      await supervisor.shutdown();
      await store.close();
    });
    // Installed before listening: a signal right after "Server listening" (tests stop
    // the server immediately) must still close cleanly with exit 0.
    installShutdown(app);
    await listenLoopback(app, { port: config.port });
    // Resume the sessions that were live (docs/supervisor.md → Restart recovery). The demo's sessions are not real.
    if (releaseCommands) {
      recovering = recover(app, config, store, supervisor).finally(releaseCommands);
      await recovering;
    }
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
      listLive: claudeAgentsLister({ claudeCommand: config.claudeCommand, workspaceRoot: config.workspaceRoot }),
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
