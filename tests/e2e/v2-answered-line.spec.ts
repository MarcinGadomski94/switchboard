import { type Page, expect, test } from '@playwright/test';
import type { InboxItem, Session, SessionEvent } from '../../src/core/api.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.0 · the answered line does not stick (`docs/design/v2-decisions.md` →
 * *Fixes after 2.0* → *The answered line leaves*). Real path: fake-claude with its
 * `switchboard` MCP server running, so `turn_status waiting_for_you` raises a D124
 * "Waiting for you" item.
 *
 * - The Needs-you page: an answered card leaves at once with the counts; no line stays.
 * - An agent's chat: a D124 ask answered from the chat card turns into the compact line,
 *   which leaves after its time (the Undo window, 5 s) and does not come back while
 *   the agent works on the reply, even though the server still lists the item until
 *   the agent's next turn closes it.
 * - Undo inside its window (past the line's 4 s) still takes the answer back.
 * - The same at phone width.
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-answered-line', { env: { ...V2_SERVER_ENV, FAKE_CLAUDE_MCP_RUN: '1' } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

const ASK = 'Is the change request merged?';

async function session(page: Page, id: string): Promise<Session> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as Session, id);
}

async function waitingItems(page: Page, id: string): Promise<InboxItem[]> {
  const items = await page.evaluate(async () => (await (await fetch('/api/inbox')).json()) as InboxItem[]);
  return items.filter((item) => item.systemKind === 'turn-waiting' && item.sessionId === id);
}

async function events(page: Page, id: string): Promise<SessionEvent[]> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`)).json()) as SessionEvent[], id);
}

/** Starts an agent whose turn ends with a declared ask (D124) and opens its v2 chat. */
async function askingAgent(page: Page, name: string): Promise<string> {
  await openWithHub(page, `${world.baseUrl}/`);
  const { id } = await world.startSession(page, name, `Check the PR. [fake:tool mcp__switchboard__turn_status {"status":"waiting_for_you","ask":"${ASK}"}]`);
  await expect.poll(async () => (await session(page, id)).status, { timeout: 15_000 }).toBe('need');
  await expect.poll(async () => (await waitingItems(page, id)).length).toBe(1);
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  return id;
}

/**
 * Answers the ask from the chat card with a reply that keeps the agent busy. The
 * card's own Dismiss call is held back (it fails, as the client tolerates), so the
 * server keeps listing the item until the agent's next turn closes it: the path
 * where the line used to stick.
 */
async function replyFromChat(page: Page, id: string, phone = false): Promise<void> {
  // The top bar's Needs-you count (a phone's full-screen chat has no top bar: its count is checked on the tab afterwards).
  const badge = page.getByTestId('v2-needs-button').locator('.v2-dot-badge');
  await page.route('**/api/inbox/*/actions/dismiss', (route) => route.abort());
  const card = page.getByTestId('v2-agent-view').getByTestId('v2-answer-card');
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await expect(card).toHaveAttribute('data-kind', 'ask');
  if (!phone) await expect(badge).toHaveText('1');
  await card.getByRole('textbox').fill('merged [fake:hold 12]');
  await card.getByRole('button', { name: 'Send' }).click();
  // The compact line at once; the count drops at once.
  const line = page.getByTestId('v2-agent-view').getByTestId('v2-answered');
  await expect(line).toContainText('You replied “merged');
  await expect(card).toHaveCount(0);
  if (!phone) await expect(badge).toHaveCount(0);
  // Gone after its time (the Undo window), without coming back.
  await expect(line).toHaveCount(0, { timeout: 7_000 });
  await expect.poll(async () => JSON.stringify(await events(page, id)), { timeout: 15_000 }).toContain('merged');
  await expect.poll(async () => (await waitingItems(page, id)).length, { timeout: 15_000 }).toBe(0);
  await page.waitForTimeout(1_500);
  await expect(line).toHaveCount(0);
  await expect(page.getByTestId('v2-agent-view').getByTestId('v2-answer-card')).toHaveCount(0);
  if (!phone) await expect(badge).toHaveCount(0);
}

test('the Needs-you page: an answered card leaves at once with the count, and no line stays', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/needs-you`);
  await world.startSession(page, 'page-asker', '[fake:ask-delay] Ask me which environment.');
  const card = page.getByTestId('v2-answer-card');
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId('v2-nav-badge-home')).toHaveText('1');
  await card.locator('.v2-opt', { hasText: 'Staging' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('v2-nav-badge-home')).toHaveCount(0);
  await expect(page.getByTestId('v2-needs-button').locator('.v2-dot-badge')).toHaveCount(0);
  await expect(page.getByTestId('v2-page-needs-you').getByTestId('v2-answered')).toHaveCount(0);
  await page.waitForTimeout(6_000);
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('v2-needs-empty')).toBeVisible();
});

test('a D124 ask answered from the chat while the agent is busy: the line leaves after the Undo window and does not come back', async ({ page }) => {
  const id = await askingAgent(page, 'busy-asker');
  await replyFromChat(page, id);
});

test('Undo inside its window, past the line’s 4 s, still takes the answer back', async ({ page }) => {
  const id = await askingAgent(page, 'undo-asker');
  const card = page.getByTestId('v2-agent-view').getByTestId('v2-answer-card');
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await card.getByRole('textbox').fill('not yet');
  await card.getByRole('button', { name: 'Send' }).click();
  const line = page.getByTestId('v2-agent-view').getByTestId('v2-answered');
  await expect(line).toBeVisible();
  await page.waitForTimeout(4_300);
  // Still in the Undo window: the line is still there, and Undo works.
  await expect(line).toBeVisible();
  await page.getByTestId('v2-toast-undo').click();
  await expect(card).toHaveCount(1);
  await expect(line).toHaveCount(0);
  await expect(page.getByTestId('v2-needs-button').locator('.v2-dot-badge')).toHaveText('1');
  await page.waitForTimeout(2_000);
  expect(JSON.stringify(await events(page, id))).not.toContain('not yet');
  expect((await waitingItems(page, id)).length).toBe(1);
  // Answered for good (Not waiting): its line leaves too, and the next specs start all clear.
  await card.locator('[data-action="not-waiting"]').click();
  await expect(line).toBeVisible();
  await expect(line).toHaveCount(0, { timeout: 7_000 });
  await expect.poll(async () => (await waitingItems(page, id)).length, { timeout: 15_000 }).toBe(0);
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the chat’s answered line leaves and does not come back', async ({ page }) => {
    const id = await askingAgent(page, 'phone-asker');
    await replyFromChat(page, id, true);
    // Back on Home: the Needs-you tab has no count, and Home lists nothing.
    await openWithHub(page, `${world.baseUrl}/`);
    await expect(page.getByTestId('v2-tab-needs')).toBeVisible();
    await expect(page.getByTestId('v2-tab-needs').locator('.v2-dot-badge')).toHaveCount(0);
    await expect(page.getByTestId('v2-answered')).toHaveCount(0);
  });
});
