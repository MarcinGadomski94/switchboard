import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ArtifactKind, ArtifactListItem } from '../../core/api.ts';
import { ARTIFACT_SAVE_BODY_MAX, artifactExtension, artifactFileName, isArtifactKind } from '../../core/artifacts.ts';
import { AGENT_SESSION_HEADER } from '../../core/todos.ts';
import { ArtifactError } from '../artifacts/service.ts';
import type { ApiContext } from '../routes.ts';
import { contentDisposition } from './attachments.ts';
import { isPeerRequest } from './machines.ts';
import type { PendingRoute } from './not-implemented.ts';

/** Artifact routes (contract → REST) not implemented yet: none. */
export const ARTIFACT_ROUTES_PENDING: readonly PendingRoute[] = [];

/** D89: the raw route (a version's bytes); the peers' proxy passes its answer on as bytes. */
export const ARTIFACT_RAW_ROUTE = '/api/sessions/:id/artifacts/:artifactId/versions/:n/raw';

/**
 * D89: the CSP of an `html` version. `sandbox allow-scripts` (no
 * `allow-same-origin`) gives the page an opaque origin even when it is opened on
 * its own, so it never reaches the app's cookie, storage or API; `default-src
 * 'none'` lets its own inline scripts, styles and `data:` images run and nothing
 * load or connect; only the app may frame it.
 */
export const HTML_ARTIFACT_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/** D89: the CSP of every other version: nothing runs or loads (an SVG's scripts included); only the app may frame it. */
export const STATIC_ARTIFACT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'";

/**
 * D89 (`docs/security.md` → *Artifacts*): the headers a version is served with:
 * `html` as `text/html` under {@link HTML_ARTIFACT_CSP}; `svg` as `image/svg+xml`
 * and images as their sniffed type, under {@link STATIC_ARTIFACT_CSP}; every other
 * text as `text/plain` (never rendered by the browser). `?download` makes it an
 * attachment named after the title (`text/csv` for a CSV). Always `nosniff`.
 */
export function artifactHeaders(
  artifact: { readonly kind: ArtifactKind; readonly title: string; readonly language: string | null },
  mediaType: string | null,
  download: boolean,
): Record<string, string> {
  const name = artifactFileName(artifact.title, artifactExtension(artifact.kind, artifact.language, mediaType));
  const type =
    artifact.kind === 'html'
      ? 'text/html; charset=utf-8'
      : artifact.kind === 'svg'
        ? 'image/svg+xml'
        : artifact.kind === 'image'
          ? (mediaType ?? 'application/octet-stream')
          : artifact.kind === 'csv' && download
            ? 'text/csv; charset=utf-8'
            : 'text/plain; charset=utf-8';
  return {
    'content-type': type,
    'content-disposition': contentDisposition(download ? 'attachment' : 'inline', name),
    'x-content-type-options': 'nosniff',
    'content-security-policy': artifact.kind === 'html' ? HTML_ARTIFACT_CSP : STATIC_ARTIFACT_CSP,
    'cache-control': 'private, max-age=3600',
    'cross-origin-resource-policy': 'same-origin',
  };
}

function sendArtifactError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ArtifactError) return reply.code(error.status).send(error.body());
  throw error;
}

/** The session the agent token was checked for (`security.ts` refused the request without a valid one). */
function agentSession(request: FastifyRequest): string {
  const value = request.headers[AGENT_SESSION_HEADER];
  return typeof value === 'string' ? value : '';
}

function lastValue(raw: unknown): string {
  const value = Array.isArray(raw) ? raw.at(-1) : raw;
  return typeof value === 'string' ? value : '';
}

/** D89: the Artifacts page's filters: `kind` (kinds separated by commas; an unknown one matches nothing), `session` (a session id), `q` (title, kind, language, session, machine). */
export function filterArtifacts(items: readonly ArtifactListItem[], query: { readonly q?: string; readonly kind?: string; readonly session?: string }): ArtifactListItem[] {
  const kinds = (query.kind ?? '')
    .split(',')
    .map((kind) => kind.trim().toLowerCase())
    .filter((kind) => kind !== '');
  const needle = (query.q ?? '').trim().toLowerCase();
  const session = (query.session ?? '').trim();
  return items.filter((item) => {
    if (kinds.length > 0 && !kinds.some((kind) => isArtifactKind(kind) && kind === item.kind)) return false;
    if (session !== '' && item.sessionId !== session) return false;
    if (needle === '') return true;
    const text = [item.title, item.kind, item.language ?? '', item.sessionName ?? '', item.sessionTitle ?? '', item.machine?.name ?? ''].join(' ').toLowerCase();
    return text.includes(needle);
  });
}

