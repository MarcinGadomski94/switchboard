import path from 'node:path';
import { expect, test } from '@playwright/test';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV, markWindow, sameWindow } from './v2-world.ts';

/**
 * D131 · the v2 shell on the real code path (`docs/v2.md`): a server whose default
 * theme is v2; the rail and its navigation, the top bar, the status pill, the
 * shortcuts, deep links from classic addresses, the theme switch both ways without
 * a reload (the address kept), and the phone's bottom tabs.
 */
let tmp: string;
let server: ServerProcess;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-v2-shell');
  server = await startServer({ SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), ...V2_SERVER_ENV });
});

test.afterAll(async () => {
  await server?.stop();
  await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

test('v2 is the default: the shell renders with its seven rail items, and the rail navigates', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  await expect(page.getByTestId('v2-shell')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'v2');
  // The classic shell is not mounted at all.
  await expect(page.getByTestId('shell')).toHaveCount(0);
  const rail = page.getByTestId('v2-rail');
  await expect(rail.locator('.v2-nav-item .v2-nav-label')).toHaveText(['Home', 'Agents', 'Projects', 'Crews', 'Results', 'Tasks', 'Settings']);
  await expect(page.getByTestId('v2-nav-home')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('v2-page-home')).toBeVisible();
  await expect(rail.getByTestId('v2-rail-pins')).toContainText('Pinned');
  // The top bar: search, shortcuts, the status pill, Needs you, + New.
  await expect(page.getByTestId('v2-palette-open')).toBeVisible();
  await expect(page.getByTestId('v2-status-pill')).toBeVisible();
  await expect(page.getByTestId('v2-needs-button')).toBeVisible();
  await expect(page.getByTestId('v2-new')).toHaveText('New');

  for (const [area, url, testId] of [
    ['agents', '/agents', 'v2-page-agents'],
    ['projects', '/projects', 'v2-page-projects'],
    ['crews', '/crews', 'v2-page-crews'],
    ['results', '/results', 'v2-page-results'],
    ['tasks', '/tasks', 'v2-page-tasks'],
    ['settings', '/settings', 'v2-page-settings'],
    ['home', '/', 'v2-page-home'],
  ] as const) {
    await page.getByTestId(`v2-nav-${area}`).click();
    await expect(page).toHaveURL(`${server.baseUrl}${url}`);
    await expect(page.getByTestId(testId)).toBeVisible();
    await expect(page.getByTestId(`v2-nav-${area}`)).toHaveAttribute('aria-current', 'page');
  }

  // The status pill opens its details (usage and computers) and closes on Escape.
  await page.getByTestId('v2-status-pill').click();
  const pop = page.getByTestId('v2-status-pop');
  await expect(pop).toBeVisible();
  await expect(pop.locator('h4', { hasText: 'Computers' })).toBeVisible();
  await expect(pop.getByTestId('v2-pill-computer')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
});

test('keyboard: ? lists the shortcuts, ⌘K opens the palette, ⌘⇧F opens Search', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  await expect(page.getByTestId('v2-shell')).toBeVisible();
  await page.locator('body').press('?');
  const list = page.getByTestId('v2-shortcuts');
  await expect(list).toBeVisible();
  await expect(list).toContainText('Command palette and quick search');
  await expect(list).toContainText('Hide or show the agent’s details panel');
  await expect(list).toContainText('Hide or show the folder tree in Agents');
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('v2-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type('crews');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(`${server.baseUrl}/crews`);

  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(page).toHaveURL(`${server.baseUrl}/search`);
  await expect(page.getByTestId('v2-page-search')).toBeVisible();
});

test('a classic address opens its v2 page (push notifications, paired computers, bookmarks)', async ({ page }) => {
  await page.goto(`${server.baseUrl}/sessions/abc/diff`);
  await expect(page).toHaveURL(`${server.baseUrl}/agents/abc/changes`);
  // Lane S: the agent view (here for an id with no agent) on its Changes tab.
  await expect(page.locator('[data-testid="v2-agent-view"][data-session-id="abc"]')).toHaveAttribute('data-tab', 'changes');
  await page.goto(`${server.baseUrl}/inbox`);
  await expect(page).toHaveURL(`${server.baseUrl}/needs-you`);
  await expect(page.getByTestId('v2-page-needs-you')).toBeVisible();
  await page.goto(`${server.baseUrl}/plans/p1`);
  await expect(page).toHaveURL(`${server.baseUrl}/projects/p1`);
});

test('the theme switch: v2 → Classic → v2, at once and without a reload, keeping the page', async ({ page }) => {
  await page.goto(`${server.baseUrl}/settings/appearance`);
  await expect(page.getByTestId('v2-theme-switch')).toBeVisible();
  await markWindow(page);
  await page.getByTestId('v2-theme-switch').getByRole('button', { name: 'Classic' }).click();
  // The classic UI, on the same page (Settings → Appearance), the same window.
  await expect(page.getByTestId('shell')).toBeVisible();
  await expect(page.getByTestId('v2-shell')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'classic');
  await expect(page).toHaveURL(`${server.baseUrl}/settings/appearance`);
  await expect(page.getByTestId('theme-switch')).toBeVisible();
  await expect(page.getByTestId('theme-classic')).toHaveAttribute('aria-pressed', 'true');
  expect(await sameWindow(page)).toBe(true);
  // The choice is this browser's: a reload keeps it.
  await page.reload();
  await expect(page.getByTestId('shell')).toBeVisible();
  await markWindow(page);
  // A classic deep link maps to v2 on the way back.
  await page.goto(`${server.baseUrl}/settings/appearance`);
  await markWindow(page);
  await page.getByTestId('theme-v2').click();
  await expect(page.getByTestId('v2-shell')).toBeVisible();
  await expect(page.getByTestId('shell')).toHaveCount(0);
  expect(await sameWindow(page)).toBe(true);
  await expect(page).toHaveURL(`${server.baseUrl}/settings/appearance`);

  // From an agent's Changes tab to Classic (the palette's switch): the address becomes the session's Diff.
  await page.goto(`${server.baseUrl}/agents/abc/changes`);
  await expect(page.locator('[data-testid="v2-agent-view"][data-session-id="abc"]')).toBeVisible();
  await markWindow(page);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('v2-palette')).toBeVisible();
  await page.keyboard.type('classic');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('shell')).toBeVisible();
  await expect(page).toHaveURL(`${server.baseUrl}/sessions/abc/diff`);
  expect(await sameWindow(page)).toBe(true);
  // Back to v2 for the next tests (the browser's own choice).
  await page.evaluate(() => window.localStorage.removeItem('switchboard.ui.theme'));
});

