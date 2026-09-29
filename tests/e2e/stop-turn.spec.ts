import { type Locator, type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D50 oracle, real path (D13, no demo seed): `node src/server/main.ts` with
 * fake-claude as the CLI. Stop the current turn:
 * - while a turn runs (`[fake:hold]`: it thinks without a tool call), the
 *   composer's Send is the ■ Stop button; clicking it interrupts the turn only: the
 *   chat shows "■ Stopped", the session is idle (the process lives on), Send comes
 *   back, and the next message runs normally;
 * - Esc stops the turn too, from the composer's field; with the model popover open
 *   Esc only closes the popover first; with no turn running Esc does nothing;
 * - messages queued while the turn ran (the D44 clock) are taken back: their
 *   bubbles go, and their texts come back into the field, in order, before what
 *   was typed there; sending that runs normally.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('stop-turn');
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

function userMessage(page: Page, text: string): Locator {
  return page.getByTestId('session-chat').locator('[data-testid="chat-message"][data-role="user"]').filter({ hasText: text });
}

/** Counts the page's `POST …/interrupt` requests. */
function countInterrupts(page: Page): { readonly count: () => number } {
  let n = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/interrupt')) n += 1;
  });
  return { count: () => n };
}

/** A session thinking for a long while, opened, its turn running (the activity line says thinking). */
async function runningSession(page: Page, name: string): Promise<string> {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, name, '[fake:hold 30] Think it through.');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('chat-activity')).toHaveAttribute('data-state', 'thinking', { timeout: 15_000 });
  return id;
}

/** After a Stop: the "■ Stopped" line, Send back, idle, no activity line; then the next message runs normally. */
async function expectStoppedThenNextRuns(page: Page, id: string): Promise<void> {
  const chat = page.getByTestId('session-chat');
  await expect(chat.locator('[data-testid="chat-step"][data-mark="■"]')).toHaveText(['■ Stopped'], { timeout: 10_000 });
  await expect(page.getByTestId('chat-send')).toBeVisible();
  await expect(page.getByTestId('chat-stop')).toHaveCount(0);
  await expect(page.getByTestId('chat-activity')).toHaveCount(0);
  const stopped = await detail(page, id);
  expect(stopped.status).toBe('idle');
  expect(stopped.live).toBe(true);

  await page.getByTestId('chat-input').fill('Reply with exactly: resumed-ok');
  await page.getByTestId('chat-input').press('Enter');
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('done');
  await expect(chat.getByTestId('chat-text').last()).toHaveText('OK');
  expect((await detail(page, id)).live).toBe(true);
}

test('while a turn runs Send is ■ Stop; clicking it stops the turn only: "■ Stopped", idle, and the next message runs', async ({ page }) => {
  const interrupts = countInterrupts(page);
  const id = await runningSession(page, 'stop-button');
  await expect(page.getByTestId('chat-send')).toHaveCount(0);
  const stop = page.getByTestId('chat-stop');
  await expect(stop).toHaveText('■ Stop');
  await expect(stop).toHaveAttribute('title', 'Stop the current turn (Esc)');
  expect((await detail(page, id)).status).toBe('run');

  await stop.click();
  await expectStoppedThenNextRuns(page, id);
  expect(interrupts.count()).toBe(1);
});

test('Esc stops the turn from the composer; an open popover takes Esc first; with no turn running Esc does nothing', async ({ page }) => {
  const interrupts = countInterrupts(page);
  const id = await runningSession(page, 'stop-esc');

  // The model popover is open: Esc closes it, the turn goes on.
  await page.getByTestId('session-model-button').click();
  await expect(page.getByTestId('model-popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('model-popover')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(interrupts.count()).toBe(0);
  await expect(page.getByTestId('chat-stop')).toBeVisible();
  expect((await detail(page, id)).status).toBe('run');

  // Esc in the composer's field stops it.
  await page.getByTestId('chat-input').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('session-chat').locator('[data-testid="chat-step"][data-mark="■"]')).toHaveText(['■ Stopped'], { timeout: 10_000 });
  expect(interrupts.count()).toBe(1);
  await expect.poll(async () => (await detail(page, id)).status).toBe('idle');

  // No turn runs: Esc does nothing.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  expect(interrupts.count()).toBe(1);
  await expectStoppedThenNextRuns(page, id);
});

test('messages queued while the turn ran come back into the composer (in order, before the draft); their bubbles go', async ({ page }) => {
  const id = await runningSession(page, 'stop-queued');
  const input = page.getByTestId('chat-input');
  for (const text of ['First queued.', 'Second queued.']) {
    await input.fill(text);
    await input.press('Enter');
    await expect(userMessage(page, text)).toHaveAttribute('data-queued', 'turn');
  }
  await input.fill('Typed meanwhile');

  await page.getByTestId('chat-stop').click();
  await expect(userMessage(page, 'First queued.')).toHaveCount(0);
  await expect(userMessage(page, 'Second queued.')).toHaveCount(0);
  await expect(input).toHaveValue('First queued.\n\nSecond queued.\n\nTyped meanwhile');
  await expect(input).toBeFocused();
  await expect(page.getByTestId('session-chat').getByTestId('chat-queued')).toHaveCount(0);
  await expect.poll(async () => (await detail(page, id)).status).toBe('idle');
  // They never run: still idle a moment later, one result (the Stopped line).
  await page.waitForTimeout(600);
  const after = await detail(page, id);
  expect(after.status).toBe('idle');
  expect(after.events.filter((e) => (e.payload as { type?: string }).type === 'result')).toHaveLength(1);

  // Sending the restored text runs it normally.
  await input.press('Enter');
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('done');
  await expect(userMessage(page, 'Typed meanwhile')).toHaveAttribute('data-delivered', 'true');
  await expect(page.getByTestId('session-chat').getByTestId('chat-text').last()).toHaveText('OK');
});
