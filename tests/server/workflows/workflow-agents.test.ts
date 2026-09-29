import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session, SessionDetail, WorkflowAgentChat } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { SessionSupervisor } from '../../../src/server/supervisor/supervisor.ts';
import { toSession } from '../../../src/server/sessions/wire.ts';
import { WorkflowService } from '../../../src/server/workflows/service.ts';
import type { SessionRecord } from '../../../src/server/db/repos/sessions.ts';
import { generateToken } from '../../../src/server/token.ts';
import { fakeClaudeCommand } from '../../../tools/fake-claude/command.ts';
import { FAKE_WORKFLOW_NAME, FAKE_WORKFLOW_SUMMARY } from '../../../tools/fake-claude/scenarios.ts';
import { fakeAgentBrief, fakeAgentLabel, fakeAgentText } from '../../../tools/fake-claude/workflow.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D51 on the real path: a session whose CLI (fake-claude, `[fake:workflow <s> 2x2]`)
 * runs a background Workflow. Its agents join `Session.agents` (`kind: 'workflow'`)
 * and its run `Session.workflows`, live from the stream and the files the CLI
 * writes; an agent's chat reads its transcript; after a restart (a new supervisor on
 * the same store) everything comes back from the files.
 */

const PORT = 4873;
const HOST = `127.0.0.1:${PORT}`;

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let extra: SessionSupervisor | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await extra?.shutdown();
  await world?.cleanup();
  app = undefined;
  extra = undefined;
  world = undefined;
});

async function setup(): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld();
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
  await seedFolder(world.store, world.workspace);
  app = await buildApp({ config: { ...base, port: PORT }, token, store: world.store, webRoot: world.root, supervisor: world.supervisor });
  await app.ready();
  return world;
}

function get(url: string) {
  if (!app) throw new Error('no app');
  return app.inject({ method: 'GET', url, headers: { host: HOST, cookie: `sb_token=${token}` } });
}

async function detail(id: string): Promise<SessionDetail> {
  return (await get(`/api/sessions/${id}`)).json() as SessionDetail;
}

