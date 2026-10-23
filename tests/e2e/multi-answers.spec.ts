import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { SessionDetail, SessionEvent } from '../../src/core/api.ts';
import type { ToolPayload } from '../../src/core/event-payload.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D128 oracle, real path (no demo seed): `node src/server/main.ts` with fake-claude
 * as the CLI. An `ask-multiselect` question ("Which parts should I update?",
 * Code / Tests / Docs) is answered with two options and own words, in the chat's
 * inline card (keyboard: Space toggles, Enter sends) and in the Inbox at a phone
 * width with touch (44 px targets). The fake process gets ONE `control_response`
 * whose answer is every choice joined the CLI's way, and the answered view lists
 * them all, also after a reload.
 */

let world: QuestionWorld;
let tmp: string;
let logFile: string;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-multi-answers');
  logFile = path.join(tmp, 'fake.log');
  world = await startQuestionWorld('multi-answers', { env: { FAKE_CLAUDE_LOG: logFile } });
});

test.afterAll(async () => {
  await world?.stop();
  if (tmp) await removeTempDir(tmp);
});

const PARTS = 'Which parts should I update?';

async function controlResponses(): Promise<Array<{ response: { response: Record<string, unknown> } }>> {
  let text = '';
  try {
    text = await readFile(logFile, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { kind: string; line?: string })
    .filter((entry) => entry.kind === 'stdin' && (entry.line ?? '').includes('"control_response"'))
    .map((entry) => JSON.parse(entry.line as string) as { response: { response: Record<string, unknown> } });
}

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as SessionDetail, id);
}

