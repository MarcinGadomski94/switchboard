import { type Page, type Route, expect, test } from '@playwright/test';
import type { SessionDetail, SessionEvent } from '../../src/core/api.ts';
import { PNG_1X1 } from '../helpers/attachments.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.0 · the v2 composer shows your message at once (classic D114,
 * `docs/chat.md` → *Composer*; the shared store `views/session/outgoing.ts`): Enter
 * empties the box and the bubble is in the chat within a second, whatever the agent
 * is doing (idle, a reply running: with its "Queued" note), while `POST …/messages`
 * is still held back (`page.route`, as `queued-send.spec.ts` does); the real event
 * replaces it (one bubble, never two); a refusal puts the text and the attachment
 * back with the error; leaving and coming back keeps the bubble; the phone too.
 */

const SLOW_MS = 3_000;

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-send', { env: { ...V2_SERVER_ENV } });
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

async function userEvents(page: Page, id: string, text: string): Promise<number> {
  const events = await page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`)).json()) as SessionEvent[], id);
  return events.filter((event) => (event.payload as { type?: string; text?: string } | null)?.type === 'user' && ((event.payload as { text?: string }).text ?? '').includes(text)).length;
}

async function settled(page: Page, id: string): Promise<void> {
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 30_000 }).toMatch(/^(done|idle)$/);
}

/** Holds the session's `POST …/messages` back for `ms` (or answers `refuse` instead). */
async function slowSends(page: Page, id: string, ms: number, refuse?: { status: number; body: unknown }): Promise<void> {
  await page.route(`**/api/sessions/${id}/messages`, async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (refuse) return route.fulfill({ status: refuse.status, contentType: 'application/json', body: JSON.stringify(refuse.body) });
    return route.continue();
  });
}

async function go(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

function bubbles(page: Page, text: string) {
  return page.getByTestId('v2-agent-view').getByTestId('v2-agent-you').filter({ hasText: text });
}

function input(page: Page) {
  return page.getByTestId('v2-agent-view').getByTestId('v2-agent-input');
}

test('idle: the bubble shows within a second of Enter, then the real event takes its place (one bubble)', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-send-idle', 'Say hi.');
  await settled(page, id);
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  await expect(input(page)).toBeEnabled();
  await slowSends(page, id, SLOW_MS);
  await input(page).fill('Right away, idle.');
  await input(page).press('Enter');
  await expect(input(page)).toHaveValue('');
  await expect(bubbles(page, 'Right away, idle.')).toHaveCount(1, { timeout: 1_000 });
  await expect(bubbles(page, 'Right away, idle.')).toHaveAttribute('data-delivered', 'false');
  // The real event replaces it: still one.
  await expect.poll(() => userEvents(page, id, 'Right away, idle.'), { timeout: 15_000 }).toBe(1);
  await expect(bubbles(page, 'Right away, idle.')).toHaveAttribute('data-delivered', 'true', { timeout: 10_000 });
  await expect(bubbles(page, 'Right away, idle.')).toHaveCount(1);
  await settled(page, id);
  await expect(bubbles(page, 'Right away, idle.')).toHaveCount(1);
});

test('working: the bubble shows at once with its Queued note, stays one, and leaving and coming back keeps it', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-send-working', '[fake:hold 10] Think it through.');
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  await expect(page.getByTestId('v2-agent-live')).toHaveAttribute('data-kind', 'working', { timeout: 15_000 });
  await slowSends(page, id, SLOW_MS);
  await input(page).fill('Queued while it works.');
  await input(page).press('Enter');
  await expect(input(page)).toHaveValue('');
  const bubble = bubbles(page, 'Queued while it works.');
  await expect(bubble).toHaveCount(1, { timeout: 1_000 });
  await expect(bubble.getByTestId('v2-agent-you-queued')).toBeVisible();
  // Leave (the POST still held) and come back: still there, once.
  await go(page, '/');
  await expect(page.getByTestId('v2-agent-view')).toHaveCount(0);
  await go(page, `/agents/${id}`);
  await expect(bubbles(page, 'Queued while it works.')).toHaveCount(1, { timeout: 1_000 });
  // The service takes it; the event's bubble stands alone.
  await expect.poll(() => userEvents(page, id, 'Queued while it works.'), { timeout: 20_000 }).toBe(1);
  await expect(bubbles(page, 'Queued while it works.')).toHaveCount(1);
  await settled(page, id);
  await expect(bubbles(page, 'Queued while it works.')).toHaveCount(1);
  await expect(bubbles(page, 'Queued while it works.').getByTestId('v2-agent-you-queued')).toHaveCount(0);
});

test('a refused send: the bubble goes, the text and the attachment come back with the error', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-send-refused', 'Say hi.');
  await settled(page, id);
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  await expect(input(page)).toBeEnabled();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('v2-agent-attach').click();
  await (await chooser).setFiles({ name: 'mock.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1X1, 'base64') });
  await expect(page.getByTestId('v2-agent-draft-chip')).toHaveAttribute('data-state', 'ready');
  await slowSends(page, id, 1_500, { status: 409, body: { error: 'busy' } });
  await input(page).fill('This one is refused.');
  await input(page).press('Enter');
  const bubble = bubbles(page, 'This one is refused.');
  await expect(bubble).toHaveCount(1, { timeout: 1_000 });
  // The optimistic bubble carries the attachment.
  await expect(bubble.getByTestId('v2-agent-message-image')).toHaveCount(1);
  await expect(page.getByTestId('v2-agent-error')).toBeVisible({ timeout: 10_000 });
  await expect(bubble).toHaveCount(0);
  await expect(input(page)).toHaveValue('This one is refused.');
  await expect(page.getByTestId('v2-agent-draft-chip')).toHaveCount(1);
});

test('phone (390 × 844): the bubble shows at once and stays one', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-send-phone', '[fake:hold 8] Think it through.');
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  await expect(page.getByTestId('v2-agent-view')).toHaveAttribute('data-layout', 'phone');
  await expect(page.getByTestId('v2-agent-live')).toHaveAttribute('data-kind', 'working', { timeout: 15_000 });
  await slowSends(page, id, SLOW_MS);
  await input(page).fill('From the phone.');
  await page.getByTestId('v2-agent-send').click();
  await expect(input(page)).toHaveValue('');
  await expect(bubbles(page, 'From the phone.')).toHaveCount(1, { timeout: 1_000 });
  await expect.poll(() => userEvents(page, id, 'From the phone.'), { timeout: 20_000 }).toBe(1);
  await settled(page, id);
  await expect(bubbles(page, 'From the phone.')).toHaveCount(1);
});
