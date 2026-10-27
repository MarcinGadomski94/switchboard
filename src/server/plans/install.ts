import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { planEnvironment } from './environment.ts';
import { PlanGit } from './git.ts';
import { registerPlanRoutes } from './routes.ts';
import { PlanService, pickReposTimeoutFromEnv, stoppedGraceFromEnv } from './service.ts';
import { installPlansJira } from './jira/install.ts';
import { ciSettingsOf } from '../settings/settings.ts';

/** What {@link installPlans} needs from the app (the route context it already built). */
export type PlansAppContext = Pick<ApiContext, 'config' | 'store' | 'bus' | 'todos' | 'providers' | 'supervisor' | 'worktrees' | 'folders' | 'attachments' | 'clis' | 'accounts' | 'systemItems' | 'hooks' | 'peers' | 'ci' | 'accountChoice'>;

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
      // D130: a Start's runs' subfolder syncs like a manual move (D71).
      sidebarSynced: (changes) => context.peers.sidebarChanged(changes),
      git: new PlanGit({ gh: context.config.ghCommand, prs: (repoPath, branch) => context.ci.read(repoPath, branch) }),
      // D115 follow-ups: test servers shorten the "not picked in time" wait (`SWITCHBOARD_PLAN_PICK_REPOS_MS`, docs/configuration.md).
      ...(pickReposTimeoutFromEnv() !== null ? { pickReposTimeoutMs: pickReposTimeoutFromEnv() as number } : {}),
      // D120: test servers shorten the grace period before an item shows stopped (`SWITCHBOARD_PLAN_STOPPED_GRACE_MS`, docs/configuration.md).
      ...(stoppedGraceFromEnv() !== null ? { stoppedGraceMs: stoppedGraceFromEnv() as number } : {}),
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
        // D138: a Project's sessions follow its accounts.
        ...(context.accountChoice ? { applyProjectAccounts: async (planId: string) => void (await context.accountChoice?.applyProject(planId)) } : {}),
      }),
    });
    app.addHook('onReady', async () => {
      // Demo mode never runs Plans, except for the README screenshots (`demoExtras`) and the v2 layer (`demoV2`, docs/demo.md).
      if (!context.config.demo || context.config.demoExtras || context.config.demoV2) await own.start();
    });
    app.addHook('preClose', async () => {
      await own.close();
    });
    plans = own;
  }
  services.set(app, plans);
  // D138: which Project a session belongs to, for the account choice's precedence (Plans hook).
  const service = plans;
  context.accountChoice?.useProjects({ ofSession: (sessionId) => service.accountsOfSession(sessionId), sessionsOf: (planId) => service.accountSessions(planId) });
  app.addHook('onClose', async () => {
    context.accountChoice?.useProjects(null);
  });
  await registerPlanRoutes(app, plans, context);
  // D99-Jira: the Jira import and status sync (src/server/plans/jira/; its routes answer plans-unavailable while plans.db is broken).
  await installPlansJira(app, context, plans);
  return plans;
}
