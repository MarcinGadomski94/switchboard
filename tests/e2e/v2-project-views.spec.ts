import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { Plan, PlanEdge, PlanItem } from '../../src/core/plans.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fixes after 2.0 → *Steps, Board and Timeline in the Graph's look* (`src/web/v2/projects/views.tsx`):
 * a 10-step project over three repositories, served to the page as `GET /api/plans/{id}` (a real
 * server serves the app; the step actions this spec uses are routed too). Every view opens with
 * the Graph's header; Steps groups by state or repository, a working step shows its ring, meta and
 * estimate bar; a stopped step's click opens its details with Restart first (D139); a Board card
 * glides to its new column when its step changes state; the Timeline lights up the hover path;
 * reduced motion stops every animation; a phone (390 × 844) shows Steps. Light and dark
 * screenshots go to `test-results/v2-project-{steps,board,timeline}-*.png`.
 */

let tmp: string;
let server: ServerProcess;

const PLAN_ID = 'views-sample';
const NOW = Date.now();
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const REPOS = ['acme-api', 'acme-web', 'acme-sdk'];

function item(n: number, id: string, title: string, solutions: readonly string[], patch: Partial<PlanItem> = {}): PlanItem {
  return {
    id,
    todoId: `t-${id}`,
    key: `ACME-${n}`,
    title,
    hold: false,
    solutions,
    state: 'waiting',
    reason: null,
    note: null,
    storedState: 'pending',
    waitingOn: null,
    dependsOn: [],
    runSessionId: null,
    branch: null,
    prUrl: null,
    checks: null,
    developerMerges: false,
    developerConfirms: false,
    estimateMinutes: 45,
    actualMinutes: null,
    onCriticalPath: false,
    position: n,
    startedAt: null,
    waitingSince: null,
    mergedAt: null,
    doneAt: null,
    spans: [],
    ...patch,
  };
}

function samplePlan(): Plan {
  const [api, web, sdk] = REPOS.map((repo) => [repo]) as [string[], string[], string[]];
  const edges: PlanEdge[] = [
    ['a1', 'a2'],
    ['a1', 'a3'],
    ['s1', 's2'],
    ['a2', 'w2'],
    ['w1', 'w2'],
    ['a2', 's2'],
    ['w2', 'w3'],
    ['s2', 'w3'],
    ['a3', 'x1'],
    ['w3', 'x1'],
  ].map(([from, to]) => ({ from: from as string, to: to as string }));
  const items = [
    item(1, 'a1', 'Scaffold the Acme API', api, { state: 'done', storedState: 'done', actualMinutes: 38, startedAt: ago(200), doneAt: ago(162) }),
    item(2, 'w1', 'Scaffold the web app', web, { state: 'needs-you', storedState: 'running', reason: 'Which port should the web app use?', startedAt: ago(90), runSessionId: 'run-w1' }),
    item(3, 's1', 'Scaffold the SDK', sdk, { state: 'ready' }),
    item(4, 'a2', 'Orders endpoints with paging and filters', api, { state: 'running', storedState: 'running', startedAt: ago(25), estimateMinutes: 60 }),
    item(5, 'a3', 'Webhooks for order events', api, { state: 'stopped', storedState: 'running', stoppedBy: 'error', reason: 'The agent stopped with an error', startedAt: ago(70), runSessionId: 'run-a3' }),
    item(6, 's2', 'SDK client for orders', sdk),
    item(7, 'w2', 'Orders page in the web app', web),
    item(8, 'w3', 'Order details with live status', web),
    item(9, 'x1', 'Shared error codes across the API and the web app', [REPOS[0] as string, REPOS[1] as string]),
    item(10, 'x2', 'Release notes and docs', [], { state: 'ready-to-merge', storedState: 'done', startedAt: ago(60), actualMinutes: 20 }),
  ].map((entry) => ({ ...entry, dependsOn: edges.filter((edge) => edge.to === entry.id).map((edge) => edge.from) }));
  return {
    id: PLAN_ID,
    title: 'Acme orders',
    sourceSessionId: 'views-source',
    targetBranch: 'feature/acme-orders',
    allowProtectedTarget: false,
    repos: REPOS,
    baseBranch: 'dev',
    mergeMode: 'developer',
    maxConcurrency: 3,
    usageThreshold: 85,
    answers: null,
    state: 'running',
    external: null,
    held: null,
    pausedReason: null,
    items,
    edges,
    criticalPath: { itemIds: [], minutes: 0 },
    progress: { done: 1, total: 10, percent: 10 },
    estimatedMinutesLeft: 300,
    createdAt: ago(300),
    updatedAt: ago(1),
    startedAt: ago(240),
    finishedAt: null,
    machine: null,
  };
}

