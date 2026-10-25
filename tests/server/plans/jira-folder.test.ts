/**
 * D112 · Import from Jira into a folder: `POST /api/plans/jira/preview` (no session) and
 * `POST /api/plans/jira/import`, which starts a new session "Plan · <plan title>" (the epic summary
 * when the plan title is empty) in the chosen
 * folder (a git repo, or a workspace with the chosen solution repos) through New session's own
 * path, and makes it the plan's source. Every refusal leaves no session behind; a session made
 * for an import that then fails is closed and deleted again. Real app (`buildApp`), fake claude,
 * temp git repos, the fake Jira (`tests/helpers/fake-jira.ts`), never the real Jira.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Folder, Session } from '../../../src/core/api.ts';
import { type Plan } from '../../../src/core/plans.ts';
import type { JiraPreview } from '../../../src/core/plans-jira.ts';
import type { SidebarLayout } from '../../../src/core/sidebar-layout.ts';
import { peerAnswerKind, mapPeerAnswer } from '../../../src/core/peer-wire.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { FolderService } from '../../../src/server/folders/service.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { planOwnerName, planOwnerTitle } from '../../../src/server/plans/jira/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { type FakeJira, startFakeJira } from '../../helpers/fake-jira.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { type SupervisorWorld, makeSupervisorWorld, until } from '../../helpers/supervisor.ts';

const PORT = 4948; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

interface Rig {
  s: SupervisorWorld;
  g: GitWorld;
  app: FastifyInstance;
  token: string;
  fake: FakeJira;
  repoFolder: Folder;
  workspaceFolder: Folder;
  /** The names of the sessions the hub announced. */
  announced: Set<string>;
  /** D119: how many times the hub published `sidebarLayoutChanged`. */
  layoutChanges: number;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.app.close();
  await rig?.fake.close();
  await rig?.s.cleanup();
  rig = undefined;
});

function call(r: Rig, method: InjectOptions['method'], url: string, payload?: unknown) {
  return r.app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${r.token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function setup(): Promise<Rig> {
  const s = await makeSupervisorWorld({ scenario: 'handoff-start' });
  const g = await makeGitWorld({ root: s.root, workspace: s.workspace, store: s.store, baseEnv: s.env });
  await writeFile(path.join(s.workspace, 'AGENTS.md'), '# Acme workspace\n');
  const repoPath = await g.makeRepo(path.join(s.root, 'acme'));
  const worktrees = g.manager({ sessions: s.supervisor });
  const bus = new HubBus();
  const folders = await FolderService.open({ store: s.store });
  const token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: s.root }, platform: 'linux', home: s.root, cwd: s.root });
  const app = await buildApp({ config: { ...base, port: PORT }, token, store: s.store, webRoot: s.root, supervisor: s.supervisor, worktrees, providers: { diff: worktrees }, bus, folders, agentTools: false });
  await app.ready();
  const fake = await startFakeJira();
  const announced = new Set<string>();
  bus.subscribe((message) => {
    const payload = message.payload as { name?: unknown };
    if (message.name.startsWith('session') && typeof payload?.name === 'string') announced.add(payload.name);
  });
  const partial = { s, g, app, token, fake, announced, layoutChanges: 0 } as Rig;
  bus.subscribe((message) => {
    if (message.name === 'sidebarLayoutChanged') partial.layoutChanges += 1;
  });
  rig = partial;
  const saved = await call(partial, 'PUT', '/api/integrations/jira', { baseUrl: fake.url, email: fake.email, token: fake.token });
  expect(saved.statusCode, saved.body).toBe(200);
  partial.repoFolder = (await call(partial, 'POST', '/api/folders', { path: repoPath })).json() as Folder;
  partial.workspaceFolder = (await call(partial, 'POST', '/api/folders', { path: s.workspace })).json() as Folder;
  expect(partial.repoFolder.kind).toBe('repo');
  expect(partial.workspaceFolder.kind).toBe('workspace');
  return partial;
}

const IMPORT = { epic: 'PROJ-10', targetBranch: 'feature/PROJ-10-acme-checkout', baseBranch: 'main' };

async function sessionCount(r: Rig): Promise<number> {
  return (await r.s.store.sessions.list({})).length;
}

