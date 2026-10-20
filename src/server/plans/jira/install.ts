import { rm } from 'node:fs/promises';
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
import { JiraClient, JiraError } from './client.ts';
import { adfToText } from '../../../core/plans-jira.ts';
import { registerJiraIssueSource } from '../../todos/import.ts';
import { resolveSessionFolder, startNewSession } from '../../sessions/start.ts';
import { toSession } from '../../sessions/wire.ts';
import { WorktreeError } from '../../worktrees/manager.ts';
import type { PlanOwnerPlace, PlanOwnerRefusal, PlanOwnerSessions } from './service.ts';

/** The Jira lane's service of an app (tests). */
const services = new WeakMap<FastifyInstance, PlanJiraService>();

/** The Jira lane's service `installPlansJira` gave `app` (`undefined` before; tests). */
export function planJiraServiceOf(app: FastifyInstance): PlanJiraService | undefined {
  return services.get(app);
}

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
    newSession: planOwnerSessions(context),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.refreshMs ? { refreshMs: options.refreshMs } : {}),
  });
  services.set(app, service);
  // D118: a Jira plan's runs and asks get its Jira context, read from Jira when they are sent.
  const offContext = plans.setContextSource({ itemContext: (input) => service.itemContext(input), askContext: (planId) => service.askContext(planId) });
  await registerPlanJiraRoutes(app, service, credentials, enabled, async (sessionId) => {
    const record = await context.store.sessions.get(sessionId);
    return record ? toSession(context.store, record, context.supervisor.activity(record.id)) : null;
  });
  app.addHook('onReady', async () => {
    if (!context.config.demo) service.start();
  });
  // D109: the todo import's Jira issues come through this lane's one Jira connection (Plans on or off;
  // the connection's settings row is in Settings → Experimental → Plans). Credentials never leave the client.
  const offImport = registerJiraIssueSource(context.store, {
    status: async () => {
      const found = await credentials.resolve();
      return found ? { available: true, problem: null } : { available: false, problem: 'Jira is not connected: switch Plans on in Settings → Experimental and fill in its Jira connection (or set ATL_BASE_URL, ATL_USER and ATL_TOKEN)' };
    },
    search: async (jql, max) => {
      const found = await credentials.resolve();
      if (!found) throw new Error('Jira is not connected');
      const client = new JiraClient(found.credentials, options.fetch ? { fetch: options.fetch } : {});
      try {
        const answer = await client.search(jql, ['summary', 'description', 'status'], max);
        return {
          truncated: answer.truncated,
          issues: answer.issues.map((issue) => ({
            key: issue.key,
            title: typeof issue.fields['summary'] === 'string' ? issue.fields['summary'] : issue.key,
            url: `${client.baseUrl}/browse/${encodeURIComponent(issue.key)}`,
            body: adfToText(issue.fields['description']),
          })),
        };
      } catch (error) {
        throw new Error(error instanceof JiraError ? error.message : 'Jira could not be read');
      }
    },
  });
  app.addHook('preClose', async () => {
    offImport();
    offContext();
    await service.close();
    release();
  });
  return service;
}

/**
 * D112 · the sessions an import from a folder creates: checked with the New-session form's
 * folder rules, started through `POST /api/sessions`' own path ({@link startNewSession}) as a
 * Simple start with no message (its CLI starts and waits, idle, like any New session without a
 * first message), with a workspace's chosen repos as its solutions; discarded (closed, then
 * deleted with its attachments and exports, like a deleted chat) when the import then fails.
 */
export function planOwnerSessions(context: PlansAppContext): PlanOwnerSessions {
  const refusal = (status: number, error: string, message: string, field?: string): PlanOwnerRefusal => ({
    ok: false,
    status,
    body: field ? { error, message, errors: [{ field, message }] } : { error, message },
  });
  const folderOf = async (place: PlanOwnerPlace) => resolveSessionFolder(context, { folder: place.folder });
  return {
    async check(place) {
      const resolved = await folderOf(place);
      if (!resolved.ok) return { ok: false, status: resolved.status, body: resolved.body as PlanOwnerRefusal['body'] };
      const { folder } = resolved;
      if (folder.kind === 'repo') return { ok: true, kind: 'repo' };
      if (folder.kind !== 'workspace') return refusal(409, 'not-a-repo', 'the folder is not a git repository or a workspace: a plan merges into a target branch, which needs one', 'folder');
      // D115: repos are optional: without them the plan's agent picks each item's repositories.
      const repos = place.repos ?? [];
      for (const name of repos) {
        try {
          await context.worktrees.resolveRepo(name, folder);
        } catch (error) {
          if (error instanceof WorktreeError) return refusal(422, 'invalid', `${name} is not a solution repository of this workspace: ${error.message}`, 'repos');
          throw error;
        }
      }
      return { ok: true, kind: 'workspace' };
    },
    async start(place, naming) {
      const body = {
        simple: true,
        name: naming.name,
        title: naming.title,
        task: '',
        worktrees: false,
        ultracode: false,
        ...(place.folder !== null ? { folder: place.folder } : {}),
        ...(place.provider !== undefined && place.provider !== null ? { provider: place.provider } : {}),
        ...(place.model !== undefined ? { model: place.model } : {}),
        ...(place.effort !== undefined ? { effort: place.effort } : {}),
        ...(place.profileId !== undefined && place.profileId !== null ? { profileId: place.profileId } : {}),
      };
      const repos = place.repos ?? [];
      const outcome = await startNewSession(context, body, {
        // A Simple start in a workspace names no solutions; the plan's repos become the session's (D38: they would fill in from its agents' work anyway).
        beforeSpawn: async (session) => {
          if (session.rootKind === 'workspace' && repos.length > 0) await context.store.sessions.update(session.id, { solutions: [...repos] });
        },
      });
      if (!outcome.ok) return { ok: false, status: outcome.status, body: outcome.body as PlanOwnerRefusal['body'] };
      return { ok: true, sessionId: outcome.record.id };
    },
    async nameTaken(name) {
      return (await context.store.sessions.getByName(name)) !== null;
    },
    async discard(sessionId) {
      const record = await context.store.sessions.get(sessionId);
      if (!record) return;
      if (record.closedAt === null) await context.supervisor.close(sessionId, { confirm: true });
      await context.store.sessions.delete(sessionId);
      for (const dir of ['attachments', 'handovers']) await rm(path.join(context.config.dataDir, dir, sessionId), { recursive: true, force: true });
    },
  };
}
