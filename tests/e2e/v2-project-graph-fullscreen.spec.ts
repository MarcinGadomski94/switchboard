import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { PLAN_ID, samplePlan } from './project-graph-sample.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fixes after 2.0 → *The Project graph in full screen* (`src/web/v2/projects/GraphView.tsx`,
 * `graph-fullscreen.ts`): Full screen from the header and from the zoom stack (the Fullscreen API
 * in headless Chromium; the window-filling overlay when the API is missing, as on iOS Safari), Esc
 * and Exit, the canvas filling the screen, the automatic fit on resize and the Fit pill after a
 * manual zoom, tooltips, menus and the step sheet inside the full-screen element, the
 * `/projects/:id/graph` page, and a phone (390 × 844) on the overlay. Screenshots:
 * `test-results/v2-project-graph-fullscreen-*.png`.
 */

let tmp: string;
let server: ServerProcess;

const node = (page: Page, key: string) => page.locator(`[data-testid="v2-graph-node"][data-key="${key}"]`);

async function serve(page: Page): Promise<void> {
  await stubToolProbes(page);
  const plan = samplePlan();
  await page.route(new RegExp(`/api/plans/${PLAN_ID}(\\?.*)?$`), (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, json: plan }) : route.fallback()));
  await page.route(new RegExp(`/api/plans/${PLAN_ID}/`), (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, json: [] }) : route.fallback()));
}

/** Takes the Fullscreen API away (iOS Safari has none for elements): Full screen falls back to the overlay. */
async function withoutFullscreenApi(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, 'requestFullscreen', { value: undefined, configurable: true });
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false, configurable: true });
  });
}

async function openGraph(page: Page): Promise<void> {
  await page.goto(`${server.baseUrl}/projects/${PLAN_ID}`);
  await page.getByTestId('v2-project-views').getByRole('button', { name: 'Graph' }).click();
  await expect(page.getByTestId('v2-graph-node')).toHaveCount(15);
}

/** The full-screen element's and the canvas's boxes against the viewport. */
async function boxes(page: Page): Promise<{ root: DOMRect; frame: DOMRect; width: number; height: number; fullscreenElement: string | null }> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="v2-project-graph"]')?.getBoundingClientRect();
    const frame = document.querySelector('[data-testid="v2-graph-canvas"]')?.getBoundingClientRect();
    if (!root || !frame) throw new Error('no graph');
    return { root: root.toJSON() as DOMRect, frame: frame.toJSON() as DOMRect, width: window.innerWidth, height: window.innerHeight, fullscreenElement: document.fullscreenElement?.getAttribute('data-testid') ?? null };
  });
}

/** Whether the stage (the fitted graph) lies inside the canvas. */
async function fitted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const frame = document.querySelector('[data-testid="v2-graph-canvas"]')?.getBoundingClientRect();
    const stage = document.querySelector('[data-testid="v2-graph-stage"]')?.getBoundingClientRect();
    if (!frame || !stage) return false;
    return stage.left >= frame.left - 1 && stage.right <= frame.right + 1 && stage.top >= frame.top - 1 && stage.bottom <= frame.bottom + 1;
  });
}

/** The canvas fills the screen: the root covers the viewport, the canvas its width and all of its height but the top bar (`bar` px at most). */
async function expectFillsScreen(page: Page, bar = 110): Promise<void> {
  await expect
    .poll(async () => {
      const b = await boxes(page);
      return Math.abs(b.root.width - b.width) <= 1 && Math.abs(b.root.height - b.height) <= 1 && b.frame.width >= b.width - 32 && b.frame.height >= b.height - bar;
    })
    .toBe(true);
}

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-v2-project-graph-fullscreen');
  server = await startServer({ SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), ...V2_SERVER_ENV });
});

test.afterAll(async () => {
  await server?.stop();
  await removeTempDir(tmp);
});

