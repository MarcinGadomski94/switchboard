import { expect, test } from '@playwright/test';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { type QuestionWorld, startQuestionWorld } from './question-world.ts';
import { stubToolProbes } from './probes.ts';
import { expectNoOverflow } from './responsive-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · lane R · v2 Insights (`/insights`) on the real D108 API with the classic
 * Insights spec's seeded world (two sessions in two folders, six turns of
 * yesterday and the day before, six finished tasks on two models, one reopened,
 * the Default account's readings): the tiles and charts show the numbers, the
 * range and filters live in the address and scope them, Today is empty, the
 * forecast and the suggestion show, and the page fits a phone.
 */
test.describe.configure({ mode: 'serial' });

let world: QuestionWorld;
const MIN = 60_000;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  world = await startQuestionWorld('v2-insights', { env: { ...V2_SERVER_ENV } });
  const store = await openStore(storeFile(world.dataDir));
  try {
    const now = Date.now();
    const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
    const acme = await store.sessions.create({ name: 'acme-upload', title: 'Acme upload flow', claudeSessionId: 'c-acme', root: '/work/acme', model: 'opus' } as Parameters<typeof store.sessions.create>[0]);
    const docs = await store.sessions.create({ name: 'acme-docs', title: 'Acme docs', claudeSessionId: 'c-docs', root: '/work/docs', model: 'haiku' } as Parameters<typeof store.sessions.create>[0]);
    const result = (tokens: number, model: string) => ({ type: 'result', subtype: 'success', isError: false, durationMs: 120_000, tokens, usage: { input: 100, output: tokens - 100, cacheWrite: 0, cacheRead: 20_000 }, model });
    for (let i = 0; i < 4; i += 1) await store.events.append({ sessionId: acme.id, kind: 'ok', label: 'Done', ts: at(86_400_000 + i * MIN), payload: result(10_000, 'claude-opus-5-5') });
    for (let i = 0; i < 2; i += 1) await store.events.append({ sessionId: docs.id, kind: 'ok', label: 'Done', ts: at(2 * 86_400_000 + i * MIN), payload: result(2_000, 'claude-haiku-4-5') });
    const todo = store.db.prepare(
      `INSERT INTO todo_actuals (todo_id, session_id, folder, title, estimate_minutes, actual_ms, actual_tokens, completed_at, priority, provider, model, profile_id, usage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'low', 'claude', ?, 'default-claude', ?)`,
    );
    const split = JSON.stringify({ input: 1_000, output: 10_000, cacheWrite: 20_000, cacheRead: 200_000, unsplit: 0 });
    [10, 30, 50].forEach((minutes, i) => todo.run(`o${i}`, acme.id, '/work/acme', `Upload step ${i + 1}`, 20, minutes * MIN, 31_000, at(86_400_000 + i * MIN), 'claude-opus-5-5', split));
    [4, 10, 6].forEach((minutes, i) => todo.run(`h${i}`, docs.id, '/work/docs', `Docs page ${i + 1}`, 10, minutes * MIN, 31_000, at(2 * 86_400_000 + i * MIN), 'claude-haiku-4-5', split));
    store.db.prepare("INSERT INTO todo_reopens (todo_id, session_id, reopened_at) VALUES ('o1', ?, ?)").run(acme.id, at(86_400_000));
    const reset = new Date(now + 2 * 3_600_000).toISOString();
    const weekReset = new Date(now + 3 * 86_400_000).toISOString();
    for (const [ago, five, week] of [
      [60 * MIN, 20, 50],
      [30 * MIN, 30, 51],
      [0, 40, 52],
    ] as const) {
      await store.usage.add({ source: 'rate_limit_event', profileId: 'default-claude', receivedAt: at(ago), fiveHourPct: five, fiveHourResetsAt: reset, sevenDayPct: week, sevenDayResetsAt: weekReset, raw: {} });
    }
  } finally {
    await store.close();
  }
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

const tileValue = (id: string) => `[data-testid="v2-insights-tile-${id}"] .v2-ins-v`;

