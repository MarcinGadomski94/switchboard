import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { SessionDetail, SessionEvent } from '../../src/core/api.ts';
import type { ToolPayload } from '../../src/core/event-payload.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D39 oracle, real path (D13, no demo seed): `node src/server/main.ts` with
 * fake-claude as the CLI and a temp workspace. An `ask-2q` batch is answered with
 * one option (Blue) and one own answer typed after "Other…", once in the chat's
 * inline card and once in the Inbox. The fake process gets one `control_response`
 * whose `answers` carry the label and the typed text verbatim (its stdin log), the
 * fake's AskUserQuestion result is built from them, and the chat's answers bubble
 * shows the text verbatim, line break included.
 */

let world: QuestionWorld;
let tmp: string;
let logFile: string;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-own-answers');
  logFile = path.join(tmp, 'fake.log');
  world = await startQuestionWorld('own-answers', { env: { FAKE_CLAUDE_LOG: logFile } });
});

test.afterAll(async () => {
  await world?.stop();
  if (tmp) await removeTempDir(tmp);
});

// D79 raises a Review card in the Inbox for every session here that leaves changes; these tests count the Inbox's
// questions only, so the cards are off for this file's server.
test.beforeEach(async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const status = await page.evaluate(async () => (await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'sessions.reviewCards': false }) })).status);
  expect(status).toBe(200);
});

const COLOR = 'Which color should the button be?';
const SIZE = 'Which size should it be?';
const ALL_ANSWERED = 'All answered. Each answer is written into the blocked brief word for word.';

/** The `control_response` lines the fake processes received on stdin, parsed, in order. */
async function controlResponses(): Promise<Array<{ response: { request_id: string; response: Record<string, unknown> } }>> {
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
    .map((entry) => JSON.parse(entry.line as string) as { response: { request_id: string; response: Record<string, unknown> } });
}

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return (await response.json()) as SessionDetail;
  }, id);
}

async function events(page: Page, id: string): Promise<SessionEvent[]> {
  return page.evaluate(async (sessionId) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
    return (await response.json()) as SessionEvent[];
  }, id);
}

/** The exact text of each element (no whitespace normalizing), so a line break must be there. */
async function exactTexts(locator: Locator): Promise<string[]> {
  return locator.evaluateAll((elements) => elements.map((element) => element.textContent ?? ''));
}

/**
 * Picks Blue for the first question and answers the second in own words: Other…
 * opens a focused field (still "1 of 2" while it is empty), Esc cancels back to no
 * pick, Other… again, typing counts, Shift+Enter adds a line, Enter confirms.
 * Returns the typed text.
 */
async function answerWithOwnWords(card: Locator, page: Page, words: readonly [string, string]): Promise<string> {
  const questions = card.getByTestId('question');
  const status = card.getByTestId('question-status');
  const send = card.getByTestId('question-send');
  await expect(questions.nth(0).getByTestId('question-option')).toHaveText(['Red', 'Green', 'Blue']);
  await expect(questions.nth(1).getByTestId('question-option')).toHaveText(['Small', 'Large']);
  await expect(questions.getByTestId('question-other')).toHaveText(['Other…', 'Other…']);
  // Other… is styled like the options (same class and computed look).
  const small = questions.nth(1).getByTestId('question-option').first();
  const other = questions.nth(1).getByTestId('question-other');
  for (const prop of ['font-size', 'border-top-color', 'border-radius', 'padding-left', 'color', 'background-color']) {
    await expect(other).toHaveCSS(prop, await small.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), prop));
  }

  await questions.nth(0).getByRole('button', { name: 'Blue' }).click();
  await expect(status).toHaveText('1 of 2 answered');

  // Other…: the field opens focused; empty text does not count.
  await other.click();
  await expect(other).toHaveAttribute('data-selected', 'true');
  const field = questions.nth(1).getByTestId('question-own-input');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('');
  await expect(status).toHaveText('1 of 2 answered');
  await expect(send).toBeDisabled();
  await expect(send).toHaveCSS('opacity', '0.45');
  // Blank text does not count either; Enter on it changes nothing.
  await page.keyboard.type('   ');
  await page.keyboard.press('Enter');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('   ');
  await expect(status).toHaveText('1 of 2 answered');

  // Esc cancels back to no pick (the field goes, focus returns to Other…).
  await page.keyboard.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(other).toHaveAttribute('data-selected', 'false');
  await expect(other).toBeFocused();
  await expect(status).toHaveText('1 of 2 answered');

  // Again: text counts at once; Shift+Enter adds a line; Enter confirms.
  await other.click();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('');
  await page.keyboard.type(words[0]);
  await expect(status).toHaveText(ALL_ANSWERED);
  await expect(send).toBeEnabled();
  await expect(send).toHaveCSS('opacity', '1');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type(words[1]);
  const typed = `${words[0]}\n${words[1]}`;
  await expect(field).toHaveValue(typed);
  await page.keyboard.press('Enter');
  await expect(field).toHaveCount(0);
  const confirmed = questions.nth(1).getByTestId('question-own-answer');
  expect(await exactTexts(confirmed)).toEqual([typed]);
  await expect(other).toHaveAttribute('data-selected', 'true');
  await expect(other).toBeFocused();
  await expect(status).toHaveText(ALL_ANSWERED);
  // The first question's pick is untouched.
  await expect(questions.nth(0).getByTestId('question-option').filter({ hasText: 'Blue' })).toHaveAttribute('data-selected', 'true');
  return typed;
}

