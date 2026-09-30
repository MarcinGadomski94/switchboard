import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepoBranch, RepoBranches, Session } from '../../../src/core/api.ts';
import type { UserPayload } from '../../../src/core/event-payload.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type GitWorld, forbiddenGitCalls, makeGitWorld } from '../../helpers/git.ts';
import { type OriginRepo, makeOriginRepo } from '../../helpers/origin.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, payloadType, spawnedArgv, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D60 oracle (real path, D13): "Move … to worktree" onto an **existing** branch.
 * `GET /api/solutions/{repo}/branches` and `POST /api/solutions/{repo}/isolate
 * { sessionId, existingBranch }` with fake-claude, the real worktree manager (git
 * through the logging spy) and `microfrontends/alpha-front` cloned from a
 * **local bare origin** (never a real remote). Covered: the list (local first,
 * remote-only, checked out elsewhere, subject + date, a fetch bringing a new
 * remote branch, a failed fetch keeping the local list); isolate onto a local
 * branch, onto a remote-only branch (a tracking local branch), onto a remote
 * branch whose local branch exists (the local one wins); the refusals (checked
 * out elsewhere, unknown, both fields, a name that is an option); the move
 * message; the developer's checkout untouched; nothing pushed.
 */
const PORT = 4876; // inject() opens no socket; the port feeds the Host check only
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

interface World {
  readonly s: SupervisorWorld;
  readonly g: GitWorld;
  /** Origin: master, `PROJ-5-remote-only`, `PROJ-6-shared` (also local, at an older commit). Local only: `PROJ-7-local`, `PROJ-8-busy` (checked out in another worktree). */
  readonly alpha: OriginRepo;
  /** Where `PROJ-8-busy` is checked out. */
  readonly busy: string;
}

async function setup(): Promise<World> {
  sw = await makeSupervisorWorld({ scenario: 'handoff-start' });
  const g = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  const alpha = await makeOriginRepo(g.git, g.root, path.join(g.workspace, 'microfrontends', 'alpha-front'), [
    ['PROJ-5-remote-only', 'master'],
    ['PROJ-6-shared', 'master'],
  ]);
  const repo = await realpath(alpha.repo);
  // A local PROJ-6-shared at master (origin's is one commit ahead), a local-only branch, and one checked out elsewhere.
  await g.git(repo, 'branch', 'PROJ-6-shared', 'master');
  await g.git(repo, 'branch', 'PROJ-7-local', 'master');
  const busy = path.join(g.root, 'busy-elsewhere');
  await g.git(repo, 'worktree', 'add', '-q', '-b', 'PROJ-8-busy', busy);
  const worktrees = g.manager({ sessions: sw.supervisor });
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: sw.root }, platform: 'linux', home: sw.root, cwd: sw.root });
  await seedFolder(sw.store, g.workspace);
  app = await buildApp({ config: { ...base, port: PORT }, token, store: sw.store, webRoot: sw.root, supervisor: sw.supervisor, worktrees, providers: { diff: worktrees } });
  await app.ready();
  return { s: sw, g, alpha: { ...alpha, repo }, busy: await realpath(busy) };
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

async function startInPlace(s: SupervisorWorld, name: string): Promise<Session> {
  const response = await call('POST', '/api/sessions', newSession({ name, solutions: ['alpha-front'] }));
  expect(response.statusCode, response.body).toBe(201);
  const session = response.json() as Session;
  await waitForStatus(s.store, session.id, ['done']);
  return session;
}