test('This week shows the seeded numbers, charts, forecast and suggestion', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`${world.baseUrl}/insights?range=week`);
  await expect(page.getByTestId('v2-page-insights')).toBeVisible();
  await expect(page.locator('[data-testid="v2-insights-range"] [aria-pressed="true"]')).toHaveText('This week');
  await expect(page.locator(tileValue('tokens'))).toHaveText('44k');
  await expect(page.locator(tileValue('time'))).toHaveText('12m');
  await expect(page.locator(tileValue('rework'))).toHaveText('17%');
  await expect(page.locator(tileValue('estimates'))).toHaveText('67%');
  await expect(page.locator(tileValue('prices'))).toHaveText('Example prices');
  await expect(page.locator(tileValue('cost'))).toHaveText(/^~\$\d/);
  // Charts: inline SVG with a text alternative.
  const vbars = page.getByTestId('v2-insights-vbars');
  await expect(vbars).toHaveAttribute('role', 'img');
  await expect(vbars).toHaveAttribute('aria-label', /^Tokens per day: .*Today 0$/);
  await expect(vbars.locator('rect')).toHaveCount(7);
  await expect(page.getByTestId('v2-insights-cost-bars').locator('.v2-ins-hbar')).toHaveCount(2);
  await expect(page.getByTestId('v2-insights-accuracy-bars').locator('.v2-ins-hbar')).toHaveCount(4);
  await expect(page.getByTestId('v2-insights-forecast')).toContainText('Default');
  await expect(page.getByTestId('v2-insights-suggestion')).toContainText('Suggestion:');
  await expect(page.getByTestId('v2-insights-suggestion-switch')).toHaveAttribute('href', /^\/settings\/advanced\/sessions\?suggestRule=/);
  await expect(page.getByTestId('v2-insights-back')).toHaveAttribute('href', '/settings/usage');
});

test('the filters scope the numbers and live in the address; Today is empty', async ({ page }) => {
  await page.goto(`${world.baseUrl}/insights?range=week`);
  await expect(page.locator(tileValue('tokens'))).toHaveText('44k');
  const folder = page.getByTestId('v2-insights-folder');
  await expect(folder.locator('option')).toHaveText(['All folders', 'acme', 'docs']);
  await folder.selectOption('/work/acme');
  await expect(page).toHaveURL(/range=week&folder=%2Fwork%2Facme/);
  await expect(page.locator(tileValue('tokens'))).toHaveText('40k');
  await page.getByTestId('v2-insights-model').selectOption('claude-haiku-4-5');
  await expect(page).toHaveURL(/model=claude-haiku-4-5/);
  await expect(page.locator(tileValue('tokens'))).toHaveText('0');
  await expect(page.getByTestId('v2-insights-empty')).toBeVisible();
  // Reload keeps them.
  await page.reload();
  await expect(page.getByTestId('v2-insights-folder')).toHaveValue('/work/acme');
  await expect(page.getByTestId('v2-insights-model')).toHaveValue('claude-haiku-4-5');
  // Back to everything, then Today (the default range): nothing today.
  await page.goto(`${world.baseUrl}/insights?range=week&folder=/work/docs`);
  await expect(page.locator(tileValue('tokens'))).toHaveText('4k');
  await page.locator('[data-testid="v2-insights-range"] button', { hasText: 'Today' }).click();
  await expect(page).toHaveURL(/\/insights\?folder=%2Fwork%2Fdocs$/);
  await expect(page.getByTestId('v2-insights-sub')).toContainText('Today, across every computer.');
  await expect(page.getByTestId('v2-insights-empty')).toBeVisible();
  // Today's chart still shows the last 7 days.
  await expect(page.getByTestId('v2-insights-vbars').locator('rect')).toHaveCount(7);
  await page.getByTestId('v2-insights-computer').selectOption('local');
  await expect(page).toHaveURL(/computer=local/);
});

test('phone: the tiles and charts fit 390 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/insights?range=week`);
  await expect(page.locator(tileValue('tokens'))).toHaveText('44k');
  await expect(page.getByTestId('v2-insights-vbars')).toBeVisible();
  await expectNoOverflow(page, 390, 'v2 insights at 390');
  const select = await page.getByTestId('v2-insights-folder').boundingBox();
  expect(select?.height ?? 0).toBeGreaterThanOrEqual(44);
});
