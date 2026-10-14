import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AGENT_SESSION_HEADER } from '../../core/todos.ts';
import { MemoryError, type MemoryService } from './service.ts';

function sendMemoryError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof MemoryError) return reply.code(error.status).send(error.body());
  throw error;
}

/** The session the agent token was checked for (`security.ts` refused the request without a valid one). */
function agentSession(request: FastifyRequest): string {
  const value = request.headers[AGENT_SESSION_HEADER];
  return typeof value === 'string' ? value : '';
}

async function answer<T>(reply: FastifyReply, work: () => T | Promise<T>, status = 200): Promise<FastifyReply> {
  try {
    const body = await work();
    return status === 204 ? reply.code(204).send() : reply.code(status).send(body);
  } catch (error) {
    return sendMemoryError(reply, error);
  }
}

/**
 * D107 · Project memory (`docs/memory.md`; contract → *Project memory (D107)*).
 *
 * The UI's routes (the `sb_token` cookie; a paired machine's through
 * `/api/machines/{id}/api/memory/…`, on `PEER_API_ALLOW`):
 * - `GET /api/memory/state` → `MemoryState` (answered while off too);
 * - `GET /api/memory/scopes` → `MemoryScope[]`;
 * - `GET /api/memory/entries?scope=&status=` → `MemoryEntry[]`;
 * - `POST /api/memory/entries` `{ scope, title, text, tags?, pinned? }` → 201 (the developer's: approved);
 * - `PUT /api/memory/entries/{id}` `{ title?, text?, tags?, pinned? }`; `DELETE /api/memory/entries/{id}` → 204;
 * - `POST /api/memory/entries/{id}/approve` `{ title?, text?, tags?, pinned? }` (the edit is what is approved);
 *   `POST /api/memory/entries/{id}/reject`;
 * - `GET|PUT /api/memory/settings` `{ cap }`.
 *
 * The agent's (the `memory_*` MCP tools), only with the session's agent token, for that session's
 * folder: `GET /agent/v1/memory` (approved entries; also the helper's probe), `POST /agent/v1/memory`
 * (a proposal).
 *
 * Experimental: while off every route answers 404 `memory-off` except `GET /api/memory/state`;
 * while `memory.db` is broken, 503 `memory-unavailable`. Registered by `installMemory`.
 */
export async function registerMemoryRoutes(app: FastifyInstance, memory: MemoryService): Promise<void> {
  app.get('/api/memory/state', async () => memory.state());
  app.get('/api/memory/scopes', async (_request, reply) => answer(reply, () => memory.scopes()));
  app.get<{ Querystring: { scope?: string; status?: string } }>('/api/memory/entries', async (request, reply) =>
    answer(reply, () => memory.entries({ ...(request.query.scope ? { scope: request.query.scope } : {}), ...(request.query.status ? { status: request.query.status } : {}) })),
  );
  app.post('/api/memory/entries', async (request, reply) => answer(reply, () => memory.add(request.body), 201));
  app.put<{ Params: { id: string } }>('/api/memory/entries/:id', async (request, reply) => answer(reply, () => memory.update(request.params.id, request.body)));
  app.delete<{ Params: { id: string } }>('/api/memory/entries/:id', async (request, reply) => answer(reply, () => memory.delete(request.params.id), 204));
  app.post<{ Params: { id: string } }>('/api/memory/entries/:id/approve', async (request, reply) => answer(reply, () => memory.approve(request.params.id, request.body)));
  app.post<{ Params: { id: string } }>('/api/memory/entries/:id/reject', async (request, reply) => answer(reply, () => memory.reject(request.params.id)));
  app.get('/api/memory/settings', async (_request, reply) => answer(reply, () => memory.settings()));
  app.put('/api/memory/settings', async (request, reply) => answer(reply, () => memory.setSettings(request.body)));

  // ── the agent's routes (the `switchboard` MCP helper) ──────────────────
  app.get('/agent/v1/memory', async (request, reply) => answer(reply, () => memory.agentList(agentSession(request))));
  app.post('/agent/v1/memory', async (request, reply) => answer(reply, () => memory.propose(agentSession(request), request.body), 201));
}
