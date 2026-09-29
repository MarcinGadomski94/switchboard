import { type Locator, type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { QUEUED_TOOLTIPS } from '../../src/web/views/session/chat.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D44 oracle, real path (D13, no demo seed): `node src/server/main.ts` with
 * fake-claude as the CLI. The developer's own messages show a clock while the
 * agent has not taken them up, live over `/hub`:
 * - a message sent while a turn runs (`[fake:hold]`: it thinks without a tool
 *   call): the clock with "Queued: the agent reads it after its current turn";
 *   when the turn ends, the next turn starts on the message and the clock goes;
 * - the same while a question holds the turn (`ask-2q`): answering makes a tool
 *   boundary where the running turn takes the message (the CLI's mid-turn
 *   absorption): the clock goes, and the session ends `done`;
 * - a message sent to a paused session: it resumes the session and waits for the
 *   new process, which takes a moment to start (`FAKE_CLAUDE_STARTUP_MS` stands
 *   for the CLI's hooks and MCP servers): the clock with "Queued: sent when the
 *   session resumes", gone once the process takes the message up;
 * - answers to a question the pause left stale wait in the outbox: the answers
 *   bubble shows the clock with the resume tooltip; Resume sends them and it goes.
 * The clock is checked on its own (no prototype frame, like D18's Name row): 12 px,
 * the SPEC's muted `#76756f`, beside the bubble's bottom left and outside it, and
 * the bubble keeps its size and place when it goes.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('queued-messages', { env: { FAKE_CLAUDE_STARTUP_MS: '2500' } });
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

/** The user bubble (its message box) with this text. */
function userMessage(page: Page, text: string): Locator {
  return page.getByTestId('session-chat').locator('[data-testid="chat-message"][data-role="user"]').filter({ hasText: text });
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function rect(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('no box');
  return box;
}

/**
 * The clock on its own: 12×12, the muted `#76756f`, outside the bubble at its
 * left, its bottom inside the bubble's height; it adds no text to the message.
 */
async function expectClockBeside(clock: Locator, bubble: Locator, text: string): Promise<void> {
  await expect(clock).toBeVisible();
  await expect(clock).toHaveCSS('color', 'rgb(118, 117, 111)');
  await expect(clock).toHaveCSS('position', 'absolute');
  const c = await rect(clock);
  const b = await rect(bubble);
  expect(c.width).toBe(12);
  expect(c.height).toBe(12);
  expect(c.x + c.width).toBeLessThanOrEqual(b.x - 4);
  expect(c.x + c.width).toBeGreaterThanOrEqual(b.x - 10);
  expect(c.y).toBeGreaterThanOrEqual(b.y);
  expect(c.y + c.height).toBeLessThanOrEqual(b.y + b.height);
  await expect(bubble).toHaveText(text);
}

function expectSameBox(a: Rect, b: Rect): void {
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(a[key] - b[key])).toBeLessThanOrEqual(0.5);
}

test('a message sent while a turn runs shows the clock ("after its current turn") until the next turn starts on it', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  // The turn thinks for 8 s without calling a tool (`[fake:hold]`), so the message waits for its result.
  const { id } = await world.startSession(page, 'queued-turn', '[fake:hold 8] Think it through.');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const chat = page.getByTestId('session-chat');
  await expect(page.getByTestId('chat-activity')).toHaveAttribute('data-state', 'thinking', { timeout: 15_000 });
  // The task, sent to a fresh process, never waited.
  await expect(chat.getByTestId('chat-queued')).toHaveCount(0);

  await page.getByTestId('chat-input').fill('Keep it short.');
  await page.getByTestId('chat-input').press('Enter');
  const message = userMessage(page, 'Keep it short.');
  await expect(message).toHaveAttribute('data-queued', 'turn');
  const clock = message.getByTestId('chat-queued');
  await expect(clock).toHaveAttribute('data-reason', 'turn');
  await expect(clock).toHaveAttribute('title', QUEUED_TOOLTIPS.turn);
  await expect(clock).toHaveAttribute('title', 'Queued: the agent reads it after its current turn');
  await expect(clock).toHaveAttribute('aria-label', 'Queued: the agent reads it after its current turn');
  const bubble = message.getByTestId('chat-text');
  await expectClockBeside(clock, bubble, 'Keep it short.');
  const queuedBox = await rect(bubble);
  // Only that message waits.
  await expect(chat.getByTestId('chat-queued')).toHaveCount(1);
  expect((await detail(page, id)).status).toBe('run');

  // The turn ends ("OK"); the CLI then starts the next turn on the message: the clock goes, live.
  await expect(clock).toHaveCount(0, { timeout: 20_000 });
  await expect(message).not.toHaveAttribute('data-queued');
  // Time order: the message was written while the first turn ran, before its reply.
  await expect(chat.getByTestId('chat-text')).toHaveText(['[fake:hold 8] Think it through.', 'Keep it short.', 'OK', 'OK']);
  await expect(message).toHaveAttribute('data-delivered', 'true');
  expectSameBox(await rect(bubble), queuedBox);
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
  await expect(chat.getByTestId('chat-queued')).toHaveCount(0);
});

test('a message sent while a question holds the turn shows the clock until answering lets the turn take it (a tool boundary); the session ends done', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'queued-absorbed', '[fake:ask-2q] Ask me about the button.');
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('need');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const chat = page.getByTestId('session-chat');
  const card = chat.getByTestId('question-card');
  await expect(card).toBeVisible();

  await page.getByTestId('chat-input').fill('Keep it short.');
  await page.getByTestId('chat-input').press('Enter');
  const message = userMessage(page, 'Keep it short.');
  const clock = message.getByTestId('chat-queued');
  await expect(clock).toHaveAttribute('title', 'Queued: the agent reads it after its current turn');

  // Answering: the AskUserQuestion result is a tool boundary; the running turn takes the message there.
  await card.getByRole('button', { name: 'Green' }).click();
  await card.getByRole('button', { name: 'Small' }).click();
  await card.getByTestId('question-send').click();
  await expect(clock).toHaveCount(0, { timeout: 15_000 });
  await expect(message).toHaveAttribute('data-delivered', 'true');
  await expect(chat.getByTestId('chat-text').last()).toHaveText('You chose a green button in small size.');
  // One turn, one result: the session is done, not left running.
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
  await page.waitForTimeout(500);
  expect((await detail(page, id)).status).toBe('done');
  await expect(page.getByTestId('chat-activity')).toHaveCount(0);
});

