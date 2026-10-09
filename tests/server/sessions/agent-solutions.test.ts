import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { NewSession, Session } from '../../../src/core/api.ts';
import { SOLUTIONS_NOT_CHOSEN, agentWorktreesInstruction } from '../../../src/core/first-turn.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { generateToken } from '../../../src/server/token.ts';
import { WorktreeAdoption } from '../../../src/server/worktrees/adopt.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { type SupervisorWorld, isHandshake, makeSupervisorWorld, readFakeLog, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D38 (real path, D13): a workspace session can start without picked solutions.
 * Sessions go through `POST /api/sessions` with fake-claude as the CLI, real git
 * repositories in a temp workspace (`microfrontends/web-front`, `mobile`), the
 * real worktree manager and the app's `WorktreeAdoption`. Covered: an empty or
 * omitted `solutions` is accepted for a workspace and a repo folder is
 * unchanged; no worktree is created up front and the first message carries the
 * "not chosen" answers; a worktree on the session's branch is adopted by the
 * turn-end sweep and one the agent adds with `git worktree add` (a main-agent
 * Bash result) right away, registered and assigned like an up-front worktree;
 * a write fills in the session's solutions (persisted and published).
 */
const PORT = 4874; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let sw: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await sw?.cleanup();
  app = undefined;
  sw = undefined;
});

async function setup(): Promise<{ s: SupervisorWorld; g: GitWorld; published: Session[] }> {
  sw = await makeSupervisorWorld({ scenario: 'handoff-start' });
  const g = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  const worktrees = g.manager({ sessions: sw.supervisor });
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: sw.root }, platform: 'linux', home: sw.root, cwd: sw.root });
  await seedFolder(sw.store, g.workspace);
  app = await buildApp({ config: { ...base, port: PORT }, token, store: sw.store, webRoot: sw.root, supervisor: sw.supervisor, worktrees, providers: { diff: worktrees } });
  await app.ready();
  const published: Session[] = [];
  sw.supervisor.on('sessionUpdated', (session) => published.push(session));
  return { s: sw, g, published };
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

function body(overrides: Partial<NewSession> & Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'agent-picks',
    task: 'Add the free talk screen.',
    workType: 'feature',
    mode: 'single',
    solutions: [],
    phase: 'ui-first',
    coordination: null,
    qa: null,
    worktrees: false,
    ultracode: false,
    ...overrides,
  };
}

