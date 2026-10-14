import { type Page, expect, test } from '@playwright/test';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { type QuestionWorld, startQuestionWorld } from './question-world.ts';
import { stubToolProbes } from './probes.ts';
import { expectNoOverflow } from './responsive-world.ts';
import { writeReport } from './visual/harness.ts';

/**
 * D108 · the Insights page (`docs/insights.md`) on the real server: a small seeded world
 * (two sessions in two folders, six turns, six completed todos on two models, the Default
 * account's readings). Every section renders its numbers; the filters scope them and live in
 * the address; a suggested rule opens Model by task pre-filled (nothing saved); prices edited in
 * Settings drop the "example prices" mark; at 360 / 768 / 1366 / 1920 nothing overflows the
 * window. Screenshots: `test-results/visual/insights-*.png` (and `docs/visual/` with
 * `SWITCHBOARD_VISUAL_REPORT=1`).
 */
test.describe.configure({ mode: 'serial' });

let world: QuestionWorld;
const MIN = 60_000;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  world = await startQuestionWorld('insights');
  const store = await openStore(storeFile(world.dataDir));
  try {
    const now = Date.now();
    const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
    const acme = await store.sessions.create({ name: 'acme-upload', title: 'Acme upload flow', claudeSessionId: 'c-acme', root: '/work/acme', model: 'opus' } as Parameters<typeof store.sessions.create>[0]);
    const docs = await store.sessions.create({ name: 'acme-docs', title: 'Acme docs', claudeSessionId: 'c-docs', root: '/work/docs', model: 'haiku' } as Parameters<typeof store.sessions.create>[0]);
    const result = (tokens: number, model: string) => ({ type: 'result', subtype: 'success', isError: false, durationMs: 120_000, tokens, usage: { input: 100, output: tokens - 100, cacheWrite: 0, cacheRead: 20_000 }, model });
    // Opus: 4 turns × 10,000 tokens (yesterday); Haiku: 2 turns × 2,000 (two days ago).
    for (let i = 0; i < 4; i += 1) await store.events.append({ sessionId: acme.id, kind: 'ok', label: 'Done', ts: at(86_400_000 + i * MIN), payload: result(10_000, 'claude-opus-5-5') });
    for (let i = 0; i < 2; i += 1) await store.events.append({ sessionId: docs.id, kind: 'ok', label: 'Done', ts: at(2 * 86_400_000 + i * MIN), payload: result(2_000, 'claude-haiku-4-5') });
    await store.events.append({ sessionId: acme.id, kind: 'text', label: 'Reverted', ts: at(86_400_000 - MIN), payload: { type: 'lifecycle', action: 'reverted', turn: 3 } });
    const todo = store.db.prepare(
      `INSERT INTO todo_actuals (todo_id, session_id, folder, title, estimate_minutes, actual_ms, actual_tokens, completed_at, priority, provider, model, profile_id, usage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'low', 'claude', ?, 'default-claude', ?)`,
    );
    const split = JSON.stringify({ input: 1_000, output: 10_000, cacheWrite: 20_000, cacheRead: 200_000, unsplit: 0 });
    // Opus 10 / 30 / 50 min against 20; Haiku 4 / 10 / 6 against 10 (the unit fixture's numbers).
    [10, 30, 50].forEach((minutes, i) => todo.run(`o${i}`, acme.id, '/work/acme', `Upload step ${i + 1}`, 20, minutes * MIN, 31_000, at(86_400_000 + i * MIN), 'claude-opus-5-5', split));
    [4, 10, 6].forEach((minutes, i) => todo.run(`h${i}`, docs.id, '/work/docs', `Docs page ${i + 1}`, 10, minutes * MIN, 31_000, at(2 * 86_400_000 + i * MIN), 'claude-haiku-4-5', split));
    store.db.prepare("INSERT INTO todo_reopens (todo_id, session_id, reopened_at) VALUES ('o1', ?, ?)").run(acme.id, at(86_400_000));
    // The Default account's 5-hour window: 20 → 40 % over the last hour, resetting in 2 hours.
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

async function openInsights(page: Page, query = 'period=7d'): Promise<void> {
  await page.goto(`${world.baseUrl}/insights?${query}`);
  await expect(page.getByTestId('view-insights')).toBeVisible();
  await expect(page.getByTestId('insights-suggestions')).toBeVisible();
}

test('every section renders the seeded numbers; the filters scope them and live in the address', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await openInsights(page);
  await expect(page.getByTestId('tile-turns').locator('.sb-ins-tile-value')).toHaveText('6');
  await expect(page.getByTestId('tile-tokens').locator('.sb-ins-tile-value')).toHaveText('44k');
  await expect(page.getByTestId('by-folder').locator('tbody th')).toHaveText(['acme', 'docs']);
  await expect(page.getByTestId('by-session').locator('tbody th')).toHaveText(['Acme upload flow', 'Acme docs']);
  await expect(page.getByTestId('trend-table').locator('tbody tr')).toHaveCount(7);
  // Estimates: 6 todos, median 0.8×.
  await expect(page.getByTestId('accuracy-all').locator('h3')).toHaveText('All · 6 todos · median 0.8×');
  await expect(page.getByTestId('accuracy-all').locator('.sb-ins-hcount')).toHaveText(['1', '2', '2', '1']);
  // Outcomes: Opus 1 of 3 reopened, 1 revert in 4 turns = 25 per 100.
  const opus = page.getByTestId('outcomes-table').locator('tr', { hasText: 'claude-opus-5-5' });
  await expect(opus.locator('td')).toHaveText(['3', '33% (1)', '4', '25.0']);
  // Cost: example prices, marked; 3 × $0.344 + 3 × $0.0096 = $1.06.
  await expect(page.getByTestId('cost-prices')).toContainText('Example prices — edit in Settings');
  await expect(page.getByTestId('tile-cost-total').locator('.sb-ins-tile-value')).toHaveText('$1.06');
  await expect(page.getByTestId('cost-top').locator('tbody tr').first()).toContainText('$0.34');
  // Forecast: 20 %/h, 40 % now, reset in 2 h → ~80 % by the reset.
  await expect(page.getByTestId('forecast-five_hour')).toHaveAttribute('data-verdict', 'holds');
  await expect(page.getByTestId('forecast-five_hour')).toContainText('reaches ~80% by its reset');
  // Suggestion: Haiku over Opus.
  await expect(page.getByTestId('suggestion')).toHaveCount(1);
  await expect(page.getByTestId('suggestion')).toContainText('claude-haiku-4-5 finished 3 low-priority todos estimated ≤ 30 min with 0 reopened, at 1/36 the cost of claude-opus-5-5');

  // A model filter: in the address, every section follows.
  await page.getByTestId('filter-model').selectOption('claude-haiku-4-5');
  await expect(page).toHaveURL(/model=claude-haiku-4-5/);
  await expect(page.getByTestId('tile-turns').locator('.sb-ins-tile-value')).toHaveText('2');
  await expect(page.getByTestId('tile-cost-total').locator('.sb-ins-tile-value')).toHaveText('$0.0288');
  // Period: custom range.
  await page.getByTestId('filter-period').selectOption('custom');
  await expect(page.getByTestId('filter-from')).toBeVisible();
  await expect(page).toHaveURL(/period=custom&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  // A reload keeps the filters.
  await page.reload();
  await expect(page.getByTestId('filter-model')).toHaveValue('claude-haiku-4-5');
  // The sidebar's Insights cell is the current page.
  await expect(page.getByTestId('nav-insights')).toHaveAttribute('aria-current', 'page');
});

test('a suggested rule opens Model by task pre-filled; nothing is saved until Save', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await openInsights(page);
  await page.getByTestId('suggestion-open').click();
  await expect(page).toHaveURL(/\/settings\/sessions$/);
  const rules = page.locator('[data-row="model-rules"]').getByTestId('model-rule');
  await expect(rules).toHaveCount(1);
  await expect(rules.first().getByTestId('rule-priority')).toHaveValue('low');
  await expect(rules.first().getByTestId('rule-estimate')).toHaveValue('at-most');
  await expect(rules.first().getByTestId('rule-minutes')).toHaveValue('30');
  await expect(rules.first().getByTestId('rule-model')).toHaveValue('haiku');
  await expect(page.getByTestId('model-rules-save')).toBeEnabled();
  const stored = await page.evaluate(async () => ((await (await fetch('/api/settings')).json()) as Record<string, unknown>)['sessions.modelRules']);
  expect(stored).toEqual([]);
});