test('Full screen from the header and the zoom stack (the Fullscreen API); Esc and Exit leave; the title shows progress', async ({ page }) => {
  test.setTimeout(60_000);
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGraph(page);
  const root = page.getByTestId('v2-project-graph');
  const title = await page.title();

  await page.getByTestId('v2-graph-fullscreen').click();
  await expect(root).toHaveAttribute('data-fs', 'native');
  expect((await boxes(page)).fullscreenElement).toBe('v2-project-graph');
  await expectFillsScreen(page);
  await expect(page.getByTestId('v2-graph-fs-title')).toHaveText('Acme orders');
  await expect(page.getByTestId('v2-graph-fs-bar').getByTestId('v2-graph-summary')).toHaveText('1 of 15 done · 1 working · 2 need you');
  await expect(page.getByTestId('v2-graph-critical')).toBeVisible();
  await expect(page.getByTestId('v2-graph-follow')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('v2-graph-exit')).toBeVisible();
  await expect.poll(() => page.title()).toBe('▶ 7% · Acme orders');
  await expect.poll(() => fitted(page)).toBe(true);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.mouse.move(700, 450);
    await page.screenshot({ path: `test-results/v2-project-graph-fullscreen-1440-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });

  // Esc leaves (the browser's own key for the Fullscreen API).
  await page.keyboard.press('Escape');
  await expect(root).not.toHaveAttribute('data-fs', /.*/);
  await expect.poll(async () => (await boxes(page)).fullscreenElement).toBeNull();
  await expect.poll(() => page.title()).toBe(title);
  await expect(page.locator('.v2-p-graph-legend')).toBeVisible();

  // The zoom stack's icon enters too; Exit (header) and the icon (zoom stack) leave.
  await page.getByTestId('v2-graph-zoom-fullscreen').click();
  await expect(root).toHaveAttribute('data-fs', 'native');
  await page.getByTestId('v2-graph-exit').click();
  await expect(root).not.toHaveAttribute('data-fs', /.*/);
  await page.getByTestId('v2-graph-zoom-fullscreen').click();
  await expect(root).toHaveAttribute('data-fs', 'native');
  await page.getByTestId('v2-graph-zoom-fullscreen').click();
  await expect(root).not.toHaveAttribute('data-fs', /.*/);
});

test('the overlay when the Fullscreen API is missing: fills the window, Esc leaves', async ({ page }) => {
  await withoutFullscreenApi(page);
  await serve(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openGraph(page);
  const root = page.getByTestId('v2-project-graph');
  await page.getByTestId('v2-graph-fullscreen').click();
  await expect(root).toHaveAttribute('data-fs', 'overlay');
  await expectFillsScreen(page);
  // Covers the shell (the rail is underneath).
  const onTop = await page.evaluate(() => document.elementFromPoint(20, 400)?.closest('[data-testid="v2-project-graph"]') !== null);
  expect(onTop).toBe(true);
  await page.keyboard.press('Escape');
  await expect(root).not.toHaveAttribute('data-fs', /.*/);
});

test('re-fits on resize until zoomed by hand; then the Fit pill re-fits', async ({ page }) => {
  test.setTimeout(60_000);
  // A window in the API's full screen cannot be resized by the test: the overlay (same canvas rules).
  await withoutFullscreenApi(page);
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGraph(page);
  const canvas = page.getByTestId('v2-graph-canvas');
  await page.getByTestId('v2-graph-fullscreen').click();
  await expect(page.getByTestId('v2-project-graph')).toHaveAttribute('data-fs', 'overlay');
  await expect.poll(() => fitted(page)).toBe(true);
  const zoomWide = Number(await canvas.getAttribute('data-zoom'));
  await expect(page.getByTestId('v2-graph-fit-pill')).toHaveCount(0);

  // A smaller window: the graph fits again by itself.
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeLessThan(zoomWide);
  await expect.poll(() => fitted(page)).toBe(true);
  await expectFillsScreen(page);

  // Zoomed by hand: a resize leaves the view; the Fit pill fits again.
  await page.getByTestId('v2-graph-zoom-in').click();
  await page.getByTestId('v2-graph-zoom-in').click();
  await expect(page.getByTestId('v2-graph-fit-pill')).toBeVisible();
  const zoomed = await canvas.getAttribute('data-zoom');
  await page.setViewportSize({ width: 1200, height: 760 });
  await expectFillsScreen(page);
  await expect(canvas).toHaveAttribute('data-zoom', zoomed ?? '');
  await page.getByTestId('v2-graph-fit-pill').click();
  await expect(page.getByTestId('v2-graph-fit-pill')).toHaveCount(0);
  await expect.poll(() => fitted(page)).toBe(true);

  // Follow is a toggle, remembered.
  await page.getByTestId('v2-graph-follow').click();
  await expect(page.getByTestId('v2-graph-follow')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('switchboard.v2.projectGraph.follow'))).toBe('0');
  await page.getByTestId('v2-graph-follow').click();
  await expect(page.getByTestId('v2-graph-follow')).toHaveAttribute('aria-pressed', 'true');
});

test('tooltips, step menus and the step sheet show inside the full-screen element', async ({ page }) => {
  test.setTimeout(60_000);
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGraph(page);
  const root = page.getByTestId('v2-project-graph');
  await page.getByTestId('v2-graph-fullscreen').click();
  await expect(root).toHaveAttribute('data-fs', 'native');
  const inside = (selector: string): Promise<boolean> =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el !== null && (document.fullscreenElement?.contains(el) ?? false);
    }, selector);

  await node(page, 'ACME-4').hover();
  await expect(page.getByTestId('v2-graph-tip')).toBeVisible();
  expect(await inside('[data-testid="v2-graph-tip"]')).toBe(true);

  await node(page, 'ACME-5').hover();
  await node(page, 'ACME-5').getByTestId('v2-step-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Restart' })).toBeVisible();
  expect(await inside('[role="menu"]')).toBe(true);
  await page.mouse.move(700, 450);
  await page.screenshot({ path: 'test-results/v2-project-graph-fullscreen-1440-menu.png' });
  // Esc closes the menu first; full screen stays.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: 'Restart' })).toHaveCount(0);
  await expect(root).toHaveAttribute('data-fs', 'native');

  // A click on the failed step opens its details, inside full screen.
  await node(page, 'ACME-5').click();
  await expect(page.getByTestId('v2-step-sheet')).toBeVisible();
  expect(await inside('[data-testid="v2-step-sheet"]')).toBe(true);
  await page.getByTestId('v2-step-sheet').getByRole('button', { name: /close/i }).first().click();
  await expect(page.getByTestId('v2-step-sheet')).toHaveCount(0);

  // The graph's ⋯ has Open in a new window and Copy link.
  await page.getByTestId('v2-graph-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Open in a new window' })).toBeVisible();
  expect(await inside('[role="menu"]')).toBe(true);
  await expect(page.getByRole('menuitem', { name: 'Copy link to this graph' })).toBeVisible();
});

test('/projects/:id/graph: the graph alone, filling the window; Full screen from there; opened from the ⋯', async ({ page, context }) => {
  test.setTimeout(60_000);
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGraph(page);
  // "Open in a new window" opens the page.
  const popupPromise = context.waitForEvent('page');
  await page.getByTestId('v2-graph-menu').click();
  await page.getByRole('menuitem', { name: 'Open in a new window' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(new URL(popup.url()).pathname).toBe(`/projects/${PLAN_ID}/graph`);
  await popup.close();

  await page.goto(`${server.baseUrl}/projects/${PLAN_ID}/graph`);
  await expect(page.getByTestId('v2-page-project-graph')).toBeVisible();
  await expect(page.getByTestId('v2-graph-node')).toHaveCount(15);
  const root = page.getByTestId('v2-project-graph');
  await expect(root).toHaveAttribute('data-fs', 'page');
  await expect(page.getByTestId('v2-rail')).toHaveCount(0);
  await expectFillsScreen(page);
  await expect.poll(() => page.title()).toBe('▶ 7% · Acme orders');
  await expect.poll(() => fitted(page)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.mouse.move(700, 450);
  await page.screenshot({ path: 'test-results/v2-project-graph-fullscreen-page-1440.png' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Full screen from the page uses the API; leaving it comes back to the page.
  await page.getByTestId('v2-graph-fullscreen').click();
  await expect(root).toHaveAttribute('data-fs', 'native');
  await page.keyboard.press('Escape');
  await expect(root).toHaveAttribute('data-fs', 'page');
  // ← goes back to the project page.
  await page.getByTestId('v2-graph-back').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PLAN_ID}$`));
  await expect(page.getByTestId('v2-rail')).toBeVisible();
});

