import { type Browser, type CDPSession, type Locator, type Page, expect, test, webkit } from '@playwright/test';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { type DemoApp, startDemoApp } from './visual/harness.ts';
import { PHONE_SIZES, ROUTES, type Size, expectInsideWindow, expectNoOverflow, newTouchPage, openDrawer, openPage, touchContext } from './responsive-world.ts';

/**
 * D74 oracle (docs/responsive.md → Touch, Long-press drag), on the demo seed with
 * a touch screen:
 * 1. a sidebar row held still for ~400 ms lifts and follows the finger: dropped on
 *    a folder it goes into the folder; dropped on another loose row it is
 *    re-ordered there (the mouse drag's targets, `resolveDrop`);
 * 2. a finger that moves at once scrolls the drawer and never starts a drag;
 * 3. tap targets are at least 44 × 44 px on a coarse pointer, and a row's ⋯ is
 *    shown without a hover;
 * 4. WebKit (when its browser is installed): the phone sizes' pages do not
 *    overflow, the drawer works, and a long press drags a row into a folder.
 * Chromium's touches go through CDP (`Input.dispatchTouchEvent`), so the browser
 * itself decides between a scroll and a held press.
 */

let app: DemoApp;

test.beforeAll(async () => {
  app = await startDemoApp();
});

test.afterAll(async () => {
  await app?.stop();
});

const PHONE: Size = { name: 'phone', width: 390, height: 844 };

async function layout(page: Page): Promise<SidebarLayout> {
  return page.evaluate(async () => (await (await fetch('/api/sidebar')).json()) as SidebarLayout);
}

/** Makes sure a top-level folder named `name` exists (empty of `sessionId`); returns its id. */
async function folderNamed(page: Page, name: string): Promise<string> {
  return page.evaluate(async (wanted) => {
    const read = async (): Promise<SidebarLayout> => (await (await fetch('/api/sidebar')).json()) as SidebarLayout;
    let found = (await read()).folders.find((folder) => folder.name === wanted);
    if (!found) {
      await fetch('/api/sidebar/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: wanted }) });
      found = (await read()).folders.find((folder) => folder.name === wanted);
    }
    return found?.id ?? '';
  }, name);
}

async function center(locator: Locator, dx = 0): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('no box');
  return { x: box.x + Math.min(box.width / 2, 80) + dx, y: box.y + box.height / 2 };
}

/** Chromium touch input (a real touch the browser may turn into a scroll). */
class Finger {
  private readonly cdp: CDPSession;

  private constructor(cdp: CDPSession) {
    this.cdp = cdp;
  }

  static async of(page: Page): Promise<Finger> {
    return new Finger(await page.context().newCDPSession(page));
  }

  down(at: { x: number; y: number }): Promise<unknown> {
    return this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
  }

  async move(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12, pauseMs = 25): Promise<void> {
    for (let i = 1; i <= steps; i += 1) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }

