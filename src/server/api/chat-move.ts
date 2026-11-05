import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ChatLookAtChoice } from '../../core/chat-move.ts';
import { ChatMoveRunner } from '../chats/move-runner.ts';
import { ChatMoveService } from '../chats/move-service.ts';
import type { ApiContext } from '../routes.ts';
import { SupervisorError } from '../supervisor/supervisor.ts';
import { TakeoverError } from '../takeover/service.ts';
import { isPeerRequest } from './machines.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TakeoverError) return reply.code(error.status).send({ error: error.code, message: error.message });
  if (error instanceof SupervisorError) return reply.code(409).send({ error: error.code, message: error.message });
  throw error;
}

/** `lookAt` of a body: `{ <source path>: <target path> | null }` (absent = `undefined`; malformed = `null`). */
export function lookAtChoiceOf(value: unknown): ChatLookAtChoice | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return null;
  const out: Record<string, string | null> = {};
  const entries = Object.entries(value);
  if (entries.length > 50) return null;
  for (const [source, target] of entries) {
    if (target !== null && typeof target !== 'string') return null;
    out[source] = typeof target === 'string' && target.trim() !== '' ? target.trim() : null;
  }
  return out;
}

/**
 * D155 (`docs/peers.md` → *Moving a chat (D155)*, `contracts/local-api.md` →
 * *Moving a chat (D155)*): moving a chat to / from a paired computer.
 *
 * Local only (the UI; a peer never starts a move through us):
 * - `POST /api/takeover/chat/preview` `{ chatId, targetMachine?, lookAt? }` → `ChatMovePreview`.
 * - `POST /api/takeover/chat` (same body) → 202 `ChatMoveRun` (poll it).
 * - `GET /api/takeover/chat/runs/{id}` → `ChatMoveRun`.
 *
 * Peer API (the other machine's runner calls these; on `PEER_API_ALLOW`):
 * `chat/source/{inspect,data,data-chunk,release}`, `chat/target/{plan,data-chunk,resume,abort,close}`.
 * The conversation, the stop, the finish and the source's undo are the take-over's
 * own `source/{stop,files,chunk,finish,rollback}` and `target/chunk`.
 */
