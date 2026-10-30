/**
 * D99 · the plan scheduler (unit, fake clock and fakes): a real store and TodoService, a
 * fake git / gh ({@link FakeGit}) and a fake environment that "starts" runs by storing a
 * session and its worktree, and (D102) a fake Merge step ({@link FakeMerger}). Session status
 * changes arrive on the bus as the real services publish them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { type Plan, type PlanChecks } from '../../../src/core/plans.ts';
import type { SessionStatus } from '../../../src/core/model.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import type { PlanGitPort, PlanRepoInput, PlanRepoState } from '../../../src/server/plans/git.ts';
import { type PlanEnvironment, PlanError, type PlanMergePort, type PlanRunInput, PlanService } from '../../../src/server/plans/service.ts';
import { BranchMergeError, type BranchMergeInput, type BranchMergePlan } from '../../../src/server/worktrees/branch-merge.ts';
import { plansFollowContinuation } from '../../../src/server/plans/hooks.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { FakeClock } from '../../helpers/clock.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

interface BranchState {
  hasWork?: boolean;
  merged?: boolean;
  pr?: { state: string; checks: PlanChecks; mergeable?: string | null; url?: string } | null;
  ghAvailable?: boolean;
  conflict?: boolean;
}

/** Git / gh as the test says, per item branch. */
class FakeGit implements PlanGitPort {
  readonly branches = new Map<string, BranchState>();
  defaultBranches: string[] = ['main'];
  protectedBranches: string[] = [];
  readonly inspected: Array<{ branch: string; conflicts: boolean }> = [];

  async prepareTarget(_repoPath: string, target: string): Promise<{ ok: true; ref: string; created: boolean }> {
    return { ok: true, ref: target, created: false };
  }

  async targetFacts(): Promise<{ defaultBranches: string[]; protectedBranches: string[] }> {
    return { defaultBranches: this.defaultBranches, protectedBranches: this.protectedBranches };
  }

  async tip(): Promise<string> {
    return 'cafe000';
  }

  async inspect(input: PlanRepoInput, options: { conflicts?: boolean } = {}): Promise<PlanRepoState> {
    this.inspected.push({ branch: input.branch, conflicts: options.conflicts === true });
    const state = this.branches.get(input.branch) ?? {};
    const pr = state.pr ? { url: state.pr.url ?? `https://example.test/pr/${input.branch}`, state: state.pr.state, baseRefName: input.target, checks: state.pr.checks, mergeable: state.pr.mergeable ?? null } : null;
    return { repo: input.repo, hasWork: state.hasWork ?? state.merged ?? false, merged: state.merged ?? false, pr, ghAvailable: state.ghAvailable ?? true, conflict: options.conflicts === true && state.conflict === true };
  }
}

/** D102: the Merge step's git as the test says: a branch listed in `conflicts` is refused with its files; a merge marks it merged. */
class FakeMerger implements PlanMergePort {
  readonly conflicts = new Map<string, string[]>();
  readonly merged: string[] = [];
  readonly prs: string[] = [];
  readonly git: FakeGit;
  constructor(git: FakeGit) {
    this.git = git;
  }

  async check(input: BranchMergeInput): Promise<BranchMergePlan> {
    const files = this.conflicts.get(input.branch);
    if (files) throw new BranchMergeError('conflicts', `${input.repo}: ${input.branch} conflicts with ${input.target}`, files);
    return { input, head: 'beef', targetTip: 'cafe', targetLocal: true, checkedOutAt: null, kind: 'fast-forward', tree: null };
  }

  async merge(plan: BranchMergePlan): Promise<string> {
    this.merged.push(`${plan.input.branch} → ${plan.input.target}`);
    this.git.branches.set(plan.input.branch, { ...(this.git.branches.get(plan.input.branch) ?? {}), hasWork: true, merged: true });
    return `${plan.input.repo}: merged`;
  }

  async openPullRequest(input: BranchMergeInput): Promise<string> {
    this.prs.push(input.branch);
    return `https://example.test/pr/${input.branch}`;
  }
}

interface Rig {
  readonly dir: string;
  readonly store: Store;
  readonly bus: HubBus;
  readonly clock: FakeClock;
  readonly git: FakeGit;
  readonly merger: FakeMerger;
  readonly todos: TodoService;
  readonly runs: PlanRunInput[];
  readonly sent: Array<{ sessionId: string; text: string }>;
  readonly notices: Array<{ kind: string; title: string }>;
  /** D102: the Inbox's "Ready to merge" items raised (`+ title`) and closed (`- itemId outcome`). */
  readonly mergeNotices: string[];
  /** D120: the Inbox's "Stopped" items raised (`+ title | detail`) and closed (`- itemId outcome`). */
  readonly stoppedNotices: string[];
  /** D149: the Inbox's "Done without merging" items raised (`+ title | url | dedupe`). */
  readonly unmergedNotices: string[];
  /** D145: the run sessions whose item was merged (their worktrees are cleaned up). */
  readonly merged: string[];
  readonly changed: string[];
  readonly errors: unknown[];
  held: string | null;
  failRun: string | null;
  plans: PlanService;
  sourceId: string;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.plans.close();
  await rig?.store.close();
  if (rig) await removeTempDir(rig.dir);
  rig = undefined;
});

function environment(r: Omit<Rig, 'plans'>): PlanEnvironment {
  return {
    async repos(sourceSessionId, names) {
      if (!(await r.store.sessions.get(sourceSessionId))) throw new PlanError(404, 'not-found', 'no session');
      const all = ['acme-front', 'acme-api'];
      const wanted = names ?? ['acme-front'];
      for (const name of wanted) if (!all.includes(name)) throw new PlanError(422, 'invalid', `${name} is not a solution`, 'repos');
      return { kind: 'workspace', repos: wanted.map((name) => ({ name, repoPath: `/repos/${name}` })) };
    },
    async run(input) {
      r.runs.push(input);
      if (r.failRun !== null) return { ok: false, message: r.failRun };
      const session = await r.store.sessions.create({ name: `run-${r.runs.length}`, claudeSessionId: `c-${r.runs.length}`, status: 'run', cwd: '/ws', root: '/ws', rootKind: 'workspace', solutions: Object.keys(input.from ?? {}), worktrees: true });
      for (const [repo] of Object.entries(input.from ?? {})) await r.store.worktrees.create({ repo, repoPath: `/repos/${repo}`, branch: input.branch, path: `/wt/${input.branch}/${repo}`, sessionId: session.id });
      return { ok: true, sessionId: session.id, branch: input.branch };
    },
    async usageHeld() {
      return r.held;
    },
    async send(sessionId, text) {
      r.sent.push({ sessionId, text });
    },
    async notice(input) {
      r.notices.push({ kind: input.kind, title: input.title });
    },
    async mergeNotice(input) {
      r.mergeNotices.push(`+ ${input.title}`);
    },
    async closeMergeNotice(itemId, outcome) {
      r.mergeNotices.push(`- ${itemId} ${outcome}`);
    },
    async itemMerged(sessionId) {
      r.merged.push(sessionId);
    },
    async stoppedNotice(input) {
      r.stoppedNotices.push(`+ ${input.title} | ${input.dedupe}`);
    },
    async closeStoppedNotices(itemId, outcome) {
      r.stoppedNotices.push(`- ${itemId} ${outcome}`);
    },
    async unmergedNotice(input) {
      r.unmergedNotices.push(`+ ${input.title} | ${input.url ?? ''} | ${input.dedupe}`);
    },
  };
}

async function setup(options: { pollMs?: number; stoppedGraceMs?: number } = {}): Promise<Rig> {
  const dir = await makeTempDir('plans');
  const clock = new FakeClock(new Date('2026-10-13T10:00:00Z'));
  const store = await openTempStore(dir, { now: () => clock.now() });
  const bus = new HubBus();
  const todos = new TodoService({ store, bus, now: () => clock.now().getTime() });
  const source = await store.sessions.create({ name: 'source', claudeSessionId: 'c-source', status: 'idle', cwd: '/ws', root: '/ws', rootKind: 'workspace', solutions: ['acme-front'], worktrees: false, workType: 'feature', mode: 'single', phase: 'ui-first' });
  const git = new FakeGit();
  const base = { dir, store, bus, clock, git, merger: new FakeMerger(git), todos, runs: [] as PlanRunInput[], sent: [], notices: [], mergeNotices: [] as string[], stoppedNotices: [] as string[], unmergedNotices: [] as string[], merged: [] as string[], changed: [] as string[], errors: [] as unknown[], held: null, failRun: null, sourceId: source.id };
  bus.subscribe((message) => {
    if (message.name === 'planChanged') base.changed.push(message.payload.planId);
  });
  const partial = base as unknown as Rig;
  partial.plans = new PlanService({ dataDir: dir, store, bus, todos, git: base.git, merger: base.merger, env: environment(partial), clock, pollMs: options.pollMs ?? 60_000, ...(options.stoppedGraceMs !== undefined ? { stoppedGraceMs: options.stoppedGraceMs } : {}), onError: (error) => base.errors.push(error) });
  await partial.plans.start();
  rig = partial;
  return partial;
}

