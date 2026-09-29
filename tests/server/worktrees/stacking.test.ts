import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { BranchingPreflight, Session } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { PARENT_MERGED } from '../../../src/server/inbox/system-items.ts';
import { generateToken } from '../../../src/server/token.ts';
import type { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type GitWorld, forbiddenGitCalls, makeGitWorld } from '../../helpers/git.ts';
import { type OriginRepo, makeOriginRepo } from '../../helpers/origin.ts';
import { type SupervisorWorld, isHandshake, makeSupervisorWorld, readFakeLog, until } from '../../helpers/supervisor.ts';

/**
 * D47 oracle (real path, D13): stacked task branches. `POST /api/branching/preflight`
 * and `POST /api/sessions` with fake-claude as the CLI, the real worktree manager
 * (git through the logging spy), fake-gh for the parent's PR (per repo: the
 * `<repo>:<branch>` keys) and repos cloned from **local bare origins**:
 * `alpha-front` (origin: master, dev, the epic, the parent from the epic),
 * `beta-front` (origin: master, dev, the parent from dev; no epic) and
 * `gamma-front` (origin: master, dev: no parent, no epic). Covered: the preflight's
 * parent, status and PR target columns (a key, a full name, several matches, a
 * merged parent); the worktrees cut from `origin/<parent>` or the D40 fallback;
 * nothing pushed; the stacked hand-off; without an epic; refusals; the parent-merged
 * watcher (squash and merge commit): the row, the Inbox item and the session
 * message, once; a closed session gets only the item.
 */
const PORT = 4874; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const EPIC = 'feature/PROJ-3010-Platform-tracking-and-KPI-delivery-process-development';
const PARENT = 'PROJ-3013-configure-hubspot-opt-in-cookie-banner-across-both-domains';
const TASK = 'PROJ-3014-kpi-events';

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
  readonly worktrees: WorktreeManager;
  readonly alpha: OriginRepo;
  readonly beta: OriginRepo;
  readonly gamma: OriginRepo;
}

async function setup(): Promise<World> {
  sw = await makeSupervisorWorld({ scenario: 'handoff-start' });
  const g = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  const mf = (name: string): string => path.join(g.workspace, 'microfrontends', name);
  const alpha = await makeOriginRepo(g.git, g.root, mf('alpha-front'), [
    ['dev', 'master'],
    [EPIC, 'dev'],
    [PARENT, EPIC],
  ]);
  const beta = await makeOriginRepo(g.git, g.root, mf('beta-front'), [
    ['dev', 'master'],
    [PARENT, 'dev'],
  ]);
  const gamma = await makeOriginRepo(g.git, g.root, mf('gamma-front'), [['dev', 'master']]);
  await g.setPullRequests({
    [`alpha-front:${PARENT}`]: { number: 306, state: 'OPEN', url: 'https://github.test/alpha/pull/306', baseRefName: EPIC, headRefOid: await g.git(alpha.pusher, 'rev-parse', PARENT) },
    [`beta-front:${PARENT}`]: { number: 1080, state: 'OPEN', url: 'https://github.test/beta/pull/1080', baseRefName: EPIC, headRefOid: await g.git(beta.pusher, 'rev-parse', PARENT) },
  });
  const worktrees = g.manager({ sessions: sw.supervisor });
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: sw.root }, platform: 'linux', home: sw.root, cwd: sw.root });
  await seedFolder(sw.store, g.workspace);
  app = await buildApp({ config: { ...base, port: PORT }, token, store: sw.store, webRoot: sw.root, supervisor: sw.supervisor, worktrees, providers: { diff: worktrees } });
  await app.ready();
  const real = async (repo: OriginRepo): Promise<OriginRepo> => ({ ...repo, repo: await realpath(repo.repo) });
  return { s: sw, g, worktrees, alpha: await real(alpha), beta: await real(beta), gamma: await real(gamma) };
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

const epic = { key: 'PROJ-3010', summary: 'Platform tracking and KPI delivery process development' };

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'kpi-events',
    task: 'Add the KPI events.',
    workType: 'feature',
    mode: 'orchestrator',
    solutions: ['alpha-front', 'beta-front', 'gamma-front'],
    phase: 'ui-first',
    coordination: null,
    qa: null,
    worktrees: true,
    ultracode: false,
    branch: TASK,
    branching: { epic, base: 'dev', parent: 'PROJ-3013' },
    ...overrides,
  };
}

