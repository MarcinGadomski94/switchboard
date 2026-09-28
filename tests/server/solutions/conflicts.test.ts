import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session, Solution, SolutionGroup } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { LiveSolutions } from '../../../src/server/solutions/live.ts';
import { WorkspaceScanner } from '../../../src/server/solutions/scanner.ts';
import { generateToken } from '../../../src/server/token.ts';
import { type GitWorld, forbiddenGitCalls, makeGitWorld } from '../../helpers/git.ts';
import { REPO_ROOT } from '../../helpers/net.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * Conflict detection (M6.3) on the real code path (D13, no demo): real git repos
 * in a temp workspace, sessions started through `POST /api/sessions` with
 * fake-claude as the CLI, `GET /api/solutions` from `LiveSolutions`, and the
 * "Move … to worktree" action through `POST /api/solutions/{repo}/isolate`
 * (gap #2, the worktree manager).
 */
const PORT = 4873; // inject() opens no socket; the port feeds the Host check only
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

async function setup(): Promise<{ s: SupervisorWorld; g: GitWorld }> {
  sw = await makeSupervisorWorld({ scenario: 'handoff-start' });
  const g = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  const m = g.manager({ sessions: sw.supervisor });
  await writeFile(path.join(g.workspace, 'AGENTS.md'), await readFile(ROUTER_FIXTURE, 'utf8'));
  await g.makeRepo(path.join(g.workspace, 'deprecated', 'microfrontends', 'old-front'));
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: sw.root }, platform: 'linux', home: sw.root, cwd: sw.root });
  const solutions = new LiveSolutions({ scanner: new WorkspaceScanner({ workspaceRoot: g.workspace }), store: sw.store, diff: m });
  app = await buildApp({
    config: { ...base, port: PORT, workspaceRoot: g.workspace },
    token,
    store: sw.store,
    webRoot: sw.root,
    supervisor: sw.supervisor,
    worktrees: m,
    providers: { diff: m, solutions },
  });
  await app.ready();
  return { s: sw, g };
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

async function start(s: SupervisorWorld, overrides: Parameters<typeof newSession>[0]): Promise<Session> {
  const response = await call('POST', '/api/sessions', newSession(overrides));
  expect(response.statusCode).toBe(201);
  const session = response.json() as Session;
  await waitForStatus(s.store, session.id, ['done', 'fail']);
  return session;
}

