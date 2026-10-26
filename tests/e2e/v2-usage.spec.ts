import { expect, test } from '@playwright/test';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { type QuestionWorld, startQuestionWorld } from './question-world.ts';
import { stubToolProbes } from './probes.ts';
import { expectNoOverflow } from './responsive-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D134 · v2 Insights → Usage (`/insights?view=usage`) on the real API with seeded per-turn
 * data: two accounts with their own 5-hour windows (the Default: started 3 h ago, 60 % used;
 * "Acme Pro": started 1 h ago), "Acme upload" (Default, 60 turns of 1k in the window, one with
 * a subagent), "Acme docs" (Pro, one 20k turn in its window, one 2 h ago outside it, i.e. in the
 * week only). The sessions are ranked, the period and group-by switch, the pill's "See what used
 * it" opens the view filtered, a row opens the agent, the log pages, and it fits a phone.
 */
test.describe.configure({ mode: 'serial' });

let world: QuestionWorld;
let acmeId = '';
let docsId = '';
const MIN = 60_000;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  world = await startQuestionWorld('v2-usage', { env: { ...V2_SERVER_ENV } });
  const store = await openStore(storeFile(world.dataDir));
  try {
    const now = Date.now();
    const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
    const ahead = (ms: number): string => new Date(now + ms).toISOString();
    const pro = await store.profiles.create({ cli: 'claude', name: 'Acme Pro', dir: '/tmp/acme-pro', builtin: false, enabled: true, shareSettings: false, exhaustedUntil: null, exhaustedWindow: null, exhaustedText: null } as Parameters<typeof store.profiles.create>[0]);
    await store.usage.add({ source: 'rate_limit_event', profileId: 'default-claude', receivedAt: at(MIN), fiveHourPct: 60, fiveHourResetsAt: ahead(2 * 3_600_000), sevenDayPct: 30, sevenDayResetsAt: ahead(3 * 86_400_000), raw: {} });
    await store.usage.add({ source: 'rate_limit_event', profileId: pro.id, receivedAt: at(MIN), fiveHourPct: 10, fiveHourResetsAt: ahead(4 * 3_600_000), sevenDayPct: 5, sevenDayResetsAt: ahead(5 * 86_400_000), raw: {} });
    const acme = await store.sessions.create({ name: 'acme-upload', title: 'Acme upload', claudeSessionId: 'c-acme', root: '/work/acme', model: 'opus' } as Parameters<typeof store.sessions.create>[0]);
    const docs = await store.sessions.create({ name: 'acme-docs', title: 'Acme docs', claudeSessionId: 'c-docs', root: '/work/docs', model: 'sonnet', profileId: pro.id } as Parameters<typeof store.sessions.create>[0]);
    acmeId = acme.id;
    docsId = docs.id;
    const result = (output: number, model: string, modelTotals?: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }>) => ({
      type: 'result',
      subtype: 'success',
      isError: false,
      durationMs: 60_000,
      tokens: output + 100,
      usage: { input: 100, output, cacheWrite: 0, cacheRead: 8_000 },
      model,
      ...(modelTotals ? { modelTotals } : {}),
    });
    // Acme upload: 60 turns of 1k over the last 2 hours; its first turn is fresh, the last adds a haiku subagent (5k).
    let total = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    for (let i = 0; i < 60; i += 1) {
      total = { input: total.input + 100, output: total.output + 900, cacheWrite: 0, cacheRead: total.cacheRead + 8_000 };
      const totals: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = { 'claude-opus-5-5': total };
      if (i === 59) totals['claude-haiku-4-5'] = { input: 0, output: 5_000, cacheWrite: 0, cacheRead: 3_000 };
      await store.events.append({ sessionId: acme.id, kind: 'ok', label: 'Done', ts: at((120 - i * 2) * MIN), payload: result(900, 'claude-opus-5-5', totals) });
    }
    await store.events.append({ sessionId: docs.id, kind: 'ok', label: 'Done', ts: at(120 * MIN), payload: result(39_900, 'claude-sonnet-4-5') });
    await store.events.append({ sessionId: docs.id, kind: 'ok', label: 'Done', ts: at(20 * MIN), payload: result(19_900, 'claude-sonnet-4-5') });
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

const labels = (page: import('@playwright/test').Page) => page.getByTestId('v2-usage-row-label');

test('the Usage view lists the sessions of each account’s 5-hour window, ranked, with the honest note', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`${world.baseUrl}/insights`);
  await page.getByTestId('v2-insights-tabs').getByRole('tab', { name: 'Usage' }).click();
  await expect(page).toHaveURL(/\/insights\?view=usage$/);
  await expect(page.getByTestId('v2-usage')).toBeVisible();
  await expect(page.locator('[data-testid="v2-usage-period"] [aria-pressed="true"]')).toHaveText('5 hours');
  // Acme upload: 60k own + 5k by the subagent; Acme docs: 20k (its 40k turn is before Acme Pro's window).
  await expect(labels(page)).toHaveText(['Acme upload', 'Acme docs']);
  const first = page.getByTestId('v2-usage-row').first();
  await expect(first.getByTestId('v2-usage-row-tokens')).toHaveText('65k');
  await expect(first.getByTestId('v2-usage-row-share')).toHaveText('76%');
  await expect(page.getByTestId('v2-usage-window')).toHaveCount(2);
  await expect(page.getByTestId('v2-usage-info')).toContainText('Anthropic doesn’t publish the token cap');
  await expect(page.getByTestId('v2-usage-info')).toContainText('Cache reads are listed apart');
  // The subagent breakdown.
  await first.getByTestId('v2-usage-row-agents').click();
  await expect(first.getByTestId('v2-usage-agents')).toContainText('claude-haiku-4-5: 5k');
  // The chart: top sessions stacked, with a legend and a text alternative.
  await expect(page.getByTestId('v2-usage-legend')).toContainText('Acme upload');
  await expect(page.getByTestId('v2-usage-stack')).toHaveAttribute('aria-label', /^Tokens over time: Acme upload 65k, Acme docs 20k$/);
});

