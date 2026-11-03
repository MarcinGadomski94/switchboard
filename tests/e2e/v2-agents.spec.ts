import { type Locator, type Page, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { THEME_STORAGE_KEY } from '../../src/web/theme.ts';
import { stubToolProbes } from './probes.ts';
import { type DemoApp, startDemoApp } from './visual/harness.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · lane A · the v2 Agents page on the demo seed: the List / Chats / Board
 * choice is remembered; dragging an agent onto a folder of the tree uses the
 * shared sidebar layout, so the classic sidebar shows the same; M on a focused
 * row opens Move to folder; folders are created, renamed and deleted with Undo;
 * a project's "Plan · …" subfolder takes only its steps; the Board's quick
 * answer; Closed + Reopen; the phone's drill-down. 2.4.16: folders move into
 * other folders (drag, ⋯ › Move to…, the phone's folder page) and back to the
 * top level; the refused places stay refused.
 */

let demo: DemoApp;

test.beforeAll(async () => {
  demo = await startDemoApp({ ...V2_SERVER_ENV });
});

test.afterAll(async () => {
  await demo?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
  await page.goto(`${demo.baseUrl}/agents`);
  await resetLayout(page);
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith('switchboard.v2.agents')) localStorage.removeItem(key);
  });
  await page.reload();
  await expect(page.getByTestId('v2-page-agents')).toBeVisible();
});

async function resetLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const layout = (await (await fetch('/api/sidebar')).json()) as SidebarLayout;
    const json = { 'content-type': 'application/json' };
    for (const id of layout.pinned) await fetch('/api/sidebar/place', { method: 'POST', headers: json, body: JSON.stringify({ sessionId: id, place: 'loose' }) });
    // Deepest first (the folders come in tree order): deleting a folder moves its subfolders up, so a top-level-only pass would leave them behind.
    for (const folder of [...layout.folders].reverse()) await fetch(`/api/sidebar/folders/${encodeURIComponent(folder.id)}`, { method: 'DELETE' });
  });
}

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, u, b]) => {
      const answer = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      return answer.status === 204 ? null : answer.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;
}

async function sessions(page: Page): Promise<Session[]> {
  return api<Session[]>(page, 'GET', '/api/sessions');
}

function folderRow(page: Page, name: string): Locator {
  return page.getByTestId('v2-tree-folder').filter({ has: page.getByTestId('v2-tree-folder-name').getByText(name, { exact: true }) });
}

/** Makes folder `name` (in `parentId`) through the API and answers its id. */
async function apiFolder(page: Page, name: string, parentId: string | null = null): Promise<string> {
  const layout = await api<SidebarLayout>(page, 'POST', '/api/sidebar/folders', parentId ? { name, parentId } : { name });
  const made = layout.folders.find((f) => f.name === name && (f.parentId ?? null) === parentId);
  if (!made) throw new Error(`no folder ${name}`);
  return made.id;
}

async function parentOf(page: Page, id: string): Promise<string | null | undefined> {
  const layout = await api<SidebarLayout>(page, 'GET', '/api/sidebar');
  const folder = layout.folders.find((f) => f.id === id);
  return folder ? (folder.parentId ?? null) : undefined;
}

