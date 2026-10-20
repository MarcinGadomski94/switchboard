import { type Page, type Route, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import type { SessionDraft } from '../../src/core/drafts.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { newTouchPage, touchContext } from './responsive-world.ts';

/**
 * Fix · queued send feedback, real path (fake-claude, no demo seed). While a turn
 * runs, the service can take seconds to answer `POST …/messages` (the checkpoint's
 * git snapshot before the message, the process's queue of stream lines). The
 * composer does not wait for it: Enter clears the field and the message shows at
 * once with the clock ("after its current turn"); the server draft is cleared and
 * stays cleared (leaving the session before the answer used to save the text
 * again, so it came back into the field); the message shows once when the `/hub`
 * event catches up. A refused send puts the text back with the error. The slow
 * answer is held back by the page (`page.route`), so the gap is the same on every run.
 */

const SLOW_MS = 3_000;

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('queued-send');
});

test.afterAll(async () => {
  await world?.stop();
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sid) => (await (await fetch(`/api/sessions/${encodeURIComponent(sid)}`)).json()) as SessionDetail, id);
}

async function drafts(page: Page, id: string): Promise<SessionDraft[]> {
  return page.evaluate(async (sid) => (await (await fetch(`/api/sessions/${encodeURIComponent(sid)}/drafts`)).json()) as SessionDraft[], id);
}

/** Holds the session's `POST …/messages` back for `ms` before it reaches the server (or answers `refuse` instead). */
async function slowSends(page: Page, id: string, ms: number, refuse?: { status: number; body: unknown }): Promise<void> {
  await page.route(`**/api/sessions/${id}/messages`, async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (refuse) return route.fulfill({ status: refuse.status, contentType: 'application/json', body: JSON.stringify(refuse.body) });
    return route.continue();
  });
}

/** In-app navigation (no reload: the send in flight goes on), as the sidebar and the back button do. */
async function goInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

function userMessages(page: Page, text: string) {
  return page.getByTestId('session-chat').locator('[data-testid="chat-message"][data-role="user"]').filter({ hasText: text });
}

for (const size of [
  { name: 'desktop', width: 1440, height: 900, touch: false },
  { name: 'phone', width: 360, height: 740, touch: true },
]) {
  test(`${size.name}: Enter while a turn runs clears the composer and shows the message queued at once; leaving and coming back keeps it so`, async ({ browser }) => {
    test.setTimeout(90_000);
    const context = size.touch ? await touchContext(browser, size) : await browser.newContext({ viewport: { width: size.width, height: size.height } });
    try {
      const page = size.touch ? await newTouchPage(context) : await context.newPage();
      await page.goto(`${world.baseUrl}/`);
      const { id } = await world.startSession(page, `queued-send-${size.name}`, '[fake:hold 12] Think it through.');
      await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
      await expect(page.getByTestId('chat-activity')).toHaveAttribute('data-state', 'thinking', { timeout: 15_000 });
      await slowSends(page, id, SLOW_MS);

      const input = page.getByTestId('chat-input');
      const text = `Keep it short (${size.name}).`;
      await input.click();
      await input.pressSequentially(text);
      // The draft is saved while typing (D88), as it was for the developer.
      await expect.poll(async () => (await drafts(page, id)).length).toBe(1);
      await input.press('Enter');

      // At once (well before the slow answer): the field is empty and the message waits with the clock.
      const message = userMessages(page, text);
      await expect(input).toHaveValue('', { timeout: 1_000 });
      await expect(message).toHaveCount(1, { timeout: 1_000 });
      await expect(message).toHaveAttribute('data-queued', 'turn', { timeout: 1_000 });
      await expect(message.getByTestId('chat-queued')).toBeVisible();
      await expect.poll(() => drafts(page, id), { timeout: 1_500 }).toEqual([]);

      // Leave the session before the service answers, and come back.
      await goInApp(page, '/inbox');
      await expect(page.getByTestId('view-session')).toHaveCount(0);
      await page.waitForTimeout(SLOW_MS + 500);
      await goInApp(page, `/sessions/${id}`);
      await expect(page.getByTestId('view-session')).toHaveAttribute('data-session-id', id);
      await expect(page.getByTestId('chat-input')).toHaveValue('');
      await expect(userMessages(page, text)).toHaveCount(1);
      expect(await drafts(page, id)).toEqual([]);
      // The server recorded it once, queued behind the turn.
      const events = await page.evaluate(
        async (sid) => (await (await fetch(`/api/sessions/${encodeURIComponent(sid)}/events`)).json()) as Array<{ payload: { type?: string; text?: string } }>,
        id,
      );
      expect(events.filter((event) => event.payload.type === 'user' && event.payload.text === text)).toHaveLength(1);

      // A reload: still empty, still one message; the turn ends and the next one takes it up (the clock goes).
      await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
      await expect(page.getByTestId('chat-input')).toHaveValue('');
      await expect(userMessages(page, text)).toHaveCount(1);
      await expect(userMessages(page, text).getByTestId('chat-queued')).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(async () => (await detail(page, id)).status, { timeout: 20_000 }).toBe('done');
      await expect(userMessages(page, text)).toHaveCount(1);
    } finally {
      await context.close();
    }
  });
}

