import { type Page, expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · lane H: the v2 Needs-you page on the real path (fake-claude). The empty
 * "all clear" page; items of several kinds arriving live (a question, a batch of
 * two, a permission request); the kind filter chips with their counts and the
 * "nothing of this kind" state; the rail's and top bar's counts matching the page;
 * Undo; the keys (↑ / ↓ between cards, 1–9 to answer, Enter to send a batch).
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-needs-page', { env: { ...V2_SERVER_ENV } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function inboxOf(page: Page, sessionId: string): Promise<number> {
  const items = await page.evaluate(async () => (await (await fetch('/api/inbox')).json()) as Array<{ sessionId: string | null }>);
  return items.filter((item) => item.sessionId === sessionId).length;
}

const focusedKey = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute('data-key') ?? null);

test('all clear, then every kind live: filters, counts, Undo and the keys', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/needs-you`);
  await expect(page.getByTestId('v2-needs-empty')).toContainText('All clear');
  await expect(page.getByTestId('v2-needs-filters')).toHaveCount(0);

  const asker = await world.startSession(page, 'asker', '[fake:ask-delay] Ask me which environment.');
  const batcher = await world.startSession(page, 'batcher', '[fake:ask-2q] Ask me two questions.');
  const runner = await world.startSession(page, 'runner', '[fake:perm-allow] Run the command.');
  const cards = page.getByTestId('v2-needs-list').getByTestId('v2-answer-card');
  await expect(cards).toHaveCount(3);

  // The counts: every chip, the rail's Home badge and the top bar's, all the same as the page.
  const chip = (filter: string) => page.getByTestId(`v2-needs-filter-${filter}`);
  await expect(chip('all')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip('all').locator('.v2-fchip-n')).toHaveText('3');
  await expect(chip('question').locator('.v2-fchip-n')).toHaveText('2');
  await expect(chip('approval').locator('.v2-fchip-n')).toHaveText('1');
  await expect(chip('ready').locator('.v2-fchip-n')).toHaveText('0');
  await expect(page.getByTestId('v2-nav-badge-home')).toHaveText('3');
  await expect(page.getByTestId('v2-nav-badge-agents')).toHaveText('3');
  await expect(page.getByTestId('v2-needs-button').locator('.v2-dot-badge')).toHaveText('3');

  // Each card says who asks and links to its agent.
  const approval = cards.and(page.locator('[data-kind="approval"]'));
  await expect(approval.locator('.v2-qi-src')).toHaveText('runner');
  await expect(approval.getByTestId('v2-answer-open-agent')).toHaveText('Open agent');

  // Filter: Approvals only; Ready for approval is empty ("Nothing of this kind" → Show all).
  await chip('approval').click();
  await expect(chip('approval')).toHaveAttribute('aria-pressed', 'true');
  await expect(cards).toHaveCount(1);
  await expect(cards).toHaveAttribute('data-kind', 'approval');
  await chip('question').click();
  await expect(cards).toHaveCount(2);
  await chip('ready').click();
  await expect(cards).toHaveCount(0);
  await expect(page.getByTestId('v2-needs-filter-empty')).toContainText('Nothing of this kind');
  await page.getByTestId('v2-needs-filter-empty').getByRole('button', { name: 'Show all' }).click();
  await expect(chip('all')).toHaveAttribute('aria-pressed', 'true');
  await expect(cards).toHaveCount(3);

  // Undo: Allow once hides it everywhere; Undo brings it back before anything is sent.
  await approval.getByRole('button', { name: /Allow once/ }).click();
  await expect(cards).toHaveCount(2);
  await expect(page.getByTestId('v2-nav-badge-home')).toHaveText('2');
  await expect(chip('approval').locator('.v2-fchip-n')).toHaveText('0');
  await expect(page.getByTestId('v2-toast')).toContainText('You allowed it once · sent to runner');
  await page.getByTestId('v2-toast-undo').click();
  await expect(cards).toHaveCount(3);
  await expect(page.getByTestId('v2-nav-badge-home')).toHaveText('3');
  expect(await inboxOf(page, runner.id)).toBe(1);

  // Keys: ↓ / ↑ move between the cards (wrapping).
  const keys = await cards.evaluateAll((els) => els.map((el) => el.getAttribute('data-key')));
  await cards.first().focus();
  await page.keyboard.press('ArrowDown');
  expect(await focusedKey(page)).toBe(keys[1]);
  await page.keyboard.press('ArrowDown');
  expect(await focusedKey(page)).toBe(keys[2]);
  await page.keyboard.press('ArrowDown');
  expect(await focusedKey(page)).toBe(keys[0]);
  await page.keyboard.press('ArrowUp');
  expect(await focusedKey(page)).toBe(keys[2]);

  // 1–9: the single question, answered with 2 (Production); the focus moves on to the next card.
  const question = page.locator('[data-testid="v2-answer-card"][data-kind="question"]').filter({ has: page.locator('.v2-qi-src', { hasText: /^asker$/ }) });
  await question.focus();
  await page.keyboard.press('2');
  await expect(question).toHaveCount(0);
  await expect(cards).toHaveCount(2);
  expect(await focusedKey(page)).not.toBeNull();

  // Enter sends a batch once every question has an answer.
  const batch = page.locator('[data-testid="v2-answer-card"]').filter({ has: page.locator('.v2-qi-src', { hasText: /^batcher$/ }) });
  for (const block of await batch.locator('.v2-qi-q').all()) await block.locator('.v2-opt').first().click();
  await expect(batch.getByTestId('v2-answer-send')).toBeEnabled();
  await batch.focus();
  await page.keyboard.press('Enter');
  await expect(batch).toHaveCount(0);
  await expect(cards).toHaveCount(1);

  // Both reach their agents after the Undo window; the page and the counts stay in step.
  await expect.poll(async () => (await inboxOf(page, asker.id)) + (await inboxOf(page, batcher.id)), { timeout: 20_000 }).toBe(0);
  await expect(page.getByTestId('v2-nav-badge-home')).toHaveText('1');
  await expect(page.getByTestId('v2-needs-button').locator('.v2-dot-badge')).toHaveText('1');

  // The last one: Allow once for real; all clear.
  await approval.getByRole('button', { name: /Allow once/ }).click();
  await expect(page.getByTestId('v2-needs-empty')).toBeVisible();
  await expect(page.getByTestId('v2-nav-badge-home')).toHaveCount(0);
  await expect.poll(async () => inboxOf(page, runner.id), { timeout: 20_000 }).toBe(0);
});
