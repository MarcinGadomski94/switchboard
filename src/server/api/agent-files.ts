import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AGENT_FILE_TEXT_LINES, type AgentFileErrorCode } from '../../core/agent-files.ts';
import { isRemoteId } from '../../core/peers.ts';
import { pageFrame, pagePolicy } from '../agent-files/page.ts';
import { AGENT_FILE_STATUS, AgentFileError, AgentFileService, type AgentFileSession, type PageOptions } from '../agent-files/service.ts';
import type { ApiContext } from '../routes.ts';

interface IdParams {
  readonly id: string;
}

interface FileQuery {
  readonly path?: unknown;
  readonly confirm?: unknown;
  readonly offset?: unknown;
  readonly limit?: unknown;
  /** `…/files/page`: `1` lets the page's own scripts run. */
  readonly scripts?: unknown;
  /** `…/files/page`: new when the page is asked for anew (Reload). */
  readonly v?: unknown;
}

/** How a page is asked for: without its scripts unless `scripts=1`. */
function pageOptions(query: FileQuery): PageOptions {
  return { confirm: query.confirm === '1', scripts: query.scripts === '1', version: typeof query.v === 'string' ? query.v : undefined };
}

function refuse(reply: FastifyReply, code: AgentFileErrorCode, message: string): FastifyReply {
  return reply.code(AGENT_FILE_STATUS[code]).send({ error: code, message });
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AgentFileError) return refuse(reply, error.code, error.message);
  throw error;
}

/** A whole number from a query value, `fallback` when it is absent or not one. */
function wholeNumber(value: unknown, fallback: number): number {
  return typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : fallback;
}