/** Drags `from` over `to` with the mouse (Playwright drives Chromium's native drag) and answers whether `to` showed the drop highlight; `drop` false cancels with Escape. */
async function dragOver(page: Page, from: Locator, to: Locator, drop = true): Promise<boolean> {
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

async function newFolder(page: Page, name: string): Promise<void> {
  await page.getByTestId('v2-tree-new-folder').click();
  const dialog = page.getByTestId('v2-folder-dialog');
  await dialog.getByTestId('v2-folder-name').fill(name);
  await dialog.getByTestId('v2-folder-go').click();
  await expect(folderRow(page, name)).toBeVisible();
}

test('List / Chats / Board: the choice is remembered', async ({ page }) => {
  const view = page.getByTestId('v2-agents-view');
  await expect(view.locator('[data-value="list"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('v2-agents-list')).toBeVisible();
  await view.locator('[data-value="chats"]').click();
  await expect(page.getByTestId('v2-agents-chats')).toBeVisible();
  await view.locator('[data-value="board"]').click();
  await expect(page.getByTestId('v2-agents-board')).toBeVisible();
  // Group by: remembered too.
  await page.getByTestId('v2-groupby').locator('[data-value="folder"]').click();
  await page.reload();
  await expect(page.getByTestId('v2-agents-board')).toBeVisible();
  await expect(page.getByTestId('v2-groupby').locator('[data-value="folder"]')).toHaveAttribute('aria-pressed', 'true');
  // The folder tree hides with ⌘\ and stays hidden.
  await expect(page.getByTestId('v2-ftree')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(page.getByTestId('v2-ftree')).toBeHidden();
  await page.reload();
  await expect(page.getByTestId('v2-ftree')).toBeHidden();
  await page.getByTestId('v2-tree-toggle-button').click();
  await expect(page.getByTestId('v2-ftree')).toBeVisible();
});

test('drag an agent onto a folder; the classic sidebar shows the same', async ({ page }) => {
  const [first] = await sessions(page);
  if (!first) throw new Error('no demo session');
  await newFolder(page, 'Payments');
  await page.getByTestId('v2-tree-all').click();
  const row = page.getByTestId('v2-agents-list').locator(`[data-session="${first.id}"]`);
  await row.dragTo(folderRow(page, 'Payments'));
  await expect(page.getByTestId('v2-toast').filter({ hasText: `Moved “${first.name}” to Payments.` })).toBeVisible();
  await expect(folderRow(page, 'Payments').getByTestId('v2-tree-count')).toHaveText('1');
  const layout = await api<SidebarLayout>(page, 'GET', '/api/sidebar');
  expect(layout.folders.find((f) => f.name === 'Payments')?.sessionIds).toEqual([first.id]);

  // Switch this browser to the classic theme: its sidebar reads the same layout.
  await page.evaluate((key) => localStorage.setItem(key, 'classic'), THEME_STORAGE_KEY);
  await page.reload();
  const classic = page.getByTestId('sidebar-folder').filter({ hasText: 'Payments' });
  await expect(classic.getByTestId('sidebar-folder-count')).toHaveText('1');
  await page.evaluate((key) => localStorage.setItem(key, 'v2'), THEME_STORAGE_KEY);
});

test('M on a focused row opens Move to folder; Undo puts it back', async ({ page }) => {
  const [first] = await sessions(page);
  if (!first) throw new Error('no demo session');
  await newFolder(page, 'Docs');
  await page.getByTestId('v2-tree-all').click();
  const row = page.getByTestId('v2-agents-list').locator(`[data-session="${first.id}"]`);
  await row.locator('button').first().focus();
  await page.keyboard.press('m');
  const dialog = page.getByTestId('v2-move-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input:checked')).toHaveValue('loose');
  await page.keyboard.press('ArrowDown');
  await expect(dialog.locator('input:checked')).not.toHaveValue('loose');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(folderRow(page, 'Docs').getByTestId('v2-tree-count')).toHaveText('1');
  await page.getByTestId('v2-toast').filter({ hasText: `Moved “${first.name}” to Docs.` }).getByTestId('v2-toast-undo').click();
  await expect(folderRow(page, 'Docs').getByTestId('v2-tree-count')).toHaveText('0');
});

test('create, rename and delete a folder, each with Undo', async ({ page }) => {
  await newFolder(page, 'Alpha');
  await expect(page.getByTestId('v2-crumbs')).toContainText('Alpha');
  // A subfolder from the folder's ⋯ menu.
  await folderRow(page, 'Alpha').getByTestId('v2-tree-folder-menu').click();
  await page.getByTestId('v2-folder-menu').getByRole('menuitem', { name: 'New subfolder' }).click();
  await page.getByTestId('v2-folder-dialog').getByTestId('v2-folder-name').fill('Beta');
  await page.getByTestId('v2-folder-dialog').getByTestId('v2-folder-go').click();
  await expect(folderRow(page, 'Beta')).toHaveAttribute('aria-level', '2');

  // Rename, then Undo.
  await folderRow(page, 'Alpha').getByTestId('v2-tree-folder-menu').click();
  await page.getByTestId('v2-folder-menu').getByRole('menuitem', { name: 'Rename…' }).click();
  await page.getByTestId('v2-folder-dialog').getByTestId('v2-folder-name').fill('Gamma');
  await page.keyboard.press('Enter');
  await expect(folderRow(page, 'Gamma')).toBeVisible();
  await page.getByTestId('v2-toast').filter({ hasText: 'Renamed to “Gamma”.' }).getByTestId('v2-toast-undo').click();
  await expect(folderRow(page, 'Alpha')).toBeVisible();

  // Delete (its subfolder moves up), then Undo brings both back as they were.
  await folderRow(page, 'Alpha').getByTestId('v2-tree-folder-menu').click();
  await page.getByTestId('v2-folder-menu').getByRole('menuitem', { name: 'Delete folder…' }).click();
  await expect(page.getByTestId('v2-folder-delete-text')).toContainText('No agents are deleted.');
  await page.getByTestId('v2-folder-dialog').getByTestId('v2-folder-go').click();
  await expect(folderRow(page, 'Alpha')).toHaveCount(0);
  await expect(folderRow(page, 'Beta')).toHaveAttribute('aria-level', '1');
  await page.getByTestId('v2-toast').filter({ hasText: 'Deleted “Alpha”.' }).getByTestId('v2-toast-undo').click();
  await expect(folderRow(page, 'Alpha')).toBeVisible();
  await expect(folderRow(page, 'Beta')).toHaveAttribute('aria-level', '2');
});

test('2.4.16: folders drag into other folders and back to the top level, kept after a reload; never into their own subfolders', async ({ page }) => {
  const [first] = await sessions(page);
  if (!first) throw new Error('no demo session');
  const alpha = await apiFolder(page, 'Alpha');
  const beta = await apiFolder(page, 'Beta');
  await api(page, 'POST', '/api/sidebar/place', { sessionId: first.id, place: 'folder', folderId: beta });
  const gamma = await apiFolder(page, 'Gamma', beta);
  await page.reload();
  await expect(folderRow(page, 'Beta')).toHaveAttribute('aria-level', '1');

  // Beta (with its agent and Gamma) onto Alpha: highlighted on the way, then Alpha's subfolder.
  expect(await dragOver(page, folderRow(page, 'Beta'), folderRow(page, 'Alpha'))).toBe(true);
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Moved folder “Beta” to Alpha.' })).toBeVisible();
  await expect(folderRow(page, 'Beta')).toHaveAttribute('aria-level', '2');
  await expect(folderRow(page, 'Gamma')).toHaveAttribute('aria-level', '3');
  expect(await parentOf(page, beta)).toBe(alpha);
  const moved = await api<SidebarLayout>(page, 'GET', '/api/sidebar');
  expect(moved.folders.find((f) => f.id === beta)?.sessionIds).toEqual([first.id]);
  expect(moved.folders.find((f) => f.id === gamma)?.parentId).toBe(beta);
  await page.reload();
  await expect(folderRow(page, 'Beta')).toHaveAttribute('aria-level', '2');
  await expect(folderRow(page, 'Alpha').getByTestId('v2-tree-count')).toHaveText('1');

  // Alpha onto its own sub-subfolder Gamma: no highlight, the reason on the drop, nothing moves.
  expect(await dragOver(page, folderRow(page, 'Alpha'), folderRow(page, 'Gamma'))).toBe(false);
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'A folder can’t go inside one of its own subfolders.' })).toBeVisible();
  expect(await parentOf(page, alpha)).toBeNull();
  // Onto itself: refused too.
  expect(await dragOver(page, folderRow(page, 'Alpha'), folderRow(page, 'Alpha'))).toBe(false);
  expect(await parentOf(page, alpha)).toBeNull();

  // Beta onto the Folders heading: back to the top level (at the end).
  expect(await dragOver(page, folderRow(page, 'Beta'), page.getByTestId('v2-tree-folders'))).toBe(true);
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Moved folder “Beta” to the top level.' })).toBeVisible();
  await expect(folderRow(page, 'Beta')).toHaveAttribute('aria-level', '1');
  expect(await parentOf(page, beta)).toBeNull();
  // A top-level folder on Not in a folder is already there: no highlight.
  expect(await dragOver(page, folderRow(page, 'Alpha'), page.getByTestId('v2-tree-loose'))).toBe(false);

  // An agent still drags onto a folder as before, and moves no folder.
  await page.getByTestId('v2-tree-all').click();
  const row = page.getByTestId('v2-agents-list').locator(`[data-session="${first.id}"]`);
  await row.dragTo(folderRow(page, 'Alpha'));
  await expect(page.getByTestId('v2-toast').filter({ hasText: `Moved “${first.name}” to Alpha.` })).toBeVisible();
  const after = await api<SidebarLayout>(page, 'GET', '/api/sidebar');
  expect(after.folders.find((f) => f.id === alpha)?.sessionIds).toEqual([first.id]);
  expect(after.folders.map((f) => [f.name, f.parentId ?? null])).toEqual([
    ['Alpha', null],
    ['Beta', null],
    ['Gamma', beta],
  ]);
});

