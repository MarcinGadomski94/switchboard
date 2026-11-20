import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D181 (corrected 2026-11-20) · the rail (`docs/v2.md` → *Shell*): on a desktop the eight
 * destinations are icons in two rows of four with a tooltip (on hover and on keyboard focus);
 * the rail keeps its width, Pinned and Recent stay lists under the icons, Recent lists as many
 * agents as Settings › Appearance says, pinned and recent agents name their computer once one
 * is paired, and Results is Artifacts.
 */
let world: TeamWorld;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-v2-icon-rail', { plain: true, env: { ...V2_SERVER_ENV, SWITCHBOARD_TEST_SECRET_STORE: 'memory' } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('two rows of four icons, a tooltip on hover and on focus; the rail keeps its width; Artifacts', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const rail = page.getByTestId('v2-rail');
  await expect(rail).toBeVisible();
  // The rail is back to its width (232 px), with the lists under the icons.
  expect(Math.round((await rail.boundingBox())?.width ?? 0)).toBeGreaterThan(200);
  const boxes = await page.getByTestId('v2-rail-grid').locator('a.v2-nav-item').evaluateAll((links) => links.map((link) => link.getBoundingClientRect()).map((box) => ({ x: Math.round(box.x), y: Math.round(box.y) })));
  expect(boxes).toHaveLength(8);
  expect(new Set(boxes.map((box) => box.y)).size).toBe(2);
  expect(new Set(boxes.map((box) => box.x)).size).toBe(4);
  await expect(page.getByTestId('v2-nav-results')).toHaveAccessibleName('Artifacts');
  await page.getByTestId('v2-nav-agents').hover();
  await expect(page.getByTestId('v2-rail-tip')).toHaveText('Agents');
  await page.mouse.move(700, 450);
  await expect(page.getByTestId('v2-rail-tip')).toHaveCount(0);
  await page.getByTestId('v2-nav-results').focus();
  await expect(page.getByTestId('v2-rail-tip')).toHaveText('Artifacts');
  await page.getByTestId('v2-nav-results').click();
  await expect(page).toHaveURL(/\/results$/);
  await expect(page.getByRole('heading', { name: 'Artifacts' }).first()).toBeVisible();
  // Pinned is a list in the rail (the hint while nothing is pinned).
  await expect(page.getByTestId('v2-rail-pins')).toContainText('Pin agents or crews from their ⋯ menu.');
});

test('Pinned and Recent are lists under the icons; Recent follows Settings', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${world.baseUrl}/`);
  await page.evaluate(() => {
    window.localStorage.removeItem('switchboard.v2.recent');
    window.localStorage.removeItem('switchboard.v2.recentCount');
    window.localStorage.removeItem('switchboard.v2.recentOpen');
  });

  // Three agents opened: Recent lists them, newest first.
  const ids: string[] = [];
  for (const name of ['acme-one', 'acme-two', 'acme-three']) {
    const session = await world.startSession(page, name, 'Reply with just OK.');
    ids.push(session.id);
    await page.goto(`${world.baseUrl}/agents/${session.id}`);
    await expect(page.getByTestId('v2-agent-title')).toBeVisible();
  }
  const items = page.getByTestId('v2-rail').getByTestId('v2-recent-item');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveAttribute('data-session', ids[2] as string);
  await items.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${ids[1]}$`));

  // Pin one: it shows in Pinned (and leaves Recent); a screenshot of Home.
  await page.getByTestId('v2-agent-menu').click();
  await page.getByRole('menuitem', { name: 'Pin to sidebar' }).click();
  await page.goto(`${world.baseUrl}/`);
  await expect(page.getByTestId('v2-rail-pins').getByTestId('v2-pin-agent')).toHaveCount(1);
  await expect(items).toHaveCount(2);
  await page.mouse.move(900, 600);
  await page.screenshot({ path: path.join(os.tmpdir(), 'd181b-shots', 'home-1440.png') });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: path.join(os.tmpdir(), 'd181b-shots', 'home-1024.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Folding Recent is remembered.
  await page.getByTestId('v2-recent-toggle').click();
  await expect(items).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('v2-recent-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('v2-recent-toggle').click();
  await expect(items).toHaveCount(2);

  // Settings › Appearance › Recent agents: 1, then 0 (Recent goes).
  await page.goto(`${world.baseUrl}/settings/appearance`);
  const count = page.getByTestId('v2-recent-count');
  await expect(count).toHaveValue('5');
  await count.selectOption('1');
  await expect(items).toHaveCount(1);
  await count.selectOption('0');
  await expect(page.getByTestId('v2-recent')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('v2-recent-count')).toHaveValue('0');
  await expect(page.getByTestId('v2-recent')).toHaveCount(0);
  await page.getByTestId('v2-recent-count').selectOption('5');
});