test('prices edited in Settings are used and no longer marked as examples', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`${world.baseUrl}/settings/notify`);
  const row = page.locator('[data-row="insights-prices"]');
  await expect(row.getByTestId('prices-example')).toBeVisible();
  await expect(row.getByTestId('price-row')).toHaveCount(4);
  await row.getByTestId('prices-currency').fill('EUR');
  // Opus output 20 → 10 per 1M.
  await row.getByTestId('price-row').nth(1).getByTestId('price-output').fill('10');
  await row.getByTestId('prices-save').click();
  await expect(row.getByTestId('prices-example')).toHaveCount(0);
  await openInsights(page);
  await expect(page.getByTestId('cost-prices')).toContainText('Prices in EUR, from Settings');
  // Opus 3 × (0.344 − 0.1) + Haiku 3 × 0.0096 = 0.7608 → €0.76.
  await expect(page.getByTestId('tile-cost-total').locator('.sb-ins-tile-value')).toHaveText('€0.76');
  // Back to the examples.
  await page.goto(`${world.baseUrl}/settings/notify`);
  await page.locator('[data-row="insights-prices"]').getByTestId('prices-reset').click();
  await expect(page.locator('[data-row="insights-prices"]').getByTestId('prices-example')).toBeVisible();
});

for (const width of [360, 768, 1366, 1920]) {
  test(`responsive at ${width} px: every section, nothing past the window`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openInsights(page);
    for (const id of ['insights-time', 'insights-estimates', 'insights-outcomes', 'insights-cost', 'insights-forecast', 'insights-suggestions']) await expect(page.getByTestId(id)).toBeAttached();
    await expectNoOverflow(page, width, `Insights at ${width}`);
    // The filters stay one block above the sections, inside the window.
    const filters = await page.getByTestId('insights-filters').boundingBox();
    expect(filters!.x + filters!.width).toBeLessThanOrEqual(width + 1);
    // The page's body scrolls inside the shell: a window as tall as its content for the screenshot.
    const height = await page.getByTestId('insights-body').evaluate((el) => el.scrollHeight + el.getBoundingClientRect().top);
    await page.setViewportSize({ width, height: Math.ceil(height) + 20 });
    await expect(page.getByTestId('insights-suggestions')).toBeVisible();
    await writeReport({ [`insights-${width}.png`]: await page.screenshot() });
  });
}