async function settle(r: Rig): Promise<void> {
  await r.plans.idle();
  await r.plans.idle();
}

/** A draft plan with items A, B, C, D (keys PROJ-1…4) and A → B, A → C, B + C → D. */
async function diamond(r: Rig, options: { holdD?: boolean; maxConcurrency?: number } = {}): Promise<{ plan: Plan; ids: Record<'A' | 'B' | 'C' | 'D', string> }> {
  const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Acme epic', targetBranch: 'feature/PROJ-100-acme', ...(options.maxConcurrency ? { maxConcurrency: options.maxConcurrency } : {}) });
  const ids = {} as Record<'A' | 'B' | 'C' | 'D', string>;
  for (const [index, name] of (['A', 'B', 'C', 'D'] as const).entries()) {
    const added = await r.plans.addItem(plan.id, { key: `PROJ-${index + 1}`, todo: { title: `Item ${name}`, plan: `Do ${name}. Acceptance: ${name} works.`, estimateMinutes: 30 }, hold: name === 'D' && options.holdD === true });
    ids[name] = added.itemId;
  }
  await r.plans.addEdge(plan.id, { from: 'PROJ-1', to: 'PROJ-2' });
  await r.plans.addEdge(plan.id, { from: 'PROJ-1', to: 'PROJ-3' });
  await r.plans.addEdge(plan.id, { from: ids.B, to: ids.D });
  await r.plans.addEdge(plan.id, { from: ids.C, to: ids.D });
  return { plan: await r.plans.get(plan.id), ids };
}

async function item(r: Rig, planId: string, itemId: string) {
  const plan = await r.plans.get(planId);
  const found = plan.items.find((candidate) => candidate.id === itemId);
  if (!found) throw new Error('no item');
  return found;
}

/** Publishes a session status change as the supervisor does. */
async function status(r: Rig, sessionId: string, next: SessionStatus): Promise<void> {
  await r.store.sessions.update(sessionId, { status: next });
  r.bus.publish('sessionUpdated', { ...(await r.store.sessions.get(sessionId)), id: sessionId, status: next } as unknown as Session);
  await settle(r);
}

/** The agent merged the item's work and its turn ended. */
async function agentMerges(r: Rig, planId: string, itemId: string, state: BranchState = {}): Promise<void> {
  const current = await item(r, planId, itemId);
  r.git.branches.set(current.branch as string, { hasWork: true, merged: true, pr: { state: 'MERGED', checks: { state: 'green', summary: null, sha: 'abc' } }, ...state });
  await status(r, current.runSessionId as string, 'idle');
}

/** D102: the item's agent marks its todo done (the brief's last step) and its turn ends with work on its branch. */
async function agentFinishes(r: Rig, planId: string, itemId: string, state: BranchState = { hasWork: true }): Promise<void> {
  const current = await item(r, planId, itemId);
  r.git.branches.set(current.branch as string, state);
  await r.todos.update(r.sourceId, current.todoId, { state: 'done' }, 'agent');
  await status(r, current.runSessionId as string, 'idle');
}

function started(r: Rig): string[] {
  return r.runs.map((run) => run.item.key ?? run.item.title);
}

