import { type Page, expect, test } from '@playwright/test';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D150 · v2 Projects on the real path (fake claude, temp git, fake gh): finished and cancelled
 * projects go to a **Done (N)** section below the others, closed by default and remembered after
 * a reload, a cancelled card labelled "Cancelled"; the Start dialog's **In folder** picker puts the
 * steps' subfolder into a nested sidebar folder and the step's agent shows in it. Desktop and a
 * 390 × 844 phone.
 */

let world: PlansWorld;
let source = '';

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

/** A draft without a target branch (no merging) with one step. */
async function draft(page: Page, title: string): Promise<string> {
  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: source, title });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const planId = created.body.id as string;
  const added = await world.call(page, 'POST', `/api/plans/${planId}/items`, { key: 'PROJ-1', todo: { title: `${title} step`, estimateMinutes: 20 } });
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  return planId;
}

async function folderIn(page: Page, name: string, parentId: string | null = null): Promise<string> {
  const answer = await world.call(page, 'POST', '/api/sidebar/folders', { name, parentId });
  expect(answer.status).toBe(201);
  return (answer.body as SidebarLayout).folders.find((f) => f.name === name && (f.parentId ?? null) === parentId)?.id as string;
}

const card = (page: Page, planId: string) => page.locator(`[data-testid="v2-project-card"][data-plan-id="${planId}"]`);

test('Done (N): closed by default with its count, opens, remembered after a reload; a cancelled card says so', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/projects`);
  source = await world.sourceSession(page, 'v2-projects-done');
  const active = await draft(page, 'Acme active');
  const finished = await draft(page, 'Acme finished');
  const cancelled = await draft(page, 'Acme cancelled');
  // Finished: started, its one step marked done. Cancelled: cancelled from draft.
  expect((await world.call(page, 'POST', `/api/plans/${finished}/start`, { mergeMode: 'none', sidebarFolder: '' })).status).toBe(200);
  const step = await world.itemIn(page, finished, 'PROJ-1', 'running');
  expect((await world.call(page, 'POST', `/api/plans/${finished}/items/${step.id}/done`)).status).toBe(200);
  await expect.poll(async () => (await world.plan(page, finished)).state, { timeout: 30_000 }).toBe('done');
  expect((await world.call(page, 'POST', `/api/plans/${cancelled}/cancel`)).status).toBe(200);

  await page.goto(`${world.baseUrl}/projects`);
  await expect(card(page, active)).toBeVisible();
  const toggle = page.getByTestId('v2-projects-done-toggle');
  await expect(toggle).toHaveText('Done (2)');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(card(page, finished)).toHaveCount(0);
  await expect(card(page, cancelled)).toHaveCount(0);
  // The active one sits above the Done section.
  const activeBox = await card(page, active).boundingBox();
  const toggleBox = await toggle.boundingBox();
  expect((activeBox?.y ?? 0) < (toggleBox?.y ?? 0)).toBe(true);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const done = page.getByTestId('v2-project-done-cards').getByTestId('v2-project-card');
  // Newest finished first: the cancel came after the finish.
  await expect(done).toHaveCount(2);
  await expect(done.nth(0)).toHaveAttribute('data-plan-id', cancelled);
  await expect(done.nth(1)).toHaveAttribute('data-plan-id', finished);
  await expect(card(page, cancelled)).toContainText('Cancelled');
  await expect(card(page, finished)).toContainText('Done');

  await page.reload();
  await expect(page.getByTestId('v2-projects-done-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(card(page, cancelled)).toBeVisible();
  await page.getByTestId('v2-projects-done-toggle').click();
  await page.reload();
  await expect(page.getByTestId('v2-projects-done-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(card(page, cancelled)).toHaveCount(0);
});

test('phone 390 × 844: the Done section fits, opens and closes', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/projects`);
  const toggle = page.getByTestId('v2-projects-done-toggle');
  await expect(toggle).toHaveText('Done (2)');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const box = await toggle.boundingBox();
  expect((box?.height ?? 0) >= 40 && (box?.x ?? -1) >= 0).toBe(true);
  await toggle.click();
  await expect(page.getByTestId('v2-project-done-cards').getByTestId('v2-project-card')).toHaveCount(2);
  await expect(page.getByTestId('v2-project-done-cards')).toContainText('Cancelled');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await toggle.click();
  await expect(page.getByTestId('v2-project-done-cards')).toHaveCount(0);
});

