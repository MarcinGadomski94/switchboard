import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isProtectedPath, mayIssueCookie, serializeTokenCookie } from './security.ts';

/** Options for {@link registerWeb}. */
export interface WebOptions {
  /** Absolute path of the built UI (`dist/web`). It may not exist yet. */
  readonly webRoot: string;
  /** The per-install token, handed to the browser as the `sb_token` cookie. */
  readonly token: string;
}

/** Served when `dist/web/index.html` does not exist (UI not built). */
export const UNBUILT_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Switchboard</title></head>
<body style="margin:0;background:#0b0c0d;color:#e8e7e3;font:13px system-ui,sans-serif;padding:28px">
<p>Switchboard is running, but its UI has not been built. Run <code>npm run build</code>, then reload.</p>
</body>
</html>
`;

async function readIndexHtml(webRoot: string): Promise<string | null> {
  try {
    return await readFile(path.join(webRoot, 'index.html'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** A request for a file (the last path segment has an extension) rather than a UI route. */
function isFileRequest(relative: string): boolean {
  const last = relative.split('/').pop() ?? '';
  return last.includes('.') && relative !== 'index.html';
}

/**
 * Serves the UI: every GET that is not `/api` or `/hub` and does not name a file
 * returns `index.html` (client-side routes), and sets the `sb_token` cookie when
 * gap #20 allows it; file requests are served from `webRoot`. Both are public
 * routes; the Host/Origin guard still applies to them.
 */
export async function registerWeb(app: FastifyInstance, options: WebOptions): Promise<void> {
  const { webRoot, token } = options;
  await app.register(fastifyStatic, { root: webRoot, serve: false });

  const sendPage = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const html = (await readIndexHtml(webRoot)) ?? UNBUILT_PAGE;
    if (mayIssueCookie(request)) reply.header('set-cookie', serializeTokenCookie(token));
    return reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(html);
  };

  app.get('/', { config: { public: true } }, sendPage);
  app.get<{ Params: { '*': string } }>('/*', { config: { public: true } }, async (request, reply) => {
    // Reached for /api and /hub only with a valid cookie (the guard 401s otherwise).
    if (isProtectedPath(request.url)) return reply.callNotFound();
    const relative = request.params['*'];
    if (isFileRequest(relative)) return reply.sendFile(relative);
    return sendPage(request, reply);
  });
}
