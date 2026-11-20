import { realpath } from 'node:fs/promises';
import path from 'node:path';
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isRemoteId } from '../../core/peers.ts';
import { AGENT_TERMINAL_GRACE_MS, TERMINAL_SHELLS, type TerminalShell, type TerminalsView, terminalSize } from '../../core/terminals.ts';
import type { FolderService } from '../folders/service.ts';
import type { PeerService } from '../peers/service.ts';
import { CLOSE_PEER_UNREACHABLE, pipeToPeer, serveTerminalSocket } from '../terminals/socket.ts';
import { TerminalError, type TerminalProgram, type TerminalService, availableShells, resolveShell } from '../terminals/service.ts';

/**
 * D170 · the terminals' routes (`docs/terminals.md`, contract → *Terminals*), every one behind the
 * same guard as the rest of `/api` (Host, Origin, the token cookie; a paired phone's device
 * credential, D73; the request's profile, D165):
 *
 * - `GET /api/terminals` → {@link TerminalsView}: this computer's terminals of the request's profile.
 * - `POST /api/terminals` `{ shell?, folderId?, cwd?, cols?, rows? }` → 201 the terminal. The start
 *   folder is the home folder, a saved folder this profile sees (`folderId`), or a path inside one
 *   (or home): anything else 403 `outside`. 409 `too-many` at the cap; 503 `unavailable` when the
 *   pseudo-terminal cannot start; 403 `choose-profile` for a browser in no profile.
 * - `GET /api/terminals/{id}` · `DELETE /api/terminals/{id}` (204): one terminal; another profile's is 404.
 * - `GET /api/terminals/{id}/socket` (WebSocket): attach (frames: `src/core/terminals.ts`).
 * - D182 `POST /api/sessions/{id}/terminal` `{ shell?, cols?, rows? }` → 201 the terminal at the bottom
 *   of the agent's conversation, in the agent's folder (`cwd`, else its root) on this computer: not
 *   listed, closed {@link AGENT_TERMINAL_GRACE_MS} after its last tab (the page also closes it when you
 *   leave). 409 `closed`, `folder-missing`; 404 another profile's agent (the D165 guard) or none.
 *   D182 follow-up 2026-11-20: a paired computer's agent (`r~<machine>~<id>`) is forwarded to its
 *   computer like every session route (on the peer API there): the terminal starts there, in the
 *   agent's folder, and is reached through `/api/machines/{machineId}/api/terminals/{id}…` (socket, close).
 *   409 `remote` only for a remote id that reached this handler unforwarded (a peer's own request).
 * - `GET /api/machines/{machineId}/api/terminals/{id}/socket` (WebSocket): a paired computer's
 *   terminal, piped through the peer link (`/peer/v1/terminals/{id}/socket`). Its other routes go
 *   through the paired-machine proxy as `/api/machines/{machineId}/api/terminals…`.
 */
/** `SWITCHBOARD_TEST_TERMINAL_ARGV` (tests only): a JSON argv run instead of the shell; `null` when unset or malformed. */
function testProgram(value: string | undefined): TerminalProgram | null {
  if (!value) return null;
  try {
    const argv = JSON.parse(value) as unknown;
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === 'string')) return null;
    return { file: argv[0] as string, args: argv.slice(1) as string[], title: 'Test program', shell: 'program' };
  } catch {
    return null;
  }
}

/** D182: what the agent's terminal needs of a session record. */
export interface AgentTerminalSession {
  readonly cwd: string | null;
  readonly root: string | null;
  readonly closedAt: string | null;
  readonly userProfileId?: string | null;
}

