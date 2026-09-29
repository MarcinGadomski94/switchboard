import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { BranchingPreflight, NewSession, Session } from '../../../src/core/api.ts';
import { agentWorktreesInstruction } from '../../../src/core/first-turn.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type GitWorld, forbiddenGitCalls, makeGitWorld } from '../../helpers/git.ts';
import { type OriginRepo, makeOriginRepo } from '../../helpers/origin.ts';
import { type SupervisorWorld, isHandshake, makeSupervisorWorld, readFakeLog, until } from '../../helpers/supervisor.ts';

/**
 * D40 oracle (real path, D13): the epic/task branching model of a new session's
 * worktrees. `POST /api/branching/preflight` and `POST /api/sessions` with
 * fake-claude as the CLI, the real worktree manager (git through the logging
 * spy) and repos cloned from **local bare origins** in a temp workspace (never a
 * real remote): `microfrontends/alpha-front` (origin: master, dev, the epic,
 * a task), `microfrontends/beta-front` (origin: master only) and the GitWorld's
 * `mobile` (no origin). Covered: the preflight rows (base missing, the epic on
 * origin with its behind count, the task on origin, the no-epic default
 * branch, no origin); where the worktree is cut from (the epic on origin, else
 * `origin/dev`; no epic: `origin/master` even when the local master is behind);
 * an existing task branch reused (from origin, and the local one); dropped repos;
 * the refusals; nothing pushed; the Branching lines of the first message.
 */
const PORT = 4874; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const EPIC = 'feature/PROJ-3010-Platform-tracking-and-KPI-delivery-process-development';
const TASK = 'PROJ-3011-kpi-dashboard';

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
  /** Origin: master, dev (2 commits past the epic's start), the epic (from dev), the task branch `PROJ-9-on-origin`. */
  readonly alpha: OriginRepo;
  /** Origin: master only. */
  readonly beta: OriginRepo;
}

async function setup(): Promise<World> {
  sw = await makeSupervisorWorld({ scenario: 'handoff-start' });
  const g = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  const alpha = await makeOriginRepo(g.git, g.root, path.join(g.workspace, 'microfrontends', 'alpha-front'), [
    ['dev', 'master'],
    [EPIC, 'dev'],
    ['PROJ-9-on-origin', 'dev'],
  ]);
  // dev moves on after the epic was cut: the epic is 2 commits behind origin/dev.
  await alpha.push('dev', 'dev-2.txt', 'two\n');
  await alpha.push('dev', 'dev-3.txt', 'three\n');
  const beta = await makeOriginRepo(g.git, g.root, path.join(g.workspace, 'microfrontends', 'beta-front'));
  const worktrees = g.manager({ sessions: sw.supervisor });
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: sw.root }, platform: 'linux', home: sw.root, cwd: sw.root });
  await seedFolder(sw.store, g.workspace);
  app = await buildApp({ config: { ...base, port: PORT }, token, store: sw.store, webRoot: sw.root, supervisor: sw.supervisor, worktrees, providers: { diff: worktrees } });
  await app.ready();
  return { s: sw, g, alpha: { ...alpha, repo: await realpath(alpha.repo) }, beta: { ...beta, repo: await realpath(beta.repo) } };
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
    name: 'kpi-dashboard',
    task: 'Build the KPI dashboard.',
    workType: 'feature',
    mode: 'orchestrator',
    solutions: ['alpha-front'],
    phase: 'ui-first',
    coordination: null,
    qa: null,
    worktrees: true,
    ultracode: false,
    branch: TASK,
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
    return (JSON.parse(line.line as string) as { message: { content: string } }).message.content;
  }, 'the first message');
}

