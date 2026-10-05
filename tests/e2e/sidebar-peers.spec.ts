import { type Browser, type BrowserContext, type Locator, type Page, expect, test } from '@playwright/test';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { remoteId } from '../../src/core/peers.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, pairedNodes } from '../helpers/peers.ts';

/**
 * D71 fix · a paired machine's session in the sidebar's folders (`docs/sidebar.md`
 * → *Storage and sync*): two real Switchboards on loopback test ports (D48 test
 * world, fake CLIs). On B, A's sessions (remote ids `r~<A>~<id>`) are dragged into
 * a folder, a subfolder, Pinned and re-ordered inside a folder, and moved with the
 * ⋯ menu; a drag held at the edge of the scrolling list scrolls it to a folder out
 * of view (the sidebar does that itself now, in every engine). D71: the shared
 * layout's switch in Settings → Machines and a synced move in the other sidebar.
 */

let tmp: string;
let nodes: PeerNode[] = [];
let contexts: BrowserContext[] = [];

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-sidebar-peers');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function pageOf(browser: Browser, target: PeerNode, at: string, height = 1200): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${target.baseUrl}${at}`);
  return page;
}

function list(page: Page): Locator {
  return page.getByTestId('sidebar-sessions');
}

function row(page: Page, id: string): Locator {
  return list(page).locator(`a.sb-session[data-session-id="${id}"]`);
}

function folderHead(page: Page, id: string): Locator {
  return list(page).locator(`[data-folder-id="${id}"]`);
}

/** A native drag: press on `source`, start the drag, move onto `target` at `y` (a fraction of its height), hover a moment (dragover), release. */
async function dragOnto(page: Page, source: Locator, target: () => Locator, y = 0.5): Promise<void> {
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  if (!from) throw new Error('no source box');
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 34, from.y + from.height / 2 + 6, { steps: 3 });
  const to = await target().boundingBox();
  if (!to) throw new Error('no target box');
  await page.mouse.move(to.x + 40, to.y + to.height * y, { steps: 6 });
  for (let k = 0; k < 4; k++) {
    await page.waitForTimeout(40);
    await page.mouse.move(to.x + 41 + (k % 2), to.y + to.height * y);
  }
  await page.mouse.up();
}

async function layoutOf(node: PeerNode): Promise<SidebarLayout> {
  return (await node.call('GET', '/api/sidebar')).body as SidebarLayout;
}

async function startOn(node: PeerNode, name: string): Promise<string> {
  const started = await node.call('POST', '/api/sessions', { name, task: 'Hello.', folder: node.folderId, worktrees: false, ultracode: false });
  expect(started.status).toBe(201);
  return started.body.id as string;
}