/** Serves the sample plan; Restart on the stopped step answers it running (the board card then moves). */
async function serve(page: Page): Promise<void> {
  await stubToolProbes(page);
  let plan = samplePlan();
  await page.route(new RegExp(`/api/plans/${PLAN_ID}(\\?.*)?$`), (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, json: plan }) : route.fallback()));
  await page.route(new RegExp(`/api/plans/${PLAN_ID}/items/a3/restart$`), (route) => {
    plan = { ...plan, items: plan.items.map((entry) => (entry.id === 'a3' ? { ...entry, state: 'running', storedState: 'running', stoppedBy: undefined, reason: null, startedAt: ago(1) } : entry)) };
    return route.fulfill({ status: 200, json: plan });
  });
  await page.route(new RegExp(`/api/plans/${PLAN_ID}/`), (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, json: [] }) : route.fallback()));
}

async function openView(page: Page, name: 'Steps' | 'Board' | 'Graph' | 'Timeline'): Promise<void> {
  await page.getByTestId('v2-project-views').getByRole('button', { name }).click();
  await expect(page.getByTestId('v2-project-view')).toHaveAttribute('data-view', name.toLowerCase());
}

const step = (page: Page, key: string) => page.locator(`[data-testid="v2-step"][data-key="${key}"]`);
const card = (page: Page, key: string) => page.locator(`[data-testid="v2-board-card"][data-key="${key}"]`);
const row = (page: Page, key: string) => page.locator(`[data-testid="v2-timeline-row"][data-key="${key}"]`);
const SUMMARY = '1 of 10 done · 1 working · 3 need you';

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-v2-project-views');
  server = await startServer({ SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), ...V2_SERVER_ENV });
});

test.afterAll(async () => {
  await server?.stop();
  await removeTempDir(tmp);
});

test('every view opens with the Graph’s header; light and dark screenshots at 1440', async ({ page }) => {
  test.setTimeout(90_000);
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${server.baseUrl}/projects/${PLAN_ID}`);
  for (const name of ['Steps', 'Board', 'Timeline'] as const) {
    await openView(page, name);
    const view = page.getByTestId('v2-project-view');
    await expect(view.getByTestId('v2-project-progress')).toBeVisible();
    await expect(view.getByTestId('v2-progress-summary')).toHaveText(SUMMARY);
    await expect(view.locator('.v2-p-ghead .v2-p-ghead-pct')).toHaveText('10%');
    // The bar by state: done, working, needs you, approval, failed, ready, waiting.
    await expect(view.locator('[data-testid="v2-progress-bar"] span')).toHaveCount(7);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.mouse.move(0, 0);
      await view.screenshot({ path: `test-results/v2-project-${name.toLowerCase()}-1440-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  }
  // The Graph has the same header (its own copy for now, the same classes and words).
  await openView(page, 'Graph');
  await expect(page.locator('[data-testid="v2-project-view"] .v2-p-ghead')).toBeVisible();
  await expect(page.getByTestId('v2-graph-summary')).toHaveText(SUMMARY);
  // Critical path: one choice for all four views (remembered).
  await page.getByTestId('v2-graph-critical').click();
  await openView(page, 'Steps');
  await expect(page.getByTestId('v2-progress-critical')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-testid="v2-step"][data-crit]')).toHaveCount(0);
  await page.getByTestId('v2-progress-critical').click();
  await expect(page.getByTestId('v2-progress-critical')).toHaveAttribute('aria-pressed', 'true');
});

