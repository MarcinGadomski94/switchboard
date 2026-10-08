import { mkdir } from 'node:fs/promises';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { Session, SessionDetail, SessionTodoList, SidebarLayout } from '../../src/core/api.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D83 on the real path (D13): fake-claude's `[fake:usage 170000]` fills the context to
 * 85 %. The bar above the composer offers "Context 85% — Continue in a fresh session";
 * Not now snoozes it; Continue asks the agent for a handover, starts the fresh
 * session (same folder, CLI, model) with it, moves the todo list and the pin, closes
 * the old session, and both chats link each other; History links them too. The
 * session's ⋯ menu offers the same action; Settings turns the offer off; a phone wraps it.
 */
let world: QuestionWorld;
const SHOTS = process.env['LANE_E_SHOTS'] ?? null;

test.beforeAll(async () => {
  world = await startQuestionWorld('fresh-session');
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
});

test.afterAll(async () => {
  await world?.stop();
});

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, u, b]) => {
      const response = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json' }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });
      return (response.status === 204 ? null : await response.json()) as unknown;
    },
    [method, url, body] as const,
  ) as Promise<T>;
}

function row(page: Page, id: string): Locator {
  return page.getByTestId('sidebar-sessions').locator(`a.sb-session[data-session-id="${id}"]`);
}

test('the offer at 85 %, Not now, Continue: a fresh session takes over the todos and the pin; the old one is closed; linked both ways', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'fresh-e2e', 'Fill it. [fake:usage 170000]');
  await expect.poll(async () => (await api<SessionDetail>(page, 'GET', `/api/sessions/${id}`)).status, { timeout: 15_000 }).toBe('done');
  // A todo list and a pin to carry over.
  await api(page, 'POST', `/api/sessions/${id}/todos`, { title: 'Finish the login fix', priority: 'high', estimateMinutes: 30 });
  await api(page, 'POST', `/api/sessions/${id}/todos`, { title: 'Write the test' });
  const before = await api<SessionTodoList>(page, 'GET', `/api/sessions/${id}/todos`);
  await api(page, 'POST', '/api/sidebar/place', { sessionId: id, place: 'pinned' });

  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const bar = page.getByTestId('fresh-offer');
  await expect(page.getByTestId('chat-context-text')).toHaveText('Context 85% · 170k / 200k');
  await expect(bar.getByTestId('fresh-offer-text')).toHaveText('Context 85% — Continue in a fresh session');
  // Above the composer.
  const [barBox, composerBox] = [await bar.boundingBox(), await page.getByTestId('chat-composer').boundingBox()];
  expect((barBox?.y ?? 0) + (barBox?.height ?? 0)).toBeLessThanOrEqual((composerBox?.y ?? 0) + 0.5);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/offer-bar-1440.png` });

  // Not now: gone, also after a reload (snoozed until 95 %).
  await bar.getByTestId('fresh-not-now').click();
  await expect(bar).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('chat-context-text')).toHaveText('Context 85% · 170k / 200k');
  await expect(page.getByTestId('fresh-offer')).toHaveCount(0);

  // Forget the snooze: the offer is back; Continue.
  await page.evaluate(() => window.localStorage.removeItem('switchboard.freshSnoozes'));
  await page.reload();
  await page.getByTestId('fresh-continue').click();
  // The tab follows to the fresh session.
  await expect.poll(async () => new URL(page.url()).pathname, { timeout: 20_000 }).not.toBe(`/sessions/${id}`);
  const freshId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2] ?? '');
  const old = await api<Session>(page, 'GET', `/api/sessions/${id}`);
  expect(old.closedAt).not.toBeNull();
  expect(old.continuedTo).toEqual({ sessionId: freshId, title: 'fresh-e2e (2)' });
  const fresh = await api<SessionDetail>(page, 'GET', `/api/sessions/${freshId}`);
  expect(fresh).toMatchObject({ name: 'fresh-e2e-2', displayTitle: 'fresh-e2e (2)', cwd: old.cwd, provider: 'claude', continuedFrom: { sessionId: id, title: 'fresh-e2e' } });

  // The todo list moved (ids and states kept); the pin moved too.
  const moved = await api<SessionTodoList>(page, 'GET', `/api/sessions/${freshId}/todos`);
  expect(moved.todos.map((t) => [t.id, t.title, t.state])).toEqual(before.todos.map((t) => [t.id, t.title, t.state]));
  expect((await api<SessionTodoList>(page, 'GET', `/api/sessions/${id}/todos`)).todos).toEqual([]);
  await expect.poll(async () => (await api<SidebarLayout>(page, 'GET', '/api/sidebar')).pinned).toEqual([freshId]);
  await expect(row(page, freshId)).toHaveAttribute('data-group', 'pinned');
  await expect(row(page, id)).toHaveCount(0);

  // The fresh chat starts with "Continued from <old>" (a link back) and the handover as its first message.
  const from = page.getByTestId('chat-divider-link').filter({ hasText: 'Continued from fresh-e2e' });
  await expect(from).toBeVisible();
  await expect(page.getByTestId('session-chat')).toContainText('You are continuing the session "fresh-e2e" in a fresh session');
  await expect.poll(async () => (await api<SessionDetail>(page, 'GET', `/api/sessions/${freshId}`)).status, { timeout: 15_000 }).toBe('done');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/fresh-session-new-1440.png` });

  // The old one: "Continued in <new>" in its chat and its header, both linking forward.
  await from.click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${id}`));
  await expect(page.getByTestId('session-continued-in-note')).toContainText('Continued in fresh-e2e (2)');
  await expect(page.getByTestId('chat-divider-link').filter({ hasText: 'Continued in fresh-e2e (2)' })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/fresh-session-old-1440.png` });
  await page.getByTestId('session-continued-in-link').click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${freshId}`));

  // History links both rows.
  await page.goto(`${world.baseUrl}/history`);
  const oldRow = page.locator(`[data-testid="history-row"][data-session-id="${id}"]`);
  await expect(oldRow.getByTestId('history-continued-in')).toHaveText('Continued in fresh-e2e (2)');
  await expect(page.locator(`[data-testid="history-row"][data-session-id="${freshId}"]`).getByTestId('history-continued-from')).toHaveText('Continued from fresh-e2e');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/fresh-session-history-1440.png` });
});

