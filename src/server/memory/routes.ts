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
 * - `GET|PUT /api/memory/settings` `{ cap }`;
 * - D107 follow-up 2026-10-15 (scopes): `GET /api/memory/entries?kind=member|repo|workspace`;
 *   `GET /api/memory/scope-options?scope=&entry=` → `MemoryScopeOption[]`; `scopeKind` / `scopeKey`
 *   on add, edit and approve; `GET /api/memory/sessions/{id}` → `MemorySessionCount`;
 *   `POST /api/memory/draft` `{ sessionId } | { memberId }` → `MemoryDraftAnswer`;
 *   `POST /api/memory/draft-all` `{ teamId? }` → `MemoryDraftAllAnswer`;
 *   `POST /api/memory/import` `{ sessionId, memberId, entries }` (a paired machine, after a member moved here).
 *
 * The agent's (the `memory_*` MCP tools), only with the session's agent token, for that session's
 * folder: `GET /agent/v1/memory` (approved entries; also the helper's probe), `POST /agent/v1/memory`
 * (a proposal); D135: `POST /agent/v1/memory/edit` `{ entry, title?, text?, reason? }` and
 * `POST /agent/v1/memory/retract` `{ entry, reason }` (proposals to change or remove an approved
 * entry; `approve` / `reject` above decide them: an approved edit replaces the entry, an approved
 * retract deletes it).
 *
 * D132: always on since 2.0 (no switch); while `memory.db` is broken every route but
 * `GET /api/memory/state` answers 503 `memory-unavailable`. Registered by `installMemory`.
 */
export async function registerMemoryRoutes(app: FastifyInstance, memory: MemoryService): Promise<void> {
  app.get('/api/memory/state', async () => memory.state());
  app.get('/api/memory/scopes', async (_request, reply) => answer(reply, () => memory.scopes()));
  app.get<{ Querystring: { scope?: string; status?: string; kind?: string } }>('/api/memory/entries', async (request, reply) =>
    answer(reply, () =>
      memory.entries({ ...(request.query.scope ? { scope: request.query.scope } : {}), ...(request.query.status ? { status: request.query.status } : {}), ...(request.query.kind ? { kind: request.query.kind } : {}) }),
    ),
  );
  app.get<{ Querystring: { scope?: string; entry?: string } }>('/api/memory/scope-options', async (request, reply) => answer(reply, () => memory.scopeOptions(request.query.scope ?? '', request.query.entry || undefined)));
  app.get<{ Params: { id: string } }>('/api/memory/sessions/:id', async (request, reply) => answer(reply, () => memory.sessionCount(request.params.id)));
  app.post('/api/memory/draft', async (request, reply) => answer(reply, () => memory.draft(request.body)));
  app.post('/api/memory/draft-all', async (request, reply) => answer(reply, () => memory.draftAll(request.body)));
  app.post('/api/memory/import', async (request, reply) => answer(reply, () => memory.importMember(request.body)));
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
  // D135: proposals to change or remove an approved entry (reviewed and approved through the same entry routes).
  app.post('/agent/v1/memory/edit', async (request, reply) => answer(reply, () => memory.proposeEdit(agentSession(request), request.body), 201));
  app.post('/agent/v1/memory/retract', async (request, reply) => answer(reply, () => memory.proposeRetract(agentSession(request), request.body), 201));
}