/**
 * D89 · artifacts saved on purpose (`docs/artifacts.md`; contract: the D89 section
 * of `docs/handoff/contracts/local-api.md`):
 *
 * - `GET /api/artifacts?q=&kind=&session=` → {@link ArtifactListItem}[]: this
 *   machine's and (D48) the paired machines' (as last known), newest first.
 * - `GET /api/sessions/{id}/artifacts` → `Artifact[]`; `POST` (Save as artifact)
 *   `ArtifactSaveInput` (no `path`) → 201 `ArtifactSaveResult`.
 * - `GET /api/sessions/{id}/artifacts/{artifactId}[?version=n]` → `ArtifactDetail`;
 *   `DELETE` → 204.
 * - `GET …/{artifactId}/versions/{n}/raw[?download]` → the version's bytes
 *   ({@link artifactHeaders}); D89 ruling: `?render` on a Mermaid version → the
 *   sandboxed page that draws it (`mermaidPage`), under {@link HTML_ARTIFACT_CSP}.
 * - The agent's (`artifact_*` tools): `GET /agent/v1/artifacts`, `POST
 *   /agent/v1/artifacts` (`path` allowed), `GET /agent/v1/artifacts/{artifactId}[?version=n]`:
 *   the session is the one the agent token belongs to.
 *
 * A peer's session (`r~<machine>~<id>`) is forwarded to its machine like every session route.
 */
export async function registerArtifactRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { artifacts } = context;

  app.get<{ Querystring: { q?: string | string[]; kind?: string | string[]; session?: string | string[] } }>('/api/artifacts', async (request): Promise<ArtifactListItem[]> => {
    const local = await artifacts.listAll();
    const all = isPeerRequest(request) ? local : [...local, ...context.peers.remoteArtifacts()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return filterArtifacts(all, { q: lastValue(request.query.q), kind: lastValue(request.query.kind), session: lastValue(request.query.session) });
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/artifacts', async (request, reply) => {
    try {
      return await artifacts.list(request.params.id);
    } catch (error) {
      return sendArtifactError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/artifacts', { bodyLimit: ARTIFACT_SAVE_BODY_MAX }, async (request, reply) => {
    try {
      return reply.code(201).send(await artifacts.save(request.params.id, request.body, 'developer'));
    } catch (error) {
      return sendArtifactError(reply, error);
    }
  });

  app.get<{ Params: { id: string; artifactId: string }; Querystring: { version?: string } }>('/api/sessions/:id/artifacts/:artifactId', async (request, reply) => {
    try {
      return await artifacts.detail(request.params.id, request.params.artifactId, request.query.version);
    } catch (error) {
      return sendArtifactError(reply, error);
    }
  });

  app.delete<{ Params: { id: string; artifactId: string } }>('/api/sessions/:id/artifacts/:artifactId', async (request, reply) => {
    try {
      await artifacts.remove(request.params.id, request.params.artifactId);
      return reply.code(204).send();
    } catch (error) {
      return sendArtifactError(reply, error);
    }
  });

  app.get<{ Params: { id: string; artifactId: string; n: string }; Querystring: { download?: unknown; render?: unknown } }>(ARTIFACT_RAW_ROUTE, async (request, reply) => {
    try {
      const raw = await artifacts.raw(request.params.id, request.params.artifactId, request.params.n);
      // D89 ruling: `?render` on a Mermaid version: the page that draws it, sandboxed like an HTML artifact.
      const page = request.query.render !== undefined && request.query.download === undefined ? await artifacts.mermaidView(raw) : null;
      if (page !== null) {
        for (const [name, value] of Object.entries(artifactHeaders({ ...raw.artifact, kind: 'html' }, null, false))) reply.header(name, value);
        return reply.send(page);
      }
      for (const [name, value] of Object.entries(artifactHeaders(raw.artifact, raw.version.mediaType, request.query.download !== undefined))) reply.header(name, value);
      return reply.send(raw.bytes);
    } catch (error) {
      return sendArtifactError(reply, error);
    }
  });

  // ── the agent's routes (the `switchboard` MCP helper's artifact_* tools) ──

  app.get('/agent/v1/artifacts', async (request, reply) => {
    try {
      return await artifacts.list(agentSession(request));
    } catch (error) {
      return sendArtifactError(reply, error);
    }
  });

  app.post('/agent/v1/artifacts', { bodyLimit: ARTIFACT_SAVE_BODY_MAX }, async (request, reply) => {
    try {
      return reply.code(201).send(await artifacts.save(agentSession(request), request.body, 'agent'));
    } catch (error) {
      return sendArtifactError(reply, error);
    }
  });

  app.get<{ Params: { artifactId: string }; Querystring: { version?: string } }>('/agent/v1/artifacts/:artifactId', async (request, reply) => {
    try {
      return await artifacts.detail(agentSession(request), request.params.artifactId, request.query.version);
    } catch (error) {
      return sendArtifactError(reply, error);
    }
  });
}
