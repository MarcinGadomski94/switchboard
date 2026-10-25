import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { startNewSession } from '../sessions/start.ts';
import { registerAccessRoutes } from './access/routes.ts';
import { registerTeamRoutes } from './routes.ts';
import { TeamService } from './service.ts';

/** What {@link installTeam} needs from the app (the route context it already built). */
export type TeamAppContext = Pick<ApiContext, 'config' | 'store' | 'bus' | 'supervisor' | 'loops' | 'todos' | 'peers' | 'takeoverRunner' | 'hooks' | 'providers' | 'worktrees' | 'folders' | 'attachments' | 'clis'>;

/** The Team service of an app (tests: its access part's in-memory keychain, `receive`). */
const services = new WeakMap<FastifyInstance, TeamService>();

/** The Team service `installTeam` gave `app` (`undefined` before). */
export function teamServiceOf(app: FastifyInstance): TeamService | undefined {
  return services.get(app);
}

/**
 * D100 · the one place `app.ts` wires Team in (`docs/team-removal.md`): the service
 * (opened when the app is ready: it reads the switch, and opens `team.db` and starts
 * its timers only while Team is on), its routes, and its close.
 */
export async function installTeam(app: FastifyInstance, context: TeamAppContext): Promise<TeamService> {
  const team = new TeamService({
    dataDir: context.config.dataDir,
    store: context.store,
    bus: context.bus,
    supervisor: context.supervisor,
    loops: context.loops,
    todos: context.todos,
    peers: context.peers,
    takeover: context.takeoverRunner,
    isHooked: (sessionId) => context.hooks.isHooked(sessionId),
    startSession: async (body, beforeSpawn) => {
      const outcome = await startNewSession(context, body, { beforeSpawn: (session) => beforeSpawn(session.id) });
      return outcome.ok ? { ok: true, sessionId: outcome.record.id } : { ok: false, status: outcome.status, body: outcome.body };
    },
  });
  services.set(app, team);
  await registerTeamRoutes(app, team);
  await registerAccessRoutes(app, team);
  app.addHook('onReady', async () => {
    // Demo mode never starts Team, except for the README screenshots (`demoExtras`) and the v2 layer (`demoV2`, docs/demo.md).
    if (!context.config.demo || context.config.demoExtras || context.config.demoV2) await team.init();
  });
  app.addHook('preClose', async () => {
    await team.close();
  });
  return team;
}