  up(): Promise<unknown> {
    return this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

async function drawerAt(browser: Browser, size: Size): Promise<Page> {
  const context = await touchContext(browser, size);
  const page = await newTouchPage(context);
  await openPage(page, app.baseUrl, '/history');
  await openDrawer(page);
  return page;
}

test('long-press drag: a row lifts after the hold, goes into a folder, and re-orders among the loose rows', async ({ browser }) => {
  const page = await drawerAt(browser, PHONE);
  const folderId = await folderNamed(page, 'Phone work');
  await page.reload();
  await page.getByTestId('shell').waitFor();
  await openDrawer(page);
  const finger = await Finger.of(page);

  // Into the folder.
  const row = page.locator('a.sb-session[data-session-id="qa-free-talk"]');
  const folder = page.locator(`[data-testid="sidebar-folder"][data-folder-id="${folderId}"]`);
  await row.scrollIntoViewIfNeeded();
  const start = await center(row);
  await finger.down(start);
  await page.waitForTimeout(250);
  // Not yet: the hold is ~400 ms.
  await expect(page.getByTestId('sidebar-touch-ghost')).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('sidebar-touch-ghost')).toBeVisible();
  await expect(row).toHaveAttribute('data-dragging', 'true');
  const target = await center(folder);
  await finger.move(start, target);
  await expect(folder).toHaveAttribute('data-drop', 'into');
  await finger.up();
  await expect.poll(async () => (await layout(page)).folders.find((f) => f.id === folderId)?.sessionIds ?? []).toContain('qa-free-talk');
  await expect(page.getByTestId('sidebar-touch-ghost')).toHaveCount(0);
  // The release did not follow the row's link.
  await expect(page).toHaveURL(/\/history$/);

  // Re-order: the last loose row goes before the first one.
  const loose = page.locator('a.sb-session[data-group="loose"]');
  const before = await loose.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-session-id')));
  const last = loose.last();
  const first = loose.first();
  await last.scrollIntoViewIfNeeded();
  const from = await center(last);
  await finger.down(from);
  await page.waitForTimeout(550);
  await expect(last).toHaveAttribute('data-dragging', 'true');
  const firstBox = await first.boundingBox();
  if (!firstBox) throw new Error('no first row');
  const to = { x: from.x, y: firstBox.y + 6 };
  await finger.move(from, to, 16);
  await expect(first).toHaveAttribute('data-drop', 'before');
  await finger.up();
  const moved = before.at(-1);
  await expect.poll(async () => (await loose.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-session-id'))))[0]).toBe(moved);
  await page.context().close();
});

test('D77 · the Todos board: a card held still lifts and goes into another column (its state changes); a quick swipe does not', async ({ browser }) => {
  const size: Size = { name: 'tablet', width: 1024, height: 768 };
  const context = await touchContext(browser, size);
  const page = await newTouchPage(context);
  await openPage(page, app.baseUrl, '/todos');
  const todoId = await page.evaluate(async (session) => {
    const answer = (await (await fetch(`/api/sessions/${session}/todos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Drag me by touch' }) })).json()) as { todos: Array<{ id: string; title: string }> };
    window.localStorage.setItem('sb.todos.view', 'board');
    return answer.todos.find((todo) => todo.title === 'Drag me by touch')?.id ?? '';
  }, 'free-talk-feature');
  await openPage(page, app.baseUrl, '/todos');
  const board = page.getByTestId('todo-board');
  const card = board.locator(`[data-testid="todo-item"][data-todo-id="${todoId}"]`);
  await expect(card).toHaveAttribute('data-state', 'open');
  const finger = await Finger.of(page);
  const start = await center(card.getByTestId('todo-session-label'));
  const target = await center(board.getByTestId('board-column-in_progress'));
  // A quick swipe (within the hold) is no drag.
  await finger.down(start);
  await finger.move(start, target, 6, 10);
  await finger.up();
  await page.waitForTimeout(300);
  await expect(card).toHaveAttribute('data-state', 'open');
  // Held still past ~400 ms: it lifts (the ghost follows), the target column lights up, the drop moves it.
  await finger.down(start);
  await page.waitForTimeout(550);
  await expect(board.getByTestId('board-ghost')).toBeVisible();
  await finger.move(start, target);
  await expect(board.getByTestId('board-column-in_progress')).toHaveAttribute('data-over', 'true');
  await finger.up();
  await expect(board.getByTestId('board-column-in_progress').locator(`[data-todo-id="${todoId}"]`)).toHaveAttribute('data-state', 'in_progress');
  await expect(board.getByTestId('board-ghost')).toHaveCount(0);
  await page.evaluate(
    async ({ session, id }) => {
      await fetch(`/api/sessions/${session}/todos/${id}`, { method: 'DELETE' });
      window.localStorage.removeItem('sb.todos.view');
    },
    { session: 'free-talk-feature', id: todoId },
  );
  await context.close();
});

test('a finger that moves at once scrolls the drawer and never starts a drag', async ({ browser }) => {
  const page = await drawerAt(browser, { name: 'phone', width: 360, height: 760 });
  const sidebar = page.getByTestId('sidebar');
  await expect.poll(() => sidebar.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const finger = await Finger.of(page);
  const row = page.locator('a.sb-session').first();
  const start = await center(row);
  // The row is on screen, the list goes on below the window.
  expect(start.y).toBeLessThan(760 - 30);
  await finger.down(start);
  // A quick swipe up (well within the hold), then the finger stays down past the hold.
  await finger.move(start, { x: start.x, y: start.y - 200 }, 10, 12);
  await page.waitForTimeout(600);
  await expect(page.locator('[data-dragging="true"]')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-touch-ghost')).toHaveCount(0);
  await finger.up();
  expect(await sidebar.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByTestId('sidebar-sessions')).not.toHaveAttribute('data-dragging');
  // No tap either: the page did not change.
  await expect(page).toHaveURL(/\/history$/);
  await page.context().close();
});

test('tap targets are at least 44 × 44 px on a touch screen; the row ⋯ shows without a hover', async ({ browser }) => {
  const context = await touchContext(browser, PHONE);
  const page = await newTouchPage(context);
  const big = async (locator: Locator, label: string): Promise<void> => {
    const count = await locator.count();
    expect(count, `${label}: present`).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const box = await locator.nth(i).boundingBox();
      if (!box) continue; // not on screen (scrolled away)
      expect(Math.round(box.height), `${label} #${i} height`).toBeGreaterThanOrEqual(44);
      expect(Math.round(box.width), `${label} #${i} width`).toBeGreaterThanOrEqual(44);
    }
  };
  await openPage(page, app.baseUrl, '/history');
  await big(page.getByTestId('drawer-open'), 'menu button');
  await big(page.getByTestId('app-bar-inbox'), 'app bar Inbox');
  await openDrawer(page);
  await big(page.locator('.sb-nav-item'), 'nav item');
  await big(page.getByTestId('new-session'), 'New session');
  await big(page.getByTestId('nav-settings'), 'Settings');
  await big(page.getByTestId('sidebar-hide'), 'drawer close');
  await big(page.getByTestId('sidebar-new-folder'), 'new folder');
  await big(page.locator('a.sb-session'), 'session row');
  const more = page.getByTestId('sidebar-session-menu');
  await big(more, 'row ⋯');
  expect(await more.first().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  // The × needs a hover: Close is in the menu.
  await expect(page.getByTestId('sidebar-session-close').first()).toBeHidden();
  await more.first().tap();
  await big(page.locator('.sb-layout-menu-item'), 'menu item');
  await page.keyboard.press('Escape');

  await openPage(page, app.baseUrl, '/sessions/free-talk-feature');
  await big(page.locator('.sb-sv-tab'), 'session tab');
  await big(page.getByTestId('session-more'), 'session ⋯');
  await big(page.getByTestId('panel-open'), 'panel button');
  await big(page.getByTestId('chat-send'), 'Send');
  await big(page.locator('.sb-chat-quick-reply'), 'quick reply');
  await big(page.getByTestId('question').first().locator('.sb-qcard__option'), 'question option');
  await page.getByTestId('session-more').tap();
  await big(page.getByTestId('session-actions-menu').locator('.sb-sv-action'), 'header action');
  await context.close();
});

test.describe('WebKit (phones)', () => {
  let engine: Browser | null = null;

  test.beforeAll(async () => {
    engine = await webkit.launch().catch(() => null);
  });

  test.afterAll(async () => {
    await engine?.close();
  });

  for (const size of PHONE_SIZES) {
    test(`${size.width}×${size.height}: pages, drawer, long-press drag`, async () => {
      test.skip(engine === null, 'the Playwright WebKit browser is not installed');
      if (!engine) return;
      test.setTimeout(180_000);
      const context = await touchContext(engine, size);
      const page = await newTouchPage(context);
      for (const route of ROUTES) {
        await openPage(page, app.baseUrl, route);
        await page.waitForLoadState('networkidle');
        await expectNoOverflow(page, size.width, `WebKit ${route}`);
      }
      await openPage(page, app.baseUrl, '/history');
      await openDrawer(page);
      await expectInsideWindow(page.getByTestId('sidebar'), size, 'WebKit drawer');
      await page.getByTestId('nav-inbox').tap();
      await expect(page.getByTestId('view-inbox')).toBeVisible();
      await expect(page.getByTestId('shell')).toHaveAttribute('data-drawer', 'closed');

      // A long press drags a row into a folder (pointer events: WebKit has no CDP touch input here).
      const folderId = await folderNamed(page, `WebKit ${size.width}`);
      await page.reload();
      await page.getByTestId('shell').waitFor();
      await openDrawer(page);
      const row = page.locator('a.sb-session[data-session-id="button-rollout"]');
      const folder = page.locator(`[data-testid="sidebar-folder"][data-folder-id="${folderId}"]`);
      await row.scrollIntoViewIfNeeded();
      const to = await center(folder);
      const fromNow = await center(row);
      await page.evaluate(
        async ({ start, end }) => {
          const fire = (type: string, at: { x: number; y: number }): void => {
            const target = document.elementFromPoint(at.x, at.y) ?? document.body;
            target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: at.x, clientY: at.y }));
          };
          const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
          fire('pointerdown', start);
          await wait(550);
          for (let i = 1; i <= 10; i += 1) {
            fire('pointermove', { x: start.x + ((end.x - start.x) * i) / 10, y: start.y + ((end.y - start.y) * i) / 10 });
            await wait(20);
          }
          fire('pointerup', end);
        },
        { start: fromNow, end: to },
      );
      await expect.poll(async () => (await layout(page)).folders.find((f) => f.id === folderId)?.sessionIds ?? []).toContain('button-rollout');
      await context.close();
    });
  }
});
