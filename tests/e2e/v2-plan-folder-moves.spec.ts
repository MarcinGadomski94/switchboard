import { type Locator, type Page, expect, test } from '@playwright/test';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D151 · moving a project's runs folder in v2 Agents, on the real path (fake claude, temp git,
 * fake gh): while the project runs, dragging its runs folder onto another folder is refused with
 * the reason (no highlight, a toast, nothing moves) and Move to… disables every other place with
 * it; once the project is paused the drag moves it and the project page's Activity says where it
 * went. Dropping a folder onto the folder it is already in does nothing at all (no toast).
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

async function folderIn(page: Page, name: string, parentId: string | null = null): Promise<string> {
  const answer = await world.call(page, 'POST', '/api/sidebar/folders', { name, parentId });
  expect(answer.status).toBe(201);
  return (answer.body as SidebarLayout).folders.find((f) => f.name === name && (f.parentId ?? null) === parentId)?.id as string;
}

async function parentOf(page: Page, id: string): Promise<string | null | undefined> {
  const layout = (await world.call(page, 'GET', '/api/sidebar')).body as SidebarLayout;
  const folder = layout.folders.find((f) => f.id === id);
  return folder ? (folder.parentId ?? null) : undefined;
}

function folderRow(page: Page, name: string): Locator {
  return page.getByTestId('v2-tree-folder').filter({ has: page.getByTestId('v2-tree-folder-name').getByText(name, { exact: true }) });
}

/** Drags `from` over `to` with the mouse (Chromium's native drag) and answers whether `to` showed the drop highlight. */
async function dragOver(page: Page, from: Locator, to: Locator): Promise<boolean> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error('not on screen');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 6, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  const highlighted = (await to.getAttribute('data-drop-ok')) !== null;
  await page.mouse.up();
  return highlighted;
}

const WHY = 'The project “Acme epic” is running: pause it to move its folder.';

test('a running project\'s folder refuses to move (drag and Move to…); paused, it moves and the project notes it; a drop where it already is does nothing', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/agents`);
  const source = await world.sourceSession(page, 'v2-plan-folder-moves');
  const releases = await folderIn(page, 'Releases');
  expect((await world.call(page, 'POST', '/api/sidebar/place', { sessionId: source, place: 'folder', folderId: releases })).status).toBe(200);
  const other = await folderIn(page, 'Other');
  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: source, title: 'Acme epic' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const planId = created.body.id as string;
  expect((await world.call(page, 'POST', `/api/plans/${planId}/items`, { key: 'PROJ-1', todo: { title: 'Acme step', estimateMinutes: 20 } })).status).toBe(201);
  const started = await world.call(page, 'POST', `/api/plans/${planId}/start`, { mergeMode: 'none', sidebarFolder: 'Acme epic' });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const runsFolder = started.body.sidebarFolder.id as string;
  await world.itemIn(page, planId, 'PROJ-1', 'running');

  await page.reload();
  await expect(folderRow(page, 'Acme epic')).toBeVisible();

  // Running: the drag is refused with the reason, nothing moves.
  expect(await dragOver(page, folderRow(page, 'Acme epic'), folderRow(page, 'Other'))).toBe(false);
  await expect(page.getByTestId('v2-toast').filter({ hasText: WHY })).toBeVisible();
  expect(await parentOf(page, runsFolder)).toBe(releases);
  // The folder holding it is held too.
  expect(await dragOver(page, folderRow(page, 'Releases'), folderRow(page, 'Other'))).toBe(false);
  expect(await parentOf(page, releases)).toBeNull();
  // The server refuses it too (another client, an older tab).
  const refused = await world.call(page, 'PUT', `/api/sidebar/folders/${runsFolder}/position`, { index: 0, parentId: other });
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ error: 'project-running', message: WHY });

  // Move to…: every other place disabled with the reason; its present place picked.
  await folderRow(page, 'Acme epic').getByTestId('v2-tree-folder-menu').click();
  await page.getByTestId('v2-folder-menu').getByRole('menuitem', { name: 'Move to…' }).click();
  const dialog = page.getByTestId('v2-folder-move-dialog');
  const option = (value: string): Locator => dialog.locator(`[data-testid="v2-folder-move-option"][data-value="${value}"]`);
  await expect(option(releases).locator('input')).toBeChecked();
  await expect(option(other).locator('input')).toBeDisabled();
  await expect(option(other)).toContainText(WHY);
  await expect(option('loose').locator('input')).toBeDisabled();
  // Move here on its present place: nothing happens, nothing is said.
  const toastsBefore = await page.getByTestId('v2-toast').count();
  await dialog.getByTestId('v2-folder-move-go').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'already there' })).toHaveCount(0);
  expect(await page.getByTestId('v2-toast').count()).toBeLessThanOrEqual(toastsBefore);

  // Paused: the drag moves it; the project notes where.
  expect((await world.call(page, 'POST', `/api/plans/${planId}/pause`)).status).toBe(200);
  await page.reload();
  await expect(folderRow(page, 'Acme epic')).toBeVisible();
  // (The drop highlight itself is covered by v2-agents.spec.ts; here the move and its toast are checked.)
  await dragOver(page, folderRow(page, 'Acme epic'), folderRow(page, 'Other'));
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Moved folder “Acme epic” to Other.' })).toBeVisible();
  await expect.poll(() => parentOf(page, runsFolder)).toBe(other);
  await expect(folderRow(page, 'Acme epic')).toHaveAttribute('aria-level', '2');

  // Dropped onto the folder it is already in: no highlight, no toast, nothing moves.
  await page.reload();
  await expect(folderRow(page, 'Acme epic')).toBeVisible();
  expect(await dragOver(page, folderRow(page, 'Acme epic'), folderRow(page, 'Other'))).toBe(false);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('v2-toast')).toHaveCount(0);
  expect(await parentOf(page, runsFolder)).toBe(other);

  // The project's Activity.
  await page.goto(`${world.baseUrl}/projects/${planId}`);
  await expect(page.getByTestId('v2-project-activity-line')).toHaveCount(1);
  await expect(page.getByTestId('v2-project-activity-line').first()).toContainText('Runs folder moved to Other › Acme epic');
  expect((await world.call(page, 'POST', `/api/plans/${planId}/cancel`)).status).toBe(200);
});
