import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { BRANCH_REQUIRED, BRANCH_RULE } from '../../../src/core/ticket-branch.ts';
import type { LifecyclePayload, UserPayload } from '../../../src/core/event-payload.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { generateToken } from '../../../src/server/token.ts';
import type { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type GitWorld, forbiddenGitCalls, makeGitWorld } from '../../helpers/git.ts';
import {
  type SupervisorWorld,
  makeSupervisorWorld,
  newSession,
  payloadType,
  spawnedArgv,
  stdinOf,
  until,
  waitForStatus,
} from '../../helpers/supervisor.ts';

const PORT = 4873; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let sw: SupervisorWorld | undefined;
let gw: GitWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await sw?.cleanup();
  app = undefined;
  sw = undefined;
  gw = undefined;
});

/** A fake-claude supervisor and real git repos in the same temp workspace. */
async function setup(scenario = 'handoff-start'): Promise<{ s: SupervisorWorld; g: GitWorld; m: WorktreeManager }> {
  sw = await makeSupervisorWorld({ scenario });
  gw = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  return { s: sw, g: gw, m: gw.manager({ sessions: sw.supervisor }) };
}

/** The fake logs its argv a moment after it was spawned: wait until `count` spawns are logged. */
function spawnsWhenLogged(s: SupervisorWorld, count: number) {
  return until(async () => {
    const spawns = await spawnedArgv(s.logFile);
    return spawns.length >= count ? spawns : undefined;
  }, `${count} logged spawn(s)`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function withApp(s: SupervisorWorld, m: WorktreeManager, workspace: string | null = s.workspace): Promise<void> {
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: s.root }, platform: 'linux', home: s.root, cwd: s.root });
  // D14: the workspace is the saved (default) folder; `null` = nothing saved.
  if (workspace) await seedFolder(s.store, workspace);
  app = await buildApp({ config: { ...base, port: PORT }, token, store: s.store, webRoot: s.root, supervisor: s.supervisor, worktrees: m });
  await app.ready();
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

describe('WorktreeManager · isolate (gap #2)', () => {
  it('creates the worktree, pauses the session and resumes it with the move message; the developer tree is untouched', async () => {
    const { s, g, m } = await setup();
    const session = await s.supervisor.start(newSession({ name: 'mover', solutions: ['web-front'] }), s.place);
    await waitForStatus(s.store, session.id, ['done']);
    await writeFile(path.join(g.web, 'README.md'), 'hello\nthe session wrote here in place\n');
    const statusBefore = await g.git(g.web, 'status', '--porcelain');

    // D32: the developer names the branch after the ticket (the route requires it).
    const result = await m.isolate('web-front', session.id, { branch: 'PROJ-4-mover' });

    const target = path.join(path.dirname(g.web), 'web-front-wt-mover');
    expect(result.created).toBe(true);
    expect(result.worktree).toMatchObject({ repo: 'web-front', branch: 'PROJ-4-mover', path: target, sessionId: session.id, baseRef: 'main' });
    expect(await exists(target)).toBe(true);
    expect(await g.git(target, 'branch', '--show-current')).toBe('PROJ-4-mover');
    // Paused (D7 stop), then resumed with --resume and the move message instead of "Continue.".
    const spawns = await spawnsWhenLogged(s, 2);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.argv).toContain('--resume');
    expect(spawns[1]?.argv).toContain(session.claudeSessionId);
    const stdin = await until(async () => {
      const lines = await stdinOf(s.logFile, spawns[1]?.pid ?? -1);
      return lines.length > 0 ? lines : undefined;
    }, 'the resumed process stdin');
    const content = (stdin[0]?.['message'] as { content?: string } | undefined)?.content ?? '';
    expect(content).toContain(target);
    expect(content).toContain('branch PROJ-4-mover');
    expect(content).not.toContain('session/mover');
    expect(content).toContain(`Do not stash, reset or check out anything in ${g.web}`);
    const events = await s.store.events.list(session.id);
    expect(events.filter((e) => payloadType(e) === 'lifecycle').map((e) => (e.payload as LifecyclePayload).action)).toEqual(['started', 'paused', 'resumed']);
    const moved = events.find((e) => payloadType(e) === 'user' && (e.payload as UserPayload).origin === 'service');
    expect((moved?.payload as UserPayload).text).toBe(content);
    await waitForStatus(s.store, session.id, ['done']);
    // The developer's working tree: same branch, same changes, nothing stashed.
    expect(await g.git(g.web, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(await g.git(g.web, 'status', '--porcelain')).toBe(statusBefore);
    expect(await g.git(g.web, 'stash', 'list')).toBe('');
    expect(forbiddenGitCalls(await g.gitCalls())).toEqual([]);

    // Asking again does nothing new.
    const again = await m.isolate('web-front', session.id, { branch: 'PROJ-5-other' });
    expect(again).toEqual({ worktree: result.worktree, created: false, existing: null });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await spawnedArgv(s.logFile)).toHaveLength(2);
  });

  it('a session without a live process is resumed with the message; detached and unknown sessions are refused before anything is created', async () => {
    const { s, g, m } = await setup();
    const paused = await s.supervisor.start(newSession({ name: 'paused-one', solutions: ['mobile'] }), s.place);
    await waitForStatus(s.store, paused.id, ['done']);
    await s.supervisor.pause(paused.id);
    expect((await m.isolate('mobile', paused.id)).created).toBe(true);
    expect(await spawnsWhenLogged(s, 2)).toHaveLength(2);
    await waitForStatus(s.store, paused.id, ['done']);

    const away = await s.supervisor.start(newSession({ name: 'away', solutions: ['mobile'] }), s.place);
    await waitForStatus(s.store, away.id, ['done']);
    await s.supervisor.detach(away.id);
    await expect(m.isolate('mobile', away.id)).rejects.toMatchObject({ code: 'detached' });
    expect(await exists(path.join(g.workspace, 'mobile-wt-away'))).toBe(false);
    await expect(m.isolate('mobile', 'no-such-session')).rejects.toMatchObject({ code: 'session-not-found' });
  });
});

