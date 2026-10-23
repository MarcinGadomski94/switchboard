import { expect, test } from '@playwright/test';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { openWithHub } from './question-world.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';

/**
 * D130 (`docs/plans.md` → *The runs' sidebar subfolder*): the Start dialog's **Sidebar subfolder**
 * is prefilled with the plan's title; Start makes it inside the source session's sidebar folder
 * and the plan's runs show in it, the source staying where it is. Phone width: the field fits.
 * Real path: fake-claude, temp git, fake gh.
 */

let world: PlansWorld;

test.beforeAll(async () => {
  world = await startPlansWorld();
});

test.afterAll(async () => {
  await world?.stop();
});

async function folderIn(page: Parameters<PlansWorld['call']>[0], name: string, parentId: string | null = null): Promise<string> {
  const answer = await world.call(page, 'POST', '/api/sidebar/folders', { name, parentId });
  expect(answer.status).toBe(201);
  return (answer.body as SidebarLayout).folders.find((f) => f.name === name && (f.parentId ?? null) === parentId)?.id as string;
}

test('Start: the prefilled subfolder is made in the source\'s folder and the runs show in it', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await world.setPlans(page, true);
  const source = await world.sourceSession(page, 'subfolder-source');
  const acme = await folderIn(page, 'Acme');
  expect((await world.call(page, 'POST', '/api/sidebar/place', { sessionId: source, place: 'folder', folderId: acme })).status).toBe(200);
  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: source, title: 'PROJ-123 Acme checkout' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const planId = created.body.id as string;
  expect((await world.call(page, 'POST', `/api/plans/${planId}/items`, { key: 'PROJ-124', todo: { title: 'Build the cart', estimateMinutes: 20 } })).status).toBe(201);

  await page.goto(`${world.baseUrl}/plans/${planId}`);
  await page.getByTestId('plan-start').click();
  const dialog = page.getByTestId('plan-mode-dialog');
  const input = dialog.getByTestId('plan-start-folder-input');
  await expect(input).toHaveValue('PROJ-123 Acme checkout');
  await dialog.getByTestId('plan-mode-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('plan-state')).toHaveText('running');

  const made = (await world.call(page, 'GET', '/api/sidebar')).body as SidebarLayout;
  const sub = made.folders.find((f) => f.name === 'PROJ-123 Acme checkout');
  expect(sub?.parentId).toBe(acme);
  const sessions = page.getByTestId('sidebar-sessions');
  await expect(sessions.locator(`[data-testid="sidebar-folder"][data-folder-id="${sub?.id}"]`).getByTestId('sidebar-folder-name')).toHaveText('PROJ-123 Acme checkout');
  const run = (await world.itemIn(page, planId, 'PROJ-124', 'running')).runSessionId as string;
  await expect(sessions.locator(`a.sb-session[data-session-id="${run}"]`)).toHaveAttribute('data-group-folder', sub?.id as string);
  await expect(sessions.locator(`a.sb-session[data-session-id="${source}"]`)).toHaveAttribute('data-group-folder', acme);
  expect((await world.call(page, 'POST', `/api/plans/${planId}/cancel`)).status).toBe(200);
});

test('360 px: the Sidebar subfolder field fits; cleared, the plan starts without a subfolder', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 740 });
  await openWithHub(page, `${world.baseUrl}/inbox`);
  const source = await world.sourceSession(page, 'phone-source');
  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: source, title: 'PROJ-200 Acme phone plan with a much longer title than fits a sidebar folder' });
  expect(created.status).toBe(201);
  const planId = created.body.id as string;
  expect((await world.call(page, 'POST', `/api/plans/${planId}/items`, { key: 'PROJ-201', todo: { title: 'Fix the phone layout', estimateMinutes: 20 } })).status).toBe(201);
  await page.goto(`${world.baseUrl}/plans/${planId}`);
  await page.getByTestId('plan-start').click();
  const dialog = page.getByTestId('plan-mode-dialog');
  const input = dialog.getByTestId('plan-start-folder-input');
  await expect(input).toHaveValue('PROJ-200 Acme phone plan with a much longer title than…');
  const box = await input.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true);
  await input.fill('');
  await dialog.getByTestId('plan-mode-confirm').click();
  await expect(dialog).toHaveCount(0);
  expect((await world.plan(page, planId)).sidebarFolder).toBeNull();
  expect(((await world.call(page, 'GET', '/api/sidebar')).body as SidebarLayout).folders.some((f) => f.name.startsWith('PROJ-200'))).toBe(false);
  expect((await world.call(page, 'POST', `/api/plans/${planId}/cancel`)).status).toBe(200);
});
