import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AttachRequest, AttachWarning, FileDiff, ResumeCommand, Session, SessionDetail, SessionEvent } from '../../core/api.ts';
import { checkTitle } from '../../core/session-title.ts';
import type { ApiContext } from '../routes.ts';
import { toEvent, toSession, toSessionDetail } from '../sessions/wire.ts';
import { startNewSession } from '../sessions/start.ts';
import { AttachWarningError, SupervisorError, type SupervisorErrorCode } from '../supervisor/supervisor.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';

/** Session routes (contract → REST, `/api/sessions*`) not implemented yet. */
export const SESSION_ROUTES_PENDING: readonly PendingRoute[] = [];

/** HTTP status of each supervisor refusal. */
const ERROR_STATUS: Record<SupervisorErrorCode, number> = {
  'not-found': 404,
  'folder-missing': 409,
  detached: 409,
  'already-running': 409,
  'request-not-open': 409,
  closing: 503,
  'attach-warning': 409,
  'not-live': 409,
  'remote-unavailable': 409,
  // D24: the CLI refused or failed the `remote_control` request; `message` is its text, verbatim.
  'remote-failed': 502,
};

interface IdParams {
  readonly id: string;
}

/** Sends a supervisor refusal as `{ error: <code>, message }` (+ `reasons` for an attach warning), rethrows anything else. */
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AttachWarningError) {
    const body: AttachWarning = { error: 'attach-warning', message: error.message, reasons: error.reasons };
    return reply.code(ERROR_STATUS[error.code]).send(body);
  }
  if (error instanceof SupervisorError) {
    return reply.code(ERROR_STATUS[error.code]).send({ error: error.code, message: error.message });
  }
  throw error;
}

function notFound(reply: FastifyReply, id: string): FastifyReply {
  return reply.code(404).send({ error: 'not-found', message: `no session ${id}` });
}

/**
 * Registers the session routes (M2.1: the supervisor's layer; M4.x / M5.x add to
 * the UI side, M4.5 the diff; D22 the additive rename, `PUT /api/sessions/{id}/title`,
 * which publishes `sessionUpdated`; D24 the additive Remote toggle, `PUT
 * /api/sessions/{id}/remote`). Every route sits behind the security guard.
 */