test('2.4.16: a folder\'s ⋯ › Move to… picks the place from the tree (invalid ones disabled with the reason), with Undo', async ({ page }) => {
  const alpha = await apiFolder(page, 'Alpha');
  const beta = await apiFolder(page, 'Beta');
  await apiFolder(page, 'Inner', beta);
  await page.reload();
  await folderRow(page, 'Beta').getByTestId('v2-tree-folder-menu').click();
  await page.getByTestId('v2-folder-menu').getByRole('menuitem', { name: 'Move to…' }).click();
  const dialog = page.getByTestId('v2-folder-move-dialog');
  await expect(dialog).toBeVisible();
  const option = (value: string): Locator => dialog.locator(`[data-testid="v2-folder-move-option"][data-value="${value}"]`);
  // Top level is where it is now; itself and its own subfolder are disabled with the reason.
  await expect(option('loose').locator('input')).toBeChecked();
  await expect(option(beta).locator('input')).toBeDisabled();
  await expect(option(beta)).toContainText('A folder can’t go inside itself.');
  await expect(dialog.getByTestId('v2-folder-move-option').filter({ hasText: 'Inner' }).locator('input')).toBeDisabled();
  await option(alpha).locator('input').check();
  await dialog.getByTestId('v2-folder-move-go').click();
  await expect(dialog).toBeHidden();
  await expect(folderRow(page, 'Beta')).toHaveAttribute('aria-level', '2');
  expect(await parentOf(page, beta)).toBe(alpha);
  await page.getByTestId('v2-toast').filter({ hasText: 'Moved folder “Beta” to Alpha.' }).getByTestId('v2-toast-undo').click();
  await expect(folderRow(page, 'Beta')).toHaveAttribute('aria-level', '1');
  await expect.poll(() => parentOf(page, beta)).toBeNull();

  // The keyboard way: M on the folder row opens the same dialog; Enter moves.
  await folderRow(page, 'Beta').getByTestId('v2-tree-folder-main').focus();
  await page.keyboard.press('m');
  await expect(dialog).toBeVisible();
  await option(alpha).locator('input').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect.poll(() => parentOf(page, beta)).toBe(alpha);
});

