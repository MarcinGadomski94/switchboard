import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { type TeamCharter } from '../../../src/core/team.ts';
import { AGENT_SESSION_HEADER } from '../../../src/core/todos.ts';
import { TEAM_TEMPLATES } from '../../../src/core/team-templates.ts';
import { NO_ATTACHMENTS } from '../../../src/server/attachments/service.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { LoopService } from '../../../src/server/loops/owned.ts';
import { type TeamPeers, TeamService } from '../../../src/server/team/service.ts';
import { agentMcpLaunch } from '../../../src/server/todos/agent-mcp.ts';
import { registerAgentToolRoutes } from '../../../src/server/todos/agent-tools.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { freeTestPorts } from '../../helpers/net.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * 2026-10-16 oracle (`docs/mcp.md` → *Tools that appear without a restart*) on the real spawn
 * path: fake-claude runs the real `switchboard` helper (`FAKE_CLAUDE_MCP_RUN=1`) against a
 * loopback stand-in for Switchboard's agent routes, and logs the tools it holds with every
 * user message. A member whose helper started while the Team probe failed lacks
 * `team_propose_charter`; the D105 charter ask then makes sure the CLI has it before the ask
 * goes out: live (`list_changed`, no restart) when the CLI re-lists, else one `--resume`
 * restart first. Either way the ask arrives with the tool in the agent's list.
 */

const SELF = { id: 'm-mac-0001', name: 'Mac' };
const peers = {
  self: async () => SELF,
  machines: async () => [],
  remoteSessions: () => [],
  remoteArchived: () => [],
  remoteInbox: () => [],
  forward: async () => ({ status: 404, body: { error: 'not-found', message: 'no peers here' } }),
  ask: async () => ({ status: null, reason: 'no peers here' }),
  hasMachine: () => false,
  sidebarChanged: () => undefined,
} as unknown as TeamPeers;

const DEVELOPER = TEAM_TEMPLATES.find((t) => t.id === 'developer')?.charter as TeamCharter;

interface Rig {
  readonly world: SupervisorWorld;
  readonly team: TeamService;
  readonly loops: LoopService;
  readonly todos: TodoService;
  readonly agent: FastifyInstance;
  /** While `true` the Team probe fails (as a timed-out probe at the helper's start). */
  probeFails: boolean;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.team.close();
  await rig?.loops.close();
  rig?.todos.close();
  await rig?.world.cleanup();
  await rig?.agent.close();
  rig = undefined;
});

/** The agent routes the helper calls (no token check here: the stand-in serves this test's sessions only). */
async function agentServer(r: Omit<Rig, 'agent'> & { probeFails: boolean }): Promise<{ app: FastifyInstance; port: number }> {
  for (const port of (await freeTestPorts()).reverse()) {
    const app = Fastify();
    const session = (request: { headers: Record<string, unknown> }) => String(request.headers[AGENT_SESSION_HEADER] ?? '');
    app.get('/agent/v1/team', async (request, reply) => {
      if (r.probeFails || !r.team.memberOfSession(session(request))) return reply.code(404).send({ error: 'not-a-member', message: 'this session is not a team member (or Team is off)' });
      return { member: { id: 'x', name: 'x' } };
    });
    app.get('/agent/v1/plans', async (_request, reply) => reply.code(404).send({ error: 'plans-off', message: 'Plans is off' }));
    app.get('/agent/v1/memory', async (_request, reply) => reply.code(404).send({ error: 'memory-off', message: 'Project memory is off' }));
    await registerAgentToolRoutes(app, r.world.supervisor.agentTools, 1_000);
    try {
      await app.listen({ host: '127.0.0.1', port });
      return { app, port };
    } catch {
      await app.close();
    }
  }
  throw new Error('no free test port');
}

async function setup(listChanged: boolean): Promise<Rig> {
  const world = await makeSupervisorWorld({ parentEnv: { FAKE_CLAUDE_MCP_RUN: '1', FAKE_CLAUDE_MCP_LIST_CHANGED: listChanged ? '1' : '0' }, toolRefreshWaitMs: 2_000 });
  const bus = new HubBus();
  const todos = new TodoService({ store: world.store, bus });
  const loops = new LoopService({ store: world.store, deliver: async (session, text, mark) => void (await world.supervisor.sendMessage(session.id, text, 'service', NO_ATTACHMENTS, { loop: mark })) });
  const team = new TeamService({ dataDir: world.root, store: world.store, bus, supervisor: world.supervisor, loops, todos, peers, takeover: null, isHooked: async () => false, pushDelayMs: 10 });
  const partial = { world, team, loops, todos, probeFails: false };
  const { app, port } = await agentServer(partial);
  // The rig is `partial` itself: the stand-in reads its probeFails.
  const r: Rig = Object.assign(partial, { agent: app });
  rig = r;
  world.supervisor.useAgentMcp(async (session) => agentMcpLaunch({ nodePath: process.execPath, port, sessionId: session.id, token: 'test-token' }));
  await team.init();
  return r;
}

interface LogLine {
  readonly kind: string;
  readonly pid: number;
  readonly line?: string;
  readonly tools?: string[];
}

