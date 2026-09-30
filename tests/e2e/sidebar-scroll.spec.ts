import { type Locator, type Page, expect, test } from '@playwright/test';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * Fix: sidebar scrolling (E2E, real path with fake-claude, no demo seed;
 * `docs/sidebar.md` → *Layout and scrolling*). With many open sessions only the
 * SESSIONS list scrolls: the brand, + New session, the nav, TOOLS, the SESSIONS
 * label, Settings and the machine footer stay in view at 1440×900. The session
 * opened from the ⌘K palette has its row scrolled into the list's view; a row's ⋯
 * menu near the bottom shows in full (it flips above its row when the window has
 * no room below); dragging a session near the list's top edge scrolls the list,
 * so it can be dropped on a folder that was out of view; hiding and showing the
 * sidebar (D41) keeps the list's scroll position.
 */

const COUNT = 26;
let world: QuestionWorld;
/** Oldest first (the list shows newest first, so `ids[0]` is the last row). */
const ids: string[] = [];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  world = await startQuestionWorld('e2e-sidebar-scroll');
  const page = await browser.newPage();
  await page.goto(`${world.baseUrl}/`);
  for (let i = 1; i <= COUNT; i += 1) ids.push((await world.startSession(page, `many-${String(i).padStart(2, '0')}`, 'Reply with just OK.')).id);
  await page.close();
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await resetLayout(page);
  await expect(list(page).locator('a.sb-session')).toHaveCount(COUNT);
});

async function resetLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const layout = (await (await fetch('/api/sidebar')).json()) as SidebarLayout;
    const json = { 'content-type': 'application/json' };
    for (const id of layout.pinned) await fetch('/api/sidebar/place', { method: 'POST', headers: json, body: JSON.stringify({ sessionId: id, place: 'loose' }) });
    for (const folder of layout.folders) await fetch(`/api/sidebar/folders/${encodeURIComponent(folder.id)}`, { method: 'DELETE' });
  });
}

async function addFolder(page: Page, name: string): Promise<void> {
  await page.evaluate(async (folderName) => {
    await fetch('/api/sidebar/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: folderName }) });
  }, name);
}

function list(page: Page): Locator {
  return page.getByTestId('sidebar-sessions');
}

function row(page: Page, id: string): Locator {
  return list(page).locator(`a.sb-session[data-session-id="${id}"]`);
}

async function scrollState(page: Page): Promise<{ sidebarTop: number; sidebarScrolls: boolean; listTop: number; listScrolls: boolean; listSideways: boolean }> {
  return page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>('.sb-sidebar')!;
    const sessions = document.querySelector<HTMLElement>('[data-testid="sidebar-sessions"]')!;
    return {
      sidebarTop: sidebar.scrollTop,
      sidebarScrolls: sidebar.scrollHeight > sidebar.clientHeight,
      listTop: sessions.scrollTop,
      listScrolls: sessions.scrollHeight > sessions.clientHeight,
      listSideways: sessions.scrollWidth > sessions.clientWidth,
    };
  });
}

async function setListScroll(page: Page, to: 'top' | 'end'): Promise<void> {
  await page.evaluate((where) => {
    const sessions = document.querySelector<HTMLElement>('[data-testid="sidebar-sessions"]')!;
    sessions.scrollTop = where === 'top' ? 0 : sessions.scrollHeight;
  }, to);
}

/** The boxes of the parts that must stay put while the list scrolls. */
async function fixedParts(page: Page): Promise<Record<string, { x: number; y: number; width: number; height: number } | null>> {
  const boxes: Record<string, { x: number; y: number; width: number; height: number } | null> = {};
  for (const id of ['new-session', 'nav-inbox', 'nav-mcp', 'nav-history', 'sidebar-tools', 'sidebar-new-folder', 'nav-settings', 'machine-footer', 'usage-meters']) {
    boxes[id] = await page.getByTestId(id).boundingBox();
  }
  return boxes;
}

/** `box` lies inside the window (1440×900) and inside `outer` (if given). */
function expectInside(box: { x: number; y: number; width: number; height: number } | null, outer?: { x: number; y: number; width: number; height: number } | null): void {
  expect(box).not.toBeNull();
  const b = box!;
  const o = outer ?? { x: 0, y: 0, width: 1440, height: 900 };
  expect(b.y).toBeGreaterThanOrEqual(o.y - 0.5);
  expect(b.y + b.height).toBeLessThanOrEqual(o.y + o.height + 0.5);
  expect(b.x).toBeGreaterThanOrEqual(o.x - 0.5);
  expect(b.x + b.width).toBeLessThanOrEqual(o.x + o.width + 0.5);
}

