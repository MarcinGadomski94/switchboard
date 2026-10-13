import { mkdir } from 'node:fs/promises';
import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D96 oracle, real path (no demo seed): `node src/server/main.ts` with fake-claude
 * as the CLI. On the newest models the agent's message before a question arrives
 * as a progress note (a non-empty `thinking` block; `[fake:note]` writes that
 * shape: empty thinking, the note, AskUserQuestion, one message). The chat shows it
 * as an agent message directly above the question card, and the Inbox question
 * item shows it as the question's context.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('progress-notes');
});

test.afterAll(async () => {
  await world?.stop();
});

const NOTE = "I've reviewed the campaign setup, the tag workspace and the form tracking (all read-only checks).\n\nTwo decisions are yours:";
const TASK = `[fake:ask-2q] [fake:note ${JSON.stringify(NOTE)}] Ask me about the button.`;
/** Where the screenshots go for the developer's look (`/tmp/d96-shots/`). */
const SHOTS = process.env['D96_SHOTS'] ?? '';

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return (await response.json()) as SessionDetail;
  }, id);
}

test('the progress note shows as an agent message right above the question card, and as the Inbox question context', async ({ page }) => {
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'notes-e2e', TASK);
  await expect.poll(async () => (await detail(page, id)).status).toBe('need');

  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const chat = page.getByTestId('session-chat');
  const card = chat.getByTestId('question-card');
  await expect(card).toBeVisible();
  const note = chat.locator('[data-testid="chat-message"][data-role="agent"][data-note="true"]');
  await expect(note).toHaveCount(1);
  // Markdown like any agent text: two paragraphs.
  await expect(note.getByTestId('chat-text').locator('p')).toHaveText([
    "I've reviewed the campaign setup, the tag workspace and the form tracking (all read-only checks).",
    'Two decisions are yours:',
  ]);
  // Directly above the card: the card is the note's next sibling in the chat.
  expect(await note.evaluate((el) => el.nextElementSibling?.getAttribute('data-testid') ?? el.nextElementSibling?.className ?? null)).toBe('question-card');
  // Like other agent text it can be saved as an artifact (D89 ⋯ menu).
  await expect(note.getByTestId('chat-message-menu')).toHaveCount(1);
  if (SHOTS) await chat.screenshot({ path: `${SHOTS}/chat-note-above-question.png` });

  await page.goto(`${world.baseUrl}/inbox`);
  await expect(page.getByTestId('inbox-item')).toHaveCount(1);
  const context = page.getByTestId('inbox-text');
  await expect(context).toHaveText(NOTE);
  await expect(context).toHaveClass(/sb-inbox__text--context/);
  await expect(context).toHaveCSS('white-space', 'pre-wrap');
  await expect(page.getByTestId('question-card')).toBeVisible();
  if (SHOTS) await page.getByTestId('inbox-detail').screenshot({ path: `${SHOTS}/inbox-question-context.png` });
});

test('D96-q1: a permission request shows the agent\'s message right above its call as context, above the description', async ({ page }) => {
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'perm-notes-e2e', `[fake:perm-allow] [fake:note ${JSON.stringify(NOTE)}] Run it.`);
  await expect.poll(async () => (await detail(page, id)).status).toBe('need');

  await page.goto(`${world.baseUrl}/inbox`);
  const card = page.getByTestId('inbox-item').filter({ hasText: 'perm-notes-e2e' });
  await expect(card).toHaveCount(1);
  await card.click();
  await expect(page.getByTestId('permission-request')).toBeVisible();
  const context = page.getByTestId('inbox-context');
  await expect(context).toHaveText(NOTE);
  await expect(context).toHaveCSS('white-space', 'pre-wrap');
  // Order in the detail: the context, then the model's description (D6), then the request.
  const order = await page.getByTestId('inbox-detail').evaluate((root) =>
    [...root.querySelectorAll('[data-testid="inbox-context"], [data-testid="inbox-text"], [data-testid="permission-request"]')].map((el) => el.getAttribute('data-testid')),
  );
  expect(order[0]).toBe('inbox-context');
  expect(order.at(-1)).toBe('permission-request');
  if (SHOTS) await page.getByTestId('inbox-detail').screenshot({ path: `${SHOTS}/inbox-permission-context.png` });
});
