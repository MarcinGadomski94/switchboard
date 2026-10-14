/**
 * D109 (`docs/ci.md`): the shared PR watcher on the real code path: temp git repos, the real
 * worktree manager and Inbox items, gh = tools/fake-gh (its PRs, run logs, merge), never the
 * real GitHub. The session messages go to a recorder here (the paused-credits hold, through
 * the real supervisor, is its own test below).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ciChip, ciFailureMessage, failureSignature, parsePrReading, prReadyToMerge, trimLogTail } from '../../../src/core/ci.ts';
import { CiGh } from '../../../src/server/ci/gh.ts';
import { registerCiMergeOwner } from '../../../src/server/ci/hooks.ts';
import { PrWatcher, ciTiming } from '../../../src/server/ci/watcher.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import { CI_FAILING, CI_READY, SystemItemService, WORKTREE_REMOVABLE } from '../../../src/server/inbox/system-items.ts';
import type { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { until } from '../../helpers/supervisor.ts';

const BRANCH = 'feature/pr-watch';
const PR_URL = 'https://github.com/acme/web-front/pull/12';

interface Rig {
  readonly w: GitWorld;
  readonly m: WorktreeManager;
  readonly bus: HubBus;
  readonly events: HubMessage[];
  readonly items: SystemItemService;
  readonly watcher: PrWatcher;
  readonly sent: Array<{ sessionId: string; text: string }>;
  readonly sessionId: string;
  readonly worktreeId: string;
  readonly logs: string;
  /** Sets the fake PR #12 (merged over the defaults). */
  pr(fields: Record<string, unknown>): Promise<void>;
  /** Writes the failed log of run 101 job 201. */
  log(text: string): Promise<void>;
  /** The open Inbox items of a kind. */
  open(kind: string): Promise<Array<{ id: string; title: string; detail: string; actions: Array<{ id: string }>; payload: unknown }>>;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.watcher.close();
  await rig?.items.close();
  await rig?.w.cleanup();
  rig = undefined;
});

function red(name = 'build', run = '101', job = '201'): Record<string, unknown> {
  return { __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: `https://github.com/acme/web-front/actions/runs/${run}/job/${job}` };
}
const green = (name = 'build'): Record<string, unknown> => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const running = (name = 'build'): Record<string, unknown> => ({ __typename: 'CheckRun', name, status: 'IN_PROGRESS', conclusion: '' });

/** A failing job's log as gh prints it (job, step, timestamp columns). */
function ghLog(lines: string[]): string {
  return lines.map((line, i) => `build\tRun tests\t2026-10-14T10:00:${String(i % 60).padStart(2, '0')}.0000000Z ${line}`).join('\n');
}