export async function registerSessionRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { store, supervisor, providers } = context;

  app.get('/api/sessions', async (): Promise<Session[]> => {
    const records = await store.sessions.list();
    return Promise.all(records.map((record) => toSession(store, record, supervisor.activity(record.id))));
  });

  app.post('/api/sessions', async (request, reply) => {
    try {
      // Validation, worktrees (M2.2), the first-turn payload (M5.2) and the start: sessions/start.ts (shared with the M7.1 scheduler).
      const outcome = await startNewSession(context, request.body);
      if (!outcome.ok) return reply.code(outcome.status).send(outcome.body);
      return reply.code(201).send(await toSession(store, outcome.record, supervisor.activity(outcome.record.id)));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: IdParams }>('/api/sessions/:id', async (request, reply): Promise<SessionDetail | FastifyReply> => {
    const record = await store.sessions.get(request.params.id);
    if (!record) return notFound(reply, request.params.id);
    return toSessionDetail(store, providers, record, supervisor.activity(record.id));
  });

  // D22 (additive): rename. Only the title changes (the name, branch and worktree stay); the next spawn passes it as `--name`.
  app.put<{ Params: IdParams }>('/api/sessions/:id/title', async (request, reply): Promise<Session | FastifyReply> => {
    const record = await store.sessions.get(request.params.id);
    if (!record) return notFound(reply, request.params.id);
    const parsed = parseTitleInput(request.body);
    if (!parsed.ok) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'title', message: parsed.message }] });
    const updated = (await store.sessions.update(record.id, { title: parsed.title })) ?? record;
    const session = await toSession(store, updated);
    context.bus.publish('sessionUpdated', session);
    return session;
  });

  // D24 (additive): Remote Control on the session's live process. The supervisor publishes `sessionUpdated`.
  app.put<{ Params: IdParams }>('/api/sessions/:id/remote', async (request, reply): Promise<Session | FastifyReply> => {
    const record = await store.sessions.get(request.params.id);
    if (!record) return notFound(reply, request.params.id);
    const enabled = parseRemoteInput(request.body);
    if (enabled === null) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'enabled', message: 'the body must be { enabled: true | false }' }] });
    try {
      const updated = await supervisor.setRemote(record.id, enabled);
      return await toSession(store, updated, supervisor.activity(updated.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: IdParams }>('/api/sessions/:id/messages', async (request, reply) => {
    const body = request.body as { text?: unknown } | undefined;
    const text = body?.text;
    if (typeof text !== 'string' || text.trim() === '') {
      return reply.code(422).send({ error: 'invalid', errors: [{ field: 'text', message: 'the message must be non-empty text' }] });
    }
    try {
      await supervisor.sendMessage(request.params.id, text);
      return reply.code(202).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: IdParams }>('/api/sessions/:id/pause', async (request, reply) => {
    try {
      const record = await supervisor.pause(request.params.id);
      return await toSession(store, record, supervisor.activity(record.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: IdParams }>('/api/sessions/:id/resume', async (request, reply) => {
    try {
      const record = await supervisor.resume(request.params.id);
      return await toSession(store, record, supervisor.activity(record.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: IdParams }>('/api/sessions/:id/detach', async (request, reply): Promise<ResumeCommand | FastifyReply> => {
    try {
      return await supervisor.detach(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // M4.1: `{ confirm: true }` (optional body) attaches despite the terminal warning; without it a warning is a 409 `attach-warning`.
  app.post<{ Params: IdParams }>('/api/sessions/:id/attach', async (request, reply): Promise<ResumeCommand | FastifyReply> => {
    const body = request.body as AttachRequest | null | undefined;
    const confirm = typeof body === 'object' && body !== null && body.confirm === true;
    try {
      return await supervisor.attach(request.params.id, { confirm });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: IdParams; Querystring: { since?: string } }>(
    '/api/sessions/:id/events',
    async (request, reply): Promise<SessionEvent[] | FastifyReply> => {
      const record = await store.sessions.get(request.params.id);
      if (!record) return notFound(reply, request.params.id);
      const since = request.query.since;
      if (since !== undefined && Number.isNaN(Date.parse(since))) {
        return reply.code(422).send({ error: 'invalid', errors: [{ field: 'since', message: 'since must be an ISO timestamp' }] });
      }
      const events = await store.events.list(record.id, since === undefined ? {} : { sinceTs: new Date(since).toISOString() });
      return events.map(toEvent);
    },
  );

  // M4.5 · gap #10: the session's changed files (`providers.diff`: the WorktreeManager, or the demo's), `?file=` narrows to one path.
  app.get<{ Params: IdParams; Querystring: { file?: unknown } }>(
    '/api/sessions/:id/diff',
    async (request, reply): Promise<FileDiff[] | FastifyReply> => {
      const record = await store.sessions.get(request.params.id);
      if (!record) return notFound(reply, request.params.id);
      const file = request.query.file;
      if (file !== undefined && !isDiffFilePath(file)) {
        return reply.code(422).send({ error: 'invalid', errors: [{ field: 'file', message: 'file must be one relative path inside a solution' }] });
      }
      if (!providers.diff) return [];
      return providers.diff.diff(record.id, file);
    },
  );

  registerPending(app, SESSION_ROUTES_PENDING);
}

/**
 * The body of `PUT /api/sessions/{id}/title` (D22, `SessionTitleInput`):
 * `{ title }` where a `null`, empty or blank title clears it (`title: null`: the
 * name is shown again) and any other text must be 1–80 characters once trimmed
 * (the create path's rule, `checkTitle`). A body without a `title` field is refused.
 */
export function parseTitleInput(body: unknown): { readonly ok: true; readonly title: string | null } | { readonly ok: false; readonly message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !('title' in body)) {
    return { ok: false, message: 'the body must be { title }: text, or null to clear it' };
  }
  const raw = (body as { title?: unknown }).title;
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return { ok: true, title: null };
  const check = checkTitle(raw);
  return check.ok ? { ok: true, title: check.title } : { ok: false, message: check.message };
}

/** The body of `PUT /api/sessions/{id}/remote` (D24, `SessionRemoteInput`): `{ enabled: boolean }`, else `null`. */
export function parseRemoteInput(body: unknown): boolean | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const enabled = (body as { enabled?: unknown }).enabled;
  return typeof enabled === 'boolean' ? enabled : null;
}

/**
 * `?file=` of the diff route: one non-empty, solution-relative path (no absolute
 * path, drive letter, `..` segment or NUL), as `FileDiff.path` names it.
 */
export function isDiffFilePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[\\/]/).includes('..');
}