test('many sessions: only the SESSIONS list scrolls; nav, TOOLS, the SESSIONS label, Settings and the footer stay in view', async ({ page }) => {
  const state = await scrollState(page);
  expect(state.sidebarScrolls).toBe(false);
  expect(state.listScrolls).toBe(true);
  expect(state.listSideways).toBe(false);
  await expect(list(page)).toHaveCSS('overflow-y', 'auto');
  await expect(list(page)).toHaveCSS('overflow-x', 'hidden');

  const before = await fixedParts(page);
  for (const box of Object.values(before)) expectInside(box);
  // The list fills the room between the SESSIONS label and Settings.
  const listBox = await list(page).boundingBox();
  const settings = before['nav-settings']!;
  expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(settings.y + 0.5);
  expect(listBox!.height).toBeGreaterThanOrEqual(160);

  // Scrolled to its end: the last (oldest) row shows, nothing else moved, the sidebar itself did not scroll.
  await setListScroll(page, 'end');
  await expect.poll(async () => (await scrollState(page)).listTop).toBeGreaterThan(0);
  expect(await fixedParts(page)).toEqual(before);
  expect((await scrollState(page)).sidebarTop).toBe(0);
  expectInside(await row(page, ids[0]!).boundingBox(), listBox);

  // The wheel over the list scrolls the list, not the sidebar.
  await setListScroll(page, 'top');
  await list(page).hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(async () => (await scrollState(page)).listTop).toBeGreaterThan(0);
  expect((await scrollState(page)).sidebarTop).toBe(0);
  expect(await fixedParts(page)).toEqual(before);

  // D41: hiding and showing the sidebar keeps the list where it was.
  const kept = (await scrollState(page)).listTop;
  await page.getByTestId('sidebar-hide').click();
  await expect(page.getByTestId('shell')).toHaveAttribute('data-sidebar', 'hidden');
  await page.getByTestId('sidebar-show').click();
  await expect(page.getByTestId('shell')).not.toHaveAttribute('data-sidebar', 'hidden');
  await expect.poll(async () => (await fixedParts(page))['machine-footer']).toEqual(before['machine-footer']);
  expect((await scrollState(page)).listTop).toBe(kept);
});

