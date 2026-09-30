import { type Locator, type Page, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import { SIDEBAR_FOLDER_DEPTH_MAX, type SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { stubToolProbes } from './probes.ts';
import { type DemoApp, openApp, startDemoApp } from './visual/harness.ts';

/**
 * D58 oracle (E2E): subfolders in the sidebar's SESSIONS, on the demo seed (no
 * CLI runs). "New subfolder" from a folder's ⋯ menu; drag a session into a
 * subfolder; drag a folder onto the middle of another folder's head (it becomes
 * its subfolder) and out to the top level; a collapsed parent hides everything
 * inside and counts it (with the amber dot for a session inside that waits);
 * the tree survives a reload and shows live in a second tab; "Move to folder ▸"
 * never offers a folder's own subfolders; deleting a folder with subfolders asks
 * first and moves them up; deep nesting stays inside the sidebar (no horizontal
 * scroll, long names end with an ellipsis).
 */

let demo: DemoApp;

test.beforeAll(async () => {
  demo = await startDemoApp();
});

test.afterAll(async () => {
  await demo?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
  await openApp(page, demo.baseUrl, '/inbox');
  await resetLayout(page);
});

/** Unpins everything and deletes every folder (through the API). */
async function resetLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const layout = (await (await fetch('/api/sidebar')).json()) as SidebarLayout;
    const json = { 'content-type': 'application/json' };
    for (const id of layout.pinned) await fetch('/api/sidebar/place', { method: 'POST', headers: json, body: JSON.stringify({ sessionId: id, place: 'loose' }) });
    for (const folder of layout.folders) await fetch(`/api/sidebar/folders/${encodeURIComponent(folder.id)}`, { method: 'DELETE' });
  });
}

async function sessions(page: Page): Promise<Session[]> {
  return page.evaluate(async () => (await (await fetch('/api/sessions')).json()) as Session[]);
}

async function layoutOf(page: Page): Promise<SidebarLayout> {
  return page.evaluate(async () => (await (await fetch('/api/sidebar')).json()) as SidebarLayout);
}

/** `parent/name` per folder, in the tree order the API answers. */
async function treeOf(page: Page): Promise<string[]> {
  const layout = await layoutOf(page);
  return layout.folders.map((f) => `${f.parentId === null ? '-' : (layout.folders.find((p) => p.id === f.parentId)?.name ?? '?')}/${f.name}`);
}

function list(page: Page): Locator {
  return page.getByTestId('sidebar-sessions');
}

function row(page: Page, id: string): Locator {
  return list(page).locator(`a.sb-session[data-session-id="${id}"]`);
}

function folderHead(page: Page, name: string): Locator {
  return page.getByTestId('sidebar-folder').filter({ has: page.getByTestId('sidebar-folder-name').getByText(name, { exact: true }) });
}

/** A native drag: press on `source`, move a little (the drag starts), then release over `target` at `y` (a fraction of its height). */
async function dragOnto(page: Page, source: Locator, target: () => Locator, y = 0.5): Promise<void> {
  const from = await source.boundingBox();
  if (!from) throw new Error('no source box');
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 34, from.y + from.height / 2 + 6, { steps: 3 });
  const to = await target().boundingBox();
  if (!to) throw new Error('no target box');
  await page.mouse.move(to.x + 40, to.y + to.height * y, { steps: 6 });
  await page.mouse.up();
}

async function openFolderMenu(page: Page, name: string): Promise<Locator> {
  await folderHead(page, name).hover();
  await folderHead(page, name).getByTestId('sidebar-folder-menu').click();
  const menu = page.getByTestId('sidebar-menu');
  await expect(menu).toBeVisible();
  return menu;
}

async function newTopFolder(page: Page, name: string): Promise<void> {
  await page.getByTestId('sidebar-new-folder').click();
  await page.getByTestId('sidebar-new-folder-name').fill(name);
  await page.getByTestId('sidebar-new-folder-name').press('Enter');
  await expect(folderHead(page, name)).toHaveCount(1);
}