test('a message sent to a paused session shows the clock ("when the session resumes") until the resumed process takes it up', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'queued-resume', 'Remember the code word: zeppelin.');
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('done');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const chat = page.getByTestId('session-chat');
  await expect(chat.getByTestId('chat-text')).toHaveText(['Remember the code word: zeppelin.', 'OK']);

  await page.getByTestId('session-pause').click();
  await expect.poll(async () => (await detail(page, id)).status).toBe('paused');
  await expect(page.getByTestId('session-pause')).toHaveText('Resume');

  await page.getByTestId('chat-input').fill('Are you back?');
  await page.getByTestId('chat-input').press('Enter');
  const message = userMessage(page, 'Are you back?');
  const clock = message.getByTestId('chat-queued');
  await expect(clock).toHaveAttribute('data-reason', 'resume');
  await expect(clock).toHaveAttribute('title', QUEUED_TOOLTIPS.resume);
  await expect(clock).toHaveAttribute('title', 'Queued: sent when the session resumes');
  const bubble = message.getByTestId('chat-text');
  await expectClockBeside(clock, bubble, 'Are you back?');
  const queuedBox = await rect(bubble);

  // The message resumed the session; once the new process has started it takes the message up: the clock goes.
  await expect(clock).toHaveCount(0, { timeout: 15_000 });
  await expect(message).not.toHaveAttribute('data-queued');
  expectSameBox(await rect(bubble), queuedBox);
  await expect(chat.getByTestId('chat-text')).toHaveText(['Remember the code word: zeppelin.', 'OK', 'Are you back?', 'OK']);
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
});

test('answers to a question the pause left stale wait in the outbox with the clock; Resume sends them and it goes', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'queued-outbox', '[fake:ask-2q] Ask me about the button.');
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('need');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const chat = page.getByTestId('session-chat');
  const card = chat.getByTestId('question-card');
  await expect(card).toBeVisible();

  await page.getByTestId('session-pause').click();
  await expect.poll(async () => (await detail(page, id)).status).toBe('paused');
  // Stale, still answerable: answering while paused queues the answers in the outbox (no process starts).
  await card.getByRole('button', { name: 'Green' }).click();
  await card.getByRole('button', { name: 'Small' }).click();
  await card.getByTestId('question-send').click();
  const answers = chat.getByTestId('chat-answers');
  await expect(chat.getByTestId('chat-answer')).toHaveText(['acme-app-front: Green', 'acme-app-front: Small']);
  await expect(answers).toHaveAttribute('data-queued', 'resume');
  const clock = answers.getByTestId('chat-queued');
  await expect(clock).toHaveAttribute('title', 'Queued: sent when the session resumes');
  const bubble = answers.locator('.sb-chat-answers-bubble');
  await expect(clock).toBeVisible();
  await expect(clock).toHaveCSS('color', 'rgb(118, 117, 111)');
  const c = await rect(clock);
  const b = await rect(bubble);
  expect(c.x + c.width).toBeLessThanOrEqual(b.x - 4);
  expect(c.y + c.height).toBeLessThanOrEqual(b.y + b.height);
  const queuedBox = await rect(bubble);
  expect((await detail(page, id)).status).toBe('paused');

  // Resume: the answers go out ahead of "Continue."; the clock goes once they are written.
  await page.getByTestId('session-pause').click();
  await expect(clock).toHaveCount(0, { timeout: 15_000 });
  await expect(answers).not.toHaveAttribute('data-queued');
  expectSameBox(await rect(bubble), queuedBox);
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('done');
  expect((await detail(page, id)).questions.map((q) => q.queued)).toEqual([null, null]);
  await expect(chat.getByTestId('chat-queued')).toHaveCount(0);
});
