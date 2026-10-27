import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { PLAN_ID, samplePlan } from './project-graph-sample.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fixes after 2.0 → *The Project graph, redrawn* (`src/web/v2/projects/GraphView.tsx`): a
 * 15-step fan-out / fan-in project over three repositories, served to the page as
 * `GET /api/plans/{id}` (the graph only reads it; a real server serves the app). Fit without
 * sideways overflow at 1440 × 900 and 1024 × 768, the hover path, the node ⋯ menu and click,
 * the keyboard, the critical path toggle, the minimap, reduced motion, and a phone (390 × 844,
 * touch): the Graph view, the opening view on the working step, pinch, double tap, long press.
 * Light and dark screenshots go to `test-results/v2-project-graph-*.png`.
 */

let tmp: string;
let server: ServerProcess;

async function serve(page: Page): Promise<void> {
  await stubToolProbes(page);
  const plan = samplePlan();
  await page.route(new RegExp(`/api/plans/${PLAN_ID}(\\?.*)?$`), (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, json: plan }) : route.fallback()));
  await page.route(new RegExp(`/api/plans/${PLAN_ID}/`), (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, json: [] }) : route.fallback()));
}

async function openGraph(page: Page): Promise<void> {
  await page.goto(`${server.baseUrl}/projects/${PLAN_ID}`);
  await page.getByTestId('v2-project-views').getByRole('button', { name: 'Graph' }).click();
  await expect(page.getByTestId('v2-graph-node')).toHaveCount(15);
}

const node = (page: Page, key: string) => page.locator(`[data-testid="v2-graph-node"][data-key="${key}"]`);

/** Whether the stage (the fitted graph) lies inside the canvas, and the page does not scroll sideways. */
async function fitsWithoutOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const frame = document.querySelector('[data-testid="v2-graph-canvas"]')?.getBoundingClientRect();
    const stage = document.querySelector('[data-testid="v2-graph-stage"]')?.getBoundingClientRect();
    if (!frame || !stage) return false;
    const inside = stage.left >= frame.left - 1 && stage.right <= frame.right + 1 && stage.top >= frame.top - 1 && stage.bottom <= frame.bottom + 1;
    return inside && document.documentElement.scrollWidth <= window.innerWidth + 1;
  });
}

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-v2-project-graph');
  server = await startServer({ SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), ...V2_SERVER_ENV });
});

test.afterAll(async () => {
  await server?.stop();
  await removeTempDir(tmp);
});