test('a project subfolder ("Plan · …") takes only its own steps', async ({ page }) => {
  const [first] = await sessions(page);
  if (!first) throw new Error('no demo session');
  await api(page, 'POST', '/api/sidebar/folders', { name: 'Plan · PROJ-200 Saved cards' });
  const plan = folderRow(page, 'Plan · PROJ-200 Saved cards');
  await expect(plan).toBeVisible();
  await expect(plan.locator('.v2-plan-ic')).toHaveCount(1);
  await page.getByTestId('v2-tree-all').click();
  await page.getByTestId('v2-agents-list').locator(`[data-session="${first.id}"]`).dragTo(plan);
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Only the project’s own steps live in' })).toBeVisible();
  await expect(plan.getByTestId('v2-tree-count')).toHaveText('0');
  // Move to folder offers it disabled.
  const row = page.getByTestId('v2-agents-list').locator(`[data-session="${first.id}"]`);
  await row.getByTestId('v2-row-menu').click();
  await page.getByTestId('v2-agent-menu').getByRole('menuitem', { name: /Move to folder/ }).click();
  const option = page.getByTestId('v2-move-option').filter({ hasText: 'Plan · PROJ-200 Saved cards' });
  await expect(option.locator('input')).toBeDisabled();
  await expect(option).toContainText('project steps only');
});