test('a paired machine\'s sessions go into a folder and a subfolder, get pinned and re-ordered by drag and drop, and move with the ⋯ menu', async ({ browser }) => {
  const world = await pairedNodes(tmp);
  nodes.push(world.a, world.b);
  const { a, b, aId } = world;
  const r1 = remoteId(aId, await startOn(a, 'on-a-1'));
  const r2 = remoteId(aId, await startOn(a, 'on-a-2'));
  const r3 = remoteId(aId, await startOn(a, 'on-a-3'));
  const local = await startOn(b, 'on-b');
  const top = ((await b.call('POST', '/api/sidebar/folders', { name: 'Acme' })).body as SidebarLayout).folders[0]?.id as string;
  const sub = ((await b.call('POST', '/api/sidebar/folders', { name: 'PROJ-1', parentId: top })).body as SidebarLayout).folders.find((f) => f.name === 'PROJ-1')?.id as string;
  const page = await pageOf(browser, b, '/inbox');
  for (const id of [r1, r2, r3, local]) await expect(row(page, id)).toBeVisible({ timeout: 15_000 });
  // A's sessions follow B's, newest first (the peer's own order).
  await expect.poll(async () => list(page).locator('a.sb-session').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-session-id')))).toEqual([local, r3, r2, r1]);

  // Into the folder and into the subfolder.
  await dragOnto(page, row(page, r1), () => folderHead(page, top));
  await expect.poll(async () => (await layoutOf(b)).folders.find((f) => f.id === top)?.sessionIds).toEqual([r1]);
  await expect(row(page, r1)).toHaveAttribute('data-group', 'folder');
  await dragOnto(page, row(page, r2), () => folderHead(page, sub));
  await expect.poll(async () => (await layoutOf(b)).folders.find((f) => f.id === sub)?.sessionIds).toEqual([r2]);

  // A third one into the top folder before the first (the upper half of its row), then after it: re-ordered inside the folder.
  await dragOnto(page, row(page, r3), () => row(page, r1), 0.25);
  await expect.poll(async () => (await layoutOf(b)).folders.find((f) => f.id === top)?.sessionIds).toEqual([r3, r1]);
  await dragOnto(page, row(page, r3), () => row(page, r1), 0.8);
  await expect.poll(async () => (await layoutOf(b)).folders.find((f) => f.id === top)?.sessionIds).toEqual([r1, r3]);

  // Pinned (the "drop here to pin" label): out of the folder.
  await dragOnto(page, row(page, r1), () => page.getByTestId('sidebar-pinned-head'));
  await expect.poll(async () => (await layoutOf(b)).pinned).toEqual([r1]);
  await expect(row(page, r1)).toHaveAttribute('data-group', 'pinned');

  // The ⋯ menu: Move to folder ▸ the subfolder.
  await row(page, r3).hover();
  await row(page, r3).getByTestId('sidebar-session-menu').click();
  const menu = page.getByTestId('sidebar-menu');
  await menu.getByTestId('sidebar-menu-move-to-folder').click();
  await menu.getByTestId(`sidebar-menu-folder-${sub}`).click();
  await expect.poll(async () => (await layoutOf(b)).folders.find((f) => f.id === sub)?.sessionIds).toEqual([r2, r3]);
  await expect(page.getByTestId('sidebar-layout-error')).toHaveCount(0);
});

test('a drag held at the list\'s top edge scrolls it, so a paired machine\'s session at the bottom reaches a folder out of view', async ({ browser }) => {
  const world = await pairedNodes(tmp);
  nodes.push(world.a, world.b);
  const { a, b, aId } = world;
  const remote = remoteId(aId, await startOn(a, 'on-a'));
  for (let i = 0; i < 10; i++) await startOn(b, `on-b-${i}`);
  const folder = ((await b.call('POST', '/api/sidebar/folders', { name: 'Acme' })).body as SidebarLayout).folders[0]?.id as string;
  const page = await pageOf(browser, b, '/inbox', 900);
  await expect(row(page, remote)).toBeAttached({ timeout: 15_000 });
  await list(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const box = (await list(page).boundingBox()) as { x: number; y: number; width: number; height: number };
  expect(((await folderHead(page, folder).boundingBox())?.y ?? 0) + 10).toBeLessThan(box.y);
  const from = (await row(page, remote).boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 34, from.y + from.height / 2 - 6, { steps: 3 });
  const edgeY = box.y + 4;
  await page.mouse.move(from.x + 40, edgeY, { steps: 6 });
  await expect
    .poll(
      async () => {
        await page.mouse.move(from.x + 41, edgeY);
        await page.mouse.move(from.x + 40, edgeY);
        return (await folderHead(page, folder).boundingBox())?.y ?? 0;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(box.y + 20);
  const head = (await folderHead(page, folder).boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(head.x + 40, head.y + head.height / 2, { steps: 4 });
  await page.mouse.move(head.x + 41, head.y + head.height / 2);
  await expect(folderHead(page, folder)).toHaveAttribute('data-drop', 'into');
  await page.mouse.up();
  await expect.poll(async () => (await layoutOf(b)).folders[0]?.sessionIds).toEqual([remote]);
});

test('D71: Settings → Machines switches the shared sidebar layout on (waiting until both are on); a move on A shows up in B\'s sidebar', async ({ browser }) => {
  const world = await pairedNodes(tmp);
  nodes.push(world.a, world.b);
  const { a, b, aId } = world;
  const own = await startOn(a, 'on-a');
  const folderOnA = ((await a.call('POST', '/api/sidebar/folders', { name: 'Acme' })).body as SidebarLayout).folders[0]?.id as string;

  const settingsA = await pageOf(browser, a, '/settings/machines');
  const rowA = settingsA.getByTestId('machine');
  await expect(rowA.getByTestId('machine-sidebar-sync-switch')).toHaveText('off');
  await expect(rowA.getByTestId('machine-sidebar-sync-text')).toContainText('Off:');
  await rowA.getByTestId('machine-sidebar-sync-switch').click();
  await expect(rowA.getByTestId('machine-sidebar-sync-switch')).toHaveText('on');
  await expect(rowA.getByTestId('machine-sidebar-sync')).toHaveAttribute('data-state', 'waiting', { timeout: 10_000 });
  await expect(rowA.getByTestId('machine-sidebar-sync-text')).toContainText('waiting for');

  const settingsB = await pageOf(browser, b, '/settings/machines');
  const rowB = settingsB.getByTestId('machine');
  await rowB.getByTestId('machine-sidebar-sync-switch').click();
  await expect(rowB.getByTestId('machine-sidebar-sync')).toHaveAttribute('data-state', 'synced', { timeout: 10_000 });
  await expect(rowA.getByTestId('machine-sidebar-sync')).toHaveAttribute('data-state', 'synced', { timeout: 10_000 });

  // B's sidebar shows A's folder (merged); A drags its own session into it; B's sidebar follows live.
  const sidebarB = await pageOf(browser, b, '/inbox');
  await expect(folderHead(sidebarB, folderOnA)).toBeVisible({ timeout: 10_000 });
  const sidebarA = await pageOf(browser, a, '/inbox');
  await expect(row(sidebarA, own)).toBeVisible({ timeout: 15_000 });
  await dragOnto(sidebarA, row(sidebarA, own), () => folderHead(sidebarA, folderOnA));
  await expect.poll(async () => (await layoutOf(a)).folders[0]?.sessionIds).toEqual([own]);
  await expect(row(sidebarB, remoteId(aId, own))).toHaveAttribute('data-group', 'folder', { timeout: 10_000 });
  expect((await layoutOf(b)).folders[0]?.sessionIds).toEqual([remoteId(aId, own)]);
});
