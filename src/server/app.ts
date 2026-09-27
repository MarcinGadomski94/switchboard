import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.ts';
import { registerApiRoutes } from './routes.ts';
import { registerSecurity } from './security.ts';
import { registerWeb } from './web.ts';

/** Options for {@link buildApp}. */
export interface AppOptions {
  readonly config: ServerConfig;
  /** The per-install token (token.ts). */
  readonly token: string;
  /** Absolute path of the built UI, normally `<repo>/dist/web`. */
  readonly webRoot: string;
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
  await registerApiRoutes(app, { config: options.config });
  await registerWeb(app, { webRoot: options.webRoot, token: options.token });
  return app;
}