test('the ⋯ menu continues at any percent; off in Settings hides the bar; a phone wraps it', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'menu-fresh', 'Small. [fake:usage 20000]');
  await expect.poll(async () => (await api<SessionDetail>(page, 'GET', `/api/sessions/${id}`)).status, { timeout: 15_000 }).toBe('done');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('chat-context-text')).toHaveText('Context 10% · 20k / 200k');
  await expect(page.getByTestId('fresh-offer')).toHaveCount(0);
  await row(page, id).hover();
  await row(page, id).getByTestId('sidebar-session-menu').click();
  await page.getByTestId('sidebar-menu').getByTestId('sidebar-menu-fresh').click();
  await expect.poll(async () => (await api<Session>(page, 'GET', `/api/sessions/${id}`)).continuedTo?.sessionId ?? null, { timeout: 20_000 }).not.toBeNull();
  const freshId = (await api<Session>(page, 'GET', `/api/sessions/${id}`)).continuedTo?.sessionId as string;
  await expect(page).toHaveURL(new RegExp(`/sessions/${freshId}`));

  // Settings → Sessions: off hides the bar even past the threshold.
  const { id: full } = await world.startSession(page, 'full-off', 'Fill. [fake:usage 180000]');
  await expect.poll(async () => (await api<SessionDetail>(page, 'GET', `/api/sessions/${full}`)).status, { timeout: 15_000 }).toBe('done');
  await page.goto(`${world.baseUrl}/settings/sessions`);
  const settingRow = page.locator('[data-row="fresh-offer"]');
  await expect(settingRow.getByTestId('fresh-offer-threshold')).toHaveValue('80');
  await settingRow.getByTestId('fresh-offer-threshold').selectOption('95');
  await expect.poll(async () => (await api<Record<string, unknown>>(page, 'GET', '/api/settings'))['sessions.freshOfferPct']).toBe(95);
  await openWithHub(page, `${world.baseUrl}/sessions/${full}`);
  await expect(page.getByTestId('chat-context-text')).toHaveText('Context 90% · 180k / 200k');
  await expect(page.getByTestId('fresh-offer')).toHaveCount(0);
  await api(page, 'PUT', '/api/settings', { 'sessions.freshOfferPct': 85 });
  await page.reload();
  await expect(page.getByTestId('fresh-offer')).toBeVisible();
  await api(page, 'PUT', '/api/settings', { 'sessions.freshOffer': false });
  await page.reload();
  await expect(page.getByTestId('chat-context-text')).toHaveText('Context 90% · 180k / 200k');
  await expect(page.getByTestId('fresh-offer')).toHaveCount(0);
  await api(page, 'PUT', '/api/settings', { 'sessions.freshOffer': true, 'sessions.freshOfferPct': 80 });

  // Phone: the bar wraps inside the page.
  await page.setViewportSize({ width: 360, height: 780 });
  await page.reload();
  const bar = page.getByTestId('fresh-offer');
  await expect(bar).toBeVisible();
  const box = await bar.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/offer-bar-360.png` });
});
