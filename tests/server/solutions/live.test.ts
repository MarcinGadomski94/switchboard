import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session, Solution, SolutionGroup } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { LiveSolutions } from '../../../src/server/solutions/live.ts';
import { generateToken } from '../../../src/server/token.ts';
import type { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type GitWorld, forbiddenGitCalls, makeGitWorld } from '../../helpers/git.ts';
import { REPO_ROOT } from '../../helpers/net.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * `GET /api/solutions` with its live fields (M6.2, `LiveSolutions`) on the real
 * code path (D13, no demo): real git repos in a temp workspace laid out by the
 * real router rules, sessions started through `POST /api/sessions` with
 * fake-claude as the CLI (one with a worktree, one in place, each really writing
 * a file through `[fake:write]`), the worktree manager's diff, phase ledgers,
 * follow-up files and a codebase-memory dirty list.
 */
const PORT = 4873; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const ROUTER_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md');

let sw: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';
let errors: unknown[] = [];

afterEach(async () => {
  await app?.close();
  await sw?.cleanup();
  app = undefined;
  sw = undefined;
  errors = [];
});

/** The dirty-tracker hook's project id: the absolute path with runs of `:` `/` `\` turned into `-`. */
function hookProjectId(absolute: string): string {
  return absolute.replace(/\\/g, '/').replace(/[:/\\]+/g, '-').replace(/^-+|-+$/g, '');
}

async function setup(): Promise<{ s: SupervisorWorld; g: GitWorld; m: WorktreeManager }> {
  sw = await makeSupervisorWorld({ scenario: 'handoff-start' });
  const g = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  const m = g.manager({ sessions: sw.supervisor });
  const ws = g.workspace;
  await writeFile(path.join(ws, 'AGENTS.md'), await readFile(ROUTER_FIXTURE, 'utf8'));
  await g.makeRepo(path.join(ws, 'nugets', 'idle-nuget'));
  await g.makeRepo(path.join(ws, 'deprecated', 'microfrontends', 'old-front'));
  // Ledgers: a table in web-front, bullets in mobile (committed, so the diffs do not count them).
  await g.commit(
    g.web,
    'phase-ledger.md',
    '| Interface | Phase | Seam |\n|---|---|---|\n| FreeTalkService | UI-first | mock-DI · fixtures/free-talk.json |\n| ProfileConnector | integration | Tier B green 09-24 |\n',
  );
  await g.commit(g.mobile, 'phase-ledger.md', '- `PushPreferencesClient` → integration → Tier A pending on BFF route\n');
  // The hook marks web-front, and mobile through its `<root>-mobile-<subfolder>` form.
  await mkdir(path.join(ws, '.claude'), { recursive: true });
  await writeFile(
    path.join(ws, '.claude', '.codebase-memory-dirty'),
    `${hookProjectId(path.join(ws, 'microfrontends', 'web-front'))}\n${hookProjectId(path.join(ws, 'mobile', 'src'))}\n`,
  );

  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: sw.root }, platform: 'linux', home: sw.root, cwd: sw.root });
  const solutions = new LiveSolutions({ store: sw.store, diff: m, resolveRepo: (solution, folder) => m.resolveRepo(solution, folder), onError: (e) => errors.push(e) });
  await seedFolder(sw.store, ws);
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
  return { s: sw, g, m };
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

async function solutionsByName(): Promise<Map<string, Solution>> {
  const response = await call('GET', '/api/solutions');
  expect(response.statusCode).toBe(200);
  const groups = response.json() as SolutionGroup[];
  return new Map(groups.flatMap((group) => group.solutions.map((s) => [s.name, s] as const)));
}

