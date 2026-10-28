import { type Browser, type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, startQuestionWorld } from './question-world.ts';
import { useV2 } from './v2-world.ts';

/**
 * D141 · deleting a sidebar folder can archive the agents in it (real server, fake-claude):
 * - v2 desktop: the Agents tree's Delete folder… asks "Delete “Acme” and archive its 3 agents?",
 *   the box ticked, one working ("[fake:hang]") counted, the names listed; Delete archives all
 *   three (the working one stopped), deletes the folder and its subfolder, the toast says so and
 *   Archived lists them; Undo restores them and the tree.
 * - classic desktop: the sidebar's folder ⋯ → Delete folder… opens the same confirmation
 *   ("sessions"); Delete archives them; the toast.
 * - phone (390 × 844): the classic drawer's confirmation fits the screen; v2's phone Archived list shows the result.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-folder-archive');
});

test.afterAll(async () => {
  await world?.stop();
});

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, u, b]) => {
      const answer = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      return answer.status === 204 ? null : answer.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;
}

async function status(page: Page, id: string): Promise<string> {
  return (await api<SessionDetail>(page, 'GET', `/api/sessions/${encodeURIComponent(id)}`)).status;
}

async function closedAt(page: Page, id: string): Promise<string | null> {
  return (await api<SessionDetail>(page, 'GET', `/api/sessions/${encodeURIComponent(id)}`)).closedAt ?? null;
}

/** A folder `name` with a subfolder "Deep": `top` sessions in the folder, `deep` in the subfolder. */
async function folderWith(page: Page, name: string, top: readonly string[], deep: readonly string[]): Promise<string> {
  let layout = await api<SidebarLayout>(page, 'POST', '/api/sidebar/folders', { name });
  const id = layout.folders.find((f) => f.name === name && !f.parentId)?.id as string;
  layout = await api<SidebarLayout>(page, 'POST', '/api/sidebar/folders', { name: `${name} Deep`, parentId: id });
  const sub = layout.folders.find((f) => f.parentId === id)?.id as string;
  for (const sessionId of top) await api(page, 'POST', '/api/sidebar/place', { sessionId, place: 'folder', folderId: id });
  for (const sessionId of deep) await api(page, 'POST', '/api/sidebar/place', { sessionId, place: 'folder', folderId: sub });
  return id;
}

/** Starts sessions; the `[fake:hang]` one keeps working, the others finish their turn. */
async function agents(page: Page, prefix: string): Promise<{ working: string; idle: string; deep: string }> {
  const working = (await world.startSession(page, `${prefix}-working`, '[fake:hang] Keep working.')).id;
  const idle = (await world.startSession(page, `${prefix}-idle`, 'Reply with just OK.')).id;
  const deep = (await world.startSession(page, `${prefix}-deep`, 'Reply with just OK.')).id;
  await expect.poll(() => status(page, working), { timeout: 15_000 }).toBe('run');
  for (const id of [idle, deep]) await expect.poll(() => status(page, id), { timeout: 15_000 }).toBe('done');
  return { working, idle, deep };
}

async function openPage(browser: Browser, phone: boolean, v2: boolean): Promise<Page> {
  const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await stubToolProbes(page);
  if (v2) await useV2(page);
  return page;
}