/** One `bytes=a-b` range of a file of `size` bytes: the range, `null` without a header, `'invalid'` when it cannot be met. */
function rangeOf(header: unknown, size: number): { readonly start: number; readonly end: number } | null | 'invalid' {
  if (typeof header !== 'string' || header.trim() === '') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (match[1] === '') {
    const tail = Number(match[2]);
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start > end || start >= size ? 'invalid' : { start, end };
}

/**
 * SPIKE · side panel Files (`src/core/agent-files.ts` is the contract). The loopback
 * UI only: a paired phone is refused by name (`DEVICE_REFUSED`,
 * `src/server/devices/local-only.ts`) and the peer listener's allow-list does not have
 * these routes (`src/server/peers/service.ts`). An agent of a paired computer: the
 * request is forwarded there first (`api/machines.ts`) and refused by that computer;
 * the 409 `remote` below is this server's own answer when nothing forwards.
 */
export async function registerAgentFileRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { store, providers, config } = context;
  const service = new AgentFileService({
    worksIn: async (id) => (providers.diff?.worksIn ? providers.diff.worksIn(id) : { repos: [] }),
    toolPaths: (id, names) => store.events.editedFilePaths(id, names),
    replyTexts: async (id, limit) => {
      const events = await store.events.assistantTextsNewestFirst(id, { agentId: null, words: [], limit });
      return events.map((event) => (event.payload as { text?: unknown } | null)?.text).filter((text): text is string => typeof text === 'string' && text !== '');
    },
    platform: process.platform,
    openPrefix: config.openCommand,
  });

  /** The session of the path's id, or `null` after the refusal went out. */
  const sessionOf = async (id: string, reply: FastifyReply): Promise<AgentFileSession | null> => {
    if (isRemoteId(id)) {
      refuse(reply, 'remote', 'This agent runs on another computer: open its files there.');
      return null;
    }
    const record = await store.sessions.get(id);
    if (!record) {
      refuse(reply, 'missing', `No such agent: ${id}`);
      return null;
    }
    return { id: record.id, cwd: record.cwd, root: record.root };
  };

  app.get<{ Params: IdParams }>('/api/sessions/:id/files', async (request, reply) => {
    const session = await sessionOf(request.params.id, reply);
    if (!session) return reply;
    try {
      return await service.list(session);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: IdParams }>('/api/sessions/:id/files/roots', async (request, reply) => {
    const session = await sessionOf(request.params.id, reply);
    if (!session) return reply;
    return { roots: await service.roots(session) };
  });

  app.get<{ Params: IdParams; Querystring: FileQuery }>('/api/sessions/:id/files/dir', async (request, reply) => {
    const session = await sessionOf(request.params.id, reply);
    if (!session) return reply;
    try {
      return await service.dir(session, typeof request.query.path === 'string' ? request.query.path : null);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: IdParams; Querystring: FileQuery }>('/api/sessions/:id/files/meta', async (request, reply) => {
    const session = await sessionOf(request.params.id, reply);
    if (!session) return reply;
    try {
      const allowed = await service.allow(session, typeof request.query.path === 'string' ? request.query.path : '');
      return await service.metaOf(allowed.real, allowed.allowedBy);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: IdParams; Querystring: FileQuery }>('/api/sessions/:id/files/text', async (request, reply) => {
    const session = await sessionOf(request.params.id, reply);
    if (!session) return reply;
    try {
      const allowed = await service.allow(session, typeof request.query.path === 'string' ? request.query.path : '');
      const meta = await service.metaOf(allowed.real, allowed.allowedBy);
      return await service.text(allowed.real, meta, wholeNumber(request.query.offset, 0), wholeNumber(request.query.limit, AGENT_FILE_TEXT_LINES), request.query.confirm === '1');
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: IdParams; Querystring: FileQuery }>('/api/sessions/:id/files/raw', async (request, reply) => {
    const session = await sessionOf(request.params.id, reply);
    if (!session) return reply;
    try {
      const allowed = await service.allow(session, typeof request.query.path === 'string' ? request.query.path : '');
      const meta = await service.metaOf(allowed.real, allowed.allowedBy);
      if (meta.secret !== null && request.query.confirm !== '1') return refuse(reply, 'secret', `This file looks like it holds secrets (${meta.secret}).`);
      reply
        .header('Content-Type', meta.mime)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .header('Accept-Ranges', 'bytes')
        // As the artifacts' raw route (`api/artifacts.ts`, `docs/security.md`): no other origin may embed or read these bytes, a page on another loopback port included.
        .header('Cross-Origin-Resource-Policy', 'same-origin')
        .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
      // Whatever the file is, it never runs as a page of this app. A PDF needs the browser's viewer, which a sandbox would block: it may only be framed by this app.
      reply.header('Content-Security-Policy', meta.mime === 'application/pdf' ? "frame-ancestors 'self'" : "sandbox; default-src 'none'; frame-ancestors 'self'");
      const range = rangeOf(request.headers.range, meta.size);
      if (range === 'invalid') return reply.code(416).header('Content-Range', `bytes */${meta.size}`).send();
      if (range) {
        return reply
          .code(206)
          .header('Content-Range', `bytes ${range.start}-${range.end}/${meta.size}`)
          .header('Content-Length', range.end - range.start + 1)
          .send(createReadStream(allowed.real, { start: range.start, end: range.end }));
      }
      return reply.header('Content-Length', meta.size).send(createReadStream(allowed.real));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // An HTML file as a page: a document that frames it, closed off from this app, under rules that fetch nothing (`pagePolicy`). Its scripts run only with `scripts=1`.
  app.get<{ Params: IdParams; Querystring: FileQuery }>('/api/sessions/:id/files/page', async (request, reply) => {
    const session = await sessionOf(request.params.id, reply);
    if (!session) return reply;
    try {
      const options = pageOptions(request.query);
      const allowed = await service.allow(session, typeof request.query.path === 'string' ? request.query.path : '');
      const meta = await service.metaOf(allowed.real, allowed.allowedBy);
      const page = await service.page(session, allowed.real, meta, options);
      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .header('Cross-Origin-Resource-Policy', 'same-origin')
        .header('Referrer-Policy', 'no-referrer')
        .header('Content-Security-Policy', pagePolicy(options.scripts).header)
        .send(pageFrame(page.html, meta.name, options.scripts));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: IdParams; Querystring: FileQuery }>('/api/sessions/:id/files/page/info', async (request, reply) => {
    const session = await sessionOf(request.params.id, reply);
    if (!session) return reply;
    try {
      const allowed = await service.allow(session, typeof request.query.path === 'string' ? request.query.path : '');
      const meta = await service.metaOf(allowed.real, allowed.allowedBy);
      return await service.pageInfo(session, allowed.real, meta, pageOptions(request.query));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: IdParams; Body: unknown }>('/api/sessions/:id/files/open', async (request, reply) => {
    const session = await sessionOf(request.params.id, reply);
    if (!session) return reply;
    const body = (request.body ?? {}) as { path?: unknown; how?: unknown };
    if (typeof body.path !== 'string' || (body.how !== 'app' && body.how !== 'folder')) return refuse(reply, 'invalid', 'path and how ("app" or "folder") are required');
    try {
      const allowed = await service.allow(session, body.path);
      await service.open(allowed.real, body.how);
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
