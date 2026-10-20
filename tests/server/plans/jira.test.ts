/**
 * D99 · Plans · Jira (`docs/plans.md` → *Jira import and status sync*): the import and the
 * status sync against the fake Jira (`tests/helpers/fake-jira.ts`, a loopback HTTP server: never
 * the real Jira, never the developer's ATL_* values). The plan core is real (store, TodoService,
 * PlanService) with a fake git / gh and a fake run environment, as in `scheduler.test.ts`; the
 * routes are the lane's own, on a bare Fastify app.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { SessionStatus } from '../../../src/core/model.ts';
import { PLANS_SETTING, type PlanChecks } from '../../../src/core/plans.ts';
import type { JiraPreview, PlanJiraState } from '../../../src/core/plans-jira.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { openDatabase } from '../../../src/server/db/database.ts';
import { migrate } from '../../../src/server/db/migrate.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import type { PlanGitPort, PlanRepoInput, PlanRepoState } from '../../../src/server/plans/git.ts';
import { JiraCredentialSource, type JiraSecretStore } from '../../../src/server/plans/jira/credentials.ts';
import { PLANS_MIGRATIONS } from '../../../src/server/plans/db.ts';
import { registerPlanJiraRoutes } from '../../../src/server/plans/jira/routes.ts';
import { PlanJiraService } from '../../../src/server/plans/jira/service.ts';
import { PlanJiraStore } from '../../../src/server/plans/jira/store.ts';
import type { BranchMergeInput, BranchMergePlan } from '../../../src/server/worktrees/branch-merge.ts';
import { type PlanEnvironment, PlanError, type PlanMergePort, PlanService } from '../../../src/server/plans/service.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { FakeClock } from '../../helpers/clock.ts';
import { type FakeIssue, type FakeJira, commentText, startFakeJira } from '../../helpers/fake-jira.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

interface BranchState {
  hasWork?: boolean;
  merged?: boolean;
  pr?: { state: string; checks: PlanChecks; url?: string } | null;
}

class FakeGit implements PlanGitPort {
  readonly branches = new Map<string, BranchState>();
  async prepareTarget(_repoPath: string, target: string): Promise<{ ok: true; ref: string; created: boolean }> {
    return { ok: true, ref: target, created: false };
  }
  async targetFacts(): Promise<{ defaultBranches: string[]; protectedBranches: string[] }> {
    return { defaultBranches: ['main'], protectedBranches: [] };
  }
  async tip(): Promise<string> {
    return 'cafe000';
  }
  async inspect(input: PlanRepoInput): Promise<PlanRepoState> {
    const state = this.branches.get(input.branch) ?? {};
    const pr = state.pr ? { url: state.pr.url ?? `https://git.acme.example/acme/acme-front/pull/${input.branch.length}`, state: state.pr.state, baseRefName: input.target, checks: state.pr.checks, mergeable: null } : null;
    return { repo: input.repo, hasWork: state.hasWork ?? state.merged ?? false, merged: state.merged ?? false, pr, ghAvailable: true, conflict: false };
  }
}

/** D102's Merge step as the tests say: a merge marks the branch merged (the developer's Merge). */
class FakeMerger implements PlanMergePort {
  readonly merged: string[] = [];
  readonly git: FakeGit;
  constructor(git: FakeGit) {
    this.git = git;
  }
  async check(input: BranchMergeInput): Promise<BranchMergePlan> {
    return { input, head: 'beef', targetTip: 'cafe', targetLocal: true, checkedOutAt: null, kind: 'fast-forward', tree: null };
  }
  async merge(plan: BranchMergePlan): Promise<string> {
    this.merged.push(`${plan.input.branch} → ${plan.input.target}`);
    this.git.branches.set(plan.input.branch, { ...(this.git.branches.get(plan.input.branch) ?? {}), hasWork: true, merged: true });
    return `${plan.input.repo}: merged`;
  }
  async openPullRequest(input: BranchMergeInput): Promise<string> {
    return `https://git.acme.example/acme/acme-front/pull/${input.branch.length}`;
  }
}

/** An in-memory keychain (the Team access lane's `MemorySecretStore` shape). */
class MemoryKeychain implements JiraSecretStore {
  readonly name = 'memory';
  readonly values = new Map<string, string>();
  async available() {
    return { ok: true, problem: null };
  }
  async set(ref: { service: string; account: string }, value: string) {
    this.values.set(`${ref.service}/${ref.account}`, value);
  }
  async get(ref: { service: string; account: string }) {
    return this.values.get(`${ref.service}/${ref.account}`) ?? null;
  }
  async delete(ref: { service: string; account: string }) {
    this.values.delete(`${ref.service}/${ref.account}`);
  }
}

interface Rig {
  dir: string;
  store: Store;
  bus: HubBus;
  clock: FakeClock;
  git: FakeGit;
  plans: PlanService;
  todos: TodoService;
  jira: PlanJiraService;
  app: FastifyInstance;
  fake: FakeJira;
  keychain: MemoryKeychain;
  sourceId: string;
  errors: unknown[];
  sent: Array<{ sessionId: string; text: string }>;
  stops: string[];
  enabled: boolean;
  close(): Promise<void>;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

async function setup(options: { env?: 'fake' | 'none'; issues?: FakeIssue[] } = {}): Promise<Rig> {
  const dir = await makeTempDir('plans-jira');
  const clock = new FakeClock(new Date('2026-10-13T10:00:00Z'));
  const store = await openTempStore(dir, { now: () => clock.now() });
  const bus = new HubBus();
  const todos = new TodoService({ store, bus, now: () => clock.now().getTime() });
  const source = await store.sessions.create({ name: 'source', claudeSessionId: 'c-source', status: 'idle', cwd: '/ws', root: '/ws', rootKind: 'workspace', solutions: ['acme-front'], worktrees: false, workType: 'feature', mode: 'single', phase: 'ui-first' });
  const git = new FakeGit();
  let runs = 0;
  const stops: string[] = [];
  const env: PlanEnvironment = {
    async repos(sourceSessionId, names) {
      if (!(await store.sessions.get(sourceSessionId))) throw new PlanError(404, 'not-found', 'no session');
      return { kind: 'workspace', repos: (names ?? ['acme-front']).map((name) => ({ name, repoPath: `/repos/${name}` })) };
    },
    async run(input) {
      runs += 1;
      const session = await store.sessions.create({ name: `run-${runs}`, claudeSessionId: `c-${runs}`, status: 'run', cwd: '/ws', root: '/ws', rootKind: 'workspace', solutions: Object.keys(input.from ?? {}), worktrees: true });
      for (const [repo] of Object.entries(input.from ?? {})) await store.worktrees.create({ repo, repoPath: `/repos/${repo}`, branch: input.branch, path: `/wt/${input.branch}/${repo}`, sessionId: session.id });
      return { ok: true, sessionId: session.id, branch: input.branch };
    },
    async usageHeld() {
      return null;
    },
    // D117 follow-up: the session's Stop, as the real environment's supervisor interrupt (the turn ends, the session stays).
    async stopTurn(sessionId) {
      stops.push(sessionId);
      await store.sessions.update(sessionId, { status: 'idle' });
      return 'stopped';
    },
    async send() {},
    async notice() {},
    async mergeNotice() {},
    async closeMergeNotice() {},
  };
  const errors: unknown[] = [];
  await store.settings.set(PLANS_SETTING, true);
  const plans = new PlanService({ dataDir: dir, store, bus, todos, git, merger: new FakeMerger(git), env, clock, onError: (error) => errors.push(error) });
  await plans.start();
  const fake = await startFakeJira(options.issues);
  const keychain = new MemoryKeychain();
  const credentials = new JiraCredentialSource({ env: options.env === 'none' ? {} : { ATL_BASE_URL: fake.url, ATL_USER: fake.email, ATL_TOKEN: fake.token }, store: keychain });
  const db = await openDatabase(`${dir}/plans.db`);
  const state = { enabled: true };
  const jiraStore = new PlanJiraStore(db, () => clock.now());
  const on = () => state.enabled && plans.state().available;
  const sent: Array<{ sessionId: string; text: string }> = [];
  const jira = new PlanJiraService({ store, plans, todos, bus, db: async () => jiraStore, credentials, enabled: on, clock, send: async (sessionId, text) => void sent.push({ sessionId, text }), onError: (error) => errors.push(error) });
  jira.start();
  const app = Fastify();
  await registerPlanJiraRoutes(app, jira, credentials, on);
  await app.ready();
  const made: Rig = {
    dir,
    store,
    bus,
    clock,
    git,
    plans,
    todos,
    jira,
    app,
    fake,
    keychain,
    sourceId: source.id,
    errors,
    sent,
    stops,
    get enabled() {
      return state.enabled;
    },
    set enabled(value: boolean) {
      state.enabled = value;
    },
    async close() {
      await app.close();
      await jira.close();
      await plans.close();
      db.close();
      await store.close();
      await fake.close();
      await removeTempDir(dir);
    },
  };
  rig = made;
  return made;
}

async function settle(r: Rig): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await r.plans.idle();
    await r.jira.idle();
  }
}