/** The one new control_response carries Blue and the typed text by question text (the rest of the input unchanged). */
async function expectAnswersSent(before: number, typed: string): Promise<void> {
  await expect.poll(async () => (await controlResponses()).length).toBe(before + 1);
  const reply = (await controlResponses())[before];
  expect(reply?.response.response).toMatchObject({ behavior: 'allow', updatedInput: { answers: { [COLOR]: 'Blue', [SIZE]: typed } } });
  const input = (reply?.response.response as { updatedInput: { questions: Array<{ question: string }> } }).updatedInput;
  expect(input.questions.map((q) => q.question)).toEqual([COLOR, SIZE]);
}

/** The chat shows the answers bubble with the own answer verbatim; the fake built its tool result from it. */
async function expectAnswersBubble(page: Page, id: string, typed: string): Promise<void> {
  const chat = page.getByTestId('session-chat');
  await expect(chat.getByTestId('question-card')).toHaveCount(0);
  await expect(chat.getByTestId('chat-answer')).toHaveCount(2);
  expect(await exactTexts(chat.getByTestId('chat-answer'))).toEqual(['acme-app-front: Blue', `acme-app-front: ${typed}`]);
  // Verbatim on screen too: the line break shows as a line break (two lines, the option's line one).
  await expect(chat.getByTestId('chat-answer').nth(1)).toHaveCSS('white-space', 'pre-wrap');
  const heights = await chat.getByTestId('chat-answer').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(heights[1]).toBeGreaterThan((heights[0] ?? 0) * 1.8);
  expect(heights[1]).toBeLessThan((heights[0] ?? 0) * 2.2);
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
  expect((await detail(page, id)).questions.map((q) => [q.state, q.answerIndex, q.answerText])).toEqual([
    ['answered', 2, null],
    ['answered', null, typed],
  ]);
  const ask = (await events(page, id)).find((e) => (e.payload as ToolPayload).name === 'AskUserQuestion')?.payload as ToolPayload | undefined;
  expect(ask?.result).toContain(`"${COLOR}"="Blue"`);
  expect(ask?.result).toContain(`"${SIZE}"="${typed}"`);
}

test('chat card: Blue + an own answer (Other…) reach the process verbatim; the answers bubble shows the text', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const before = (await controlResponses()).length;
  const { id } = await world.startSession(page, 'own-chat', '[fake:ask-2q] Ask me about the button.');
  await expect.poll(async () => (await detail(page, id)).status).toBe('need');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const card = page.getByTestId('session-chat').getByTestId('question-card');
  await expect(card).toHaveClass(/sb-qcard--chat/);

  const typed = await answerWithOwnWords(card, page, ['Medium, with rounded corners', 'and a "soft" shadow']);
  expect(await controlResponses()).toHaveLength(before);

  const answered = page.waitForResponse((r) => /\/api\/questions\/batch\/[^/]+\/answers$/.test(r.url()));
  await card.getByTestId('question-send').click();
  const response = await answered;
  expect(response.status()).toBe(204);
  expect(response.request().postDataJSON()).toEqual({
    answers: [
      { questionId: (await detail(page, id)).questions[0]?.id, answerIndex: 2 },
      { questionId: (await detail(page, id)).questions[1]?.id, text: typed },
    ],
  });
  await expectAnswersSent(before, typed);
  await expectAnswersBubble(page, id, typed);
});

test('Inbox card: Blue + an own answer (Other…) reach the process verbatim; the session chat shows the text in the answers bubble', async ({ page }) => {
  await page.goto(`${world.baseUrl}/inbox`);
  await expect(page.getByTestId('view-inbox')).toBeVisible();
  const before = (await controlResponses()).length;
  const { id } = await world.startSession(page, 'own-inbox', '[fake:ask-2q] Ask me about the button.');
  const items = page.getByTestId('inbox-item');
  await expect(items).toHaveCount(1);
  const card = page.getByTestId('question-card');
  await expect(card).toHaveClass(/sb-qcard--inbox/);

  const typed = await answerWithOwnWords(card, page, ['Whatever fits the 360 frame', 'no wider than the text field']);
  expect(await controlResponses()).toHaveLength(before);

  await card.getByTestId('question-send').click();
  await expect(items).toHaveCount(0);
  await expect(page.getByTestId('inbox-zero')).toBeVisible();
  await expectAnswersSent(before, typed);

  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expectAnswersBubble(page, id, typed);
});
