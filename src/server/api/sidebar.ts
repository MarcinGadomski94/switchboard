import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { parseRemoteId } from '../../core/peers.ts';
import {
  type SidebarLayout,
  addFolder,
  moveFolder,
  parseFolderCreate,
  parseFolderMove,
  parseFolderPatch,
  parsePlaceInput,
  placeSession,
  removeFolder,
  updateFolder,
} from '../../core/sidebar-layout.ts';
import type { ApiContext } from '../routes.ts';

interface FolderParams {
  /** Not `id`: the peers' forwarding (`registerPeerForwarding`) reads `:id` params. */
  readonly folderId: string;
}

function invalid(reply: FastifyReply, errors: ReadonlyArray<{ readonly field: string; readonly message: string }>): FastifyReply {
  return reply.code(422).send({ error: 'invalid', errors });
}

function noFolder(reply: FastifyReply, id: string): FastifyReply {
  return reply.code(404).send({ error: 'not-found', message: `no sidebar folder ${id}` });
}

/**
 * Registers the sidebar layout routes (D54, additive, `docs/sidebar.md`,
 * `contracts/local-api.md` → *Sidebar pins and folders (D54)*): pins, folders,
 * their order and collapsed state, stored in this service's database and the
 * same in every tab. Each write answers the whole new layout and publishes it as
 * `sidebarLayoutChanged`. The layout is this machine's: none of these routes is
 * on the peer API's allow-list, and session ids travel in the body (a paired
 * machine's remote id is placed here, never forwarded to the peer).
 */
export async function registerSidebarRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { store, bus } = context;

  const changed = (layout: SidebarLayout): SidebarLayout => {
    bus.publish('sidebarLayoutChanged', layout);
    return layout;
  };

  /** A session id this machine knows: one of its sessions, or one of a paired machine's. */
  const known = async (sessionId: string): Promise<boolean> => {
    const remote = parseRemoteId(sessionId);
    if (remote) return (await store.machines.get(remote.machineId)) !== null;
    return (await store.sessions.get(sessionId)) !== null;
  };

  app.get('/api/sidebar', async (): Promise<SidebarLayout> => store.sidebar.read());

  app.post('/api/sidebar/folders', async (request, reply): Promise<SidebarLayout | FastifyReply> => {
    const input = parseFolderCreate(request.body);
    if (!input.ok) return invalid(reply, input.errors);
    const id = randomUUID();
    const layout = await store.sidebar.update((current) => addFolder(current, id, input.value.name));
    return reply.code(201).send(changed(layout as SidebarLayout));
  });

  app.put<{ Params: FolderParams }>('/api/sidebar/folders/:folderId', async (request, reply): Promise<SidebarLayout | FastifyReply> => {
    const patch = parseFolderPatch(request.body);
    if (!patch.ok) return invalid(reply, patch.errors);
    const layout = await store.sidebar.update((current) => updateFolder(current, request.params.folderId, patch.value));
    return layout ? changed(layout) : noFolder(reply, request.params.folderId);
  });

  app.put<{ Params: FolderParams }>('/api/sidebar/folders/:folderId/position', async (request, reply): Promise<SidebarLayout | FastifyReply> => {
    const move = parseFolderMove(request.body);
    if (!move.ok) return invalid(reply, move.errors);
    const layout = await store.sidebar.update((current) => moveFolder(current, request.params.folderId, move.value.index));
    return layout ? changed(layout) : noFolder(reply, request.params.folderId);
  });

  app.delete<{ Params: FolderParams }>('/api/sidebar/folders/:folderId', async (request, reply): Promise<SidebarLayout | FastifyReply> => {
    const layout = await store.sidebar.update((current) => removeFolder(current, request.params.folderId));
    return layout ? changed(layout) : noFolder(reply, request.params.folderId);
  });

  app.post('/api/sidebar/place', async (request, reply): Promise<SidebarLayout | FastifyReply> => {
    const input = parsePlaceInput(request.body);
    if (!input.ok) return invalid(reply, input.errors);
    const { value } = input;
    if (!(await known(value.sessionId))) return reply.code(404).send({ error: 'not-found', message: `no session ${value.sessionId}` });
    const layout = await store.sidebar.update((current) => placeSession(current, value));
    return layout ? changed(layout) : noFolder(reply, value.folderId ?? '');
  });
}