export async function registerTerminalRoutes(
  app: FastifyInstance,
  options: {
    readonly terminals: TerminalService;
    readonly folders: FolderService;
    readonly peers: PeerService;
    /** D182: an agent's record (its folder and profile), `null` when there is none. */
    readonly session?: (id: string) => Promise<AgentTerminalSession | null>;
    /** D182: how long an agent's terminal outlives its last tab (tests shorten it). */
    readonly agentTerminalGraceMs?: number;
  },
): Promise<void> {
  const { terminals, folders, peers } = options;

  const send = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof TerminalError) return reply.code(error.status).header('cache-control', 'no-store').send({ error: error.code, message: error.message });
    throw error;
  };

  /** The start folder of a new terminal, checked against the home folder and this profile's saved folders. */
  const startFolder = async (body: Record<string, unknown>): Promise<string> => {
    const home = await realpath(terminals.home).catch(() => terminals.home);
    if (typeof body['folderId'] === 'string' && body['folderId'] !== '') {
      try {
        const folder = await folders.get(body['folderId']);
        return await realpath(folder.canonicalPath).catch(() => folder.canonicalPath);
      } catch {
        throw new TerminalError(404, 'not-found', `no saved folder ${body['folderId']}`);
      }
    }
    if (typeof body['cwd'] !== 'string' || body['cwd'] === '') return home;
    if (!path.isAbsolute(body['cwd'])) throw new TerminalError(422, 'invalid', 'The start folder must be an absolute path.');
    const wanted = await realpath(body['cwd']).catch(() => null);
    if (!wanted) throw new TerminalError(404, 'not-found', `${body['cwd']} does not exist`);
    const inside = (root: string): boolean => {
      const rel = path.relative(root, wanted);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };
    if (inside(home)) return wanted;
    for (const folder of await folders.list()) {
      const root = await realpath(folder.canonicalPath).catch(() => folder.canonicalPath);
      if (inside(root)) return wanted;
    }
    throw new TerminalError(403, 'outside', 'A terminal starts in your home folder or a saved folder of this profile.');
  };

  app.get('/api/terminals', async (request): Promise<TerminalsView> => {
    const shells = await availableShells(terminals.platform, terminals.env);
    return { terminals: terminals.list(request.userProfileScope), shells, home: terminals.home, max: terminals.max };
  });

  app.post('/api/terminals', async (request, reply) => {
    try {
      const scope = request.userProfileScope;
      if (scope === null) throw new TerminalError(403, 'choose-profile', 'Choose a profile first.');
      const body = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
      const shell: TerminalShell = typeof body['shell'] === 'string' && (TERMINAL_SHELLS as readonly string[]).includes(body['shell']) ? (body['shell'] as TerminalShell) : 'default';
      // Tests of separate server processes (two paired computers) run a deterministic program, never a real shell.
      const testArgv = testProgram(terminals.env['SWITCHBOARD_TEST_TERMINAL_ARGV']);
      const program = testArgv ?? (await resolveShell(shell, terminals.platform, terminals.env));
      if (!program) throw new TerminalError(422, 'no-shell', `${shell} is not installed on this computer.`);
      const cwd = await startFolder(body);
      const { cols, rows } = terminalSize(body['cols'], body['rows']);
      const info = await terminals.create({ program, cwd, owner: scope === '*' ? null : scope, cols, rows });
      return reply.code(201).header('cache-control', 'no-store').send(info);
    } catch (error) {
      return send(reply, error);
    }
  });

  // D182: the terminal at the bottom of an agent's conversation, in the agent's own folder on this
  // computer (the D165 guard already answered 404 for another profile's agent).
  app.post<{ Params: { id: string } }>('/api/sessions/:id/terminal', async (request, reply) => {
    try {
      const scope = request.userProfileScope;
      if (scope === null) throw new TerminalError(403, 'choose-profile', 'Choose a profile first.');
      // A paired computer's agent is forwarded before this handler (registerPeerForwarding); only a peer's own request gets here with one.
      if (isRemoteId(request.params.id)) throw new TerminalError(409, 'remote', 'This agent runs on another computer: open a terminal there.');
      const record = options.session ? await options.session(request.params.id) : null;
      if (!record) throw new TerminalError(404, 'not-found', `no agent ${request.params.id}`);
      if (record.closedAt) throw new TerminalError(409, 'closed', 'This agent is archived.');
      const folder = record.cwd ?? record.root;
      const cwd = folder ? await realpath(folder).catch(() => null) : null;
      if (!cwd) throw new TerminalError(409, 'folder-missing', 'The agent’s folder is not on this computer any more.');
      const body = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
      const shell: TerminalShell = typeof body['shell'] === 'string' && (TERMINAL_SHELLS as readonly string[]).includes(body['shell']) ? (body['shell'] as TerminalShell) : 'default';
      const program = testProgram(terminals.env['SWITCHBOARD_TEST_TERMINAL_ARGV']) ?? (await resolveShell(shell, terminals.platform, terminals.env));
      if (!program) throw new TerminalError(422, 'no-shell', `${shell} is not installed on this computer.`);
      const { cols, rows } = terminalSize(body['cols'], body['rows']);
      const owner = scope === '*' ? (record.userProfileId ?? null) : scope;
      const info = await terminals.create({ program, cwd, owner, cols, rows, agent: { sessionId: request.params.id, closeUnattendedMs: options.agentTerminalGraceMs ?? AGENT_TERMINAL_GRACE_MS } });
      return reply.code(201).header('cache-control', 'no-store').send(info);
    } catch (error) {
      return send(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/api/terminals/:id', async (request, reply) => {
    try {
      return terminals.get(request.userProfileScope, request.params.id);
    } catch (error) {
      return send(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/terminals/:id', async (request, reply) => {
    try {
      terminals.close(request.userProfileScope, request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return send(reply, error);
    }
  });

  // The sockets: the guard (Host, Origin, cookie / device credential) and the profile scope ran on the upgrade.
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  await app.register(async (scope) => {
    scope.get<{ Params: { id: string } }>('/api/terminals/:id/socket', { websocket: true }, (socket, request) => {
      serveTerminalSocket(terminals, request.userProfileScope, request.params.id, socket);
    });
    scope.get<{ Params: { id: string; terminalId: string } }>('/api/machines/:id/api/terminals/:terminalId/socket', { websocket: true }, (socket, request) => {
      const profile = request.userProfileScope;
      if (profile === null) {
        socket.close(4404, 'not found');
        return;
      }
      // Messages typed before the paired computer answered are held, then sent in order.
      const held: Buffer[] = [];
      const hold = (raw: Buffer): void => {
        held.push(raw);
      };
      socket.on('message', hold);
      peers.openTerminalSocket(request.params.id, request.params.terminalId, profile === '*' ? null : profile).then(
        (peer) => {
          socket.off('message', hold);
          pipeToPeer(socket, peer);
          for (const raw of held) peer.send(raw.toString('utf8'));
        },
        () => socket.close(CLOSE_PEER_UNREACHABLE, 'unreachable'),
      );
    });
  });
}