async function branches(sessionId: string, fetch = false): Promise<RepoBranches> {
  const response = await call('GET', `/api/solutions/alpha-front/branches?session=${sessionId}${fetch ? '&fetch=1' : ''}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as RepoBranches;
}

function byName(list: RepoBranches, name: string): RepoBranch | undefined {
  return list.branches.find((branch) => branch.name === name);
}

/** The move message the session got (the service's user message). */
async function moveMessage(s: SupervisorWorld, sessionId: string): Promise<string> {
  return until(async () => {
    const events = await s.store.events.list(sessionId);
    const moved = events.find((e) => payloadType(e) === 'user' && (e.payload as UserPayload).origin === 'service');
    return moved ? (moved.payload as UserPayload).text : undefined;
  }, 'the move message');
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

describe('D60 · GET /api/solutions/{repo}/branches', () => {
  it('lists local branches first, then remote ones; checked out elsewhere is named; a fetch brings new remote branches', async () => {
    const { s, g, alpha, busy } = await setup();
    const session = await startInPlace(s, 'lister');

    const cached = await branches(session.id);
    expect(cached.repo).toBe('alpha-front');
    expect(cached.repoPath).toBe(alpha.repo);
    expect(cached.fetched).toBeNull();
    expect(cached.fetchError).toBeNull();
    const kinds = cached.branches.map((branch) => branch.kind);
    expect(kinds.indexOf('remote')).toBeGreaterThan(kinds.lastIndexOf('local'));
    expect(cached.branches.filter((b) => b.kind === 'local').map((b) => b.name).sort()).toEqual(['PROJ-6-shared', 'PROJ-7-local', 'PROJ-8-busy', 'master']);
    expect(cached.branches.filter((b) => b.kind === 'remote').map((b) => b.name).sort()).toEqual(['origin/PROJ-5-remote-only', 'origin/PROJ-6-shared', 'origin/master']);
    // origin/HEAD is not a branch.
    expect(byName(cached, 'origin/HEAD')).toBeUndefined();

    expect(byName(cached, 'master')).toMatchObject({ kind: 'local', remote: null, localName: 'master', upstream: 'origin/master', checkedOutAt: alpha.repo, subject: 'write README.md' });
    expect(byName(cached, 'PROJ-8-busy')).toMatchObject({ checkedOutAt: busy, upstream: null });
    expect(byName(cached, 'PROJ-7-local')).toMatchObject({ checkedOutAt: null, upstream: null, localExists: true });
    expect(byName(cached, 'origin/PROJ-5-remote-only')).toMatchObject({
      kind: 'remote',
      remote: 'origin',
      localName: 'PROJ-5-remote-only',
      upstream: 'origin/PROJ-5-remote-only',
      localExists: false,
      checkedOutAt: null,
      subject: 'write PROJ-5-remote-only.txt',
    });
    expect(byName(cached, 'origin/PROJ-6-shared')).toMatchObject({ localExists: true, checkedOutAt: null });
    // origin/master's local branch is checked out in the main checkout: the remote row says so too.
    expect(byName(cached, 'origin/master')?.checkedOutAt).toBe(alpha.repo);
    expect(Number.isNaN(Date.parse(byName(cached, 'PROJ-7-local')?.committedAt ?? ''))).toBe(false);

    // Someone pushes a new branch: the cached list lacks it until a fetch.
    await alpha.push('PROJ-9-late', 'late.txt', 'late\n');
    expect(byName(await branches(session.id), 'origin/PROJ-9-late')).toBeUndefined();
    const fetched = await branches(session.id, true);
    expect(fetched.fetched).toBe(true);
    expect(fetched.fetchError).toBeNull();
    expect(byName(fetched, 'origin/PROJ-9-late')).toMatchObject({ kind: 'remote', subject: 'write late.txt', localExists: false });

    // Nothing was created, checked out or pushed by listing.
    expect(await s.store.worktrees.list()).toEqual([]);
    expect(await g.git(alpha.repo, 'symbolic-ref', '--short', 'HEAD')).toBe('master');
    expect(forbiddenGitCalls(await g.gitCalls())).toEqual([]);
  });

  it('a failed fetch keeps the list of what is known locally and says why; bad input is refused', async () => {
    const { s, g, alpha } = await setup();
    const session = await startInPlace(s, 'offline');
    await g.git(alpha.repo, 'remote', 'set-url', 'origin', path.join(g.root, 'no-such-origin.git'));
    const list = await branches(session.id, true);
    expect(list.fetched).toBe(false);
    expect(list.fetchError).toMatch(/^git fetch failed: /);
    expect(byName(list, 'PROJ-7-local')).toBeDefined();
    expect(byName(list, 'origin/PROJ-5-remote-only')).toBeDefined();

    const noSession = await call('GET', '/api/solutions/alpha-front/branches');
    expect(noSession.statusCode).toBe(422);
    expect(noSession.json()).toMatchObject({ error: 'invalid', errors: [{ field: 'session' }] });
    expect((await call('GET', '/api/solutions/alpha-front/branches?session=nope')).statusCode).toBe(404);
    const unknownRepo = await call('GET', `/api/solutions/nope-front/branches?session=${session.id}`);
    expect(unknownRepo.statusCode).toBe(422);
    expect(unknownRepo.json()).toMatchObject({ error: 'invalid', errors: [{ field: 'repo' }] });
  });
});

describe('D60 · POST /api/solutions/{repo}/isolate { existingBranch }', () => {
  it('a local branch: the worktree is on it as it is; the move message says it is an existing branch', async () => {
    const { s, g, alpha } = await setup();
    const session = await startInPlace(s, 'local-one');
    const statusBefore = await g.git(alpha.repo, 'status', '--porcelain');
    const tipBefore = await g.git(alpha.repo, 'rev-parse', 'PROJ-7-local');

    const response = await call('POST', '/api/solutions/alpha-front/isolate', { sessionId: session.id, existingBranch: 'PROJ-7-local' });
    expect(response.statusCode, response.body).toBe(201);
    const target = path.join(path.dirname(alpha.repo), 'alpha-front-wt-local-one');
    expect(response.json()).toMatchObject({ repo: 'alpha-front', branch: 'PROJ-7-local', path: target, sessionId: session.id });
    expect(await g.git(target, 'branch', '--show-current')).toBe('PROJ-7-local');
    expect(await g.git(target, 'rev-parse', 'HEAD')).toBe(tipBefore);
    const [row] = await s.store.worktrees.list({ sessionId: session.id });
    expect(row?.baseRef).toBe('origin/master');

    const message = await moveMessage(s, session.id);
    expect(message).toContain(`in ${target} (the existing branch PROJ-7-local, which tracks no remote branch)`);
    expect(message).toContain("you are continuing that branch's work, not starting fresh");
    expect(message).toContain(`Do not stash, reset or check out anything in ${alpha.repo}`);
    await waitForStatus(s.store, session.id, ['done']);

    // A second click gives the same worktree back (200), nothing new.
    const again = await call('POST', '/api/solutions/alpha-front/isolate', { sessionId: session.id, existingBranch: 'PROJ-6-shared' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ branch: 'PROJ-7-local', path: target });

    expect(await g.git(alpha.repo, 'symbolic-ref', '--short', 'HEAD')).toBe('master');
    expect(await g.git(alpha.repo, 'status', '--porcelain')).toBe(statusBefore);
    expect(forbiddenGitCalls(await g.gitCalls())).toEqual([]);
  });

  it('a remote-only branch: a local branch of that name tracking it; nothing is pushed', async () => {
    const { s, g, alpha } = await setup();
    const session = await startInPlace(s, 'remote-one');
    const originBefore = await alpha.refs();
    const response = await call('POST', '/api/solutions/alpha-front/isolate', { sessionId: session.id, existingBranch: 'origin/PROJ-5-remote-only' });
    expect(response.statusCode, response.body).toBe(201);
    const target = path.join(path.dirname(alpha.repo), 'alpha-front-wt-remote-one');
    expect(response.json()).toMatchObject({ branch: 'PROJ-5-remote-only', path: target });
    expect(await g.git(target, 'branch', '--show-current')).toBe('PROJ-5-remote-only');
    expect(await g.git(target, 'rev-parse', '--abbrev-ref', 'PROJ-5-remote-only@{upstream}')).toBe('origin/PROJ-5-remote-only');
    expect(await g.git(target, 'rev-parse', 'HEAD')).toBe(await g.git(alpha.repo, 'rev-parse', 'origin/PROJ-5-remote-only'));
    const message = await moveMessage(s, session.id);
    expect(message).toContain('(the existing branch PROJ-5-remote-only, made from origin/PROJ-5-remote-only and tracking it)');
    expect(message).toContain('If origin/PROJ-5-remote-only has commits the branch lacks, bring them in before you build on it.');
    await waitForStatus(s.store, session.id, ['done']);
    expect(await alpha.refs()).toBe(originBefore);
  });

  it('a remote branch whose local branch exists: the worktree is on the local one, and the message says so (ASSUMED D60-local-wins)', async () => {
    const { s, g, alpha } = await setup();
    const session = await startInPlace(s, 'shared-one');
    const localTip = await g.git(alpha.repo, 'rev-parse', 'PROJ-6-shared');
    const response = await call('POST', '/api/solutions/alpha-front/isolate', { sessionId: session.id, existingBranch: 'origin/PROJ-6-shared' });
    expect(response.statusCode, response.body).toBe(201);
    const target = path.join(path.dirname(alpha.repo), 'alpha-front-wt-shared-one');
    expect(await g.git(target, 'branch', '--show-current')).toBe('PROJ-6-shared');
    expect(await g.git(target, 'rev-parse', 'HEAD')).toBe(localTip);
    const message = await moveMessage(s, session.id);
    expect(message).toContain('(the existing branch PROJ-6-shared, which tracks no remote branch; origin/PROJ-6-shared was picked, but the local branch PROJ-6-shared already existed, so the worktree uses it)');
    await waitForStatus(s.store, session.id, ['done']);
  });

  it('refusals: checked out in the main checkout or another worktree, unknown, both fields, a name that is an option; nothing made or paused', async () => {
    const { s, g, alpha, busy } = await setup();
    const session = await startInPlace(s, 'refused');
    const post = (payload: Record<string, unknown>) => call('POST', '/api/solutions/alpha-front/isolate', { sessionId: session.id, ...payload });

    const main = await post({ existingBranch: 'master' });
    expect(main.statusCode).toBe(409);
    expect(main.json()).toEqual({ error: 'branch-checked-out', message: `alpha-front: master is checked out at ${alpha.repo}` });
    const viaRemote = await post({ existingBranch: 'origin/master' });
    expect(viaRemote.json()).toEqual({ error: 'branch-checked-out', message: `alpha-front: master is checked out at ${alpha.repo}` });
    const elsewhere = await post({ existingBranch: 'PROJ-8-busy' });
    expect(elsewhere.statusCode).toBe(409);
    expect(elsewhere.json()).toEqual({ error: 'branch-checked-out', message: `alpha-front: PROJ-8-busy is checked out at ${busy}` });
    const unknown = await post({ existingBranch: 'origin/PROJ-404-gone' });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toEqual({ error: 'branch-not-found', message: 'alpha-front has no branch origin/PROJ-404-gone' });
    expect((await post({ existingBranch: 'origin/HEAD' })).json()).toMatchObject({ error: 'branch-not-found' });

    const both = await post({ existingBranch: 'PROJ-7-local', branch: 'PROJ-1-new' });
    expect(both.statusCode).toBe(422);
    expect(both.json()).toEqual({ error: 'invalid', errors: [{ field: 'existingBranch', message: 'send either branch (a new branch) or existingBranch, not both' }] });
    for (const bad of ['--orphan', '', 'a b', 'x..y', 42]) {
      const response = await post({ existingBranch: bad });
      expect(response.statusCode, String(bad)).toBe(422);
      expect(response.json()).toMatchObject({ errors: [{ field: 'existingBranch' }] });
    }
    // D32 still applies to a new branch.
    expect((await post({ branch: 'not-a-ticket' })).statusCode).toBe(422);

    expect(await s.store.worktrees.list()).toEqual([]);
    expect(await exists(path.join(path.dirname(alpha.repo), 'alpha-front-wt-refused'))).toBe(false);
    expect(await spawnedArgv(s.logFile)).toHaveLength(1);
    expect(forbiddenGitCalls(await g.gitCalls())).toEqual([]);

    // A detached session is still refused first.
    await s.supervisor.detach(session.id);
    expect((await post({ existingBranch: 'PROJ-7-local' })).json()).toMatchObject({ error: 'detached' });
  });
});
