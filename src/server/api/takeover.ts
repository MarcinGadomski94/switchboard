import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HookError } from '../hooks/service.ts';
import type { ApiContext } from '../routes.ts';
import { SupervisorError } from '../supervisor/supervisor.ts';
import { TakeoverGitError } from '../takeover/git.ts';
import { TakeoverError } from '../takeover/service.ts';
import { placementOf } from '../../core/takeover.ts';
import { isPeerRequest } from './machines.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Sends a take-over failure as `{ error, message }`; rethrows what it does not know. */
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TakeoverError) return reply.code(error.status).send({ error: error.code, message: error.message });
  if (error instanceof HookError) return reply.code(error.status).send({ error: error.code, message: error.message });
  if (error instanceof SupervisorError) return reply.code(409).send({ error: error.code, message: error.message });
  if (error instanceof TakeoverGitError) return reply.code(502).send({ error: 'git-failed', message: error.message });
  throw error;
}

function invalid(reply: FastifyReply, field: string, message: string): FastifyReply {
  return reply.code(422).send({ error: 'invalid', errors: [{ field, message }] });
}

/** The `clonePaths` of a request body: `{ <repo key>: <path> }`, strings only. */
function clonePathsOf(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, path] of Object.entries(value)) {
    if (typeof path !== 'string') return null;
    out[key] = path;
  }
  return out;
}

/**
 * D65 (`docs/peers.md` → *Taking a session over*, `contracts/local-api.md` →
 * *Take-over*): taking a session over from one paired machine to another.
 *
 * Local only (the UI; a peer never starts a take-over through us):
 * - `POST /api/takeover/preview` `{ sessionId, targetMachine?, clonePaths? }` → `TakeoverPreview`.
 * - `POST /api/takeover` `{ sessionId, targetMachine?, clonePaths?, confirmStopTerminal? }` → 202 `TakeoverRun` (poll it).
 * - `GET /api/takeover/runs/{id}` → `TakeoverRun`.
 * - D110 `POST /api/takeover/folders` `{ machine?, path? }` → `TargetDirListing` (the target's folder picker; `machine` absent = this one).
 * `preview` and the start also take `placement` (`TargetPlacement`: the chosen target folders).
 *
 * Peer API (the other machine's runner calls these; also callable locally):
 * `source/{inspect,stop,capture,stop-terminal,files,chunk,finish,rollback}`,
 * `target/{plan,chunk,apply,abort,resume,close}`, `GET leftovers`, `POST leftovers/{id}/delete`;
 * D110 (read-only): `target/folders` `{ path? }`, `target/verify` `{ source, placement, clonePaths? }`.
 */