async function logLines(r: Rig): Promise<LogLine[]> {
  const text = await readFile(r.world.logFile, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogLine);
}

/** The tools the fake held when the stdin user message containing `needle` arrived. */
async function toolsAtMessage(r: Rig, needle: string): Promise<string[] | undefined> {
  const lines = await logLines(r);
  const at = lines.findIndex((line) => line.kind === 'stdin' && typeof line.line === 'string' && line.line.includes(needle));
  if (at < 0) return undefined;
  return lines.slice(at + 1).find((line) => line.kind === 'mcp-tools' && line.pid === lines[at]?.pid)?.tools;
}

async function idle(r: Rig, sessionId: string, what: string): Promise<void> {
  await until(async () => (r.world.supervisor.isLive(sessionId) && !r.world.supervisor.turnRunning(sessionId)) || undefined, what, 20_000);
}

/** A member whose helper started while the Team probe failed: its CLI never listed the Team tools. */
async function memberWithoutTools(r: Rig) {
  const session = await r.world.supervisor.start(newSession({ name: 'studio-one', task: 'first' }), r.world.place);
  await waitForStatus(r.world.store, session.id, ['done', 'idle']);
  await idle(r, session.id, 'idle');
  r.probeFails = true;
  const member = await r.team.adopt({ sessionId: session.id, name: 'Studio maintainer', templateId: 'developer', charter: DEVELOPER });
  // Adoption restarts the process (its charter is part of the instruction); its new helper's probe failed.
  await until(async () => r.world.supervisor.agentTools.listed(session.id) ?? undefined, 'the restarted helper reported', 20_000);
  await idle(r, session.id, 'idle after the adoption');
  expect([...(r.world.supervisor.agentTools.listed(session.id)?.tools ?? [])]).toContain('todo_list');
  expect([...(r.world.supervisor.agentTools.listed(session.id)?.tools ?? [])]).not.toContain('team_propose_charter');
  r.probeFails = false;
  return { session, member };
}

describe('2026-10-16 · the charter ask makes sure the member has team_propose_charter', () => {
  it('a CLI that ignores list_changed is restarted once (idle, --resume) before the ask; the ask arrives with the tool', async () => {
    const r = await setup(false);
    const { session, member } = await memberWithoutTools(r);
    const pid = r.world.supervisor.pid(session.id);

    await r.team.askCharter(member.id);
    const tools = await until(async () => toolsAtMessage(r, 'team_propose_charter'), 'the ask at the agent', 30_000);
    expect(tools).toContain('team_propose_charter');
    expect(tools).toContain('team_report');
    // It is a new process, started with --resume, the chat's divider says why.
    expect(r.world.supervisor.pid(session.id)).not.toBe(pid);
    const events = await r.world.store.events.list(session.id);
    const restart = events.find((event) => (event.payload as { action?: string } | null)?.action === 'tools-updated');
    expect(restart?.label).toBe('Switchboard tools updated');
    // The ask came after the restart, once.
    const asks = events.filter((event) => (event.payload as { type?: string; text?: string } | null)?.type === 'user' && String((event.payload as { text?: string }).text).includes('team_propose_charter'));
    expect(asks).toHaveLength(1);
    expect(asks[0]?.id ?? 0).toBeGreaterThan(restart?.id ?? Number.MAX_SAFE_INTEGER);
  });

  it('a running turn is never interrupted: the restart and the ask wait for its end', async () => {
    const r = await setup(false);
    const { session, member } = await memberWithoutTools(r);
    await r.world.supervisor.sendMessage(session.id, 'Think it over [fake:hold 4]', 'user');
    await until(async () => r.world.supervisor.turnRunning(session.id) || undefined, 'the held turn runs');
    const pid = r.world.supervisor.pid(session.id);

    await r.team.askCharter(member.id);
    // Still the same process, its turn still running: nothing was sent yet.
    expect(r.world.supervisor.pid(session.id)).toBe(pid);
    expect(await toolsAtMessage(r, 'team_propose_charter')).toBeUndefined();

    const tools = await until(async () => toolsAtMessage(r, 'team_propose_charter'), 'the ask after the turn', 30_000);
    expect(tools).toContain('team_propose_charter');
    expect(r.world.supervisor.pid(session.id)).not.toBe(pid);
    const texts = JSON.stringify(await r.world.store.events.list(session.id));
    expect(texts).not.toContain('Request interrupted by user');
  });

  it('a CLI that honours list_changed gets the tool live: no restart, and the ask arrives with it', async () => {
    const r = await setup(true);
    const { session, member } = await memberWithoutTools(r);
    const pid = r.world.supervisor.pid(session.id);

    await r.team.askCharter(member.id);
    const tools = await until(async () => toolsAtMessage(r, 'team_propose_charter'), 'the ask at the agent', 30_000);
    expect(tools).toContain('team_propose_charter');
    expect(r.world.supervisor.pid(session.id)).toBe(pid);
    expect((await r.world.store.events.list(session.id)).some((event) => (event.payload as { action?: string } | null)?.action === 'tools-updated')).toBe(false);
  });
});