describe('D112 · Import from Jira into a folder', () => {
  it('names the owning session after the plan title, else the epic', () => {
    expect(planOwnerTitle('PROJ-10 Acme checkout', 'Acme checkout')).toBe('Plan · PROJ-10 Acme checkout');
    expect(planOwnerTitle('  ', 'Acme checkout')).toBe('Plan · Acme checkout');
    expect(planOwnerTitle('', '')).toBe('Plan · Jira epic');
    expect(planOwnerTitle('x'.repeat(100))).toHaveLength(80);
    expect(planOwnerName('PROJ-10')).toBe('plan-proj-10');
  });

  it('previews without a session, then creates a session in a repo folder that owns the plan and is asked for the order', async () => {
    const r = await setup();
    const preview = await call(r, 'POST', '/api/plans/jira/preview', { epic: 'PROJ-10' });
    expect(preview.statusCode, preview.body).toBe(200);
    expect((preview.json() as JiraPreview).items).toHaveLength(5);
    expect(await sessionCount(r)).toBe(0);

    const answer = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.repoFolder.id, provider: 'claude' });
    expect(answer.statusCode, answer.body).toBe(201);
    const { plan, session, askedForOrder } = answer.json() as { plan: Plan; session: Session; askedForOrder: boolean };
    expect(session.title).toBe('Plan · Acme checkout');
    expect(session.name).toBe('plan-proj-10');
    expect(session.folder).toBe(r.repoFolder.id);
    expect(session.provider).toBe('claude');
    expect(plan.sourceSessionId).toBe(session.id);
    expect(plan.state).toBe('draft');
    expect(plan.items).toHaveLength(5);
    expect(plan.repos).toEqual(['acme']);
    // The epic has an item without links: the new session's agent gets the ask (it started idle and takes it the normal way).
    expect(askedForOrder).toBe(true);
    await until(async () => ((await r.s.store.events.list(session.id)).some((event) => JSON.stringify(event.payload).includes('Please propose the missing order')) ? true : undefined), 'the ask in the new session', 20_000);
    // The todos are the new session's.
    const todos = (await call(r, 'GET', `/api/sessions/${session.id}/todos`)).json() as { todos: unknown[] };
    expect(todos.todos).toHaveLength(5);

    // A second import of the same epic gets the next free name; its title follows the plan title.
    const again = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, title: 'PROJ-10 Acme checkout v2', folder: r.repoFolder.id });
    expect(again.statusCode, again.body).toBe(201);
    const second = again.json() as { plan: Plan; session: Session };
    expect(second.session.name).toBe('plan-proj-10-2');
    expect(second.plan.title).toBe('PROJ-10 Acme checkout v2');
    expect(second.session.title).toBe('Plan · PROJ-10 Acme checkout v2');
  });

  it('a workspace folder: the chosen repos become the session\'s solutions and the plan\'s repos', async () => {
    const r = await setup();
    const answer = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.workspaceFolder.id, repos: ['mobile'] });
    expect(answer.statusCode, answer.body).toBe(201);
    const { plan, session } = answer.json() as { plan: Plan; session: Session };
    expect(session.folder).toBe(r.workspaceFolder.id);
    expect(session.solutions).toEqual(['mobile']);
    expect(plan.repos).toEqual(['mobile']);
    expect(plan.sourceSessionId).toBe(session.id);
  });

  it('leaves no session behind when the place, the body or Jira refuses', async () => {
    const r = await setup();
    const refusals: Array<[unknown, number, string]> = [
      [{ ...IMPORT, folder: r.workspaceFolder.id, repos: ['nope'] }, 422, 'repos'],
      [{ ...IMPORT, folder: 'no-such-folder' }, 422, 'folder'],
      [{ epic: 'PROJ-10', folder: r.repoFolder.id }, 422, 'targetBranch'],
      [{ ...IMPORT, epic: 'PROJ-404', folder: r.repoFolder.id }, 404, ''],
      [{ ...IMPORT, folder: r.repoFolder.id, provider: 'nope' }, 422, 'provider'],
    ];
    for (const [body, status, field] of refusals) {
      const answer = await call(r, 'POST', '/api/plans/jira/import', body);
      expect([JSON.stringify(body), answer.statusCode]).toEqual([JSON.stringify(body), status]);
      if (field) expect(answer.json().errors?.[0]?.field).toBe(field);
    }
    r.fake.failNext(/^GET \/rest\/api\/3\/search/, 500);
    expect((await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.repoFolder.id })).statusCode).toBe(502);
    expect(await sessionCount(r)).toBe(0);
    expect(r.announced.size).toBe(0);
    expect((await call(r, 'GET', '/api/plans')).json()).toEqual([]);
  });

  it('closes and deletes the session it started when the plan then cannot be made', async () => {
    const r = await setup();
    // A target branch the core refuses (not a valid branch name) is found only once the session exists.
    const answer = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, targetBranch: 'feature/..bad', folder: r.repoFolder.id });
    expect(answer.statusCode, answer.body).toBe(422);
    expect(answer.json().errors?.[0]?.field).toBe('targetBranch');
    // The session was started (and announced) before the core refused the plan; it is gone again.
    expect(r.announced.has('plan-proj-10')).toBe(true);
    expect(await sessionCount(r)).toBe(0);
    expect((await call(r, 'GET', '/api/plans')).json()).toEqual([]);
  });

  it('a paired machine forwards the import and namespaces the plan and the session', () => {
    expect(peerAnswerKind('POST', '/api/plans/jira/import')).toBe('plan-import');
    expect(peerAnswerKind('POST', '/api/plans/jira/preview')).toBe('none');
    const machine = { id: 'm2', name: 'Acme laptop', state: 'online' as const };
    const mapped = mapPeerAnswer(machine as never, 'plan-import', { plan: { id: 'p1', sourceSessionId: 's1', items: [], edges: [] }, session: { id: 's1', name: 'plan-proj-10' }, askedForOrder: false }) as { plan: Plan; session: Session };
    expect(mapped.plan.id).toBe('r~m2~p1');
    expect(mapped.session.id).toBe('r~m2~s1');
  });
});