async function call(r: Rig, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; body: any; text: string }> {
  const answer = await r.app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  return { status: answer.statusCode, body: answer.body ? JSON.parse(answer.body) : null, text: answer.body };
}

async function importEpic(r: Rig, sync: 'off' | 'read-only' | 'write' = 'write', extra: Record<string, unknown> = {}): Promise<{ planId: string; ids: Record<string, string> }> {
  const answer = await call(r, 'POST', `/api/sessions/${r.sourceId}/plans/jira/import`, { epic: 'https://acme.atlassian.net/browse/PROJ-10', targetBranch: 'feature/PROJ-10-acme-checkout', sync, ...extra });
  expect(answer.status, answer.text).toBe(201);
  const ids: Record<string, string> = {};
  for (const item of answer.body.plan.items) ids[item.key] = item.id;
  return { planId: answer.body.plan.id, ids };
}

async function status(r: Rig, sessionId: string, next: SessionStatus): Promise<void> {
  await r.store.sessions.update(sessionId, { status: next });
  r.bus.publish('sessionUpdated', { ...(await r.store.sessions.get(sessionId)), id: sessionId, status: next } as unknown as Session);
  await settle(r);
}

async function item(r: Rig, planId: string, key: string) {
  const found = (await r.plans.get(planId)).items.find((entry) => entry.key === key);
  if (!found) throw new Error(`no item ${key}`);
  return found;
}

function commentsOf(r: Rig, key: string): string[] {
  return (r.fake.issues.get(key)?.comments ?? []).map(commentText);
}

describe('D99-Jira · import preview', () => {
  it('maps the children, their blocks links to dependencies, notes the outside link, reports the cycle', async () => {
    const r = await setup();
    const answer = await call(r, 'POST', `/api/sessions/${r.sourceId}/plans/jira/preview`, { epic: 'proj-10' });
    expect(answer.status, answer.text).toBe(200);
    const preview = answer.body as JiraPreview;
    // D118: the preview also carries the epic's description and counts.
    expect(preview.epic).toMatchObject({ key: 'PROJ-10', summary: 'Acme checkout', url: `${r.fake.url}/browse/PROJ-10` });
    expect(preview.items.map((entry) => entry.key)).toEqual(['PROJ-11', 'PROJ-12', 'PROJ-13', 'PROJ-14', 'PROJ-15']);
    expect(preview.edges.map((edge) => edge.text)).toEqual(['PROJ-12 waits on PROJ-11', 'PROJ-13 waits on PROJ-12', 'PROJ-13 waits on PROJ-14']);
    expect(preview.cycles).toHaveLength(1);
    expect(preview.cycles[0]).toMatchObject({ from: 'PROJ-13', to: 'PROJ-14', cycle: ['PROJ-13', 'PROJ-14', 'PROJ-13'] });
    expect(preview.cycles[0]?.text).toBe('PROJ-14 waits on PROJ-13 was left out: PROJ-13 → PROJ-14 → PROJ-13 would be a cycle (each waits on the next)');
    expect(preview.externalLinks).toEqual([{ key: 'PROJ-15', other: 'PROJ-99', relation: 'waits-on', text: 'PROJ-15 waits on PROJ-99 (outside the epic)' }]);
    expect(preview.unlinked).toEqual(['PROJ-15']);
    // Fields: the custom acceptance field, a description section, components, assignee, estimate.
    const [cart, page] = preview.items;
    expect(cart).toMatchObject({ summary: 'Cart API', acceptanceCriteria: 'Cart answers 200 with items.', acceptanceSource: 'field', components: ['acme-api'], assignee: 'Ada Acme', estimateMinutes: 60, status: 'To Do' });
    expect(page).toMatchObject({ acceptanceCriteria: '- Lists the items\n- Shows the total', acceptanceSource: 'description', description: 'Show the cart.\n\nNotes\n\nAsk Acme design.' });
    expect(preview.suggestedTargetBranch).toBe('feature/PROJ-10-acme-checkout');
    expect(preview.proposeAvailable).toBe(false);
    // Nothing was created.
    expect(await r.plans.list()).toEqual([]);
    expect(r.fake.calls(/^POST /)).toEqual([]);
  });

  it('refuses a missing epic key, an unknown epic, an unconfigured Jira and a switched-off Plans', async () => {
    const r = await setup();
    expect((await call(r, 'POST', `/api/sessions/${r.sourceId}/plans/jira/preview`, { epic: 'nothing here' })).body).toMatchObject({ error: 'invalid', errors: [{ field: 'epic' }] });
    expect((await call(r, 'POST', `/api/sessions/${r.sourceId}/plans/jira/preview`, { epic: 'PROJ-404' })).status).toBe(404);
    expect((await call(r, 'POST', '/api/sessions/nope/plans/jira/preview', { epic: 'PROJ-10' })).status).toBe(404);
    r.enabled = false;
    for (const [method, url] of [['POST', `/api/sessions/${r.sourceId}/plans/jira/preview`], ['POST', `/api/sessions/${r.sourceId}/plans/jira/import`], ['GET', '/api/plans/x/jira'], ['PUT', '/api/plans/x/jira'], ['POST', '/api/plans/x/jira/refresh'], ['GET', '/api/integrations/jira'], ['PUT', '/api/integrations/jira']] as const) {
      const answer = await call(r, method, url, method === 'GET' ? undefined : {});
      expect([url, answer.status, answer.body?.error]).toEqual([url, 404, 'plans-off']);
    }
  });

  it('follows the core switch: Settings → Experimental → Plans off answers plans-off', async () => {
    const r = await setup();
    await r.store.settings.set(PLANS_SETTING, false);
    await r.plans.switchChanged();
    expect((await call(r, 'GET', '/api/integrations/jira')).body.error).toBe('plans-off');
    expect((await call(r, 'POST', `/api/sessions/${r.sourceId}/plans/jira/preview`, { epic: 'PROJ-10' })).body.error).toBe('plans-off');
    expect(r.fake.requests).toEqual([]);
  });

  it('answers 409 jira-not-configured without credentials', async () => {
    const r = await setup({ env: 'none' });
    const answer = await call(r, 'POST', `/api/sessions/${r.sourceId}/plans/jira/preview`, { epic: 'PROJ-10' });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toBe('jira-not-configured');
    expect(r.fake.requests).toEqual([]);
  });
});