test('Steps: by state or by repository; a working step has its ring, meta and estimate bar; a stopped step opens its details with Restart', async ({ page }) => {
  test.setTimeout(60_000);
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${server.baseUrl}/projects/${PLAN_ID}`);
  await openView(page, 'Steps');
  const steps = page.getByTestId('v2-steps');
  await expect(steps).toHaveAttribute('data-group', 'state');
  await expect(steps.getByTestId('v2-steps-section')).toHaveCount(4);
  await expect(steps.locator('[data-testid="v2-steps-section"]').first()).toHaveAttribute('data-section', 'needs');
  await expect(steps.locator('[data-section="needs"] [data-testid="v2-step"]')).toHaveCount(3);
  await expect(steps.getByTestId('v2-steps-done')).toContainText('1 earlier step done');

  // The working step: its ring (spinning, no icon), key, tinted chip, "Working · 25m", the estimate bar.
  const working = step(page, 'ACME-4');
  await expect(working).toHaveAttribute('data-gtone', 'working');
  await expect(working.locator('.v2-pv-ring')).toBeVisible();
  await expect(working.locator('.v2-pv-chip')).toHaveText('api');
  await expect(working.getByTestId('v2-step-state')).toHaveText(/^Working · \d+m$/);
  await expect(working.getByTestId('v2-step-eta')).toBeVisible();
  // The critical path (the longest chain still to do): 2 → 7 → 8 → 9.
  await expect(step(page, 'ACME-2')).toHaveAttribute('data-crit', 'true');
  await expect(working).not.toHaveAttribute('data-crit', /.*/);
  await expect(step(page, 'ACME-7').getByTestId('v2-step-detail')).toHaveText('Waiting on 4, 2');
  await expect(step(page, 'ACME-9').locator('.v2-pv-chip')).toHaveText('2 repos');

  // D139: a click on the stopped step opens its details, Restart first; inline Restart too.
  const stopped = step(page, 'ACME-5');
  await expect(stopped.getByTestId('v2-step-state')).toHaveText('Stopped — open to restart');
  await expect(stopped.getByTestId('v2-step-detail')).toHaveText('The agent stopped with an error');
  await expect(stopped.getByTestId('v2-step-restart')).toBeVisible();
  await stopped.getByTestId('v2-step-open').click();
  const sheet = page.getByTestId('v2-step-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button').filter({ hasText: /Restart|Open chat/ }).first()).toHaveText('Restart');
  await page.keyboard.press('Escape');
  // The ⋯ menu is still there.
  await stopped.getByTestId('v2-step-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Restart' })).toBeVisible();
  await page.keyboard.press('Escape');

  // By repository: the Graph's lanes, remembered.
  await page.getByTestId('v2-steps-group').getByRole('button', { name: 'Repository' }).click();
  await expect(steps).toHaveAttribute('data-group', 'repo');
  await expect(steps.getByTestId('v2-steps-lane')).toHaveText([/acme-api.*1\/3/s, /acme-web.*0\/3/s, /acme-sdk.*0\/2/s, /Several repositories.*0\/2/s]);
  await page.reload();
  await expect(page.getByTestId('v2-steps')).toHaveAttribute('data-group', 'repo');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.getByTestId('v2-steps').screenshot({ path: `test-results/v2-project-steps-repo-1440-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await page.getByTestId('v2-steps-group').getByRole('button', { name: 'State' }).click();
});