export async function registerChatMoveRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const service = new ChatMoveService({
    store: context.store,
    config: context.config,
    supervisor: context.supervisor,
    accounts: context.accounts,
    clis: context.clis,
    folders: context.folders,
    takeover: context.takeover,
    todos: context.todos,
    self: () => context.peers.self(),
    log: app.log,
  });
  const runner = new ChatMoveRunner({ chats: service, takeover: context.takeover, peers: context.peers, store: context.store, log: app.log });
  // D154: chat moves are listed with the other moves (badges, Home, a failed move's Needs-you item).
  context.moves.follow(runner);

  const localOnly = (request: FastifyRequest, reply: FastifyReply): FastifyReply | null =>
    isPeerRequest(request) ? reply.code(403).send({ error: 'peer-forbidden', message: 'a chat move is started from the computer whose screen you are on' }) : null;

  const requestOf = (body: unknown, reply: FastifyReply) => {
    if (!isRecord(body)) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'body', message: 'the body must be an object' }] });
    const chatId = text(body['chatId']);
    if (!chatId) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'chatId', message: 'chatId is required' }] });
    const targetMachine = body['targetMachine'] === undefined || body['targetMachine'] === null ? null : text(body['targetMachine']);
    if (body['targetMachine'] !== undefined && body['targetMachine'] !== null && targetMachine === null) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'targetMachine', message: 'targetMachine must be a machine id' }] });
    const lookAt = lookAtChoiceOf(body['lookAt']);
    if (lookAt === null) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'lookAt', message: 'lookAt must map each looked-at folder to a folder on the target or null (leave it out)' }] });
    return { chatId, targetMachine, ...(lookAt ? { lookAt } : {}) };
  };

  app.post('/api/takeover/chat/preview', async (request, reply) => {
    const refused = localOnly(request, reply);
    if (refused) return refused;
    const parsed = requestOf(request.body, reply);
    if ('send' in parsed) return parsed;
    try {
      return await runner.preview(parsed);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/takeover/chat', async (request, reply) => {
    const refused = localOnly(request, reply);
    if (refused) return refused;
    const parsed = requestOf(request.body, reply);
    if ('send' in parsed) return parsed;
    try {
      return reply.code(202).send(await runner.start(parsed));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { runId: string } }>('/api/takeover/chat/runs/:runId', async (request, reply) => {
    const refused = localOnly(request, reply);
    if (refused) return refused;
    return runner.get(request.params.runId) ?? reply.code(404).send({ error: 'not-found', message: `no chat move ${request.params.runId}` });
  });

  // ── the peer API: one end's chat operations ───────────────────────────
  // Tests only (`SWITCHBOARD_PEER_TEST_HOOKS=1` + `SWITCHBOARD_TEST_CHAT_MOVE_UNSUPPORTED=1`): this machine answers the
  // chat routes over the peer API exactly as a Switchboard before D155 does (its listener's 403 peer-forbidden).
  const actOlder = process.env['SWITCHBOARD_PEER_TEST_HOOKS'] === '1' && process.env['SWITCHBOARD_TEST_CHAT_MOVE_UNSUPPORTED'] === '1';
  const op = (route: string, run: (body: Record<string, unknown>) => Promise<unknown>): void => {
    app.post(`/api/takeover/chat/${route}`, async (request, reply) => {
      if (actOlder && isPeerRequest(request)) return reply.code(403).send({ error: 'peer-forbidden', message: `POST /api/takeover/chat/${route} is not part of the peer API` });
      if (!isRecord(request.body)) return reply.code(422).send({ error: 'invalid', message: 'the body must be an object' });
      try {
        return await run(request.body);
      } catch (error) {
        return sendError(reply, error);
      }
    });
  };
  const need = (body: Record<string, unknown>, field: string): string => {
    const value = text(body[field]);
    if (!value) throw new TakeoverError(422, 'invalid', `${field} is required`);
    return value;
  };
  const objectOf = (body: Record<string, unknown>, field: string): Record<string, unknown> => {
    const value = body[field];
    if (!isRecord(value)) throw new TakeoverError(422, 'invalid', `${field} must be an object`);
    return value;
  };
  const lookAtIn = (body: Record<string, unknown>): ChatLookAtChoice | null => {
    const lookAt = lookAtChoiceOf(body['lookAt']);
    if (lookAt === null) throw new TakeoverError(422, 'invalid', 'lookAt must map folders to a path or null');
    return lookAt ?? null;
  };
  const partOf = (body: Record<string, unknown>): 'attachment' | 'scratch' | 'artifact' => {
    const part = body['part'];
    if (part !== 'attachment' && part !== 'scratch' && part !== 'artifact') throw new TakeoverError(422, 'invalid', 'part must be attachment, scratch or artifact');
    return part;
  };

  op('source/inspect', (body) => service.inspect(need(body, 'chatId'), text(body['opId']) ?? undefined));
  op('source/data', (body) => service.data(need(body, 'opId'), need(body, 'chatId')));
  op('source/data-chunk', (body) => service.readData(need(body, 'opId'), partOf(body), need(body, 'name'), typeof body['offset'] === 'number' ? body['offset'] : -1));
  op('source/release', async (body) => service.release(need(body, 'opId')));
  op('target/plan', (body) => service.plan({ source: objectOf(body, 'source') as never, lookAt: lookAtIn(body), ...(text(body['opId']) ? { opId: text(body['opId']) as string } : {}) }));
  op('target/data-chunk', (body) =>
    service.receiveData({
      opId: need(body, 'opId'),
      part: body['part'],
      name: body['name'],
      size: typeof body['size'] === 'number' ? body['size'] : -1,
      sha256: String(body['sha256'] ?? ''),
      offset: typeof body['offset'] === 'number' ? body['offset'] : -1,
      data: typeof body['data'] === 'string' ? body['data'] : '',
    }),
  );
  op('target/resume', (body) =>
    service.resume({ opId: need(body, 'opId'), source: objectOf(body, 'source') as never, files: (Array.isArray(body['files']) ? body['files'] : []) as never, lookAt: lookAtIn(body), from: objectOf(body, 'from') as never }),
  );
  op('target/abort', (body) => service.abort(need(body, 'opId')));
  op('target/close', async (body) => {
    await service.close(need(body, 'opId'));
    return { ok: true };
  });
}
