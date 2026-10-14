import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { planEnvironment } from './environment.ts';
import { PlanGit } from './git.ts';
import { registerPlanRoutes } from './routes.ts';
import { PlanService } from './service.ts';
import { installPlansJira } from './jira/install.ts';
import { ciSettingsOf } from '../settings/settings.ts';

/** What {@link installPlans} needs from the app (the route context it already built). */
export type PlansAppContext = Pick<ApiContext, 'config' | 'store' | 'bus' | 'todos' | 'providers' | 'supervisor' | 'worktrees' | 'folders' | 'attachments' | 'clis' | 'accounts' | 'systemItems' | 'hooks' | 'peers' | 'ci'>;

/** The Plans service of an app (tests). */
const services = new WeakMap<FastifyInstance, PlanService>();

/** The Plans service `installPlans` gave `app` (`undefined` before). */
export function planServiceOf(app: FastifyInstance): PlanService | undefined {
  return services.get(app);
}

/**
 * D99 · the one place `app.ts` wires Plans in (`docs/plans-removal.md`): the service (started
 * when the app is ready: it reads the switch, and opens `plans.db` and starts the scheduler only
 * while Plans is on), its routes, and its close. A `given` service (tests) is the caller's to
 * start and close.
 */
export async function installPlans(app: FastifyInstance, context: PlansAppContext, given?: PlanService): Promise<PlanService> {
  let plans = given;
  if (!plans) {
    const own = new PlanService({
      dataDir: context.config.dataDir,
      store: context.store,
      bus: context.bus,
      todos: context.todos,
      // D109: the items' PRs are read through the shared PR watcher.
      git: new PlanGit({ gh: context.config.ghCommand, prs: (repoPath, branch) => context.ci.read(repoPath, branch) }),
      env: planEnvironment({
        context: { store: context.store, providers: context.providers, supervisor: context.supervisor, worktrees: context.worktrees, folders: context.folders, todos: context.todos, attachments: context.attachments, clis: context.clis },
        accounts: context.accounts,
        systemItems: context.systemItems,
        send: async (sessionId, text) => {
          if (await context.hooks.isHooked(sessionId)) await context.hooks.sendMessage(sessionId, text);
          else await context.supervisor.sendMessage(sessionId, text, 'service');
        },
        // D109: the shared PR watcher sends red checks itself while its setting is on.
        ciSendsFailures: async () => (await ciSettingsOf(context.store.settings))['ci.sendFailures'],
        prOpened: async (sessionId) => {
          for (const worktree of await context.store.worktrees.list({ sessionId })) await context.ci.watchSoon(worktree.id);
        },
      }),
    });
    app.addHook('onReady', async () => {
      // Demo mode never runs Plans, except for the README screenshots (`demoExtras`).
      if (!context.config.demo || context.config.demoExtras) await own.start();
    });
    app.addHook('preClose', async () => {
      await own.close();
    });
    plans = own;
  }
  services.set(app, plans);
  await registerPlanRoutes(app, plans, context);
  // D99-Jira: the Jira import and status sync (src/server/plans/jira/; its routes answer plans-off while Plans is off).
  await installPlansJira(app, context, plans);
  return plans;
}