async function events(page: Page, id: string): Promise<SessionEvent[]> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`)).json()) as SessionEvent[], id);
}

/** The one new control_response carries every choice as one answer string; the fake's tool result lists them. */
async function expectAgentGot(page: Page, id: string, before: number, answer: string): Promise<void> {
  await expect.poll(async () => (await controlResponses()).length).toBe(before + 1);
  expect((await controlResponses())[before]?.response.response).toMatchObject({ behavior: 'allow', updatedInput: { answers: { [PARTS]: answer } } });
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
  const ask = (await events(page, id)).find((e) => (e.payload as ToolPayload).name === 'AskUserQuestion')?.payload as ToolPayload | undefined;
  expect(ask?.result).toContain(`"${PARTS}"="${answer}"`);
}

/** The answered view: the answers bubble lists every choice. */
async function expectAnsweredView(page: Page, line: RegExp): Promise<void> {
  const chat = page.getByTestId('session-chat');
  await expect(chat.getByTestId('question-card')).toHaveCount(0);
  await expect(chat.getByTestId('chat-answer')).toHaveCount(1);
  await expect(chat.getByTestId('chat-answer')).toHaveText(line);
}

function checkbox(card: Locator, name: string): Locator {
  return card.getByRole('checkbox', { name, exact: true });
}

test('chat card: "Choose any", checkboxes; Space toggles, Other… alongside, Enter sends; the agent receives every choice', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const before = (await controlResponses()).length;
  const { id } = await world.startSession(page, 'multi-chat', '[fake:ask-multiselect] Ask me a multi-select question.');
  await expect.poll(async () => (await detail(page, id)).status).toBe('need');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const card = page.getByTestId('session-chat').getByTestId('question-card');
  const status = card.getByTestId('question-status');
  const send = card.getByTestId('question-send');

  await expect(card.getByTestId('question-multi-hint')).toHaveText('Choose any');
  await expect(card.getByRole('checkbox')).toHaveCount(4);
  await expect(card.getByTestId('question-other')).toHaveAttribute('role', 'checkbox');
  await expect(send).toBeDisabled();

  // Click ticks; Space toggles (on and off) without sending.
  await checkbox(card, 'Tests').click();
  await expect(checkbox(card, 'Tests')).toHaveAttribute('aria-checked', 'true');
  await expect(status).toHaveText(/All answered/);
  await checkbox(card, 'Code').focus();
  await page.keyboard.press('Space');
  await expect(checkbox(card, 'Code')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Space');
  await expect(checkbox(card, 'Code')).toHaveAttribute('aria-checked', 'false');
  await checkbox(card, 'Docs').focus();
  await page.keyboard.press('Space');
  await expect(checkbox(card, 'Docs')).toHaveAttribute('aria-checked', 'true');
  expect(await controlResponses()).toHaveLength(before);

  // Other… is a checkbox that opens the field; a ticked empty Other… blocks Send; the options stay ticked.
  await card.getByTestId('question-other').click();
  await expect(card.getByTestId('question-other')).toHaveAttribute('aria-checked', 'true');
  const field = card.getByTestId('question-own-input');
  await expect(field).toBeFocused();
  await expect(send).toBeDisabled();
  await page.keyboard.type('the changelog');
  await expect(send).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(field).toHaveCount(0);
  await expect(card.getByTestId('question-own-answer')).toHaveText('the changelog');
  await expect(checkbox(card, 'Tests')).toHaveAttribute('aria-checked', 'true');
  await expect(checkbox(card, 'Docs')).toHaveAttribute('aria-checked', 'true');

  // Enter on a checkbox sends.
  const answered = page.waitForResponse((r) => /\/api\/questions\/batch\/[^/]+\/answers$/.test(r.url()));
  await checkbox(card, 'Docs').focus();
  await page.keyboard.press('Enter');
  const response = await answered;
  expect(response.status()).toBe(204);
  const questionId = (await detail(page, id)).questions[0]?.id;
  expect(response.request().postDataJSON()).toEqual({ answers: [{ questionId, answerIndexes: [1, 2], text: 'the changelog' }] });

  await expectAgentGot(page, id, before, 'Tests, Docs, the changelog');
  await expectAnsweredView(page, /: Tests, Docs, the changelog$/);
  expect((await detail(page, id)).questions.map((q) => [q.answerIndex, q.answerIndexes, q.answerText])).toEqual([[1, [1, 2], 'the changelog']]);
  // After a reload the answered view still lists every choice.
  await page.reload();
  await expectAnsweredView(page, /: Tests, Docs, the changelog$/);
});

test('Inbox card at a phone width (touch): 44 px checkboxes; two options reach the agent; the chat lists both', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await page.goto(`${world.baseUrl}/inbox`);
    await expect(page.getByTestId('view-inbox')).toBeVisible();
    const before = (await controlResponses()).length;
    const { id } = await world.startSession(page, 'multi-inbox', '[fake:ask-multiselect] Ask me a multi-select question.');
    // A phone shows the Inbox list first; the item opens its detail with the card.
    await page.getByTestId('inbox-item').first().tap();
    const card = page.getByTestId('question-card');
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/sb-qcard--inbox/);
    await expect(card.getByTestId('question-multi-hint')).toHaveText('Choose any');
    for (const name of ['Code', 'Tests', 'Docs', 'Other…']) {
      const box = await checkbox(card, name).boundingBox();
      expect(box?.height, name).toBeGreaterThanOrEqual(44);
    }
    // Nothing overflows the phone width.
    const cardBox = await card.boundingBox();
    expect((cardBox?.x ?? 0) + (cardBox?.width ?? 0)).toBeLessThanOrEqual(390);

    await checkbox(card, 'Code').tap();
    await checkbox(card, 'Docs').tap();
    await expect(checkbox(card, 'Code')).toHaveAttribute('aria-checked', 'true');
    await expect(checkbox(card, 'Docs')).toHaveAttribute('aria-checked', 'true');
    await card.getByTestId('question-send').tap();
    await expect(page.getByTestId('inbox-item')).toHaveCount(0);
    await expectAgentGot(page, id, before, 'Code, Docs');

    await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
    await expectAnsweredView(page, /: Code, Docs$/);
  } finally {
    await context.close();
  }
});
