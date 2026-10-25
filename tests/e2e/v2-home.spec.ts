import { type Page, expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · lane H: v2 Home on the real path (fake-claude, no demo seed). An empty
 * Home first (greeting, all clear, nothing running, nothing done); then agents in
 * several states (one working, one asking a question, one done) land live in
 * Working now, Needs you and Done today; a question answered on Home leaves the
 * Needs-you page and every count; an agent started from the start box shows a
 * skeleton, then its live card; More options opens + New with the text; the
 * phone layout (390 × 844).
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-home', { env: { ...V2_SERVER_ENV } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

interface SessionWire {
  readonly id: string;
  readonly status: string;
  readonly title?: string | null;
  readonly model?: { readonly current: string | null } | null;
}

async function sessions(page: Page): Promise<readonly SessionWire[]> {
  return page.evaluate(async () => (await (await fetch('/api/sessions')).json()) as SessionWire[]);
}

test('an empty Home: the greeting, all clear, nothing running, nothing done', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  await expect(page.getByTestId('v2-page-home')).toBeVisible();
  await expect(page.getByTestId('v2-home-greeting')).toHaveText(/^Good (morning|afternoon|evening)$/);
  await expect(page.getByTestId('v2-home-summary')).toHaveText('Nothing needs you');
  await expect(page.getByTestId('v2-home-work-summary')).toHaveText('0 working · 0 done today');
  await expect(page.getByTestId('v2-home-needs-empty')).toContainText('All clear');
  await expect(page.getByTestId('v2-working-empty')).toHaveText('Nothing running. Start an agent above.');
  await expect(page.getByTestId('v2-done-empty')).toHaveText('Nothing finished yet today.');
  // The start box: the saved folder (the last used, else the default), this computer, Smart.
  await expect(page.getByTestId('v2-start-folder')).toHaveValue(/.+/);
  await expect(page.getByTestId('v2-start-folder').locator('option:checked')).toHaveText('work space');
  await expect(page.getByTestId('v2-start-speed').locator('[aria-pressed="true"]')).toHaveText('Smart');
  await expect(page.getByTestId('v2-start-go')).toBeDisabled();
});

test('working, asking and done agents land live; a question answered on Home leaves the Needs-you page and the counts', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  const worker = await world.startSession(page, 'worker', '[fake:hold 300] Work on the checkout for a while.');
  const asker = await world.startSession(page, 'asker', '[fake:ask-delay] Ask me which environment.');
  const finisher = await world.startSession(page, 'finisher', 'Say hi.');

  // Working now: the worker's live card (status, activity line, Open).
  const workCard = page.locator(`[data-testid="v2-working-card"][data-session="${worker.id}"]`);
  await expect(workCard).toBeVisible();
  await expect(workCard.getByTestId('v2-activity')).toBeVisible();
  await expect(workCard).toContainText('Working');

  // Needs you: the asker's question as a full answer card (top 3), with the counts.
  const card = page.getByTestId('v2-home-needs').getByTestId('v2-answer-card');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.v2-qi-title')).toHaveText('Which environment should I target?');
  await expect(page.getByTestId('v2-home-summary')).toHaveText('1 thing needs you');
  await expect(page.getByTestId('v2-home-needs-count')).toHaveText('1');
  await expect(page.getByTestId('v2-nav-badge-home')).toHaveText('1');

  // Done today: the finisher.
  await expect.poll(async () => (await sessions(page)).find((s) => s.id === finisher.id)?.status, { timeout: 15_000 }).toBe('done');
  const doneRow = page.locator(`[data-testid="v2-done-row"][data-session="${finisher.id}"]`);
  await expect(doneRow).toBeVisible();
  await expect(doneRow).toContainText('finisher');
  await expect(doneRow).toContainText('Done just now');
  await expect(page.getByTestId('v2-home-done-count')).toHaveText('1');
  // A Done-today agent row peeks too (lane X); Escape closes the sheet.
  await doneRow.click();
  await expect(page.getByTestId('v2-agent-peek')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('v2-agent-peek')).toBeHidden();

  // Answer on Home: the card leaves; the toast offers Undo; the Needs-you page is clear and every count is gone.
  await card.locator('.v2-opt', { hasText: 'Staging' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('v2-home-needs-empty')).toBeVisible();
  await expect(page.getByTestId('v2-toast')).toContainText('You answered “Staging” · sent to asker');
  await expect(page.getByTestId('v2-nav-badge-home')).toHaveCount(0);
  await page.getByTestId('v2-home-see-all').click();
  await expect(page).toHaveURL(/\/needs-you$/);
  await expect(page.getByTestId('v2-needs-empty')).toBeVisible();
  await expect(page.getByTestId('v2-needs-list').getByTestId('v2-answer-card')).toHaveCount(0);
  await expect(page.getByTestId('v2-needs-button').locator('.v2-dot-badge')).toHaveCount(0);
  // After the Undo window the answer reaches the agent: its question leaves the server's Inbox.
  await expect
    .poll(async () => (await page.evaluate(async () => (await (await fetch('/api/inbox')).json()) as Array<{ sessionId: string | null }>)).filter((i) => i.sessionId === asker.id).length, { timeout: 15_000 })
    .toBe(0);

  // A click on a working card peeks at the agent (lane X: the peek sheet, Home stays); Open full view opens it.
  await page.getByTestId('v2-nav-home').click();
  await workCard.click();
  const peek = page.getByTestId('v2-agent-peek');
  await expect(peek).toBeVisible();
  await expect(page).toHaveURL(`${world.baseUrl}/`);
  await peek.getByTestId('v2-agent-peek-full').click();
  await expect(page).toHaveURL(new RegExp(`/agents/${worker.id}$`));
});