async function make(options: { readonly owner?: boolean } = {}): Promise<Rig> {
  const w = await makeGitWorld();
  const m = w.manager();
  const bus = new HubBus();
  const events: HubMessage[] = [];
  bus.subscribe((message) => events.push(message));
  const items = new SystemItemService({ store: w.store, bus, worktrees: m });
  const session = await w.store.sessions.create({ name: 'pr-watch', claudeSessionId: randomUUID(), solutions: ['web-front'], worktrees: true });
  const wtPath = path.join(w.root, 'web-front-wt-pr');
  await w.git(w.web, 'worktree', 'add', '-q', '-b', BRANCH, wtPath, 'main');
  await w.git(wtPath, 'push', '-q', '-u', 'origin', BRANCH);
  const worktree = await w.store.worktrees.create({ repo: 'web-front', repoPath: w.web, branch: BRANCH, path: wtPath, sessionId: session.id, baseRef: 'main', prNumber: 12, prUrl: PR_URL, prState: 'OPEN' });
  const logs = path.join(w.root, 'run-logs');
  await mkdir(logs, { recursive: true });
  const sent: Array<{ sessionId: string; text: string }> = [];
  const watcher = new PrWatcher({
    store: w.store,
    bus,
    gh: new CiGh({ gh: fakeGhCommand(), env: { ...w.env, FAKE_GH_RUN_LOGS: logs } }),
    send: async (sessionId, text) => {
      sent.push({ sessionId, text });
    },
    notices: items,
    cleanup: async (worktreeId) => {
      await m.checkPullRequest(worktreeId);
    },
    onError: (error) => w.errors.push(error),
  });
  items.useCi(watcher);
  if (options.owner) registerCiMergeOwner(w.store, async () => true);
  const base = { number: 12, state: 'OPEN', url: PR_URL, headRefName: BRANCH, baseRefName: 'main', headRefOid: 'aaaaaaa1', mergeable: 'MERGEABLE', isDraft: false, reviewDecision: '', statusCheckRollup: [] as unknown[] };
  let current: Record<string, unknown> = { ...base };
  const made: Rig = {
    w,
    m,
    bus,
    events,
    items,
    watcher,
    sent,
    sessionId: session.id,
    worktreeId: worktree.id,
    logs,
    async pr(fields) {
      current = { ...current, ...fields };
      await w.setPullRequests({ [BRANCH]: current });
    },
    async log(text) {
      await writeFile(path.join(logs, '101-201.log'), text);
    },
    async open(kind) {
      return (await w.store.systemItems.list(['open'])).filter((item) => item.kind === kind) as never;
    },
  };
  await made.pr({});
  rig = made;
  return made;
}

