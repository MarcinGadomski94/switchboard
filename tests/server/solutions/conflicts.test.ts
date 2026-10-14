import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session, Solution, SolutionGroup } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { LiveSolutions } from '../../../src/server/solutions/live.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
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
  const solutions = new LiveSolutions({ store: sw.store, diff: m, resolveRepo: (solution, folder) => m.resolveRepo(solution, folder), repos: m.repos });
  await seedFolder(sw.store, g.workspace);
  app = await buildApp({
    config: { ...base, port: PORT },
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
    // D22: a titled writer; its worktree still comes from its short name (D32: its branch is the one the developer names).
    const first = await start(s, { name: 'first-writer', title: 'First writer', solutions: ['mobile'], task: '[fake:write mobile/first-writer.md]' });
    const second = await start(s, { name: 'second-writer', solutions: ['mobile'], task: '[fake:write mobile/second-writer.md]' });
    await start(s, { name: 'web-alone', solutions: ['web-front'], task: '[fake:write microfrontends/web-front/web-alone.md]' });
    const statusBefore = await g.git(g.mobile, 'status', '--porcelain');

    let byName = await rows();
    expect(byName.get('mobile')).toMatchObject({
      conflict: true,
      flag: '⚠ shared working tree',
      conflictSessions: [
        { sessionId: first.id, name: 'first-writer', title: 'First writer', isolated: false, repo: 'mobile', attached: true },
        { sessionId: second.id, name: 'second-writer', title: null, isolated: false, repo: 'mobile', attached: true },
      ],
    });
    // One session alone in a checkout, and read-only rows, have no conflict.
    expect(byName.get('web-front')).toMatchObject({ conflict: false, flag: '', conflictSessions: [] });
    expect(byName.get('old-front')).toMatchObject({ conflict: false, flag: '', conflictSessions: [] });

    // "Move second-writer to worktree": its own worktree; first-writer is still in the main checkout → still a conflict.
    // D32: on the ticket branch the developer named in the confirm step.
    const moved = await call('POST', '/api/solutions/mobile/isolate', { sessionId: second.id, branch: 'PROJ-2-second-writer' });
    expect(moved.statusCode).toBe(201);
    expect(moved.json()).toMatchObject({ repo: 'mobile', branch: 'PROJ-2-second-writer', path: path.join(g.workspace, 'mobile-wt-second-writer'), sessionId: second.id });
    expect(await exists(path.join(g.workspace, 'mobile-wt-second-writer'))).toBe(true);
    await until(async () => (await spawnedArgv(s.logFile)).length >= 4, 'second-writer resumed with the move message');
    await waitForStatus(s.store, second.id, ['done']);
    byName = await rows();
    expect(byName.get('mobile')?.conflict).toBe(true);
    expect(byName.get('mobile')?.conflictSessions.map((c) => [c.name, c.isolated])).toEqual([
      ['first-writer', false],
      ['second-writer', true],
    ]);
    // D22 (ruling 4): each branch names its owner by the session's display title; the titled writer's in-place branch too.
    expect(byName.get('mobile')?.branches.map((b) => [b.branch, b.owner, b.ownerTitle, b.worktree === null])).toEqual([
      ['PROJ-2-second-writer', 'second-writer', 'second-writer', false],
      ['main', 'first-writer', 'First writer', true],
    ]);

    // Move the other one: every writer has its own worktree → no conflict.
    const movedFirst = await call('POST', '/api/solutions/mobile/isolate', { sessionId: first.id, branch: 'PROJ-1-first-writer' });
    expect(movedFirst.statusCode).toBe(201);
    // D22: the titled session's worktree is named after its short name, never its title; D32: its branch is the ticket branch.
    expect(movedFirst.json()).toMatchObject({ branch: 'PROJ-1-first-writer', path: path.join(g.workspace, 'mobile-wt-first-writer') });
    await until(async () => (await spawnedArgv(s.logFile)).length >= 5, 'first-writer resumed with the move message');
    await waitForStatus(s.store, first.id, ['done']);
    byName = await rows();
    expect(byName.get('mobile')).toMatchObject({ conflict: false, flag: '', conflictSessions: [] });
    // D22 (ruling 4): the titled writer's worktree branch is owned by its title.
    expect(byName.get('mobile')?.branches.find((b) => b.sessionId === first.id)).toMatchObject({
      branch: 'PROJ-1-first-writer',
      owner: 'first-writer',
      ownerTitle: 'First writer',
    });

    // The developer's checkout: same branch, same changes, nothing stashed; no forbidden git call anywhere.
    expect(await g.git(g.mobile, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(await g.git(g.mobile, 'status', '--porcelain')).toBe(statusBefore);
    expect(await g.git(g.mobile, 'stash', 'list')).toBe('');
    expect(forbiddenGitCalls(await g.gitCalls())).toEqual([]);
  });

  it('a worktree session plus one in place is a conflict; ended sessions do not count; a detached one counts but cannot be moved', async () => {
    const { s, g } = await setup();
    const isolated = await start(s, { name: 'has-worktree', solutions: ['web-front'], worktrees: true, branch: 'PROJ-5-has-worktree' });
    const inPlace = await start(s, { name: 'in-place', solutions: ['web-front'], task: '[fake:write microfrontends/web-front/in-place.md]' });
    let web = (await rows()).get('web-front');
    expect(web).toMatchObject({ conflict: true, flag: '⚠ shared working tree' });
    expect(web?.conflictSessions.map((c) => [c.sessionId, c.isolated, c.repo])).toEqual([
      [isolated.id, true, 'web-front'],
      [inPlace.id, false, 'web-front'],
    ]);

    // A session that ended (its process failed) no longer writes: mobile has one live writer only.
    const crashed = await start(s, { name: 'crashed', solutions: ['mobile'], task: '[fake:crash]' });
    expect((await s.store.sessions.get(crashed.id))?.endedAt).not.toBeNull();
    await start(s, { name: 'mobile-live', solutions: ['mobile'], task: '[fake:write mobile/mobile-live.md]' });
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
    const refused = await call('POST', '/api/solutions/web-front/isolate', { sessionId: inPlace.id, branch: 'PROJ-6-in-place' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'detached' });
    expect(await exists(path.join(path.dirname(g.web), 'web-front-wt-in-place'))).toBe(false);
  });

  // 2026-10-14 (stale Solutions and conflicts): where a session writes comes from the shared repo set (session-repos.ts).
  it('two sessions each in its own agent-made linked worktree of one repo: isolated, no conflict; two editing the main checkout: a conflict', async () => {
    const { s, g } = await setup();
    // The agents made these themselves (`git worktree add`), Switchboard did not register them.
    const treeA = path.join(path.dirname(g.web), 'web-front-wt-acme-101-checkout');
    const treeB = path.join(path.dirname(g.web), 'web-front-wt-acme-102-billing');
    await g.git(g.web, 'worktree', 'add', '-q', '-b', 'ACME-101-checkout', treeA);
    await g.git(g.web, 'worktree', 'add', '-q', '-b', 'ACME-102-billing', treeB);
    // D38: a write in a linked worktree adds that folder's name to the session; the other one also names the main checkout
    // (picked at the start) but only writes in its worktree.
    const a = await start(s, { name: 'acme-checkout', solutions: [], task: '[fake:write microfrontends/web-front-wt-acme-101-checkout/notes.md]' });
    const b = await start(s, { name: 'acme-billing', solutions: ['web-front'], task: '[fake:write microfrontends/web-front-wt-acme-102-billing/notes.md]' });
    expect((await s.store.sessions.get(a.id))?.solutions).toEqual(['web-front-wt-acme-101-checkout']);
    expect((await s.store.sessions.get(b.id))?.solutions).toEqual(['web-front', 'web-front-wt-acme-102-billing']);

    let web = (await rows()).get('web-front');
    expect(web).toMatchObject({ conflict: false, flag: '', conflictSessions: [] });
    expect(web?.branches.map((branch) => [branch.branch, branch.worktree === null ? null : path.basename(branch.worktree), branch.owner])).toEqual([
      ['ACME-101-checkout', 'web-front-wt-acme-101-checkout', 'acme-checkout'],
      ['ACME-102-billing', 'web-front-wt-acme-102-billing', 'acme-billing'],
    ]);

    // Two sessions writing the main checkout itself: a conflict, both named, neither isolated.
    const c = await start(s, { name: 'acme-main-one', solutions: [], task: '[fake:write microfrontends/web-front/one.md]' });
    const d = await start(s, { name: 'acme-main-two', solutions: [], task: '[fake:write microfrontends/web-front/two.md]' });
    web = (await rows()).get('web-front');
    expect(web?.conflict).toBe(true);
    expect(web?.conflictSessions.map((writer) => [writer.sessionId, writer.isolated])).toEqual([
      [a.id, true],
      [b.id, true],
      [c.id, false],
      [d.id, false],
    ]);
    expect(forbiddenGitCalls(await g.gitCalls())).toEqual([]);
  });

  it('closed, moved and continued sessions are not writers (a continued one counts as its successor); their in-place rows go', async () => {
    const { s } = await setup();
    const first = await start(s, { name: 'acme-first', solutions: ['mobile'], task: '[fake:write mobile/acme-first.md]' });
    const second = await start(s, { name: 'acme-second', solutions: ['mobile'], task: '[fake:write mobile/acme-second.md]' });
    expect((await rows()).get('mobile')?.conflict).toBe(true);

    // Closed by the developer: gone from the row; the other one alone is no conflict.
    await s.supervisor.close(second.id, { confirm: true });
    let mobile = (await rows()).get('mobile');
    expect(mobile).toMatchObject({ conflict: false, conflictSessions: [] });
    expect(mobile?.branches.map((branch) => branch.owner)).toEqual(['acme-first']);

    // Taken over to another machine (D65 `movedTo`, even before it is marked closed): not a writer here.
    const third = await start(s, { name: 'acme-third', solutions: ['mobile'], task: '[fake:write mobile/acme-third.md]' });
    expect((await rows()).get('mobile')?.conflict).toBe(true);
    await s.store.sessions.update(third.id, { movedTo: { machineId: 'acme-pc', machineName: 'Acme PC', sessionId: 'remote-1', at: new Date().toISOString() } });
    expect((await rows()).get('mobile')).toMatchObject({ conflict: false });

    // Continued in a fresh session (D83 `continuedTo`): the old one no longer writes.
    const fourth = await start(s, { name: 'acme-fourth', solutions: ['mobile'], task: '[fake:write mobile/acme-fourth.md]' });
    expect((await rows()).get('mobile')?.conflict).toBe(true);
    await s.store.sessions.update(fourth.id, { continuedTo: first.id });
    mobile = (await rows()).get('mobile');
    expect(mobile).toMatchObject({ conflict: false });
    expect(mobile?.branches.map((branch) => branch.owner)).toEqual(['acme-first']);
    expect(mobile?.status).not.toBe('idle');
  });

  it("a continued session's worktree belongs to its successor; a closed session's worktree is idle", async () => {
    const { s } = await setup();
    const old = await start(s, { name: 'acme-old', solutions: ['web-front'], worktrees: true, branch: 'ACME-7-old' });
    const fresh = await start(s, { name: 'acme-fresh', solutions: ['mobile'] });
    await s.store.sessions.update(old.id, { continuedTo: fresh.id, closedAt: new Date().toISOString() });
    let branch = (await rows()).get('web-front')?.branches[0];
    expect(branch).toMatchObject({ branch: 'ACME-7-old', sessionId: fresh.id, owner: 'acme-fresh' });

    // Its successor closed too: the worktree (still on disk) stays listed, idle, and writes nothing.
    await s.supervisor.close(fresh.id, { confirm: true });
    const web = (await rows()).get('web-front');
    branch = web?.branches[0];
    expect(branch).toMatchObject({ branch: 'ACME-7-old', owner: 'acme-fresh', status: 'idle' });
    expect(web?.status).toBe('idle');
  });

  it("a removed worktree's branch row disappears, and the repo name it left in the session does not read as 'in place'", async () => {
    const { s, g } = await setup();
    const isolated = await start(s, { name: 'acme-isolated', solutions: ['web-front'], worktrees: true, branch: 'ACME-8-isolated' });
    const other = await start(s, { name: 'acme-other', solutions: ['web-front'], task: '[fake:write microfrontends/web-front/acme-other.md]' });
    let web = (await rows()).get('web-front');
    expect(web?.conflictSessions.map((writer) => [writer.sessionId, writer.isolated])).toEqual([
      [isolated.id, true],
      [other.id, false],
    ]);
    const [worktree] = await s.store.worktrees.list({ sessionId: isolated.id });
    if (!worktree) throw new Error('no worktree');

    // Removed outside Switchboard (the folder is gone, the record is still live): no branch row for it.
    await g.git(g.web, 'worktree', 'remove', '--force', worktree.path);
    web = (await rows()).get('web-front');
    expect(web?.branches.some((branch) => branch.worktree !== null)).toBe(false);
    // Its session still lists `web-front` (D38), but it never wrote the main checkout: not a writer there.
    expect(web?.branches.map((branch) => branch.owner)).toEqual(['acme-other']);
    expect(web).toMatchObject({ conflict: false });

    // Removed through Switchboard (the record is marked removed): the same.
    await s.store.worktrees.markRemoved(worktree.id);
    web = (await rows()).get('web-front');
    expect(web?.branches.map((branch) => branch.owner)).toEqual(['acme-other']);
    expect(web).toMatchObject({ conflict: false });
  });

  // Developer ruling 2026-10-14: a session writes a main checkout only while it has its own uncommitted edits there.
  it('naming a checkout is not writing it; uncommitted edits are, committed ones are not; two with uncommitted edits conflict', async () => {
    const { s, g } = await setup();
    const named = await start(s, { name: 'acme-named', solutions: ['mobile'] });
    const editor = await start(s, { name: 'acme-editor', solutions: ['mobile'], task: '[fake:write mobile/acme-notes.md]' });
    let mobile = (await rows()).get('mobile');
    expect(mobile).toMatchObject({ conflict: false, conflictSessions: [] });
    expect(mobile?.branches.map((branch) => branch.sessionId)).toEqual([editor.id]);

    // Its edit committed (by the developer or the agent): not a writer any more.
    await g.git(g.mobile, 'add', '--', 'acme-notes.md');
    await g.git(g.mobile, 'commit', '-q', '-m', 'ACME-12 notes');
    mobile = (await rows()).get('mobile');
    expect(mobile?.branches.map((branch) => [branch.sessionId, branch.owner])).toEqual([[null, 'idle']]);

    // A new uncommitted edit makes it a writer again; the named session editing too makes two: a conflict.
    const again = await call('POST', `/api/sessions/${editor.id}/messages`, { text: '[fake:write mobile/acme-more.md]' });
    expect(again.statusCode).toBeLessThan(300);
    const edits = await call('POST', `/api/sessions/${named.id}/messages`, { text: '[fake:write mobile/acme-named.md]' });
    expect(edits.statusCode).toBeLessThan(300);
    await until(async () => (await rows()).get('mobile')?.conflict === true, 'both sessions write mobile/ uncommitted');
    expect((await rows()).get('mobile')?.conflictSessions.map((writer) => [writer.sessionId, writer.isolated])).toEqual([
      [named.id, false],
      [editor.id, false],
    ]);
  });
});
