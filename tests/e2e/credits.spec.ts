import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { AccountSettings } from '../../src/core/accounts.ts';
import type { SystemInfo } from '../../src/core/api.ts';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D103 oracle (E2E, real code path, fake CLIs, temp data folder): two Claude Code
 * accounts as in the developer's report. "Work" (the Default) is at 100 % of its
 * weekly limit and still answering, paid from credits (a stored `rate_limit_event`
 * with overage in use, and a `get_usage` answer with its `extra_usage`, in the
 * shapes Claude Code 2.1.296 sends; Acme amounts). "Private" is at 100 % of its
 * 5-hour window, credits off. The footer grid shows the amber "on credits" badge
 * row under Work's line with what is left; Settings → Accounts shows the credits
 * line and the "When every account is out of allowance" rule.
 */

const HOUR = 3_600_000;
let tmp: string;
let server: ServerProcess;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-credits');
  const dataDir = path.join(tmp, 'data');
  const defaultDir = path.join(tmp, 'claude-config');
  const privateDir = path.join(tmp, 'private-config');
  await mkdir(defaultDir, { recursive: true });
  await mkdir(privateDir, { recursive: true });
  await writeFile(path.join(defaultDir, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email: 'work@example.test', subscriptionType: 'max' }));
  await writeFile(path.join(privateDir, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email: 'private@example.test', subscriptionType: 'max' }));
  const store = await openStore(storeFile(dataDir));
  try {
    const now = Date.now();
    const at = (ms: number): string => new Date(now + ms).toISOString();
    const epoch = (ms: number): number => Math.floor((now + ms) / 1000);
    await store.profiles.update('default-claude', { name: 'Work' });
    const priv = await store.profiles.create({ id: 'acme-private', cli: 'claude', name: 'Private', dir: privateDir, shareSettings: false });
    // Work: weekly at its limit, answering from credits.
    await store.usage.add({
      receivedAt: at(-60_000),
      source: 'get_usage',
      sessionId: null,
      profileId: 'default-claude',
      fiveHourPct: 16,
      fiveHourResetsAt: at(2 * HOUR),
      sevenDayPct: 100,
      sevenDayResetsAt: at(39 * HOUR),
      raw: {
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 16, resets_at: at(2 * HOUR) },
          seven_day: { utilization: 100, resets_at: at(39 * HOUR) },
          extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 3760, utilization: 75.2, currency: 'EUR', decimal_places: 2, disabled_reason: null, user_disabled: false, spend_limit_reached: false, credits_ever_enabled: true, daily: null, weekly: null },
        },
      },
    });
    await store.usage.add({
      receivedAt: at(-30_000),
      source: 'rate_limit_event',
      sessionId: null,
      profileId: 'default-claude',
      fiveHourPct: 16,
      fiveHourResetsAt: at(2 * HOUR),
      sevenDayPct: 100,
      sevenDayResetsAt: at(39 * HOUR),
      raw: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: epoch(39 * HOUR), rateLimitType: 'seven_day', overageStatus: 'allowed', overageResetsAt: epoch(400 * HOUR), isUsingOverage: true, overageInUse: true } },
    });
    // Private: its 5-hour window at the limit, credits off.
    await store.usage.add({
      receivedAt: at(-60_000),
      source: 'get_usage',
      sessionId: null,
      profileId: priv.id,
      fiveHourPct: 100,
      fiveHourResetsAt: at(HOUR),
      sevenDayPct: 52,
      sevenDayResetsAt: at(90 * HOUR),
      raw: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: at(HOUR) }, seven_day: { utilization: 52, resets_at: at(90 * HOUR) }, extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null } } },
    });
  } finally {
    await store.close();
  }
  server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: defaultDir, FAKE_CLAUDE_AUTH_REQUIRED: '1' });
});

test.afterAll(async () => {
  await server?.stop();
  await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

test('the footer grid: an amber "on credits" badge with what is left under the account on credits; the tooltip says until when', async ({ page }) => {
  const systemAnswer = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/system');
  await page.goto(`${server.baseUrl}/`);
  const info = (await (await systemAnswer).json()) as SystemInfo;
  expect(info.accountUsage?.find((row) => row.profileId === 'default-claude')?.credits).toMatchObject({ onCredits: true, currency: 'EUR', limit: 50, used: 37.6, left: 12.4 });

  const usage = page.getByTestId('usage-meters');
  const lines = usage.getByTestId('usage-line');
  await expect(lines).toHaveCount(2);
  const work = usage.locator('[data-testid="usage-line"][data-account="default-claude"]');
  await expect(work).toHaveAttribute('data-credits', 'true');
  await expect(usage.locator('[data-testid="usage-line"][data-account="acme-private"]')).not.toHaveAttribute('data-credits', 'true');
  // Only the account on credits has the badge row.
  const credits = usage.getByTestId('usage-credits');
  await expect(credits).toHaveCount(1);
  await expect(credits).toHaveAttribute('data-account', 'default-claude');
  await expect(credits.getByTestId('credit-badge')).toHaveText('€on credits');
  await expect(credits.locator('.sb-usage-credits-text')).toHaveText('€12.40 left of €50');
  // Amber: the badge's text is the status-need color.
  const color = await credits.getByTestId('credit-badge').evaluate((el) => getComputedStyle(el).color);
  const need = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--status-need)';
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  expect(color).toBe(need);
  expect((await work.getAttribute('title')) ?? '').toMatch(/\nOn credits until (\d+ [a-z]{3} )?\d\d:\d\d · €12\.40 left of €50\n/);
  await page.getByTestId('machine-footer').screenshot({ path: path.join('test-results', 'credits-footer.png') });
});

test('Settings → Accounts: the credits line with the reset; "When every account is out of allowance" is saved', async ({ page }) => {
  await page.goto(`${server.baseUrl}/settings/accounts`);
  const work = page.locator('[data-testid="account-profile"][data-profile-id="default-claude"]');
  const line = work.getByTestId('account-credits');
  await expect(line).toHaveAttribute('data-on-credits', 'true');
  await expect(line.getByTestId('credit-badge')).toHaveText('€on credits');
  await expect(line).toContainText(/On credits until .+ · €12\.40 left of €50 · credits reset /);
  // Private: credits off, nothing shown.
  await expect(page.locator('[data-testid="account-profile"][data-profile-id="acme-private"]').getByTestId('account-credits')).toHaveCount(0);
  await work.screenshot({ path: path.join('test-results', 'credits-settings-account.png') });

  const rule = page.getByTestId('accounts-out-of-allowance');
  await expect(rule).toHaveValue('use-credits');
  await rule.selectOption('pause');
  await expect
    .poll(async () => (await page.evaluate(async () => ((await (await fetch('/api/accounts')).json()) as { settings: AccountSettings }).settings.outOfAllowance)))
    .toBe('pause');
  await page.reload();
  await expect(page.getByTestId('accounts-out-of-allowance')).toHaveValue('pause');
  await page.locator('[data-row="accounts-out-of-allowance"]').screenshot({ path: path.join('test-results', 'credits-settings-rule.png') });
});