describe('D119 · the imported plan gets its own sidebar subfolder', () => {
  async function sidebarFolder(r: Rig, name: string, parentId: string | null = null): Promise<string> {
    const answer = await call(r, 'POST', '/api/sidebar/folders', { name, parentId });
    expect(answer.statusCode, answer.body).toBe(201);
    return ((answer.json() as SidebarLayout).folders.find((f) => f.name === name && (f.parentId ?? null) === parentId) as { id: string }).id;
  }
  async function layout(r: Rig): Promise<SidebarLayout> {
    return (await call(r, 'GET', '/api/sidebar')).json() as SidebarLayout;
  }
  type Answer = { plan: Plan; session: Session; sidebarFolder: { id: string; name: string; parentId: string | null } | null };

  it('makes "Plan · <title>" in the chosen folder with the session first, publishes the layout, and a run of the plan lands after the session', async () => {
    const r = await setup();
    const releases = await sidebarFolder(r, 'Releases', await sidebarFolder(r, 'Acme'));
    const before = r.layoutChanges;
    const answer = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, title: 'PROJ-10 Acme checkout', folder: r.repoFolder.id, sidebarFolderId: releases });
    expect(answer.statusCode, answer.body).toBe(201);
    const { plan, session, sidebarFolder: made } = answer.json() as Answer;
    expect(made).toMatchObject({ name: 'Plan · PROJ-10 Acme checkout', parentId: releases });
    const folder = (await layout(r)).folders.find((f) => f.id === made?.id);
    expect(folder).toMatchObject({ name: 'Plan · PROJ-10 Acme checkout', parentId: releases, sessionIds: [session.id] });
    expect(r.layoutChanges).toBeGreaterThan(before);

    // A run of the plan follows its source (the owner session) into the subfolder, right after it (`placeRun`).
    const started = await call(r, 'POST', `/api/plans/${plan.id}/start`, { mergeMode: 'agents' });
    expect(started.statusCode, started.body).toBe(200);
    const run = await until(async () => (await call(r, 'GET', `/api/plans/${plan.id}`)).json<Plan>().items.find((item) => item.runSessionId)?.runSessionId ?? undefined, 'a running item', 20_000);
    await until(async () => (JSON.stringify((await layout(r)).folders.find((f) => f.id === made?.id)?.sessionIds) === JSON.stringify([session.id, run]) ? true : undefined), 'the run after the session', 20_000);
  }, 60_000);

  it('root (null) makes a top-level subfolder; a name taken at that level gets " (2)"; absent places nothing (as before)', async () => {
    const r = await setup();
    await sidebarFolder(r, 'Plan · Acme checkout');
    const first = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.repoFolder.id, sidebarFolderId: null });
    expect(first.statusCode, first.body).toBe(201);
    const made = (first.json() as Answer).sidebarFolder;
    expect(made).toMatchObject({ name: 'Plan · Acme checkout (2)', parentId: null });
    const third = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.repoFolder.id, sidebarFolderId: null });
    expect((third.json() as Answer).sidebarFolder?.name).toBe('Plan · Acme checkout (3)');
    const before = (await layout(r)).folders.length;
    const unplaced = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.repoFolder.id });
    expect(unplaced.statusCode, unplaced.body).toBe(201);
    expect((unplaced.json() as Answer).sidebarFolder).toBeNull();
    const after = await layout(r);
    expect(after.folders.length).toBe(before);
    expect(after.folders.some((f) => f.sessionIds.includes((unplaced.json() as Answer).session.id))).toBe(false);
  }, 60_000);

  it('refuses an unknown or too-deep sidebar folder before anything is made, and a failed import leaves no folder', async () => {
    const r = await setup();
    let parent: string | null = null;
    for (const name of ['L1', 'L2', 'L3', 'L4', 'L5']) parent = await sidebarFolder(r, name, parent);
    const folders = (await layout(r)).folders.length;
    const unknown = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.repoFolder.id, sidebarFolderId: 'no-such-folder' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().errors?.[0]?.field).toBe('sidebarFolderId');
    const deep = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.repoFolder.id, sidebarFolderId: parent });
    expect(deep.statusCode).toBe(422);
    expect(deep.json().errors?.[0]?.field).toBe('sidebarFolderId');
    const bad = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.repoFolder.id, sidebarFolderId: 7 });
    expect(bad.statusCode).toBe(422);
    expect(await sessionCount(r)).toBe(0);
    // D112's rollback (the core refuses the target once the session exists): the session goes, and no folder was made.
    const before = r.layoutChanges;
    const refused = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, targetBranch: 'feature/..bad', folder: r.repoFolder.id, sidebarFolderId: null });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(await sessionCount(r)).toBe(0);
    expect((await layout(r)).folders.length).toBe(folders);
    expect(r.layoutChanges).toBe(before);
  }, 60_000);
});