describe('D99-Jira · create plan', () => {
  it('creates a draft through the core seam: items, dependencies, external, todos with acceptance criteria', async () => {
    const r = await setup();
    const { planId, ids } = await importEpic(r, 'off');
    const plan = await r.plans.get(planId);
    expect(plan.state).toBe('draft');
    expect(plan.mergeMode).toBeNull();
    expect(plan.external).toEqual({ system: 'jira', key: 'PROJ-10' });
    expect(plan.title).toBe('PROJ-10 Acme checkout');
    expect(plan.items.map((entry) => [entry.key, entry.title, entry.solutions])).toEqual([
      ['PROJ-11', 'PROJ-11 Cart API', []],
      ['PROJ-12', 'PROJ-12 Cart page', []],
      ['PROJ-13', 'PROJ-13 Payment form', []],
      ['PROJ-14', 'PROJ-14 Payment provider', []],
      ['PROJ-15', 'PROJ-15 Receipt email', []],
    ]);
    // The cycle's link is not imported; the outside link is not a dependency.
    expect(plan.edges).toEqual([
      { from: ids['PROJ-11'], to: ids['PROJ-12'] },
      { from: ids['PROJ-12'], to: ids['PROJ-13'] },
      { from: ids['PROJ-14'], to: ids['PROJ-13'] },
    ]);
    const todo = await r.store.todos.get((await item(r, planId, 'PROJ-12')).todoId);
    expect(todo?.description).toContain('Show the cart.');
    expect(todo?.description).toContain('Acceptance criteria:\n- Lists the items\n- Shows the total');
    expect(todo?.description).toContain(`Jira: ${r.fake.url}/browse/PROJ-12`);
    expect((await r.store.todos.get((await item(r, planId, 'PROJ-11')).todoId))?.estimateMinutes).toBe(60);
    const jira = (await call(r, 'GET', `/api/plans/${planId}/jira`)).body as PlanJiraState;
    expect(jira).toMatchObject({ epicKey: 'PROJ-10', sync: 'off', transitions: { inProgress: 'In Progress', inReview: 'In Review' } });
    expect(jira.activity[0]?.text).toBe('Imported 5 items and 3 dependencies from PROJ-10 · 1 link(s) left out (cycle) · 1 link(s) outside the epic · sync off');
    // The merge mode is still chosen at Start: the core requires it.
    await expect(r.plans.startPlan(planId, {})).rejects.toMatchObject({ code: 'merge-mode-required' });
  });

  it('refuses a missing target branch (the core checks it) and creates nothing', async () => {
    const r = await setup();
    const answer = await call(r, 'POST', `/api/sessions/${r.sourceId}/plans/jira/import`, { epic: 'PROJ-10' });
    expect(answer.status).toBe(422);
    expect(answer.body.errors[0].field).toBe('targetBranch');
    expect(await r.plans.list()).toEqual([]);
  });

  it('forgets the Jira rows when the plan is deleted; a plan not from Jira answers not-jira', async () => {
    const r = await setup();
    const { planId } = await importEpic(r, 'off');
    await r.plans.remove(planId);
    await settle(r);
    const other = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Hand-made', targetBranch: 'feature/PROJ-1-x' });
    expect((await call(r, 'GET', `/api/plans/${other.id}/jira`)).body.error).toBe('not-jira');
    expect((await call(r, 'GET', `/api/plans/${planId}/jira`)).status).toBe(404);
  });
});

describe('D99-Jira · read-only refresh', () => {
  it('reads title, status and description on demand and every 30 min while running; notes the drift', async () => {
    const r = await setup();
    const { planId } = await importEpic(r, 'read-only');
    // Off → refresh refused.
    r.fake.issues.get('PROJ-15')!.summary = 'Receipt email v2';
    r.fake.issues.get('PROJ-13')!.status = 'Blocked';
    const now = (await call(r, 'POST', `/api/plans/${planId}/jira/refresh`)).body as PlanJiraState;
    const p13 = now.items.find((entry) => entry.key === 'PROJ-13');
    expect(p13).toMatchObject({ status: 'Blocked', statusAtImport: 'To Do', drift: 'Jira status changed: To Do → Blocked' });
    // A pending item's todo follows the new title; nothing was written to Jira.
    expect((await item(r, planId, 'PROJ-15')).title).toBe('PROJ-15 Receipt email v2');
    expect(r.fake.calls(/^POST /)).toEqual([]);
    expect(now.activity[0]?.text).toBe('Refreshed 5 ticket(s), 1 pending item(s) updated');

    // Running: the 30-minute timer reads again. Jira says Done for PROJ-11 while the item runs.
    await r.plans.startPlan(planId, { mergeMode: 'developer' });
    await settle(r);
    expect((await item(r, planId, 'PROJ-11')).state).toBe('running');
    r.fake.issues.get('PROJ-11')!.status = 'Done';
    const before = r.fake.calls(/^GET \/rest\/api\/3\/issue\/PROJ-11\?/).length;
    await r.clock.advanceTo(new Date(r.clock.now().getTime() + 30 * 60_000), () => settle(r));
    await r.jira.idle();
    await settle(r);
    expect(r.fake.calls(/^GET \/rest\/api\/3\/issue\/PROJ-11\?/).length).toBe(before + 1);
    const later = (await call(r, 'GET', `/api/plans/${planId}/jira`)).body as PlanJiraState;
    expect(later.items.find((entry) => entry.key === 'PROJ-11')?.drift).toBe('Jira says Done; the plan item is running');
    expect(later.activity[0]?.text).toBe('Refreshed 5 ticket(s) (every 30 min)');
    // Read-only never writes.
    expect(r.fake.calls(/^POST /)).toEqual([]);
  });

  it('answers sync-off for a plan whose sync is off and changes the setting on the plan', async () => {
    const r = await setup();
    const { planId } = await importEpic(r, 'off');
    expect((await call(r, 'POST', `/api/plans/${planId}/jira/refresh`)).body.error).toBe('sync-off');
    const changed = await call(r, 'PUT', `/api/plans/${planId}/jira`, { sync: 'read-only', transitions: { inReview: 'Code Review' } });
    expect(changed.body).toMatchObject({ sync: 'read-only', transitions: { inProgress: 'In Progress', inReview: 'Code Review' } });
    expect(changed.body.activity[0].text).toBe('Jira sync off → read-only, transitions "In Progress" / "Code Review" / "Done"');
    expect((await call(r, 'PUT', `/api/plans/${planId}/jira`, { sync: 'sometimes' })).body.errors[0].field).toBe('sync');
  });
});