test('the Board quick answer answers from the card', async ({ page }) => {
  await page.getByTestId('v2-agents-view').locator('[data-value="board"]').click();
  const needs = page.getByTestId('v2-bd-col-needs');
  await expect(needs).toBeVisible();
  const answer = page.getByTestId('v2-bcard-answer').first();
  await expect(answer).toBeVisible();
  await answer.click();
  const pop = page.getByTestId('v2-qpop');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('Quick answer');
  const card = pop.getByTestId('v2-answer-card');
  await expect(card).toBeVisible();
  const before = await page.getByTestId('v2-bcard-answer').count();
  const send = card.getByTestId('v2-answer-send');
  if (await send.count()) {
    // A batch: pick the first option of every question, then send.
    for (const block of await card.locator('p.v2-qi-title + *').all()) await block.locator('.v2-opt').first().click();
    await send.click();
  } else await card.locator('.v2-opt').first().click();
  await expect(pop).toBeHidden();
  await expect(page.getByTestId('v2-toast').first()).toBeVisible();
  await expect(page.getByTestId('v2-bcard-answer')).toHaveCount(before - 1);
});

test('a Board card peeks (lane X: the shared board and the peek sheet); Enter too; the tablet board fits next to the tree', async ({ page }) => {
  await page.getByTestId('v2-agents-view').locator('[data-value="board"]').click();
  const card = page.getByTestId('v2-bcard').first();
  await expect(card).toBeVisible();
  const id = await card.getAttribute('data-session');
  await card.locator('.v2-t').click();
  const peek = page.getByTestId('v2-agent-peek');
  await expect(peek).toBeVisible();
  await expect(page).toHaveURL(/\/agents$/);
  await page.keyboard.press('Escape');
  await expect(peek).toBeHidden();
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(peek).toBeVisible();
  await peek.getByTestId('v2-agent-peek-full').click();
  await expect(page).toHaveURL(new RegExp(`/agents/${encodeURIComponent(id ?? '')}$`));
  // Tablet with the folder tree open: four readable columns; the board scrolls, the page does not.
  await page.goto(`${demo.baseUrl}/agents`);
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(page.getByTestId('v2-ftree')).toBeVisible();
  await expect(page.getByTestId('v2-agents-board')).toBeVisible();
  // At 1024 the board fits next to the tree: every column head is on screen, nothing scrolls sideways.
  const done = await page.getByTestId('v2-bd-col-done').boundingBox();
  expect((done?.x ?? 0) + (done?.width ?? 0)).toBeLessThanOrEqual(1024);
  const fits = (): Promise<boolean> => page.getByTestId('v2-agents-board').evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(await fits()).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  // At 768 with the tree open the heads and lanes scroll sideways together inside the board (one scroller), never the page.
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(page.getByTestId('v2-ftree')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const widths = await page.getByTestId('v2-agents-board').evaluate((el) => [el.querySelector('.v2-bd-cols')?.scrollWidth ?? 0, el.querySelector('.v2-lane')?.getBoundingClientRect().width ?? 0]);
  expect(widths[1] ?? 0).toBeGreaterThanOrEqual((widths[0] ?? 0) - 1);
});

test('Archived (D137; was Closed): search and Restore', async ({ page }) => {
  const list = await sessions(page);
  const target = list.find((s) => s.status !== 'run') ?? list[0];
  if (!target) throw new Error('no demo session');
  await api(page, 'POST', `/api/sessions/${encodeURIComponent(target.id)}/close`, { confirm: true });
  await page.getByTestId('v2-tree-closed').click();
  await expect(page.getByTestId('v2-page-agents-closed')).toBeVisible();
  await expect(page).toHaveURL(/\/agents\?show=closed$/);
  await page.getByTestId('v2-closed-search').fill(target.name);
  const row = page.getByTestId('v2-closed-row').filter({ hasText: target.name });
  await expect(row).toHaveCount(1);
  await page.getByTestId('v2-closed-search').fill('no such agent anywhere');
  await expect(page.getByTestId('v2-closed-empty')).toBeVisible();
  await page.getByTestId('v2-closed-search').fill(target.name);
  await row.getByTestId('v2-closed-reopen').click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: `Restored “${target.name}”.` })).toBeVisible();
  await expect(row).toHaveCount(0);
  const after = await sessions(page);
  expect(after.some((s) => s.id === target.id)).toBe(true);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('drill down through the folders with a breadcrumb', async ({ page }) => {
    const [first] = await sessions(page);
    if (!first) throw new Error('no demo session');
    const outer = await api<SidebarLayout>(page, 'POST', '/api/sidebar/folders', { name: 'Checkout' });
    const checkout = outer.folders.find((f) => f.name === 'Checkout');
    if (!checkout) throw new Error('no folder');
    const inner = await api<SidebarLayout>(page, 'POST', '/api/sidebar/folders', { name: 'Payments', parentId: checkout.id });
    const payments = inner.folders.find((f) => f.name === 'Payments');
    if (!payments) throw new Error('no subfolder');
    await api(page, 'POST', '/api/sidebar/place', { sessionId: first.id, place: 'folder', folderId: payments.id });
    await page.reload();
    await expect(page.getByTestId('v2-agents-phone')).toBeVisible();
    await expect(page.getByTestId('v2-ftree')).toHaveCount(0);
    await page.getByTestId('v2-phone-view').locator('[data-value="folders"]').click();
    await page.getByTestId('v2-phone-folder').filter({ hasText: 'Checkout' }).click();
    await expect(page.getByTestId('v2-phone-crumb')).toContainText('Checkout');
    await page.getByTestId('v2-phone-folder').filter({ hasText: 'Payments' }).click();
    const crumb = page.getByTestId('v2-phone-crumb');
    await expect(crumb).toContainText('Payments');
    await expect(page.getByTestId('v2-agent-row').filter({ hasText: first.name })).toBeVisible();
    // Browse only: no drag, no tree menus.
    await expect(page.getByTestId('v2-tree-folder-menu')).toHaveCount(0);
    // Every tap target is at least 44 px high.
    for (const target of await page.getByTestId('v2-phone-crumb').locator('button').all()) expect((await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await crumb.getByRole('button', { name: 'Checkout' }).click();
    await expect(page.getByTestId('v2-phone-folder').filter({ hasText: 'Payments' })).toBeVisible();
    // The choice of view is remembered.
    await page.reload();
    await expect(page.getByTestId('v2-phone-folders')).toBeVisible();
  });

  test('2.4.16: a folder\'s page has Move to…', async ({ page }) => {
    const checkout = await apiFolder(page, 'Checkout');
    const payments = await apiFolder(page, 'Payments');
    await page.reload();
    await page.getByTestId('v2-phone-view').locator('[data-value="folders"]').click();
    await page.getByTestId('v2-phone-folder').filter({ hasText: 'Payments' }).click();
    const move = page.getByTestId('v2-phone-folder-move');
    expect((await move.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await move.click();
    const dialog = page.getByTestId('v2-folder-move-dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator(`[data-testid="v2-folder-move-option"][data-value="${checkout}"]`).click();
    await dialog.getByTestId('v2-folder-move-go').click();
    await expect(dialog).toBeHidden();
    // The page follows the folder to its new place.
    await expect(page.getByTestId('v2-phone-crumb')).toContainText('Checkout');
    await expect(page.getByTestId('v2-phone-crumb')).toContainText('Payments');
    await expect.poll(() => parentOf(page, payments)).toBe(checkout);
    await page.getByTestId('v2-phone-crumb').getByRole('button', { name: 'Agents' }).click();
    await expect(page.getByTestId('v2-phone-folder')).toHaveCount(1);
  });
});
