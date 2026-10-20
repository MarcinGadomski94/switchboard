/**
 * D112 · Import from Jira into a folder: `POST /api/plans/jira/preview` (no session) and
 * `POST /api/plans/jira/import`, which starts a new session "Plan · <epic title>" in the chosen
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
import { PLANS_SETTING, type Plan } from '../../../src/core/plans.ts';
import type { JiraPreview } from '../../../src/core/plans-jira.ts';
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
  await s.store.settings.set(PLANS_SETTING, true);
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
  const partial = { s, g, app, token, fake, announced } as Rig;
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
  it('names the owning session after the epic', () => {
    expect(planOwnerTitle('Acme checkout')).toBe('Plan · Acme checkout');
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

    // A second import of the same epic gets the next free name.
    const again = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.repoFolder.id });
    expect(again.statusCode, again.body).toBe(201);
    expect((again.json() as { session: Session }).session.name).toBe('plan-proj-10-2');
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
      [{ ...IMPORT, folder: r.workspaceFolder.id }, 422, 'repos'],
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