async function newSubfolder(page: Page, parent: string, name: string): Promise<void> {
  await (await openFolderMenu(page, parent)).getByTestId('sidebar-menu-new-subfolder').click();
  const field = page.getByTestId('sidebar-new-folder-name');
  await expect(field).toBeFocused();
  await field.fill(name);
  await field.press('Enter');
  await expect(folderHead(page, name)).toHaveCount(1);
}

test('subfolders: create, drag a session and a folder in, out to the top level, collapse hides and counts; reload and a second tab', async ({ page, context }) => {
  const all = await sessions(page);
  const waiting = all.find((s) => s.status === 'need') ?? all[0];
  const other1 = all.find((s) => s.id !== waiting?.id) as Session;
  const [w, o] = [waiting?.id as string, other1.id];

  // A second tab follows everything live.
  const other = await context.newPage();
  await stubToolProbes(other);
  await openApp(other, demo.baseUrl, '/inbox');

  await newTopFolder(page, 'Work');
  await newSubfolder(page, 'Work', 'Reviews');
  expect(await treeOf(page)).toEqual(['-/Work', 'Work/Reviews']);
  const work = folderHead(page, 'Work');
  const reviews = folderHead(page, 'Reviews');
  await expect(reviews).toHaveAttribute('data-level', '1');
  // Indented one step under its parent.
  const [workBox, reviewsBox] = [await work.boundingBox(), await reviews.boundingBox()];
  expect((reviewsBox?.x ?? 0) - (workBox?.x ?? 0)).toBeGreaterThanOrEqual(8);

  // Drag a session onto the subfolder's head: into it; its parent counts it too.
  await dragOnto(page, row(page, w), () => folderHead(page, 'Reviews'));
  await expect.poll(async () => (await layoutOf(page)).folders.find((f) => f.name === 'Reviews')?.sessionIds).toEqual([w]);
  await expect(reviews.getByTestId('sidebar-folder-count')).toHaveText('1');
  await expect(work.getByTestId('sidebar-folder-count')).toHaveText('1');
  const sessionBox = await row(page, w).boundingBox();
  expect((sessionBox?.x ?? 0) - (reviewsBox?.x ?? 0)).toBeGreaterThanOrEqual(8);
  // A session straight in Work.
  await dragOnto(page, row(page, o), () => folderHead(page, 'Work'));
  await expect(work.getByTestId('sidebar-folder-count')).toHaveText('2');

  // A folder dropped on the middle of another folder's head becomes its subfolder.
  await newTopFolder(page, 'Later');
  await dragOnto(page, folderHead(page, 'Later'), () => folderHead(page, 'Work'), 0.5);
  await expect.poll(() => treeOf(page)).toEqual(['-/Work', 'Work/Reviews', 'Work/Later']);
  await expect(folderHead(page, 'Later')).toHaveAttribute('data-parent-id', /.+/);
  // …and back out to the top level through the zone shown while a subfolder is dragged.
  await dragOnto(page, folderHead(page, 'Later'), () => page.getByTestId('sidebar-loose-zone'));
  await expect.poll(() => treeOf(page)).toEqual(['-/Work', 'Work/Reviews', '-/Later']);
  await expect(page.getByTestId('sidebar-loose-zone')).toHaveCount(0);
  // Onto a subfolder's upper quarter: beside it, at that level.
  await dragOnto(page, folderHead(page, 'Later'), () => folderHead(page, 'Reviews'), 0.1);
  await expect.poll(() => treeOf(page)).toEqual(['-/Work', 'Work/Later', 'Work/Reviews']);
  await expect(folderHead(other, 'Later')).toHaveAttribute('data-level', '1');

  // Collapse the parent: its subfolders and every session inside go; the count is everything inside.
  await work.getByTestId('sidebar-folder-toggle').click();
  await expect(work).toHaveAttribute('data-collapsed', 'true');
  await expect(folderHead(page, 'Reviews')).toHaveCount(0);
  await expect(row(page, w)).toHaveCount(0);
  await expect(row(page, o)).toHaveCount(0);
  await expect(work.getByTestId('sidebar-folder-count')).toHaveText('2');
  // The demo seed has a session waiting for the developer: the amber dot shows through two levels.
  expect(waiting?.status).toBe('need');
  await expect(work.getByTestId('sidebar-folder-need')).toHaveCount(1);
  await expect(folderHead(other, 'Reviews')).toHaveCount(0);

  // Reload: the tree and the collapsed state are where they were.
  await page.reload();
  await page.getByTestId('shell').waitFor();
  await expect(folderHead(page, 'Work')).toHaveAttribute('data-collapsed', 'true');
  await expect(folderHead(page, 'Work').getByTestId('sidebar-folder-count')).toHaveText('2');
  await folderHead(page, 'Work').click();
  await expect(folderHead(page, 'Reviews')).toBeVisible();
  await expect(row(page, w)).toHaveAttribute('data-group', 'folder');
  // Subfolders first, then the folder's own sessions.
  const order = await list(page)
    .locator(':scope > *')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-folder-id') ? `folder:${el.textContent?.replace(/\d+$/, '')}` : `session:${el.getAttribute('data-session-id')}`));
  expect(order.slice(0, 5)).toEqual(['folder:Work', 'folder:Later', 'folder:Reviews', `session:${w}`, `session:${o}`]);
  await expect(folderHead(other, 'Reviews')).toBeVisible();
  await other.close();
});

