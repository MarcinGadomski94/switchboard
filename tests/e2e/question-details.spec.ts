import { type Locator, type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { ASK_DETAIL_DESCRIPTION } from '../../tools/fake-claude/session.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * Fix · question card details, real path (D13, no demo seed): fake-claude's
 * `[fake:ask-2q] [fake:ask-detail]` asks two questions whose first has options with
 * long descriptions and a preview (a mockup with a very long line). Both the chat's
 * inline card and the Inbox card show each description under its label, show the
 * preview of the hovered / picked option in a box of its own that scrolls instead
 * of widening the card, and keep the header chip data and the Other… pill.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('question-details');
});

test.afterAll(async () => {
  await world?.stop();
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return (await response.json()) as SessionDetail;
  }, id);
}

async function expectDetails(card: Locator): Promise<void> {
  const first = card.getByTestId('question').first();
  const options = first.getByTestId('question-option');
  await expect(options).toHaveCount(3);
  // The description is visible text under the label, not a tooltip.
  const red = options.nth(0);
  await expect(red.getByTestId('question-option-label')).toHaveText('Red');
  const description = red.getByTestId('question-option-description');
  await expect(description).toBeVisible();
  await expect(description).toHaveText(ASK_DETAIL_DESCRIPTION);
  await expect(options.nth(1).getByTestId('question-option-description')).toHaveText('A green button');
  // The description sits under the label and wraps inside the option.
  const labelBox = await red.getByTestId('question-option-label').boundingBox();
  const descriptionBox = await description.boundingBox();
  const optionBox = await red.boundingBox();
  expect(descriptionBox!.y).toBeGreaterThanOrEqual(labelBox!.y + labelBox!.height - 1);
  expect(descriptionBox!.x + descriptionBox!.width).toBeLessThanOrEqual(optionBox!.x + optionBox!.width + 1);
  // The second question (no previews) keeps its descriptions too, and the Other… pill stays.
  await expect(card.getByTestId('question').nth(1).getByTestId('question-option-description')).toHaveCount(2);
  await expect(card.getByTestId('question-other')).toHaveCount(2);

  // Nothing is previewed until an option is hovered or picked; then that option's preview shows.
  const preview = first.getByTestId('question-option-preview');
  await expect(preview).toHaveCount(0);
  await options.nth(1).hover();
  await expect(preview).toHaveText('Second option mockup');
  await red.hover();
  await expect(preview).toContainText('[ Buy now ]');
  await expect(preview).toContainText('_END');
  // It is a monospace block with its own scroll: the long line never widens the card.
  expect(await preview.evaluate((element) => getComputedStyle(element).fontFamily.toLowerCase())).toMatch(/mono/);
  expect(await preview.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const cardBox = await card.boundingBox();
  const previewBox = await preview.boundingBox();
  expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);

  // Picking keeps showing the picked option's preview (keyboard focus moves it too).
  await red.click();
  await expect(red).toHaveAttribute('data-selected', 'true');
  await expect(preview).toContainText('[ Buy now ]');
  await options.nth(2).focus();
  await expect(preview).toHaveCount(0);
}

test('chat card: every option shows its description; the hovered / picked option shows its preview', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'details-chat', '[fake:ask-2q] [fake:ask-detail] Ask me about the button.');
  await expect.poll(async () => (await detail(page, id)).status).toBe('need');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const card = page.getByTestId('session-chat').getByTestId('question-card');
  await expect(card).toHaveClass(/sb-qcard--chat/);
  await expect(card.getByTestId('question').first().locator('.sb-qcard__quote')).toHaveText('“Which color should the button be?”');
  await expectDetails(card);
});

test('Inbox card: every option shows its description; the hovered / picked option shows its preview', async ({ page }) => {
  await page.goto(`${world.baseUrl}/inbox`);
  await expect(page.getByTestId('view-inbox')).toBeVisible();
  await world.startSession(page, 'details-inbox', '[fake:ask-2q] [fake:ask-detail] Ask me about the button.');
  await expect(page.getByTestId('inbox-item')).toHaveCount(1);
  const card = page.getByTestId('question-card');
  await expect(card).toHaveClass(/sb-qcard--inbox/);
  await expectDetails(card);
});
