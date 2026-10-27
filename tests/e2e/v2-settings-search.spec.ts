import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { TOKEN_FILE } from '../../src/server/token.ts';
import { V2_SETTINGS_SECTIONS } from '../../src/web/v2/routes.ts';
import { SETTINGS_INDEX, type SettingEntry } from '../../src/web/v2/settings/settings-index.ts';
import { ADVANCED_GROUPS } from '../../src/web/v2/settings/settings-map.ts';
import { freeTestPorts, makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.0 · the search in v2 Settings and the grouped Advanced list on the real
 * code path (a v2 server, the fake CLIs, temp data): every indexed setting's row is on
 * its page with its label (the index cannot drift), "archive" → the row highlighted on
 * its Advanced page and Back to the results, the keyboard, ⌘K finding a setting, a
 * phone (390 × 844), the grouped Advanced list and the order of the sections.
 */

let tmp: string;
let server: ServerProcess;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-v2-settings-search');
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
  const token = (await readFile(path.join(dataDir, TOKEN_FILE), 'utf8')).trim();
  // Phone access on a test port (the default 13003 is never bound in tests).
  const res = await fetch(`${server.baseUrl}/api/devices/access`, { method: 'PUT', headers: { cookie: `sb_token=${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ port: devicePort, enabled: true }) });
  expect(res.status).toBe(200);
});

test.afterAll(async () => {
  await server?.stop();
  await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

/** The page address of an entry, without `?setting=`. */
const pageOf = (entry: SettingEntry): string => (entry.section === 'advanced' ? `/settings/advanced/${entry.sub}` : `/settings/${entry.section}`);

const search = (page: Page) => page.getByTestId('v2-settings-search-input');

test('every indexed setting is on its page, with its label', async ({ page }) => {
  test.setTimeout(180_000);
  const byPage = new Map<string, SettingEntry[]>();
  for (const entry of SETTINGS_INDEX) byPage.set(pageOf(entry), [...(byPage.get(pageOf(entry)) ?? []), entry]);
  for (const [address, entries] of byPage) {
    await page.goto(`${server.baseUrl}${address}`);
    for (const entry of entries) {
      const anchor = page.locator(`[data-testid="v2-page-settings"] ${entry.anchor}`).first();
      await expect(anchor, `${entry.id}: ${entry.anchor} on ${address}`).toBeAttached();
      // The label is the row's text or a control's accessible name; a whole-page entry may be named by the page's heading.
      const named = await anchor.evaluate((element, label) => {
        const norm = (text: string): string => text.replace(/[’']/g, "'").replace(/\s+/g, ' ').toLowerCase();
        const own = [element.textContent ?? '', ...[...element.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label') ?? '')].join(' ');
        const page = document.querySelector('[data-testid="v2-page-settings"]');
        const headings = [...(page?.querySelectorAll('h1, h2, .v2-subnav [aria-current="true"]') ?? [])].map((el) => el.textContent ?? '').join(' ');
        return norm(own).includes(norm(label)) || norm(headings).includes(norm(label));
      }, entry.label);
      expect(named, `${entry.id}: “${entry.label}” at ${entry.anchor} on ${address}`).toBe(true);
    }
  }
});

test('search "archive" → the row on its Advanced page, highlighted; Back returns to the results', async ({ page }) => {
  await page.goto(`${server.baseUrl}/settings`);
  await search(page).fill('archive');
  await expect(page).toHaveURL(`${server.baseUrl}/settings?q=archive`);
  // The results replace the sections.
  await expect(page.getByTestId('v2-settings-nav')).toHaveCount(0);
  const first = page.getByTestId('v2-settings-hit').first();
  await expect(first).toHaveAttribute('data-setting', 'sessions.archive');
  await expect(first.getByTestId('v2-settings-hit-crumbs')).toHaveText('Advanced › Agents & separate copies › Delete archived agents after');
  await expect(first.locator('mark').first()).toHaveText(/archive/i);
  await first.click();
  await expect(page.getByTestId('v2-advanced-page')).toHaveAttribute('data-page', 'sessions');
  const row = page.locator('[data-row="archive"]');
  await expect(row).toHaveAttribute('data-v2-flash', '');
  await expect(row).toBeInViewport();
  // The address drops ?setting= once the row is found; the highlight goes after ~2 s.
  await expect(page).toHaveURL(`${server.baseUrl}/settings/advanced/sessions`);
  await expect(row).not.toHaveAttribute('data-v2-flash', '', { timeout: 4000 });
  await page.goBack();
  await expect(page).toHaveURL(`${server.baseUrl}/settings?q=archive`);
  await expect(search(page)).toHaveValue('archive');
  await expect(page.getByTestId('v2-settings-hit').first()).toHaveAttribute('data-setting', 'sessions.archive');
});

test('keyboard: ↓ / ↑ move, ↩ opens, Esc clears; and the empty state', async ({ page }) => {
  await page.goto(`${server.baseUrl}/settings/advanced`);
  await search(page).click();
  await page.keyboard.type('notification');
  const hits = page.getByTestId('v2-settings-hit');
  await expect(hits.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(hits.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(hits.nth(1)).toHaveAttribute('aria-selected', 'true');
  const second = await hits.nth(1).getAttribute('data-setting');
  await page.keyboard.press('Enter');
  const entry = SETTINGS_INDEX.find((candidate) => candidate.id === second) as SettingEntry;
  await expect(page).toHaveURL(`${server.baseUrl}${pageOf(entry)}`);
  await expect(page.locator(`[data-testid="v2-page-settings"] ${entry.anchor}`).first()).toHaveAttribute('data-v2-flash', '');

  // Esc clears the query (and the address), and the sections come back.
  await search(page).fill('sound');
  await expect(hits.first()).toHaveAttribute('data-setting', 'notify.toast');
  await search(page).press('Escape');
  await expect(search(page)).toHaveValue('');
  await expect(hits).toHaveCount(0);
  await expect(page).toHaveURL(`${server.baseUrl}${pageOf(entry)}`);
  await expect(page.getByTestId('v2-settings-nav')).toBeVisible();

  await search(page).fill('zzqx');
  await expect(page.getByTestId('v2-settings-search-empty')).toContainText('No setting matches “zzqx”');
});

test('⌘K finds a single setting and opens it highlighted', async ({ page }) => {
  const hub = page.waitForResponse((response) => new URL(response.url()).pathname === '/hub');
  await page.goto(`${server.baseUrl}/`);
  expect((await hub).status()).toBe(200);
  const palette = page.getByTestId('v2-palette');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette).toBeVisible();
  await page.keyboard.type('peer listener');
  await expect(palette.locator('.v2-cmd').first()).toHaveAttribute('data-command', 'setting:machines.peer-listener');
  await expect(palette.locator('.v2-cmdk-group').first()).toHaveText('Settings');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId('v2-advanced-page')).toHaveAttribute('data-page', 'machines');
  await expect(page.locator('[data-row="peer-listener"]')).toHaveAttribute('data-v2-flash', '');
});

test('phone (390×844): the search is usable on the list and on an Advanced page', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const phone = await context.newPage();
    await stubToolProbes(phone);
    await phone.goto(`${server.baseUrl}/settings`);
    const input = search(phone);
    await expect(input).toBeVisible();
    const box = await phone.getByTestId('v2-settings-search').locator('.v2-set-search-box').boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await input.fill('port');
    const hit = phone.locator('[data-testid="v2-settings-hit"][data-setting="machines.peer-listener"]');
    await expect(hit).toBeVisible();
    expect((await hit.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    // Nothing scrolls sideways.
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await hit.tap();
    await expect(phone.getByTestId('v2-advanced-page')).toHaveAttribute('data-page', 'machines');
    await expect(phone.locator('[data-row="peer-listener"]')).toHaveAttribute('data-v2-flash', '');
    // On the Advanced page too.
    await expect(search(phone)).toBeVisible();
    await search(phone).fill('dark');
    await expect(phone.getByTestId('v2-settings-hit').first()).toHaveAttribute('data-setting', 'appearance.scheme');
  } finally {
    await context.close();
  }
});

test('Advanced is grouped under headings, and the sections are in the new order', async ({ page }) => {
  await page.goto(`${server.baseUrl}/settings/advanced`);
  const groups = page.getByTestId('v2-advanced-group');
  await expect(groups.locator('h3')).toHaveText(ADVANCED_GROUPS.map((group) => group.label));
  for (const [index, group] of ADVANCED_GROUPS.entries()) {
    const links = groups.nth(index).locator('a.v2-adv-row');
    await expect(links).toHaveCount(group.keys.length);
    for (const [at, key] of group.keys.entries()) await expect(links.nth(at)).toHaveAttribute('data-testid', `v2-advanced-${key}`);
  }
  await expect(page.getByTestId('v2-settings-nav').locator('a')).toHaveText(['Usage & accounts', 'Rules for every agent', 'Appearance', 'Computers', 'Phones', 'Advanced']);
  expect(V2_SETTINGS_SECTIONS[0]).toBe('usage');
  // The keys and addresses did not change: an old link and the Archived list's link still land.
  await page.goto(`${server.baseUrl}/settings/folders`);
  await expect(page.getByTestId('v2-advanced-page')).toHaveAttribute('data-page', 'workspace');
});
