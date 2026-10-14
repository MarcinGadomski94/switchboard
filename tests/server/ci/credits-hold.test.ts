/**
 * D109 × D103: the CI failure message goes the normal message path, so while every account is
 * out of allowance and Settings → Accounts says to pause new turns, it is held in the session
 * (`queued: "credits"`) like a message the developer typed, and counted as sent once.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { UserPayload } from '../../../src/core/event-payload.ts';
import { CiGh } from '../../../src/server/ci/gh.ts';
import { PrWatcher } from '../../../src/server/ci/watcher.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { SystemItemService } from '../../../src/server/inbox/system-items.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, waitForStatus } from '../../helpers/supervisor.ts';

let world: SupervisorWorld | undefined;
let git: GitWorld | undefined;
let watcher: PrWatcher | undefined;

afterEach(async () => {
  await watcher?.close();
  await git?.cleanup();
  await world?.cleanup();
  watcher = undefined;
  git = undefined;
  world = undefined;
});

const HOUR = 3_600_000;
const soon = (ms: number): string => new Date(Date.now() + ms).toISOString();
const epoch = (ms: number): number => Math.floor((Date.now() + ms) / 1000);

it('while new turns pause for credits, the CI failure is held in the session, not sent to the CLI', async () => {
  const w = await makeSupervisorWorld();
  world = w;
  const g = await makeGitWorld({ root: w.root, workspace: w.workspace, store: w.store });
  git = g;
  const session = await w.supervisor.start(newSession({ task: 'first task' }), w.place);
  await waitForStatus(w.store, session.id, ['done']);
  // The only account pays from credits, and the setting pauses new turns (D103).
  await w.store.usage.add({ source: 'get_usage', sessionId: null, profileId: 'default-claude', fiveHourPct: 100, fiveHourResetsAt: soon(HOUR), sevenDayPct: 99, sevenDayResetsAt: soon(48 * HOUR), raw: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: soon(HOUR) }, seven_day: { utilization: 99, resets_at: soon(48 * HOUR) }, extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 3760, utilization: null, currency: 'EUR', decimal_places: 2, spend_limit_reached: false } } } });
  await w.store.usage.add({ source: 'rate_limit_event', sessionId: null, profileId: 'default-claude', fiveHourPct: 100, fiveHourResetsAt: soon(HOUR), sevenDayPct: 100, sevenDayResetsAt: soon(48 * HOUR), raw: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: epoch(48 * HOUR), rateLimitType: 'seven_day', overageStatus: 'allowed', overageResetsAt: epoch(400 * HOUR), isUsingOverage: true, overageInUse: true } } });
  await w.accounts.setSettings({ outOfAllowance: 'pause' });
  // The session's worktree and its red PR.
  const wtPath = path.join(w.root, 'web-front-wt-ci');
  await g.git(g.web, 'worktree', 'add', '-q', '-b', 'feature/held', wtPath, 'main');
  const worktree = await w.store.worktrees.create({ repo: 'web-front', repoPath: g.web, branch: 'feature/held', path: wtPath, sessionId: session.id, prNumber: 3, prState: 'OPEN' });
  await g.setPullRequests({ 'feature/held': { number: 3, state: 'OPEN', url: 'https://github.com/acme/web-front/pull/3', headRefOid: 'ddddddd1', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/web-front/actions/runs/5/job/6' }] } });
  const logs = path.join(w.root, 'logs');
  await mkdir(logs, { recursive: true });
  await writeFile(path.join(logs, '5.log'), 'test\tRun\t2026-10-14T10:00:00Z AssertionError: held\n');
  const bus = new HubBus();
  watcher = new PrWatcher({
    store: w.store,
    bus,
    gh: new CiGh({ gh: fakeGhCommand(), env: { ...g.env, FAKE_GH_RUN_LOGS: logs } }),
    send: async (sessionId, text) => {
      await w.supervisor.sendMessage(sessionId, text, 'service');
    },
    notices: new SystemItemService({ store: w.store, bus }),
    onError: (error) => w.errors.push(error),
  });
  await watcher.check(worktree.id);
  const held = await w.supervisor.heldMessages(session.id);
  expect(held).toHaveLength(1);
  expect((held[0]?.payload as UserPayload).text).toMatch(/^CI failed: test — on PR #3/);
  expect(held[0]?.payload).toMatchObject({ queued: 'credits', delivered: false });
  expect((held[0]?.payload as UserPayload).text).toContain('AssertionError: held');
  // Counted once: reading the same red head again holds nothing more.
  await watcher.check(worktree.id);
  expect(await w.supervisor.heldMessages(session.id)).toHaveLength(1);
  expect((await watcher.status(session.id)).prs[0]).toMatchObject({ attempts: 1 });
});
