import { expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · lane R · the v2 ⌘K palette on the real code path: jump to a page and to
 * an agent, the `task …` quick capture (into the agent on screen), New … actions,
 * the empty state, and the phone.
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-palette', { env: { ...V2_SERVER_ENV } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

test('⌘K jumps to a page, a Settings page and an agent', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  const agent = await world.startSession(page, 'checkout-redesign', 'Hello');
  const palette = page.getByTestId('v2-palette');

  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette).toBeVisible();
  // Opened empty: recent agents and the actions, grouped.
  await expect(palette.locator('.v2-cmdk-group').first()).toBeVisible();
  await expect(palette.locator('[data-command="action:new:agent"]')).toBeVisible();
  await page.keyboard.type('insights');
  await expect(palette.locator('.v2-cmd').first()).toHaveAttribute('data-command', 'page:insights');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(`${world.baseUrl}/insights`);

  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('phones');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${world.baseUrl}/settings/phones`);

  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('checkout red');
  const row = palette.locator(`[data-command="agent:${agent.id}"]`);
  await expect(row).toBeVisible();
  await expect(palette.locator('.v2-cmd').first()).toHaveAttribute('data-command', `agent:${agent.id}`);
  // The last row searches everything.
  await expect(palette.locator('.v2-cmd').last()).toHaveText(/Search everything for “checkout red”/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${world.baseUrl}/agents/${agent.id}`);

  // ↓ then ↩ picks the next row; the search row goes to /search?q=.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('zzqx');
  await expect(palette.locator('.v2-cmd')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${world.baseUrl}/search?q=zzqx`);
});

test('⌘K: "task …" adds a task to the agent on screen', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  const agent = await world.startSession(page, 'tasks-owner', 'Hello');
  await page.goto(`${world.baseUrl}/agents/${agent.id}`);
  await expect(page.getByTestId('v2-agent-view')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('v2-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type('task Remember the last payment method');
  const quick = palette.locator('[data-command="quick-task"]');
  await expect(quick).toContainText('Add task: Remember the last payment method');
  await expect(quick).toContainText('tasks-owner');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId('v2-toast')).toContainText('Task added to tasks-owner');
  const todos = await page.evaluate(async (sid) => (await (await fetch(`/api/sessions/${sid}/todos`)).json()) as { todos: Array<{ title: string }> }, agent.id);
  expect(todos.todos.map((item) => item.title)).toContain('Remember the last payment method');
});

test('⌘K: New … opens the + New sheet on that kind', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('new routine');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('v2-palette')).toHaveCount(0);
  await expect(page.getByTestId('v2-new-sheet')).toBeVisible();
  await expect(page.getByTestId('v2-new-kind-routine')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
});

test('phone (390 × 844, a keyboard attached): ⌘K opens the palette, rows are touch-sized and navigate', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${world.baseUrl}/`);
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('v2-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type('crews');
  const first = palette.locator('.v2-cmd').first();
  expect((await first.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await first.click();
  await expect(page).toHaveURL(`${world.baseUrl}/crews`);
});

test('phone (390 × 844, touch only): the top bar\'s ⌘K button opens the palette (lane X)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${world.baseUrl}/`);
  const open = page.getByTestId('v2-topbar').getByTestId('v2-palette-open');
  await expect(open).toBeVisible();
  const box = await open.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  // The whole top bar fits the phone's width.
  const bar = await page.getByTestId('v2-topbar').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(bar.scroll).toBeLessThanOrEqual(bar.client);
  await open.click();
  const palette = page.getByTestId('v2-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type('crews');
  await palette.locator('.v2-cmd').first().click();
  await expect(page).toHaveURL(`${world.baseUrl}/crews`);
});

test('⌘K replays the v2 welcome tour directly: "Replay tour: what’s new in Switchboard 2" (lane X)', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  const palette = page.getByTestId('v2-palette');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette).toBeVisible();
  await page.keyboard.type('replay tour');
  const first = palette.locator('.v2-cmd').first();
  await expect(first).toHaveAttribute('data-command', 'action:replay-tour:welcome-v2');
  await expect(first).toContainText('Replay tour: what’s new in Switchboard 2');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId('v2-tour')).toHaveAttribute('data-tour-id', 'welcome-v2');
  await expect(page.getByTestId('v2-tour-card')).toBeVisible();
});