test('phone 390 × 844: the overlay fills the screen; pinch still zooms; Exit leaves', async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await withoutFullscreenApi(page);
    await serve(page);
    await page.goto(`${server.baseUrl}/projects/${PLAN_ID}`);
    await page.getByTestId('v2-project-views').getByRole('button', { name: 'Graph' }).tap();
    await expect(page.getByTestId('v2-graph-node')).toHaveCount(15);
    const root = page.getByTestId('v2-project-graph');
    await page.getByTestId('v2-graph-fullscreen').tap();
    await expect(root).toHaveAttribute('data-fs', 'overlay');
    // A phone's top bar wraps (title and Exit; the ring and the bar; Critical path and Follow).
    await expectFillsScreen(page, 180);
    // A phone opens full screen on the work at the phone zoom (a fitted 15-step project is unreadable at 390).
    await expect.poll(async () => Number(await page.getByTestId('v2-graph-canvas').getAttribute('data-zoom'))).toBeCloseTo(0.55, 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    // Touch screens never auto-hide the top bar.
    await page.waitForTimeout(3300);
    await expect(root).not.toHaveAttribute('data-idle', /.*/);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.screenshot({ path: 'test-results/v2-project-graph-fullscreen-390-light.png' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: 'test-results/v2-project-graph-fullscreen-390-dark.png' });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });

    // Pinch: as on the normal canvas.
    const canvas = page.getByTestId('v2-graph-canvas');
    const before = Number(await canvas.getAttribute('data-zoom'));
    await canvas.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const y = box.top + 80;
      const fire = (type: string, id: number, x: number): boolean => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
      fire('pointerdown', 1, box.left + 100);
      fire('pointerdown', 2, box.left + 200);
      fire('pointermove', 2, box.left + 250);
      fire('pointermove', 1, box.left + 50);
      fire('pointerup', 2, box.left + 250);
      fire('pointerup', 1, box.left + 50);
    });
    await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeCloseTo(before * 2, 2);
    await expect(page.getByTestId('v2-graph-fit-pill')).toBeVisible();

    await page.getByTestId('v2-graph-exit').tap();
    await expect(root).not.toHaveAttribute('data-fs', /.*/);
    await expect(canvas).toHaveAttribute('data-narrow', 'true');
  } finally {
    await context.close();
  }
});

test('idle: after 3 s the top bar fades and the pointer hides; a move brings them back', async ({ page }) => {
  test.setTimeout(30_000);
  await serve(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openGraph(page);
  const root = page.getByTestId('v2-project-graph');
  await page.getByTestId('v2-graph-fullscreen').click();
  await expect(root).toHaveAttribute('data-fs', 'native');
  await page.mouse.move(600, 500);
  // Nothing in the top bar has the keyboard focus (the button that was clicked keeps it otherwise).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(610, 500);
  await expect(root).toHaveAttribute('data-idle', 'true', { timeout: 6000 });
  await page.mouse.move(640, 520);
  await expect(root).not.toHaveAttribute('data-idle', /.*/);
});
