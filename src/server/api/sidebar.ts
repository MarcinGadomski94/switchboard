import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isCrewPinId } from '../../core/crew-pins.ts';
import { parseRemoteId } from '../../core/peers.ts';
import {
  type SidebarLayout,
  type SidebarTreeProblem,
  addFolder,
  checkFolderParent,
  moveFolder,
  parseFolderCreate,
  parseFolderMove,
  parseFolderPatch,
  parsePlaceInput,
  placeSession,
  removeFolder,
  updateFolder,
} from '../../core/sidebar-layout.ts';
import {
  type FolderArchiveAgent,
  type FolderArchiveCandidate,
  type FolderArchiveHolds,
  type SidebarFolderArchiveResult,
  folderSessionIds,
  removeFolderTree,
  splitFolderArchive,
} from '../../core/sidebar-folder-archive.ts';
import type { SidebarWrite } from '../db/repos/sidebar.ts';
import { plansArchiveHolds } from '../plans/hooks.ts';
import { closeSession } from '../sessions/close.ts';
import { SupervisorError } from '../supervisor/supervisor.ts';
import { teamMemberOf } from '../team/hooks.ts';
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

/** D141: `?archive=1` (or `true`) archives the folder's agents; absent, `0` or `false` = D54 / D58's delete; anything else `null`. */
function parseArchiveFlag(value: string | undefined): boolean | null {
  if (value === undefined || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  return null;
}

/** D58: a refused place in the folder tree: 404 for an unknown folder, 422 on `parentId` for a loop or too deep. */
function treeRefusal(reply: FastifyReply, problem: SidebarTreeProblem): FastifyReply {
  return problem.kind === 'not-found' ? noFolder(reply, problem.id) : invalid(reply, [{ field: 'parentId', message: problem.message }]);
}

/**
 * Registers the sidebar layout routes (D54, additive, `docs/sidebar.md`,
 * `contracts/local-api.md` → *Sidebar pins and folders (D54)* and *Subfolders
 * in the sidebar (D58)*): pins, folders (D58: in folders, with no loops and at
 * most five levels), their order and collapsed state, stored in this service's database and the
 * same in every tab. Each write answers the whole new layout and publishes it as
 * `sidebarLayoutChanged`. None of these routes is on the peer API's allow-list,
 * and session ids travel in the body (a paired machine's remote id is placed
 * here, never forwarded to the peer). D71: the records a write changed go to
 * the paired machines the layout is shared with (`PeerService.sidebarChanged`,
 * `docs/peers.md` → *Shared sidebar layout (D71)*); D71 M2: a loose `index`
 * counts in the whole loose list (the unplaced sessions first). D141: a folder
 * delete with `?archive=1` archives the agents in it and its subfolders first
 * (`docs/sidebar.md` → *Delete a folder and archive its agents (D141)*).
 */
export async function registerSidebarRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { store, bus, supervisor, peers } = context;

  /** Publishes the new layout (every tab) and hands the records written to the D71 sync (the paired machines it is on with). */
  const changed = (write: SidebarWrite): SidebarLayout => {
    bus.publish('sidebarLayoutChanged', write.layout);
    peers.sidebarChanged(write.changes);
    return write.layout;
  };

  /** D71: the listed (open) sessions' ids in the service's order (`GET /api/sessions`): a loose drop's index counts in them. */
  const listed = async (): Promise<string[]> => {
    const records = (await store.sessions.list({ closed: false })).filter((record) => !supervisor.isStarting(record.id));
    return [...records.map((record) => record.id), ...peers.remoteSessions().map((session) => session.id)];
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
    const parentId = input.value.parentId ?? null;
    let problem: SidebarTreeProblem | null = null;
    const layout = await store.sidebar.change((current) => {
      problem = checkFolderParent(current, null, parentId);
      return problem ? null : addFolder(current, id, input.value.name, parentId);
    });
    if (!layout) return treeRefusal(reply, problem ?? { kind: 'not-found', id: parentId ?? '' });
    return reply.code(201).send(changed(layout));
  });

  app.put<{ Params: FolderParams }>('/api/sidebar/folders/:folderId', async (request, reply): Promise<SidebarLayout | FastifyReply> => {
    const patch = parseFolderPatch(request.body);
    if (!patch.ok) return invalid(reply, patch.errors);
    const layout = await store.sidebar.change((current) => updateFolder(current, request.params.folderId, patch.value));
    return layout ? changed(layout) : noFolder(reply, request.params.folderId);
  });

  app.put<{ Params: FolderParams }>('/api/sidebar/folders/:folderId/position', async (request, reply): Promise<SidebarLayout | FastifyReply> => {
    const move = parseFolderMove(request.body);
    if (!move.ok) return invalid(reply, move.errors);
    const { folderId } = request.params;
    let problem: SidebarTreeProblem | null = null;
    const layout = await store.sidebar.change((current) => {
      const folder = current.folders.find((f) => f.id === folderId);
      if (!folder) {
        problem = { kind: 'not-found', id: folderId };
        return null;
      }
      // D58: `parentId` absent = the level it is at (D54's re-order).
      problem = checkFolderParent(current, folderId, move.value.parentId === undefined ? (folder.parentId ?? null) : move.value.parentId);
      return problem ? null : moveFolder(current, folderId, move.value.index, move.value.parentId);
    });
    return layout ? changed(layout) : treeRefusal(reply, problem ?? { kind: 'not-found', id: folderId });
  });

  app.delete<{ Params: FolderParams; Querystring: { archive?: string } }>('/api/sidebar/folders/:folderId', async (request, reply): Promise<SidebarLayout | SidebarFolderArchiveResult | FastifyReply> => {
    const archive = parseArchiveFlag(request.query.archive);
    if (archive === null) return invalid(reply, [{ field: 'archive', message: 'archive must be 1 or 0' }]);
    const { folderId } = request.params;
    if (!archive) {
      const layout = await store.sidebar.change((current) => removeFolder(current, folderId));
      return layout ? changed(layout) : noFolder(reply, folderId);
    }
    // D141: archive the agents in the folder and its subfolders (those nothing holds back), then delete the whole subtree.
    const before = await store.sidebar.read();
    if (!before.folders.some((f) => f.id === folderId)) return noFolder(reply, folderId);
    const candidates = await folderCandidates(before, folderId);
    const { archive: toArchive, kept } = splitFolderArchive(candidates, await archiveHolds(before, candidates.map((c) => c.sessionId)));
    const archived: FolderArchiveAgent[] = [];
    const outcomes = await Promise.all(toArchive.map(async (candidate) => ({ candidate, failure: await archiveOne(candidate.sessionId) })));
    for (const { candidate, failure } of outcomes) {
      const agent: FolderArchiveAgent = { sessionId: candidate.sessionId, name: candidate.name, machine: candidate.machine?.name ?? null };
      if (failure === null) archived.push(agent);
      else kept.push({ ...agent, reason: 'failed', message: failure });
    }
    const write = await store.sidebar.change((current) => removeFolderTree(current, folderId));
    // Deleted meanwhile (another tab): the archiving stands; the layout is the current one.
    const layout = write ? changed(write) : await store.sidebar.read();
    return { layout, archived, kept } satisfies SidebarFolderArchiveResult;
  });

  /** D141: the listed (open) agents placed in the folder or its subfolders, this machine's and the paired computers'. */
  const folderCandidates = async (layout: SidebarLayout, folderId: string): Promise<FolderArchiveCandidate[]> => {
    const local = new Map((await store.sessions.list({ closed: false })).filter((record) => !supervisor.isStarting(record.id)).map((record) => [record.id, record]));
    const remote = new Map(peers.remoteSessions().map((session) => [session.id, session]));
    const out: FolderArchiveCandidate[] = [];
    for (const id of folderSessionIds(layout, folderId)) {
      const record = local.get(id);
      if (record) {
        out.push({ sessionId: id, name: record.title ?? record.name, machine: null });
        continue;
      }
      const session = remote.get(id);
      if (session) out.push({ sessionId: id, name: session.displayTitle ?? session.title ?? session.name, machine: { name: session.machine?.name ?? '', online: session.machine?.state === 'online' } });
    }
    return out;
  };

  /** D141: the archive's own holds (D137) that keep an agent out of a folder delete: pinned, a crew member, a plan's source or running step. */
  const archiveHolds = async (layout: SidebarLayout, ids: readonly string[]): Promise<FolderArchiveHolds> => {
    // Plans not ready (`null`): nothing is known to hold (the agents' plans may still be loading); the close itself never deletes anything.
    const plans = (await plansArchiveHolds(store)) ?? new Map<string, 'plan' | 'plan-step'>();
    return { pinned: new Set(layout.pinned), crew: new Set(ids.filter((id) => teamMemberOf(store, id) !== null)), plans };
  };

  /** D141: archives one agent the way Archive does (D33 / D137): this computer's here, a paired computer's on it through the proxy (D48). `null` = archived, else why not. */
  const archiveOne = async (sessionId: string): Promise<string | null> => {
    const remote = parseRemoteId(sessionId);
    if (remote) {
      const answer = await peers.forward(remote.machineId, 'POST', `/api/sessions/${encodeURIComponent(remote.id)}/close`, { confirm: true });
      if (answer.status >= 200 && answer.status < 300) return null;
      const body = answer.body as { message?: unknown } | null;
      return typeof body?.message === 'string' ? body.message : `HTTP ${answer.status}`;
    }
    try {
      await closeSession(context, sessionId, true);
      return null;
    } catch (error) {
      if (error instanceof SupervisorError) return error.message;
      throw error;
    }
  };

  app.post('/api/sidebar/place', async (request, reply): Promise<SidebarLayout | FastifyReply> => {
    const input = parsePlaceInput(request.body);
    if (!input.ok) return invalid(reply, input.errors);
    const { value } = input;
    // 2.4.4: a pinned crew (`crew~<team id>`, `docs/sidebar.md` → *Pinned crews*) is only ever pinned or unpinned (no folder, no loose order).
    if (isCrewPinId(value.sessionId)) {
      if (value.place === 'folder' || (value.place === 'loose' && value.index !== undefined)) return invalid(reply, [{ field: 'place', message: 'a crew is only pinned or unpinned' }]);
      const write = await store.sidebar.change((current) => placeSession(current, value));
      return write ? changed(write) : store.sidebar.read();
    }
    if (!(await known(value.sessionId))) return reply.code(404).send({ error: 'not-found', message: `no session ${value.sessionId}` });
    // D71: a loose drop at a position counts in the whole loose list as shown (the unplaced sessions first).
    const order = value.place === 'loose' && value.index !== undefined ? await listed() : [];
    const layout = await store.sidebar.change((current) => placeSession(current, value, order));
    return layout ? changed(layout) : noFolder(reply, value.folderId ?? '');
  });
}