describe('D51 · workflow agents on the real path', () => {
  it('live agents, their chat, the background line\'s counts, the final state, and the same after a restart', async () => {
    const w = await setup();
    const updates: Session[] = [];
    w.supervisor.on('sessionUpdated', (session) => updates.push(session));
    const session = await w.supervisor.start(newSession({ task: 'Audit the fixtures. [fake:workflow 6 2x2]' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);

    // Live: the first phase's agents run (from the stream's snapshot and the files), grouped under their run.
    const live = await until(async () => {
      const d = await detail(session.id);
      const running = d.agents.filter((a) => a.kind === 'workflow' && a.status === 'run');
      return running.length === 2 && running.every((a) => a.workflow?.agentId) ? d : undefined;
    }, 'two running workflow agents');
    expect(live.workflows).toHaveLength(1);
    const run = live.workflows?.[0];
    expect(run).toMatchObject({ name: FAKE_WORKFLOW_NAME, summary: FAKE_WORKFLOW_SUMMARY, status: 'run', phase: 'Audit', phases: ['Audit', 'Review'] });
    expect(run?.runId).toMatch(/^wf_[0-9a-f]{12}$/);
    const first = live.agents.find((a) => a.name === fakeAgentLabel(0, 1));
    expect(first).toMatchObject({ kind: 'workflow', description: 'Audit', status: 'run', toolUseId: null, solutionPath: null });
    expect(first?.workflow).toMatchObject({ runId: run?.runId, index: 1, phase: 'Audit' });
    // The main agent stays first; the workflow's agents follow it.
    expect(live.agents[0]?.kind).toBe('main');
    // D43's line gains the run's progress.
    const background = w.supervisor.activity(session.id)?.background.find((task) => task.kind === 'workflow');
    expect(background?.workflow).toMatchObject({ runId: run?.runId, agentCount: expect.any(Number), phase: 'Audit' });

    // Its chat: the brief without the CLI's frame, then (once there) its Read and its text.
    const chat = await until(async () => {
      const answer = await get(`/api/sessions/${session.id}/workflow-agents/${encodeURIComponent(first?.id ?? '')}/chat`);
      const body = answer.json() as WorkflowAgentChat;
      return answer.statusCode === 200 && body.events.length >= 3 ? body : undefined;
    }, 'the agent\'s chat with its tool call and text');
    expect(chat.events[0]).toMatchObject({ agentId: first?.id, sessionId: session.id, payload: { type: 'agent-prompt', text: fakeAgentBrief(0, 1) } });
    expect(chat.events[1]).toMatchObject({ payload: { type: 'tool', name: 'Read' } });
    expect(chat.events[2]).toMatchObject({ payload: { type: 'assistant', text: fakeAgentText(fakeAgentLabel(0, 1)) } });
    expect(chat.version).toBeGreaterThan(0);

    // The end: every agent done, the run done (its run file), and sessionUpdated told the UI on the way.
    const done = await until(async () => {
      const d = await detail(session.id);
      return d.workflows?.[0]?.status === 'done' ? d : undefined;
    }, 'the run done', 20_000);
    expect(done.workflows?.[0]).toMatchObject({ agentCount: 4, doneCount: 4, failedCount: 0, phase: 'Review' });
    expect(done.agents.filter((a) => a.kind === 'workflow').map((a) => [a.name, a.status, a.description])).toEqual([
      [fakeAgentLabel(0, 1), 'done', 'Audit'],
      [fakeAgentLabel(0, 2), 'done', 'Audit'],
      [fakeAgentLabel(1, 1), 'done', 'Review'],
      [fakeAgentLabel(1, 2), 'done', 'Review'],
    ]);
    const doneChat = (await get(`/api/sessions/${session.id}/workflow-agents/${encodeURIComponent(first?.id ?? '')}/chat`)).json() as WorkflowAgentChat;
    expect(doneChat.result).toEqual({ text: expect.stringContaining('"ok": true'), isError: false });
    expect(updates.some((s) => s.id === session.id && (s.workflows ?? []).some((r) => r.status === 'run'))).toBe(true);
    expect(updates.some((s) => s.id === session.id && (s.workflows ?? []).some((r) => r.status === 'done'))).toBe(true);
    // Unknown agents: 404.
    expect((await get(`/api/sessions/${session.id}/workflow-agents/wf_nope--a1/chat`)).statusCode).toBe(404);
    expect((await get(`/api/sessions/no-such/workflow-agents/x/chat`)).statusCode).toBe(404);
    await w.supervisor.pause(session.id);

    // A restart: a new supervisor on the same store reads it all back from the CLI's files.
    extra = new SessionSupervisor({ store: w.store, claudeCommand: fakeClaudeCommand(), env: w.env, onError: (error) => w.errors.push(error) });
    const record = (await w.store.sessions.get(session.id)) as SessionRecord;
    const again = await toSession(w.store, record);
    expect(again.workflows).toEqual(done.workflows);
    expect(again.agents.filter((a) => a.kind === 'workflow').map((a) => [a.id, a.status])).toEqual(done.agents.filter((a) => a.kind === 'workflow').map((a) => [a.id, a.status]));
    const reread = await extra.workflowChat(record, first?.id ?? '');
    expect(reread?.events.map((e) => (e.payload as { type: string }).type)).toEqual(['agent-prompt', 'tool', 'assistant']);
    expect(w.errors).toEqual([]);
  }, 60_000);
});

describe('D51 · a run whose process ends', () => {
  it('a pause mid-run stops the run at once: it and its running agents read stopped (idle), however fresh the files are', async () => {
    const w = await setup();
    const session = await w.supervisor.start(newSession({ task: 'Audit. [fake:workflow 30 1x2]' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await until(async () => {
      const d = await detail(session.id);
      return d.agents.filter((a) => a.kind === 'workflow' && a.status === 'run' && a.workflow?.agentId).length === 2 || undefined;
    }, 'two running workflow agents');
    await w.supervisor.pause(session.id);
    const stopped = await until(async () => {
      const d = await detail(session.id);
      return d.workflows?.[0]?.status === 'idle' ? d : undefined;
    }, 'the run stopped', 5_000);
    expect(stopped.agents.filter((a) => a.kind === 'workflow').map((a) => a.status)).toEqual(['idle', 'idle']);
    expect(stopped.workflows?.[0]).toMatchObject({ doneCount: 0, agentCount: 2 });
    // D51-resume: the stopped run offers its script (the fake wrote it next to the transcript).
    expect(stopped.workflows?.[0]?.resume?.scriptPath).toMatch(new RegExp(`${FAKE_WORKFLOW_NAME}-wf_[0-9a-f]{12}\\.js$`));
  }, 60_000);
});

describe('D51 × D50 · stopping a workflow task', () => {
  it('Stop background tasks (stop_task) stops the run: it reads stopped, its running agents cut off, the process lives on', async () => {
    const w = await setup();
    const session = await w.supervisor.start(newSession({ task: 'Audit. [fake:workflow 30 1x2]' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await until(async () => {
      const d = await detail(session.id);
      return d.agents.filter((a) => a.kind === 'workflow' && a.status === 'run' && a.workflow?.agentId).length === 2 || undefined;
    }, 'two running workflow agents');
    await w.supervisor.stopBackground(session.id);
    const stopped = await until(async () => {
      const d = await detail(session.id);
      return d.workflows?.[0]?.status === 'idle' ? d : undefined;
    }, 'the run stopped', 5_000);
    expect(stopped.agents.filter((a) => a.kind === 'workflow').map((a) => a.status)).toEqual(['idle', 'idle']);
    expect(w.supervisor.isLive(session.id)).toBe(true);
    await w.supervisor.pause(session.id);
  }, 60_000);
});

describe('D51 · WorkflowService on files alone (terminal / hooked / History sessions)', () => {
  const SID = '9d2c1b0a-5151-4a4a-8b8b-0c0c0c0c0c51';

  function record(root: string): SessionRecord {
    return { id: 'session-1', name: 'files-only', claudeSessionId: SID, cwd: root, root, rootKind: 'workspace' } as SessionRecord;
  }

  it('reads a run from the session\'s folders only: bad names, symlinks and paths inside files are never followed; a fresh run runs, a stale one stopped', async () => {
    const w = await makeSupervisorWorld();
    world = w;
    const projects = path.join(w.configDir, 'projects');
    const main = path.join(projects, '-work-space', SID);
    const other = path.join(projects, '-work-space-microfrontends', SID);
    const runDir = path.join(main, 'subagents', 'workflows', 'wf_1111aaaa-222');
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, 'journal.jsonl'),
      [
        '{"type":"launched"}',
        '{"type":"started","key":"k1","agentId":"a1","label":"audit:one","phase":"Audit"}',
        '{"type":"started","key":"k2","agentId":"../../escape","label":"evil","phase":"Audit"}',
        '',
      ].join('\n'),
    );
    await writeFile(path.join(runDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', description: 'audit:one', workflowPhase: 'Audit' }));
    const envelope = { isSidechain: true, agentId: 'a1', cwd: '/elsewhere', sessionId: SID };
    await writeFile(
      path.join(runDir, 'agent-a1.jsonl'),
      `${JSON.stringify({ ...envelope, type: 'user', uuid: 'u1', parentUuid: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Audit one. Transcript dir: /etc/passwd' } })}\n` +
        // D51-solution: a failed write does not count, the next successful one does (a path relative to the line's cwd).
        `${JSON.stringify({ ...envelope, type: 'assistant', uuid: 'm1', parentUuid: 'u1', timestamp: new Date().toISOString(), message: { id: 'x1', model: 'claude', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: path.join(w.workspace, 'microfrontends', 'bad-front', 'x.ts') } }] } })}\n` +
        `${JSON.stringify({ ...envelope, type: 'user', uuid: 'r1', parentUuid: 'm1', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'nope', is_error: true }] } })}\n` +
        `${JSON.stringify({ ...envelope, cwd: w.workspace, type: 'assistant', uuid: 'm2', parentUuid: 'r1', timestamp: new Date().toISOString(), message: { id: 'x2', model: 'claude', content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'microfrontends/x-front/a.ts' } }] } })}\n` +
        `${JSON.stringify({ ...envelope, type: 'user', uuid: 'r2', parentUuid: 'm2', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } })}\n`,
    );
    // The script sits under another cwd's project folder (the session moved there).
    await mkdir(path.join(other, 'workflows', 'scripts'), { recursive: true });
    await writeFile(path.join(other, 'workflows', 'scripts', 'term-audit-wf_1111aaaa-222.js'), "export const meta = { name: 'term-audit', description: 'Audit from a terminal', phases: [{ title: 'Audit' }] }");
    // Not runs: a bad name, and a symlinked run folder pointing outside the projects folder.
    await mkdir(path.join(main, 'subagents', 'workflows', 'not-a-run'), { recursive: true });
    const outside = path.join(w.root, 'outside', 'wf_2222bbbb-333');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'journal.jsonl'), '{"type":"started","agentId":"a9","label":"outside"}\n');
    await symlink(outside, path.join(main, 'subagents', 'workflows', 'wf_2222bbbb-333'));

    const changes: string[] = [];
    let now = Date.now();
    const service = new WorkflowService({ configDir: () => w.configDir, onChange: (id) => changes.push(id), pollMs: 50, now: () => now });
    try {
      const first = await service.forSession(record(w.workspace));
      expect(first.runs.map((r) => [r.runId, r.name, r.summary, r.status])).toEqual([['wf_1111aaaa-222', 'term-audit', 'Audit from a terminal', 'run']]);
      expect(first.agents.map((a) => [a.id, a.name, a.status, a.workflow?.cwd, a.solutionPath])).toEqual([['wf_1111aaaa-222--a1', 'audit:one', 'run', '/elsewhere', 'microfrontends/x-front']]);
      // Still running: no resume offered.
      expect(first.runs[0]?.resume).toBeNull();

      // The agent ends (the journal grows): the poll picks it up and tells the UI.
      await writeFile(path.join(runDir, 'journal.jsonl'), '{"type":"result","key":"k1","agentId":"a1","result":"fine"}\n', { flag: 'a' });
      await until(async () => changes.length > 0 || undefined, 'a change from the poll', 5_000);
      const later = await service.forSession(record(w.workspace));
      expect(later.agents[0]?.status).toBe('done');

      // Files untouched for long: nobody runs it any more.
      const old = new Date(Date.now() - 10 * 60_000);
      for (const file of ['journal.jsonl', 'agent-a1.jsonl', 'agent-a1.meta.json']) await utimes(path.join(runDir, file), old, old);
      now += 11_000; // past the list's reuse time
      const fresh = new WorkflowService({ configDir: () => w.configDir, onChange: () => undefined, now: () => now });
      const stale = await fresh.forSession(record(w.workspace));
      expect(stale.runs[0]?.status).toBe('idle');
      // D51-resume: a stopped run offers the script Switchboard found (under the other cwd's project folder).
      expect(stale.runs[0]?.resume).toEqual({ scriptPath: path.join(other, 'workflows', 'scripts', 'term-audit-wf_1111aaaa-222.js'), args: null });
      expect(stale.agents[0]?.solutionPath).toBe('microfrontends/x-front');
      fresh.close();
      const chat = await service.chat(record(w.workspace), 'wf_1111aaaa-222--a1');
      expect(chat?.events[0]?.payload).toEqual({ type: 'agent-prompt', text: 'Audit one. Transcript dir: /etc/passwd' });
      expect(chat?.result).toEqual({ text: 'fine', isError: false });
    } finally {
      service.close();
    }
  });

  it('a session without workflows reads nothing heavy and has none; another CLI session id\'s runs are not its', async () => {
    const w = await makeSupervisorWorld();
    world = w;
    await mkdir(path.join(w.configDir, 'projects', '-x', 'another-session', 'subagents', 'workflows', 'wf_3333cccc-444'), { recursive: true });
    const service = new WorkflowService({ configDir: () => w.configDir, onChange: () => undefined });
    try {
      expect(await service.forSession(record(w.workspace))).toEqual({ runs: [], agents: [] });
      expect(await service.chat(record(w.workspace), 'wf_3333cccc-444--a1')).toBeNull();
    } finally {
      service.close();
    }
  });
});