test('Board: columns with counts and mini rings; Restart moves the card to Working (gliding)', async ({ page }) => {
  test.setTimeout(60_000);
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${server.baseUrl}/projects/${PLAN_ID}`);
  await openView(page, 'Board');
  const col = (name: string) => page.locator(`[data-testid="v2-board-col"][data-col="${name}"]`);
  await expect(page.getByTestId('v2-board-col')).toHaveCount(4);
  await expect(col('needs').getByTestId('v2-board-count')).toHaveText('2');
  await expect(col('working').getByTestId('v2-board-count')).toHaveText('6');
  await expect(col('ready').getByTestId('v2-board-count')).toHaveText('1');
  await expect(col('done').getByTestId('v2-board-count')).toHaveText('1');
  await expect(col('needs').locator('.v2-pv-col-ring')).toBeVisible();
  // The working card leads its column, with the Graph card's ring, meta and estimate bar.
  await expect(col('working').getByTestId('v2-board-card').first()).toHaveAttribute('data-key', 'ACME-4');
  await expect(card(page, 'ACME-4').getByTestId('v2-step-eta')).toBeVisible();
  await expect(card(page, 'ACME-10').getByTestId('v2-step-combine')).toBeVisible();

  // A click on the stopped card opens its details (D139); a right-click its menu.
  await card(page, 'ACME-5').click();
  await expect(page.getByTestId('v2-step-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await card(page, 'ACME-5').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Restart' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Restart: the step works again, its card glides to Working.
  await card(page, 'ACME-5').getByTestId('v2-step-restart').click();
  await expect(card(page, 'ACME-5')).toHaveAttribute('data-col', 'working');
  await expect(col('needs').getByTestId('v2-board-count')).toHaveText('1');
  await expect(col('working').getByTestId('v2-board-count')).toHaveText('7');
  expect(await card(page, 'ACME-5').evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0);
});

test('Timeline: lanes, bars by state, arrows; hover lights up the path', async ({ page }) => {
  test.setTimeout(60_000);
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${server.baseUrl}/projects/${PLAN_ID}`);
  await openView(page, 'Timeline');
  await expect(page.getByTestId('v2-timeline-lane')).toHaveCount(4);
  await expect(page.getByTestId('v2-timeline-row')).toHaveCount(10);
  await expect(page.getByTestId('v2-timeline-arrow')).toHaveCount(10);
  await expect(row(page, 'ACME-4')).toHaveAttribute('data-gtone', 'working');
  await expect(page.locator('[data-testid="v2-timeline-arrow"][data-kind="live"]')).toHaveCount(1);
  expect(await page.locator('[data-testid="v2-timeline-arrow"][data-crit]').count()).toBeGreaterThan(0);
  await expect(page.getByTestId('v2-timeline-summary')).toContainText('Projected finish');

  await row(page, 'ACME-4').locator('.v2-pv-tl-track').hover();
  await expect(row(page, 'ACME-4')).toHaveAttribute('data-hot', 'true');
  await expect(row(page, 'ACME-1')).toHaveAttribute('data-hot', 'true');
  await expect(row(page, 'ACME-9')).toHaveAttribute('data-hot', 'true');
  await expect(row(page, 'ACME-3')).toHaveAttribute('data-hot', 'false');
  await expect(page.locator('[data-testid="v2-timeline-arrow"][data-from="ACME-1"][data-to="ACME-4"]')).toHaveAttribute('data-hot', 'true');
  await expect(page.locator('[data-testid="v2-timeline-arrow"][data-from="ACME-1"][data-to="ACME-5"]')).toHaveAttribute('data-hot', 'false');
  await page.mouse.move(2, 2);
  await expect(row(page, 'ACME-3')).not.toHaveAttribute('data-hot', /.*/);
  // A click on a row's name opens the stopped step's details; its ⋯ is the step menu.
  await row(page, 'ACME-5').locator('.v2-pv-tl-n').click();
  await expect(page.getByTestId('v2-step-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('reduced motion stops every animation in Steps, Board and Timeline', async ({ page }) => {
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${server.baseUrl}/projects/${PLAN_ID}`);
  const running = (): Promise<number> => page.evaluate(() => (document.querySelector('[data-testid="v2-project-view"]')?.getAnimations({ subtree: true }) ?? []).length);
  for (const name of ['Steps', 'Board', 'Timeline'] as const) {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openView(page, name);
    await expect.poll(running).toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(running).toBe(0);
  }
  await expect(page.locator('.v2-pv-tl-shine')).toHaveCount(0);
});

test('phone 390 × 844: Steps in the Graph’s look, no sideways scroll', async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await serve(page);
    await page.goto(`${server.baseUrl}/projects/${PLAN_ID}`);
    await expect(page.getByTestId('v2-steps')).toBeVisible();
    await expect(page.getByTestId('v2-project-progress')).toBeVisible();
    await expect(step(page, 'ACME-4').getByTestId('v2-step-eta')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    // Every row fits the screen; its ⋯ is a touch target.
    for (const key of ['ACME-2', 'ACME-4', 'ACME-5', 'ACME-10']) {
      const box = await step(page, key).boundingBox();
      expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 999) <= 390).toBe(true);
    }
    expect((await step(page, 'ACME-5').getByTestId('v2-step-menu').boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
    // The whole list in one picture: a tall phone (the app scrolls inside its shell).
    await page.setViewportSize({ width: 390, height: 2400 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByTestId('v2-steps').screenshot({ path: 'test-results/v2-project-steps-390-light.png' });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.getByTestId('v2-steps').screenshot({ path: 'test-results/v2-project-steps-390-dark.png' });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 390, height: 844 });
    // A tap on the stopped step opens its details (D139).
    await step(page, 'ACME-5').getByTestId('v2-step-open').tap();
    await expect(page.getByTestId('v2-step-sheet')).toBeVisible();
    await expect(page.getByTestId('v2-step-sheet-restart')).toBeVisible();
  } finally {
    await context.close();
  }
});
