import { type Locator, type Page, expect, test } from '@playwright/test';
import type { HistoryItem, SessionDetail } from '../../src/core/api.ts';
import type { LifecyclePayload } from '../../src/core/event-payload.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D33 oracle (E2E, real path: `node src/server/main.ts` with fake-claude, no demo
 * seed, D13):
 * 1. An idle session closes from its sidebar row: the × is invisible at rest and
 *    shows on hover without moving anything, over the age; a click closes it
 *    without asking and without opening it; the row leaves the sidebar, and
 *    History shows it with the "Closed" tag and Reopen.
 * 2. A running session closes from the session header after the confirmation
 *    ("Stop <title> and close it? …"; Cancel keeps it running); Stop & close stops
 *    its process and the Inbox opens.
 * 3. A waiting session closed from the sidebar (the confirmation again): its
 *    question leaves the Inbox; Reopen in History puts the row back and opens the
 *    session (its question reads "Closed · session closed"); a message resumes it.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-close-sessions');
});

test.afterAll(async () => {
  await world?.stop();
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as SessionDetail, id);
}

async function listedIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => ((await (await fetch('/api/sessions')).json()) as Array<{ id: string }>).map((s) => s.id));
}

async function lifecycleActions(page: Page, id: string): Promise<string[]> {
  return (await detail(page, id)).events.map((event) => event.payload as LifecyclePayload).filter((p) => p?.type === 'lifecycle').map((p) => p.action);
}

/** The sidebar row of a session. */
function sidebarRow(page: Page, id: string): Locator {
  return page.getByTestId('sidebar-sessions').locator(`a[href$="/sessions/${id}"]`);
}

/** The computed color of a SPEC token (a probe element in the page). */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

/** The History row of a stored session. */
function historyRow(page: Page, id: string): Locator {
  return page.locator(`[data-testid="history-row"][data-session-id="${id}"]`);
}

test('an idle session closes from its sidebar row: × on hover (nothing moves), no question asked; History shows it Closed', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const idle = await world.startSession(page, 'close-idle', 'Reply with just OK.');
  const kept = await world.startSession(page, 'keep-open', 'Reply with just OK.');
  await expect.poll(async () => (await detail(page, idle.id)).status, { timeout: 15_000 }).toBe('done');
  await expect.poll(async () => (await detail(page, kept.id)).status, { timeout: 15_000 }).toBe('done');
  await openWithHub(page, `${world.baseUrl}/inbox`);

  const row = sidebarRow(page, idle.id);
  await expect(row).toBeVisible();
  const close = row.getByTestId('sidebar-session-close');
  // Invisible at rest (the prototype's row is unchanged), not a click target.
  await expect(close).toHaveCSS('opacity', '0');
  await expect(close).toHaveCSS('pointer-events', 'none');
  await expect(close).toHaveAttribute('title', 'Close (keeps it in History)');
  await expect(close).toHaveAttribute('aria-label', 'Close close-idle');
  await expect(row).toHaveText(/close-idle/);
  const rowBefore = await row.boundingBox();
  const nameBefore = await row.locator('.sb-session-name').boundingBox();
  const ageBefore = await row.locator('.sb-session-age').boundingBox();

  // Hover: the × shows at the row's right, over the age (hidden meanwhile); nothing moves.
  await row.hover();
  await expect(close).toHaveCSS('opacity', '1');
  await expect(close).toHaveCSS('color', await tokenColor(page, '--muted-2'));
  await expect(row.locator('.sb-session-age')).toHaveCSS('visibility', 'hidden');
  expect(await row.boundingBox()).toEqual(rowBefore);
  expect(await row.locator('.sb-session-name').boundingBox()).toEqual(nameBefore);
  expect(await row.locator('.sb-session-age').boundingBox()).toEqual(ageBefore);
  const x = await close.boundingBox();
  expect(Math.round((x?.x ?? 0) + (x?.width ?? 0))).toBe(Math.round((rowBefore?.x ?? 0) + (rowBefore?.width ?? 0) - 6));
  expect(x?.y ?? 0).toBeGreaterThanOrEqual(rowBefore?.y ?? 0);

  // A click closes it at once (its process was idle): no confirmation, the row goes, the page stays on the Inbox.
  await close.click();
  await expect(page.getByTestId('close-confirm')).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(page).toHaveURL(`${world.baseUrl}/inbox`);
  await expect(sidebarRow(page, kept.id)).toBeVisible();
  expect(await listedIds(page)).toEqual([kept.id]);
  const closed = await detail(page, idle.id);
  expect(typeof closed.closedAt).toBe('string');
  expect(closed).toMatchObject({ status: 'paused', live: false });

  // History: the Closed tag and Reopen on its row; the open session has neither.
  await page.getByTestId('nav-history').click();
  const history = historyRow(page, idle.id);
  await expect(history).toHaveAttribute('data-closed', 'true');
  await expect(history.getByTestId('history-closed-tag')).toHaveText('Closed');
  await expect(history.getByTestId('history-reopen')).toHaveText('Reopen');
  await expect(historyRow(page, kept.id).getByTestId('history-closed-tag')).toHaveCount(0);
  await expect(historyRow(page, kept.id).getByTestId('history-reopen')).toHaveCount(0);
  const rows = await page.evaluate(async () => (await (await fetch('/api/history')).json()) as HistoryItem[]);
  expect(rows.find((item) => item.sessionId === idle.id)?.closedAt).toBe(closed.closedAt);
});