test('menus: Move to folder ▸ is the tree without the folder and its subfolders; Move up / down within its level; delete with subfolders asks and moves them up', async ({ page }) => {
  const [s] = (await sessions(page)).map((x) => x.id) as [string];
  await newTopFolder(page, 'Work');
  await newSubfolder(page, 'Work', 'Reviews');
  await newSubfolder(page, 'Reviews', 'Deep');
  await newTopFolder(page, 'Later');
  const layout = await layoutOf(page);
  const id = (name: string) => layout.folders.find((f) => f.name === name)?.id as string;

  // Work's targets: not Work, Reviews, Deep; Later is offered.
  let menu = await openFolderMenu(page, 'Work');
  await menu.getByTestId('sidebar-menu-move-to-folder').click();
  await expect(menu.getByTestId(`sidebar-menu-folder-${id('Later')}`)).toBeVisible();
  for (const name of ['Work', 'Reviews', 'Deep']) await expect(menu.getByTestId(`sidebar-menu-folder-${id(name)}`)).toHaveCount(0);
  await expect(menu.getByTestId('sidebar-menu-top-level')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Deep → Later from the keyboard path; then Top level.
  menu = await openFolderMenu(page, 'Deep');
  await menu.getByTestId('sidebar-menu-move-to-folder').click();
  await expect(menu.getByTestId(`sidebar-menu-current-folder-${id('Reviews')}`)).toBeDisabled();
  await menu.getByTestId(`sidebar-menu-folder-${id('Later')}`).click();
  await expect.poll(() => treeOf(page)).toEqual(['-/Work', 'Work/Reviews', '-/Later', 'Later/Deep']);
  menu = await openFolderMenu(page, 'Deep');
  await menu.getByTestId('sidebar-menu-move-to-folder').click();
  await menu.getByTestId('sidebar-menu-top-level').click();
  await expect.poll(() => treeOf(page)).toEqual(['-/Work', 'Work/Reviews', '-/Later', '-/Deep']);
  // Move up within its level.
  menu = await openFolderMenu(page, 'Deep');
  await expect(menu.getByTestId('sidebar-menu-down')).toBeDisabled();
  await menu.getByTestId('sidebar-menu-up').click();
  await expect.poll(() => treeOf(page)).toEqual(['-/Work', 'Work/Reviews', '-/Deep', '-/Later']);

  // A session's "Move to folder ▸" lists the tree, indented.
  await row(page, s).hover();
  await row(page, s).getByTestId('sidebar-session-menu').click();
  await page.getByTestId('sidebar-menu-move-to-folder').click();
  const target = page.getByTestId(`sidebar-menu-folder-${id('Reviews')}`);
  const topTarget = page.getByTestId(`sidebar-menu-folder-${id('Work')}`);
  expect(parseFloat(await target.evaluate((el) => getComputedStyle(el).paddingLeft))).toBeGreaterThan(parseFloat(await topTarget.evaluate((el) => getComputedStyle(el).paddingLeft)));
  await target.click();
  await expect.poll(async () => (await layoutOf(page)).folders.find((f) => f.name === 'Reviews')?.sessionIds).toEqual([s]);

  // Delete Work (it has a subfolder): the menu asks; Cancel goes back; the confirm moves Reviews up, with its session.
  menu = await openFolderMenu(page, 'Work');
  await menu.getByTestId('sidebar-menu-delete').click();
  await expect(menu.getByTestId('sidebar-menu-delete-confirm')).toContainText('1 subfolder');
  await menu.getByTestId('sidebar-menu-delete-cancel').click();
  await expect(menu.getByTestId('sidebar-menu-rename')).toBeVisible();
  await menu.getByTestId('sidebar-menu-delete').click();
  await menu.getByTestId('sidebar-menu-delete-confirm').click();
  await expect.poll(() => treeOf(page)).toEqual(['-/Reviews', '-/Deep', '-/Later']);
  expect((await layoutOf(page)).folders.find((f) => f.name === 'Reviews')?.sessionIds).toEqual([s]);
  await expect(row(page, s)).toHaveAttribute('data-group', 'folder');
});

test(`deep nesting (${SIDEBAR_FOLDER_DEPTH_MAX} levels) stays inside the sidebar: no horizontal scroll, long names end in an ellipsis, no deeper subfolder`, async ({ page }) => {
  const [s] = (await sessions(page)).map((x) => x.id) as [string];
  const long = 'A rather long folder name that cannot fit the sidebar';
  await page.evaluate(
    async ({ long: name, depth, sessionId }) => {
      const json = { 'content-type': 'application/json' };
      let parentId: string | null = null;
      for (let i = 1; i <= depth; i++) {
        const layout = (await (await fetch('/api/sidebar/folders', { method: 'POST', headers: json, body: JSON.stringify({ name: `${i} ${name}`, parentId }) })).json()) as SidebarLayout;
        parentId = layout.folders.find((f) => f.name === `${i} ${name}`)?.id ?? null;
      }
      await fetch('/api/sidebar/place', { method: 'POST', headers: json, body: JSON.stringify({ sessionId, place: 'folder', folderId: parentId }) });
    },
    { long, depth: SIDEBAR_FOLDER_DEPTH_MAX, sessionId: s },
  );
  const deepest = folderHead(page, `${SIDEBAR_FOLDER_DEPTH_MAX} ${long}`);
  await expect(deepest).toHaveAttribute('data-level', String(SIDEBAR_FOLDER_DEPTH_MAX - 1));
  await expect(row(page, s)).toBeVisible();
  const sidebar = list(page);
  const overflow = await sidebar.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const name = deepest.getByTestId('sidebar-folder-name');
  expect(await name.evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
  expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // The deepest row and head end inside the list.
  const [listBox, rowBox, headBox] = [await sidebar.boundingBox(), await row(page, s).boundingBox(), await deepest.boundingBox()];
  expect((rowBox?.x ?? 0) + (rowBox?.width ?? 0)).toBeLessThanOrEqual((listBox?.x ?? 0) + (listBox?.width ?? 0) + 0.5);
  expect((headBox?.x ?? 0) + (headBox?.width ?? 0)).toBeLessThanOrEqual((listBox?.x ?? 0) + (listBox?.width ?? 0) + 0.5);
  // No sixth level.
  const menu = await openFolderMenu(page, `${SIDEBAR_FOLDER_DEPTH_MAX} ${long}`);
  await expect(menu.getByTestId('sidebar-menu-new-subfolder')).toBeDisabled();
});