test('switching the period and the group-by', async ({ page }) => {
  await page.goto(`${world.baseUrl}/insights?view=usage`);
  await expect(labels(page)).toHaveText(['Acme upload', 'Acme docs']);
  await page.locator('[data-testid="v2-usage-period"] button', { hasText: 'Week' }).click();
  await expect(page).toHaveURL(/view=usage&period=week/);
  // The week holds Acme docs' 40k turn too.
  await expect(labels(page)).toHaveText(['Acme upload', 'Acme docs']);
  await expect(page.getByTestId('v2-usage-row').nth(1).getByTestId('v2-usage-row-tokens')).toHaveText('60k');
  await page.getByTestId('v2-usage-group').selectOption('model');
  await expect(page).toHaveURL(/groupBy=model/);
  // Opus and Sonnet tie at 60k: the one with more cache reads first.
  await expect(labels(page)).toHaveText(['claude-opus-5-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']);
  await page.getByTestId('v2-usage-group').selectOption('account');
  await expect(labels(page)).toHaveText(['Default', 'Acme Pro']);
  await page.reload();
  await expect(page.getByTestId('v2-usage-group')).toHaveValue('account');
});

test('the pill’s “See what used it” opens the view filtered to the account’s window, with the estimate', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`${world.baseUrl}/`);
  await page.getByTestId('v2-status-pill').click();
  const pop = page.getByTestId('v2-status-pop');
  const account = pop.getByTestId('v2-pill-account').filter({ hasText: 'Acme Pro' });
  await account.getByTestId('v2-pill-see-usage').click();
  await expect(page).toHaveURL(/\/insights\?view=usage&account=/);
  await expect(page.getByTestId('v2-usage-account')).toHaveValue(/.+/);
  await expect(labels(page)).toHaveText(['Acme docs']);
  // One account in its own window: the share × its 10 % as a labelled estimate.
  await expect(page.getByTestId('v2-usage-row-estimate')).toHaveText('≈ 10% of the 5-hour limit (estimate)');
  await expect(page.getByTestId('v2-usage-info')).toContainText('is an estimate');
});

test('opening an agent from a row (the peek, then its full view)', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`${world.baseUrl}/insights?view=usage`);
  await page.getByTestId('v2-usage-row').filter({ hasText: 'Acme docs' }).getByTestId('v2-usage-row-open').click();
  await expect(page.getByTestId('v2-agent-peek')).toBeVisible();
  await expect(page.getByTestId('v2-agent-peek-name')).toHaveText('Acme docs');
  await page.getByTestId('v2-agent-peek-full').click();
  await expect(page).toHaveURL(new RegExp(`/agents/${docsId}`));
});

test('the log pages, filters to one session and offers the CSV', async ({ page }) => {
  // Last 7 days: every seeded turn (62), whatever the windows' readings say by now.
  await page.goto(`${world.baseUrl}/insights?view=usage&period=7d`);
  const log = page.getByTestId('v2-usage-log');
  await expect(log.getByTestId('v2-usage-log-row')).toHaveCount(50);
  await expect(log.getByTestId('v2-usage-page')).toHaveText('Page 1 of 2');
  await log.getByTestId('v2-usage-next').click();
  await expect(page).toHaveURL(/page=1/);
  await expect(log.getByTestId('v2-usage-log-row')).toHaveCount(12);
  await expect(log.getByTestId('v2-usage-page')).toHaveText('Page 2 of 2');
  await log.getByTestId('v2-usage-prev').click();
  await expect(log.getByTestId('v2-usage-page')).toHaveText('Page 1 of 2');
  // Only Acme docs' replies.
  await page.getByTestId('v2-usage-row').filter({ hasText: 'Acme docs' }).getByTestId('v2-usage-row-log').click();
  await expect(page).toHaveURL(new RegExp(`group=${docsId}`));
  await expect(log.getByTestId('v2-usage-log-row')).toHaveCount(2);
  await expect(log).toContainText('Only “Acme docs”.');
  await log.getByTestId('v2-usage-log-all').click();
  await expect(log.getByTestId('v2-usage-log-row')).toHaveCount(50);
  const csv = await page.request.get(`${world.baseUrl}${(await log.getByTestId('v2-usage-csv').getAttribute('href')) ?? ''}`);
  expect(csv.status()).toBe(200);
  expect((await csv.text()).trim().split('\r\n')).toHaveLength(63);
  expect(acmeId).not.toBe('');
});

test('phone: the view fits 390 px and a row opens the agent’s page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/insights?view=usage`);
  await expect(labels(page)).toHaveText(['Acme upload', 'Acme docs']);
  await expect(page.getByTestId('v2-usage-stack')).toBeVisible();
  await expectNoOverflow(page, 390, 'v2 usage at 390');
  const select = await page.getByTestId('v2-usage-group').boundingBox();
  expect(select?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.getByTestId('v2-usage-row').first().getByTestId('v2-usage-row-open').click();
  await expect(page).toHaveURL(new RegExp(`/agents/${acmeId}`));
});
