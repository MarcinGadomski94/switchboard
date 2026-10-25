/**
 * D129 · the agent edits items already in its plan: `plan_update_item`, `plan_remove_item`,
 * `plan_remove_dependency` and `plan_set_mode`, through the real app's agent routes (agent
 * token, `inject`) over a PlanService with a fake environment and git (runs are stored
 * sessions, messages to run sessions are recorded), so started and done items are real states.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type Plan, type PlanItem } from '../../../src/core/plans.ts';
import { type AgentApi, createTodoServer } from '../../../src/hook/sb-mcp.ts';
import { planAddDependency, planRemoveDependency, planRemoveItem, planSetMode, planUpdateItem, registerPlanToolsIfOn } from '../../../src/hook/sb-plan-tools.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import type { PlanGitPort, PlanRepoInput, PlanRepoState } from '../../../src/server/plans/git.ts';
import { type PlanEnvironment, type PlanMergePort, type PlanRunInput, PlanService } from '../../../src/server/plans/service.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import type { BranchMergeInput, BranchMergePlan } from '../../../src/server/worktrees/branch-merge.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

const PORT = 4961; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

/** Git as an item branch with no work yet; `main` is the default branch. */
class QuietGit implements PlanGitPort {
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
    return { repo: input.repo, hasWork: false, merged: false, pr: null, ghAvailable: true, conflict: false };
  }
}

const NO_MERGE: PlanMergePort = {
  async check(input: BranchMergeInput): Promise<BranchMergePlan> {
    return { input, head: 'beef', targetTip: 'cafe', targetLocal: true, checkedOutAt: null, kind: 'fast-forward', tree: null };
  },
  async merge(): Promise<string> {
    return 'merged';
  },
  async openPullRequest(input: BranchMergeInput): Promise<string> {
    return `https://example.test/pr/${input.branch}`;
  },
};

interface Rig {
  readonly dir: string;
  readonly store: Store;
  readonly plans: PlanService;
  readonly todos: TodoService;
  readonly app: FastifyInstance;
  readonly token: string;
  readonly sourceId: string;
  readonly otherId: string;
  readonly sent: Array<{ sessionId: string; text: string }>;
  readonly errors: unknown[];
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.app.close();
  await rig?.plans.close();
  await rig?.store.close();
  if (rig) await removeTempDir(rig.dir);
  rig = undefined;
});

async function setup(): Promise<Rig> {
  const dir = await makeTempDir('plan-item-tools');
  const store = await openTempStore(dir);
  const bus = new HubBus();
  const todos = new TodoService({ store, bus });
  const source = await store.sessions.create({ name: 'source', claudeSessionId: 'c-source', status: 'idle', cwd: '/ws', root: '/ws', rootKind: 'workspace', solutions: ['acme-front'], worktrees: false });
  const other = await store.sessions.create({ name: 'other', claudeSessionId: 'c-other', status: 'idle', cwd: '/ws', root: '/ws', rootKind: 'workspace', solutions: ['acme-front'], worktrees: false });
  const sent: Array<{ sessionId: string; text: string }> = [];
  const errors: unknown[] = [];
  let runs = 0;
  const env: PlanEnvironment = {
    async repos(_sourceSessionId, names) {
      return { kind: 'workspace', repos: (names ?? ['acme-front']).map((name) => ({ name, repoPath: `/repos/${name}` })) };
    },
    async run(input: PlanRunInput) {
      runs += 1;
      const session = await store.sessions.create({ name: `run-${runs}`, claudeSessionId: `c-run-${runs}`, status: 'run', cwd: '/ws', root: '/ws', rootKind: 'workspace', solutions: Object.keys(input.from ?? {}), worktrees: true });
      return { ok: true, sessionId: session.id, branch: input.branch };
    },
    async usageHeld() {
      return null;
    },
    async send(sessionId, text) {
      sent.push({ sessionId, text });
    },
    async notice() {},
    async mergeNotice() {},
    async closeMergeNotice() {},
    async stoppedNotice() {},
    async closeStoppedNotices() {},
  };
  const plans = new PlanService({ dataDir: dir, store, bus, todos, git: new QuietGit(), merger: NO_MERGE, env, pollMs: 3_600_000, onError: (error) => errors.push(error) });
  const token = generateToken();
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: dir }, platform: 'linux', home: dir, cwd: dir }), port: PORT };
  const app = await buildApp({ config, token, store, webRoot: dir, bus, todos, plans, agentTools: false });
  await app.ready();
  await plans.start();
  rig = { dir, store, plans, todos, app, token, sourceId: source.id, otherId: other.id, sent, errors };
  return rig;
}

