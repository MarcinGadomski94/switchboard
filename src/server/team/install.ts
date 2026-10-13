import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { startNewSession } from '../sessions/start.ts';
import { registerTeamRoutes } from './routes.ts';
import { TeamService } from './service.ts';

/** What {@link installTeam} needs from the app (the route context it already built). */
export type TeamAppContext = Pick<ApiContext, 'config' | 'store' | 'bus' | 'supervisor' | 'loops' | 'todos' | 'peers' | 'reviews' | 'takeoverRunner' | 'hooks' | 'providers' | 'worktrees' | 'folders' | 'attachments' | 'clis'>;

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
    reviews: context.reviews,
    takeover: context.takeoverRunner,
    isHooked: (sessionId) => context.hooks.isHooked(sessionId),
    startSession: async (body, beforeSpawn) => {
      const outcome = await startNewSession(context, body, { beforeSpawn: (session) => beforeSpawn(session.id) });
      return outcome.ok ? { ok: true, sessionId: outcome.record.id } : { ok: false, status: outcome.status, body: outcome.body };
    },
  });
  await registerTeamRoutes(app, team);
  app.addHook('onReady', async () => {
    if (!context.config.demo) await team.init();
  });
  app.addHook('preClose', async () => {
    await team.close();
  });
  return team;
}
