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
 * tests/server/usage/wire.test.ts). D66: the footer's usage grid has one line (a
 * single Claude Code account) with the **5h** and **Week** bars in place of the
 * prototype's one "Max" row; the **Fable** weekly limit is in use, so the line's
 * tooltip lists it; a model at 0 % that is not active is not listed.
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

test('the footer grid shows the account\'s 5h and Week bars with their %, the resets, paces and the model in use in its tooltip; RAM in use', async ({ page }) => {
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

  // D66: under CPU / RAM, the usage grid: its header, then one line (a single Claude Code account) with both windows.
  const footer = page.getByTestId('machine-footer');
  await expect(footer.locator('.sb-meter > span:first-child')).toHaveText(['CPU', 'RAM']);
  await expect(footer.locator('.sb-meter').nth(1).locator('.sb-meter-value')).toHaveText(/^\d+\.\d\/\d+ GB$/);
  const usage = page.getByTestId('usage-meters');
  await expect(usage.getByTestId('usage-grid-header')).toHaveText('5hWeek');
  const lines = usage.getByTestId('usage-line');
  await expect(lines).toHaveCount(1);
  const line = lines.first();
  // Named after the account (its single one, the built-in Default: `activeAccounts`, ruling 2026-10-04).
  expect(info.activeAccounts?.find((account) => account.cli === 'claude')).toMatchObject({ profileId: 'default-claude', name: 'Default' });
  await expect(line.locator('.sb-usage-label')).toHaveText('Default');
  await expect(line).toHaveAttribute('data-active', 'false');
  await expect(line.locator('.sb-usage-pct')).toHaveText(['62%', '18%']);
  // The tooltip: each window's % and the time until its reset (1h48 / 74h12; a minute less if the page is slow), its pace
  // under it, then the model's weekly limit (Fable; Opus is 0 % and not active, so it is not listed).
  const title = (await line.getAttribute('title')) ?? '';
  expect(title).toMatch(/^Default\n5h: 62% · resets in 1h4[78]\n {2}On pace: 62% of (64|64\.33|64\.67)% until \d\d:\d\d\nWeek: 18% · resets in 74h1[12]\n {2}On pace: 18% of 55\.8[3-6]% until \d\d:\d\d\nFable week: 93% · resets in 74h1[12]\nSettings → Accounts$/);
  // Each bar is 4 px, filled to the %.
  for (const [window, pct] of [
    ['session', 62],
    ['week', 18],
  ] as const) {
    const fill = line.locator(`[data-window="${window}"] .sb-meter-fill`);
    await expect(fill).toHaveAttribute('style', `width: ${pct}%;`);
    const track = line.locator(`[data-window="${window}"] .sb-meter-track`);
    expect((await track.boundingBox())?.height).toBe(4);
  }
  // D23 / D46 on the page's own clock (tests/e2e/week-pace.spec.ts and session-pace.spec.ts drive the colors and the steps):
  // both windows are on pace, each with its marker.
  for (const window of ['session', 'week'] as const) {
    await expect(line.locator(`[data-window="${window}"]`)).toHaveAttribute('data-pace', 'on');
    await expect(line.locator(`[data-window="${window}"]`).getByTestId('pace-marker')).toHaveCount(1);
  }
  // The Week % ends where the RAM value ends; the two bars are as wide as each other.
  const ramRight = await footer.locator('.sb-meter').nth(1).locator('.sb-meter-value').evaluate((v) => Math.round(v.getBoundingClientRect().right));
  const pcts = await line.locator('.sb-usage-pct').evaluateAll((values) => values.map((v) => Math.round(v.getBoundingClientRect().right)));
  expect(pcts[1]).toBe(ramRight);
  const widths = await line.locator('.sb-meter-track').evaluateAll((tracks) => tracks.map((t) => Math.round(t.getBoundingClientRect().width)));
  expect(new Set(widths).size).toBe(1);

  // Fable at 93 % crossed the 90 % threshold: one warning toast, named after the model.
  const toast = page.getByTestId('toast');
  await expect(toast.locator('.sb-toast-title')).toHaveText('Max usage 93%');
  await expect(toast.locator('.sb-toast-sub')).toHaveText('Fable weekly limit');
  await expect(toast.locator('.sb-toast-text')).toHaveText(/^Your Max Fable weekly limit reached 93% \(warning at 90%\)\. It resets in 74h1[12]\. Nothing is paused automatically\.$/);
  await toast.getByRole('button', { name: 'Later' }).click();
  await expect(toast).toHaveCount(0);

  // The `system` hub event keeps the rows (a reload does not show the warning again in this browser).
  await page.reload();
  await expect(page.getByTestId('usage-line').locator('.sb-usage-pct')).toHaveText(['62%', '18%']);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('toast')).toHaveCount(0);

  // D66: a click on a line opens Settings → Accounts.
  await page.getByTestId('usage-line').first().click();
  await expect(page).toHaveURL(/\/settings\/accounts$/);
});