test('staying on the session: the queued message shows once while the slow answer and the /hub event catch up', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'queued-send-stay', '[fake:hold 10] Think it through.');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('chat-activity')).toHaveAttribute('data-state', 'thinking', { timeout: 15_000 });
  await slowSends(page, id, SLOW_MS);
  const input = page.getByTestId('chat-input');
  await input.fill('One and only.');
  await input.press('Enter');
  await expect(input).toHaveValue('', { timeout: 1_000 });
  const message = userMessages(page, 'One and only.');
  await expect(message).toHaveAttribute('data-queued', 'turn', { timeout: 1_000 });
  // Through the answer and the `/hub` event: never two bubbles.
  for (let waited = 0; waited < SLOW_MS + 2_000; waited += 250) {
    expect(await message.count()).toBe(1);
    await page.waitForTimeout(250);
  }
  await expect(message).toHaveCount(1);
  await expect(page.getByTestId('session-chat').getByTestId('chat-queued')).toHaveCount(1);
  await expect(input).toHaveValue('');
  expect(await drafts(page, id)).toEqual([]);
});

test('a refused send puts the text back into the composer with the error, and keeps it as the draft', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'queued-send-refused', '[fake:hold 10] Think it through.');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('chat-activity')).toHaveAttribute('data-state', 'thinking', { timeout: 15_000 });
  await slowSends(page, id, 800, { status: 409, body: { error: 'conflict', message: 'the session is switching accounts' } });
  const input = page.getByTestId('chat-input');
  await input.fill('Do not lose me.');
  await input.press('Enter');
  await expect(input).toHaveValue('', { timeout: 1_000 });
  await expect(userMessages(page, 'Do not lose me.')).toHaveCount(1, { timeout: 1_000 });
  // The refusal: the text is back, the bubble goes, the error shows; the draft is saved again.
  await expect(input).toHaveValue('Do not lose me.', { timeout: 5_000 });
  await expect(userMessages(page, 'Do not lose me.')).toHaveCount(0);
  await expect(page.getByTestId('chat-error')).toBeVisible();
  await expect.poll(async () => (await drafts(page, id)).map((draft) => draft.value)).toEqual([{ text: 'Do not lose me.', attachments: [] }]);
});

test('a send refused after the session was left: its text is in the composer (and the draft) when the developer comes back, with the error', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'queued-send-refused-away', '[fake:hold 10] Think it through.');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('chat-activity')).toHaveAttribute('data-state', 'thinking', { timeout: 15_000 });
  await slowSends(page, id, 1_500, { status: 409, body: { error: 'conflict', message: 'the session is switching accounts' } });
  const input = page.getByTestId('chat-input');
  await input.fill('Still mine.');
  await input.press('Enter');
  await expect(input).toHaveValue('', { timeout: 1_000 });
  await goInApp(page, '/inbox');
  await expect(page.getByTestId('view-session')).toHaveCount(0);
  await expect.poll(async () => (await drafts(page, id)).map((draft) => draft.value), { timeout: 10_000 }).toEqual([{ text: 'Still mine.', attachments: [] }]);
  await goInApp(page, `/sessions/${id}`);
  await expect(page.getByTestId('chat-input')).toHaveValue('Still mine.');
  await expect(page.getByTestId('chat-error')).toBeVisible();
  await expect(userMessages(page, 'Still mine.')).toHaveCount(0);
});