describe('D99-Jira · write mode', () => {
  it('transitions and comments on run start, PR, question and merge; no Done with "Move to Done" off (D116); no duplicates on retry', async () => {
    const r = await setup();
    const { planId } = await importEpic(r, 'write', { doneOnMerge: false });
    await r.plans.startPlan(planId, { mergeMode: 'agents' });
    await settle(r);
    // Run start: PROJ-11, PROJ-14 and PROJ-15 are ready → "In Progress" (through "Start progress", resolved by its target).
    for (const key of ['PROJ-11', 'PROJ-14', 'PROJ-15']) expect(r.fake.issues.get(key)?.status).toBe('In Progress');
    expect(r.fake.issues.get('PROJ-12')?.status).toBe('To Do');

    // PROJ-11's PR opens (checks running): "In Review" + a comment with the link. The comment's first answer is lost (stored, then 500).
    const p11 = await item(r, planId, 'PROJ-11');
    r.git.branches.set(p11.branch as string, { hasWork: true, pr: { state: 'OPEN', url: 'https://git.acme.example/acme/acme-front/pull/7', checks: { state: 'pending', summary: 'running: build', sha: 'abc' } } });
    r.fake.failNext(/^POST \/rest\/api\/3\/issue\/PROJ-11\/comment$/, 500, { commit: true });
    await status(r, p11.runSessionId as string, 'idle');
    expect((await item(r, planId, 'PROJ-11')).prUrl).toBe('https://git.acme.example/acme/acme-front/pull/7');
    expect(r.fake.issues.get('PROJ-11')?.status).toBe('In Review');
    expect(commentsOf(r, 'PROJ-11')).toHaveLength(1);
    // Retries (any later planChanged) find the marker: no second comment, no second transition.
    for (let round = 0; round < 3; round += 1) {
      r.bus.publish('planChanged', { planId, state: 'running' });
      await settle(r);
    }
    expect(commentsOf(r, 'PROJ-11')).toHaveLength(1);
    expect(commentsOf(r, 'PROJ-11')[0]).toMatch(/^Pull request opened: https:\/\/git\.acme\.example\/acme\/acme-front\/pull\/7 \[switchboard:[0-9a-f]+:[0-9a-f]+:pr-comment:https:\/\/git\.acme\.example\/acme\/acme-front\/pull\/7\]$/);
    expect(r.fake.calls(/^POST \/rest\/api\/3\/issue\/PROJ-11\/transitions$/)).toHaveLength(2);

    // PROJ-15's agent asks the developer: one comment per question episode.
    const p15 = await item(r, planId, 'PROJ-15');
    await status(r, p15.runSessionId as string, 'need');
    expect((await item(r, planId, 'PROJ-15')).state).toBe('question');
    r.bus.publish('planChanged', { planId, state: 'running' });
    await settle(r);
    expect(commentsOf(r, 'PROJ-15').filter((text) => text.startsWith('The agent working on this ticket is waiting'))).toHaveLength(1);
    await status(r, p15.runSessionId as string, 'run');
    await status(r, p15.runSessionId as string, 'need');
    expect(commentsOf(r, 'PROJ-15').filter((text) => text.startsWith('The agent working on this ticket is waiting'))).toHaveLength(2);

    // PROJ-11 merges: a comment "Merged into <target>", the ticket stays In Review (D116's setting is off).
    r.git.branches.set(p11.branch as string, { hasWork: true, merged: true, pr: { state: 'MERGED', url: 'https://git.acme.example/acme/acme-front/pull/7', checks: { state: 'green', summary: null, sha: 'abc' } } });
    await status(r, p11.runSessionId as string, 'run');
    await status(r, p11.runSessionId as string, 'idle');
    expect((await item(r, planId, 'PROJ-11')).state).toBe('done');
    expect(commentsOf(r, 'PROJ-11').filter((text) => text.startsWith('Merged into feature/PROJ-10-acme-checkout.'))).toHaveLength(1);
    expect(r.fake.issues.get('PROJ-11')?.status).toBe('In Review');
    expect(r.fake.calls(/transitions$/).filter((request) => request.method === 'POST').map((request) => (request.body as { transition: { id: string } }).transition.id)).not.toContain('41');

    // Every write is in the plan's activity.
    const jira = (await call(r, 'GET', `/api/plans/${planId}/jira`)).body as PlanJiraState;
    const texts = jira.activity.map((entry) => entry.text);
    expect(texts).toContain('PROJ-11 → In Progress (its run started)');
    expect(texts).toContain('PROJ-11 → In Review (its pull request opened)');
    expect(texts).toContain('PROJ-11: pr-comment failed (will retry): Jira answered 500: Fake Jira failure after storing.');
    expect(texts).toContain('PROJ-11: commented "Merged into feature/PROJ-10-acme-checkout."');
    expect(texts.filter((text) => text.startsWith('PROJ-15: commented "The agent working'))).toHaveLength(2);
  });

  it('a missing transition is a soft failure noted on the item and never blocks the plan', async () => {
    const r = await setup();
    const { planId } = await importEpic(r, 'write');
    await r.plans.startPlan(planId, { mergeMode: 'agents' });
    await settle(r);
    // PROJ-12 starts once PROJ-11 is merged; its workflow has no "In Review".
    const p11 = await item(r, planId, 'PROJ-11');
    r.git.branches.set(p11.branch as string, { hasWork: true, merged: true, pr: { state: 'MERGED', url: 'https://git.acme.example/acme/acme-front/pull/1', checks: { state: 'green', summary: null, sha: 'a' } } });
    await status(r, p11.runSessionId as string, 'idle');
    const p12 = await item(r, planId, 'PROJ-12');
    expect(p12.state).toBe('running');
    r.git.branches.set(p12.branch as string, { hasWork: true, pr: { state: 'OPEN', url: 'https://git.acme.example/acme/acme-front/pull/2', checks: { state: 'pending', summary: 'running: build', sha: 'b' } } });
    await status(r, p12.runSessionId as string, 'idle');
    const jira = (await call(r, 'GET', `/api/plans/${planId}/jira`)).body as PlanJiraState;
    const row = jira.items.find((entry) => entry.key === 'PROJ-12');
    expect(row?.syncNote).toBe('no "In Review" transition for PROJ-12 (available: To Do, Done)');
    expect(jira.activity.some((entry) => entry.kind === 'soft-failure' && entry.key === 'PROJ-12')).toBe(true);
    // The rest went on: the comment with the link is there, the item still runs.
    expect(commentsOf(r, 'PROJ-12').some((text) => text.startsWith('Pull request opened: https://git.acme.example/acme/acme-front/pull/2'))).toBe(true);
    expect((await item(r, planId, 'PROJ-12')).state).toBe('running');
    // Not retried.
    const asked = r.fake.calls(/^GET \/rest\/api\/3\/issue\/PROJ-12\/transitions$/).length;
    r.bus.publish('planChanged', { planId, state: 'running' });
    await settle(r);
    expect(r.fake.calls(/^GET \/rest\/api\/3\/issue\/PROJ-12\/transitions$/).length).toBe(asked);
  });

  it('reads and writes nothing while Plans is off', async () => {
    const r = await setup();
    const { planId } = await importEpic(r, 'write');
    r.enabled = false;
    const before = r.fake.requests.length;
    await r.plans.startPlan(planId, { mergeMode: 'agents' });
    await settle(r);
    await r.jira.tick();
    await settle(r);
    expect(r.fake.requests.slice(before)).toEqual([]);
  });
});

/** D116: the transition POSTs that moved an issue to Done (transition id 41 in the fake). */
function donePosts(r: Rig, key: string) {
  return r.fake.calls(new RegExp(`^POST /rest/api/3/issue/${key}/transitions$`)).filter((request) => (request.body as { transition: { id: string } }).transition.id === '41');
}

/** PROJ-11's agent opens its PR (In Review), then it is merged (agents mode): the item is done. `before` runs just before the merge is seen. */
async function agentMerges11(r: Rig, planId: string, before: () => void = () => {}): Promise<void> {
  const p11 = await item(r, planId, 'PROJ-11');
  const pr = { url: 'https://git.acme.example/acme/acme-front/pull/7', checks: { state: 'pending' as const, summary: 'running: build', sha: 'abc' } };
  r.git.branches.set(p11.branch as string, { hasWork: true, pr: { state: 'OPEN', ...pr } });
  await status(r, p11.runSessionId as string, 'idle');
  expect(r.fake.issues.get('PROJ-11')?.status).not.toBe('In Progress');
  before();
  r.git.branches.set(p11.branch as string, { hasWork: true, merged: true, pr: { state: 'MERGED', url: pr.url, checks: { state: 'green', summary: null, sha: 'abc' } } });
  await status(r, p11.runSessionId as string, 'run');
  await status(r, p11.runSessionId as string, 'idle');
  expect((await item(r, planId, 'PROJ-11')).state).toBe('done');
}

async function jiraState(r: Rig, planId: string): Promise<PlanJiraState> {
  return (await call(r, 'GET', `/api/plans/${planId}/jira`)).body as PlanJiraState;
}