describe('POST /api/branching/preflight (D40)', () => {
  it('fetches each repo and reports the base, the epic with its behind count, the task, and what the worktree is cut from', async () => {
    const { g } = await setup();
    const { rows } = await preflight({ solutions: ['alpha-front', 'beta-front', 'mobile'], epicBranch: EPIC, base: 'dev', taskBranch: 'PROJ-9-on-origin' });
    expect(rows).toEqual([
      {
        solution: 'alpha-front',
        repoPath: expect.stringContaining('alpha-front'),
        error: null,
        base: 'dev',
        baseSource: 'epic',
        baseExists: true,
        epic: { branch: EPIC, exists: true, behind: 2 },
        task: { branch: 'PROJ-9-on-origin', exists: true, local: false },
        cutFrom: `origin/${EPIC}`,
      },
      {
        solution: 'beta-front',
        repoPath: expect.stringContaining('beta-front'),
        error: null,
        base: 'dev',
        baseSource: 'epic',
        baseExists: false,
        epic: { branch: EPIC, exists: false, behind: null },
        task: { branch: 'PROJ-9-on-origin', exists: false, local: false },
        cutFrom: null,
      },
      {
        solution: 'mobile',
        repoPath: g.mobile,
        error: "no origin remote: the worktree starts from the repo's current HEAD",
        base: 'dev',
        baseSource: 'epic',
        baseExists: null,
        epic: { branch: EPIC, exists: null, behind: null },
        task: { branch: 'PROJ-9-on-origin', exists: null, local: null },
        cutFrom: null,
      },
    ]);
    // The fetch ran with --prune in each repo with an origin; nothing was pushed or changed.
    const calls = await g.gitCalls();
    expect(calls.filter((c) => c.argv[0] === 'fetch').map((c) => [path.basename(c.cwd), c.argv])).toEqual(
      expect.arrayContaining([
        ['alpha-front', ['fetch', 'origin', '--prune']],
        ['beta-front', ['fetch', 'origin', '--prune']],
      ]),
    );
    expect(forbiddenGitCalls(calls)).toEqual([]);
  });

  it('without an epic checks the origin default branch; an override is checked instead; no solutions is no rows', async () => {
    await setup();
    const { rows } = await preflight({ solutions: ['alpha-front', 'beta-front'], taskBranch: TASK, bases: { 'beta-front': 'release' } });
    expect(rows.map((row) => [row.solution, row.base, row.baseSource, row.baseExists, row.epic, row.task, row.cutFrom])).toEqual([
      ['alpha-front', 'master', 'default', true, null, { branch: TASK, exists: false, local: false }, 'origin/master'],
      ['beta-front', 'release', 'override', false, null, { branch: TASK, exists: false, local: false }, null],
    ]);
    expect(await preflight({ solutions: [] })).toEqual({ rows: [] });
    const refused = await call('POST', '/api/branching/preflight', { solutions: ['alpha-front'], epicBranch: 'feature/bad..name' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().errors.map((e: { field: string }) => e.field)).toEqual(['epicBranch']);
  });
});

describe('POST /api/sessions · D40 task worktrees', () => {
  it('with the epic on origin: fetch, cut from origin/<epic>, no upstream, nothing pushed; the first message carries the epic lines', async () => {
    const { s, g, alpha } = await setup();
    const before = await alpha.refs();
    const session = await started(body({ branching: { epic: { key: 'PROJ-3010', summary: 'Platform tracking and KPI delivery process development' }, base: 'dev' } }));
    const [worktree] = await s.store.worktrees.list({ sessionId: session.id });
    expect(worktree).toMatchObject({ repo: 'alpha-front', branch: TASK, baseRef: `origin/${EPIC}` });
    const wt = worktree?.path as string;
    expect(await g.git(wt, 'rev-parse', 'HEAD')).toBe(await g.git(alpha.repo, 'rev-parse', `refs/remotes/origin/${EPIC}`));
    expect(await g.git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(TASK);
    await expect(g.git(wt, 'rev-parse', '--abbrev-ref', '@{upstream}')).rejects.toThrow();
    // Never the epic branch locally, never a push.
    await expect(g.git(alpha.repo, 'rev-parse', '--verify', `refs/heads/${EPIC}`)).rejects.toThrow();
    expect(await alpha.refs()).toBe(before);
    const calls = await g.gitCalls();
    expect(calls.some((c) => c.argv[0] === 'fetch' && c.argv[1] === 'origin' && c.cwd === alpha.repo)).toBe(true);
    expect(forbiddenGitCalls(calls)).toEqual([]);
    // Stored for later (adoption after a restart).
    expect((await s.store.sessions.get(session.id))?.branching).toEqual({
      epic: { key: 'PROJ-3010', summary: 'Platform tracking and KPI delivery process development', branch: EPIC },
      base: 'dev',
      bases: {},
      dropped: [],
    });
    const message = await firstMessage(s, session.id);
    expect(message).toContain(
      [
        '- Ultracode: off',
        '- Branching model: epic/task (lazy)',
        `- Epic: PROJ-3010 · ${EPIC} (base: origin/dev)`,
        `- Task branch: ${TASK} (base: ${EPIC})`,
        '- Rule: create and push the epic + task branches with `git push -u origin <same name>` only in a repo at its first code change; cut the epic from the current `origin/dev` when it is missing on origin; never create either branch in repos that are not changed',
        '- Worktrees (one per solution; make every change there, not in the main checkout):',
        `  - microfrontends/alpha-front: ${wt} (branch ${TASK}, from origin/${EPIC})`,
      ].join('\n'),
    );
  });

  it('with the epic not on origin: cut from origin/dev; a repo without dev is dropped (no worktree, not in solutions) or refused', async () => {
    const { s, g, alpha, beta } = await setup();
    const epic = { key: 'PROJ-4000', summary: 'New epic', branch: 'feature/PROJ-4000-New-epic' };
    // Not dropped: the missing base refuses the start before anything is created.
    const refused = await call('POST', '/api/sessions', body({ name: 'refused', solutions: ['alpha-front', 'beta-front'], branching: { epic, base: 'dev' } }));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'base-missing', message: 'beta-front: origin/dev does not exist: drop it from the task or use another base' });
    expect(await exists(path.join(g.workspace, 'microfrontends', 'alpha-front-wt-refused'))).toBe(false);

    const betaBefore = await beta.refs();
    const session = await started(body({ solutions: ['alpha-front', 'beta-front'], branching: { epic, base: 'dev', dropped: ['beta-front'] } }));
    expect(session.solutions).toEqual(['alpha-front']);
    const rows = await s.store.worktrees.list({ sessionId: session.id });
    expect(rows.map((row) => [row.repo, row.branch, row.baseRef])).toEqual([['alpha-front', TASK, 'origin/dev']]);
    expect(await g.git(rows[0]?.path as string, 'rev-parse', 'HEAD')).toBe(await g.git(alpha.repo, 'rev-parse', 'refs/remotes/origin/dev'));
    expect(await exists(path.join(g.workspace, 'microfrontends', 'beta-front-wt-kpi-dashboard'))).toBe(false);
    expect(await beta.refs()).toBe(betaBefore);
    const message = await firstMessage(s, session.id);
    expect(message).toContain('- Solutions in scope: microfrontends/alpha-front\n');
    expect(message).toContain('- Dropped repos (no base branch): microfrontends/beta-front\n');
    expect(message).toContain(`(branch ${TASK}, from origin/dev)`);
  });

  it('a per-repo base override: the worktree is cut from origin/<override> and the first message lists it', async () => {
    const { s, g, beta } = await setup();
    const session = await started(body({ solutions: ['beta-front'], branching: { epic: { key: 'PROJ-4000', summary: 'New epic' }, base: 'dev', bases: { 'beta-front': 'master' } } }));
    const [row] = await s.store.worktrees.list({ sessionId: session.id });
    expect(row).toMatchObject({ repo: 'beta-front', baseRef: 'origin/master' });
    expect(await g.git(row?.path as string, 'rev-parse', 'HEAD')).toBe(await g.git(beta.repo, 'rev-parse', 'refs/remotes/origin/master'));
    const message = await firstMessage(s, session.id);
    expect(message).toContain("cut the epic from the current `origin/dev` (or the repo's base override below) when it is missing on origin");
    expect(message).toContain('- Base overrides: microfrontends/beta-front: origin/master\n');
  });

  it('without an epic: cut from origin/master after the fetch, even when the local master is behind; the task-only line', async () => {
    const { s, g, alpha } = await setup();
    // Someone pushes to master: the local master (and origin/master before a fetch) are behind.
    const pushed = await alpha.push('master', 'hotfix.txt', 'fix\n');
    expect(await g.git(alpha.repo, 'rev-parse', 'master')).not.toBe(pushed);
    const session = await started(body({ branching: { epic: null } }));
    const [row] = await s.store.worktrees.list({ sessionId: session.id });
    expect(row).toMatchObject({ baseRef: 'origin/master' });
    expect(await g.git(row?.path as string, 'rev-parse', 'HEAD')).toBe(pushed);
    expect(await g.git(alpha.repo, 'rev-parse', 'master')).not.toBe(pushed); // the local master is untouched
    const message = await firstMessage(s, session.id);
    expect(message).toContain(`- Branching model: task only: ${TASK} (base: origin/master)\n`);
    expect(message).not.toContain('Rule:');
  });

  it('reuses an existing task branch: tracking origin/<task> when it is there, else the local branch (kept on discard)', async () => {
    const { s, g, alpha, beta } = await setup();
    const fromOrigin = await started(body({ name: 'from-origin', branch: 'PROJ-9-on-origin', branching: { epic: { key: 'PROJ-3010', summary: 'x', branch: EPIC } } }));
    const [tracked] = await s.store.worktrees.list({ sessionId: fromOrigin.id });
    expect(await g.git(tracked?.path as string, 'rev-parse', 'HEAD')).toBe(await g.git(alpha.repo, 'rev-parse', 'refs/remotes/origin/PROJ-9-on-origin'));
    expect(await g.git(tracked?.path as string, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/PROJ-9-on-origin');

    // A local branch that is not on origin (and not checked out anywhere) is used as it is.
    const localTip = await g.commit(beta.repo, 'local.txt', 'mine\n');
    await g.git(beta.repo, 'branch', 'PROJ-12-local-only', localTip);
    const local = await started(body({ name: 'local-only', solutions: ['beta-front'], branch: 'PROJ-12-local-only', branching: { epic: null } }));
    const [reused] = await s.store.worktrees.list({ sessionId: local.id });
    expect(await g.git(reused?.path as string, 'rev-parse', 'HEAD')).toBe(localTip);
    expect(reused).toMatchObject({ branch: 'PROJ-12-local-only', baseRef: 'origin/master' });
    // Checked out in another worktree already: refused, nothing created.
    const clash = await call('POST', '/api/sessions', body({ name: 'clash', solutions: ['beta-front'], branch: 'PROJ-12-local-only' }));
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ error: 'branch-checked-out', message: `beta-front: PROJ-12-local-only is checked out at ${reused?.path}` });
    expect(forbiddenGitCalls(await g.gitCalls())).toEqual([]);
  });

  it('a repo without an origin is cut from its HEAD as before; a failed fetch refuses the start', async () => {
    const { s, g } = await setup();
    const session = await started(body({ name: 'no-origin', solutions: ['mobile'], branching: { epic: null } }));
    const [row] = await s.store.worktrees.list({ sessionId: session.id });
    expect(row).toMatchObject({ repo: 'mobile', branch: TASK, baseRef: 'main' });
    const message = await firstMessage(s, session.id);
    expect(message).not.toContain('Branching model');
    expect(message).toContain(`(branch ${TASK})`);

    // An origin that cannot be fetched (a missing local path: no network involved).
    await g.git(g.mobile, 'remote', 'add', 'origin', path.join(g.root, 'no-such-origin.git'));
    const refused = await call('POST', '/api/sessions', body({ name: 'offline', solutions: ['mobile'], branch: 'PROJ-13-offline' }));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'fetch-failed', message: expect.stringContaining('git fetch origin failed in mobile') });
  });

  it('validates `branching`: the epic key, branch and base, drops and overrides in scope', async () => {
    await setup();
    const refused = await call(
      'POST',
      '/api/sessions',
      body({ branching: { epic: { key: 'proj 3010', summary: 'x', branch: 'feature/a..b' }, base: 'de v', dropped: ['nope'], bases: { other: 'dev' } } }),
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.json().errors.map((e: { field: string }) => e.field)).toEqual([
      'branching.epic.key',
      'branching.epic.branch',
      'branching.base',
      'branching.dropped',
      'branching.bases',
    ]);
    const all = await call('POST', '/api/sessions', body({ branching: { dropped: ['alpha-front'] } }));
    expect(all.statusCode).toBe(422);
    expect(all.json().errors).toEqual([{ field: 'branching.dropped', message: 'every solution in scope is dropped: keep one, or start without solutions' }]);
  });

  it('D38 (no solutions picked): no worktree up front, the branching is stored and the instruction names the base', async () => {
    const { s } = await setup();
    const session = await started(body({ solutions: [], branching: { epic: { key: 'PROJ-3010', summary: 'Platform tracking and KPI delivery process development' }, base: 'dev' } }));
    expect(await s.store.worktrees.list({ sessionId: session.id })).toEqual([]);
    const message = await firstMessage(s, session.id);
    expect(message).toContain('- Branching model: epic/task (lazy)');
    expect(message).toContain(`- Worktrees: ${agentWorktreesInstruction(TASK, 'kpi-dashboard', { epic: { key: 'PROJ-3010', branch: EPIC }, base: 'dev' })}`);
    expect(message).toContain(`cut from origin/${EPIC} when it exists on origin, else from origin/dev`);
  });
});