test('D181 (2026-11-20): a pinned agent names its computer on a second line, under its name', async ({ page }) => {
  // A paired computer (in this browser's view only): this computer's agents then name it.
  await page.route('**/api/machines', async (route) => {
    const response = await route.fetch();
    const view = (await response.json()) as { machines: unknown[] };
    view.machines = [{ id: 'acmepairedaa', name: 'Acme-MacBook', address: '100.64.0.9:13002', state: 'online', pairedAt: '2026-11-20T08:00:00.000Z', lastSeenAt: null }, ...view.machines];
    await route.fulfill({ response, json: view });
  });
  await page.goto(`${world.baseUrl}/`);
  const row = page.getByTestId('v2-rail-pins').getByTestId('v2-pin-agent').first();
  await expect(row).toBeVisible();
  const sub = row.getByTestId('v2-pin-sub');
  await expect(sub).toBeVisible();
  const nameBox = await row.locator('.v2-pin-name').boundingBox();
  const subBox = await sub.boundingBox();
  // Under the name (a second line), starting where the name starts (not under the status dot).
  expect((subBox?.y ?? 0) >= (nameBox?.y ?? 0) + (nameBox?.height ?? 0) - 2).toBe(true);
  expect(Math.abs((subBox?.x ?? 0) - (nameBox?.x ?? 0))).toBeLessThanOrEqual(2);
  await page.mouse.move(900, 600);
  await page.screenshot({ path: path.join(os.tmpdir(), 'sidebar-resize-shots', 'rows-1440.png') });
});

test('D181 (2026-11-20): the sidebar resizes by its edge (drag, keys, double-click) and remembers it', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  await page.evaluate(() => window.localStorage.removeItem('switchboard.v2.railWidth'));
  await page.reload();
  const rail = page.getByTestId('v2-rail');
  const handle = page.getByTestId('v2-rail-handle');
  await expect(handle).toHaveAttribute('aria-valuenow', '232');
  await expect(handle).toHaveAccessibleName('Resize the sidebar');
  const width = async (): Promise<number> => Math.round((await rail.boundingBox())?.width ?? 0);
  expect(await width()).toBe(232);

  // Drag the edge to 320 px: the rail follows, the four icons per row spread with it.
  const box = await handle.boundingBox();
  const y = (box?.y ?? 0) + 300;
  await page.mouse.move((box?.x ?? 0) + 4, y);
  await page.mouse.down();
  await page.mouse.move(250, y, { steps: 4 });
  await page.mouse.move(320, y, { steps: 4 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow', '320');
  expect(await width()).toBe(320);
  const xs = await page.getByTestId('v2-rail-grid').locator('a.v2-nav-item').evaluateAll((links) => [...new Set(links.map((link) => Math.round(link.getBoundingClientRect().x)))]);
  expect(xs).toHaveLength(4);
  await page.mouse.move(900, 600);
  await page.screenshot({ path: path.join(os.tmpdir(), 'sidebar-resize-shots', 'home-1440-wide.png') });

  // Remembered across a reload.
  await page.reload();
  await expect(page.getByTestId('v2-rail-handle')).toHaveAttribute('aria-valuenow', '320');
  expect(await width()).toBe(320);

  // Keys: → by 16, End to 400, Home to 200.
  await page.getByTestId('v2-rail-handle').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('v2-rail-handle')).toHaveAttribute('aria-valuenow', '336');
  await page.keyboard.press('End');
  await expect(page.getByTestId('v2-rail-handle')).toHaveAttribute('aria-valuenow', '400');
  await page.keyboard.press('Home');
  await expect(page.getByTestId('v2-rail-handle')).toHaveAttribute('aria-valuenow', '200');
  expect(await width()).toBe(200);

  // Double-click: back to 232.
  await page.getByTestId('v2-rail-handle').dblclick();
  await expect(page.getByTestId('v2-rail-handle')).toHaveAttribute('aria-valuenow', '232');
  await page.mouse.move(900, 600);
  await page.screenshot({ path: path.join(os.tmpdir(), 'sidebar-resize-shots', 'home-1440-default.png') });

  // Tablet: no handle (the narrow rail keeps its width).
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.getByTestId('v2-rail-handle')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
});