test('Start: the In folder picker puts the steps’ subfolder into a nested folder; the step’s agent shows in it', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${world.baseUrl}/projects`);
  const acme = await folderIn(page, 'Acme');
  expect((await world.call(page, 'POST', '/api/sidebar/place', { sessionId: source, place: 'folder', folderId: acme })).status).toBe(200);
  const nested = await folderIn(page, 'Q4', await folderIn(page, 'Clients'));
  const planId = await draft(page, 'Acme nested');
  await page.goto(`${world.baseUrl}/projects/${planId}`);
  await page.getByTestId('v2-project-start').click();
  const dialog = page.getByTestId('v2-start-dialog');
  const parent = dialog.getByTestId('v2-start-parent');
  // Defaults to the project's own agent's folder; lists every level, indented.
  await expect(parent).toHaveValue(acme);
  await expect(parent.locator('option')).toHaveText(['Top level', 'Acme', 'Clients', '   Q4']);
  await parent.selectOption(nested);
  await expect(dialog.getByTestId('v2-start-folder')).toHaveValue('Acme nested');
  await dialog.locator('[data-testid="v2-mode-option"][data-mode="none"]').click();
  await dialog.getByTestId('v2-start-go').click();
  await expect(dialog).toHaveCount(0);

  const layout = (await world.call(page, 'GET', '/api/sidebar')).body as SidebarLayout;
  const sub = layout.folders.find((f) => f.name === 'Acme nested');
  expect(sub?.parentId).toBe(nested);
  expect((await world.plan(page, planId)).sidebarFolder).toEqual({ id: sub?.id, name: 'Acme nested' });
  const run = (await world.itemIn(page, planId, 'PROJ-1', 'running')).runSessionId as string;
  await expect.poll(async () => ((await world.call(page, 'GET', '/api/sidebar')).body as SidebarLayout).folders.find((f) => f.id === sub?.id)?.sessionIds ?? []).toEqual([run]);
  // The project's own agent stays where it was.
  expect(((await world.call(page, 'GET', '/api/sidebar')).body as SidebarLayout).folders.find((f) => f.id === acme)?.sessionIds).toEqual([source]);
  // Agents shows the subfolder.
  await page.goto(`${world.baseUrl}/agents`);
  await expect(page.locator(`[data-testid="v2-tree-folder"][data-folder="${sub?.id}"]`).getByTestId('v2-tree-folder-name')).toHaveText('Acme nested');
  expect((await world.call(page, 'POST', `/api/plans/${planId}/cancel`)).status).toBe(200);
});

test('phone 390 × 844: the picker fits; the top level with no subfolder name says why Start waits', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/projects`);
  const top = await folderIn(page, 'Phone top');
  const planId = await draft(page, 'Acme phone');
  await page.goto(`${world.baseUrl}/projects/${planId}`);
  await page.getByTestId('v2-project-start').click();
  const dialog = page.getByTestId('v2-start-dialog');
  const parent = dialog.getByTestId('v2-start-parent');
  await expect(parent).toBeVisible();
  const box = await parent.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  await dialog.locator('[data-testid="v2-mode-option"][data-mode="none"]').click();
  await dialog.getByTestId('v2-start-folder').fill('');
  await parent.selectOption('root');
  await expect(dialog).toContainText('Name a subfolder to put the steps at the top level');
  await expect(dialog.getByTestId('v2-start-go')).toBeDisabled();
  // No name and a folder: the steps go straight into it.
  await parent.selectOption(top);
  await dialog.getByTestId('v2-start-go').click();
  await expect(dialog).toHaveCount(0);
  expect((await world.plan(page, planId)).sidebarFolder).toEqual({ id: top, name: 'Phone top' });
  const run = (await world.itemIn(page, planId, 'PROJ-1', 'running')).runSessionId as string;
  await expect.poll(async () => ((await world.call(page, 'GET', '/api/sidebar')).body as SidebarLayout).folders.find((f) => f.id === top)?.sessionIds ?? []).toEqual([run]);
  expect((await world.call(page, 'POST', `/api/plans/${planId}/cancel`)).status).toBe(200);
});