describe('GET /api/solutions · live fields (M6.2)', () => {
  it('idle workspace: checkout branches owned by "idle", ledgers, freshness, read-only rows locked', async () => {
    const { g } = await setup();
    const response = await call('GET', '/api/solutions');
    const groups = response.json() as SolutionGroup[];
    expect(groups.map((group) => [group.folder, group.note, group.solutions.map((s) => s.relativePath)])).toEqual([
      ['microfrontends/', '', ['microfrontends/web-front']],
      ['mobile/', '', ['mobile']],
      ['nugets/', '', ['nugets/idle-nuget']],
      ['read-only', 'deprecated/ · never edited', ['deprecated/microfrontends/old-front']],
    ]);
    const rows = await solutionsByName();
    expect(rows.get('web-front')).toEqual({
      name: 'web-front',
      path: path.join(g.workspace, 'microfrontends', 'web-front'),
      relativePath: 'microfrontends/web-front',
      type: 'Web',
      status: 'idle',
      rule: 'editable',
      phase: 'mixed',
      changes: '—',
      flag: '',
      conflict: false,
      conflictSessions: [],
      branches: [{ branch: 'main', worktree: null, sessionId: null, owner: 'idle', ownerTitle: null, status: 'idle' }],
      ledger: [
        { interface: 'FreeTalkService', phase: 'UI-first', seam: 'mock-DI · fixtures/free-talk.json' },
        { interface: 'ProfileConnector', phase: 'integration', seam: 'Tier B green 09-24' },
      ],
      artifacts: [],
      codebaseMemory: 'dirty',
    });
    expect(rows.get('mobile')).toMatchObject({ phase: 'integration', codebaseMemory: 'dirty', ledger: [{ interface: 'PushPreferencesClient', phase: 'integration' }] });
    expect(rows.get('idle-nuget')).toMatchObject({ status: 'idle', phase: '—', changes: '—', ledger: null, artifacts: [], codebaseMemory: 'fresh' });
    expect(rows.get('old-front')).toMatchObject({
      rule: 'read-only',
      status: 'idle',
      phase: '—',
      changes: 'locked',
      branches: [{ branch: 'main', worktree: null, sessionId: null, owner: 'idle', ownerTitle: null, status: 'idle' }],
    });
    // A detached HEAD shows the short commit.
    const head = await g.git(path.join(g.workspace, 'nugets', 'idle-nuget'), 'rev-parse', 'HEAD');
    await g.git(path.join(g.workspace, 'nugets', 'idle-nuget'), 'checkout', '-q', '--detach');
    expect((await solutionsByName()).get('idle-nuget')?.branches).toEqual([{ branch: head.slice(0, 7), worktree: null, sessionId: null, owner: 'idle', ownerTitle: null, status: 'idle' }]);
    expect(errors).toEqual([]);
  });

  it('sessions: a worktree branch and an in-place branch with their owners, status, phase, changes and artifacts', async () => {
    const { s, g } = await setup();
    // D22 (ruling 4): the worktree session has a title, which its branch's `ownerTitle` carries.
    const worktreeSession = await call(
      'POST',
      '/api/sessions',
      newSession({
        name: 'wt-session',
        title: 'Free talk contract',
        solutions: ['web-front'],
        worktrees: true,
        branch: 'PROJ-77-free-talk-contract',
        phase: 'integration',
        task: '[fake:write microfrontends/web-front-wt-wt-session/contracts/free-talk.md]',
      }),
    );
    expect(worktreeSession.statusCode).toBe(201);
    const wt = worktreeSession.json() as Session;
    await mkdir(path.join(g.mobile, 'mobile-followups'), { recursive: true });
    await writeFile(path.join(g.mobile, 'mobile-followups', 'from-other-front.md'), '# Follow-ups\n- one\n');
    const inPlaceSession = await call(
      'POST',
      '/api/sessions',
      newSession({ name: 'in-place', solutions: ['mobile'], worktrees: false, phase: 'ui-first', task: '[fake:write mobile/mobile-followups/from-web-front.md]' }),
    );
    expect(inPlaceSession.statusCode).toBe(201);
    const inPlace = inPlaceSession.json() as Session;
    await waitForStatus(s.store, wt.id, ['done']);
    await waitForStatus(s.store, inPlace.id, ['done']);

    const rows = await solutionsByName();
    const web = rows.get('web-front');
    expect(web?.branches).toEqual([
      // The worktree keeps the short name (D32: the branch is the developer's ticket branch); the owner's title is the session's.
      {
        branch: 'PROJ-77-free-talk-contract',
        worktree: path.join(g.workspace, 'microfrontends', 'web-front-wt-wt-session'),
        sessionId: wt.id,
        owner: 'wt-session',
        ownerTitle: 'Free talk contract',
        status: 'done',
      },
    ]);
    expect(web?.status).toBe('done');
    // The ledger's phases win over the session's.
    expect(web?.phase).toBe('mixed');
    // One written line in the worktree (gap #10 diff against the merge-base).
    expect(web?.changes).toBe('+1');
    expect(web?.artifacts).toContainEqual({ type: 'CONTRACT', name: 'contracts/free-talk.md', meta: '', sessionId: wt.id });

    const mobile = rows.get('mobile');
    // An untitled session: its owner title is its name.
    expect(mobile?.branches).toEqual([{ branch: 'main', worktree: null, sessionId: inPlace.id, owner: 'in-place', ownerTitle: 'in-place', status: 'done' }]);
    expect(mobile?.status).toBe('done');
    // In place against HEAD: the session's file (1 line) + the untracked follow-up (2 lines).
    expect(mobile?.changes).toBe('+3');
    const followups = mobile?.artifacts.filter((a) => a.type === 'FOLLOWUP');
    expect(followups).toEqual([
      { type: 'FOLLOWUP', name: 'mobile-followups/from-web-front.md', meta: '', sessionId: inPlace.id },
      { type: 'FOLLOWUP', name: 'mobile-followups/from-other-front.md', meta: '', sessionId: null },
    ]);

    // Without a ledger the open sessions' phase shows.
    await rm(path.join(g.mobile, 'phase-ledger.md'));
    expect((await solutionsByName()).get('mobile')).toMatchObject({ phase: 'UI-first', ledger: null });

    // An ended in-place session leaves the row; the worktree stays until it is removed (gap #3).
    await s.store.sessions.update(inPlace.id, { status: 'done', endedAt: new Date().toISOString() });
    await s.store.sessions.update(wt.id, { status: 'done', endedAt: new Date().toISOString() });
    const after = await solutionsByName();
    expect(after.get('mobile')?.branches).toEqual([{ branch: 'main', worktree: null, sessionId: null, owner: 'idle', ownerTitle: null, status: 'idle' }]);
    expect(after.get('mobile')?.status).toBe('idle');
    expect(after.get('mobile')?.changes).toBe('—');
    expect(after.get('web-front')?.branches.map((b) => [b.branch, b.owner, b.ownerTitle, b.status])).toEqual([['PROJ-77-free-talk-contract', 'wt-session', 'Free talk contract', 'done']]);
    expect(after.get('web-front')?.changes).toBe('+1');

    // Reading the solutions never changes a tree.
    expect(forbiddenGitCalls(await g.gitCalls())).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('an unreadable dirty list reads "unknown" and is reported; the rest still loads', async () => {
    const { g } = await setup();
    await rm(path.join(g.workspace, '.claude', '.codebase-memory-dirty'));
    await mkdir(path.join(g.workspace, '.claude', '.codebase-memory-dirty'));
    const rows = await solutionsByName();
    expect([...rows.values()].map((s) => s.codebaseMemory)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(errors).toHaveLength(1);
    await rm(path.join(g.workspace, '.claude'), { recursive: true });
    expect([...(await solutionsByName()).values()].map((s) => s.codebaseMemory)).toEqual(['fresh', 'fresh', 'fresh', 'fresh']);
  });
});