/** The MCP helper's API over `inject`, as session `sessionId` with its own agent token. */
function helperApi(r: Rig, sessionId: string): AgentApi {
  return async (method, url, body) => {
    const answer = await r.app.inject({
      method,
      url,
      headers: { host: HOST, 'x-switchboard-session': sessionId, authorization: `Bearer ${agentTokenFor(r.token, sessionId)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return { status: answer.statusCode, body: answer.body ? (answer.json() as unknown) : null };
  };
}

function text(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

async function settle(r: Rig): Promise<void> {
  await r.plans.idle();
  await r.plans.idle();
}

/** A draft plan of the source session: PROJ-1 → PROJ-2 (PROJ-2 runs after PROJ-1). */
async function twoItems(r: Rig, targetBranch: string | null = 'feature/PROJ-100-acme'): Promise<{ plan: Plan; first: string; second: string }> {
  const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Acme epic', targetBranch });
  const first = (await r.plans.addItem(plan.id, { key: 'PROJ-1', todo: { title: 'Item one', description: 'First.', plan: 'Do one.', estimateMinutes: 30 } })).itemId;
  const second = (await r.plans.addItem(plan.id, { key: 'PROJ-2', todo: { title: 'Item two', plan: 'Do two.', estimateMinutes: 45 }, after: ['PROJ-1'] })).itemId;
  return { plan: await r.plans.get(plan.id), first, second };
}

async function itemOf(r: Rig, planId: string, itemId: string): Promise<PlanItem> {
  const found = (await r.plans.get(planId)).items.find((candidate) => candidate.id === itemId);
  if (!found) throw new Error('no item');
  return found;
}

describe('D129 · plan_update_item', () => {
  it('sets and clears the hold of a draft plan\'s item, by key or id', async () => {
    const r = await setup();
    const { plan, first, second } = await twoItems(r);
    const api = helperApi(r, r.sourceId);
    const set = await planUpdateItem(api, { plan_id: plan.id, item: 'PROJ-2', hold: true });
    expect(set.isError, text(set)).toBeFalsy();
    expect(text(set)).toContain(`Updated [${second}] PROJ-2 Item two (hold)`);
    expect(text(set)).toContain('Item two: waiting (hold)');
    expect((await itemOf(r, plan.id, second)).hold).toBe(true);
    const cleared = await planUpdateItem(api, { plan_id: plan.id, item: `[${second}]`, hold: false });
    expect(cleared.isError, text(cleared)).toBeFalsy();
    expect((await itemOf(r, plan.id, second)).hold).toBe(false);
    expect((await itemOf(r, plan.id, first)).hold).toBe(false);
    expect(r.sent).toEqual([]);
  });

  it('a running plan: a hold set and cleared on a running item tells its session its new rule', async () => {
    const r = await setup();
    const { plan, first } = await twoItems(r);
    await r.plans.startPlan(plan.id, { mergeMode: 'agents-with-holds' });
    await settle(r);
    const running = await itemOf(r, plan.id, first);
    expect(running.storedState).toBe('running');
    const api = helperApi(r, r.sourceId);
    const held = await planUpdateItem(api, { plan_id: plan.id, item: 'PROJ-1', hold: true });
    expect(held.isError, text(held)).toBeFalsy();
    expect(r.sent).toEqual([{ sessionId: running.runSessionId, text: expect.stringContaining('Do not merge it yourself') }]);
    const released = await planUpdateItem(api, { plan_id: plan.id, item: 'PROJ-1', hold: false });
    expect(released.isError, text(released)).toBeFalsy();
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]).toEqual({ sessionId: running.runSessionId, text: expect.stringContaining('The plan\'s merge rule changed for this item.') });
    expect(r.sent[1]?.text).not.toContain('Do not merge it yourself');
    // A pending item's hold changes silently (no session yet).
    expect((await planUpdateItem(api, { plan_id: plan.id, item: 'PROJ-2', hold: true })).isError).toBeFalsy();
    expect(r.sent).toHaveLength(2);
    expect(r.errors).toEqual([]);
  });

  it("edits a pending item's title, description and estimate (its todo); refuses them once it started, and a done item's hold", async () => {
    const r = await setup();
    const { plan, first, second } = await twoItems(r);
    const api = helperApi(r, r.sourceId);
    const edited = await planUpdateItem(api, { plan_id: plan.id, item: 'PROJ-2', title: 'Item two, renamed', description: 'Now with a note.', estimate_minutes: 90 });
    expect(edited.isError, text(edited)).toBeFalsy();
    expect(text(edited)).toContain('Item two, renamed');
    const viewed = await itemOf(r, plan.id, second);
    expect([viewed.title, viewed.estimateMinutes]).toEqual(['Item two, renamed', 90]);
    const todo = await r.store.todos.get(viewed.todoId);
    expect([todo?.title, todo?.description, todo?.estimateMinutes]).toEqual(['Item two, renamed', 'Now with a note.', 90]);
    // The todo service's own checks hold: an empty title is refused, nothing changes.
    const blank = await planUpdateItem(api, { plan_id: plan.id, item: 'PROJ-2', title: '   ', hold: true });
    expect(blank.isError).toBe(true);
    expect((await itemOf(r, plan.id, second)).hold).toBe(false);

    await r.plans.startPlan(plan.id, { mergeMode: 'developer' });
    await settle(r);
    expect((await itemOf(r, plan.id, first)).storedState).toBe('running');
    const started = await planUpdateItem(api, { plan_id: plan.id, item: 'PROJ-1', title: 'Too late' });
    expect(started.isError).toBe(true);
    expect(text(started)).toBe("the item's title, description and estimate change only before the item starts (PROJ-1 is running)");
    expect((await itemOf(r, plan.id, first)).title).toBe('Item one');
    // The developer route refuses the same, with the same reason.
    const developer = await r.app.inject({ method: 'PUT', url: `/api/plans/${plan.id}/items/${first}`, headers: { host: HOST, cookie: `sb_token=${r.token}`, 'content-type': 'application/json' }, payload: JSON.stringify({ estimateMinutes: 5 }) });
    expect([developer.statusCode, developer.json().error, developer.json().message]).toEqual([409, 'started', "the item's title, description and estimate change only before the item starts (PROJ-1 is running)"]);

    await r.plans.markItemDone(plan.id, first);
    expect((await itemOf(r, plan.id, first)).storedState).toBe('done');
    const doneHold = await planUpdateItem(api, { plan_id: plan.id, item: 'PROJ-1', hold: true });
    expect(doneHold.isError).toBe(true);
    expect(text(doneHold)).toContain('is merged already');
    const doneTitle = await planUpdateItem(api, { plan_id: plan.id, item: 'PROJ-1', estimate_minutes: 10 });
    expect(text(doneTitle)).toContain('PROJ-1 is done');
  });

  it('asks for something to change and names an unknown item', async () => {
    const r = await setup();
    const { plan } = await twoItems(r);
    const api = helperApi(r, r.sourceId);
    expect(text(await planUpdateItem(api, { plan_id: plan.id, item: 'PROJ-1' }))).toContain('Give what changes');
    const unknown = await planUpdateItem(api, { plan_id: plan.id, item: 'PROJ-9', hold: true });
    expect([unknown.isError, text(unknown)]).toEqual([true, 'no item PROJ-9 in the plan']);
  });
});

describe('D129 · plan_remove_item and plan_remove_dependency', () => {
  it('removes a pending item (its edges go, its todo stays); refuses a started one', async () => {
    const r = await setup();
    const { plan, first, second } = await twoItems(r);
    const api = helperApi(r, r.sourceId);
    const todoId = (await itemOf(r, plan.id, second)).todoId;
    const removed = await planRemoveItem(api, { plan_id: plan.id, item: 'PROJ-2' });
    expect(removed.isError, text(removed)).toBeFalsy();
    expect(text(removed)).toContain("its todo stays in this session's list");
    const after = await r.plans.get(plan.id);
    expect(after.items.map((item) => item.key)).toEqual(['PROJ-1']);
    expect(after.edges).toEqual([]);
    expect((await r.store.todos.get(todoId))?.sessionId).toBe(r.sourceId);

    await r.plans.startPlan(plan.id, { mergeMode: 'developer' });
    await settle(r);
    const refused = await planRemoveItem(api, { plan_id: plan.id, item: first });
    expect([refused.isError, text(refused)]).toEqual([true, 'the item is running: only an item that has not started can be removed']);
    expect((await r.plans.get(plan.id)).items).toHaveLength(1);
  });

  it('removes a dependency (from goes first, to waits); a missing one is refused', async () => {
    const r = await setup();
    const { plan, second } = await twoItems(r);
    const api = helperApi(r, r.sourceId);
    expect((await itemOf(r, plan.id, second)).dependsOn).toHaveLength(1);
    const removed = await planRemoveDependency(api, { plan_id: plan.id, from: 'PROJ-1', to: 'PROJ-2' });
    expect(removed.isError, text(removed)).toBeFalsy();
    expect(text(removed)).toContain('PROJ-2 no longer waits for PROJ-1');
    expect((await itemOf(r, plan.id, second)).dependsOn).toEqual([]);
    const again = await planRemoveDependency(api, { plan_id: plan.id, from: 'PROJ-1', to: 'PROJ-2' });
    expect([again.isError, text(again)]).toEqual([true, 'no such dependency']);
    // plan_add_dependency puts it back (item after after = to after from).
    expect((await planAddDependency(api, { plan_id: plan.id, item: 'PROJ-2', after: 'PROJ-1' })).isError).toBeFalsy();
    expect((await itemOf(r, plan.id, second)).dependsOn).toHaveLength(1);
  });
});

describe('D129 · plan_set_mode', () => {
  it('changes a running plan\'s mode and tells running items; refuses an agent mode on a protected target without the acknowledgement; keeps the merge step', async () => {
    const r = await setup();
    const { plan, first } = await twoItems(r, 'main');
    await r.plans.startPlan(plan.id, { mergeMode: 'developer' });
    await settle(r);
    const running = await itemOf(r, plan.id, first);
    const api = helperApi(r, r.sourceId);
    const refused = await planSetMode(api, { plan_id: plan.id, merge_mode: 'agents' });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('allowProtectedTarget: true');
    expect((await r.plans.get(plan.id)).mergeMode).toBe('developer');
    expect(r.sent).toEqual([]);
    const noStep = await planSetMode(api, { plan_id: plan.id, merge_mode: 'none' });
    expect([noStep.isError, text(noStep)]).toEqual([true, 'the plan started with a merge step: it keeps one (choose agents, agents-with-holds or developer)']);
    const changed = await planSetMode(api, { plan_id: plan.id, merge_mode: 'agents', allow_protected_target: true });
    expect(changed.isError, text(changed)).toBeFalsy();
    expect(text(changed)).toContain('The merge mode is agents.');
    expect(await r.plans.get(plan.id)).toMatchObject({ mergeMode: 'agents', allowProtectedTarget: true });
    expect(r.sent).toEqual([{ sessionId: running.runSessionId, text: expect.stringContaining('merge the pull request into main yourself') }]);
    // No mode: the tool asks for the developer's choice and calls nothing.
    expect(text(await planSetMode(api, { plan_id: plan.id }))).toContain("merge_mode is the developer's choice");
  });
});

describe('D129 · scope', () => {
  it("another session's agent is refused (not its plan); nothing changes", async () => {
    const r = await setup();
    const { plan, first } = await twoItems(r);
    const api = helperApi(r, r.otherId);
    const notFound = `no plan ${plan.id} in this session`;
    for (const result of [
      await planUpdateItem(api, { plan_id: plan.id, item: 'PROJ-1', hold: true }),
      await planRemoveItem(api, { plan_id: plan.id, item: 'PROJ-1' }),
      await planRemoveDependency(api, { plan_id: plan.id, from: 'PROJ-1', to: 'PROJ-2' }),
      await planSetMode(api, { plan_id: plan.id, merge_mode: 'developer' }),
    ]) {
      expect([result.isError, text(result)]).toEqual([true, notFound]);
    }
    const after = await r.plans.get(plan.id);
    expect([after.items.length, after.edges.length, after.mergeMode, (await itemOf(r, plan.id, first)).hold]).toEqual([2, 1, null, false]);
  });

  it('D132: always on: a stored 1.x Plans switch set to off changes nothing, the routes answer and the tools register', async () => {
    const r = await setup();
    const { plan } = await twoItems(r);
    await r.store.settings.set('experimental.plans', false);
    const api = helperApi(r, r.sourceId);
    expect(await registerPlanToolsIfOn(createTodoServer(api), api)).toBe(true);
    const answer = await api('PUT', `/agent/v1/plans/${plan.id}/items/PROJ-1`, { hold: true });
    expect(answer.status).toBe(200);
    const tool = await planUpdateItem(api, { plan_id: plan.id, item: 'PROJ-1', hold: false });
    expect(tool.isError ?? false).toBe(false);
  });
});