describe('REST · worktrees (M2.2)', () => {
  it('POST /api/sessions with worktrees: one per solution, linked to the session before its process starts', async () => {
    const { s, g, m } = await setup();
    await withApp(s, m);
    // D32: one ticket branch, used in every solution's repo (the folders still follow the short name).
    const response = await call('POST', '/api/sessions', newSession({ name: 'wt-session', solutions: ['web-front', 'mobile'], worktrees: true, branch: 'PROJ-0001-test-branch-name' }));
    expect(response.statusCode).toBe(201);
    const session = response.json() as Session;
    const rows = await s.store.worktrees.list({ sessionId: session.id });
    expect(rows.map((r) => [r.repo, r.branch, r.path])).toEqual([
      ['web-front', 'PROJ-0001-test-branch-name', path.join(path.dirname(g.web), 'web-front-wt-wt-session')],
      ['mobile', 'PROJ-0001-test-branch-name', path.join(g.workspace, 'mobile-wt-wt-session')],
    ]);
    for (const row of rows) {
      expect(await exists(row.path)).toBe(true);
      expect(await g.git(row.path, 'branch', '--show-current')).toBe('PROJ-0001-test-branch-name');
    }
    // No session/ branch was made anywhere.
    expect(await g.git(g.web, 'branch', '--list', 'session/*')).toBe('');
    expect(await g.git(g.mobile, 'branch', '--list', 'session/*')).toBe('');
    const events = await s.store.events.list(session.id);
    const started = events.find((e) => payloadType(e) === 'lifecycle');
    for (const row of rows) expect(row.updatedAt <= (started?.ts ?? '')).toBe(true);
    // The process still runs in the workspace root (ARCHITECTURE); the worktrees are where the agent edits.
    const [spawn] = await spawnsWhenLogged(s, 1);
    expect(spawn?.cwd).toBe(s.workspace);
    await waitForStatus(s.store, session.id, ['done']);
  });

  it('POST /api/sessions: a solution without a repo → 422 and nothing is created or spawned; an existing branch → 409', async () => {
    const { s, g, m } = await setup();
    await withApp(s, m);
    const missing = await call('POST', '/api/sessions', newSession({ name: 'half', solutions: ['web-front', 'nope-front'], worktrees: true, branch: 'PROJ-1-half' }));
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ error: 'invalid', errors: [{ field: 'solutions' }] });
    expect(await exists(path.join(path.dirname(g.web), 'web-front-wt-half'))).toBe(false);

    // D40 (replaces D32's refusal of an existing branch): an existing ticket branch is reused, but one checked out in
    // another worktree → 409 naming that repo; nothing is made in the other.
    const elsewhere = path.join(g.root, 'clash-elsewhere');
    await g.git(g.mobile, 'worktree', 'add', '-q', '-b', 'PROJ-9-clash', elsewhere);
    const clash = await call('POST', '/api/sessions', newSession({ name: 'clash', solutions: ['web-front', 'mobile'], worktrees: true, branch: 'PROJ-9-clash' }));
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toEqual({ error: 'branch-checked-out', message: `mobile: PROJ-9-clash is checked out at ${elsewhere}` });
    expect(await exists(path.join(path.dirname(g.web), 'web-front-wt-clash'))).toBe(false);
    expect(await g.git(g.web, 'branch', '--list', 'PROJ-9-clash')).toBe('');

    expect(await s.store.sessions.list()).toEqual([]);
    expect(await spawnedArgv(s.logFile)).toEqual([]);
    expect(await s.store.worktrees.list()).toEqual([]);
  });

  it('D32: POST /api/sessions with worktrees needs a ticket branch (422 on branch, nothing made); without a worktree none is needed', async () => {
    const { s, g, m } = await setup();
    await withApp(s, m);
    const none = await call('POST', '/api/sessions', newSession({ name: 'no-branch', solutions: ['web-front'], worktrees: true }));
    expect(none.statusCode).toBe(422);
    expect(none.json()).toEqual({ error: 'invalid', errors: [{ field: 'branch', message: BRANCH_REQUIRED }] });
    for (const branch of ['proj-1-lower', 'PROJ-1', 'session/x', 'PROJ-1-Upper']) {
      const bad = await call('POST', '/api/sessions', newSession({ name: 'bad-branch', solutions: ['web-front'], worktrees: true, branch }));
      expect(bad.statusCode, branch).toBe(422);
      expect(bad.json()).toEqual({ error: 'invalid', errors: [{ field: 'branch', message: BRANCH_RULE }] });
    }
    expect(await exists(path.join(path.dirname(g.web), 'web-front-wt-no-branch'))).toBe(false);
    expect(await s.store.sessions.list()).toEqual([]);
    expect(await spawnedArgv(s.logFile)).toEqual([]);
    expect(await s.store.worktrees.list()).toEqual([]);

    // In place: no branch needed, and a branch sent anyway is not used.
    const inPlace = await call('POST', '/api/sessions', newSession({ name: 'in-place', solutions: ['web-front'], worktrees: false, branch: 'whatever' }));
    expect(inPlace.statusCode).toBe(201);
    await waitForStatus(s.store, (inPlace.json() as Session).id, ['done']);
    expect(await s.store.worktrees.list()).toEqual([]);
    expect(await g.git(g.web, 'branch', '--list', 'whatever')).toBe('');
  });

  it('POST /api/sessions with worktrees and no saved folder → 409 no-folder (D14)', async () => {
    const { s, g } = await setup();
    await withApp(s, g.manager({ sessions: s.supervisor }), null);
    const response = await call('POST', '/api/sessions', newSession({ name: 'nowhere', worktrees: true }));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'no-folder' });
  });

  it('POST /api/solutions/{repo}/isolate → 201 Worktree, then 200 with the same one; 422 / 404 on bad input', async () => {
    const { s, g, m } = await setup();
    await withApp(s, m);
    const created = await call('POST', '/api/sessions', newSession({ name: 'iso', solutions: ['web-front'] }));
    const session = created.json() as Session;
    await waitForStatus(s.store, session.id, ['done']);

    // D32: the branch is required and must be a ticket branch; nothing is made (or paused) before it is.
    const noBranch = await call('POST', '/api/solutions/web-front/isolate', { sessionId: session.id });
    expect(noBranch.statusCode).toBe(422);
    expect(noBranch.json()).toEqual({ error: 'invalid', errors: [{ field: 'branch', message: BRANCH_REQUIRED }] });
    const badBranch = await call('POST', '/api/solutions/web-front/isolate', { sessionId: session.id, branch: 'iso' });
    expect(badBranch.json()).toEqual({ error: 'invalid', errors: [{ field: 'branch', message: BRANCH_RULE }] });
    // A branch the repo has already → 409 naming the repo; the session is not paused.
    await g.git(g.web, 'branch', 'PROJ-8-taken');
    const taken = await call('POST', '/api/solutions/web-front/isolate', { sessionId: session.id, branch: 'PROJ-8-taken' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: 'branch-exists', message: 'web-front already has a branch PROJ-8-taken' });
    expect(await s.store.worktrees.list()).toEqual([]);
    expect(await spawnedArgv(s.logFile)).toHaveLength(1);

    const first = await call('POST', '/api/solutions/web-front/isolate', { sessionId: session.id, branch: 'PROJ-3-iso' });
    expect(first.statusCode).toBe(201);
    const worktree = first.json() as Record<string, unknown>;
    expect(worktree).toEqual({
      id: expect.any(String),
      repo: 'web-front',
      branch: 'PROJ-3-iso',
      path: path.join(path.dirname(g.web), 'web-front-wt-iso'),
      sessionId: session.id,
      prNumber: null,
      prState: null,
      removable: false,
    });
    expect(await g.git(path.join(path.dirname(g.web), 'web-front-wt-iso'), 'branch', '--show-current')).toBe('PROJ-3-iso');
    await until(async () => (await spawnedArgv(s.logFile)).length === 2, 'the resumed process');
    await waitForStatus(s.store, session.id, ['done']);
    const second = await call('POST', '/api/solutions/web-front/isolate', { sessionId: session.id, branch: 'PROJ-3-iso' });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(worktree);

    const empty = await call('POST', '/api/solutions/web-front/isolate', {});
    expect(empty.statusCode).toBe(422);
    expect(empty.json().errors.map((e: { field: string }) => e.field)).toEqual(['sessionId', 'branch']);
    expect((await call('POST', '/api/solutions/web-front/isolate', { sessionId: 'nope', branch: 'PROJ-3-iso' })).statusCode).toBe(404);
    const unknownRepo = await call('POST', '/api/solutions/nope-front/isolate', { sessionId: session.id, branch: 'PROJ-3-iso' });
    expect(unknownRepo.statusCode).toBe(422);
    expect(unknownRepo.json()).toMatchObject({ error: 'invalid', errors: [{ field: 'repo' }] });
    expect(await readFile(path.join(g.web, 'README.md'), 'utf8')).toBe('hello\n');
  });
});
