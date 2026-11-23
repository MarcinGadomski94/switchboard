import { type Page, expect, test } from '@playwright/test';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * 2026-11-23 (D119 follow-up: "I can't choose a subfolder as a parent folder for agents created for
 * implementation"): v2's Import a Jira epic has a **Sidebar folder** choice like the classic one: every
 * folder at every level, by its whole path; the project's own "Plan · …" folder is made inside the
 * nested folder picked, with the project's agent in it. Real path: fake claude, temp git, the fake Jira.
 */
let world: PlansWorld;

test.beforeAll(async () => {
  world = await startPlansWorld(V2_SERVER_ENV);
});

test.afterAll(async () => {
  await world?.stop();
});

async function sidebarFolder(page: Page, name: string, parentId: string | null = null): Promise<string> {
  const answer = await world.call(page, 'POST', '/api/sidebar/folders', { name, parentId });
  expect(answer.status).toBe(201);
  return (answer.body as SidebarLayout).folders.find((f) => f.name === name && (f.parentId ?? null) === parentId)?.id as string;
}

test('a nested sidebar folder picked in the import holds the project\'s folder and its agent', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${world.baseUrl}/projects`);
  await world.setPlans(page, true);
  const repoFolder = (await world.call(page, 'POST', '/api/folders', { path: world.git.mobile })).body.id as string;
  const acme = await sidebarFolder(page, 'Acme');
  const releases = await sidebarFolder(page, 'Releases', acme);
  const q4 = await sidebarFolder(page, 'Q4', releases);

  await page.goto(`${world.baseUrl}/projects`);
  await page.getByTestId('v2-projects-import').click();
  const dialog = page.getByTestId('v2-jira-import');
  await dialog.getByTestId('v2-jira-import-epic').fill('PROJ-10');
  await dialog.getByTestId('v2-jira-import-preview').click();
  await expect(dialog.getByTestId('v2-jira-import-items').locator('li')).toHaveCount(5);
  await dialog.getByTestId('v2-jira-import-folder').selectOption(repoFolder);
  const picker = dialog.getByTestId('v2-jira-import-sidebar');
  await expect(picker.locator('option').first()).toHaveText('Sidebar root');
  await expect(picker.locator(`option[value="${q4}"]`)).toHaveText('Acme / Releases / Q4');
  await picker.selectOption(q4);
  await dialog.getByTestId('v2-jira-import-target').fill('feature/PROJ-10-acme');
  await dialog.getByTestId('v2-jira-import-create').click();
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);

  const layout = (await world.call(page, 'GET', '/api/sidebar')).body as SidebarLayout;
  const made = layout.folders.find((f) => f.name.startsWith('Plan · '));
  expect(made?.parentId).toBe(q4);
  expect(made?.sessionIds.length).toBe(1);
});
