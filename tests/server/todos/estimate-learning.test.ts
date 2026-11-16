/**
 * D167 (`docs/todos.md` → *Self-correcting estimates*): finished work changes what Switchboard
 * shows, with no action: completed items measured in working time (the `todo_actuals` rows
 * D147's completion writes, inserted here as it writes them) change the learned factor, the
 * session's todo list (each item's likely time), the agent's line, and a plan's time left and
 * `plan_status` text, live (the learner re-reads when the history changed).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { planStatusText } from '../../../src/core/plans.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import type { PlanGitPort, PlanRepoInput, PlanRepoState } from '../../../src/server/plans/git.ts';
import { type PlanEnvironment, type PlanMergePort, PlanService } from '../../../src/server/plans/service.ts';
import { estimateLearnerFor } from '../../../src/server/todos/estimate-learning.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import type { BranchMergeInput, BranchMergePlan } from '../../../src/server/worktrees/branch-merge.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

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

let dir: string | undefined;
let store: Store | undefined;
let plans: PlanService | undefined;

afterEach(async () => {
  await plans?.close();
  await store?.close();
  if (dir) await removeTempDir(dir);
  dir = undefined;
  store = undefined;
  plans = undefined;
});

/** What D147's completion writes for an item measured in working time. */
function finish(s: Store, sessionId: string, folder: string, estimate: number, workingMinutes: number, at: string): void {
  s.db
    .prepare("INSERT INTO todo_actuals (todo_id, session_id, folder, title, estimate_minutes, actual_ms, actual_tokens, completed_at, provider, model, working_ms, measure) VALUES (?, ?, ?, 'done item', ?, ?, NULL, ?, 'claude', '', ?, 'working')")
    .run(randomUUID(), sessionId, folder, estimate, Math.round(workingMinutes * 60_000), at, Math.round(workingMinutes * 60_000));
}

describe('D167 · finished work corrects the estimates by itself', () => {
  it('the todo list, the agent’s line, the plan’s time left and plan_status follow the history', async () => {
    dir = await makeTempDir('estimate-learning');
    store = await openTempStore(dir);
    const s = store;
    const bus = new HubBus();
    const todos = new TodoService({ store: s, bus });
    const source = await s.sessions.create({ name: 'source', claudeSessionId: 'c-source', status: 'idle', cwd: '/ws', root: '/ws', rootKind: 'workspace', solutions: ['acme-front'], worktrees: false });
    const env: PlanEnvironment = {
      async repos(_sourceSessionId, names) {
        return { kind: 'workspace', repos: (names ?? ['acme-front']).map((name) => ({ name, repoPath: `/repos/${name}` })) };
      },
      async run() {
        return { ok: false, message: 'not in this test' };
      },
      async usageHeld() {
        return null;
      },
      async send() {},
      async notice() {},
      async mergeNotice() {},
      async closeMergeNotice() {},
      async stoppedNotice() {},
      async closeStoppedNotices() {},
    };
    plans = new PlanService({ dataDir: dir, store: s, bus, todos, git: new QuietGit(), merger: NO_MERGE, env, pollMs: 3_600_000 });
    await plans.start();
    const plan = await plans.create({ sourceSessionId: source.id, title: 'Nine hours', targetBranch: null });
    for (let i = 0; i < 5; i += 1) await plans.addItem(plan.id, { todo: { title: `Step ${i}`, plan: 'Do it.', estimateMinutes: 108 } });

    // Nothing learned yet: raw estimates, no likely time, D147's line (none: no history).
    let view = await plans.get(plan.id);
    // Five steps of 108 min over 3 slots: 180 min.
    expect(view.estimatedMinutesLeft).toBe(180);
    expect(view.estimate).toMatchObject({ basis: 'none', rawMinutesLeft: 180, likelyMinutesLeft: 180 });
    let list = await todos.list(source.id);
    expect(list.todos[0]?.likely).toMatchObject({ basis: 'none', minutes: 108 });
    expect(await todos.calibration(source.id)).toBeNull();

    // Ten items in this folder finish at ≈0.13× their estimates.
    for (let i = 0; i < 10; i += 1) finish(s, source.id, '/ws', 90, 90 * (0.11 + (i % 5) / 100), new Date(Date.parse('2026-11-10T08:00:00.000Z') + i * 3600_000).toISOString());

    view = await plans.get(plan.id);
    expect(view.estimate?.basis).toBe('folder');
    expect(view.estimate?.rawMinutesLeft).toBe(180);
    expect(view.estimatedMinutesLeft).toBe(24);
    expect(view.items[0]?.likelyMinutes).toBe(14);
    const status = planStatusText(view);
    expect(status).toMatch(/about \d+ min left \(agents estimated 180 min; learned from 10 finished in this folder\)/);
    expect(status).toContain('est 108m → likely 14m');
    list = await todos.list(source.id);
    expect(list.todos[0]?.likely).toMatchObject({ basis: 'folder', minutes: 14, sampleSize: 10 });
    expect(await todos.calibration(source.id)).toMatch(/^Learned from 10 finished in this folder: estimates take 0\.13×/);

    // More history that ran longer: the factor moves (recent items weigh more).
    for (let i = 0; i < 10; i += 1) finish(s, source.id, '/ws', 90, 45, new Date(Date.parse('2026-11-12T08:00:00.000Z') + i * 3600_000).toISOString());
    expect(estimateLearnerFor(s).likely(90, { folder: '/ws' }).minutes).toBe(45);
    expect((await plans.get(plan.id)).items[0]?.likelyMinutes).toBe(54);
  });
});