describe('D109 · core helpers', () => {
  it('reads a PR: red checks with their Actions run and job, the review decision, ready to merge', () => {
    const pr = parsePrReading(JSON.stringify({ number: 7, state: 'OPEN', url: PR_URL, headRefOid: 'abc1234', reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', statusCheckRollup: [red('lint', '9', '10'), green('test')] }));
    expect(pr?.checks).toEqual({ state: 'red', summary: 'failed: lint', sha: 'abc1234' });
    expect(pr?.failing).toEqual([{ name: 'lint', runId: '9', jobId: '10', url: 'https://github.com/acme/web-front/actions/runs/9/job/10' }]);
    const ready = { state: 'OPEN', isDraft: false, checks: { state: 'green' as const, summary: null, sha: null }, mergeable: 'MERGEABLE', review: 'APPROVED' as const };
    expect(prReadyToMerge(ready)).toBe(true);
    expect(prReadyToMerge({ ...ready, review: null })).toBe(true);
    expect(prReadyToMerge({ ...ready, review: 'REVIEW_REQUIRED' })).toBe(false);
    expect(prReadyToMerge({ ...ready, checks: { state: 'pending', summary: null, sha: null } })).toBe(false);
    expect(prReadyToMerge({ ...ready, mergeable: 'CONFLICTING' })).toBe(false);
    expect(prReadyToMerge({ ...ready, isDraft: true })).toBe(false);
  });

  it('trims the log to its tail without gh columns, and signs a failure without the run-specific parts', () => {
    const log = ghLog(['one', 'two', 'three', '\u001b[31merror\u001b[0m: expected 4', '']);
    expect(trimLogTail(log, 2)).toBe('three\nerror: expected 4');
    expect(failureSignature(['build'], 'took 12.5s at 0123abcd9')).toBe(failureSignature(['build'], 'took 99.1s at ffee00112'));
    expect(failureSignature(['build'], 'expected 4')).not.toBe(failureSignature(['build'], 'cannot find module'));
    const text = ciFailureMessage({ checks: ['build'], prNumber: 12, branch: BRANCH, excerpt: 'boom', attempt: 1, maxAttempts: 3 });
    expect(text.startsWith('CI failed: build — on PR #12')).toBe(true);
    expect(text).toContain('boom');
    expect(text.endsWith('Fix it and push.')).toBe(true);
  });

  it('the header chip: failed before running before green / ready before merged; none without a PR', () => {
    const pr = (fields: Record<string, unknown>) => ({ worktreeId: 'w', repo: 'r', branch: 'b', number: 1, url: null, state: 'OPEN', checks: 'green', summary: null, review: null, ready: false, attempts: 0, maxAttempts: 3, stopped: null, checkedAt: null, ...fields }) as never;
    expect(ciChip([])).toBeNull();
    expect(ciChip([pr({ checks: 'pending' }), pr({ number: 2, checks: 'red' })])?.state).toBe('failed');
    expect(ciChip([pr({ checks: 'pending' })])?.label).toBe('PR #1 · CI running');
    expect(ciChip([pr({ ready: true })])?.label).toBe('PR #1 · ready to merge');
    expect(ciChip([pr({ state: 'MERGED' })])?.state).toBe('merged');
    expect(ciChip([pr({ state: 'CLOSED' })])).toBeNull();
    expect(ciTiming({ SWITCHBOARD_CI_TICK_MS: '500' })).toEqual({ intervalMs: 500, initialDelayMs: 500 });
    expect(ciTiming({})).toEqual({});
  });
});

describe('D109 · the PR watcher', () => {
  it('a red check sends ONE message with the failing job\'s log tail; reading the same red head again sends nothing', async () => {
    const r = await make();
    await r.w.store.settings.set('ci.logTailLines', 20);
    await r.pr({ statusCheckRollup: [red()] });
    await r.log(ghLog([...Array.from({ length: 40 }, (_, i) => `line ${i}`), 'Error: expected 4 to be 5']));
    await r.watcher.check(r.worktreeId);
    await r.watcher.check(r.worktreeId);
    await r.watcher.tick();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.sessionId).toBe(r.sessionId);
    expect(r.sent[0]?.text).toMatch(/^CI failed: build — on PR #12 \(feature\/pr-watch\), attempt 1 of 3\./);
    expect(r.sent[0]?.text).toContain('Error: expected 4 to be 5');
    expect(r.sent[0]?.text).toContain('line 39');
    // 20 lines: the oldest ones are not sent.
    expect(r.sent[0]?.text).not.toContain('line 5\n');
    expect(r.sent[0]?.text.endsWith('Fix it and push.')).toBe(true);
    const status = await r.watcher.status(r.sessionId);
    expect(status.prs).toEqual([expect.objectContaining({ number: 12, state: 'OPEN', checks: 'red', attempts: 1, maxAttempts: 3, stopped: null, url: PR_URL })]);
    expect(r.events.some((event) => event.name === 'ciChanged' && event.payload.sessionId === r.sessionId)).toBe(true);
    expect(r.w.errors).toEqual([]);
  });

  it('stops after the cap (max attempts) and raises "CI keeps failing" with Open PR / Open session / Try again; Try again sends again', async () => {
    const r = await make();
    await r.w.store.settings.set('ci.maxAttempts', 2);
    const failures = ['Cannot find module ./alpha', 'TypeError: beta is undefined', 'Timeout in gamma.spec'];
    for (const [i, sha] of ['bbbbbbb1', 'bbbbbbb2', 'bbbbbbb3'].entries()) {
      await r.pr({ headRefOid: sha, statusCheckRollup: [red()] });
      await r.log(ghLog([failures[i] ?? '']));
      await r.watcher.check(r.worktreeId);
    }
    expect(r.sent).toHaveLength(2);
    const [item] = await r.open(CI_FAILING);
    expect(item?.title).toBe('CI keeps failing on PR #12 (build) — 2 fixes tried');
    expect(item?.actions.map((action) => action.id)).toEqual(['open-pr', 'open-session', 'try-again', 'dismiss']);
    expect(item?.payload).toMatchObject({ url: PR_URL });
    expect((await r.watcher.status(r.sessionId)).prs[0]).toMatchObject({ stopped: 'cap', attempts: 2 });
    // A fourth red head: still stopped (no message, no second item).
    await r.pr({ headRefOid: 'bbbbbbb4' });
    await r.watcher.check(r.worktreeId);
    expect(r.sent).toHaveLength(2);
    expect(await r.open(CI_FAILING)).toHaveLength(1);
    // Try again: the attempts start over and the current failure goes out; the item closes.
    await r.items.act(item?.id ?? '', 'try-again');
    expect(r.sent).toHaveLength(3);
    expect(r.sent[2]?.text).toContain('attempt 1 of 2');
    expect(await r.open(CI_FAILING)).toHaveLength(0);
  });

  it('the same failure signature twice in a row stops after one message', async () => {
    const r = await make();
    await r.log(ghLog(['FAIL src/app.test.ts', 'expected 4 to be 5 (took 1.2 s)']));
    await r.pr({ headRefOid: 'ccccccc1', statusCheckRollup: [red()] });
    await r.watcher.check(r.worktreeId);
    // The agent pushed; the same test fails the same way (only the timing differs).
    await r.log(ghLog(['FAIL src/app.test.ts', 'expected 4 to be 5 (took 3.9 s)']));
    await r.pr({ headRefOid: 'ccccccc2' });
    await r.watcher.check(r.worktreeId);
    expect(r.sent).toHaveLength(1);
    const [item] = await r.open(CI_FAILING);
    expect(item?.title).toBe('CI keeps failing on PR #12 (build) — the same failure twice, 1 fix tried');
    expect((await r.watcher.status(r.sessionId)).prs[0]).toMatchObject({ stopped: 'same-failure' });
    // Green again: the stop is over, its item closes.
    await r.pr({ headRefOid: 'ccccccc3', statusCheckRollup: [green()] });
    await r.watcher.check(r.worktreeId);
    expect(await r.open(CI_FAILING)).toHaveLength(0);
  });

  it('"send CI failures to the session" off: nothing is sent, the status still shows red', async () => {
    const r = await make();
    await r.w.store.settings.set('ci.sendFailures', false);
    await r.pr({ statusCheckRollup: [red()] });
    await r.watcher.check(r.worktreeId);
    expect(r.sent).toEqual([]);
    expect((await r.watcher.status(r.sessionId)).prs[0]).toMatchObject({ checks: 'red', attempts: 0 });
  });

  it('green + approved raises "PR #12 ready to merge" with Merge PR; Merge PR merges (repo default method), closes it and offers the clean-up', async () => {
    const r = await make();
    await r.w.store.settings.set('ci.mergeMethod', 'repo');
    await writeFile(path.join(r.w.root, 'repo.json'), JSON.stringify({ 'web-front': { nameWithOwner: 'acme/web-front', viewerDefaultMergeMethod: 'SQUASH' } }));
    // Review still required: no item.
    await r.pr({ statusCheckRollup: [green()], reviewDecision: 'REVIEW_REQUIRED' });
    await r.watcher.check(r.worktreeId);
    expect(await r.open(CI_READY)).toHaveLength(0);
    await r.pr({ reviewDecision: 'APPROVED' });
    await r.watcher.check(r.worktreeId);
    const [item] = await r.open(CI_READY);
    expect(item?.title).toBe('PR #12 ready to merge');
    expect(item?.actions.map((action) => action.id)).toEqual(['merge-pr', 'open-pr', 'dismiss']);
    expect((await r.watcher.status(r.sessionId)).prs[0]).toMatchObject({ ready: true, review: 'APPROVED', checks: 'green' });
    // Merge PR (the click): gh pr merge with the repo's default (SQUASH, from gh repo view).
    const env = { ...r.w.env, FAKE_GH_REPO: path.join(r.w.root, 'repo.json') };
    const watcher = new PrWatcher({ store: r.w.store, bus: r.bus, gh: new CiGh({ gh: fakeGhCommand(), env }), send: async () => undefined, notices: r.items, cleanup: async (id) => void (await r.m.checkPullRequest(id)) });
    r.items.useCi(watcher);
    const closed = await r.items.act(item?.id ?? '', 'merge-pr');
    expect(closed.state).toBe('closed');
    expect(closed.closedAction).toBe('merge-pr');
    const merge = (await r.w.ghCalls()).find((call) => call.argv[0] === 'pr' && call.argv[1] === 'merge');
    expect(merge?.argv).toEqual(['pr', 'merge', '12', '--squash']);
    expect((await watcher.status(r.sessionId)).prs[0]).toMatchObject({ state: 'MERGED', ready: false });
    // The clean-up offer: D30's "PR merged" item with Remove worktree.
    const cleanup = await until(async () => (await r.open(WORKTREE_REMOVABLE))[0], 'the PR merged item');
    expect(cleanup.actions.map((action) => action.id)).toEqual(['remove-worktree', 'keep']);
    await watcher.close();
  });

  it('a refused Merge PR (checks went red meanwhile) leaves the item open with the reason', async () => {
    const r = await make();
    await r.pr({ statusCheckRollup: [green()], reviewDecision: 'APPROVED' });
    await r.watcher.check(r.worktreeId);
    const [item] = await r.open(CI_READY);
    await r.pr({ statusCheckRollup: [running()] });
    await expect(r.items.act(item?.id ?? '', 'merge-pr')).rejects.toThrow(/still running/);
    expect((await r.w.ghCalls()).some((call) => call.argv[1] === 'merge')).toBe(false);
  });

  it('polling stops once the PR is merged or closed (the tick asks gh no more)', async () => {
    const r = await make();
    await r.pr({ statusCheckRollup: [running()] });
    await r.watcher.check(r.worktreeId);
    const row = await r.w.store.prWatch.get(r.worktreeId);
    // Running checks: read again after ci.pendingPollMinutes (2 min by default).
    expect(Date.parse(row?.nextAt ?? '') - Date.parse(row?.checkedAt ?? '')).toBe(2 * 60_000);
    await r.w.store.prWatch.update(r.worktreeId, { nextAt: null });
    await r.pr({ state: 'CLOSED', statusCheckRollup: [green()] });
    await r.watcher.tick();
    expect((await r.w.store.prWatch.get(r.worktreeId))?.prState).toBe('CLOSED');
    const calls = (await r.w.ghCalls()).length;
    await r.watcher.tick();
    await r.watcher.tick();
    expect((await r.w.ghCalls()).length).toBe(calls);
    // Another worktree's PR is merged: the same.
    await r.pr({ state: 'MERGED' });
    await r.watcher.tick();
    expect((await r.w.ghCalls()).length).toBe(calls);
  });

  it('idle PRs are read every ci.idlePollMinutes; a PR found at a turn\'s end (the agent opened it) is watched', async () => {
    const r = await make();
    await r.w.store.settings.set('ci.idlePollMinutes', 15);
    await r.w.store.worktrees.update(r.worktreeId, { prState: null, prNumber: null });
    await r.pr({ statusCheckRollup: [green()], reviewDecision: 'REVIEW_REQUIRED' });
    await r.watcher.discover(r.sessionId);
    const row = await r.w.store.prWatch.get(r.worktreeId);
    expect(row).toMatchObject({ prNumber: 12, prState: 'OPEN', checks: 'green', ready: false });
    expect(Date.parse(row?.nextAt ?? '') - Date.parse(row?.checkedAt ?? '')).toBe(15 * 60_000);
  });

  it('Plans owns the merge of its items: no "ready to merge" item from the watcher', async () => {
    const r = await make({ owner: true });
    await r.pr({ statusCheckRollup: [green()], reviewDecision: 'APPROVED' });
    await r.watcher.check(r.worktreeId);
    expect(await r.open(CI_READY)).toHaveLength(0);
    expect((await r.watcher.status(r.sessionId)).prs[0]).toMatchObject({ ready: true });
  });

  it('a closed session gets no message', async () => {
    const r = await make();
    await r.w.store.sessions.update(r.sessionId, { closedAt: new Date().toISOString() });
    await r.pr({ statusCheckRollup: [red()] });
    await r.watcher.check(r.worktreeId);
    expect(r.sent).toEqual([]);
  });
});
