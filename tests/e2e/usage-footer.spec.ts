import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { SystemInfo } from '../../src/core/api.ts';
import { readingFromGetUsage } from '../../src/core/usage.ts';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D17 oracle (E2E) on the real code path (no demo seed, D13): `node
 * src/server/main.ts` with the fake CLIs and a temp data folder. The usage meter
 * reads its newest `get_usage` reading from the database, as the poller / a live
 * session would have stored it (the reading below uses the CLI's recorded shape,
 * with resets ahead of now; the poller's own path runs against fake-claude in
 * tests/server/usage/wire.test.ts). The footer shows **Session** and **Week** rows
 * instead of the prototype's one "Max" row, and a **Fable** row because that
 * model's weekly limit is in use; a model at 0 % that is not active has no row.
 * Fable at 93 % warns once (toast). RAM is the machine's memory in use (vm_stat on
 * macOS, /proc/meminfo on Linux).
 */

const MIN = 60_000;
let tmp: string;
let server: ServerProcess;
let seededAt = 0;

/** A `get_usage` answer in the recorded M0.3 shape (tools/fake-claude/fixtures/usage-ctl.ndjson), resets relative to `now`. */
function usageAnswer(now: number): Record<string, unknown> {
  const at = (ms: number): string => new Date(now + ms).toISOString().replace('Z', '+00:00');
  const weekReset = at(74 * 60 * MIN + 12 * MIN + 20_000);
  return {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 62, resets_at: at(108 * MIN + 20_000), limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
      seven_day: { utilization: 18, resets_at: weekReset, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
      limits: [
        { kind: 'session', group: 'session', percent: 62, severity: 'normal', resets_at: at(108 * MIN + 20_000), scope: null, is_active: true },
        { kind: 'weekly_all', group: 'weekly', percent: 18, severity: 'normal', resets_at: weekReset, scope: null, is_active: false },
        { kind: 'weekly_scoped', group: 'weekly', percent: 93, severity: 'normal', resets_at: weekReset, scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
        { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resets_at: weekReset, scope: { model: { id: null, display_name: 'Opus' }, surface: null }, is_active: false },
      ],
      model_scoped: [
        { display_name: 'Fable', utilization: 93, resets_at: weekReset },
        { display_name: 'Opus', utilization: 0, resets_at: weekReset },
      ],
    },
  };
}

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-usage-footer');
  const dataDir = path.join(tmp, 'data');
  const store = await openStore(storeFile(dataDir));
  try {
    seededAt = Date.now();
    const reading = readingFromGetUsage({ kind: 'response', message: { subtype: 'success', response: usageAnswer(seededAt), error: null, raw: {} } });
    await store.usage.add({
      receivedAt: new Date(seededAt).toISOString(),
      source: reading.source,
      sessionId: null,
      fiveHourPct: reading.fiveHourPct,
      fiveHourResetsAt: reading.fiveHourResetsAt,
      sevenDayPct: reading.sevenDayPct,
      sevenDayResetsAt: reading.sevenDayResetsAt,
      raw: reading.raw,
    });
  } finally {
    await store.close();
  }
  server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir });
});

test.afterAll(async () => {
  await server?.stop();
  await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

test('the footer shows Session, Week and the model in use, each with its bar, % and time to reset; RAM in use', async ({ page }) => {
  const systemAnswer = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/system');
  await page.goto(`${server.baseUrl}/`);
  const info = (await (await systemAnswer).json()) as SystemInfo;

  // The API: usagePct keeps the max rule; usageWindows lists Session, Week and Fable (Opus is 0 % and not active).
  expect(info.usagePct).toBe(62);
  expect(info.usageWindows?.map((w) => [w.key, w.label, w.pct, w.model ?? null])).toEqual([
    ['session', 'Session', 62, null],
    ['week', 'Week', 18, null],
    ['model', 'Fable', 93, 'Fable'],
  ]);
  expect(info.ramUsed).toBeGreaterThan(0);
  expect(info.ramUsed).toBeLessThanOrEqual(info.ramTotal);

  const footer = page.getByTestId('machine-footer');
  await expect(footer.locator('.sb-meter > span:first-child')).toHaveText(['CPU', 'RAM', 'Session', 'Week', 'Fable']);
  await expect(footer.locator('.sb-meter').nth(1).locator('.sb-meter-value')).toHaveText(/^\d+\.\d\/\d+ GB$/);
  const usage = page.getByTestId('usage-meters');
  // The % and the time until the reset in the reset-text format (1h48 / 74h12; a minute less if the page is slow).
  await expect(usage.locator('[data-meter="session"] .sb-meter-value')).toHaveText(/^62% · 1h4[78]$/);
  await expect(usage.locator('[data-meter="week"] .sb-meter-value')).toHaveText(/^18% · 74h1[12]$/);
  await expect(usage.locator('[data-meter="model"][data-model="Fable"] .sb-meter-value')).toHaveText(/^93% · 74h1[12]$/);
  await expect(usage.locator('[data-model="Opus"]')).toHaveCount(0);
  // Each bar is 4 px, filled to the %.
  for (const [meter, pct] of [
    ['session', 62],
    ['week', 18],
    ['model', 93],
  ] as const) {
    const fill = usage.locator(`[data-meter="${meter}"] .sb-meter-fill`);
    await expect(fill).toHaveAttribute('style', `width: ${pct}%;`);
    const track = usage.locator(`[data-meter="${meter}"] .sb-meter-track`);
    expect((await track.boundingBox())?.height).toBe(4);
  }
  // The three usage bars line up, and end where the RAM bar ends.
  const ends = await footer.locator('.sb-meter-track').evaluateAll((tracks) => tracks.map((t) => Math.round(t.getBoundingClientRect().right)));
  expect(new Set(ends).size).toBe(1);

  // Fable at 93 % crossed the 90 % threshold: one warning toast, named after the model.
  const toast = page.getByTestId('toast');
  await expect(toast.locator('.sb-toast-title')).toHaveText('Max usage 93%');
  await expect(toast.locator('.sb-toast-sub')).toHaveText('Fable weekly limit');
  await expect(toast.locator('.sb-toast-text')).toHaveText(/^Your Max Fable weekly limit reached 93% \(warning at 90%\)\. It resets in 74h1[12]\. Nothing is paused automatically\.$/);
  await toast.getByRole('button', { name: 'Later' }).click();
  await expect(toast).toHaveCount(0);

  // The `system` hub event keeps the rows (a reload does not show the warning again in this browser).
  await page.reload();
  await expect(page.getByTestId('usage-meters').locator('.sb-meter > span:first-child')).toHaveText(['Session', 'Week', 'Fable']);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('toast')).toHaveCount(0);
});