describe('D99 · plan scheduler', () => {
  it('runs A, then B ∥ C, then D (agents mode); the plan ends done with "Plan ready"', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r);
    expect(plan.items.map((entry) => entry.state)).toEqual(['ready', 'waiting', 'waiting', 'waiting']);
    expect(plan.items[3]?.reason).toBe('waiting on PROJ-2, PROJ-3');
    expect(plan.criticalPath).toEqual({ itemIds: [ids.A, ids.B, ids.D], minutes: 90 });
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    expect(started(r)).toEqual(['PROJ-1']);
    // The brief: title, description / plan, the PR into the target, the merge rule, the finish line; the branch is KEY-slug, cut from the target.
    const brief = r.runs[0]?.task('PROJ-1-item-a') ?? '';
    expect(r.runs[0]).toMatchObject({ branch: 'PROJ-1-item-a', from: { 'acme-front': 'feature/PROJ-100-acme' }, answers: { workType: 'feature', mode: 'single', phase: 'ui-first' } });
    for (const words of ['Work on todo [', 'Item A', 'Acceptance: A works.', 'gh pr create --base feature/PROJ-100-acme', 'merge the pull request into feature/PROJ-100-acme yourself', 'todo_done']) expect(brief).toContain(words);
    expect((await item(r, plan.id, ids.A)).state).toBe('running');

    await agentMerges(r, plan.id, ids.A);
    expect(started(r)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
    expect((await item(r, plan.id, ids.A)).state).toBe('done');
    expect((await r.store.todos.get((await item(r, plan.id, ids.A)).todoId))?.state).toBe('done');
    expect((await item(r, plan.id, ids.D)).state).toBe('waiting');

    await agentMerges(r, plan.id, ids.B);
    expect(started(r)).toHaveLength(3);
    await agentMerges(r, plan.id, ids.C);
    expect(started(r)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4']);
    await agentMerges(r, plan.id, ids.D);
    const done = await r.plans.get(plan.id);
    expect(done.state).toBe('done');
    expect(done.progress).toEqual({ done: 4, total: 4, percent: 100 });
    expect(r.notices).toEqual([{ kind: 'plan-ready', title: 'Plan ready: feature/PROJ-100-acme → dev' }]);
    expect(r.errors).toEqual([]);
  });

  it('agents-with-holds: a held item waits for the developer’s Merge (ready-to-merge, an Inbox item); Merge merges it and the plan ends', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r, { holdD: true });
    await r.plans.startPlan(plan.id, { mergeMode: 'agents-with-holds' });
    await settle(r);
    for (const key of ['A', 'B', 'C'] as const) await agentMerges(r, plan.id, ids[key]);
    expect(r.runs[3]?.task('PROJ-4-item-d')).toContain('Do not merge it yourself');
    expect(r.mergeNotices).toEqual([]);
    await agentFinishes(r, plan.id, ids.D);
    const d = await item(r, plan.id, ids.D);
    expect(d).toMatchObject({ state: 'ready-to-merge', waitingOn: 'merge', developerMerges: true, reason: 'waiting for your merge' });
    // The todo went straight to done (no review state any more).
    expect((await r.store.todos.get(d.todoId))?.state).toBe('done');
    expect(r.mergeNotices).toEqual(['+ Ready to merge: Item D (Acme epic)']);
    expect((await r.plans.get(plan.id)).state).toBe('running');
    // The developer's Merge.
    const answer = await r.plans.mergeItem(plan.id, ids.D);
    expect(answer.items.find((entry) => entry.id === ids.D)).toMatchObject({ state: 'done', note: 'merged by you into feature/PROJ-100-acme' });
    expect(r.merger.merged).toEqual(['PROJ-4-item-d → feature/PROJ-100-acme']);
    expect(r.mergeNotices.at(-1)).toBe(`- ${ids.D} merged`);
    await settle(r);
    expect((await r.plans.get(plan.id)).state).toBe('done');
    expect(r.errors).toEqual([]);
  });

  it('developer mode: Merge starts the dependents; a conflict is refused with the files; Send back sends the comment and the item runs again; the agent merging itself counts', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r);
    await r.plans.startPlan(plan.id, { mergeMode: 'developer' });
    await settle(r);
    // Not ready while its run has not finished: Merge is refused.
    await expect(r.plans.mergeItem(plan.id, ids.A)).rejects.toMatchObject({ status: 409, code: 'not-ready' });
    await agentFinishes(r, plan.id, ids.A);
    expect((await item(r, plan.id, ids.A)).state).toBe('ready-to-merge');
    await r.plans.mergeItem(plan.id, ids.A);
    await settle(r);
    expect(started(r)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
    // D145: the merged item's run session gets the automatic clean-up of its worktrees.
    expect(r.merged).toEqual([(await item(r, plan.id, ids.A)).runSessionId]);

    // B conflicts with the target: refused with the files, still ready to merge.
    await agentFinishes(r, plan.id, ids.B);
    const b = await item(r, plan.id, ids.B);
    r.merger.conflicts.set(b.branch as string, ['src/app.ts', 'README.md']);
    const refused = await r.plans.mergeItem(plan.id, ids.B).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PlanError);
    expect((refused as PlanError).body()).toEqual({ error: 'conflicts', message: 'acme-front: PROJ-2-item-b conflicts with feature/PROJ-100-acme', conflicts: ['src/app.ts', 'README.md'] });
    expect((await item(r, plan.id, ids.B)).state).toBe('ready-to-merge');

    // Send back: the comment goes to its session, its todo is in progress again, the Inbox item closes.
    await expect(r.plans.sendBackItem(plan.id, ids.B, { comment: '' })).rejects.toMatchObject({ status: 422 });
    const back = await r.plans.sendBackItem(plan.id, ids.B, { comment: 'Rebase onto the target first.' });
    expect(back.items.find((entry) => entry.id === ids.B)).toMatchObject({ state: 'running', waitingOn: null });
    expect(r.sent.at(-1)).toEqual({ sessionId: b.runSessionId, text: 'Plans: your work on "Item B" was sent back with this comment:\n\nRebase onto the target first.' });
    expect((await r.store.todos.get(b.todoId))?.state).toBe('in_progress');
    expect(r.mergeNotices).toContain(`- ${ids.B} sent-back`);
    // Its next finish makes it ready again (a new Inbox item).
    r.merger.conflicts.delete(b.branch as string);
    await status(r, b.runSessionId as string, 'run');
    await agentFinishes(r, plan.id, ids.B);
    expect((await item(r, plan.id, ids.B)).state).toBe('ready-to-merge');
    expect(r.mergeNotices.filter((line) => line === '+ Ready to merge: Item B (Acme epic)')).toHaveLength(2);
    await r.plans.mergeItem(plan.id, ids.B);

    // C: its agent merged it into the target itself (against the rule): detected, done with a note.
    await agentMerges(r, plan.id, ids.C);
    expect(await item(r, plan.id, ids.C)).toMatchObject({ state: 'done', note: 'merged into feature/PROJ-100-acme without your Merge' });
    await settle(r);
    expect(started(r)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4']);
    expect(r.errors).toEqual([]);
  });

  it('developer mode: a run closed without work blocks its dependents with a reason; Retry runs it again', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r);
    await r.plans.startPlan(plan.id, { mergeMode: 'developer' });
    await settle(r);
    await agentFinishes(r, plan.id, ids.A);
    await r.plans.mergeItem(plan.id, ids.A);
    await settle(r);
    const b = await item(r, plan.id, ids.B);
    await r.store.sessions.update(b.runSessionId as string, { closedAt: '2026-10-13T10:05:00Z' });
    await status(r, b.runSessionId as string, 'done');
    expect(await item(r, plan.id, ids.B)).toMatchObject({ state: 'blocked', reason: 'was closed without any work to merge' });
    expect(await item(r, plan.id, ids.D)).toMatchObject({ state: 'blocked', reason: 'waiting on PROJ-2, which was closed without any work to merge' });
    expect((await r.plans.get(plan.id)).estimatedMinutesLeft).toBeNull();
    await r.plans.retryItem(plan.id, ids.B);
    await settle(r);
    expect(started(r)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-2']);
  });

  it('keeps to the concurrency limit', async () => {
    const r = await setup();
    const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Wide', targetBranch: 'feature/PROJ-200-wide', maxConcurrency: 2 });
    for (const n of [1, 2, 3, 4]) await r.plans.addItem(plan.id, { todo: { title: `Task ${n}` } });
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    expect(r.runs).toHaveLength(2);
    const view = await r.plans.get(plan.id);
    expect(view.items.map((entry) => entry.state)).toEqual(['running', 'running', 'ready', 'ready']);
    await agentMerges(r, plan.id, view.items[0]?.id as string);
    expect(r.runs).toHaveLength(3);
    // Raising the limit starts the next one at once.
    await r.plans.update(plan.id, { maxConcurrency: 3 });
    await settle(r);
    expect(r.runs).toHaveLength(4);
    expect(r.runs.map((run) => run.branch)).toEqual(['todo/task-1', 'todo/task-2', 'todo/task-3', 'todo/task-4']);
  });

  it('holds new starts while the account is above the usage threshold; running items go on; a usage update releases it', async () => {
    const r = await setup();
    const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Busy', targetBranch: 'feature/PROJ-300-busy' });
    for (const n of [1, 2]) await r.plans.addItem(plan.id, { todo: { title: `Job ${n}` } });
    r.held = 'the account Default is at 91% of its 5-hour limit (the plan starts items below 85%)';
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    expect(r.runs).toHaveLength(0);
    expect((await r.plans.get(plan.id)).held).toBe(r.held);
    r.held = null;
    r.bus.publish('system', {} as never);
    await settle(r);
    expect(r.runs).toHaveLength(2);
    expect((await r.plans.get(plan.id)).held).toBeNull();
  });

  it('red checks: the session is told once, the item stays running and its dependents wait; green → done', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r);
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    const a = await item(r, plan.id, ids.A);
    r.git.branches.set(a.branch as string, { hasWork: true, merged: false, pr: { state: 'OPEN', checks: { state: 'red', summary: 'failed: unit-tests, lint', sha: 'aaa' } } });
    await status(r, a.runSessionId as string, 'idle');
    expect(r.sent).toEqual([{ sessionId: a.runSessionId, text: expect.stringContaining('failed: unit-tests, lint') }]);
    expect(await item(r, plan.id, ids.A)).toMatchObject({ state: 'running', waitingOn: 'checks', note: 'checks failed: unit-tests, lint' });
    expect(started(r)).toEqual(['PROJ-1']);
    // The same failure polled again: not repeated.
    r.plans.pollChecks();
    await settle(r);
    expect(r.sent).toHaveLength(1);
    // The agent merged anyway with red checks: still not done.
    r.git.branches.set(a.branch as string, { hasWork: true, merged: true, pr: { state: 'MERGED', checks: { state: 'red', summary: 'failed: unit-tests, lint', sha: 'aaa' } } });
    await r.clock.advanceTo(new Date('2026-10-13T10:01:01Z'), () => settle(r));
    expect((await item(r, plan.id, ids.A)).storedState).toBe('running');
    expect(started(r)).toEqual(['PROJ-1']);
    // Fixed: green.
    r.git.branches.set(a.branch as string, { hasWork: true, merged: true, pr: { state: 'MERGED', checks: { state: 'green', summary: null, sha: 'bbb' } } });
    await r.clock.advanceTo(new Date('2026-10-13T10:02:02Z'), () => settle(r));
    expect((await item(r, plan.id, ids.A)).state).toBe('done');
    expect(started(r)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
  });

  it('no remote / no gh: merged into the target counts, with a note', async () => {
    const r = await setup();
    const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Local', targetBranch: 'feature/PROJ-400-local' });
    const { itemId } = await r.plans.addItem(plan.id, { todo: { title: 'Local work' } });
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    await agentMerges(r, plan.id, itemId, { pr: null, ghAvailable: false });
    expect(await item(r, plan.id, itemId)).toMatchObject({ state: 'done', note: 'no remote or gh: counted as merged into feature/PROJ-400-local without reading checks' });
  });

  it('a conflict: the agent is asked to rebase; a second one becomes an Inbox item', async () => {
    const r = await setup();
    const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Clash', targetBranch: 'feature/PROJ-500-clash' });
    const { itemId } = await r.plans.addItem(plan.id, { key: 'PROJ-501', todo: { title: 'Clashing work' } });
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    const running = await item(r, plan.id, itemId);
    r.git.branches.set(running.branch as string, { hasWork: true, merged: false, conflict: true });
    await status(r, running.runSessionId as string, 'idle');
    expect(r.sent.map((entry) => entry.text)).toEqual([expect.stringContaining('Rebase onto feature/PROJ-500-clash')]);
    expect(await item(r, plan.id, itemId)).toMatchObject({ state: 'running', waitingOn: 'conflict' });
    expect(r.notices).toEqual([]);
    // Its next turn ends still conflicting.
    await status(r, running.runSessionId as string, 'run');
    await status(r, running.runSessionId as string, 'idle');
    expect(r.notices).toEqual([{ kind: 'plan-conflict', title: 'Plan "Clash": PROJ-501 conflicts with feature/PROJ-500-clash again' }]);
    expect(await item(r, plan.id, itemId)).toMatchObject({ state: 'blocked' });
    expect(r.sent).toHaveLength(1);
  });

  it('a question stops only that item; the others go on', async () => {
    const r = await setup();
    const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Asks', targetBranch: 'feature/PROJ-600-asks' });
    const first = await r.plans.addItem(plan.id, { todo: { title: 'Asker' } });
    const second = await r.plans.addItem(plan.id, { todo: { title: 'Worker' } });
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    const asker = await item(r, plan.id, first.itemId);
    await status(r, asker.runSessionId as string, 'need');
    expect(await item(r, plan.id, first.itemId)).toMatchObject({ state: 'question', waitingOn: 'question' });
    await agentMerges(r, plan.id, second.itemId);
    expect(await item(r, plan.id, second.itemId)).toMatchObject({ state: 'done' });
    expect(await item(r, plan.id, first.itemId)).toMatchObject({ state: 'question' });
  });

  it('refuses a cycle, a start without the merge mode, and an agent mode into master / the default branch; developer mode may target them', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r);
    await expect(r.plans.addEdge(plan.id, { from: ids.D, to: ids.A })).rejects.toMatchObject({ status: 409, code: 'cycle', message: 'that dependency would make a cycle: PROJ-4 → PROJ-1 → PROJ-2 → PROJ-4 (each waits for the next)' });
    await expect(r.plans.addEdge(plan.id, { from: ids.A, to: ids.A })).rejects.toMatchObject({ code: 'cycle' });
    await expect(r.plans.startPlan(plan.id, {})).rejects.toMatchObject({ status: 422, code: 'merge-mode-required' });
    await expect(r.plans.startPlan(plan.id, { mergeMode: 'yolo' })).rejects.toMatchObject({ status: 422, code: 'invalid' });

    const master = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Into master', targetBranch: 'master' });
    await r.plans.addItem(master.id, { todo: { title: 'x' } });
    for (const mode of ['agents', 'agents-with-holds']) await expect(r.plans.startPlan(master.id, { mergeMode: mode })).rejects.toMatchObject({ status: 422, code: 'target-forbidden' });
    const defaulted = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Into default', targetBranch: 'trunk' });
    await r.plans.addItem(defaulted.id, { todo: { title: 'y' } });
    r.git.defaultBranches = ['trunk'];
    await expect(r.plans.startPlan(defaulted.id, { mergeMode: 'agents' })).rejects.toMatchObject({ code: 'target-forbidden', message: expect.stringContaining("trunk is the repository's default branch") });
    r.git.defaultBranches = [];
    r.git.protectedBranches = ['trunk'];
    await expect(r.plans.startPlan(defaulted.id, { mergeMode: 'agents' })).rejects.toMatchObject({ code: 'target-forbidden', message: expect.stringContaining('protected') });
    expect((await r.plans.startPlan(master.id, { mergeMode: 'developer' })).state).toBe('running');
    // …and switching that plan to an agent mode is refused too.
    await expect(r.plans.setMode(master.id, { mergeMode: 'agents' })).rejects.toMatchObject({ code: 'target-forbidden' });
  });

  it('a mode change while running applies to items not merged yet and tells their sessions', async () => {
    const r = await setup();
    const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Switch', targetBranch: 'feature/PROJ-700-switch' });
    const { itemId } = await r.plans.addItem(plan.id, { todo: { title: 'Switch me' } });
    await r.plans.startPlan(plan.id, { mergeMode: 'developer' });
    await settle(r);
    const running = await item(r, plan.id, itemId);
    await r.plans.setMode(plan.id, { mergeMode: 'agents' });
    expect(r.sent).toEqual([{ sessionId: running.runSessionId, text: expect.stringContaining('merge the pull request into feature/PROJ-700-switch yourself') }]);
    await r.plans.setHolds(plan.id, { holds: { [itemId]: true } });
    // agents (no holds mode): a hold changes nothing; agents-with-holds: it does.
    expect(r.sent).toHaveLength(1);
    await r.plans.setMode(plan.id, { mergeMode: 'agents-with-holds' });
    expect(r.sent.at(-1)?.text).toContain('Do not merge it yourself');
  });

  it('pause stops new starts; resume goes on; restart resumes a running plan', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r);
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    await r.plans.pause(plan.id);
    await agentMerges(r, plan.id, ids.A);
    expect((await item(r, plan.id, ids.A)).state).toBe('done');
    expect(started(r)).toEqual(['PROJ-1']);
    expect((await r.plans.get(plan.id)).held).toBe('the plan is paused');
    await r.plans.resume(plan.id);
    await settle(r);
    expect(started(r)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);

    // A restart: a new service over the same store; B was merged while it was down.
    const b = await item(r, plan.id, ids.B);
    await r.plans.close();
    r.git.branches.set(b.branch as string, { hasWork: true, merged: true, pr: { state: 'MERGED', checks: { state: 'none', summary: null, sha: null } } });
    r.plans = new PlanService({ dataDir: r.dir, store: r.store, bus: r.bus, todos: r.todos, git: r.git, env: environment(r), clock: r.clock, onError: (error) => r.errors.push(error) });
    await r.plans.start();
    await settle(r);
    expect((await item(r, plan.id, ids.B)).state).toBe('done');
    await agentMerges(r, plan.id, ids.C);
    expect(started(r)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4']);
  });

  it('createFromExternal (the Jira seam): todos, items and edges in one go; a cycle is refused before anything is written', async () => {
    const r = await setup();
    await expect(
      r.plans.createFromExternal({ sourceSessionId: r.sourceId, title: 'PROJ-900', targetBranch: 'feature/PROJ-900-x', external: { system: 'jira', key: 'PROJ-900' }, items: [{ ref: 'PROJ-901', key: 'PROJ-901', title: 'a' }, { ref: 'PROJ-902', key: 'PROJ-902', title: 'b' }], edges: [{ from: 'PROJ-901', to: 'PROJ-902' }, { from: 'PROJ-902', to: 'PROJ-901' }] }),
    ).rejects.toMatchObject({ code: 'cycle' });
    expect(await r.plans.list()).toEqual([]);
    const made = await r.plans.createFromExternal({
      sourceSessionId: r.sourceId,
      title: 'PROJ-900 Acme import',
      targetBranch: 'feature/PROJ-900-acme',
      external: { system: 'jira', key: 'PROJ-900' },
      items: [
        { ref: 'PROJ-901', key: 'PROJ-901', title: 'First', plan: 'AC: first', estimateMinutes: 20 },
        { ref: 'PROJ-902', key: 'proj-902', title: 'Second', hold: true },
      ],
      edges: [{ from: 'PROJ-901', to: 'PROJ-902' }],
    });
    expect(made.plan).toMatchObject({ state: 'draft', external: { system: 'jira', key: 'PROJ-900' }, mergeMode: null });
    expect(made.plan.items.map((entry) => [entry.key, entry.state, entry.hold])).toEqual([
      ['PROJ-901', 'ready', false],
      ['PROJ-902', 'waiting', true],
    ]);
    expect(made.plan.edges).toEqual([{ from: made.itemIds['PROJ-901'], to: made.itemIds['PROJ-902'] }]);
    expect((await r.plans.findByExternal('jira', 'PROJ-900')).map((plan) => plan.id)).toEqual([made.plan.id]);
    expect((await r.todos.list(r.sourceId)).todos.map((todo) => todo.title)).toEqual(['First', 'Second']);
  });

  it('a run that cannot start fails the item with the reason', async () => {
    const r = await setup();
    const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Broken', targetBranch: 'feature/PROJ-800-broken' });
    const first = await r.plans.addItem(plan.id, { key: 'PROJ-801', todo: { title: 'Cannot start' } });
    const second = await r.plans.addItem(plan.id, { todo: { title: 'After it' }, after: ['PROJ-801'] });
    r.failRun = 'the CLI is not available';
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    expect(await item(r, plan.id, first.itemId)).toMatchObject({ state: 'blocked', reason: 'could not start: the CLI is not available' });
    expect(await item(r, plan.id, second.itemId)).toMatchObject({ state: 'blocked', reason: 'waiting on PROJ-801, which could not start: the CLI is not available' });
  });
  it('D132: always on: no switch, a stored 1.x switch set to off changes nothing, plans run and the routes answer', async () => {
    const r = await setup();
    expect(r.plans.state()).toEqual({ enabled: true, available: true, problem: null });
    const { plan } = await diamond(r);
    await r.plans.close();
    // A 1.x install with the switch off: the row is ignored (the app deletes it at start; D132).
    await r.store.settings.set('experimental.plans', false);
    r.plans = new PlanService({ dataDir: r.dir, store: r.store, bus: r.bus, todos: r.todos, git: r.git, merger: r.merger, env: environment(r), clock: r.clock, onError: (error) => r.errors.push(error) });
    await r.plans.start();
    expect(r.plans.state()).toEqual({ enabled: true, available: true, problem: null });
    expect((await r.plans.list()).map((p) => p.id)).toEqual([plan.id]);
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    expect(started(r)).toEqual(['PROJ-1']);
    expect(r.errors).toEqual([]);
  });

  it('a plan whose source session is deleted goes with it', async () => {
    const r = await setup();
    const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Orphan', targetBranch: 'feature/PROJ-300-orphan' });
    await r.store.sessions.delete(r.sourceId);
    r.plans.kick();
    await settle(r);
    expect(await r.plans.list()).toEqual([]);
    expect(r.changed).toContain(plan.id);
  });
  it('continued in a fresh session while Plans was not running: at the next start the plan follows the session links and its items still start', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r);
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    await r.plans.close();
    // D83 as the fresh-session flow does it: the todos move (ids kept), the old session names the fresh one; the hook is a no-op while Plans is closed.
    const fresh = await r.store.sessions.create({ name: 'source-2', claudeSessionId: 'c-source-2', status: 'idle', cwd: '/ws', root: '/ws', rootKind: 'workspace', solutions: ['acme-front'], worktrees: false, workType: 'feature', mode: 'single', phase: 'ui-first', continuedFrom: r.sourceId });
    await r.todos.moveAll(r.sourceId, fresh.id);
    await r.store.sessions.update(r.sourceId, { continuedTo: fresh.id });
    await plansFollowContinuation(r.store, r.sourceId, fresh.id);
    r.plans = new PlanService({ dataDir: r.dir, store: r.store, bus: r.bus, todos: r.todos, git: r.git, merger: r.merger, env: environment(r), clock: r.clock, onError: (error) => r.errors.push(error) });
    await r.plans.start();
    await settle(r);
    expect(await r.plans.get(plan.id)).toMatchObject({ sourceSessionId: fresh.id, state: 'running' });
    await agentMerges(r, plan.id, ids.A);
    expect(started(r)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
    expect(r.runs[1]?.plan.sourceSessionId).toBe(fresh.id);
    expect((await item(r, plan.id, ids.B)).state).toBe('running');
    expect(r.errors).toEqual([]);
  });

  it('the hook while on: the plan and the items a continued run session ran follow at once', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r);
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    const runOfA = (await item(r, plan.id, ids.A)).runSessionId as string;
    const freshRun = await r.store.sessions.create({ name: 'run-1-2', claudeSessionId: 'c-run-2', status: 'idle', cwd: '/ws', root: '/ws', rootKind: 'workspace', solutions: ['acme-front'], worktrees: true, continuedFrom: runOfA });
    await plansFollowContinuation(r.store, runOfA, freshRun.id);
    expect((await item(r, plan.id, ids.A)).runSessionId).toBe(freshRun.id);
    const fresh = await r.store.sessions.create({ name: 'source-2', claudeSessionId: 'c-source-2', status: 'idle', cwd: '/ws', root: '/ws', rootKind: 'workspace', solutions: ['acme-front'], worktrees: false, continuedFrom: r.sourceId });
    await r.todos.moveAll(r.sourceId, fresh.id);
    await plansFollowContinuation(r.store, r.sourceId, fresh.id);
    expect((await r.plans.get(plan.id)).sourceSessionId).toBe(fresh.id);
    expect(r.changed).toContain(plan.id);
  });
  it('item spans (the Timeline): running → waiting-you (question) → running → waiting-you (ready to merge) → done; dependents wait; all closed when the plan ends', async () => {
    const r = await setup();
    const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: 'History', targetBranch: 'feature/PROJ-700-history' });
    const a = await r.plans.addItem(plan.id, { key: 'PROJ-701', todo: { title: 'First' } });
    const b = await r.plans.addItem(plan.id, { key: 'PROJ-702', todo: { title: 'Second' }, after: ['PROJ-701'] });
    expect((await item(r, plan.id, a.itemId)).spans).toEqual([]);
    await r.plans.startPlan(plan.id, { mergeMode: 'developer' });
    await settle(r);
    const at = (minutes: number): Promise<void> => r.clock.advanceTo(new Date(r.clock.now().getTime() + minutes * 60_000), () => settle(r));
    const kinds = async (itemId: string) => (await item(r, plan.id, itemId)).spans.map((span) => [span.kind, span.endedAt === null ? 'open' : 'closed']);
    expect(await kinds(a.itemId)).toEqual([['running', 'open']]);
    expect(await kinds(b.itemId)).toEqual([['waiting-dependency', 'open']]);
    const run = (await item(r, plan.id, a.itemId)).runSessionId as string;
    await at(5);
    await status(r, run, 'need');
    await at(10);
    await status(r, run, 'run');
    await at(5);
    await agentFinishes(r, plan.id, a.itemId);
    expect((await item(r, plan.id, a.itemId)).state).toBe('ready-to-merge');
    await at(30);
    await r.plans.mergeItem(plan.id, a.itemId);
    await settle(r);
    const spans = (await item(r, plan.id, a.itemId)).spans;
    expect(spans.map((span) => span.kind)).toEqual(['running', 'waiting-you', 'running', 'waiting-you']);
    expect(spans.every((span) => span.endedAt !== null)).toBe(true);
    expect(spans.map((span) => (Date.parse(span.endedAt as string) - Date.parse(span.startedAt)) / 60_000)).toEqual([5, 10, 5, 30]);
    expect(await kinds(b.itemId)).toEqual([['waiting-dependency', 'closed'], ['running', 'open']]);
    await r.plans.cancel(plan.id);
    expect(await kinds(b.itemId)).toEqual([['waiting-dependency', 'closed'], ['running', 'closed']]);
  });

  it('item spans: paused-usage while the usage threshold holds starts; paused-plan when paused; a restart keeps one open span per item', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r);
    r.held = 'the account Default is at 91% of its 5-hour limit (the plan starts items below 85%)';
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    const open = async (itemId: string) => (await item(r, plan.id, itemId)).spans.filter((span) => span.endedAt === null).map((span) => span.kind);
    expect(await open(ids.A)).toEqual(['paused-usage']);
    expect(await open(ids.B)).toEqual(['waiting-dependency']);
    r.held = null;
    r.bus.publish('system', {} as never);
    await settle(r);
    expect((await item(r, plan.id, ids.A)).spans.map((span) => span.kind)).toEqual(['paused-usage', 'running']);
    expect(await open(ids.A)).toEqual(['running']);

    // Paused: the waiting items' spans become paused-plan, A's running span stays open.
    await r.plans.pause(plan.id);
    await settle(r);
    expect(await open(ids.A)).toEqual(['running']);
    expect(await open(ids.B)).toEqual(['paused-plan']);
    expect((await item(r, plan.id, ids.B)).spans.map((span) => span.kind)).toEqual(['waiting-dependency', 'paused-plan']);

    // A restart: a new service over the same plans.db; nothing doubles up.
    await r.plans.close();
    r.plans = new PlanService({ dataDir: r.dir, store: r.store, bus: r.bus, todos: r.todos, git: r.git, env: environment(r), clock: r.clock, onError: (error) => r.errors.push(error) });
    await r.plans.start();
    await settle(r);
    for (const id of [ids.A, ids.B, ids.C, ids.D]) expect(await open(id)).toHaveLength(1);
    await r.plans.resume(plan.id);
    await settle(r);
    expect(await open(ids.B)).toEqual(['waiting-dependency']);
    expect(r.errors).toEqual([]);
  });
});

