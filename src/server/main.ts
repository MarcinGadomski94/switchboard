import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { MigrationError } from './db/migrate.ts';
import { openStore, storeFile } from './db/store.ts';
import { BindRefusedError, listenLoopback } from './listen.ts';
import { loadOrCreateToken } from './token.ts';

/** `<repo>/dist/web`, the Vite build output served as the UI. */
const WEB_ROOT = path.resolve(import.meta.dirname, '..', '..', 'dist', 'web');

async function main(): Promise<void> {
  const config = loadConfig();
  const token = await loadOrCreateToken(config.dataDir);
  const store = await openStore(storeFile(config.dataDir));
  let app: FastifyInstance;
  try {
    app = await buildApp({ config, token, store, webRoot: WEB_ROOT, logger: true });
    app.addHook('onClose', async () => {
      await store.close();
    });
    await listenLoopback(app, { port: config.port });
  } catch (error) {
    await store.close();
    throw error;
  }

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
  if (error instanceof ConfigError || error instanceof BindRefusedError || error instanceof MigrationError) {
    console.error(`switchboard: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