async function started(payload: Record<string, unknown>): Promise<Session> {
  const response = await call('POST', '/api/sessions', payload);
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as Session;
}

async function preflight(payload: Record<string, unknown>): Promise<BranchingPreflight> {
  const response = await call('POST', '/api/branching/preflight', payload);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as BranchingPreflight;
}

/** Every stdin user message the fake got (any process), handshakes and control requests left out. */
async function stdinMessages(s: SupervisorWorld): Promise<string[]> {
  return (await readFakeLog(s.logFile))
    .filter((entry) => entry.kind === 'stdin')
    .map((entry) => JSON.parse(entry.line as string) as Record<string, unknown>)
    .filter((line) => !isHandshake(line) && line['type'] === 'user')
    .map((line) => (line as { message: { content: string } }).message.content);
}

async function firstMessage(s: SupervisorWorld): Promise<string> {
  return until(async () => (await stdinMessages(s))[0], 'the first message');
}

describe('POST /api/branching/preflight · D47 parent', () => {
  it('a key: resolved per repo, its PR through gh, the resolved base and PR target', async () => {
    const { g } = await setup();
    const { rows } = await preflight({ solutions: ['alpha-front', 'beta-front', 'gamma-front'], epicBranch: EPIC, base: 'dev', taskBranch: TASK, parent: 'proj-3013' });
    expect(rows.map((row) => [row.solution, row.cutFrom, row.prTarget, row.parent])).toEqual([
      [
        'alpha-front',
        `origin/${PARENT}`,
        PARENT,
        { typed: 'PROJ-3013', branch: PARENT, matches: [PARENT], error: null, pr: { number: 306, state: 'OPEN', url: 'https://github.test/alpha/pull/306', baseRefName: EPIC }, noPr: false, prError: null },
      ],
      [
        'beta-front',
        `origin/${PARENT}`,
        PARENT,
        { typed: 'PROJ-3013', branch: PARENT, matches: [PARENT], error: null, pr: { number: 1080, state: 'OPEN', url: 'https://github.test/beta/pull/1080', baseRefName: EPIC }, noPr: false, prError: null },
      ],
      ['gamma-front', 'origin/dev', EPIC, { typed: 'PROJ-3013', branch: null, matches: [], error: null, pr: null, noPr: false, prError: null }],
    ]);
    // gh was asked about the parent only where it is on origin, in that repo.
    const gh = (await g.ghCalls()).filter((c) => c.argv[0] === 'pr');
    expect(gh.map((c) => [path.basename(c.cwd), c.argv])).toEqual(
      expect.arrayContaining([
        ['alpha-front', ['pr', 'view', PARENT, '--json', 'number,state,url,baseRefName,headRefOid']],
        ['beta-front', ['pr', 'view', PARENT, '--json', 'number,state,url,baseRefName,headRefOid']],
      ]),
    );
    expect(gh.some((c) => path.basename(c.cwd) === 'gamma-front')).toBe(false);
    expect(forbiddenGitCalls(await g.gitCalls())).toEqual([]);
  });

  it('a full name, a merged parent, no PR, several matches, a pruned parent; 422 for a bad name', async () => {
    const { g, alpha, beta } = await setup();
    await g.setPullRequests({ [`alpha-front:${PARENT}`]: { number: 306, state: 'MERGED', url: null, baseRefName: EPIC, headRefOid: null } });
    await beta.push('PROJ-3013-second', 'second.txt', 'two\n', 'dev');
    const { rows } = await preflight({ solutions: ['alpha-front', 'beta-front'], epicBranch: EPIC, base: 'dev', parent: 'PROJ-3013' });
    expect(rows[0]?.parent).toMatchObject({ branch: PARENT, pr: { number: 306, state: 'MERGED' } });
    expect(rows[1]?.parent).toMatchObject({ branch: null, matches: [PARENT, 'PROJ-3013-second'], error: expect.stringContaining('type the parent\'s full branch name') });
    expect(rows[1]?.cutFrom).toBeNull();
    expect(rows[1]?.prTarget).toBeNull();
    // The full name picks one; no PR for it here.
    const full = await preflight({ solutions: ['beta-front'], epicBranch: EPIC, base: 'dev', parent: `origin/${PARENT}` });
    expect(full.rows[0]?.parent).toMatchObject({ typed: PARENT, branch: PARENT, pr: null, noPr: true });
    // Deleted on origin (merged and removed): the prune drops it, so the parent is not in the repo any more.
    await g.git(alpha.pusher, 'push', '-q', 'origin', '--delete', PARENT);
    const pruned = await preflight({ solutions: ['alpha-front'], epicBranch: EPIC, base: 'dev', parent: 'PROJ-3013' });
    expect(pruned.rows[0]).toMatchObject({ cutFrom: `origin/${EPIC}`, prTarget: EPIC, parent: { branch: null, matches: [] } });
    const refused = await call('POST', '/api/branching/preflight', { solutions: ['alpha-front'], parent: 'bad..name' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().errors.map((e: { field: string }) => e.field)).toEqual(['parent']);
  });
});

describe('POST /api/sessions · D47 stacked task worktrees', () => {
  it('cut from origin/<parent> where it is on origin, else origin/dev; nothing pushed; the stacked hand-off', async () => {
    const { s, g, alpha, beta, gamma } = await setup();
    const before = [await alpha.refs(), await beta.refs(), await gamma.refs()];
    const session = await started(body());
    const rows = await s.store.worktrees.list({ sessionId: session.id });
    expect(rows.map((row) => [row.repo, row.branch, row.baseRef, row.parentBranch, row.parentPrNumber, row.parentPrState, row.parentBase])).toEqual([
      ['alpha-front', TASK, `origin/${PARENT}`, PARENT, 306, 'OPEN', EPIC],
      ['beta-front', TASK, `origin/${PARENT}`, PARENT, 1080, 'OPEN', EPIC],
      ['gamma-front', TASK, 'origin/dev', null, null, null, null],
    ]);
    expect(await g.git(rows[0]?.path as string, 'rev-parse', 'HEAD')).toBe(await g.git(alpha.repo, 'rev-parse', `refs/remotes/origin/${PARENT}`));
    expect(rows[0]?.parentHeadOid).toBe(await g.git(alpha.repo, 'rev-parse', `refs/remotes/origin/${PARENT}`));
    expect(await g.git(rows[1]?.path as string, 'rev-parse', 'HEAD')).toBe(await g.git(beta.repo, 'rev-parse', `refs/remotes/origin/${PARENT}`));
    expect(await g.git(rows[2]?.path as string, 'rev-parse', 'HEAD')).toBe(await g.git(gamma.repo, 'rev-parse', 'refs/remotes/origin/dev'));
    await expect(g.git(rows[0]?.path as string, 'rev-parse', '--abbrev-ref', '@{upstream}')).rejects.toThrow();
    // Lazy: nothing on origin, no epic created anywhere.
    expect([await alpha.refs(), await beta.refs(), await gamma.refs()]).toEqual(before);
    await expect(g.git(gamma.repo, 'rev-parse', '--verify', `refs/heads/${EPIC}`)).rejects.toThrow();
    const calls = await g.gitCalls();
    expect(calls.filter((c) => c.argv[0] === 'fetch').every((c) => c.argv.join(' ') === 'fetch origin --prune')).toBe(true);
    expect(forbiddenGitCalls(calls)).toEqual([]);
    expect((await s.store.sessions.get(session.id))?.branching).toEqual({ epic: { ...epic, branch: EPIC }, base: 'dev', bases: {}, dropped: [], parent: 'PROJ-3013' });

    const message = await firstMessage(s);
    expect(message).toContain(
      [
        '- Ultracode: off',
        '- Branching model: epic/task (lazy), stacked',
        `  - Epic: PROJ-3010 — ${EPIC} (base: origin/dev)`,
        `  - Task branch: ${TASK}`,
        `  - Parent: ${PARENT} (stacked; PR #306/#1080 open)`,
        '  - Per-repo base / PR target:',
        `    - alpha-front: origin/${PARENT} → PR into ${PARENT}`,
        `    - beta-front: origin/${PARENT} → PR into ${PARENT}`,
        `    - gamma-front: origin/dev (epic missing; parent not in repo) → PR into ${EPIC} (epic, created lazily)`,
      ].join('\n'),
    );
    expect(message).toContain('  - When the parent merges: Switchboard watches the parent');
    expect(message).toContain(`  - microfrontends/alpha-front: ${rows[0]?.path} (branch ${TASK}, from origin/${PARENT})`);
    expect(message).not.toContain('- Rule: create and push the epic + task branches');
  });

  it('without an epic (a bug fix): the parent where it is, else origin/master, PR into it', async () => {
    const { s, g, gamma } = await setup();
    const session = await started(body({ solutions: ['beta-front', 'gamma-front'], branching: { epic: null, parent: PARENT } }));
    const rows = await s.store.worktrees.list({ sessionId: session.id });
    expect(rows.map((row) => [row.repo, row.baseRef, row.parentBranch])).toEqual([
      ['beta-front', `origin/${PARENT}`, PARENT],
      ['gamma-front', 'origin/master', null],
    ]);
    expect(await g.git(rows[1]?.path as string, 'rev-parse', 'HEAD')).toBe(await g.git(gamma.repo, 'rev-parse', 'refs/remotes/origin/master'));
    const message = await firstMessage(s);
    expect(message).toContain(
      [
        '- Branching model: task only, stacked',
        `  - Task branch: ${TASK}`,
        `  - Parent: ${PARENT} (stacked; PR #1080 open)`,
        '  - Per-repo base / PR target:',
        `    - beta-front: origin/${PARENT} → PR into ${PARENT}`,
        '    - gamma-front: origin/master (parent not in repo) → PR into master',
      ].join('\n'),
    );
    expect(message).not.toContain('- Epic:');
  });

  it('the parent is the epic branch: not stacked (D40 as before); refusals: bad name, own key, several matches', async () => {
    const { s, beta } = await setup();
    const plain = await started(body({ name: 'plain', solutions: ['alpha-front'], branching: { epic, base: 'dev', parent: EPIC } }));
    expect((await s.store.sessions.get(plain.id))?.branching).not.toHaveProperty('parent');
    expect(await firstMessage(s)).toContain('- Branching model: epic/task (lazy)\n');

    const invalid = await call('POST', '/api/sessions', body({ name: 'bad', branching: { epic, parent: 'bad..name' } }));
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().errors).toEqual([{ field: 'branching.parent', message: 'the parent must be a task key (e.g. PROJ-3013) or a valid git branch name' }]);
    const own = await call('POST', '/api/sessions', body({ name: 'own', branching: { epic, parent: 'PROJ-3014' } }));
    expect(own.json().errors).toEqual([{ field: 'branching.parent', message: "the parent cannot be the task's own key (PROJ-3014)" }]);

    await beta.push('PROJ-3013-second', 'second.txt', 'two\n', 'dev');
    const ambiguous = await call('POST', '/api/sessions', body({ name: 'ambiguous', solutions: ['beta-front'] }));
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json()).toEqual({
      error: 'parent-ambiguous',
      message: `beta-front: PROJ-3013 matches 2 branches on origin (${PARENT}, PROJ-3013-second): type the parent's full branch name`,
    });
    expect(await s.store.sessions.getByName('ambiguous')).toBeNull();
  });
});