export async function registerTakeoverRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { takeover, takeoverRunner } = context;

  const localOnly = (request: FastifyRequest, reply: FastifyReply): FastifyReply | null =>
    isPeerRequest(request) ? reply.code(403).send({ error: 'peer-forbidden', message: 'a take-over is started from the machine whose screen you are on' }) : null;

  const requestOf = (body: unknown, reply: FastifyReply) => {
    if (!isRecord(body)) return invalid(reply, 'body', 'the body must be an object');
    const sessionId = text(body['sessionId']);
    if (!sessionId) return invalid(reply, 'sessionId', 'sessionId is required');
    const clonePaths = clonePathsOf(body['clonePaths']);
    if (clonePaths === null) return invalid(reply, 'clonePaths', 'clonePaths must map repo keys to paths');
    const targetMachine = body['targetMachine'] === undefined || body['targetMachine'] === null ? null : text(body['targetMachine']);
    if (body['targetMachine'] !== undefined && body['targetMachine'] !== null && targetMachine === null) return invalid(reply, 'targetMachine', 'targetMachine must be a machine id');
    const placement = placementOf(body['placement']);
    if (placement === null) return invalid(reply, 'placement', 'placement must be { roots: string[], repoPaths?: { <repo key>: path } }');
    // D110: `placement: null` = the target's saved folders (the remembered folders are not used).
    return { sessionId, targetMachine, ...(clonePaths ? { clonePaths } : {}), ...(placement ? { placement } : {}), ...(body['placement'] === null ? { savedFolders: true } : {}), confirmStopTerminal: body['confirmStopTerminal'] === true };
  };

  app.post('/api/takeover/preview', async (request, reply) => {
    const refused = localOnly(request, reply);
    if (refused) return refused;
    const parsed = requestOf(request.body, reply);
    if ('send' in parsed) return parsed;
    try {
      return await takeoverRunner.preview(parsed);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/takeover', async (request, reply) => {
    const refused = localOnly(request, reply);
    if (refused) return refused;
    const parsed = requestOf(request.body, reply);
    if ('send' in parsed) return parsed;
    try {
      return reply.code(202).send(await takeoverRunner.start(parsed));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // D110: the target machine's folder picker (through the peer API when the target is the other machine).
  app.post('/api/takeover/folders', async (request, reply) => {
    const refused = localOnly(request, reply);
    if (refused) return refused;
    if (!isRecord(request.body)) return invalid(reply, 'body', 'the body must be an object');
    const machine = request.body['machine'] === undefined || request.body['machine'] === null ? null : text(request.body['machine']);
    if (request.body['machine'] !== undefined && request.body['machine'] !== null && machine === null) return invalid(reply, 'machine', 'machine must be a machine id');
    const path = text(request.body['path']);
    try {
      return await takeoverRunner.listTargetFolders(machine, path);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { runId: string } }>('/api/takeover/runs/:runId', async (request, reply) => {
    const refused = localOnly(request, reply);
    if (refused) return refused;
    return takeoverRunner.get(request.params.runId) ?? reply.code(404).send({ error: 'not-found', message: `no take-over ${request.params.runId}` });
  });

  // ── the peer API: one end's operations ────────────────────────────────

  const op = (route: string, run: (body: Record<string, unknown>, reply: FastifyReply) => Promise<unknown>): void => {
    app.post(`/api/takeover/${route}`, async (request, reply) => {
      if (!isRecord(request.body)) return invalid(reply, 'body', 'the body must be an object');
      try {
        return await run(request.body, reply);
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

  op('source/inspect', (body) => takeover.inspect(need(body, 'sessionId')));
  op('source/stop', (body) => takeover.stop(need(body, 'opId'), need(body, 'sessionId')));
  op('source/capture', (body) => takeover.capture(need(body, 'opId')));
  op('source/stop-terminal', (body) => takeover.stopTerminal(need(body, 'opId')));
  op('source/files', (body) => takeover.files(need(body, 'opId')));
  op('source/chunk', (body) => takeover.readChunk(need(body, 'opId'), need(body, 'name'), typeof body['offset'] === 'number' ? body['offset'] : -1));
  op('source/finish', (body) => {
    const move = objectOf(body, 'move');
    const stillThere = Array.isArray(body['stillThere']) ? body['stillThere'].filter((entry): entry is string => typeof entry === 'string') : [];
    return takeover.finish(
      need(body, 'opId'),
      { machineId: need(move, 'machineId'), machineName: need(move, 'machineName'), sessionId: need(move, 'sessionId'), at: need(move, 'at') },
      stillThere,
    );
  });
  op('source/rollback', (body) => takeover.rollbackSource(need(body, 'opId')));
  const placementIn = (body: Record<string, unknown>) => {
    const placement = placementOf(body['placement']);
    if (placement === null) throw new TakeoverError(422, 'invalid', 'placement must be { roots: string[], repoPaths?: { <repo key>: path } }');
    return placement ? { placement } : {};
  };
  op('target/plan', (body) => {
    const clonePaths = clonePathsOf(body['clonePaths']);
    if (clonePaths === null) throw new TakeoverError(422, 'invalid', 'clonePaths must map repo keys to paths');
    return takeover.plan({ source: objectOf(body, 'source') as never, ...(clonePaths ? { clonePaths } : {}), ...placementIn(body) });
  });
  // D110 (read-only): the folder picker's listing of this machine, and the verification of the chosen folders.
  op('target/folders', (body) => takeover.listTargetFolders(text(body['path'])));
  op('target/verify', async (body) => {
    const clonePaths = clonePathsOf(body['clonePaths']);
    if (clonePaths === null) throw new TakeoverError(422, 'invalid', 'clonePaths must map repo keys to paths');
    const placement = placementIn(body);
    if (!('placement' in placement)) throw new TakeoverError(422, 'invalid', 'placement is required');
    const planned = await takeover.plan({ source: objectOf(body, 'source') as never, ...(clonePaths ? { clonePaths } : {}), ...placement });
    return { result: { verification: planned.result.verification ?? null, blockers: planned.result.blockers }, log: planned.log };
  });
  op('target/chunk', (body) =>
    takeover.receiveChunk({
      opId: need(body, 'opId'),
      name: String(body['name'] ?? ''),
      size: typeof body['size'] === 'number' ? body['size'] : -1,
      sha256: String(body['sha256'] ?? ''),
      offset: typeof body['offset'] === 'number' ? body['offset'] : -1,
      data: typeof body['data'] === 'string' ? body['data'] : '',
    }),
  );
  op('target/apply', (body) => {
    const clonePaths = clonePathsOf(body['clonePaths']);
    if (clonePaths === null) throw new TakeoverError(422, 'invalid', 'clonePaths must map repo keys to paths');
    return takeover.apply({ opId: need(body, 'opId'), source: objectOf(body, 'source') as never, captured: (Array.isArray(body['captured']) ? body['captured'] : []) as never, ...(clonePaths ? { clonePaths } : {}), ...placementIn(body) });
  });
  op('target/abort', (body) => takeover.abort(need(body, 'opId')));
  op('target/resume', (body) =>
    takeover.resume({ opId: need(body, 'opId'), source: objectOf(body, 'source') as never, files: (Array.isArray(body['files']) ? body['files'] : []) as never, from: objectOf(body, 'from') as never }),
  );
  op('target/close', async (body) => {
    await takeover.closeTarget(need(body, 'opId'));
    return { ok: true };
  });

  // The temporary branches this machine pushed and could not delete, and their one-click delete.
  app.get('/api/takeover/leftovers', async () => takeover.listLeftovers());
  app.post<{ Params: { leftoverId: string } }>('/api/takeover/leftovers/:leftoverId/delete', async (request, reply) => {
    try {
      return (await takeover.deleteLeftover(request.params.leftoverId)).result;
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