test('a running session closes from the header after the confirmation; Cancel keeps it; Stop & close stops it and opens the Inbox', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const running = await world.startSession(page, 'close-running', '[fake:hang] Keep working.');
  await expect.poll(async () => (await detail(page, running.id)).status, { timeout: 15_000 }).toBe('run');
  await openWithHub(page, `${world.baseUrl}/sessions/${running.id}`);

  const close = page.getByTestId('session-close');
  await expect(close).toHaveText('Close');
  // Styled like the other header actions, first among them.
  const pause = page.getByTestId('session-pause');
  for (const prop of ['font-size', 'color', 'border-top-color', 'border-top-left-radius', 'padding-top', 'padding-left']) {
    expect(await close.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop)).toBe(await pause.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop));
  }
  const actions = await page.locator('.sb-sv-actions > *').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  // D31's model picker (when the session reports models) comes first, then Close (merged header order).
  expect(actions.filter((a) => a !== 'session-model')[0]).toBe('session-close');

  // The confirmation; Cancel keeps it running.
  await close.click();
  const dialog = page.getByTestId('close-confirm');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('close-confirm-text')).toHaveText('Stop close-running and close it? Its conversation stays in History and can be reopened.');
  await expect(page.getByTestId('close-confirm-stop')).toHaveText('Stop & close');
  await expect(page.getByTestId('close-confirm-cancel')).toHaveText('Cancel');
  await page.getByTestId('close-confirm-cancel').click();
  await expect(dialog).toHaveCount(0);
  expect(await detail(page, running.id)).toMatchObject({ status: 'run', live: true, closedAt: null });
  await expect(sidebarRow(page, running.id)).toBeVisible();

  // Stop & close: its process is stopped the way Pause stops it, the session is closed and the Inbox opens.
  await close.click();
  await page.getByTestId('close-confirm-stop').click();
  await expect(page).toHaveURL(`${world.baseUrl}/inbox`);
  await expect(page.getByTestId('view-inbox')).toBeVisible();
  await expect(sidebarRow(page, running.id)).toHaveCount(0);
  const closed = await detail(page, running.id);
  expect(closed).toMatchObject({ status: 'paused', live: false });
  expect(typeof closed.closedAt).toBe('string');
  expect((await lifecycleActions(page, running.id)).slice(-2)).toEqual(['paused', 'closed']);
});

test('a waiting session: its question leaves the Inbox; Reopen in History brings the row back and opens it; a message resumes it', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const waiting = await world.startSession(page, 'close-waiting', '[fake:ask-2q] Ask me two things.');
  await expect.poll(async () => (await detail(page, waiting.id)).status, { timeout: 15_000 }).toBe('need');
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await expect(page.getByTestId('nav-inbox').locator('.sb-badge')).toHaveText('1');

  // Closing from the sidebar asks first (it waits for you).
  const row = sidebarRow(page, waiting.id);
  await row.hover();
  await row.getByTestId('sidebar-session-close').click();
  await expect(page.getByTestId('close-confirm-text')).toHaveText('Stop close-waiting and close it? Its conversation stays in History and can be reopened.');
  await page.getByTestId('close-confirm-stop').click();
  await expect(row).toHaveCount(0);
  // Its question left the Inbox.
  await expect(page.getByTestId('nav-inbox').locator('.sb-badge')).toHaveText('');
  expect(await page.evaluate(async () => (await (await fetch('/api/inbox')).json()) as unknown[])).toEqual([]);

  // Reopen from History: the session view opens and the row is back.
  await page.getByTestId('nav-history').click();
  const history = historyRow(page, waiting.id);
  await expect(history.getByTestId('history-closed-tag')).toHaveText('Closed');
  await history.getByTestId('history-reopen').click();
  await expect(page).toHaveURL(`${world.baseUrl}/sessions/${waiting.id}`);
  await expect(page.getByTestId('session-name')).toHaveText('close-waiting');
  await expect(sidebarRow(page, waiting.id)).toBeVisible();
  const reopened = await detail(page, waiting.id);
  expect(reopened).toMatchObject({ closedAt: null, live: false, status: 'paused' });
  // The question closed with the session stays closed.
  await expect(page.getByTestId('session-chat').getByTestId('chat-answer')).toHaveText(['Closed · session closed']);

  // A message resumes it (--resume, the same conversation).
  const input = page.getByTestId('chat-input');
  await input.fill('Carry on without those answers.');
  await page.getByTestId('chat-send').click();
  await expect.poll(async () => (await detail(page, waiting.id)).status, { timeout: 15_000 }).toBe('done');
  expect(await detail(page, waiting.id)).toMatchObject({ live: true, closedAt: null });
  expect(await lifecycleActions(page, waiting.id)).toEqual(expect.arrayContaining(['closed', 'reopened', 'resumed']));
  await expect(page.getByTestId('session-chat').getByTestId('chat-text').last()).toHaveText('OK');
});