test('v2 desktop: the confirmation counts the agents (a subfolder too), ticked; Delete archives them, the toast says so, Archived lists them; Undo restores', async ({ browser }) => {
  const page = await openPage(browser, false, true);
  await page.goto(`${world.baseUrl}/agents`);
  const a = await agents(page, 'v2');
  await folderWith(page, 'Acme', [a.working, a.idle], [a.deep]);
  await page.reload();
  const folder = page.getByTestId('v2-tree-folder').filter({ has: page.getByTestId('v2-tree-folder-name').getByText('Acme', { exact: true }) });
  await folder.getByTestId('v2-tree-folder-menu').click();
  await page.getByTestId('v2-folder-menu').getByRole('menuitem', { name: 'Delete folder…' }).click();

  const dialog = page.getByTestId('v2-folder-dialog');
  await expect(dialog).toContainText('Delete “Acme” and archive its 3 agents?');
  await expect(dialog.getByTestId('v2-folder-archive-check')).toBeChecked();
  await expect(dialog.getByTestId('v2-folder-archive-working')).toHaveText('1 is working and will be stopped.');
  await expect(dialog.getByTestId('v2-folder-archive-names').locator('li')).toHaveText(['v2-working', 'v2-idle', 'v2-deep']);
  // Unticked: the plain delete's words; ticked again.
  await dialog.getByTestId('v2-folder-archive-check').uncheck();
  await expect(dialog).toContainText('Delete “Acme”?');
  await expect(dialog.getByTestId('v2-folder-delete-text')).toContainText('No agents are deleted.');
  await dialog.getByTestId('v2-folder-archive-check').check();
  await dialog.getByTestId('v2-folder-go').click();

  const toast = page.getByTestId('v2-toast').filter({ hasText: 'Deleted “Acme”. 3 archived.' });
  await expect(toast).toBeVisible();
  await expect(folder).toHaveCount(0);
  for (const id of [a.working, a.idle, a.deep]) await expect.poll(() => closedAt(page, id)).not.toBeNull();
  // The working one was stopped (Pause's stop): no turn runs.
  await expect.poll(() => status(page, a.working), { timeout: 15_000 }).not.toBe('run');
  const layout = await api<SidebarLayout>(page, 'GET', '/api/sidebar');
  expect(layout.folders.some((f) => f.name.startsWith('Acme'))).toBe(false);

  // Undo: restored, the folder and its subfolder back with the agents in place.
  await toast.getByTestId('v2-toast-undo').click();
  await expect(folder).toBeVisible();
  for (const id of [a.working, a.idle, a.deep]) await expect.poll(() => closedAt(page, id)).toBeNull();
  const back = await api<SidebarLayout>(page, 'GET', '/api/sidebar');
  const acme = back.folders.find((f) => f.name === 'Acme');
  expect(acme?.sessionIds).toEqual([a.working, a.idle]);
  expect(back.folders.find((f) => f.parentId === acme?.id)?.sessionIds).toEqual([a.deep]);

  // Again without Undo: Archived lists them.
  await folder.getByTestId('v2-tree-folder-menu').click();
  await page.getByTestId('v2-folder-menu').getByRole('menuitem', { name: 'Delete folder…' }).click();
  await dialog.getByTestId('v2-folder-go').click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: '3 archived' }).first()).toBeVisible();
  await page.goto(`${world.baseUrl}/agents?show=closed`);
  for (const id of [a.working, a.idle, a.deep]) await expect(page.locator(`[data-testid="v2-closed-row"][data-session="${id}"]`)).toBeVisible();
  await page.context().close();
});

test('classic desktop: the sidebar folder ⋯ → Delete folder… asks with the box ticked; Delete archives the sessions; the toast', async ({ browser }) => {
  const page = await openPage(browser, false, false);
  await page.goto(`${world.baseUrl}/`);
  const a = await agents(page, 'classic');
  const folderId = await folderWith(page, 'Classic', [a.working, a.idle], [a.deep]);
  await page.reload();
  const head = page.locator(`[data-testid="sidebar-folder"][data-folder-id="${folderId}"]`);
  await head.hover();
  await head.getByTestId('sidebar-folder-menu').click();
  await page.getByTestId('sidebar-menu-delete').click();
  const confirm = page.getByTestId('folder-delete-confirm');
  await expect(confirm.getByTestId('folder-delete-title')).toHaveText('Delete “Classic” and archive its 3 sessions?');
  await expect(confirm.getByTestId('folder-delete-archive')).toBeChecked();
  await expect(confirm).toContainText('Also archive the sessions in it');
  await expect(confirm.getByTestId('folder-delete-working')).toHaveText('1 is working and will be stopped.');
  await expect(confirm.getByTestId('folder-delete-names').locator('li')).toHaveText(['classic-working', 'classic-idle', 'classic-deep']);
  await confirm.getByTestId('folder-delete-go').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Deleted “Classic”. 3 archived.' })).toBeVisible();
  await expect(head).toHaveCount(0);
  for (const id of [a.working, a.idle, a.deep]) await expect.poll(() => closedAt(page, id)).not.toBeNull();
  await page.context().close();
});

test('phone (390 × 844): the classic drawer\'s confirmation fits the screen; v2 Archived shows the archived agents', async ({ browser }) => {
  const page = await openPage(browser, true, false);
  await page.goto(`${world.baseUrl}/`);
  const idle = (await world.startSession(page, 'phone-idle', 'Reply with just OK.')).id;
  await expect.poll(() => status(page, idle), { timeout: 15_000 }).toBe('done');
  const folderId = await folderWith(page, 'Phone', [idle], []);
  await page.reload();
  await page.getByTestId('drawer-open').tap();
  const head = page.locator(`[data-testid="sidebar-folder"][data-folder-id="${folderId}"]`);
  await head.getByTestId('sidebar-folder-menu').tap();
  await page.getByTestId('sidebar-menu-delete').tap();
  const confirm = page.getByTestId('folder-delete-confirm');
  await expect(confirm.getByTestId('folder-delete-title')).toHaveText('Delete “Phone” and archive its session?');
  await expect(confirm.getByTestId('folder-delete-working')).toHaveCount(0);
  const box = await confirm.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844).toBe(true);
  await confirm.getByTestId('folder-delete-go').tap();
  await expect.poll(() => closedAt(page, idle)).not.toBeNull();
  await page.context().close();

  const v2 = await openPage(browser, true, true);
  await v2.goto(`${world.baseUrl}/agents?show=closed`);
  await expect(v2.locator(`[data-testid="v2-closed-row"][data-session="${idle}"]`)).toBeVisible();
  await v2.context().close();
});
