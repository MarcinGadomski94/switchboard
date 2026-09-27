import path from 'node:path';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { BindRefusedError, listenLoopback } from './listen.ts';
import { loadOrCreateToken } from './token.ts';

/** `<repo>/dist/web`, the Vite build output served as the UI. */
const WEB_ROOT = path.resolve(import.meta.dirname, '..', '..', 'dist', 'web');

async function main(): Promise<void> {
  const config = loadConfig();
  const token = await loadOrCreateToken(config.dataDir);
  const app = await buildApp({ config, token, webRoot: WEB_ROOT, logger: true });
  await listenLoopback(app, { port: config.port });

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
  if (error instanceof ConfigError || error instanceof BindRefusedError) {
    console.error(`switchboard: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
