import { type Page, expect, test } from '@playwright/test';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { openWithHub } from './question-world.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';

/**
 * D119 · Import from Jira into a folder puts the plan's owner session in the sidebar: **Sidebar
 * folder** in Where it runs defaults to the sidebar folder holding the most open sessions of the
 * chosen working folder (else the last choice for it, else the root), follows the working folder
 * until picked by hand, and Create plan makes the plan's own subfolder "Plan · <title>" there with
 * the session first. Real path: fake claude, temp git repos, the fake Jira (never the real Jira).
 */
let world: PlansWorld;
let repoFolder = '';
let workspaceFolder = '';
let releases = '';
let ops = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startPlansWorld();
});

test.afterAll(async () => {
  await world?.stop();
});

async function layout(page: Page): Promise<SidebarLayout> {
  return (await world.call(page, 'GET', '/api/sidebar')).body as SidebarLayout;
}

async function sidebarFolder(page: Page, name: string, parentId: string | null = null): Promise<string> {
  const answer = await world.call(page, 'POST', '/api/sidebar/folders', { name, parentId });
  expect(answer.status).toBe(201);
  return (answer.body as SidebarLayout).folders.find((f) => f.name === name && (f.parentId ?? null) === parentId)?.id as string;
}

async function sessionIn(page: Page, name: string, folder: string, sidebar: string): Promise<string> {
  const started = await world.call(page, 'POST', '/api/sessions', { simple: true, name, title: name, task: 'Hello', folder, worktrees: false });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const id = started.body.id as string;
  expect((await world.call(page, 'POST', '/api/sidebar/place', { sessionId: id, place: 'folder', folderId: sidebar })).status).toBe(200);
  return id;
}

async function openImport(page: Page) {
  await page.goto(`${world.baseUrl}/plans`);
  await page.getByTestId('plans-import-jira').click();
  const dialog = page.getByTestId('jira-import');
  await expect(dialog.getByTestId('jira-where')).toBeVisible();
  return dialog;
}

test('the sidebar folder defaults from the open sessions of the working folder; the plan gets its own subfolder there', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await world.setPlans(page, true);
  const folders = (await world.call(page, 'GET', '/api/folders')).body as Array<{ id: string; kind: string }>;
  workspaceFolder = folders.find((folder) => folder.kind === 'workspace')?.id as string;
  repoFolder = (await world.call(page, 'POST', '/api/folders', { path: world.git.mobile })).body.id as string;
  releases = await sidebarFolder(page, 'Releases', await sidebarFolder(page, 'Acme'));
  ops = await sidebarFolder(page, 'Ops');
  // Two sessions of the repo in Acme / Releases, one in Ops; one of the workspace in Ops.
  await sessionIn(page, 'repo-one', repoFolder, releases);
  await sessionIn(page, 'repo-two', repoFolder, releases);
  await sessionIn(page, 'repo-three', repoFolder, ops);
  await sessionIn(page, 'ws-one', workspaceFolder, ops);

  const dialog = await openImport(page);
  const picker = dialog.getByTestId('jira-where-sidebar');
  await dialog.getByTestId('jira-where-folder').selectOption(repoFolder);
  await expect(picker).toHaveValue(releases);
  // The tree: the root first, a subfolder indented under its folder.
  await expect(picker.locator('option').first()).toHaveText('Sidebar root');
  await expect(picker.locator(`option[value="${releases}"]`)).toHaveText(/^ +Releases$/);
  // It follows the working folder…
  await dialog.getByTestId('jira-where-folder').selectOption(workspaceFolder);
  await expect(picker).toHaveValue(ops);
  await dialog.getByTestId('jira-where-folder').selectOption(repoFolder);
  await expect(picker).toHaveValue(releases);
  // …until the developer picks one by hand.
  await picker.selectOption('');
  await dialog.getByTestId('jira-where-folder').selectOption(workspaceFolder);
  await expect(picker).toHaveValue('');
  await picker.selectOption(releases);
  await dialog.getByTestId('jira-where-folder').selectOption(repoFolder);

  await dialog.getByTestId('jira-epic').fill('PROJ-10');
  await dialog.getByTestId('jira-preview').click();
  await expect(dialog.getByTestId('jira-items').locator('li')).toHaveCount(5);
  await dialog.getByTestId('jira-base').fill('main');
  await dialog.getByTestId('jira-create').click();
  await expect(page.getByTestId('plan-title')).toHaveText('PROJ-10 Acme checkout');
  const planId = (await page.getByTestId('plan-page').getAttribute('data-plan-id')) as string;
  const owner = (await world.plan(page, planId)).sourceSessionId;

  // The sidebar shows "Plan · PROJ-10 Acme checkout" inside Acme / Releases, with the owner session in it.
  const made = (await layout(page)).folders.find((f) => f.name === 'Plan · PROJ-10 Acme checkout');
  expect(made).toMatchObject({ parentId: releases, sessionIds: [owner] });
  const sessions = page.getByTestId('sidebar-sessions');
  const folderRow = sessions.locator(`[data-testid="sidebar-folder"][data-folder-id="${made?.id}"]`);
  await expect(folderRow.getByTestId('sidebar-folder-name')).toHaveText('Plan · PROJ-10 Acme checkout');
  await expect(sessions.locator(`a.sb-session[data-session-id="${owner}"]`)).toHaveAttribute('data-group-folder', made?.id as string);
});

test('360 px: the sidebar-folder picker fits, and an import into the root makes a top-level "Plan · … (2)"', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 740 });
  await openWithHub(page, `${world.baseUrl}/inbox`);
  // A top-level folder with the plan's name exists already: the new one gets " (2)".
  await sidebarFolder(page, 'Plan · PROJ-10 Acme phone');
  const dialog = await openImport(page);
  await dialog.getByTestId('jira-where-folder').selectOption(repoFolder);
  const picker = dialog.getByTestId('jira-where-sidebar');
  await expect(picker).toBeVisible();
  const box = await picker.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await picker.selectOption('');
  await dialog.getByTestId('jira-epic').fill('PROJ-10');
  await dialog.getByTestId('jira-preview').click();
  await expect(dialog.getByTestId('jira-items').locator('li')).toHaveCount(5);
  await dialog.getByTestId('jira-title').fill('PROJ-10 Acme phone');
  await dialog.getByTestId('jira-target').fill('feature/PROJ-10-acme-phone');
  await dialog.getByTestId('jira-base').fill('main');
  await dialog.getByTestId('jira-create').click();
  await expect(page.getByTestId('plan-title')).toHaveText('PROJ-10 Acme phone');
  const planId = (await page.getByTestId('plan-page').getAttribute('data-plan-id')) as string;
  const owner = (await world.plan(page, planId)).sourceSessionId;
  const made = (await layout(page)).folders.find((f) => f.name === 'Plan · PROJ-10 Acme phone (2)');
  expect(made).toMatchObject({ parentId: null, sessionIds: [owner] });

  // The next import of this working folder remembers the root (the developer's last choice) only when no folder holds its sessions:
  // Releases still holds two, so it stays the default.
  const next = await openImport(page);
  await next.getByTestId('jira-where-folder').selectOption(repoFolder);
  await expect(next.getByTestId('jira-where-sidebar')).toHaveValue(releases);
  await next.getByRole('button', { name: 'Cancel' }).click();
});