async function started(payload: Record<string, unknown>): Promise<Session> {
  const response = await call('POST', '/api/sessions', payload);
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as Session;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** The session's first stdin user message (the handshake left out). */
async function firstMessage(s: SupervisorWorld, sessionId: string): Promise<string> {
  const pid = (await s.store.sessions.get(sessionId))?.pid;
  return until(async () => {
    const line = (await readFakeLog(s.logFile)).find((entry) => entry.kind === 'stdin' && entry.pid === pid && !isHandshake(JSON.parse(entry.line as string) as Record<string, unknown>));
    if (!line) return undefined;
    const message = (JSON.parse(line.line as string) as { message: { content: string } }).message;
    return message.content;
  }, 'the first message');
}

describe('POST /api/sessions · D38: no picked solutions', () => {
  it('a workspace accepts an empty or omitted `solutions`, starts without a worktree and tells the agent to choose; a repo folder is unchanged', async () => {
    const { s, g } = await setup();

    // Worktrees on, no solutions: stored empty, with the branch; no worktree up front, none on disk, no git worktree add.
    const session = await started(body({ name: 'agent-picks', worktrees: true, branch: 'PROJ-38-agent-picks' }));
    expect(session.solutions).toEqual([]);
    const record = await s.store.sessions.get(session.id);
    expect(record?.solutions).toEqual([]);
    expect(record?.branch).toBe('PROJ-38-agent-picks');
    expect(await s.store.worktrees.list({ sessionId: session.id })).toEqual([]);
    expect(await exists(path.join(g.workspace, 'microfrontends', 'web-front-wt-agent-picks'))).toBe(false);
    expect((await g.gitCalls()).some((c) => c.argv.includes('worktree') && c.argv.includes('add'))).toBe(false);
    const message = await firstMessage(s, session.id);
    expect(message).toContain(`- Solutions in scope: ${SOLUTIONS_NOT_CHOSEN}`);
    expect(message).toContain(`- Worktrees: ${agentWorktreesInstruction('PROJ-38-agent-picks', 'agent-picks', { epic: null, base: 'dev' })}`);
    expect(message).not.toContain('Mobile coordination');

    // `solutions` omitted, worktrees off: accepted too; edits in place.
    const { solutions: _omitted, ...rest } = body({ name: 'no-list' });
    void _omitted;
    const omitted = await started(rest);
    expect(omitted.solutions).toEqual([]);
    expect((await s.store.sessions.get(omitted.id))?.branch).toBeNull();
    expect(await firstMessage(s, omitted.id)).toContain('- Worktrees: no worktrees · edits in place');

    // A non-empty list is validated as before.
    const refused = await call('POST', '/api/sessions', body({ name: 'read-only', solutions: ['deprecated/microfrontends/old-front'] }));
    expect(refused.statusCode).toBe(422);
    expect(refused.json().errors.map((e: { field: string }) => e.field)).toEqual(['solutions']);

    // A repo folder: its repo stays the one solution.
    const repoFolder = await seedFolder(s.store, g.web, { kind: 'repo' });
    const repo = await started({ name: 'in-repo', task: 'Fix it.', folder: repoFolder.id, solutions: [], worktrees: false, ultracode: false });
    expect(repo.solutions).toEqual(['web-front']);
    await waitForStatus(s.store, repo.id, ['done', 'idle']);
    expect(s.errors).toEqual([]);
  });
});

describe('D38: adopted worktrees', () => {
  it('the turn-end sweep adopts a worktree on the session branch; it is registered, assigned and diffed like an up-front one', async () => {
    const { s, g, published } = await setup();
    // A worktree on the session's branch outside the `<repo>-wt-<name>` naming (matched by its branch).
    const elsewhere = path.join(g.root, 'side', 'web-work');
    await g.git(g.web, 'worktree', 'add', '-b', 'PROJ-38-sweep', elsewhere);
    // The agent writes into the web repo in place: web-front joins the solutions, and the turn ends.
    const session = await started(body({ name: 'sweep', worktrees: true, branch: 'PROJ-38-sweep', task: '[fake:write microfrontends/web-front/notes/plan.md]' }));
    const adopted = await until(async () => (await s.store.worktrees.list({ sessionId: session.id }))[0], 'the adopted worktree');
    expect(adopted).toMatchObject({ repo: 'web-front', repoPath: g.web, branch: 'PROJ-38-sweep', path: elsewhere, sessionId: session.id, baseRef: 'main', removedAt: null });
    expect((await s.store.sessions.get(session.id))?.solutions).toEqual(['web-front']);
    await until(async () => published.some((p) => p.id === session.id && p.solutions.includes('web-front')) || undefined, 'the published solutions');
    // The Diff lists the worktree's branch (the in-place write is web-front's too, but its worktree now stands for it).
    await g.commit(elsewhere, 'src/sweep.txt', 'swept\n');
    const diff = await call('GET', `/api/sessions/${session.id}/diff?scope=branch`);
    expect(diff.statusCode).toBe(200);
    expect(g.errors).toEqual([]);
    expect((diff.json() as Array<{ path: string; branch: string }>).map((f) => [f.path, f.branch])).toEqual([['src/sweep.txt', 'PROJ-38-sweep']]);
    // Idempotent: another sweep registers nothing new.
    const adoption = new WorktreeAdoption({ store: s.store, sessions: s.supervisor, worktrees: g.manager() });
    await adoption.adopt(session.id);
    await adoption.close();
    expect(await s.store.worktrees.list({ sessionId: session.id })).toHaveLength(1);
    // Git ran in the main checkout only to list its worktrees (and the test's own calls).
    const inMain = (await g.gitCalls()).filter((c) => c.cwd === g.web && c.argv[0] === 'worktree');
    expect(inMain.map((c) => c.argv.join(' '))).toEqual(expect.arrayContaining(['worktree list --porcelain']));
    expect(inMain.every((c) => c.argv.join(' ') === 'worktree list --porcelain')).toBe(true);
    expect(s.errors).toEqual([]);
  });

  it('a main-agent `git worktree add` is adopted right away (worktrees off: matched by <repo>-wt-<name>)', async () => {
    const { s, g } = await setup();
    const session = await started(body({ name: 'bash-add', task: 'Make a worktree. [fake:worktree-add microfrontends/web-front PROJ-38-bash microfrontends/web-front-wt-bash-add]' }));
    const worktree = path.join(g.workspace, 'microfrontends', 'web-front-wt-bash-add');
    const adopted = await until(async () => (await s.store.worktrees.list({ sessionId: session.id }))[0], 'the adopted worktree');
    expect(adopted).toMatchObject({ repo: 'web-front', repoPath: g.web, branch: 'PROJ-38-bash', path: worktree, sessionId: session.id });
    await until(async () => ((await s.store.sessions.get(session.id))?.solutions.length ? true : undefined), 'the adopted solution');
    expect((await s.store.sessions.get(session.id))?.solutions).toEqual(['web-front']);
    expect(await g.git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe('PROJ-38-bash');
    // The session has worktrees off, so no sweep ran: the Bash result did it.
    expect((await s.store.sessions.get(session.id))?.worktrees).toBe(false);
    // A worktree of another session (by name) is never taken.
    await g.git(g.mobile, 'worktree', 'add', '-b', 'PROJ-99-other', path.join(g.workspace, 'mobile-wt-someone-else'));
    const adoption = new WorktreeAdoption({ store: s.store, sessions: s.supervisor, worktrees: g.manager() });
    await adoption.adopt(session.id);
    await adoption.close();
    expect((await s.store.worktrees.list({ sessionId: session.id })).map((w) => w.repo)).toEqual(['web-front']);
    expect(s.errors).toEqual([]);
  });
});

describe('D38: solutions fill in from writes', () => {
  it('each solution an agent writes into joins Session.solutions in order, persisted and published; the root and read-only folders do not', async () => {
    const { s, g, published } = await setup();
    const session = await started(body({ name: 'fill-in', task: '[fake:write mobile/notes.md]' }));
    await until(async () => ((await s.store.sessions.get(session.id))?.solutions.length ? true : undefined), 'the first solution');
    expect((await s.store.sessions.get(session.id))?.solutions).toEqual(['mobile']);
    await waitForStatus(s.store, session.id, ['done']);
    const results = async (): Promise<number> => (await s.store.events.list(session.id)).filter((e) => (e.payload as { type?: string }).type === 'result').length;
    for (const text of ['[fake:write contracts/free-talk.md]', '[fake:write deprecated/microfrontends/old-front/x.md]', '[fake:write microfrontends/web-front/src/a.txt]', '[fake:write mobile/again.md]']) {
      const before = await results();
      expect((await call('POST', `/api/sessions/${session.id}/messages`, { text })).statusCode).toBe(202);
      await until(async () => ((await results()) > before ? true : undefined), `the turn of ${text}`);
    }
    await until(async () => ((await s.store.sessions.get(session.id))?.solutions.length === 2 ? true : undefined), 'the second solution');
    expect((await s.store.sessions.get(session.id))?.solutions).toEqual(['mobile', 'web-front']);
    await until(async () => published.some((p) => p.id === session.id && p.solutions.join() === 'mobile,web-front') || undefined, 'the published session');
    // The session header chip (scope) follows.
    const detail = (await call('GET', `/api/sessions/${session.id}`)).json() as { chips: Array<{ k: string; v: string }> };
    expect(detail.chips).toContainEqual(expect.objectContaining({ k: 'scope', v: 'mobile + web-front' }));
    expect(g.errors).toEqual([]);
    expect(s.errors).toEqual([]);
  });
});