describe('rule 5 · the parent merges', () => {
  it('squash-merged: the row, one Inbox item and one message to the session (retarget + rebase --onto)', async () => {
    const { s, g, worktrees, alpha } = await setup();
    const session = await started(body({ solutions: ['alpha-front'] }));
    await firstMessage(s);
    const [row] = await s.store.worktrees.list({ sessionId: session.id });
    const oldTip = row?.parentHeadOid as string;
    // Still open: nothing happens.
    await worktrees.checkPullRequests();
    expect(await s.store.systemItems.list()).toEqual([]);

    // Squash-merge the parent into the epic on origin and delete it.
    await g.git(alpha.pusher, 'switch', '-q', EPIC);
    await g.git(alpha.pusher, 'merge', '-q', '--squash', PARENT);
    await g.git(alpha.pusher, 'commit', '-q', '-m', 'PROJ-3013 (#306)');
    await g.git(alpha.pusher, 'push', '-q', 'origin', EPIC);
    await g.git(alpha.pusher, 'push', '-q', 'origin', '--delete', PARENT);
    await g.setPullRequests({ [`alpha-front:${PARENT}`]: { number: 306, state: 'MERGED', url: 'https://github.test/alpha/pull/306', baseRefName: EPIC, headRefOid: oldTip } });
    await worktrees.checkPullRequests();

    const updated = await s.store.worktrees.get(row?.id as string);
    expect(updated).toMatchObject({ parentPrState: 'MERGED', parentMerge: 'squash', parentBase: EPIC, baseRef: `origin/${EPIC}`, parentHeadOid: oldTip });
    expect(updated?.parentMergedAt).not.toBeNull();
    const items = await until(async () => {
      const list = await s.store.systemItems.list();
      return list.length > 0 ? list : undefined;
    }, 'the parent-merged item');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: PARENT_MERGED,
      title: `Parent ${PARENT} merged — retarget and rebase ${TASK}`,
      sessionId: session.id,
      worktreeId: row?.id,
      branches: [{ solution: 'alpha-front', branch: TASK }],
      state: 'open',
    });
    expect(items[0]?.detail).toContain(`git rebase --onto origin/${EPIC} ${oldTip} ${TASK}`);
    const sent = await until(async () => {
      const found = (await stdinMessages(s)).filter((text) => text.includes('Switchboard: the parent branch'));
      return found.length > 0 ? found : undefined;
    }, 'the parent-merged message');
    expect(sent[0]).toContain(`\`gh pr edit ${TASK} --base ${EPIC}\``);
    expect(sent[0]).toContain(`\`git rebase --onto origin/${EPIC} ${oldTip} ${TASK}\``);

    // Once: another poll changes nothing.
    await worktrees.checkPullRequests();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await s.store.systemItems.list()).toHaveLength(1);
    expect((await stdinMessages(s)).filter((text) => text.includes('Switchboard: the parent branch'))).toHaveLength(1);
    // Switchboard never retargets, rebases or pushes.
    expect((await g.ghCalls()).some((c) => c.argv[1] === 'edit')).toBe(false);
    expect(forbiddenGitCalls(await g.gitCalls())).toEqual([]);
  });

  it('a merge commit: a normal rebase; a closed session gets only the item', async () => {
    const { s, g, worktrees, alpha } = await setup();
    const session = await started(body({ solutions: ['alpha-front'] }));
    await firstMessage(s);
    const closed = await call('POST', `/api/sessions/${session.id}/close`, { confirm: true });
    expect(closed.statusCode, closed.body).toBe(200);
    const [row] = await s.store.worktrees.list({ sessionId: session.id });
    await g.git(alpha.pusher, 'switch', '-q', EPIC);
    await g.git(alpha.pusher, 'merge', '-q', '--no-ff', '-m', 'Merge PROJ-3013', PARENT);
    await g.git(alpha.pusher, 'push', '-q', 'origin', EPIC);
    await g.setPullRequests({ [`alpha-front:${PARENT}`]: { number: 306, state: 'MERGED', url: null, baseRefName: EPIC, headRefOid: row?.parentHeadOid } });
    const messagesBefore = (await stdinMessages(s)).length;
    await worktrees.checkPullRequests();
    expect(await s.store.worktrees.get(row?.id as string)).toMatchObject({ parentMerge: 'merge' });
    const items = await until(async () => {
      const list = await s.store.systemItems.list();
      return list.length > 0 ? list : undefined;
    }, 'the parent-merged item');
    expect(items[0]?.detail).toContain('The session is closed, so nothing was sent to it');
    expect(items[0]?.detail).toContain(`git rebase origin/${EPIC} ${TASK}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await stdinMessages(s)).length).toBe(messagesBefore);
    expect(await s.store.pendingMessages.pending(session.id)).toEqual([]);
  });
});