test('phone (390 × 844): bottom tabs instead of the rail; the tabs navigate', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.baseUrl}/`);
  await expect(page.getByTestId('v2-shell')).toHaveAttribute('data-layout', 'phone');
  await expect(page.getByTestId('v2-rail')).toHaveCount(0);
  const tabs = page.getByTestId('v2-phone-tabs');
  await expect(tabs).toBeVisible();
  await expect(tabs.locator('.v2-ptab')).toHaveText(['Home', 'Needs you', 'Agents', 'Results', 'More']);
  await expect(page.getByTestId('v2-tab-home')).toHaveAttribute('aria-current', 'page');
  // Every tab is at least 44 px high (touch target).
  for (const box of await tabs.locator('.v2-ptab').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
  await page.getByTestId('v2-tab-needs').click();
  await expect(page).toHaveURL(`${server.baseUrl}/needs-you`);
  await expect(page.getByTestId('v2-page-needs-you')).toBeVisible();
  await page.getByTestId('v2-tab-more').click();
  await expect(page).toHaveURL(`${server.baseUrl}/more`);
  await expect(page.getByTestId('v2-page-more')).toContainText('Projects');
  await page.getByTestId('v2-page-more').getByRole('link', { name: /Crews/ }).click();
  await expect(page).toHaveURL(`${server.baseUrl}/crews`);
  await expect(page.getByTestId('v2-tab-more')).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('v2-tab-agents').click();
  await expect(page.getByTestId('v2-page-agents')).toBeVisible();
  // Nothing scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
