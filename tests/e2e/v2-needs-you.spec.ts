import { expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · the shared answer card in the v2 Needs-you list (`docs/v2.md` →
 * *AnswerCard*, *Needs you*): a real session (fake-claude) asks a question; it
 * arrives live in the list and on the rail's and top bar's counts; one tap answers
 * it; it leaves every list at once, the toast offers Undo; Undo brings it back;
 * answered again, the answer reaches the agent after the Undo window.
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-needs', { env: { ...V2_SERVER_ENV } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

interface InboxWire {
  readonly id: string;
  readonly kind: string;
  readonly questions?: ReadonlyArray<{ readonly state: string; readonly answerIndex: number | null }>;
}

test('a question answered from the v2 Needs-you list (with Undo), live on every count', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/needs-you`);
  await expect(page.getByTestId('v2-needs-empty')).toBeVisible();
  await expect(page.getByTestId('v2-needs-empty')).toContainText('All clear');

  const session = await world.startSession(page, 'asker', '[fake:ask-delay] Ask me which environment.');
  const card = page.getByTestId('v2-answer-card');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-kind', 'question');
  await expect(card.locator('.v2-qi-title')).toHaveText('Which environment should I target?');
  await expect(card.locator('.v2-qi-src')).toHaveText('asker');
  await expect(card.locator('.v2-opt')).toHaveText(['1Staging', '2Production', '3Other…']);
  // The counts: the rail's Home and Agents, the top bar's Needs you.
  await expect(page.getByTestId('v2-nav-badge-home')).toHaveText('1');
  await expect(page.getByTestId('v2-nav-badge-agents')).toHaveText('1');
  await expect(page.getByTestId('v2-needs-button').locator('.v2-dot-badge')).toHaveText('1');

  // Answer with the number key (focus on the card, 2 = Production), then Undo.
  await card.focus();
  await page.keyboard.press('2');
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('v2-needs-empty')).toBeVisible();
  await expect(page.getByTestId('v2-nav-badge-home')).toHaveCount(0);
  const toast = page.getByTestId('v2-toast');
  await expect(toast).toContainText('You answered “Production” · sent to asker');
  await page.getByTestId('v2-toast-undo').click();
  await expect(card).toHaveCount(1);
  await expect(page.getByTestId('v2-nav-badge-home')).toHaveText('1');

  // Answer for real: a tap on Staging; nothing is sent during the Undo window, then the agent gets it.
  await card.locator('.v2-opt', { hasText: 'Staging' }).click();
  await expect(card).toHaveCount(0);
  const inbox = async (): Promise<readonly InboxWire[]> => page.evaluate(async () => (await (await fetch('/api/inbox')).json()) as InboxWire[]);
  expect((await inbox()).length).toBe(1);
  await expect.poll(async () => (await inbox()).length, { timeout: 15_000 }).toBe(0);
  const events = await page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}/events`)).json()) as Array<{ kind: string; text?: string; payload?: unknown }>, session.id);
  expect(JSON.stringify(events)).toContain('Staging');
  // It stays answered (the list reads the server again): all clear, no count.
  await expect(page.getByTestId('v2-needs-empty')).toBeVisible();
  await expect(page.getByTestId('v2-nav-badge-home')).toHaveCount(0);
});

test('phone (390 × 844): the Needs-you tab shows the count and the card answers with a tap', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${world.baseUrl}/`);
  await world.startSession(page, 'phone-asker', '[fake:ask-delay] Ask me which environment.');
  await expect(page.getByTestId('v2-tab-needs').locator('.v2-dot-badge')).toHaveText('1');
  await page.getByTestId('v2-tab-needs').click();
  const card = page.getByTestId('v2-answer-card');
  await expect(card).toHaveCount(1);
  // No number keys on a phone; every answer at least 44 px high.
  await expect(card.locator('.v2-num')).toHaveCount(0);
  for (const height of await card.locator('.v2-opt').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(height).toBeGreaterThanOrEqual(44);
  await card.locator('.v2-opt', { hasText: 'Production' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('v2-tab-needs').locator('.v2-dot-badge')).toHaveCount(0);
});
