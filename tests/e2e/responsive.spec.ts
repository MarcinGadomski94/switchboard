import { expect, test } from '@playwright/test';
import { type DemoApp, startDemoApp } from './visual/harness.ts';
import { DEMO_SESSION, ROUTES, SIZES, type Size, expectInsideWindow, expectNoOverflow, newTouchPage, openDrawer, openPage, touchContext } from './responsive-world.ts';

/**
 * D74 oracle (docs/responsive.md), on the demo seed, at 360×740, 640×360,
 * 768×1024 and 1024×768 with a touch screen:
 * 1. every page (the nav's views, a tool, a session's four tabs, every Settings
 *    section) has no horizontal page overflow and nothing past the window's edge;
 * 2. the app bar names the page, its ☰ opens the sidebar drawer, a link in the
 *    drawer opens its page and closes the drawer, the scrim closes it too;
 * 3. the dialogs (New session Simple and Full, the palette, the setup wizard,
 *    the Close confirmation) fit the window;
 * 4. the menus (a sidebar row's ⋯ menu, the session header's ⋯ menu below 1024 px)
 *    fit the window;
 * 5. the desktop (1440×900) has none of it: no app bar, the sidebar in its column.
 */

let app: DemoApp;

test.beforeAll(async () => {
  app = await startDemoApp();
});

test.afterAll(async () => {
  await app?.stop();
});

const SESSION = DEMO_SESSION;