async function rows(): Promise<Map<string, Solution>> {
  const response = await call('GET', '/api/solutions');
  expect(response.statusCode).toBe(200);
  return new Map((response.json() as SolutionGroup[]).flatMap((group) => group.solutions.map((s) => [s.name, s] as const)));
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

describe('GET /api/solutions · conflicts (M6.3)', () => {
  it('two sessions in one checkout → conflict; moving each to a worktree clears it; the developer tree is untouched', async () => {
    const { s, g } = await setup();
    const first = await start(s, { name: 'first-writer', solutions: ['mobile'] });
    const second = await start(s, { name: 'second-writer', solutions: ['mobile'] });
    await start(s, { name: 'web-alone', solutions: ['web-front'] });
    const statusBefore = await g.git(g.mobile, 'status', '--porcelain');

    let byName = await rows();
    expect(byName.get('mobile')).toMatchObject({
      conflict: true,
      flag: '⚠ shared working tree',
      conflictSessions: [
        { sessionId: first.id, name: 'first-writer', isolated: false, repo: 'mobile', attached: true },
        { sessionId: second.id, name: 'second-writer', isolated: false, repo: 'mobile', attached: true },
      ],
    });
    // One session alone in a checkout, and read-only rows, have no conflict.
    expect(byName.get('web-front')).toMatchObject({ conflict: false, flag: '', conflictSessions: [] });
    expect(byName.get('old-front')).toMatchObject({ conflict: false, flag: '', conflictSessions: [] });

    // "Move second-writer to worktree": its own worktree; first-writer is still in the main checkout → still a conflict.
    const moved = await call('POST', '/api/solutions/mobile/isolate', { sessionId: second.id });
    expect(moved.statusCode).toBe(201);
    expect(moved.json()).toMatchObject({ repo: 'mobile', branch: 'session/second-writer', path: path.join(g.workspace, 'mobile-wt-second-writer'), sessionId: second.id });
    expect(await exists(path.join(g.workspace, 'mobile-wt-second-writer'))).toBe(true);
    await until(async () => (await spawnedArgv(s.logFile)).length >= 4, 'second-writer resumed with the move message');
    await waitForStatus(s.store, second.id, ['done']);
    byName = await rows();
    expect(byName.get('mobile')?.conflict).toBe(true);
    expect(byName.get('mobile')?.conflictSessions.map((c) => [c.name, c.isolated])).toEqual([
      ['first-writer', false],
      ['second-writer', true],
    ]);
    expect(byName.get('mobile')?.branches.map((b) => [b.branch, b.owner, b.worktree === null])).toEqual([
      ['session/second-writer', 'second-writer', false],
      ['main', 'first-writer', true],
    ]);

    // Move the other one: every writer has its own worktree → no conflict.
    expect((await call('POST', '/api/solutions/mobile/isolate', { sessionId: first.id })).statusCode).toBe(201);
    await until(async () => (await spawnedArgv(s.logFile)).length >= 5, 'first-writer resumed with the move message');
    await waitForStatus(s.store, first.id, ['done']);
    byName = await rows();
    expect(byName.get('mobile')).toMatchObject({ conflict: false, flag: '', conflictSessions: [] });

    // The developer's checkout: same branch, same changes, nothing stashed; no forbidden git call anywhere.
    expect(await g.git(g.mobile, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(await g.git(g.mobile, 'status', '--porcelain')).toBe(statusBefore);
    expect(await g.git(g.mobile, 'stash', 'list')).toBe('');
    expect(forbiddenGitCalls(await g.gitCalls())).toEqual([]);
  });

  it('a worktree session plus one in place is a conflict; ended sessions do not count; a detached one counts but cannot be moved', async () => {
    const { s, g } = await setup();
    const isolated = await start(s, { name: 'has-worktree', solutions: ['web-front'], worktrees: true });
    const inPlace = await start(s, { name: 'in-place', solutions: ['web-front'] });
    let web = (await rows()).get('web-front');
    expect(web).toMatchObject({ conflict: true, flag: '⚠ shared working tree' });
    expect(web?.conflictSessions.map((c) => [c.sessionId, c.isolated, c.repo])).toEqual([
      [isolated.id, true, 'web-front'],
      [inPlace.id, false, 'web-front'],
    ]);

    // A session that ended (its process failed) no longer writes: mobile has one live writer only.
    const crashed = await start(s, { name: 'crashed', solutions: ['mobile'], task: '[fake:crash]' });
    expect((await s.store.sessions.get(crashed.id))?.endedAt).not.toBeNull();
    await start(s, { name: 'mobile-live', solutions: ['mobile'] });
    expect((await rows()).get('mobile')).toMatchObject({ conflict: false, conflictSessions: [] });

    // Paused and detached sessions are still open: they count. A detached one cannot be isolated (409).
    await s.supervisor.pause(isolated.id);
    await s.supervisor.detach(inPlace.id);
    web = (await rows()).get('web-front');
    expect(web?.conflict).toBe(true);
    expect(web?.conflictSessions.map((c) => [c.name, c.isolated, c.attached])).toEqual([
      ['has-worktree', true, true],
      ['in-place', false, false],
    ]);
    const refused = await call('POST', '/api/solutions/web-front/isolate', { sessionId: inPlace.id });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'detached' });
    expect(await exists(path.join(path.dirname(g.web), 'web-front-wt-in-place'))).toBe(false);
  });
});
