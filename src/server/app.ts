import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.ts';
import type { Store } from './db/store.ts';
import type { Providers } from './providers.ts';
import { registerApiRoutes } from './routes.ts';
import { registerSecurity } from './security.ts';
import { SessionSupervisor } from './supervisor/supervisor.ts';
import { registerWeb } from './web.ts';

/** Options for {@link buildApp}. */
export interface AppOptions {
  readonly config: ServerConfig;
  /** The per-install token (token.ts). */
  readonly token: string;
  /** The opened database (db/store.ts); the caller owns it and closes it after the app. */
  readonly store: Store;
  /** Absolute path of the built UI, normally `<repo>/dist/web`. */
  readonly webRoot: string;
  /** Computed data sources (providers.ts); none by default. */
  readonly providers?: Providers;
  /**
   * The claude process supervisor (M2.1). The caller owns one it passes in (and
   * shuts it down before closing the store); without one the app makes its own from
   * `config` and shuts it down when it closes.
   */
  readonly supervisor?: SessionSupervisor;
  /** Fastify logger; off by default (tests). */
  readonly logger?: boolean;
}

/**
 * Builds the Fastify app without listening: the security guard first, then the
 * API routes, then the UI. Tests drive it with `inject()`; main.ts listens
 * through `listenLoopback`.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, trustProxy: false });
  registerSecurity(app, { port: options.config.port, token: options.token });
  let supervisor = options.supervisor;
  if (!supervisor) {
    const own = createSupervisor(options.config, options.store);
    app.addHook('onClose', async () => {
      await own.shutdown();
    });
    supervisor = own;
  }
  await registerApiRoutes(app, { config: options.config, store: options.store, providers: options.providers ?? {}, supervisor });
  await registerWeb(app, { webRoot: options.webRoot, token: options.token });
  return app;
}

/** A supervisor for the configured CLI command, extra args and workspace root. */
export function createSupervisor(config: ServerConfig, store: Store): SessionSupervisor {
  return new SessionSupervisor({
    store,
    claudeCommand: config.claudeCommand,
    claudeExtraArgs: config.claudeExtraArgs,
    workspaceRoot: config.workspaceRoot,
  });
}
