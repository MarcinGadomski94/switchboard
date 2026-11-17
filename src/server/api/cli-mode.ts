import type { FastifyInstance, FastifyReply } from 'fastify';
import { CliModeError, type CliModeService } from '../cli-mode/service.ts';

/**
 * D171 · the agent's CLI tab (`docs/terminals.md` → *CLI mode*, contract → *CLI mode*), behind the
 * same guard as every `/api/sessions/{id}` route (D165: another profile's agent is 404; a paired
 * computer's agent goes through the paired-machine proxy, `PEER_API_ALLOW`; a paired phone may, D170):
 *
 * - `POST /api/sessions/{id}/cli-mode` `{ stopTurn?, cols?, rows? }` → the Session (its `cliMode.terminalId`):
 *   the agent runs as the interactive `claude` in a terminal; 409 `turn-running` while a turn runs and
 *   `stopTurn` is not set; 409 `cli-mode` / `not-available` / `chat` / `hooked` / `closed` / `moved` /
 *   `folder-missing`; 503 `unavailable` / `too-many` when the terminal cannot start.
 * - `DELETE /api/sessions/{id}/cli-mode` → the Session: Back to chat mode (D72's continue); 409 `not-cli-mode`.
 */
export function registerCliModeRoutes(app: FastifyInstance, cliMode: CliModeService): void {
  const send = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof CliModeError) return reply.code(error.status).header('cache-control', 'no-store').send({ error: error.code, message: error.message });
    throw error;
  };
  app.post<{ Params: { id: string } }>('/api/sessions/:id/cli-mode', async (request, reply) => {
    try {
      return await cliMode.enter(request.params.id, request.body);
    } catch (error) {
      return send(reply, error);
    }
  });
  app.delete<{ Params: { id: string } }>('/api/sessions/:id/cli-mode', async (request, reply) => {
    try {
      return await cliMode.back(request.params.id);
    } catch (error) {
      return send(reply, error);
    }
  });
}
