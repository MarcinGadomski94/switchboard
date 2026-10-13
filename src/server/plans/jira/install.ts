import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../../db/database.ts';
import { defaultSecretStore } from '../../team/access/secret-store.ts';
import { PLANS_DB_FILE } from '../db.ts';
import type { PlansAppContext } from '../install.ts';
import type { PlanService } from '../service.ts';
import { JiraCredentialSource, type JiraSecretStore } from './credentials.ts';
import { registerPlanJiraRoutes } from './routes.ts';
import { PlanJiraService } from './service.ts';
import { PlanJiraStore } from './store.ts';

/** Options of {@link installPlansJira} (tests). */
export interface PlansJiraOptions {
  /** The OS keychain for Settings → Integrations → Jira (default: the Team access lane's `defaultSecretStore()`, in-memory under tests). */
  readonly secretStore?: JiraSecretStore | null;
  /**
   * Where `ATL_BASE_URL` / `ATL_USER` / `ATL_TOKEN` are read (default `process.env`, but never
   * under Vitest: an in-process test must not pick up the developer's own Jira).
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The HTTP client Jira is called with (default the global `fetch`). */
  readonly fetch?: typeof fetch;
  /** The refresh interval (tests). */
  readonly refreshMs?: number;
}

/**
 * D99 · Plans · Jira: the lane's one entry point, called by Plans' own `install.ts` (so it
 * goes with `src/server/plans/` on removal, `docs/plans-removal.md`). Its tables live in
 * `plans.db` (its own connection, opened on first use while Plans is on and closed when Plans
 * is seen off); its routes answer 404 `plans-off` while Plans is off; it follows the plans
 * (`planChanged`) and refreshes every 30 min once the app is ready. Answers the service (tests).
 */
export async function installPlansJira(app: FastifyInstance, context: PlansAppContext, plans: PlanService, options: PlansJiraOptions = {}): Promise<PlanJiraService> {
  let connection: DatabaseSync | null = null;
  let store: PlanJiraStore | null = null;
  let opening: Promise<PlanJiraStore> | null = null;
  const db = (): Promise<PlanJiraStore> => {
    if (store) return Promise.resolve(store);
    opening ??= openDatabase(path.join(context.config.dataDir, PLANS_DB_FILE))
      .then((opened) => {
        connection = opened;
        store = new PlanJiraStore(opened);
        return store;
      })
      .finally(() => {
        opening = null;
      });
    return opening;
  };
  const release = (): void => {
    connection?.close();
    connection = null;
    store = null;
  };
  const enabled = (): boolean => plans.state().available;
  const env = options.env ?? (process.env['VITEST'] ? {} : process.env);
  const credentials = new JiraCredentialSource({ env, store: options.secretStore === undefined ? defaultSecretStore() : options.secretStore });
  const service = new PlanJiraService({
    store: context.store,
    plans,
    todos: context.todos,
    bus: context.bus,
    db,
    release,
    credentials,
    enabled,
    // The ask for the missing order goes the normal way: a hooked session's mailbox, else the supervisor (queued while it works).
    send: async (sessionId, text) => {
      if (await context.hooks.isHooked(sessionId)) await context.hooks.sendMessage(sessionId, text);
      else await context.supervisor.sendMessage(sessionId, text, 'service');
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.refreshMs ? { refreshMs: options.refreshMs } : {}),
  });
  await registerPlanJiraRoutes(app, service, credentials, enabled);
  app.addHook('onReady', async () => {
    if (!context.config.demo) service.start();
  });
  app.addHook('preClose', async () => {
    await service.close();
    release();
  });
  return service;
}