describe('D116 · Move to Done when merged into the feature branch', () => {
  it('is on for a new plan with the "Done" default; an agent merge → the comment, then Done ("Moved PROJ-11 to Done"), no false drift', async () => {
    const r = await setup();
    const { planId } = await importEpic(r, 'write');
    expect(await jiraState(r, planId)).toMatchObject({ doneOnMerge: true, transitions: { inProgress: 'In Progress', inReview: 'In Review', done: 'Done' } });
    await r.plans.startPlan(planId, { mergeMode: 'agents' });
    await settle(r);
    await agentMerges11(r, planId);
    expect(r.fake.issues.get('PROJ-11')?.status).toBe('Done');
    expect(commentsOf(r, 'PROJ-11').filter((text) => text.startsWith('Merged into feature/PROJ-10-acme-checkout.'))).toHaveLength(1);
    // The comment comes first, then the transition.
    const order = r.fake.requests.filter((request) => request.method === 'POST' && request.path.startsWith('/rest/api/3/issue/PROJ-11/')).map((request) => request.path.split('/').at(-1));
    expect(order.slice(-2)).toEqual(['comment', 'transitions']);
    expect(donePosts(r, 'PROJ-11')).toHaveLength(1);
    let jira = await jiraState(r, planId);
    expect(jira.activity.map((entry) => entry.text)).toContain('Moved PROJ-11 to Done (merged into feature/PROJ-10-acme-checkout)');
    expect(jira.items.find((entry) => entry.key === 'PROJ-11')).toMatchObject({ status: 'Done', statusCategory: 'done' });
    // A refresh reads Done back: no "Jira says Done; the plan item is …" note on the merged item.
    await call(r, 'POST', `/api/plans/${planId}/jira/refresh`);
    jira = await jiraState(r, planId);
    expect(jira.items.find((entry) => entry.key === 'PROJ-11')?.drift ?? '').not.toMatch(/^Jira says/);
    // Later passes write nothing more.
    r.bus.publish('planChanged', { planId, state: 'running' });
    await settle(r);
    expect(donePosts(r, 'PROJ-11')).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });

  it("the developer's Merge → Done; Mark done → no Done", async () => {
    const r = await setup();
    const { planId } = await importEpic(r, 'write', { doneOnMerge: true, transitions: { done: 'done' } });
    await r.plans.startPlan(planId, { mergeMode: 'developer' });
    await settle(r);
    // PROJ-11's run finishes: ready for the developer's Merge.
    const p11 = await item(r, planId, 'PROJ-11');
    r.git.branches.set(p11.branch as string, { hasWork: true });
    await r.todos.update(r.sourceId, p11.todoId, { state: 'done' }, 'agent');
    await status(r, p11.runSessionId as string, 'idle');
    expect((await item(r, planId, 'PROJ-11')).state).toBe('ready-to-merge');
    expect(r.fake.issues.get('PROJ-11')?.status).toBe('In Progress');
    await r.plans.mergeItem(planId, p11.id);
    await settle(r);
    // The name is matched case-insensitively.
    expect(r.fake.issues.get('PROJ-11')?.status).toBe('Done');
    expect(commentsOf(r, 'PROJ-11').some((text) => text.startsWith('Merged into feature/PROJ-10-acme-checkout.'))).toBe(true);

    // PROJ-15 is counted done by the developer (no merge happened): no comment, no Done.
    const p15 = await item(r, planId, 'PROJ-15');
    await r.plans.markItemDone(planId, p15.id);
    await settle(r);
    expect((await item(r, planId, 'PROJ-15')).state).toBe('done');
    expect(r.fake.issues.get('PROJ-15')?.status).toBe('In Progress');
    expect(donePosts(r, 'PROJ-15')).toHaveLength(0);
    expect(commentsOf(r, 'PROJ-15').some((text) => text.startsWith('Merged into'))).toBe(false);
  });

  it('a plan without a merge step (mergeMode none, with a target) neither comments "Merged into" nor moves a ticket to Done', async () => {
    const r = await setup();
    const { planId } = await importEpic(r, 'write');
    await r.plans.startPlan(planId, { mergeMode: 'none' });
    await settle(r);
    expect((await r.plans.get(planId)).targetBranch).toBe('feature/PROJ-10-acme-checkout');
    const p11 = await item(r, planId, 'PROJ-11');
    await r.todos.update(r.sourceId, p11.todoId, { state: 'done' }, 'agent');
    await status(r, p11.runSessionId as string, 'idle');
    expect((await item(r, planId, 'PROJ-11')).state).toBe('done');
    r.bus.publish('planChanged', { planId, state: 'running' });
    await settle(r);
    expect(r.fake.issues.get('PROJ-11')?.status).toBe('In Progress');
    expect(donePosts(r, 'PROJ-11')).toHaveLength(0);
    expect(commentsOf(r, 'PROJ-11').some((text) => text.startsWith('Merged into'))).toBe(false);
    expect((await jiraState(r, planId)).activity.map((entry) => entry.text).some((text) => text.includes('Merged into'))).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it('an agents-mode merge still comments "Merged into <target>" (Done off: the comment only)', async () => {
    const r = await setup();
    const { planId } = await importEpic(r, 'write', { doneOnMerge: false });
    await r.plans.startPlan(planId, { mergeMode: 'agents' });
    await settle(r);
    await agentMerges11(r, planId);
    expect(commentsOf(r, 'PROJ-11').filter((text) => text.startsWith('Merged into feature/PROJ-10-acme-checkout.'))).toHaveLength(1);
    expect(donePosts(r, 'PROJ-11')).toHaveLength(0);
  });

  it('the setting off → no Done; switching it on the plan (PUT) is saved and logged', async () => {
    const r = await setup();
    const { planId } = await importEpic(r, 'write', { doneOnMerge: false });
    expect((await jiraState(r, planId)).doneOnMerge).toBe(false);
    await r.plans.startPlan(planId, { mergeMode: 'agents' });
    await settle(r);
    await agentMerges11(r, planId);
    expect(r.fake.issues.get('PROJ-11')?.status).toBe('In Review');
    expect(donePosts(r, 'PROJ-11')).toHaveLength(0);
    // Turned on later: the merged item is moved on the next pass.
    const changed = await call(r, 'PUT', `/api/plans/${planId}/jira`, { doneOnMerge: true, transitions: { done: 'Done' } });
    expect(changed.status, changed.text).toBe(200);
    expect(changed.body).toMatchObject({ doneOnMerge: true, transitions: { done: 'Done' } });
    await settle(r);
    expect(r.fake.issues.get('PROJ-11')?.status).toBe('Done');
    expect((await jiraState(r, planId)).activity.map((entry) => entry.text)).toContain('Jira move to Done when merged on');
    // Refused: a non-boolean, an empty name.
    expect((await call(r, 'PUT', `/api/plans/${planId}/jira`, { doneOnMerge: 'yes' })).body).toMatchObject({ error: 'invalid', errors: [{ field: 'doneOnMerge' }] });
    expect((await call(r, 'PUT', `/api/plans/${planId}/jira`, { transitions: { done: '  ' } })).body).toMatchObject({ error: 'invalid', errors: [{ field: 'transitions.done' }] });
  });

  it('an issue already Done is left alone; a missing Done transition is a soft note, never retried', async () => {
    const r = await setup();
    // PROJ-11 has no Done transition in its workflow.
    r.fake.issues.get('PROJ-11')!.without = ['41'];
    const { planId } = await importEpic(r, 'write');
    await r.plans.startPlan(planId, { mergeMode: 'agents' });
    await settle(r);
    await agentMerges11(r, planId);
    let jira = await jiraState(r, planId);
    expect(jira.items.find((entry) => entry.key === 'PROJ-11')?.syncNote).toBe('no "Done" transition for PROJ-11 (available: To Do, Start progress)');
    expect(jira.activity.some((entry) => entry.kind === 'soft-failure' && entry.key === 'PROJ-11')).toBe(true);
    const asked = r.fake.calls(/^GET \/rest\/api\/3\/issue\/PROJ-11\/transitions$/).length;
    r.bus.publish('planChanged', { planId, state: 'running' });
    await settle(r);
    expect(r.fake.calls(/^GET \/rest\/api\/3\/issue\/PROJ-11\/transitions$/).length).toBe(asked);
    // The plan went on: PROJ-12 (after PROJ-11) runs.
    expect((await item(r, planId, 'PROJ-12')).state).toBe('running');

    // PROJ-12 is moved to Done by the team before its merge: left alone.
    r.fake.issues.get('PROJ-12')!.status = 'Done';
    const p12 = await item(r, planId, 'PROJ-12');
    r.git.branches.set(p12.branch as string, { hasWork: true, merged: true });
    await status(r, p12.runSessionId as string, 'idle');
    expect((await item(r, planId, 'PROJ-12')).state).toBe('done');
    expect(donePosts(r, 'PROJ-12')).toHaveLength(0);
    jira = await jiraState(r, planId);
    expect(jira.items.find((entry) => entry.key === 'PROJ-12')?.syncNote ?? null).toBeNull();
  });

  it('a 5xx is retried and then succeeds; a lost answer is not moved twice', async () => {
    const r = await setup();
    const { planId } = await importEpic(r, 'write');
    await r.plans.startPlan(planId, { mergeMode: 'agents' });
    await settle(r);
    // The Done POST fails once with 503: pending, retried at the next pass (the pass's own planChanged), then Done.
    await agentMerges11(r, planId, () => r.fake.failNext(/^POST \/rest\/api\/3\/issue\/PROJ-11\/transitions$/, 503));
    let jira = await jiraState(r, planId);
    expect(jira.activity.map((entry) => entry.text)).toContain('PROJ-11: done failed (will retry): Jira answered 503: Fake Jira failure.');
    r.bus.publish('planChanged', { planId, state: 'running' });
    await settle(r);
    expect(r.fake.issues.get('PROJ-11')?.status).toBe('Done');
    expect(donePosts(r, 'PROJ-11')).toHaveLength(2);
    expect(jira.items.find((entry) => entry.key === 'PROJ-11')?.drift ?? '').not.toMatch(/^Jira says/);

    // PROJ-15: the Done POST is made, but its answer is lost (500 after moving). The retry finds it Done: no second POST.
    const p15 = await item(r, planId, 'PROJ-15');
    r.fake.failNext(/^POST \/rest\/api\/3\/issue\/PROJ-15\/transitions$/, 500, { commit: true });
    r.git.branches.set(p15.branch as string, { hasWork: true, merged: true });
    await status(r, p15.runSessionId as string, 'idle');
    expect((await item(r, planId, 'PROJ-15')).state).toBe('done');
    expect(r.fake.issues.get('PROJ-15')?.status).toBe('Done');
    for (let round = 0; round < 3; round += 1) {
      r.bus.publish('planChanged', { planId, state: 'running' });
      await settle(r);
    }
    expect(donePosts(r, 'PROJ-15')).toHaveLength(1);
    jira = await jiraState(r, planId);
    expect(jira.activity.filter((entry) => entry.key === 'PROJ-15' && entry.text.includes('gave up'))).toEqual([]);
  });

  it('a pending In Review retry is dropped once the ticket is Done (never moved back)', async () => {
    const r = await setup();
    const { planId } = await importEpic(r, 'write');
    await r.plans.startPlan(planId, { mergeMode: 'agents' });
    await settle(r);
    // PROJ-11 is seen with its PR already merged; the In Review POST fails (5xx), the Done one works.
    r.fake.failNext(/^POST \/rest\/api\/3\/issue\/PROJ-11\/transitions$/, 503);
    const p11 = await item(r, planId, 'PROJ-11');
    r.git.branches.set(p11.branch as string, { hasWork: true, merged: true, pr: { state: 'MERGED', url: 'https://git.acme.example/acme/acme-front/pull/7', checks: { state: 'green', summary: null, sha: 'abc' } } });
    await status(r, p11.runSessionId as string, 'idle');
    for (let round = 0; round < 3; round += 1) {
      r.bus.publish('planChanged', { planId, state: 'running' });
      await settle(r);
    }
    expect(r.fake.issues.get('PROJ-11')?.status).toBe('Done');
    const ids = r.fake.calls(/^POST \/rest\/api\/3\/issue\/PROJ-11\/transitions$/).map((request) => (request.body as { transition: { id: string } }).transition.id);
    expect(ids.filter((id) => id === '31')).toHaveLength(1);
  });

  it('migration: a plans.db from before D116 gets done_on_merge, off for its plans; a new plan stores it on', async () => {
    const dir = await makeTempDir('plans-jira-d116');
    try {
      const db = await openDatabase(`${dir}/plans.db`);
      migrate(db, PLANS_MIGRATIONS);
      const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      // plan_jira as v1.27.0 made it (no done_on_merge), with a plan in it.
      db.exec(`CREATE TABLE plan_jira (
  plan_id TEXT PRIMARY KEY, epic_key TEXT NOT NULL, base_url TEXT NOT NULL,
  sync TEXT NOT NULL DEFAULT 'off' CHECK (sync IN ('off', 'read-only', 'write')),
  transitions TEXT NOT NULL CHECK (json_valid(transitions)), last_refresh_at TEXT, created_at TEXT NOT NULL
) STRICT;`);
      db.prepare('INSERT INTO plan_jira (plan_id, epic_key, base_url, sync, transitions, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('a1b2c3d4e5', 'PROJ-10', 'https://acme.atlassian.net', 'write', JSON.stringify({ inProgress: 'In Progress', inReview: 'In Review' }), '2026-10-01T10:00:00Z');
      const store = new PlanJiraStore(db);
      expect(await store.plan('a1b2c3d4e5')).toMatchObject({ doneOnMerge: false, transitions: { inProgress: 'In Progress', inReview: 'In Review', done: 'Done' } });
      await store.createPlan({ planId: 'f6e5d4c3b2', epicKey: 'PROJ-20', baseUrl: 'https://acme.atlassian.net', sync: 'write', transitions: { inProgress: 'In Progress', inReview: 'In Review', done: 'Closed' }, doneOnMerge: true, items: [] });
      expect(await store.plan('f6e5d4c3b2')).toMatchObject({ doneOnMerge: true, transitions: { done: 'Closed' } });
      // Opening it again changes nothing; the core's migration list is untouched.
      new PlanJiraStore(db);
      expect(await store.plan('a1b2c3d4e5')).toMatchObject({ doneOnMerge: false });
      expect(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(version);
      db.close();
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe('D99-Jira · credentials', () => {
  it('never answers or logs the token; Settings credentials go to the keychain and win over the environment', async () => {
    const r = await setup({ env: 'none' });
    const logged: string[] = [];
    const original = { error: console.error, log: console.log, warn: console.warn };
    for (const name of ['error', 'log', 'warn'] as const) console[name] = (...args: unknown[]) => logged.push(args.map(String).join(' '));
    try {
      expect((await call(r, 'GET', '/api/integrations/jira')).body).toEqual({ configured: false, source: null, baseUrl: null, email: null, keychain: true });
      const saved = await call(r, 'PUT', '/api/integrations/jira', { baseUrl: `${r.fake.url}/jira/`, email: r.fake.email, token: r.fake.token });
      expect(saved.body).toEqual({ configured: true, source: 'settings', baseUrl: r.fake.url, email: r.fake.email, keychain: true });
      expect([...r.keychain.values.keys()]).toEqual(['Switchboard Jira/default']);
      expect((await call(r, 'PUT', '/api/integrations/jira', { baseUrl: 'http://acme.atlassian.net', email: 'a@b', token: 'x' })).body.errors[0].field).toBe('baseUrl');
      const { planId } = await importEpic(r, 'write');
      await r.plans.startPlan(planId, { mergeMode: 'agents' });
      await settle(r);
      // A wrong token: Jira refuses; the answer and the activity name the problem, not the token.
      await call(r, 'PUT', '/api/integrations/jira', { baseUrl: r.fake.url, email: r.fake.email, token: 'wrong-token-zz' });
      const refused = await call(r, 'POST', `/api/plans/${planId}/jira/refresh`);
      expect(refused.status).toBe(502);
      expect(refused.body.error).toBe('jira-auth');
      const everything = [
        refused.text,
        saved.text,
        (await call(r, 'GET', '/api/integrations/jira')).text,
        (await call(r, 'GET', `/api/plans/${planId}/jira`)).text,
        JSON.stringify(await r.plans.get(planId)),
        ...logged,
        ...r.errors.map((error) => (error instanceof Error ? `${error.message} ${error.stack}` : String(error))),
      ].join('\n');
      for (const secret of [r.fake.token, 'wrong-token-zz', Buffer.from(`${r.fake.email}:${r.fake.token}`).toString('base64')]) expect(everything).not.toContain(secret);
      // Basic auth went only to the configured base URL.
      expect(r.fake.requests.every((request) => request.authorization?.startsWith('Basic '))).toBe(true);
      expect((await call(r, 'DELETE', '/api/integrations/jira')).body.configured).toBe(false);
    } finally {
      Object.assign(console, original);
    }
  });
});

describe('D99-Jira-q1 · proposed order (unit)', () => {
  it('asks the source session once after an import with unlinked items; on demand only for a draft', async () => {
    const r = await setup();
    const answer = await call(r, 'POST', `/api/sessions/${r.sourceId}/plans/jira/import`, { epic: 'PROJ-10', targetBranch: 'feature/PROJ-10-acme-checkout' });
    expect(answer.body.askedForOrder).toBe(true);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.sessionId).toBe(r.sourceId);
    expect(r.sent[0]?.text).toContain('These items have no dependency yet: PROJ-15.');
    expect(r.sent[0]?.text).toContain('- PROJ-13 waits on PROJ-12');
    const planId = answer.body.plan.id as string;
    expect((await call(r, 'POST', `/api/plans/${planId}/proposals/ask`)).status).toBe(200);
    expect(r.sent).toHaveLength(2);
    await r.plans.startPlan(planId, { mergeMode: 'developer' });
    expect((await call(r, 'POST', `/api/plans/${planId}/proposals/ask`)).body.error).toBe('not-draft');
    expect(await call(r, 'GET', `/api/plans/${planId}/proposals`)).toMatchObject({ status: 200, body: [] });
  });

  it('stores proposals from the plan\'s own session only; accept-all adds them, a cycle stays pending with its reason', async () => {
    const r = await setup();
    const { planId } = await importEpic(r, 'off');
    const agent = (sessionId: string, body: unknown) => r.app.inject({ method: 'POST', url: `/agent/v1/plans/${planId}/proposals`, headers: { 'x-switchboard-session': sessionId }, payload: body as Record<string, unknown> });
    const other = await r.store.sessions.create({ name: 'other', claudeSessionId: 'c-other', status: 'idle', cwd: '/ws', root: '/ws', rootKind: 'workspace', solutions: [], worktrees: false });
    expect((await agent(other.id, { proposals: [{ from: 'PROJ-11', to: 'PROJ-15', reason: 'x' }] })).statusCode).toBe(404);
    expect((await agent(r.sourceId, { proposals: [] })).statusCode).toBe(422);
    const made = await agent(r.sourceId, { proposals: [{ from: 'PROJ-11', to: 'PROJ-15', reason: 'needs the cart' }, { from: 'PROJ-13', to: 'PROJ-12', reason: 'cycle' }, { from: 'proj-11', to: 'PROJ-15', reason: 'again' }] });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().added.map((entry: { text: string }) => entry.text)).toEqual(['PROJ-15 should wait on PROJ-11', 'PROJ-12 should wait on PROJ-13']);
    expect(made.json().skipped).toEqual([{ from: 'proj-11', to: 'PROJ-15', why: 'proposed before' }]);
    const all = await call(r, 'POST', `/api/plans/${planId}/proposals/accept-all`);
    expect(all.status).toBe(200);
    expect(all.body.refused).toHaveLength(1);
    expect(all.body.refused[0].reason).toContain('cycle');
    expect(all.body.proposals.map((entry: { state: string }) => entry.state)).toEqual(['accepted', 'pending']);
    expect((await r.plans.get(planId)).edges).toHaveLength(4);
    const pending = all.body.proposals[1].id as string;
    expect((await call(r, 'POST', `/api/plans/${planId}/proposals/${pending}/reject`)).body.proposals[1].state).toBe('rejected');
    expect((await call(r, 'POST', `/api/plans/${planId}/proposals/${pending}/accept`)).body.error).toBe('decided');
  });
});

/** The embedded fields of the first link's other issue. */
function link0Fields(links: Array<Record<string, unknown>>): unknown {
  return (links[0]?.['inwardIssue'] as { fields?: unknown } | undefined)?.fields;
}

/** D117: a chain epic: backend → front → E2E tests (each blocks the next), plus an unlinked docs item. */
function chainEpic(): FakeIssue[] {
  return [
    { key: 'PROJ-20', summary: 'Acme tracking', description: null, status: 'To Do', parent: null, comments: [] },
    { key: 'PROJ-21', summary: 'Acme tracking vocabulary', description: null, status: 'To Do', parent: 'PROJ-20', blocks: ['PROJ-22'], comments: [] },
    { key: 'PROJ-22', summary: 'Acme tracking front', description: null, status: 'To Do', parent: 'PROJ-20', blocks: ['PROJ-23'], comments: [] },
    { key: 'PROJ-23', summary: 'Acme tracking E2E tests', description: null, status: 'To Do', parent: 'PROJ-20', comments: [] },
    { key: 'PROJ-24', summary: 'Acme tracking docs', description: null, status: 'To Do', parent: 'PROJ-20', comments: [] },
  ];
}

describe('D117 · Jira "Blocks" direction', () => {
  const states = async (r: Rig, planId: string) => Object.fromEntries((await r.plans.get(planId)).items.map((entry) => [entry.key, entry.state]));

  it('the fake answers real Jira\'s shape: "X blocks Y" is inwardIssue Y on X and outwardIssue X on Y', async () => {
    const r = await setup({ issues: chainEpic() });
    const answer = await fetch(`${r.fake.url}/rest/api/3/issue/PROJ-21?fields=issuelinks`, { headers: { authorization: `Basic ${Buffer.from(`${r.fake.email}:${r.fake.token}`).toString('base64')}` } });
    const links = ((await answer.json()) as { fields: { issuelinks: Array<Record<string, unknown>> } }).fields.issuelinks.filter((link) => (link['type'] as { name: string }).name === 'Blocks');
    // Real Jira also embeds the other issue's summary and status (D118 reads them for outside links).
    expect(links.map((link) => [(link['inwardIssue'] as { key?: string } | undefined)?.key, link['outwardIssue']])).toEqual([['PROJ-22', undefined]]);
    expect(link0Fields(links)).toMatchObject({ summary: 'Acme tracking front', status: { name: 'To Do' } });
  });

  it('imports a chain epic with only its first item ready and the end-of-chain E2E item last', async () => {
    const r = await setup({ issues: chainEpic() });
    const answer = await call(r, 'POST', `/api/sessions/${r.sourceId}/plans/jira/import`, { epic: 'PROJ-20', targetBranch: 'feature/PROJ-20-acme-tracking' });
    expect(answer.status, answer.text).toBe(201);
    expect((answer.body.preview as JiraPreview).edges.map((edge) => edge.text)).toEqual(['PROJ-22 waits on PROJ-21', 'PROJ-23 waits on PROJ-22']);
    expect(await states(r, answer.body.plan.id)).toEqual({ 'PROJ-21': 'ready', 'PROJ-22': 'waiting', 'PROJ-23': 'waiting', 'PROJ-24': 'ready' });
  });

  it('Re-read dependencies replaces the backwards Jira edges on a draft, keeps the developer\'s, and is refused once started', async () => {
    const r = await setup({ issues: chainEpic() });
    const imported = await call(r, 'POST', `/api/sessions/${r.sourceId}/plans/jira/import`, { epic: 'PROJ-20', targetBranch: 'feature/PROJ-20-acme-tracking' });
    const planId: string = imported.body.plan.id;
    const ids: Record<string, string> = Object.fromEntries(imported.body.plan.items.map((entry: { key: string; id: string }) => [entry.key, entry.id]));
    // A plan imported before the fix: every Jira edge backwards; plus the developer's own edge (docs after the E2E tests).
    await r.plans.removeEdge(planId, ids['PROJ-21'] as string, ids['PROJ-22'] as string);
    await r.plans.removeEdge(planId, ids['PROJ-22'] as string, ids['PROJ-23'] as string);
    await r.plans.addEdge(planId, { from: ids['PROJ-23'], to: ids['PROJ-22'] });
    await r.plans.addEdge(planId, { from: ids['PROJ-22'], to: ids['PROJ-21'] });
    await r.plans.addEdge(planId, { from: ids['PROJ-23'], to: ids['PROJ-24'] });
    expect(await states(r, planId)).toMatchObject({ 'PROJ-21': 'waiting', 'PROJ-23': 'ready' });

    const url = `/api/plans/${planId}/jira/dependencies`;
    const preview = await call(r, 'POST', url, {});
    expect(preview.status, preview.text).toBe(200);
    expect(preview.body).toMatchObject({ applied: false, unchanged: 0 });
    expect(preview.body.removed.map((edge: { text: string }) => edge.text)).toEqual(['PROJ-22 waits on PROJ-23', 'PROJ-21 waits on PROJ-22']);
    expect(preview.body.added.map((edge: { text: string }) => edge.text)).toEqual(['PROJ-22 waits on PROJ-21', 'PROJ-23 waits on PROJ-22']);
    expect(preview.body.kept.map((edge: { text: string }) => edge.text)).toEqual(['PROJ-24 waits on PROJ-23']);
    // Nothing changed yet, and Jira was only read.
    expect((await r.plans.get(planId)).edges).toHaveLength(3);
    expect(r.fake.calls(/^(POST|PUT|DELETE) /)).toEqual([]);

    expect((await call(r, 'POST', url, { apply: true, fingerprint: 'stale' })).body.error).toBe('changed');
    const applied = await call(r, 'POST', url, { apply: true, fingerprint: preview.body.fingerprint });
    expect(applied.status, applied.text).toBe(200);
    expect(applied.body.applied).toBe(true);
    expect(await states(r, planId)).toEqual({ 'PROJ-21': 'ready', 'PROJ-22': 'waiting', 'PROJ-23': 'waiting', 'PROJ-24': 'waiting' });
    const edges = (await r.plans.get(planId)).edges.map((edge) => `${edge.from}>${edge.to}`).sort();
    expect(edges).toEqual([`${ids['PROJ-21']}>${ids['PROJ-22']}`, `${ids['PROJ-22']}>${ids['PROJ-23']}`, `${ids['PROJ-23']}>${ids['PROJ-24']}`].sort());
    const activity = (await call(r, 'GET', `/api/plans/${planId}/jira`)).body as PlanJiraState;
    expect(activity.activity[0]?.text).toBe('Re-read dependencies from PROJ-20: 2 removed, 2 added, 1 of yours kept');
    // Again: nothing left to change.
    expect((await call(r, 'POST', url, {})).body).toMatchObject({ removed: [], added: [], unchanged: 2 });
    expect(r.fake.calls(/^(POST|PUT|DELETE) /)).toEqual([]);

    await r.plans.startPlan(planId, { mergeMode: 'developer' });
    const refused = await call(r, 'POST', url, { apply: true });
    expect([refused.status, refused.body.error]).toEqual([409, 'not-draft']);
  });

  it('keeps an accepted proposal even when it contradicts Jira (the Jira link is left out as a cycle)', async () => {
    const r = await setup({ issues: chainEpic() });
    const imported = await call(r, 'POST', `/api/sessions/${r.sourceId}/plans/jira/import`, { epic: 'PROJ-20', targetBranch: 'feature/PROJ-20-acme-tracking' });
    const planId: string = imported.body.plan.id;
    const ids: Record<string, string> = Object.fromEntries(imported.body.plan.items.map((entry: { key: string; id: string }) => [entry.key, entry.id]));
    await r.plans.removeEdge(planId, ids['PROJ-21'] as string, ids['PROJ-22'] as string);
    await r.jira.propose(r.sourceId, planId, { proposals: [{ from: 'PROJ-22', to: 'PROJ-21', reason: 'Acme front defines the vocabulary' }] });
    expect((await call(r, 'POST', `/api/plans/${planId}/proposals/accept-all`)).status).toBe(200);
    const preview = await call(r, 'POST', `/api/plans/${planId}/jira/dependencies`, {});
    expect(preview.body.removed).toEqual([]);
    expect(preview.body.kept.map((edge: { text: string }) => edge.text)).toEqual(['PROJ-21 waits on PROJ-22']);
    expect(preview.body.cycles.map((edge: { text: string }) => edge.text)).toEqual(['PROJ-22 waits on PROJ-21']);
  });
});

describe('D117 follow-up · Delete a running plan stops its item sessions', () => {
  it('?stop: cancels, stops the sessions whose turn runs (they stay), then deletes; plain delete is unchanged', async () => {
    const r = await setup({ issues: chainEpic() });
    const imported = await call(r, 'POST', `/api/sessions/${r.sourceId}/plans/jira/import`, { epic: 'PROJ-20', targetBranch: 'feature/PROJ-20-acme-tracking' });
    const planId: string = imported.body.plan.id;
    await r.plans.startPlan(planId, { mergeMode: 'developer' });
    await settle(r);
    const running = (await r.plans.get(planId)).items.filter((entry) => entry.state === 'running');
    expect(running.map((entry) => entry.key).sort()).toEqual(['PROJ-21', 'PROJ-24']);
    // An item whose session already ended its turn is not stopped again.
    const idle = running.find((entry) => entry.key === 'PROJ-24');
    await r.store.sessions.update(idle?.runSessionId as string, { status: 'idle' });
    // Plain delete still refuses a running plan and stops nothing.
    await expect(r.plans.remove(planId)).rejects.toMatchObject({ code: 'running' });
    expect(r.stops).toEqual([]);

    const result = await r.plans.remove(planId, { stop: true });
    const busy = running.find((entry) => entry.key === 'PROJ-21');
    expect(result).toEqual({ cancelled: true, stopped: [{ itemId: busy?.id, sessionId: busy?.runSessionId, outcome: 'stopped' }] });
    expect(r.stops).toEqual([busy?.runSessionId]);
    await expect(r.plans.get(planId)).rejects.toMatchObject({ code: 'not-found' });
    // The sessions stay (not closed, not deleted).
    for (const entry of running) expect(await r.store.sessions.get(entry.runSessionId as string)).toMatchObject({ closedAt: null });
  });

  it('?stop on a paused plan cancels it first; on a draft it just deletes', async () => {
    const r = await setup({ issues: chainEpic() });
    const first = await call(r, 'POST', `/api/sessions/${r.sourceId}/plans/jira/import`, { epic: 'PROJ-20', targetBranch: 'feature/PROJ-20-acme-tracking' });
    await r.plans.startPlan(first.body.plan.id, { mergeMode: 'developer' });
    await settle(r);
    await r.plans.pause(first.body.plan.id);
    expect((await r.plans.remove(first.body.plan.id, { stop: true })).cancelled).toBe(true);
    const second = await call(r, 'POST', `/api/sessions/${r.sourceId}/plans/jira/import`, { epic: 'PROJ-20', targetBranch: 'feature/PROJ-20-acme-tracking' });
    expect(await r.plans.remove(second.body.plan.id, { stop: true })).toEqual({ cancelled: false, stopped: [] });
  });
});