describe('D99 follow-up 2026-10-15 · plans for anything', () => {
  it('a dev target: developer mode starts as it is; an agent mode needs allowProtectedTarget, which is stored', async () => {
    const r = await setup();
    // dev as the target (also equal to the default base, dev): accepted.
    const dev = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Straight to dev', targetBranch: 'dev' });
    expect(dev).toMatchObject({ targetBranch: 'dev', baseBranch: 'dev', allowProtectedTarget: false });
    const { itemId } = await r.plans.addItem(dev.id, { todo: { title: 'Fix the login' } });
    expect((await r.plans.startPlan(dev.id, { mergeMode: 'developer' })).state).toBe('running');
    await settle(r);
    expect(r.runs[0]?.from).toEqual({ 'acme-front': 'dev' });
    expect(r.runs[0]?.task('todo/fix-the-login')).toContain('the developer merges it into dev');
    // Changing to an agent mode without the acknowledgement is refused; with it, accepted and stored.
    await expect(r.plans.setMode(dev.id, { mergeMode: 'agents' })).rejects.toMatchObject({ status: 422, code: 'target-forbidden', field: 'allowProtectedTarget', message: expect.stringContaining('allowProtectedTarget: true') });
    const changed = await r.plans.setMode(dev.id, { mergeMode: 'agents', allowProtectedTarget: true });
    expect(changed).toMatchObject({ mergeMode: 'agents', allowProtectedTarget: true });
    expect(r.sent.at(-1)?.text).toContain('Never merge into any branch other than dev');
    expect((await item(r, dev.id, itemId)).developerMerges).toBe(false);
  });

  it('agents mode on dev / the default / a protected branch: refused without the ack, started with it', async () => {
    const r = await setup();
    const dev = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Agents into dev', targetBranch: 'dev', baseBranch: 'main' });
    await r.plans.addItem(dev.id, { todo: { title: 'A' } });
    for (const mode of ['agents', 'agents-with-holds']) await expect(r.plans.startPlan(dev.id, { mergeMode: mode })).rejects.toMatchObject({ status: 422, code: 'target-forbidden' });
    await expect(r.plans.startPlan(dev.id, { mergeMode: 'agents', allowProtectedTarget: 'yes' })).rejects.toMatchObject({ status: 422, code: 'invalid', field: 'allowProtectedTarget' });
    expect((await r.plans.get(dev.id)).state).toBe('draft');
    const started = await r.plans.startPlan(dev.id, { mergeMode: 'agents', allowProtectedTarget: true });
    expect(started).toMatchObject({ state: 'running', mergeMode: 'agents', allowProtectedTarget: true });
    await settle(r);
    const brief = r.runs[0]?.task('todo/a') ?? '';
    expect(brief).toContain('merge the pull request into dev yourself');
    expect(brief).not.toContain('Never merge into dev');
    // The repo's protected branch (gh) too: refused without the ack, started with it.
    r.git.protectedBranches = ['release'];
    const release = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Into release', targetBranch: 'release' });
    await r.plans.addItem(release.id, { todo: { title: 'B' } });
    await expect(r.plans.startPlan(release.id, { mergeMode: 'agents-with-holds' })).rejects.toMatchObject({ code: 'target-forbidden', message: expect.stringContaining('protected') });
    expect((await r.plans.startPlan(release.id, { mergeMode: 'agents-with-holds', allowProtectedTarget: true })).state).toBe('running');
    // A feature branch needs no ack.
    const feature = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Epic', targetBranch: 'feature/PROJ-1-x' });
    await r.plans.addItem(feature.id, { todo: { title: 'C' } });
    expect(await r.plans.startPlan(feature.id, { mergeMode: 'agents' })).toMatchObject({ state: 'running', allowProtectedTarget: false });
  });

  it('no target branch: runs the items in order, done when their todos are done, no git / PR watching; holds wait for your Done', async () => {
    const r = await setup();
    for (const value of [undefined, null, '', 'none', 'NONE']) {
      const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: `No target ${String(value)}`, ...(value === undefined ? {} : { targetBranch: value }) });
      expect(plan).toMatchObject({ targetBranch: null, mergeMode: null, allowProtectedTarget: false });
      await r.plans.remove(plan.id);
    }
    const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Research' });
    const ids: Record<string, string> = {};
    for (const name of ['A', 'B', 'C']) ids[name] = (await r.plans.addItem(plan.id, { key: `RES-${name.charCodeAt(0) - 64}`, todo: { title: `Read ${name}` }, hold: name === 'C' })).itemId;
    await r.plans.addEdge(plan.id, { from: 'RES-1', to: 'RES-2' });
    await r.plans.addEdge(plan.id, { from: 'RES-2', to: 'RES-3' });
    // Only "none" fits a plan without a target.
    await expect(r.plans.startPlan(plan.id, { mergeMode: 'agents' })).rejects.toMatchObject({ status: 422, code: 'target-required' });
    expect(await r.plans.startPlan(plan.id, {})).toMatchObject({ state: 'running', mergeMode: 'none' });
    await settle(r);
    expect(started(r)).toEqual(['RES-1']);
    expect(r.runs[0]?.from).toBeNull();
    const brief = r.runs[0]?.task(null) ?? '';
    expect(brief).toContain('no merge step');
    expect(brief).not.toContain('gh pr create');
    // Its todo done while its turn still runs: not yet; the turn ends: done, the next one starts.
    const a = await item(r, plan.id, ids['A'] as string);
    await r.todos.update(r.sourceId, a.todoId, { state: 'done' }, 'agent');
    await settle(r);
    expect((await item(r, plan.id, a.id)).state).toBe('running');
    await status(r, a.runSessionId as string, 'idle');
    expect(await item(r, plan.id, a.id)).toMatchObject({ state: 'done', mergedAt: null, note: null });
    expect(started(r)).toEqual(['RES-1', 'RES-2']);
    // B: a question first, then finished.
    const b = await item(r, plan.id, ids['B'] as string);
    await status(r, b.runSessionId as string, 'need');
    expect((await item(r, plan.id, b.id)).state).toBe('question');
    await r.todos.update(r.sourceId, b.todoId, { state: 'done' }, 'agent');
    await status(r, b.runSessionId as string, 'idle');
    expect((await item(r, plan.id, b.id)).state).toBe('done');
    // C is held: once its todo is done it waits for the developer's Done (an Inbox item), never merged.
    const c = await item(r, plan.id, ids['C'] as string);
    await r.todos.update(r.sourceId, c.todoId, { state: 'done' }, 'agent');
    await status(r, c.runSessionId as string, 'idle');
    expect(await item(r, plan.id, c.id)).toMatchObject({ state: 'to-confirm', waitingOn: 'confirm', developerConfirms: true });
    expect(r.notices.filter((notice) => notice.kind === 'plan-confirm').map((notice) => notice.title)).toEqual(['Confirm done: Read C (Research)']);
    await expect(r.plans.mergeItem(plan.id, c.id)).rejects.toMatchObject({ status: 409, code: 'no-merge-step' });
    await expect(r.plans.openItemPullRequest(plan.id, c.id)).rejects.toMatchObject({ status: 409, code: 'no-merge-step' });
    // The mode cannot switch to a merging one.
    await expect(r.plans.setMode(plan.id, { mergeMode: 'developer' })).rejects.toMatchObject({ status: 422, code: 'target-required' });
    expect((await r.plans.markItemDone(plan.id, c.id)).items.find((entry) => entry.id === c.id)?.state).toBe('done');
    await settle(r);
    expect((await r.plans.get(plan.id)).state).toBe('done');
    expect(r.mergeNotices).toEqual([`- ${c.id} merged`]);
    expect(r.notices.at(-1)).toEqual({ kind: 'plan-ready', title: 'Plan done: Research' });
    // Nothing was read from git or gh, and no checks message was sent.
    expect(r.git.inspected).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it('no merge step with a target: runs are cut from the target, done when their todos are; the mode stays none', async () => {
    const r = await setup();
    const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Docs', targetBranch: 'docs/site' });
    const { itemId } = await r.plans.addItem(plan.id, { todo: { title: 'Write the guide' } });
    expect(await r.plans.startPlan(plan.id, { mergeMode: 'none' })).toMatchObject({ state: 'running', mergeMode: 'none' });
    await settle(r);
    expect(r.runs[0]?.from).toEqual({ 'acme-front': 'docs/site' });
    expect(r.runs[0]?.task('todo/write-the-guide')).toContain('Your branch is todo/write-the-guide, cut from docs/site.');
    await expect(r.plans.setMode(plan.id, { mergeMode: 'developer' })).rejects.toMatchObject({ status: 409, code: 'started' });
    const running = await item(r, plan.id, itemId);
    await agentFinishes(r, plan.id, itemId);
    expect((await r.plans.get(plan.id)).state).toBe('done');
    expect(r.git.inspected).toEqual([]);
    expect(running.state).toBe('running');
  });

  it('an existing plan (made before the follow-up) reads as it was', async () => {
    const r = await setup();
    const { plan } = await diamond(r);
    expect(plan).toMatchObject({ targetBranch: 'feature/PROJ-100-acme', mergeMode: null, allowProtectedTarget: false, baseBranch: 'dev' });
    await expect(r.plans.startPlan(plan.id, {})).rejects.toMatchObject({ status: 422, code: 'merge-mode-required' });
    expect((await r.plans.startPlan(plan.id, { mergeMode: 'agents' })).mergeMode).toBe('agents');
  });
});

