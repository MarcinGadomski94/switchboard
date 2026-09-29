import { type Locator, type Page, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { stubToolProbes } from './probes.ts';
import { type DemoApp, openApp, startDemoApp } from './visual/harness.ts';

/**
 * D54 oracle (E2E): pins, manual order and folders in the sidebar's SESSIONS, on
 * the demo seed's six sessions (no CLI runs). Pin from a row's ⋯ menu; drag to
 * re-order the Pinned group; "+" creates a folder; drag a session into it and out
 * again; collapse it (name + count); the layout survives a reload and shows live
 * in a second tab (`sidebarLayoutChanged`); the keyboard path (Move to folder ▸,
 * Move up / down, Rename, Delete) does the same without dragging. With nothing
 * pinned or foldered the list is exactly the prototype's rows.
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

function list(page: Page): Locator {
  return page.getByTestId('sidebar-sessions');
}

function row(page: Page, id: string): Locator {
  return list(page).locator(`a.sb-session[data-session-id="${id}"]`);
}

/** The session ids in the order the sidebar shows them, with the group each row is in. */
async function shown(page: Page): Promise<Array<[string, string]>> {
  return list(page)
    .locator('a.sb-session')
    .evaluateAll((rows) => rows.map((r) => [r.getAttribute('data-session-id') ?? '', r.getAttribute('data-group') ?? ''] as [string, string]));
}

/** A native drag: press on `source`, move a little (the drag starts and drop zones appear), then release over `target` at `y` (a fraction of its height). */
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

async function openRowMenu(page: Page, id: string): Promise<Locator> {
  await row(page, id).hover();
  await row(page, id).getByTestId('sidebar-session-menu').click();
  const menu = page.getByTestId('sidebar-menu');
  await expect(menu).toBeVisible();
  return menu;
}

test('nothing pinned or foldered: the rows are the list itself, the label copy unchanged', async ({ page }) => {
  const all = await sessions(page);
  await expect(list(page).locator(':scope > *')).toHaveCount(all.length);
  await expect(list(page).locator(':scope > a.sb-session')).toHaveCount(all.length);
  const label = page.locator('.sb-section-label').filter({ has: page.getByTestId('sidebar-new-folder') });
  expect((await label.textContent())?.trim()).toBe(`Sessions${all.length}`);
  // Loose rows keep the service's order (newest first).
  expect((await shown(page)).map(([id]) => id)).toEqual(all.map((s) => s.id));
  // The row's ⋯ is invisible at rest, next to the × on hover.
  const first = row(page, all[0]?.id as string);
  await expect(first.getByTestId('sidebar-session-menu')).toHaveCSS('opacity', '0');
  const before = await first.locator('.sb-session-name').boundingBox();
  await first.hover();
  await expect(first.getByTestId('sidebar-session-menu')).toHaveCSS('opacity', '1');
  expect(await first.locator('.sb-session-name').boundingBox()).toEqual(before);
});

test('pin, drag re-order, folder, drag in and out, collapse; persists across a reload and shows live in a second tab', async ({ page, context }) => {
  const all = await sessions(page);
  const [a, b, c, d] = all.map((s) => s.id) as [string, string, string, string];

  // Pin two from the row menu: the Pinned group at the top, in pin order.
  await (await openRowMenu(page, c)).getByTestId('sidebar-menu-pin').click();
  await expect(page.getByTestId('sidebar-menu')).toHaveCount(0);
  await (await openRowMenu(page, a)).getByTestId('sidebar-menu-pin').click();
  await expect(page.getByTestId('sidebar-pinned-head')).toHaveText('Pinned');
  await expect.poll(async () => (await shown(page)).slice(0, 2)).toEqual([
    [c, 'pinned'],
    [a, 'pinned'],
  ]);
  // The menu offers Unpin now.
  const menu = await openRowMenu(page, a);
  await expect(menu.getByTestId('sidebar-menu-unpin')).toHaveText('Unpin');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sidebar-menu')).toHaveCount(0);

  // Drag a above c (upper half of c's row).
  await dragOnto(page, row(page, a), () => row(page, c), 0.2);
  await expect.poll(async () => (await layoutOf(page)).pinned).toEqual([a, c]);
  await expect.poll(async () => (await shown(page)).slice(0, 2).map(([id]) => id)).toEqual([a, c]);

  // A second tab, open before the next changes: it follows them live.
  const other = await context.newPage();
  await stubToolProbes(other);
  await openApp(other, demo.baseUrl, '/inbox');
  await expect.poll(async () => (await shown(other)).slice(0, 2).map(([id]) => id)).toEqual([a, c]);

  // "+" creates a folder (named in place).
  await page.getByTestId('sidebar-new-folder').click();
  const name = page.getByTestId('sidebar-new-folder-name');
  await expect(name).toBeFocused();
  await name.fill('Work');
  await name.press('Enter');
  const folder = page.getByTestId('sidebar-folder');
  await expect(folder).toHaveCount(1);
  await expect(folder.getByTestId('sidebar-folder-name')).toHaveText('Work');
  await expect(folder.getByTestId('sidebar-folder-count')).toHaveText('0');
  await expect(other.getByTestId('sidebar-folder').getByTestId('sidebar-folder-name')).toHaveText('Work');

  // Drag a loose session onto the folder: into it; a pinned one too (it leaves Pinned).
  await dragOnto(page, row(page, b), () => page.getByTestId('sidebar-folder'));
  await expect(folder.getByTestId('sidebar-folder-count')).toHaveText('1');
  await dragOnto(page, row(page, c), () => page.getByTestId('sidebar-folder'));
  await expect(folder.getByTestId('sidebar-folder-count')).toHaveText('2');
  let layout = await layoutOf(page);
  expect(layout.pinned).toEqual([a]);
  expect(layout.folders[0]?.sessionIds).toEqual([b, c]);
  await expect(row(page, b)).toHaveAttribute('data-group', 'folder');
  await expect(row(other, c)).toHaveAttribute('data-group', 'folder');

  // Drag it out again: the drop zone for loose sessions appears while dragging a placed session.
  await dragOnto(page, row(page, b), () => page.getByTestId('sidebar-loose-zone'));
  await expect(folder.getByTestId('sidebar-folder-count')).toHaveText('1');
  await expect(row(page, b)).toHaveAttribute('data-group', 'loose');
  await expect(page.getByTestId('sidebar-loose-zone')).toHaveCount(0);

  // Put d in too, then collapse: the folder shows its name and count, its rows go.
  await dragOnto(page, row(page, d), () => page.getByTestId('sidebar-folder'));
  await expect(folder.getByTestId('sidebar-folder-count')).toHaveText('2');
  await folder.getByTestId('sidebar-folder-toggle').click();
  await expect(folder).toHaveAttribute('data-collapsed', 'true');
  await expect(folder.getByTestId('sidebar-folder-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, c)).toHaveCount(0);
  await expect(row(page, d)).toHaveCount(0);
  await expect(folder.getByTestId('sidebar-folder-count')).toHaveText('2');
  await expect(other.getByTestId('sidebar-folder')).toHaveAttribute('data-collapsed', 'true');

  // Reload: everything is where it was (stored by the service).
  await page.reload();
  await page.getByTestId('shell').waitFor();
  await expect(page.getByTestId('sidebar-folder')).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('sidebar-folder').getByTestId('sidebar-folder-count')).toHaveText('2');
  await expect.poll(async () => (await shown(page))[0]).toEqual([a, 'pinned']);
  await expect(row(page, c)).toHaveCount(0);
  layout = await layoutOf(page);
  expect(layout).toMatchObject({ pinned: [a], folders: [{ name: 'Work', collapsed: true, sessionIds: [c, d] }] });

  // Expand again: its rows come back in their dragged order.
  await page.getByTestId('sidebar-folder').click();
  await expect.poll(async () => (await shown(page)).filter(([, g]) => g === 'folder').map(([id]) => id)).toEqual([c, d]);
  await other.close();
});

test('keyboard path: Move to folder ▸, Move up / down, folder Rename / re-order by drag / Delete (its sessions become loose)', async ({ page }) => {
  const all = await sessions(page);
  const [a, b, c] = all.map((s) => s.id) as [string, string, string];
  for (const name of ['One', 'Two']) {
    await page.getByTestId('sidebar-new-folder').click();
    await page.getByTestId('sidebar-new-folder-name').fill(name);
    await page.getByTestId('sidebar-new-folder-name').press('Enter');
    await expect(page.getByTestId('sidebar-folder').filter({ hasText: name })).toHaveCount(1);
  }
  const [one, two] = (await layoutOf(page)).folders.map((f) => f.id) as [string, string];

  // Move to folder ▸ One, from the keyboard: the menu takes the focus, ↓ walks it, Enter picks.
  for (const id of [a, b]) {
    await row(page, id).hover();
    await row(page, id).getByTestId('sidebar-session-menu').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('sidebar-menu-pin')).toBeFocused();
    await page.getByTestId('sidebar-menu-move-to-folder').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(`sidebar-menu-folder-${one}`)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('sidebar-menu')).toHaveCount(0);
  }
  await expect.poll(async () => (await layoutOf(page)).folders[0]?.sessionIds).toEqual([a, b]);

  // Move up on b, Move down is off for the last one.
  let menu = await openRowMenu(page, b);
  await expect(menu.getByTestId('sidebar-menu-down')).toBeDisabled();
  await menu.getByTestId('sidebar-menu-up').click();
  await expect.poll(async () => (await layoutOf(page)).folders[0]?.sessionIds).toEqual([b, a]);

  // Out of the folder via the submenu.
  menu = await openRowMenu(page, a);
  await menu.getByTestId('sidebar-menu-move-to-folder').click();
  await expect(menu.getByTestId(`sidebar-menu-folder-${one}`)).toHaveCount(0);
  await menu.getByTestId('sidebar-menu-out-of-folder').click();
  await expect.poll(async () => (await layoutOf(page)).folders[0]?.sessionIds).toEqual([b]);

  // Folders re-order by dragging a head onto the other's upper half.
  await dragOnto(page, page.getByTestId('sidebar-folder').filter({ hasText: 'Two' }), () => page.getByTestId('sidebar-folder').filter({ hasText: 'One' }), 0.2);
  await expect.poll(async () => (await layoutOf(page)).folders.map((f) => f.id)).toEqual([two, one]);
  await expect(page.getByTestId('sidebar-folder').first()).toContainText('Two');

  // Rename from the folder menu.
  await page.getByTestId('sidebar-folder').filter({ hasText: 'One' }).hover();
  await page.getByTestId('sidebar-folder').filter({ hasText: 'One' }).getByTestId('sidebar-folder-menu').click();
  await page.getByTestId('sidebar-menu-rename').click();
  const field = page.getByTestId('sidebar-folder-rename');
  await expect(field).toBeFocused();
  await field.fill('Reviews');
  await field.press('Enter');
  await expect(page.getByTestId('sidebar-folder').filter({ hasText: 'Reviews' })).toHaveCount(1);

  // Put c in Reviews, then delete it: b and c become loose again, in the service's order.
  await (await openRowMenu(page, c)).getByTestId('sidebar-menu-move-to-folder').click();
  await page.getByTestId(`sidebar-menu-folder-${one}`).click();
  await expect.poll(async () => (await layoutOf(page)).folders.find((f) => f.id === one)?.sessionIds).toEqual([b, c]);
  await page.getByTestId('sidebar-folder').filter({ hasText: 'Reviews' }).hover();
  await page.getByTestId('sidebar-folder').filter({ hasText: 'Reviews' }).getByTestId('sidebar-folder-menu').click();
  await page.getByTestId('sidebar-menu-delete').click();
  await expect(page.getByTestId('sidebar-folder')).toHaveCount(1);
  await expect.poll(async () => (await shown(page)).filter(([, g]) => g === 'loose').map(([id]) => id)).toEqual(all.map((s) => s.id));
});