for (const size of SIZES) {
  test.describe(`${size.name} ${size.width}×${size.height}`, () => {
    test('every page: no horizontal overflow, nothing past the window', async ({ browser }) => {
      const context = await touchContext(browser, size);
      const page = await newTouchPage(context);
      for (const route of ROUTES) {
        await openPage(page, app.baseUrl, route);
        await expect(page.locator('main [data-view]').first()).toBeVisible();
        // Loaded: the lists and the session's detail render after their first answer.
        await page.waitForLoadState('networkidle');
        await expectNoOverflow(page, size.width, route);
      }
      // A phone's list → detail pages: the picked item, with its ‹ Back.
      if (size.width < 768) {
        await openPage(page, app.baseUrl, '/inbox');
        await page.getByTestId('inbox-list').locator('.sb-inbox__card').first().click();
        await expect(page.getByTestId('inbox-back')).toBeVisible();
        await expect(page.getByTestId('inbox-list')).toBeHidden();
        await expectNoOverflow(page, size.width, 'inbox item');
        await page.getByTestId('inbox-back').click();
        await expect(page.getByTestId('inbox-list')).toBeVisible();

        await openPage(page, app.baseUrl, '/solutions');
        await page.getByTestId('solutions-list').locator('.sb-sol-row').first().click();
        await expect(page.getByTestId('solutions-back')).toBeVisible();
        await expectNoOverflow(page, size.width, 'solution');

        await openPage(page, app.baseUrl, '/settings');
        await expect(page.getByTestId('settings-content')).toBeHidden();
        await page.getByTestId('settings-nav-sessions').click();
        await expect(page.getByTestId('settings-back')).toBeVisible();
        await page.getByTestId('settings-back').click();
        await expect(page).toHaveURL(/\/settings$/);
      }
      await context.close();
    });

    test('the app bar and the sidebar drawer', async ({ browser }) => {
      const context = await touchContext(browser, size);
      const page = await newTouchPage(context);
      await openPage(page, app.baseUrl, '/history');
      await expect(page.getByTestId('app-bar-title')).toHaveText('History');
      await expect(page.getByTestId('app-bar-inbox-count')).toHaveText('5');
      // Closed: off screen, inert.
      await expect(page.getByTestId('sidebar')).toHaveAttribute('inert', '');
      await openDrawer(page);
      await expectInsideWindow(page.getByTestId('sidebar'), size, 'drawer');
      await expect(page.getByTestId('drawer-scrim')).toBeVisible();
      await expectNoOverflow(page, size.width, 'drawer open');
      // A link in the drawer opens its page and closes the drawer.
      await page.getByTestId('nav-schedules').click();
      await expect(page.getByTestId('view-schedules')).toBeVisible();
      await expect(page.getByTestId('app-bar-title')).toHaveText('Schedules & loops');
      await expect(page.getByTestId('shell')).toHaveAttribute('data-drawer', 'closed');
      // The scrim closes it (on a phone the drawer covers the screen: its hide button does).
      await openDrawer(page);
      if (size.width >= 768) await page.getByTestId('drawer-scrim').click({ position: { x: size.width - 10, y: size.height / 2 } });
      else await page.getByTestId('sidebar-hide').click();
      await expect(page.getByTestId('shell')).toHaveAttribute('data-drawer', 'closed');
      // The session view has no app bar: its header holds the menu button.
      await openPage(page, app.baseUrl, `/sessions/${SESSION}`);
      await expect(page.getByTestId('app-bar')).toHaveCount(0);
      await expect(page.getByTestId('session-header').getByTestId('drawer-open')).toBeVisible();
      await context.close();
    });

    test('dialogs fit the window', async ({ browser }) => {
      const context = await touchContext(browser, size);
      const page = await newTouchPage(context);
      await openPage(page, app.baseUrl, '/inbox');

      await openDrawer(page);
      await page.getByTestId('new-session').click();
      // A dialog opened from the drawer closes it.
      await expect(page.getByTestId('shell')).toHaveAttribute('data-drawer', 'closed');
      await expect(page.getByTestId('ns-mode-simple')).toBeVisible();
      await expectInsideWindow(page.getByTestId('modal-new-session'), size, 'New session (Simple)');
      await expectNoOverflow(page, size.width, 'New session (Simple)');
      await page.getByTestId('ns-mode-full').click();
      await expect(page.getByTestId('ns-mode-full')).toHaveAttribute('aria-checked', 'true');
      await expectInsideWindow(page.getByTestId('modal-new-session'), size, 'New session (Full)');
      await expectNoOverflow(page, size.width, 'New session (Full)');
      await page.keyboard.press('Escape');
      await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);

      await openDrawer(page);
      await page.getByTestId('open-palette').click();
      await expect(page.getByTestId('palette-input')).toBeVisible();
      await expectInsideWindow(page.getByTestId('modal-palette'), size, 'palette');
      await expectNoOverflow(page, size.width, 'palette');
      await page.keyboard.press('Escape');

      await openPage(page, app.baseUrl, '/settings/claude');
      await page.getByTestId('settings-run-setup').click();
      await expect(page.getByTestId('modal-setup-wizard')).toBeVisible();
      await expectInsideWindow(page.getByTestId('modal-setup-wizard'), size, 'setup wizard');
      await expectNoOverflow(page, size.width, 'setup wizard');
      await page.keyboard.press('Escape');

      // The Close confirmation of a session waiting for answers.
      await openPage(page, app.baseUrl, `/sessions/${SESSION}`);
      if (size.width < 1024) await page.getByTestId('session-more').click();
      await page.getByTestId('session-close').click();
      const confirm = page.locator('.sb-close-dialog');
      await expect(confirm).toBeVisible();
      await expectInsideWindow(confirm, size, 'Close confirmation');
      await expectNoOverflow(page, size.width, 'Close confirmation');
      await context.close();
    });

    test('D77 · the Todos board: four columns in the board (tablet), one column with a picker (phone); nothing past the window', async ({ browser }) => {
      const context = await touchContext(browser, size);
      const page = await newTouchPage(context);
      await openPage(page, app.baseUrl, '/todos');
      // Three items on the demo session (removed again at the end), and the board as the remembered view.
      const ids = await page.evaluate(async (session) => {
        const out: string[] = [];
        for (const title of ['Board on a small screen', 'A second card with a much longer title that has to wrap on a phone', 'Third']) {
          const answer = (await (await fetch(`/api/sessions/${session}/todos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, estimateMinutes: 30 }) })).json()) as { todos: Array<{ id: string; title: string }> };
          out.push(answer.todos.find((todo) => todo.title === title)?.id ?? '');
        }
        await fetch(`/api/sessions/${session}/todos/${out[2]}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'in_progress' }) });
        window.localStorage.setItem('sb.todos.view', 'board');
        return out;
      }, SESSION);
      await openPage(page, app.baseUrl, '/todos');
      const board = page.getByTestId('todo-board');
      await expect(board).toBeVisible();
      await expect(board.getByTestId('todo-item').first()).toBeVisible();
      if (size.width < 768) {
        // One column at a time: the picker (with counts) chooses it.
        await expect(board.getByTestId('board-column-picker')).toBeVisible();
        await expect(board.locator('[data-board-column]')).toHaveCount(1);
        await expect(board.getByTestId('board-column-open').getByTestId('todo-item')).toHaveCount(2);
        await board.getByTestId('board-pick-in_progress').click();
        await expect(board.getByTestId('board-column-in_progress').getByTestId('todo-item')).toHaveCount(1);
        await expectInsideWindow(board.getByTestId('board-column-in_progress'), { ...size, height: 100_000 }, 'the column');
      } else {
        await expect(board.getByTestId('board-column-picker')).toHaveCount(0);
        await expect(board.locator('[data-board-column]')).toHaveCount(4);
      }
      await expectNoOverflow(page, size.width, 'Todos board');
      // The card's ⋯ menu (Move to) fits the window's width (and its height, where it is tall enough for the menu's eight entries).
      const card = board.getByTestId('todo-item').first();
      await card.getByTestId('todo-menu-button').click();
      await expect(card.getByTestId('todo-menu-move')).toBeVisible();
      await expectInsideWindow(card.getByTestId('todo-menu'), size.height >= 700 ? size : { ...size, height: 100_000 }, 'board card ⋯ menu');
      await page.keyboard.press('Escape');
      await page.evaluate(
        async ({ session, todoIds }) => {
          for (const id of todoIds) await fetch(`/api/sessions/${session}/todos/${id}`, { method: 'DELETE' });
          window.localStorage.removeItem('sb.todos.view');
          window.localStorage.removeItem('sb.todos.boardColumn');
        },
        { session: SESSION, todoIds: ids },
      );
      await context.close();
    });

    test('menus fit the window', async ({ browser }) => {
      const context = await touchContext(browser, size);
      const page = await newTouchPage(context);
      await openPage(page, app.baseUrl, `/sessions/${SESSION}`);
      if (size.width < 1024) {
        // The header's actions sit in its ⋯ menu.
        await expect(page.getByTestId('session-actions-menu')).toBeHidden();
        await page.getByTestId('session-more').click();
        const menu = page.getByTestId('session-actions-menu');
        await expect(menu).toBeVisible();
        await expect(menu.getByTestId('session-pause')).toBeVisible();
        await expect(menu.getByTestId('session-handoff')).toBeVisible();
        await expectInsideWindow(menu, size, 'session ⋯ menu');
        // A tap outside closes it.
        await page.getByTestId('session-chat').click({ position: { x: 20, y: 20 } });
        await expect(menu).toBeHidden();
      } else {
        await expect(page.getByTestId('session-more')).toHaveCount(0);
        await expect(page.getByTestId('session-pause')).toBeVisible();
      }
      await expectNoOverflow(page, size.width, 'session header');

      // A sidebar row's ⋯ menu (always shown on a touch screen), with Close in it.
      await openDrawer(page);
      const row = page.locator('a.sb-session').first();
      // On a short window the drawer scrolls to the row first; a scroll that moves the ⋯ closes its menu (D54), so let it settle.
      await row.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await row.getByTestId('sidebar-session-menu').click();
      const rowMenu = page.getByTestId('sidebar-menu');
      await expect(rowMenu).toBeVisible();
      await expect(rowMenu.getByTestId('sidebar-menu-close')).toBeVisible();
      await expectInsideWindow(rowMenu, size, 'sidebar ⋯ menu');
      await context.close();
    });
  });
}

test('the desktop keeps the prototype shell: no app bar, the sidebar in its column', async ({ browser }) => {
  const size: Size = { name: 'desktop', width: 1440, height: 900 };
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
  const page = await newTouchPage(context);
  await openPage(page, app.baseUrl, `/sessions/${SESSION}`);
  await expect(page.getByTestId('app-bar')).toHaveCount(0);
  await expect(page.getByTestId('drawer-open')).toHaveCount(0);
  await expect(page.getByTestId('panel-open')).toHaveCount(0);
  await expect(page.getByTestId('session-more')).toHaveCount(0);
  const sidebar = await page.getByTestId('sidebar').boundingBox();
  expect(sidebar).toMatchObject({ x: 0, width: 256 });
  await expect(page.getByTestId('shell')).not.toHaveAttribute('data-layout');
  await context.close();
});
