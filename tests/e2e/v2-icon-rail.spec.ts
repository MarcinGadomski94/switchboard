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
});
