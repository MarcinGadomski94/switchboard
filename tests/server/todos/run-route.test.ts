import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Folder, Session, SessionTodoList, TodoRunResult } from '../../../src/core/api.ts';
import { REPO_WORKTREE_NOTE_HEADER } from '../../../src/core/first-turn.ts';
import { todoStartMessage } from '../../../src/core/todos.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { generateToken } from '../../../src/server/token.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { REPO_ROOT } from '../../helpers/net.ts';
import { type SupervisorWorld, isHandshake, makeSupervisorWorld, readFakeLog, until } from '../../helpers/supervisor.ts';

/**
 * D76 oracle (server, real path, D13): **▸ Run in new session** through
 * `POST /api/sessions/{id}/todos/{todoId}/run` with fake-claude as the CLI, real git
 * repositories and the real worktree manager. In a repo folder the run gets its own
 * worktree on a free `todo/<slug>` branch cut from the branch the source session has
 * checked out; its title is the item's, its first message the item's start message;
 * the item is in progress, linked both ways; the run's agent token marks the item
 * (done → review). In a workspace folder the run works in the same folder without a
 * worktree and the answer says so. A running item, a done one and an unknown one are refused.
 */
const PORT = 4877; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const ROUTER_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md');

let sw: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await sw?.cleanup();
  app = undefined;
  sw = undefined;
});

interface Rig {
  readonly s: SupervisorWorld;
  readonly g: GitWorld;
  readonly workspace: Folder;
  readonly repo: Folder;
  readonly repoPath: string;
}

async function setup(): Promise<Rig> {
  sw = await makeSupervisorWorld({ scenario: 'handoff-start' });
  const g = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  await writeFile(path.join(g.workspace, 'AGENTS.md'), await readFile(ROUTER_FIXTURE, 'utf8'));
  const repoPath = await g.makeRepo(path.join(sw.root, 'solo'));
  const worktrees = g.manager({ sessions: sw.supervisor });
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: sw.root }, platform: 'linux', home: sw.root, cwd: sw.root });
  app = await buildApp({ config: { ...base, port: PORT }, token, store: sw.store, webRoot: sw.root, supervisor: sw.supervisor, worktrees, providers: { diff: worktrees } });
  await app.ready();
  const workspace = (await call('POST', '/api/folders', { path: g.workspace })).json() as Folder;
  const repo = (await call('POST', '/api/folders', { path: repoPath })).json() as Folder;
  return { s: sw, g, workspace, repo, repoPath };
}

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

