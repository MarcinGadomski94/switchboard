import { type Page, expect, test } from '@playwright/test';
import type { InboxItem, Session } from '../../src/core/api.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D124, real path (D13, no demo seed): `node src/server/main.ts` with fake-claude as the CLI, its
 * `switchboard` MCP server really running (`FAKE_CLAUDE_MCP_RUN=1`). A session whose turn ends
 * with a question reads "needs you" (detected) in its header and sidebar row, with an Inbox item
 * "Waiting for you: …"; a reply clears both. A session whose agent calls `turn_status
 * waiting_for_you` shows its ask (declared, no "detected" hint), and Not waiting clears it. The
 * same at phone width.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('turn-status', { env: { FAKE_CLAUDE_MCP_RUN: '1' } });
});

test.afterAll(async () => {
  await world?.stop();
});

const QUESTION = 'Should I merge it once the checks are green?';
const ASK = 'Pick the Acme region: EU or US';

async function session(page: Page, id: string): Promise<Session> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as Session, id);
}

async function waitingItems(page: Page, id: string): Promise<InboxItem[]> {
  const items = await page.evaluate(async () => (await (await fetch('/api/inbox')).json()) as InboxItem[]);
  return items.filter((item) => item.systemKind === 'turn-waiting' && item.sessionId === id);
}

async function reply(page: Page, id: string, text: string): Promise<void> {
  const status = await page.evaluate(
    async ({ sessionId, body }) => (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: body }) })).status,
    { sessionId: id, body: text },
  );
  expect(status).toBe(202);
}

/** A session whose turn ends with a question (the text check): its header, row and Inbox item; a reply clears them. */
async function questionFlow(page: Page, name: string, phone: boolean): Promise<void> {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, name, `Ship it. [fake:say "I pushed the branch and opened the PR.\\n\\n${QUESTION}"]`);
  await expect.poll(async () => (await session(page, id)).status, { timeout: 15_000 }).toBe('need');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const line = page.getByTestId('session-needs-you');
  await expect(line).toBeVisible();
  await expect(line).toHaveAttribute('data-source', 'detected');
  await expect(page.getByTestId('session-needs-you-ask')).toHaveText(QUESTION);
  await expect(page.getByTestId('session-needs-you-detected')).toBeVisible();
  await expect(page.getByTestId('session-not-waiting')).toBeVisible();
  if (!phone) {
    // The sidebar row: its ask in place of the mode line.
    const row = page.locator(`[data-session-id="${id}"]`);
    await expect(row.getByTestId('session-row-ask')).toContainText(QUESTION);
  }
  // One Inbox item for the episode.
  await expect.poll(async () => (await waitingItems(page, id)).length).toBe(1);
  await page.goto(`${world.baseUrl}/inbox`);
  const item = page.getByTestId('inbox-item').filter({ hasText: `Waiting for you: ${name}` });
  await expect(item).toHaveCount(1);

  // The developer replies: the wait and the item go.
  await reply(page, id, 'Yes, merge it.');
  await expect.poll(async () => (await waitingItems(page, id)).length, { timeout: 15_000 }).toBe(0);
  await expect.poll(async () => (await session(page, id)).status, { timeout: 15_000 }).toBe('done');
  await expect(page.getByTestId('inbox-item').filter({ hasText: `Waiting for you: ${name}` })).toHaveCount(0);
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('session-header')).toBeVisible();
  await expect(page.getByTestId('session-needs-you')).toHaveCount(0);
}

/** A session whose agent calls turn_status waiting_for_you: its ask, declared; Not waiting clears it. */
async function declaredFlow(page: Page, name: string): Promise<void> {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, name, `Prepare the rollout. [fake:tool mcp__switchboard__turn_status {"status":"waiting_for_you","ask":"${ASK}"}]`);
  await expect.poll(async () => (await session(page, id)).status, { timeout: 15_000 }).toBe('need');
  expect((await session(page, id)).turnWait).toMatchObject({ status: 'waiting_for_you', ask: ASK, source: 'declared' });
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('session-needs-you')).toHaveAttribute('data-source', 'declared');
  await expect(page.getByTestId('session-needs-you-ask')).toHaveText(ASK);
  await expect(page.getByTestId('session-needs-you-detected')).toHaveCount(0);
  await expect.poll(async () => (await waitingItems(page, id)).length).toBe(1);
  await page.getByTestId('session-not-waiting').click();
  await expect(page.getByTestId('session-needs-you')).toHaveCount(0);
  await expect.poll(async () => (await session(page, id)).status).toBe('done');
  await expect.poll(async () => (await waitingItems(page, id)).length).toBe(0);
}

test('a turn ending with a question: needs you (detected) in the header, the row and the Inbox; a reply clears it', async ({ page }) => {
  await questionFlow(page, 'ask-merge-e2e', false);
});

test('turn_status waiting_for_you: the declared ask; Not waiting clears it', async ({ page }) => {
  await declaredFlow(page, 'declared-ask-e2e');
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the needs-you line and its Inbox item; a reply clears them', async ({ page }) => {
    await questionFlow(page, 'ask-merge-phone-e2e', true);
  });

  test('a declared ask; Not waiting clears it', async ({ page }) => {
    await declaredFlow(page, 'declared-ask-phone-e2e');
  });
});