describe('D120 · an item whose agent ended its turn without finishing is stopped', () => {
  /** The item's agent writes its last message and its turn ends (idle) with its todo still open. */
  async function agentStops(r: Rig, planId: string, itemId: string, text: string, state: BranchState = { hasWork: true }): Promise<string> {
    const current = await item(r, planId, itemId);
    const sessionId = current.runSessionId as string;
    r.git.branches.set(current.branch as string, state);
    await r.store.events.append({ sessionId, kind: 'text', label: 'text', payload: { type: 'assistant', text } });
    await r.store.sessions.update(sessionId, { lastActivityAt: r.clock.now().toISOString() });
    await status(r, sessionId, 'idle');
    return sessionId;
  }

  async function advance(r: Rig, ms: number): Promise<void> {
    await r.clock.advanceTo(new Date(r.clock.now().getTime() + ms), () => settle(r));
    await settle(r);
  }

  it('turns stopped after the grace period with the agent\'s last message; one Inbox item; waiting-you; the slot is held and dependents wait; back to running when it works again', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r, { maxConcurrency: 1 });
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    const message = 'The item isn\'t finished yet, so I haven\'t marked the todo done. The code is pushed in a PR and the integration tests pass in CI.\n\nLeft: one CI check failed for an unrelated infrastructure reason and needs a re-run; then merge the PR once green; then mark the todo done.';
    const sessionId = await agentStops(r, plan.id, ids.A, message, { hasWork: true, pr: { state: 'OPEN', checks: { state: 'red', summary: '1 failed: infra', sha: 'abc' } } });
    // Within the grace period: still running, nothing raised; a timer looks again when it is over.
    expect((await item(r, plan.id, ids.A)).state).toBe('running');
    expect(r.stoppedNotices.filter((line) => line.startsWith('+ '))).toEqual([]);
    expect(r.clock.delays()).toContain(120_000);
    await advance(r, 60_000);
    expect((await item(r, plan.id, ids.A)).state).toBe('running');
    // Past it: stopped, the excerpt as the reason, one Inbox item.
    await advance(r, 60_000);
    const a = await item(r, plan.id, ids.A);
    expect(a).toMatchObject({ state: 'stopped', storedState: 'running', stoppedSince: '2026-10-13T10:00:00.000Z' });
    expect(a.reason).toBe(message.replace(/\s+/g, ' '));
    expect(r.stoppedNotices.filter((line) => line.startsWith('+ '))).toEqual([`+ Stopped: PROJ-1 Item A (Acme epic) | plan-stopped:${ids.A}:2026-10-13T10:00:00.000Z`]);
    const raisedAt = r.stoppedNotices.length;
    // Its span is waiting-you; it keeps its slot (max 1: nothing else starts) and its dependents wait (not blocked).
    const viewed = await r.plans.get(plan.id);
    expect(viewed.items.find((entry) => entry.id === ids.A)?.spans.at(-1)).toMatchObject({ kind: 'waiting-you', endedAt: null });
    expect(viewed.items.find((entry) => entry.id === ids.B)).toMatchObject({ state: 'waiting', reason: 'waiting on PROJ-1' });
    expect(started(r)).toEqual(['PROJ-1']);
    expect(viewed.estimatedMinutesLeft).not.toBeNull();
    // More cycles (the checks poll, a todo change) raise nothing more.
    r.plans.pollChecks();
    await advance(r, 120_000);
    expect(r.stoppedNotices).toHaveLength(raisedAt);

    // The developer replies: it works again → running, the Inbox item closes.
    await status(r, sessionId, 'run');
    expect((await item(r, plan.id, ids.A)).state).toBe('running');
    expect(r.stoppedNotices.at(-1)).toBe(`- ${ids.A} running`);
    const spans = (await item(r, plan.id, ids.A)).spans;
    expect(spans.at(-1)).toMatchObject({ kind: 'running', endedAt: null });

    // It stops again: a new episode, a new Inbox item.
    await advance(r, 60_000);
    await agentStops(r, plan.id, ids.A, 'Still waiting for the re-run.');
    await advance(r, 120_000);
    expect(await item(r, plan.id, ids.A)).toMatchObject({ state: 'stopped', reason: 'Still waiting for the re-run.' });
    expect(r.stoppedNotices.filter((line) => line.startsWith('+ '))).toHaveLength(2);

    // The developer re-runs the check and replies; it finishes: merged → done, the Inbox item closes, the dependents start.
    await status(r, sessionId, 'run');
    await r.todos.update(r.sourceId, a.todoId, { state: 'done' }, 'agent');
    await agentMerges(r, plan.id, ids.A);
    expect((await item(r, plan.id, ids.A)).state).toBe('done');
    expect(r.stoppedNotices.filter((line) => line.startsWith(`- ${ids.A}`)).at(-1)).toBe(`- ${ids.A} running`);
    expect(r.stoppedNotices.filter((line) => line.startsWith('+ '))).toHaveLength(2);
    expect(started(r)).toEqual(['PROJ-1', 'PROJ-2']);
    expect(r.errors).toEqual([]);
  });

  it('a turn end followed by marking the todo done within the grace period never shows stopped', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r, { holdD: true });
    await r.plans.startPlan(plan.id, { mergeMode: 'developer' });
    await settle(r);
    await agentStops(r, plan.id, ids.A, 'Done, marking the todo now.');
    await advance(r, 30_000);
    const a = await item(r, plan.id, ids.A);
    await r.todos.update(r.sourceId, a.todoId, { state: 'done' }, 'agent');
    await settle(r);
    await advance(r, 180_000);
    expect((await item(r, plan.id, ids.A)).state).toBe('ready-to-merge');
    expect(r.stoppedNotices.filter((line) => line.startsWith('+ '))).toEqual([]);
  });

  it('green PRs while idle wait for your merge (not stopped); red checks while idle are stopped; a question stays a question', async () => {
    const r = await setup({ stoppedGraceMs: 1_000 });
    const { plan, ids } = await diamond(r);
    await r.plans.startPlan(plan.id, { mergeMode: 'developer' });
    await settle(r);
    await agentStops(r, plan.id, ids.A, 'PR is open and green.', { hasWork: true, pr: { state: 'OPEN', checks: { state: 'green', summary: null, sha: 'abc' } } });
    await advance(r, 5_000);
    expect((await item(r, plan.id, ids.A)).state).toBe('ready-to-merge');
    await r.plans.mergeItem(plan.id, ids.A);
    await settle(r);
    // B: red checks while idle.
    await agentStops(r, plan.id, ids.B, 'A check failed; I may not re-run it.', { hasWork: true, pr: { state: 'OPEN', checks: { state: 'red', summary: '1 failed: infra', sha: 'def' } } });
    await advance(r, 5_000);
    expect(await item(r, plan.id, ids.B)).toMatchObject({ state: 'stopped', reason: 'A check failed; I may not re-run it.' });
    // C asks a question: question, not stopped.
    const c = await item(r, plan.id, ids.C);
    await status(r, c.runSessionId as string, 'need');
    await advance(r, 5_000);
    expect((await item(r, plan.id, ids.C)).state).toBe('question');
    expect(r.stoppedNotices.filter((line) => line.startsWith('+ '))).toEqual([`+ Stopped: PROJ-2 Item B (Acme epic) | plan-stopped:${ids.B}:${(await item(r, plan.id, ids.B)).stoppedSince}`]);
    // Deleting the plan closes its open Stopped item.
    await r.plans.remove(plan.id, { stop: true });
    expect(r.stoppedNotices.at(-1)).toBe(`- ${ids.B} plan-ended`);
    expect(r.errors).toEqual([]);
  });
});