function agent(sessionId: string, method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: HOST, 'x-switchboard-session': sessionId, authorization: `Bearer ${agentTokenFor(token, sessionId)}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

/** The session's spawn line and its first stdin user message's content. */
async function spawnOf(s: SupervisorWorld, session: Session): Promise<{ cwd: string; argv: readonly string[]; first: string }> {
  const spawn = await until(async () => (await readFakeLog(s.logFile)).find((line) => line.kind === 'argv' && line.argv?.includes(session.claudeSessionId)), 'the spawn');
  const first = await until(async () => {
    const line = (await readFakeLog(s.logFile)).find((entry) => entry.kind === 'stdin' && entry.pid === spawn.pid && !isHandshake(JSON.parse(entry.line as string) as Record<string, unknown>));
    return line ? (JSON.parse(line.line as string) as { message: { content: string } }).message.content : undefined;
  }, 'the first message');
  return { cwd: spawn.cwd ?? '', argv: spawn.argv ?? [], first };
}

async function addTodo(sessionId: string, title: string, plan = 'No plan'): Promise<string> {
  const list = (await call('POST', `/api/sessions/${sessionId}/todos`, { title, plan, priority: 'high', estimateMinutes: 30 })).json() as SessionTodoList;
  const item = list.todos.find((todo) => todo.title === title);
  if (!item) throw new Error('no item');
  return item.id;
}

describe('POST /api/sessions/{id}/todos/{todoId}/run (D76)', () => {
  it('a repo folder: a new session on its own worktree, todo/<slug> cut from the source’s branch, titled like the item, its start message first; linked both ways', async () => {
    const { s, g, repo, repoPath } = await setup();
    // The source session works on its own worktree (feature/source) with a commit main does not have.
    const started = await call('POST', '/api/sessions', { simple: true, name: 'source', title: 'Source', task: 'Hello', folder: repo.id, worktrees: true, branch: 'feature/source', model: 'opus', effort: 'high' });
    expect(started.statusCode, started.body).toBe(201);
    const source = started.json() as Session;
    const sourceTree = source.cwd ?? '';
    const tip = await g.commit(sourceTree, 'src/feature.txt', 'feature\n');
    const plan = '1. Fix it\n2. Test it';
    const todoId = await addTodo(source.id, 'Fix the login flake', plan);

    const response = await call('POST', `/api/sessions/${source.id}/todos/${todoId}/run`);
    expect(response.statusCode, response.body).toBe(201);
    const result = response.json() as TodoRunResult;
    expect(result.note).toBeNull();
    const run = result.session;
    const worktree = path.join(path.dirname(repoPath), 'solo-wt-fix-the-login-flake');
    expect(run).toMatchObject({ title: 'Fix the login flake', name: 'fix-the-login-flake', cwd: worktree, worktrees: true, solutions: ['solo'], todoLink: { sourceSessionId: source.id, todoId } });
    expect((await stat(worktree)).isDirectory()).toBe(true);
    expect(await g.git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe('todo/fix-the-login-flake');
    expect(await g.git(worktree, 'rev-parse', 'HEAD')).toBe(tip);
    expect(result.list.todos.find((todo) => todo.id === todoId)).toMatchObject({ state: 'in_progress', startedBy: 'run', runSessionId: run.id, runState: 'active' });
    // Same CLI, model and effort as the source session.
    const record = await s.store.sessions.get(run.id);
    expect(record).toMatchObject({ provider: 'claude', model: 'opus', effort: 'high', branch: 'todo/fix-the-login-flake', todoLink: { sourceSessionId: source.id, todoId } });
    const { cwd, argv, first } = await spawnOf(s, run);
    expect(cwd).toBe(worktree);
    expect(argv).toEqual(expect.arrayContaining(['--model', 'opus']));
    const startMessage = todoStartMessage({ id: todoId, title: 'Fix the login flake', description: null, plan });
    expect(first.startsWith(`${startMessage}\n\n${REPO_WORKTREE_NOTE_HEADER}`)).toBe(true);
    expect(first).toContain('(branch todo/fix-the-login-flake, from feature/source)');

    // The run's agent marks the source's item done: it goes to review.
    const done = await agent(run.id, 'PUT', `/agent/v1/todos/${todoId}`, { state: 'done' });
    expect(done.statusCode, done.body).toBe(200);
    expect(((await call('GET', `/api/sessions/${source.id}/todos`)).json() as SessionTodoList).todos.find((t) => t.id === todoId)).toMatchObject({ state: 'review', runSessionId: run.id });

    // In review it cannot run again; a second item with the same title gets todo/<slug>-2.
    expect((await call('POST', `/api/sessions/${source.id}/todos/${todoId}/run`)).statusCode).toBe(422);
    const second = await addTodo(source.id, 'Fix the login flake!');
    const again = await call('POST', `/api/sessions/${source.id}/todos/${second}/run`);
    expect(again.statusCode, again.body).toBe(201);
    const run2 = (again.json() as TodoRunResult).session;
    expect(run2.name).toBe('fix-the-login-flake-2');
    expect(await g.git(run2.cwd ?? '', 'symbolic-ref', '--short', 'HEAD')).toBe('todo/fix-the-login-flake-2');
    // Running already: refused.
    const refused = await call('POST', `/api/sessions/${source.id}/todos/${second}/run`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'already-running' });
    expect((await call('POST', `/api/sessions/${source.id}/todos/nope/run`)).statusCode).toBe(404);
  });

  it('a workspace folder (no git repository): the same folder without a worktree, and the answer says so', async () => {
    const { s, workspace, g } = await setup();
    const started = await call('POST', '/api/sessions', { simple: true, name: 'ws-source', title: 'Source', task: 'Hello', folder: workspace.id });
    const source = started.json() as Session;
    const todoId = await addTodo(source.id, 'Tidy the docs');
    const response = await call('POST', `/api/sessions/${source.id}/todos/${todoId}/run`);
    expect(response.statusCode, response.body).toBe(201);
    const result = response.json() as TodoRunResult;
    expect(result.note).toBe("The source session's folder is not a git repository (a workspace): the run works in the same folder, without a worktree.");
    expect(result.session).toMatchObject({ title: 'Tidy the docs', cwd: g.workspace, worktrees: false, folder: workspace.id });
    const { first } = await spawnOf(s, result.session);
    expect(first).toBe(todoStartMessage({ id: todoId, title: 'Tidy the docs', description: null, plan: 'No plan' }));
  });
});