test('the start box: Enter starts an agent (skeleton, then its live card); More options opens + New with the text', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  const box = page.getByTestId('v2-start-text');
  await page.getByTestId('v2-start-speed').getByRole('button', { name: 'Fast' }).click();
  await box.fill('[fake:hold 300] Fix the login timeout on the checkout page');
  // The start answers a moment later: the skeleton card shows meanwhile.
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  const posted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions');
  await box.press('Enter');
  await expect(page.getByTestId('v2-working-pending')).toContainText('Fix the login timeout on the checkout page');
  const body = (await posted).postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({ simple: true, task: '[fake:hold 300] Fix the login timeout on the checkout page', worktrees: false, model: 'sonnet' });
  expect(typeof body['folder']).toBe('string');
  // The box empties; the toast says where it started; its live card appears in Working now.
  await expect(box).toHaveValue('');
  await expect(page.getByTestId('v2-toast')).toContainText('Agent started in work space');
  await expect.poll(async () => (await sessions(page)).filter((s) => s.title?.includes('Fix the login timeout')).length).toBe(1);
  const started = (await sessions(page)).find((s) => s.title?.includes('Fix the login timeout'));
  await expect(page.locator(`[data-testid="v2-working-card"][data-session="${started?.id}"]`)).toBeVisible();
  await expect(page.getByTestId('v2-working-pending')).toHaveCount(0);
  // Fast is remembered for the next start.
  await page.reload();
  await expect(page.getByTestId('v2-start-speed').locator('[aria-pressed="true"]')).toHaveText('Fast');

  // Shift+Enter is a new line; More options opens + New with the text.
  await box.fill('First line');
  await box.press('Shift+Enter');
  await box.pressSequentially('second line');
  await expect(box).toHaveValue('First line\nsecond line');
  await page.getByTestId('v2-start-more').click();
  await expect(page.getByTestId('v2-new-sheet')).toBeVisible();
});

test('phone (390 × 844): Home in one column and the Needs-you tab, with the same count', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${world.baseUrl}/`);
  await world.startSession(page, 'phone-worker', '[fake:hold 300] Work on the phone for a while.');
  await world.startSession(page, 'phone-asker', '[fake:ask-delay] Ask me which environment.');
  await expect(page.getByTestId('v2-page-home')).toHaveAttribute('data-phone', '');
  await expect(page.getByTestId('v2-home-summary')).toHaveText('1 thing needs you');
  // The one-line start box with its 44 px button; the working agents as rows.
  const go = page.getByTestId('v2-start-go');
  expect((await go.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId('v2-working').getByTestId('v2-agent-row').first()).toBeVisible();
  const card = page.getByTestId('v2-home-needs').getByTestId('v2-answer-card');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.v2-num')).toHaveCount(0);
  // Nothing wider than the screen.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await expect(page.getByTestId('v2-tab-needs').locator('.v2-dot-badge')).toHaveText('1');
  await page.getByTestId('v2-tab-needs').click();
  await expect(page.getByTestId('v2-page-needs-you')).toContainText('Every ask, answerable right here.');
  const needsCard = page.getByTestId('v2-needs-list').getByTestId('v2-answer-card');
  await expect(needsCard).toHaveCount(1);
  for (const height of await page.getByTestId('v2-needs-filters').locator('.v2-fchip').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(height).toBeGreaterThanOrEqual(44);
  await needsCard.locator('.v2-opt', { hasText: 'Production' }).click();
  await expect(needsCard).toHaveCount(0);
  await expect(page.getByTestId('v2-needs-empty')).toBeVisible();
  await expect(page.getByTestId('v2-tab-needs').locator('.v2-dot-badge')).toHaveCount(0);
  // On a phone a working agent opens its page (the prototype's phone chat), not the peek sheet.
  await page.getByTestId('v2-tab-home').click();
  await page.getByTestId('v2-working').getByTestId('v2-agent-row').first().click();
  await expect(page).toHaveURL(/\/agents\/[^/]+$/);
  await expect(page.getByTestId('v2-agent-peek')).toHaveCount(0);
});