describe('D124 · an item whose agent ended its turn waiting for you shows needs-you, not stopped', () => {
  async function advance(r: Rig, ms: number): Promise<void> {
    await r.clock.advanceTo(new Date(r.clock.now().getTime() + ms), () => settle(r));
    await settle(r);
  }

  it('amber needs-you with the ask in place of the red stopped, no Stopped Inbox item; back to running on a new turn; a plain end is still stopped', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r, { maxConcurrency: 1 });
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    const current = await item(r, plan.id, ids.A);
    const sessionId = current.runSessionId as string;
    r.git.branches.set(current.branch as string, { hasWork: true });
    await r.store.events.append({ sessionId, kind: 'text', label: 'text', payload: { type: 'assistant', text: 'Should I keep the old endpoint?' } });
    await r.store.sessions.update(sessionId, { lastActivityAt: r.clock.now().toISOString(), turnWait: { status: 'waiting_for_you', ask: 'Should I keep the old endpoint?', source: 'detected', at: r.clock.now().toISOString() } });
    await status(r, sessionId, 'idle');
    // Long past the D120 grace period: needs-you (its ask as the reason), never stopped, and no Stopped Inbox item.
    await advance(r, 240_000);
    const a = await item(r, plan.id, ids.A);
    expect(a).toMatchObject({ state: 'needs-you', storedState: 'running', reason: 'Should I keep the old endpoint?' });
    expect(a.spans.at(-1)).toMatchObject({ kind: 'waiting-you', endedAt: null });
    expect(r.stoppedNotices.filter((line) => line.startsWith('+ '))).toEqual([]);
    // The developer replies: a new turn clears the wait, it works again.
    await r.store.sessions.update(sessionId, { turnWait: null });
    await status(r, sessionId, 'run');
    expect((await item(r, plan.id, ids.A)).state).toBe('running');
    // A turn that ends without a waiting signal is D120's stopped as before.
    await r.store.sessions.update(sessionId, { lastActivityAt: r.clock.now().toISOString() });
    await status(r, sessionId, 'idle');
    await advance(r, 240_000);
    expect((await item(r, plan.id, ids.A)).state).toBe('stopped');
    expect(r.stoppedNotices.filter((line) => line.startsWith('+ '))).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });
});


