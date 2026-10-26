import path from 'node:path';
import { expect, test } from '@playwright/test';
import { readingFromGetUsage } from '../../src/core/usage.ts';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.0 · the Max usage warnings in v2 (`docs/v2.md` → *Usage warnings*)
 * on the real code path: a server whose default theme is v2, a temp data folder
 * holding a `get_usage` reading (the recorded shape, as in usage-footer.spec.ts)
 * whose 5-hour window is at 92 %, over the default 90 % threshold. The meter fires
 * the warning; v2 shows it once as a toast (View usage → Settings › Usage &
 * accounts), as a dismissible "Usage warning" in Needs you, and the status pill
 * is amber. "Warn at" in v2 Settings › Usage & accounts saves `usage.warnAtPct`
 * and moves the pill's amber with it.
 */

const MIN = 60_000;
let tmp: string;
let server: ServerProcess;

function usageAnswer(now: number): Record<string, unknown> {
  const at = (ms: number): string => new Date(now + ms).toISOString().replace('Z', '+00:00');
  const fiveReset = at(108 * MIN + 20_000);
  const weekReset = at(74 * 60 * MIN);
  return {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 92, resets_at: fiveReset, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
      seven_day: { utilization: 18, resets_at: weekReset, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
      limits: [
        { kind: 'session', group: 'session', percent: 92, severity: 'normal', resets_at: fiveReset, scope: null, is_active: true },
        { kind: 'weekly_all', group: 'weekly', percent: 18, severity: 'normal', resets_at: weekReset, scope: null, is_active: false },
      ],
      model_scoped: [],
    },
  };
}

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-v2-usage-warnings');
  const dataDir = path.join(tmp, 'data');
  const store = await openStore(storeFile(dataDir));
  try {
    const now = Date.now();
    const reading = readingFromGetUsage({ kind: 'response', message: { subtype: 'success', response: usageAnswer(now), error: null, raw: {} } });
    await store.usage.add({
      receivedAt: new Date(now).toISOString(),
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
  server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir, ...V2_SERVER_ENV });
});

test.afterAll(async () => {
  await server?.stop();
  await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

test('a usage warning: one toast, a dismissible Needs-you alert, the amber pill; "Warn at" saved from v2 Settings', async ({ page }) => {
  await page.goto(`${server.baseUrl}/needs-you`);
  await expect(page.getByTestId('v2-root')).toBeVisible();

  // The toast, once (the page load and the `system` events both see the warning).
  const toasts = page.getByTestId('v2-toast');
  await expect(toasts).toHaveCount(1);
  await expect(toasts.first()).toHaveAttribute('data-tone', 'warn');
  await expect(toasts.first()).toContainText(/^Claude ‘Default’ — 5-hour window at 92% · Resets \d\d:\d\d/);
  await expect(toasts.first().getByRole('button', { name: 'View usage' })).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(toasts).toHaveCount(1);

  // The pill: 92 % is over the default 90 %.
  const pillTone = page.getByTestId('v2-status-pill').locator('.v2-pill-ic');
  await expect(pillTone).toHaveAttribute('data-tone', 'amber');

  // Needs you: the "Usage warning" alert.
  const alert = page.getByTestId('v2-needs-list').locator('[data-source="usage"]');
  await expect(alert).toHaveCount(1);
  await expect(alert.locator('.v2-qi-title')).toHaveText('Usage warning');
  await expect(alert).toContainText(/Claude ‘Default’ — 5-hour window at 92% \(warning at 90%\)\. Resets \d\d:\d\d\. Nothing is paused automatically\./);

  // View usage opens Settings › Usage & accounts.
  await toasts.first().getByRole('button', { name: 'View usage' }).click();
  await expect(page).toHaveURL(/\/settings\/usage$/);

  // A reload does not toast it again (once per window and reset, in this browser).
  await page.goto(`${server.baseUrl}/needs-you`);
  await expect(alert).toHaveCount(1);
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId('v2-toast')).toHaveCount(0);

  // OK dismisses the alert, and it stays dismissed after a reload.
  await alert.getByRole('button', { name: 'OK' }).click();
  await expect(alert).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('v2-root')).toBeVisible();
  await expect(pillTone).toHaveAttribute('data-tone', 'amber');
  await page.waitForTimeout(500);
  await expect(alert).toHaveCount(0);

  // "Warn at" in v2 Settings › Usage & accounts: 95 % is saved and the pill turns green (92 < 95) …
  await page.goto(`${server.baseUrl}/settings/usage`);
  const warnAt = page.getByTestId('v2-usage-warn-at');
  await expect(warnAt).toHaveValue('90');
  const options = await warnAt.locator('option').allTextContents();
  expect(options).toEqual(['50%', '55%', '60%', '65%', '70%', '75%', '80%', '85%', '90%', '95%', '100%']);
  await warnAt.selectOption('95');
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'You’ll be warned at 95%.' })).toBeVisible();
  await expect(pillTone).toHaveAttribute('data-tone', 'green');
  const stored = await page.evaluate(async () => ((await (await fetch('/api/settings')).json()) as Record<string, unknown>)['usage.warnAtPct']);
  expect(stored).toBe(95);
  await page.reload();
  await expect(page.getByTestId('v2-usage-warn-at')).toHaveValue('95');
  await expect(pillTone).toHaveAttribute('data-tone', 'green');

  // … and at 60 % it is amber again.
  await page.getByTestId('v2-usage-warn-at').selectOption('60');
  await expect(pillTone).toHaveAttribute('data-tone', 'amber');
  const back = await page.evaluate(async () => ((await (await fetch('/api/settings')).json()) as Record<string, unknown>)['usage.warnAtPct']);
  expect(back).toBe(60);
});
