import type { FastifyInstance, FastifyReply } from 'fastify';
import { parseServerInput } from '../../core/mcp.ts';
import { McpError, type McpFolder, type McpService } from '../mcp/service.ts';
import type { ApiContext } from '../routes.ts';
import { sendFolderError } from './folders.ts';

interface FolderQuery {
  readonly folder?: string;
  readonly scope?: string;
}

interface NameParams {
  readonly name: string;
}

function sendMcpError(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof McpError)) throw error;
  return reply.code(error.status).send({
    error: error.code,
    message: error.message,
    ...(error.field ? { errors: [{ field: error.field, message: error.message }] } : {}),
    ...(error.commands.length > 0 ? { commands: error.commands } : {}),
  });
}

/**
 * D61: the MCP servers page (`docs/mcp.md`, contract → *D61*). Every route takes
 * `?folder=` (a saved folder's id or path; the default folder when omitted) and
 * sits behind the usual Host/Origin guard and `sb_token` cookie; none returns a
 * secret value.
 *
 * - `GET /api/mcp` → `McpView`
 * - `POST /api/mcp/check` `{ name? }` → `McpActionResult` (`claude mcp get <name>`, or all: `mcp_status`)
 * - `POST /api/mcp/servers` `McpServerInput` → `201 McpActionResult` (`claude mcp add-json`)
 * - `GET /api/mcp/servers/{name}?scope=` → `McpServerDefinition` (the Edit form)
 * - `PUT /api/mcp/servers/{name}?scope=` `McpServerInput` → `McpActionResult` (remove + add-json)
 * - `DELETE /api/mcp/servers/{name}?scope=` → `McpActionResult` (`claude mcp remove`)
 * - `POST /api/mcp/servers/{name}/reconnect` → `McpActionResult` (`mcp_reconnect`)
 * - `POST /api/mcp/servers/{name}/toggle` `{ enabled }` → `McpActionResult` (`mcp_toggle`)
 * - `POST /api/mcp/servers/{name}/auth` `{ reset? }` → `McpAuthState` (`mcp_authenticate`)
 * - `GET /api/mcp/auth/{id}` → `McpAuthState`; `POST /api/mcp/auth/{id}/callback` `{ callbackUrl }`; `DELETE /api/mcp/auth/{id}`
 *
 * Errors: 422 `invalid` (with `errors[]`) / `read-only`, 404 `not-found`, 409
 * `cli-failed` (the CLI's words, secrets masked, and the `commands` it ran).
 */
export async function registerMcpRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { mcp, folders, store } = context;

  const folderOf = async (param: string | undefined): Promise<McpFolder> => {
    const ref = await folders.resolveForView(param);
    const record = ref.id ? await store.folders.get(ref.id) : null;
    return { id: ref.id, path: ref.path, root: ref.root, label: record?.label ?? null };
  };

  const handle = async <T>(reply: FastifyReply, folderParam: string | undefined, run: (folder: McpFolder, service: McpService) => Promise<T>): Promise<T | FastifyReply> => {
    let folder: McpFolder;
    try {
      folder = await folderOf(folderParam);
    } catch (error) {
      return sendFolderError(reply, error);
    }
    try {
      return await run(folder, mcp);
    } catch (error) {
      return sendMcpError(reply, error);
    }
  };

  app.get<{ Querystring: FolderQuery }>('/api/mcp', (request, reply) => handle(reply, request.query.folder, (folder, service) => service.view(folder)));

  app.post<{ Querystring: FolderQuery }>('/api/mcp/check', (request, reply) => {
    const name = (request.body as { name?: unknown } | null)?.name;
    return handle(reply, request.query.folder, (folder, service) => service.check(folder, typeof name === 'string' && name !== '' ? name : undefined));
  });

  app.post<{ Querystring: FolderQuery }>('/api/mcp/servers', async (request, reply) => {
    const parsed = parseServerInput(request.body);
    if (!parsed.ok) return reply.code(422).send({ error: 'invalid', message: parsed.errors[0]?.message ?? 'invalid', errors: parsed.errors });
    const result = await handle(reply, request.query.folder, (folder, service) => service.add(folder, parsed.input));
    return 'view' in (result as object) ? reply.code(201).send(result) : result;
  });

  app.get<{ Querystring: FolderQuery; Params: NameParams }>('/api/mcp/servers/:name', (request, reply) =>
    handle(reply, request.query.folder, (folder, service) => service.definition(folder, request.params.name, request.query.scope ?? '')),
  );

  app.put<{ Querystring: FolderQuery; Params: NameParams }>('/api/mcp/servers/:name', async (request, reply) => {
    const parsed = parseServerInput(request.body);
    if (!parsed.ok) return reply.code(422).send({ error: 'invalid', message: parsed.errors[0]?.message ?? 'invalid', errors: parsed.errors });
    return handle(reply, request.query.folder, (folder, service) => service.edit(folder, request.params.name, request.query.scope ?? '', parsed.input));
  });

  app.delete<{ Querystring: FolderQuery; Params: NameParams }>('/api/mcp/servers/:name', (request, reply) =>
    handle(reply, request.query.folder, (folder, service) => service.remove(folder, request.params.name, request.query.scope ?? '')),
  );

  app.post<{ Querystring: FolderQuery; Params: NameParams }>('/api/mcp/servers/:name/reconnect', (request, reply) =>
    handle(reply, request.query.folder, (folder, service) => service.reconnect(folder, request.params.name)),
  );

  app.post<{ Querystring: FolderQuery; Params: NameParams }>('/api/mcp/servers/:name/toggle', async (request, reply) => {
    const enabled = (request.body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== 'boolean') return reply.code(422).send({ error: 'invalid', message: 'enabled must be true or false', errors: [{ field: 'enabled', message: 'enabled must be true or false' }] });
    return handle(reply, request.query.folder, (folder, service) => service.toggle(folder, request.params.name, enabled));
  });

  app.post<{ Querystring: FolderQuery; Params: NameParams }>('/api/mcp/servers/:name/auth', (request, reply) => {
    const reset = (request.body as { reset?: unknown } | null)?.reset === true;
    return handle(reply, request.query.folder, (folder, service) => service.startAuth(folder, request.params.name, reset));
  });

  app.get<{ Params: { id: string } }>('/api/mcp/auth/:id', async (request, reply) => {
    try {
      return mcp.authState(request.params.id);
    } catch (error) {
      return sendMcpError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/mcp/auth/:id/callback', async (request, reply) => {
    try {
      return await mcp.submitCallback(request.params.id, (request.body as { callbackUrl?: unknown } | null)?.callbackUrl);
    } catch (error) {
      return sendMcpError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/mcp/auth/:id', async (request, reply) => {
    try {
      return await mcp.cancelAuth(request.params.id);
    } catch (error) {
      return sendMcpError(reply, error);
    }
  });
}