describe('D149 · agents mode: a todo done with nothing merged is done after the grace period', () => {
  async function advance(r: Rig, ms: number): Promise<void> {
    await r.clock.advanceTo(new Date(r.clock.now().getTime() + ms), () => settle(r));
    await settle(r);
  }

  /** A diamond in `mode`, A running; answers the plan, the ids and A's run session. */
  async function running(r: Rig, mode: 'agents' | 'agents-with-holds' = 'agents', hold = false) {
    const { plan, ids } = await diamond(r);
    if (hold) await r.plans.updateItem(plan.id, ids.A, { hold: true });
    await r.plans.startPlan(plan.id, { mergeMode: mode });
    await settle(r);
    const a = await item(r, plan.id, ids.A);
    return { plan, ids, a, sessionId: a.runSessionId as string };
  }

  /** A's agent marks its todo done and its turn ends with `state` on its branch. */
  async function finishes(r: Rig, planId: string, itemId: string, state: BranchState): Promise<void> {
    const current = await item(r, planId, itemId);
    r.git.branches.set(current.branch as string, state);
    await r.store.sessions.update(current.runSessionId as string, { lastActivityAt: r.clock.now().toISOString() });
    await r.todos.update(r.sourceId, current.todoId, { state: 'done' }, 'agent');
    await status(r, current.runSessionId as string, 'done');
  }

  it('no commits of its own anywhere: running within the grace period, then done ("done: nothing to merge"), not merged, its dependents start, no Inbox item', async () => {
    const r = await setup();
    const { plan, ids } = await running(r);
    await finishes(r, plan.id, ids.A, { hasWork: false });
    await advance(r, 60_000);
    expect((await item(r, plan.id, ids.A)).state).toBe('running');
    expect(started(r)).toEqual(['PROJ-1']);
    await advance(r, 61_000);
    const a = await item(r, plan.id, ids.A);
    expect(a).toMatchObject({ state: 'done', mergedAt: null, note: 'done: nothing to merge (no commits of its own in acme-front)' });
    expect(started(r)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
    expect(r.unmergedNotices).toEqual([]);
    // D121's auto-repair leaves it done (it never claimed a merge), also across cycles.
    r.plans.kick();
    await advance(r, 120_000);
    expect((await item(r, plan.id, ids.A)).state).toBe('done');
    expect(r.errors).toEqual([]);
  });

  it('work not merged (a green PR its agent did not merge): done after the grace period, the note names it, one "Done without merging" Inbox item with its PR', async () => {
    const r = await setup();
    const { plan, ids, a } = await running(r);
    const pr = `https://example.test/pr/${a.branch as string}`;
    await finishes(r, plan.id, ids.A, { hasWork: true, merged: false, pr: { state: 'OPEN', checks: { state: 'green', summary: null, sha: 'abc' } } });
    expect((await item(r, plan.id, ids.A)).state).toBe('running');
    await advance(r, 121_000);
    const done = await item(r, plan.id, ids.A);
    expect(done).toMatchObject({ state: 'done', mergedAt: null, prUrl: pr });
    expect(done.note).toBe(`done without merging into feature/PROJ-100-acme: acme-front ${a.branch as string} (PR ${pr})`);
    expect(r.unmergedNotices).toHaveLength(1);
    expect(r.unmergedNotices[0]).toMatch(new RegExp(`^\\+ Done without merging: PROJ-1 Item A \\(Acme epic\\) \\| ${pr.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\| plan-unmerged:`));
    expect(started(r)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
    expect(r.merged).toEqual([]);
    r.plans.kick();
    await advance(r, 120_000);
    expect((await item(r, plan.id, ids.A)).state).toBe('done');
    expect(r.unmergedNotices).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });

  it('checks pending, red checks or a conflict keep it running (not done)', async () => {
    for (const branch of [
      { hasWork: true, pr: { state: 'OPEN', checks: { state: 'pending', summary: null, sha: 'abc' } } },
      { hasWork: true, pr: { state: 'OPEN', checks: { state: 'red', summary: '1 failing', sha: 'abc' } } },
      { hasWork: true, conflict: true },
    ] as BranchState[]) {
      const r = await setup();
      const { plan, ids } = await running(r);
      await finishes(r, plan.id, ids.A, branch);
      await advance(r, 300_000);
      const a = await item(r, plan.id, ids.A);
      expect(a.storedState).toBe('running');
      expect(started(r)).toEqual(['PROJ-1']);
      expect(r.unmergedNotices).toEqual([]);
      await r.plans.close();
      await r.store.close();
      await removeTempDir(r.dir);
      rig = undefined;
    }
  });

  it('its agent works again within the grace period (it goes on to merge): not done', async () => {
    const r = await setup();
    const { plan, ids, sessionId } = await running(r);
    await finishes(r, plan.id, ids.A, { hasWork: true });
    await advance(r, 60_000);
    await status(r, sessionId, 'run');
    await advance(r, 300_000);
    expect((await item(r, plan.id, ids.A)).storedState).toBe('running');
    expect(started(r)).toEqual(['PROJ-1']);
  });

  it('a held item (agents-with-holds) still waits for your merge', async () => {
    const r = await setup();
    const { plan, ids } = await running(r, 'agents-with-holds', true);
    await finishes(r, plan.id, ids.A, { hasWork: false });
    await advance(r, 300_000);
    expect((await item(r, plan.id, ids.A)).state).toBe('ready-to-merge');
    expect(r.unmergedNotices).toEqual([]);
  });
});

describe('D149 · the Timeline follows needs-you and questions back to running', () => {
  async function advance(r: Rig, ms: number): Promise<void> {
    await r.clock.advanceTo(new Date(r.clock.now().getTime() + ms), () => settle(r));
    await settle(r);
  }

  it('needs-you → answered → running closes the waiting-you span and opens a running one', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r, { maxConcurrency: 1 });
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    const sessionId = (await item(r, plan.id, ids.A)).runSessionId as string;
    await r.store.sessions.update(sessionId, { lastActivityAt: r.clock.now().toISOString(), turnWait: { status: 'waiting_for_you', ask: 'Which endpoint?', source: 'declared', at: r.clock.now().toISOString() } });
    await status(r, sessionId, 'done');
    await advance(r, 30_000);
    expect((await item(r, plan.id, ids.A)).state).toBe('needs-you');
    expect((await item(r, plan.id, ids.A)).spans.map((span) => [span.kind, span.endedAt === null])).toEqual([['running', false], ['waiting-you', true]]);
    // The developer answers: a new turn starts.
    await r.store.sessions.update(sessionId, { turnWait: null });
    await status(r, sessionId, 'run');
    const a = await item(r, plan.id, ids.A);
    expect(a.state).toBe('running');
    expect(a.spans.map((span) => [span.kind, span.endedAt === null])).toEqual([['running', false], ['waiting-you', false], ['running', true]]);
    expect(r.errors).toEqual([]);
  });

  it('a question (a pending permission) → answered → running closes its span too', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r, { maxConcurrency: 1 });
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    const sessionId = (await item(r, plan.id, ids.A)).runSessionId as string;
    await status(r, sessionId, 'need');
    expect((await item(r, plan.id, ids.A)).spans.at(-1)).toMatchObject({ kind: 'waiting-you', endedAt: null });
    await status(r, sessionId, 'run');
    expect((await item(r, plan.id, ids.A)).spans.at(-1)).toMatchObject({ kind: 'running', endedAt: null });
  });

  it('activation closes an open span that no longer matches the item', async () => {
    const r = await setup();
    const { plan, ids } = await diamond(r, { maxConcurrency: 1 });
    await r.plans.startPlan(plan.id, { mergeMode: 'agents' });
    await settle(r);
    const sessionId = (await item(r, plan.id, ids.A)).runSessionId as string;
    await status(r, sessionId, 'need');
    expect((await item(r, plan.id, ids.A)).spans.at(-1)).toMatchObject({ kind: 'waiting-you', endedAt: null });
    // While the service is down the agent works again (no event reaches Plans).
    await r.plans.close();
    await r.store.sessions.update(sessionId, { status: 'run' });
    r.plans = new PlanService({ dataDir: r.dir, store: r.store, bus: r.bus, todos: r.todos, git: r.git, merger: r.merger, env: environment(r), clock: r.clock, onError: (error) => r.errors.push(error) });
    await r.plans.start();
    await settle(r);
    const a = await item(r, plan.id, ids.A);
    expect(a.spans.filter((span) => span.endedAt === null).map((span) => span.kind)).toEqual(['running']);
    expect(a.spans.at(-2)).toMatchObject({ kind: 'waiting-you' });
    expect(a.spans.at(-2)?.endedAt).not.toBeNull();
  });
});
