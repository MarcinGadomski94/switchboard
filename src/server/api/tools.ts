import type { FastifyInstance, FastifyReply } from 'fastify';
import type { CodebaseMemoryStatus, Tool, ToolProbe } from '../../core/api.ts';
import type { ToolRecord } from '../db/repos/tools.ts';
import type { Store } from '../db/store.ts';
import type { ApiContext } from '../routes.ts';
import { toSession } from '../sessions/wire.ts';
import { SupervisorError, type SupervisorErrorCode } from '../supervisor/supervisor.ts';
import { REINDEX_SESSION_NAME, dirtyFileCodebaseMemory, reindexPrompt } from '../tools/codebase-memory.ts';
import { httpToolProbe } from '../tools/probe.ts';
import { validateTools } from '../tools/validate.ts';
import type { PendingRoute } from './not-implemented.ts';

/** Embedded-tool routes (contract → REST) not implemented yet: none since M8.1. */
export const TOOL_ROUTES_PENDING: readonly PendingRoute[] = [];

/** HTTP status of each supervisor refusal of the reindex session. */
const START_ERROR_STATUS: Partial<Record<SupervisorErrorCode, number>> = {
  'workspace-not-configured': 409,
  'workspace-missing': 409,
  closing: 503,
};

interface IdParams {
  readonly id: string;
}

/** A stored tool as the API shows it (data model: id, name, url, showInSidebar; + description). */
export function toTool(record: ToolRecord): Tool {
  return { id: record.id, name: record.name, url: record.url, description: record.description, showInSidebar: record.showInSidebar };
}

/** The first free session name: `base`, then `base-2`, `base-3`, … */
async function freeSessionName(store: Store, base: string): Promise<string> {
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    if ((await store.sessions.getByName(name)) === null) return name;
  }
}

/**
 * Registers the embedded-tool routes (M8.1, `docs/tools.md`):
 * - `GET /api/tools` → Tool[] in display order; `PUT /api/tools` replaces the whole
 *   list (add, edit, remove, reorder; gaps #13, #14) → the stored Tool[], `422` on
 *   an invalid body;
 * - `POST /api/tools/{id}/probe` → `{ state: up|down }` from a server-side GET with
 *   a 3 s timeout (`providers.toolProbe`, else `tools/probe.ts`); `404` for an
 *   unknown tool, `409 not-configured` for a tool without a URL;
 * - additive, not in the contract: `GET /api/codebase-memory` (the Codebase Memory
 *   strip: `.codebase-memory-dirty` projects) and `POST /api/codebase-memory/reindex`
 *   (gap #4: starts a session from the built-in reindex prompt → `201` Session,
 *   `409 nothing-to-reindex` when the list is empty).
 */
export async function registerToolRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { store, providers, supervisor, config } = context;
  const prober = providers.toolProbe ?? httpToolProbe;
  const codebaseMemory = providers.codebaseMemory ?? dirtyFileCodebaseMemory(config.workspaceRoot);

  app.get('/api/tools', async (): Promise<Tool[]> => (await store.tools.list()).map(toTool));

  app.put('/api/tools', async (request, reply): Promise<Tool[] | FastifyReply> => {
    const result = validateTools(request.body);
    if (!result.ok) return reply.code(422).send({ error: 'invalid', errors: result.errors });
    return (await store.tools.replaceAll(result.value)).map(toTool);
  });

  app.post<{ Params: IdParams }>('/api/tools/:id/probe', async (request, reply): Promise<ToolProbe | FastifyReply> => {
    const tool = await store.tools.get(request.params.id);
    if (!tool) return reply.code(404).send({ error: 'not-found', message: `no tool ${request.params.id}` });
    if (!tool.url) return reply.code(409).send({ error: 'not-configured', message: `${tool.name} has no URL` });
    return { state: await prober.probe(tool.url) };
  });

  app.get('/api/codebase-memory', async (): Promise<CodebaseMemoryStatus> => codebaseMemory.status());

  app.post('/api/codebase-memory/reindex', async (_request, reply) => {
    const { projects } = await codebaseMemory.status();
    if (projects.length === 0) {
      return reply.code(409).send({ error: 'nothing-to-reindex', message: '.codebase-memory-dirty lists no projects' });
    }
    const prompt = reindexPrompt(projects);
    try {
      const record = await supervisor.start(
        {
          name: await freeSessionName(store, REINDEX_SESSION_NAME),
          task: prompt,
          workType: null,
          mode: null,
          phase: null,
          coordination: null,
          qa: null,
          solutions: [],
          worktrees: false,
          ultracode: false,
        },
        prompt,
      );
      return reply.code(201).send(await toSession(store, record));
    } catch (error) {
      const status = error instanceof SupervisorError ? START_ERROR_STATUS[error.code] : undefined;
      if (error instanceof SupervisorError && status) return reply.code(status).send({ error: error.code, message: error.message });
      throw error;
    }
  });
}
