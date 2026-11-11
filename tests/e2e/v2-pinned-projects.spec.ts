import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D161 · a project pinned to the v2 rail on the real path (fake claude, temp git): Pin to sidebar
 * from its card's ⋯ in Projects, its row in Pinned with its status (Draft, then Working with
 * done/total once it runs), the Projects item's pulse while it works, Unpin from the project
 * page's ⋯, and the pulse gone once nothing works.
 */

let world: PlansWorld;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startPlansWorld(V2_SERVER_ENV);
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function pinnedIds(page: Page): Promise<string[]> {
  return [...((await world.call(page, 'GET', '/api/sidebar')).body as SidebarLayout).pinned];
}

test('pin a project from its card: its row shows Draft, then Working 0/1 with the Projects pulse; unpin from its page', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${world.baseUrl}/projects`);
  const source = await world.sourceSession(page, 'v2-pinned-projects');
  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: source, title: 'Pin me' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const planId = created.body.id as string;
  expect((await world.call(page, 'POST', `/api/plans/${planId}/items`, { key: 'PROJ-1', todo: { title: 'Pin me step', estimateMinutes: 20 } })).status).toBe(201);

  await page.goto(`${world.baseUrl}/projects`);
  const pulse = page.getByTestId('v2-nav-pulse-projects');
  await expect(pulse).toHaveCount(0);
  const card = page.locator(`[data-testid="v2-project-card"][data-plan-id="${planId}"]`);
  await card.getByTestId('v2-project-card-menu').click();
  await page.getByRole('menuitem', { name: 'Pin to sidebar' }).click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Pinned “Pin me” to the sidebar.' })).toBeVisible();
  // The menu acts alone: the card did not open.
  await expect(page).toHaveURL(/\/projects$/);
  await expect.poll(() => pinnedIds(page)).toEqual([`plan~${planId}`]);

  const row = page.getByTestId('v2-rail-pins').locator(`[data-testid="v2-pin-project"][data-plan="${planId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('Pin me');
  await expect(row.getByTestId('v2-pin-project-line')).toHaveText('Draft');

  // Started (no merge step): its one step runs, so the row works and the Projects item pulses.
  expect((await world.call(page, 'POST', `/api/plans/${planId}/start`, { mergeMode: 'none', sidebarFolder: '' })).status).toBe(200);
  await world.itemIn(page, planId, 'PROJ-1', 'running');
  await expect(row).toHaveAttribute('data-status', 'working', { timeout: 15_000 });
  await expect(row.getByTestId('v2-pin-project-line')).toHaveText('0/1');
  await expect(pulse).toBeVisible();
  await expect(page.getByTestId('v2-nav-projects')).toHaveAccessibleName(/a project is working/);
  await page.mouse.move(0, 0);
  await page.getByTestId('v2-rail').screenshot({ path: path.join('test-results', 'v2-pinned-project-rail.png') });

  // The row opens the project; Unpin from its page's ⋯.
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${planId}$`));
  await page.getByTestId('v2-project-menu').click();
  await page.getByRole('menuitem', { name: 'Unpin from sidebar' }).click();
  await expect.poll(() => pinnedIds(page)).toEqual([]);
  await expect(row).toHaveCount(0);

  // Nothing works once it is cancelled: no pulse.
  expect((await world.call(page, 'POST', `/api/plans/${planId}/cancel`)).status).toBe(200);
  await expect(pulse).toHaveCount(0, { timeout: 15_000 });
});
