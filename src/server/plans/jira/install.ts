import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../../db/database.ts';
import type { ApiContext } from '../../routes.ts';
import { JiraCredentialSource, type JiraSecretStore } from './credentials.ts';
import { registerPlanJiraRoutes } from './routes.ts';
import { PlanJiraService } from './service.ts';
import { PlanJiraStore } from './store.ts';

/** Plans' own database file (`docs/plans.md` → *Storage*). */
export const PLANS_DB_FILE = 'plans.db';

/** Options of {@link installPlansJira}. */
export interface PlansJiraOptions {
  /** Whether Plans is on (Settings → Experimental → Plans). */
  readonly enabled: () => boolean | Promise<boolean>;
  /** The OS keychain for Settings → Integrations → Jira; `null` = environment only. */
  readonly secretStore: JiraSecretStore | null;
  /**
   * Where `ATL_BASE_URL` / `ATL_USER` / `ATL_TOKEN` are read (default `process.env`, but never
   * under Vitest: an in-process test must not pick up the developer's own Jira).
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The HTTP client Jira is called with (default the global `fetch`). */
  readonly fetch?: typeof fetch;
  /** An open `plans.db` connection; without one, `<dataDir>/plans.db` is opened (and closed with the app). */
  readonly db?: DatabaseSync;
  /** The refresh interval (tests). */
  readonly refreshMs?: number;
}

/**
 * D99 · Plans · Jira: the lane's one entry point (`docs/plans-removal.md`). Opens its tables in
 * `plans.db`, registers its routes, follows the plans (`planChanged`) once the app is ready,
 * and stops with it. Answers the service (tests).
 */
export async function installPlansJira(app: FastifyInstance, context: ApiContext, options: PlansJiraOptions): Promise<PlanJiraService> {
  let db = options.db ?? null;
  let own: DatabaseSync | null = null;
  if (!db) {
    own = await openDatabase(path.join(context.config.dataDir, PLANS_DB_FILE));
    db = own;
  }
  const env = options.env ?? (process.env['VITEST'] ? {} : process.env);
  const credentials = new JiraCredentialSource({ env, store: options.secretStore });
  const service = new PlanJiraService({
    store: context.store,
    plans: context.plans,
    todos: context.todos,
    bus: context.bus,
    db: new PlanJiraStore(db),
    credentials,
    enabled: options.enabled,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.refreshMs ? { refreshMs: options.refreshMs } : {}),
  });
  await registerPlanJiraRoutes(app, service, credentials, options.enabled);
  app.addHook('onReady', async () => {
    if (!context.config.demo) service.start();
  });
  app.addHook('preClose', async () => {
    await service.close();
    own?.close();
  });
  return service;
}
