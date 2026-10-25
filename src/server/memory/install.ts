import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { registerMemoryRoutes } from './routes.ts';
import { MemoryService } from './service.ts';

/** What {@link installMemory} needs from the app (the route context it already built). */
export type MemoryAppContext = Pick<ApiContext, 'config' | 'store' | 'bus' | 'supervisor'> & Partial<Pick<ApiContext, 'worktrees' | 'peers'>>;

const services = new WeakMap<FastifyInstance, MemoryService>();

/** The Project memory service `installMemory` gave `app` (`undefined` before). */
export function memoryServiceOf(app: FastifyInstance): MemoryService | undefined {
  return services.get(app);
}

/**
 * D107 · the one place `app.ts` wires Project memory in (`docs/memory-removal.md`): the service
 * (started when the app is ready: it reads the switch and opens `memory.db` only while on), its
 * routes and its close.
 */
export async function installMemory(app: FastifyInstance, context: MemoryAppContext): Promise<MemoryService> {
  const memory = new MemoryService({
    dataDir: context.config.dataDir,
    store: context.store,
    bus: context.bus,
    supervisor: context.supervisor,
    // D107 follow-up 2026-10-15: the shared repo set (repo scope) and the paired machines (a moved member's memory).
    ...(context.worktrees ? { repos: context.worktrees.repos } : {}),
    ...(context.peers ? { peers: context.peers } : {}),
  });
  app.addHook('onReady', async () => {
    // Demo mode never runs Project memory (the visual oracle is unchanged), except in the v2 layer (`demoV2`, docs/demo.md).
    if (!context.config.demo || context.config.demoV2) await memory.start();
  });
  app.addHook('preClose', async () => {
    await memory.close();
  });
  services.set(app, memory);
  await registerMemoryRoutes(app, memory);
  return memory;
}
