import { type Locator, type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fixes after 2.0 · **Continue with a clean slate in v2** (D83, `docs/fresh-session.md`
 * → *v2*) on the real path: fake claude's `[fake:usage 170000]` fills the working
 * memory to 85 %, and `[fake:background 600 npm run dev]` leaves a dev server running
 * after the turn ends (the agent is idle, its live activity stays `background`: that
 * kept the button disabled before the fix). The side panel's button starts the
 * handover, opens the fresh agent ("Continued from …") and the old one is archived.
 * While a turn runs it is disabled and says why. The agent ⋯ menu has the same
 * action. A phone (390 × 844) reaches it in the Details sheet.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-clean-slate', { env: { ...V2_SERVER_ENV } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as SessionDetail, id);
}

async function send(page: Page, id: string, text: string): Promise<void> {
  const status = await page.evaluate(
    async ([sessionId, body]) => (await fetch(`/api/sessions/${encodeURIComponent(sessionId as string)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: body }) })).status,
    [id, text] as const,
  );
  expect(status).toBeLessThan(300);
}

/** Starts an agent and waits until its turn is over (`done`). */
async function idleAgent(page: Page, name: string, task: string): Promise<string> {
  const { id } = await world.startSession(page, name, task);
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('done');
  return id;
}

/** After the continuation: the tab is on the fresh agent, which links back; the old one is archived and links forward. */
async function expectContinued(page: Page, id: string, title: string): Promise<string> {
  await expect.poll(async () => decodeURIComponent(new URL(page.url()).pathname), { timeout: 30_000 }).not.toBe(`/agents/${id}`);
  const path = decodeURIComponent(new URL(page.url()).pathname);
  expect(path).toMatch(/^\/agents\/[^/]+$/);
  const freshId = path.split('/')[2] ?? '';
  const old = await detail(page, id);
  expect(old.closedAt).not.toBeNull();
  expect(old.continuedTo).toEqual({ sessionId: freshId, title: `${title} (2)` });
  expect((await detail(page, freshId)).continuedFrom).toEqual({ sessionId: id, title });
  await expect(page.getByTestId('v2-agent-view')).toHaveAttribute('data-session-id', freshId);
  await expect(page.getByTestId('v2-agent-divider').filter({ hasText: `Continued from ${title}` })).toBeVisible({ timeout: 15_000 });
  return freshId;
}

function cleanSlate(scope: Locator): { button: Locator; why: Locator } {
  return { button: scope.getByTestId('v2-agent-side-clean-slate'), why: scope.getByTestId('v2-agent-side-clean-slate-why') };
}

test('the side panel: idle with a dev server left running → Continue with a clean slate hands over, opens the fresh agent, archives the old one', async ({ page }) => {
  test.setTimeout(120_000);
  await openWithHub(page, `${world.baseUrl}/`);
  const id = await idleAgent(page, 'slate', 'Fill it. [fake:usage 170000] [fake:background 600 npm run dev]');
  // The regression: idle (done), but its live activity is `background` (the dev server).
  expect((await detail(page, id)).activity?.state).toBe('background');

  await openWithHub(page, `${world.baseUrl}/agents/${encodeURIComponent(id)}`);
  const side = page.getByTestId('v2-agent-side');
  await expect(side.getByTestId('v2-agent-group-mem').locator('summary')).toContainText('85% used');
  const { button, why } = cleanSlate(side);
  await expect(button).toBeEnabled();
  await expect(why).toHaveCount(0);
  await button.click();
  await expectContinued(page, id, 'slate');
});

test('disabled with the reason while a turn runs; the ⋯ menu continues once it ends', async ({ page }) => {
  test.setTimeout(120_000);
  await openWithHub(page, `${world.baseUrl}/`);
  const id = await idleAgent(page, 'busy-slate', 'Fill it. [fake:usage 170000]');
  await openWithHub(page, `${world.baseUrl}/agents/${encodeURIComponent(id)}`);
  const side = page.getByTestId('v2-agent-side');
  const { button, why } = cleanSlate(side);
  await expect(button).toBeEnabled();

  // A held turn: the button waits for its end and says why, in words.
  await send(page, id, 'Think for a while. [fake:hold 8]');
  await expect(button).toBeDisabled();
  await expect(why).toBeVisible();
  await expect(why).toHaveText('Available when the agent isn’t replying.');
  await page.getByTestId('v2-agent-menu').click();
  const entry = page.getByTestId('v2-agent-menu-list').getByRole('menuitem', { name: /Continue with a clean slate/ });
  await expect(entry).toBeDisabled();
  await expect(page.getByTestId('v2-agent-menu-list').locator('[data-item="clean-slate"] + .v2-menu-why')).toHaveText('Available when the agent isn’t replying.');
  await page.keyboard.press('Escape');

  // The turn ends: enabled again; the ⋯ menu's entry continues.
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await expect(why).toHaveCount(0);
  await page.getByTestId('v2-agent-menu').click();
  await expect(entry).toBeEnabled();
  await entry.click();
  await expectContinued(page, id, 'busy-slate');
});

test('phone (390 × 844): Details → Continue with a clean slate opens the fresh agent', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${world.baseUrl}/`);
  const id = await idleAgent(page, 'phone-slate', 'Fill it. [fake:usage 170000]');
  await openWithHub(page, `${world.baseUrl}/agents/${encodeURIComponent(id)}`);
  await page.getByTestId('v2-agent-menu').click();
  await page.getByTestId('v2-agent-menu-list').getByRole('menuitem', { name: 'Details' }).click();
  const sheet = page.getByTestId('v2-agent-side-sheet');
  await expect(sheet).toBeVisible();
  const { button } = cleanSlate(sheet);
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeEnabled();
  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 390).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await button.click();
  await expectContinued(page, id, 'phone-slate');
});