test('a session opened from the ⌘K palette has its row scrolled into the list; the sidebar itself does not move', async ({ page }) => {
  await setListScroll(page, 'top');
  const oldest = row(page, ids[0]!);
  const listBox = await list(page).boundingBox();
  // At the top of the list the oldest row is out of view.
  expect((await oldest.boundingBox())!.y).toBeGreaterThan(listBox!.y + listBox!.height);

  await page.getByTestId('open-palette').click();
  await page.getByTestId('palette-input').fill('many-01');
  await expect(page.locator('[data-testid="palette-row"][aria-selected="true"]')).toContainText('many-01');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${world.baseUrl}/sessions/${encodeURIComponent(ids[0]!)}`);
  await expect(oldest).toHaveAttribute('aria-current', 'page');
  await expect.poll(async () => (await oldest.boundingBox())!.y).toBeLessThan(listBox!.y + listBox!.height);
  expectInside(await oldest.boundingBox(), listBox);
  expect((await scrollState(page)).sidebarTop).toBe(0);

  // Back to the top by hand, then another session from the palette: the list follows again; the newest is revealed too.
  await setListScroll(page, 'end');
  await page.getByTestId('open-palette').click();
  await page.getByTestId('palette-input').fill(`many-${COUNT}`);
  await expect(page.locator('[data-testid="palette-row"][aria-selected="true"]')).toContainText(`many-${COUNT}`);
  await page.keyboard.press('Enter');
  const newest = row(page, ids[COUNT - 1]!);
  await expect(newest).toHaveAttribute('aria-current', 'page');
  await expect.poll(async () => (await newest.boundingBox())!.y).toBeGreaterThanOrEqual(listBox!.y - 0.5);
  expectInside(await newest.boundingBox(), listBox);
});

test('a row menu opened near the bottom of the list shows in full; a tall one flips above its ⋯; scrolling the list closes it', async ({ page }) => {
  for (let i = 1; i <= 10; i += 1) await addFolder(page, `Folder ${i}`);
  await expect(list(page).getByTestId('sidebar-folder')).toHaveCount(10);
  await setListScroll(page, 'end');
  const last = row(page, ids[0]!);
  const listBox = (await list(page).boundingBox())!;
  const rowBox = (await last.boundingBox())!;
  // The row sits at the bottom edge of the list.
  expect(rowBox.y + rowBox.height).toBeGreaterThan(listBox.y + listBox.height - 60);

  await last.hover();
  await last.getByTestId('sidebar-session-menu').click();
  const menu = page.getByTestId('sidebar-menu');
  await expect(menu).toBeVisible();
  // The menu is not inside the scrolling list (a portal), so the list cannot clip it.
  expect(await menu.evaluate((el) => el.closest('[data-testid="sidebar-sessions"]') === null)).toBe(true);
  const small = (await menu.boundingBox())!;
  expectInside(small);
  expect(small.y + small.height).toBeGreaterThan(listBox.y + listBox.height); // it reaches below the list: not clipped by it
  expect(await hitsMenu(page, small)).toBe(true);

  // Move to folder ▸: ten entries (the folders), taller than the room under the row: it opens above its ⋯, in full.
  await page.getByTestId('sidebar-menu-move-to-folder').click();
  await expect(menu.getByRole('menuitem')).toHaveCount(10);
  const tall = (await menu.boundingBox())!;
  expectInside(tall);
  // Above its ⋯ button (the menu's anchor), not under it.
  const button = (await last.getByTestId('sidebar-session-menu').boundingBox())!;
  expect(tall.y + tall.height).toBeLessThanOrEqual(button.y + 0.5);
  expect(tall.y + tall.height).toBeGreaterThan(button.y - 10);
  expect(await hitsMenu(page, tall)).toBe(true);

  // Scrolling the list moves the row away from the menu: the menu closes.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-testid="sidebar-sessions"]')!.scrollTop -= 200;
  });
  await expect(menu).toHaveCount(0);
});

/** Every corner of `box` (8 px in, past its rounded corners) is the menu itself: nothing covers or clips it. */
async function hitsMenu(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<boolean> {
  return page.evaluate(
    (b) =>
      [
        [b.x + 8, b.y + 8],
        [b.x + b.width - 8, b.y + 8],
        [b.x + 8, b.y + b.height - 8],
        [b.x + b.width - 8, b.y + b.height - 8],
      ].every(([x, y]) => document.elementFromPoint(x!, y!)?.closest('[data-testid="sidebar-menu"]') !== null),
    box,
  );
}

test('dragging a session near the top edge of the list scrolls it, so it can be dropped on a folder out of view', async ({ page }) => {
  await addFolder(page, 'Target');
  const folder = list(page).getByTestId('sidebar-folder');
  await expect(folder).toHaveCount(1);
  await setListScroll(page, 'end');
  const listBox = (await list(page).boundingBox())!;
  // The folder (first in the list) is scrolled out of view.
  expect((await folder.boundingBox())!.y + 10).toBeLessThan(listBox.y);

  const source = row(page, ids[0]!);
  const from = (await source.boundingBox())!;
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 34, from.y + from.height / 2 - 6, { steps: 3 });
  // Hold near the list's top edge until the folder head comes into view.
  const edgeY = listBox.y + 6;
  await page.mouse.move(from.x + 40, edgeY, { steps: 6 });
  await expect
    .poll(
      async () => {
        await page.mouse.move(from.x + 41, edgeY);
        await page.mouse.move(from.x + 40, edgeY);
        return (await folder.boundingBox())!.y;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(listBox.y + 20);
  const head = (await folder.boundingBox())!;
  await page.mouse.move(head.x + 40, head.y + head.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => ((await page.evaluate(async () => (await (await fetch('/api/sidebar')).json()) as SidebarLayout)).folders[0]?.sessionIds ?? [])).toEqual([ids[0]]);
  expect((await scrollState(page)).sidebarTop).toBe(0);
});

test('a long TOOLS list scrolls on its own inside a quarter of the window; SESSIONS keeps at least 160 px; the footer stays in view', async ({ page }) => {
  const before = await page.evaluate(async () => (await (await fetch('/api/tools')).json()) as unknown[]);
  const put = (tools: unknown[]) =>
    page.evaluate(async (body) => (await fetch('/api/tools', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, tools);
  try {
    expect(await put(Array.from({ length: 14 }, (_, i) => ({ name: `Tool ${i + 1}`, url: null, description: null, showInSidebar: true })))).toBe(200);
    await openWithHub(page, `${world.baseUrl}/inbox`);
    const tools = page.getByTestId('sidebar-tools');
    await expect(tools.locator('.sb-tool')).toHaveCount(14);
    const box = await tools.evaluate((el) => ({ height: el.clientHeight, scrolls: el.scrollHeight > el.clientHeight, sideways: el.scrollWidth > el.clientWidth }));
    expect(box.height).toBeLessThanOrEqual(900 * 0.25 + 0.5);
    expect(box.scrolls).toBe(true);
    expect(box.sideways).toBe(false);
    expect((await list(page).boundingBox())!.height).toBeGreaterThanOrEqual(160);
    expect((await scrollState(page)).sidebarScrolls).toBe(false);
    expectInside(await page.getByTestId('machine-footer').boundingBox());
    expectInside(await page.getByTestId('nav-settings').boundingBox());
  } finally {
    expect(await put(before)).toBe(200);
  }
});
