import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { MigrationError } from './db/migrate.ts';
import { openStore, storeFile } from './db/store.ts';
import { DemoSeedError, assertDemoDataDir, startDemo } from './demo/index.ts';
import { BindRefusedError, listenLoopback } from './listen.ts';
import type { Providers } from './providers.ts';
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
    // Real providers are added here by their items (docs/lanes.md); demo mode swaps in the demo ones.
    let providers: Providers = {};
    if (config.demo) providers = (await startDemo(store, config.dataDir)).providers;
    app = await buildApp({ config, token, store, webRoot: WEB_ROOT, providers, logger: true });
    app.addHook('onClose', async () => {
      await store.close();
    });
    // Installed before listening: a signal right after "Server listening" (tests stop
    // the server immediately) must still close cleanly with exit 0.
    installShutdown(app);
    await listenLoopback(app, { port: config.port });
  } catch (error) {
    await store.close();
    throw error;
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
