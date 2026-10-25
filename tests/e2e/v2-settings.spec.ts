import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import type { AccountsOverview } from '../../src/core/api.ts';
import type { MachinesView } from '../../src/core/peers.ts';
import { TOKEN_FILE } from '../../src/server/token.ts';
import { ADVANCED_PAGES } from '../../src/web/v2/settings/settings-map.ts';
import { freeTestPorts, makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, enableListener, machineOn, pair, startPeerNode, waitFor } from '../helpers/peers.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · lane R · v2 Settings on the real code path (a server whose default theme
 * is v2, the fake CLIs, temp data): the account order (arrows and drag), "switch
 * at 98%" saved, the rules, the phone pairing dialog with its QR code, every
 * Advanced page, the theme switch from Appearance, the phone's drill-down, and a
 * paired computer's reconnecting state (two real servers).
 */

let tmp: string;
let server: ServerProcess;
let token: string;

test.describe('one computer', () => {
  test.beforeAll(async () => {
    tmp = await makeTempDir('e2e-v2-settings');
    const dataDir = path.join(tmp, 'data');
    const claudeDir = path.join(tmp, 'claude-config');
    await mkdir(claudeDir, { recursive: true });
    await mkdir(path.join(tmp, 'codex-home'), { recursive: true });
    await mkdir(path.join(tmp, 'opencode-data'), { recursive: true });
    await writeFile(path.join(claudeDir, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email: 'default@example.test' }));
    const free = await freeTestPorts();
    const devicePort = free.at(-1) as number;
    server = await startServer({
      SWITCHBOARD_DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: path.join(tmp, 'codex-home'),
      XDG_DATA_HOME: path.join(tmp, 'opencode-data'),
      SWITCHBOARD_DEVICE_TEST_ORIGIN: `http://localhost:${devicePort}`,
      ...V2_SERVER_ENV,
    });
    token = (await readFile(path.join(dataDir, TOKEN_FILE), 'utf8')).trim();
    const call = (method: string, route: string, body: unknown) =>
      fetch(`${server.baseUrl}${route}`, { method, headers: { cookie: `sb_token=${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    // A second Claude account, so there is an order to change.
    expect((await call('POST', '/api/accounts/profiles', { cli: 'claude', name: 'Work' })).status).toBe(201);
    // Phone access on a test port (the default 13003 is never bound in tests).
    expect((await call('PUT', '/api/devices/access', { port: devicePort, enabled: true })).status).toBe(200);
  });

  test.afterAll(async () => {
    await server?.stop();
    await removeTempDir(tmp);
  });

  test.beforeEach(async ({ page }) => {
    await stubToolProbes(page);
  });

  async function accounts(page: Page): Promise<AccountsOverview> {
    return page.evaluate(async () => (await (await fetch('/api/accounts')).json()) as AccountsOverview);
  }

  test('Usage & accounts: cards per account, the order by arrows and by drag, and switch at 98% saved', async ({ page }) => {
    await page.goto(`${server.baseUrl}/settings`);
    // /settings opens Usage & accounts on a desktop.
    await expect(page.getByTestId('v2-page-settings')).toHaveAttribute('data-section', 'usage');
    await expect(page.getByTestId('v2-settings-usage')).toHaveAttribute('aria-current', 'true');
    const usage = page.getByTestId('v2-set-usage');
    await expect(usage.getByTestId('v2-account-card')).toHaveCount(2 + 2); // Claude Default + Work, Codex, OpenCode
    await expect(usage.locator('[data-testid="v2-account-card"][data-profile-id="default-claude"]')).toContainText('Claude Code');
    const order = usage.locator('[data-testid="v2-account-order"][data-cli="claude"]');
    const rows = order.getByTestId('v2-account-row');
    await expect(rows).toHaveCount(2);
    const firstId = await rows.nth(0).getAttribute('data-profile-id');
    const secondId = await rows.nth(1).getAttribute('data-profile-id');
    // Down arrow on the first: the order flips (saved on the server).
    await rows.nth(0).getByTestId('v2-account-down').click();
    await expect(rows.nth(0)).toHaveAttribute('data-profile-id', secondId as string);
    await expect(page.getByTestId('v2-toast').last()).toContainText('is now number 2');
    expect((await accounts(page)).profiles.filter((p) => p.cli === 'claude').sort((a, b) => a.position - b.position)[0]?.id).toBe(secondId);
    // Drag it back.
    await rows.nth(1).dragTo(rows.nth(0));
    await expect(rows.nth(0)).toHaveAttribute('data-profile-id', firstId as string);
    // The up arrow of the first is disabled (it says so).
    await expect(rows.nth(0).getByTestId('v2-account-up')).toBeDisabled();

    // Switch at 98% (the default), then 95%, then 98% again: saved in the D63 thresholds.
    const at = usage.getByTestId('v2-accounts-switch-at');
    await expect(at).toHaveValue('98');
    await at.selectOption('95');
    await expect.poll(async () => (await accounts(page)).settings.thresholds.fiveHourPct).toBe(95);
    await at.selectOption('98');
    await expect.poll(async () => (await accounts(page)).settings.thresholds).toMatchObject({ enabled: true, fiveHourPct: 98, weeklyPct: 98 });
    await page.reload();
    await expect(page.getByTestId('v2-accounts-switch-at')).toHaveValue('98');
    // When all are out: pause new work; switch back after reset.
    await page.getByTestId('v2-accounts-all-out').getByRole('button', { name: 'Pause new work' }).click();
    await expect.poll(async () => (await accounts(page)).settings.outOfAllowance).toBe('pause');
    await page.getByTestId('v2-accounts-switch-back').click();
    await expect.poll(async () => (await accounts(page)).settings.afterReset).toBe('back-to-first');
    // Pinning is explained, and Insights is one click away.
    await expect(page.getByTestId('v2-account-pins')).toContainText('side panel');
    await page.getByTestId('v2-open-insights').click();
    await expect(page).toHaveURL(`${server.baseUrl}/insights`);
  });

  test('Rules for every agent: saved and reset', async ({ page }) => {
    await page.goto(`${server.baseUrl}/settings/rules`);
    const text = page.getByTestId('v2-rules-text');
    await text.fill('Use British English in customer-facing text.');
    await page.getByTestId('v2-rules-save').click();
    await expect(page.getByTestId('v2-toast').last()).toContainText('Rules saved');
    await expect.poll(async () => page.evaluate(async () => ((await (await fetch('/api/settings')).json()) as Record<string, unknown>)['agents.standingInstruction'])).toBe('Use British English in customer-facing text.');
    await page.getByTestId('v2-rules-reset').click();
    await expect(page.getByTestId('v2-toast').last()).toContainText('reset');
    await expect(page.getByTestId('v2-rules-apply')).toBeDisabled();
  });

  test('Phones: Pair a phone shows a QR code and the one-time code', async ({ page }) => {
    await page.goto(`${server.baseUrl}/settings/phones`);
    await expect(page.getByTestId('v2-set-phones')).toBeVisible();
    await expect(page.getByTestId('v2-phone-access-switch')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('v2-pair-phone').click();
    const dialog = page.getByTestId('v2-pair-phone-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Open the camera on your phone.');
    await expect(dialog.getByTestId('v2-pair-qr').locator('svg, canvas, img').first()).toBeVisible();
    await expect(dialog.getByTestId('v2-phone-code')).toHaveText(/\S+/);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('Computers: this computer, background apps, Add a computer', async ({ page }) => {
    await page.goto(`${server.baseUrl}/settings/computers`);
    const self = page.locator('[data-testid="v2-computer"][data-self]');
    await expect(self).toContainText('This computer');
    await expect(self).toContainText('Online');
    await expect(page.getByTestId('v2-background-apps')).toContainText('Nothing is running in the background.');
    await page.getByTestId('v2-add-computer').click();
    const dialog = page.getByTestId('v2-add-computer-dialog');
    await expect(dialog).toBeVisible();
    // The peer listener is off by default: the dialog offers to turn it on.
    await expect(dialog.getByTestId('v2-listener-switch')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('every Advanced page opens with its classic section inside', async ({ page }) => {
    await page.goto(`${server.baseUrl}/settings/advanced`);
    const list = page.getByTestId('v2-advanced-list');
    await expect(list.locator('a')).toHaveCount(ADVANCED_PAGES.length);
    for (const entry of ADVANCED_PAGES) {
      await page.goto(`${server.baseUrl}/settings/advanced/${entry.key}`);
      const pageEl = page.getByTestId('v2-advanced-page');
      await expect(pageEl, entry.key).toHaveAttribute('data-page', entry.key);
      await expect(pageEl.locator('h2'), entry.key).toContainText(entry.label);
      const body = page.getByTestId('v2-advanced-body');
      await expect(body, entry.key).toBeVisible();
      await expect(body.locator('*:visible').first(), entry.key).toBeVisible();
    }
    // A classic address lands on its Advanced page (D132's old link too), and Back returns to the list.
    await page.goto(`${server.baseUrl}/settings/experimental`);
    await expect(page.getByTestId('v2-advanced-page')).toHaveAttribute('data-page', 'jira');
    await page.getByTestId('v2-advanced-back').click();
    await expect(page).toHaveURL(`${server.baseUrl}/settings/advanced`);
    // The setup wizard opens over the v2 page.
    await page.goto(`${server.baseUrl}/settings/advanced/setup`);
    await page.getByTestId('v2-run-setup').click();
    await expect(page.locator('.v2-classic-modal-layer .sb-overlay')).toBeVisible();
  });

  test('Appearance: the theme switch to classic and back keeps the page, and the density is remembered', async ({ page }) => {
    await page.goto(`${server.baseUrl}/settings/appearance`);
    await page.getByTestId('v2-density-switch').getByRole('button', { name: 'Compact' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
    expect(await page.evaluate(() => window.localStorage.getItem('switchboard.v2.density'))).toBe('compact');
    await page.getByTestId('v2-theme-switch').getByRole('button', { name: 'Classic' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-ui', 'classic');
    await expect(page.getByTestId('view-settings')).toBeVisible();
    await expect(page).toHaveURL(`${server.baseUrl}/settings/appearance`);
    await page.getByTestId('settings-content').getByRole('button', { name: 'v2' }).first().click();
    await expect(page.locator('html')).toHaveAttribute('data-ui', 'v2');
    await expect(page.getByTestId('v2-set-appearance')).toBeVisible();
  });

  test('phone (390×844): Settings is a list that drills down, with a back link', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const phone = await context.newPage();
      await stubToolProbes(phone);
      await phone.goto(`${server.baseUrl}/settings`);
      await expect(phone.getByTestId('v2-page-settings')).toHaveAttribute('data-pane', 'list');
      await expect(phone.getByTestId('v2-settings-nav')).toBeVisible();
      await expect(phone.getByTestId('v2-set-usage')).toHaveCount(0);
      // The rows are touch-sized.
      const box = await phone.getByTestId('v2-settings-usage').boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      await phone.getByTestId('v2-settings-rules').click();
      await expect(phone.getByTestId('v2-page-settings')).toHaveAttribute('data-pane', 'detail');
      await expect(phone.getByTestId('v2-settings-nav')).toHaveCount(0);
      await expect(phone.locator('h1')).toHaveText('Rules for every agent');
      await phone.getByTestId('v2-settings-back').click();
      await expect(phone).toHaveURL(`${server.baseUrl}/settings`);
      await expect(phone.getByTestId('v2-settings-nav')).toBeVisible();
      // Advanced drills down twice.
      await phone.getByTestId('v2-settings-advanced').click();
      await phone.getByTestId('v2-advanced-updates').click();
      await expect(phone.getByTestId('v2-advanced-page')).toHaveAttribute('data-page', 'updates');
    } finally {
      await context.close();
    }
  });
});

test.describe('paired computers', () => {
  let root: string;
  let nodes: PeerNode[] = [];
  let contexts: BrowserContext[] = [];

  test.beforeEach(async () => {
    root = await makeTempDir('e2e-v2-settings-peers');
  });

  test.afterEach(async () => {
    await Promise.all(contexts.map((context) => context.close()));
    contexts = [];
    await Promise.all(nodes.map((node) => node.server.stop()));
    nodes = [];
    await removeTempDir(root);
  });

  async function pageOf(browser: Browser, node: PeerNode, at: string): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(context);
    const page = await context.newPage();
    await stubToolProbes(page);
    await page.goto(`${node.baseUrl}${at}`);
    return page;
  }

  test('a paired computer that drops: reconnecting with Reconnect now, offline since …, back online', async ({ browser }) => {
    test.setTimeout(120_000);
    const env = { ...V2_SERVER_ENV, SWITCHBOARD_PEER_TEST_HOOKS: '1', SWITCHBOARD_PEER_GRACE_MS: '6000' };
    const a = await startPeerNode(root, 'a', { env });
    nodes.push(a);
    const b = await startPeerNode(root, 'b', { env });
    nodes.push(b);
    await pair(a, b, await enableListener(a));
    const aId = await a.machineId();
    await waitFor('A online on B', async () => (await machineOn(b, aId))?.state === 'online');
    const aName = ((await a.call('GET', '/api/machines')).body as MachinesView).self.name;

    const page = await pageOf(browser, b, '/settings/computers');
    const card = page.locator(`[data-testid="v2-computer"][data-machine-id="${aId}"]`);
    await expect(card).toHaveAttribute('data-state', 'online', { timeout: 15_000 });
    await expect(card).toContainText(aName);
    await expect(card).toContainText('Online');
    await expect(page.getByTestId('v2-shared-layout')).toContainText(aName);

    expect((await a.call('POST', '/api/test/peers/outage', { ms: 120_000 })).status).toBe(204);
    await expect(card).toHaveAttribute('data-state', 'reconnecting');
    await expect(card.getByTestId('v2-computer-reconnecting')).toContainText('Reconnecting…');
    await expect(card.getByTestId('v2-computer-reconnect')).toBeVisible();
    await expect(card).toContainText('Reconnecting');
    // After the grace: offline since …, with Reconnect now.
    await expect(card).toHaveAttribute('data-state', 'offline', { timeout: 15_000 });
    await expect(card.getByTestId('v2-computer-offline')).toContainText('Offline');
    await expect(card.getByTestId('v2-computer-reconnect')).toBeVisible();

    // A is back: Reconnect now brings it online at once.
    expect((await a.call('DELETE', '/api/test/peers/outage')).status).toBe(204);
    await card.getByTestId('v2-computer-reconnect').click();
    await expect(card).toHaveAttribute('data-state', 'online', { timeout: 10_000 });
  });
});