test('fits a 15-step project in three repository lanes without sideways overflow (1440 and 1024), light and dark', async ({ page }) => {
  test.setTimeout(60_000);
  await serve(page);
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
  ] as const) {
    await page.setViewportSize({ width, height });
    await openGraph(page);
    await expect(page.getByTestId('v2-graph-lane')).toHaveCount(4);
    await expect(page.getByTestId('v2-graph-edge')).toHaveCount(18);
    await expect(page.getByTestId('v2-graph-final')).toContainText('7%');
    await expect(page.getByTestId('v2-graph-summary')).toHaveText('1 of 15 done · 1 working · 2 need you');
    await page.getByTestId('v2-graph-fit').click();
    await expect.poll(() => fitsWithoutOverflow(page)).toBe(true);
    // Everything fits: no minimap (it shows only while steps are outside the view).
    await expect(page.getByTestId('v2-graph-minimap')).toHaveCount(0);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.mouse.move(0, 0);
      await page.getByTestId('v2-project-graph').screenshot({ path: `test-results/v2-project-graph-${width}-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  }
  // The legend explains the arrows and the lanes.
  await expect(page.locator('.v2-p-graph-legend')).toContainText('Arrows point to the steps that wait for it. Lanes group steps by repository.');
});

test('hover lights the path; click, ⋯, right-click and the keyboard still work', async ({ page }) => {
  test.setTimeout(60_000);
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGraph(page);
  // Hover the working step: it, its upstream and downstream light up; the rest dims.
  await node(page, 'ACME-4').hover();
  await expect(node(page, 'ACME-4')).toHaveAttribute('data-hot', 'true');
  await expect(node(page, 'ACME-1')).toHaveAttribute('data-hot', 'true');
  await expect(node(page, 'ACME-7')).toHaveAttribute('data-hot', 'true');
  await expect(node(page, 'ACME-15')).toHaveAttribute('data-hot', 'true');
  await expect(node(page, 'ACME-3')).toHaveAttribute('data-hot', 'false');
  await expect(page.locator('[data-testid="v2-graph-edge"][data-from="ACME-1"][data-to="ACME-4"]')).toHaveAttribute('data-hot', 'true');
  await expect(page.locator('[data-testid="v2-graph-edge"][data-from="ACME-1"][data-to="ACME-5"]')).toHaveAttribute('data-hot', 'false');
  await expect(page.getByTestId('v2-graph-tip')).toContainText('ACME-4 · Orders endpoints');
  await page.mouse.move(2, 2);
  await expect(node(page, 'ACME-3')).not.toHaveAttribute('data-hot', /.*/);

  // A click on the failed step opens its details (D139); its ⋯ and a right-click open the step menu.
  await node(page, 'ACME-5').click();
  await expect(page.getByTestId('v2-step-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('v2-step-sheet')).toHaveCount(0);
  await node(page, 'ACME-5').hover();
  await node(page, 'ACME-5').getByTestId('v2-step-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Restart' })).toBeVisible();
  await page.keyboard.press('Escape');
  await node(page, 'ACME-5').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Restart' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: 'Restart' })).toHaveCount(0);

  // Keyboard: Tab reaches the steps, Enter opens, the context-menu key opens the menu.
  await node(page, 'ACME-6').focus();
  await expect(node(page, 'ACME-6')).toHaveAttribute('data-hot', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('v2-step-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await node(page, 'ACME-6').focus();
  await page.keyboard.press('ContextMenu');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(node(page, 'ACME-6')).toHaveAttribute('aria-label', /ACME-6 .*· Waiting/);
});

test('the critical path toggle (remembered), the minimap pans, zoom buttons', async ({ page }) => {
  test.setTimeout(60_000);
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGraph(page);
  const toggle = page.getByTestId('v2-graph-critical');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('[data-testid="v2-graph-node"][data-crit]').count()).toBeGreaterThan(2);
  expect(await page.locator('[data-testid="v2-graph-edge"][data-crit]').count()).toBeGreaterThan(1);
  await toggle.click();
  await expect(page.locator('[data-testid="v2-graph-node"][data-crit]')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('v2-graph-node')).toHaveCount(15);
  await expect(page.getByTestId('v2-graph-critical')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('v2-graph-critical').click();
  await expect(page.getByTestId('v2-graph-critical')).toHaveAttribute('aria-pressed', 'true');

  // Zoom in twice, then a click on the minimap's far end moves the view there.
  const canvas = page.getByTestId('v2-graph-canvas');
  const zoom0 = Number(await canvas.getAttribute('data-zoom'));
  await page.getByTestId('v2-graph-zoom-in').click();
  await page.getByTestId('v2-graph-zoom-in').click();
  await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeGreaterThan(zoom0 * 1.4);
  // Steps are outside the view now: the minimap shows.
  await expect(page.getByTestId('v2-graph-minimap')).toBeVisible();
  await expect(page.getByTestId('v2-graph-map')).toHaveCount(0);
  const view = page.getByTestId('v2-graph-minimap-view');
  const before = Number(await view.getAttribute('x'));
  await page.getByTestId('v2-graph-minimap').scrollIntoViewIfNeeded();
  const mini = await page.getByTestId('v2-graph-minimap').boundingBox();
  if (!mini) throw new Error('no minimap');
  await page.mouse.click(mini.x + mini.width - 6, mini.y + mini.height / 2);
  await expect.poll(async () => Number(await view.getAttribute('x'))).toBeGreaterThan(before + 20);
  // ⌘/ctrl-wheel zooms around the pointer; Fit brings it all back.
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  const zoomed = Number(await canvas.getAttribute('data-zoom'));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 200);
  await page.keyboard.up('Control');
  await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeLessThan(zoomed);
  await page.getByTestId('v2-graph-fit').click();
  await expect.poll(() => fitsWithoutOverflow(page)).toBe(true);
  await expect(page.getByTestId('v2-graph-minimap')).toHaveCount(0);
  // A drag on empty canvas pans.
  const stage = page.getByTestId('v2-graph-stage');
  const t0 = await stage.evaluate((el) => getComputedStyle(el).transform);
  await page.mouse.move(box.x + 30, box.y + box.height - 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + box.height - 60, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => stage.evaluate((el) => getComputedStyle(el).transform)).not.toBe(t0);
});

test('motion: live edges carry dots and cards animate; reduced motion turns all of it off', async ({ page }) => {
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openGraph(page);
  // One live edge (into the working step): three dots.
  await expect(page.locator('[data-testid="v2-graph-edge"][data-kind="live"]')).toHaveCount(1);
  await expect(page.locator('.v2-p-gdot')).toHaveCount(3);
  const running = (): Promise<number> => page.evaluate(() => (document.querySelector('[data-testid="v2-project-graph"]')?.getAnimations({ subtree: true }) ?? []).length);
  expect(await running()).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.v2-p-gdot')).toHaveCount(0);
  await expect.poll(running).toBe(0);
});

test('phone: Graph is offered, opens on the working step; pinch, double tap, tap and long press', async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await serve(page);
    await page.goto(`${server.baseUrl}/projects/${PLAN_ID}`);
    // Steps by default on a phone; Graph is a choice (remembered).
    await expect(page.getByTestId('v2-steps')).toBeVisible();
    await page.getByTestId('v2-project-views').getByRole('button', { name: 'Graph' }).tap();
    await expect(page.getByTestId('v2-graph-node')).toHaveCount(15);
    await page.reload();
    await expect(page.getByTestId('v2-graph-node')).toHaveCount(15);

    const canvas = page.getByTestId('v2-graph-canvas');
    await canvas.scrollIntoViewIfNeeded();
    await expect(canvas).toHaveAttribute('data-narrow', 'true');
    await expect(canvas).toHaveAttribute('data-zoom', '0.550');
    // Centred on the working step.
    const frame = await canvas.boundingBox();
    const work = await node(page, 'ACME-4').boundingBox();
    if (!frame || !work) throw new Error('no boxes');
    expect(Math.abs(work.x + work.width / 2 - (frame.x + frame.width / 2))).toBeLessThan(4);
    expect(Math.abs(work.y + work.height / 2 - (frame.y + frame.height / 2))).toBeLessThan(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    // No minimap on a phone unless asked for: Map next to Fit toggles it.
    await expect(page.getByTestId('v2-graph-minimap')).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await canvas.screenshot({ path: 'test-results/v2-project-graph-390-light.png' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await canvas.screenshot({ path: 'test-results/v2-project-graph-390-dark.png' });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    const map = page.getByTestId('v2-graph-map');
    await expect(map).toHaveAttribute('aria-pressed', 'false');
    await map.tap();
    await expect(map).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('v2-graph-minimap')).toBeVisible();
    const mapBox = await page.getByTestId('v2-graph-minimap').boundingBox();
    expect(Math.round(mapBox?.width ?? 0)).toBe(120);
    await map.tap();
    await expect(page.getByTestId('v2-graph-minimap')).toHaveCount(0);

    // Pinch: two touch pointers spreading from 100 px to 200 px apart double the zoom.
    await canvas.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const y = box.top + 60;
      const fire = (type: string, id: number, x: number): boolean => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
      fire('pointerdown', 1, box.left + 100);
      fire('pointerdown', 2, box.left + 200);
      fire('pointermove', 2, box.left + 250);
      fire('pointermove', 1, box.left + 50);
      fire('pointerup', 2, box.left + 250);
      fire('pointerup', 1, box.left + 50);
    });
    await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeCloseTo(1.1, 2);

    // A double tap on empty canvas zooms in ×1.6 (here: from 1.1 to 1.76); at 1.4 and more it fits.
    await canvas.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const fire = (type: string): boolean => el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: box.left + 20, clientY: box.top + 20, bubbles: true, cancelable: true, button: 0 }));
      fire('pointerdown');
      fire('pointerup');
      fire('pointerdown');
      fire('pointerup');
    });
    await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeCloseTo(1.76, 2);
    await page.getByTestId('v2-graph-fit').tap();
    await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeLessThan(0.55);

    // A tap on a step = a click (the failed step opens its details).
    await node(page, 'ACME-5').tap();
    await expect(page.getByTestId('v2-step-sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('v2-step-sheet')).toHaveCount(0);

    // A long press opens the step menu.
    await node(page, 'ACME-5').evaluate(async (el) => {
      const box = el.getBoundingClientRect();
      const init = { pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, bubbles: true, cancelable: true, button: 0 };
      el.dispatchEvent(new PointerEvent('pointerdown', init));
      await new Promise((resolve) => setTimeout(resolve, 750));
      el.dispatchEvent(new PointerEvent('pointerup', init));
    });
    await expect(page.getByRole('menuitem', { name: 'Restart' })).toBeVisible();
    await page.screenshot({ path: 'test-results/v2-project-graph-390-menu.png' });
  } finally {
    await context.close();
  }
});
