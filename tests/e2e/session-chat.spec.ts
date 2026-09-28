import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail, SessionEvent } from '../../src/core/api.ts';
import type { ToolPayload } from '../../src/core/event-payload.ts';
import { SESSION_START_HEADER } from '../../src/core/first-turn.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * M4.2 oracle, real path (D13, no demo seed): `node src/server/main.ts` with
 * fake-claude as the CLI and a temp workspace. The Chat tab shows the task and the
 * agent's tool steps (`tool-use`), the composer sends with Enter and with Send
 * (`POST /messages`), a quick reply only fills the draft, an `ask-2q` batch shows
 * as the inline question card (Send disabled at 45% until both are answered), its
 * answers reach the fake process (the tool result it built from them) and the card
 * turns into the answers bubble; a detached session refuses a message.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('session-chat');
});

test.afterAll(async () => {
  await world?.stop();
});

const TASK = '[fake:tool-use] Create out.txt and list the files.';
const ASK = '[fake:ask-2q] Ask me about the button.';

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

/** The chat's children in order, by test id (message role / card / answers). */
async function chatShape(page: Page): Promise<string[]> {
  return page.getByTestId('session-chat').evaluate((chat) =>
    [...chat.children].map((child) => {
      const id = child.getAttribute('data-testid') ?? child.className;
      const role = child.getAttribute('data-role');
      return role ? `${id}:${role}` : id;
    }),
  );
}

test('messages, tool steps, composer, quick reply, inline question card → answers bubble, detached refusal', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'chat-e2e', TASK);
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');

  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const chat = page.getByTestId('session-chat');
  // The task bubble, then the turn: it started with tools (a block of steps), then its text.
  await expect(chat.getByTestId('chat-message')).toHaveCount(3);
  await expect(chat.getByTestId('chat-text')).toHaveText([TASK, 'DONE']);
  await expect(chat.getByTestId('chat-step')).toHaveText(['✓ Write · out.txt', '✓ Bash · ls']);
  await expect(chat.locator('[data-testid="chat-message"][data-role="user"]')).toHaveAttribute('data-origin', 'task');
  expect(await chatShape(page)).toEqual(['chat-message:user', 'chat-message:agent', 'chat-message:agent']);

  // Composer: placeholder, a quick reply fills the draft and sends nothing.
  const input = page.getByTestId('chat-input');
  await expect(input).toHaveAttribute('placeholder', 'Message chat-e2e…');
  await expect(page.getByTestId('chat-quick-reply')).toHaveText(['Accept recommended', 'Match Figma exactly', 'Stop and ask designer', 'Commit when green']);
  await page.getByTestId('chat-quick-reply').nth(1).click();
  await expect(input).toHaveValue("Match the Figma frame exactly; don't add variants.");
  await expect(input).toBeFocused();
  await expect(chat.getByTestId('chat-message')).toHaveCount(3);

  // Enter sends: POST /messages → 202, the draft clears, the message shows, the batch arrives inline.
  await input.fill(ASK);
  const posted = page.waitForResponse((r) => r.url().endsWith(`/api/sessions/${id}/messages`) && r.request().method() === 'POST');
  await input.press('Enter');
  expect((await posted).status()).toBe(202);
  expect((await posted).request().postDataJSON()).toEqual({ text: ASK });
  await expect(input).toHaveValue('');
  await expect(chat.getByTestId('chat-text')).toHaveText([TASK, 'DONE', ASK]);

  const card = chat.getByTestId('question-card');
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/sb-qcard--chat/);
  await expect(card.getByTestId('question')).toHaveCount(2);
  await expect(card.locator('.sb-qcard__quote')).toHaveText(['“Which color should the button be?”', '“Which size should it be?”']);
  await expect(card.locator('.sb-qcard__source')).toHaveText(['acme-app-front', 'acme-app-front']);
  await expect(card.locator('.sb-qcard__head')).toHaveText('2 questions · relayed verbatim');
  await expect(card.getByTestId('question-status')).toHaveText('0 of 2 answered');
  const send = card.getByTestId('question-send');
  await expect(send).toHaveText('Send all answers');
  await expect(send).toBeDisabled();
  await expect(send).toHaveCSS('opacity', '0.45');
  expect((await detail(page, id)).status).toBe('need');

  await card.getByRole('button', { name: 'Green' }).click();
  await expect(card.getByTestId('question-status')).toHaveText('1 of 2 answered');
  await expect(send).toBeDisabled();
  await card.getByRole('button', { name: 'Small' }).click();
  await expect(card.getByTestId('question-status')).toHaveText('All answered. Each answer is written into the blocked brief word for word.');
  await expect(send).toBeEnabled();
  await expect(send).toHaveCSS('opacity', '1');

  const answered = page.waitForResponse((r) => /\/api\/questions\/batch\/[^/]+\/answers$/.test(r.url()));
  await send.click();
  expect((await answered).status()).toBe(204);

  // The card turns into the answers bubble + note, then the agent's reply follows.
  await expect(chat.getByTestId('question-card')).toHaveCount(0);
  await expect(chat.getByTestId('chat-answer')).toHaveText(['acme-app-front: Green', 'acme-app-front: Small']);
  await expect(chat.getByTestId('chat-answers-note')).toHaveText('● Answers written into the briefs. Blocked agents are resuming…');
  await expect(chat.getByTestId('chat-text')).toHaveText([TASK, 'DONE', ASK, 'You chose a green button in small size.']);
  expect(await chatShape(page)).toEqual([
    'chat-message:user',
    'chat-message:agent',
    'chat-message:agent',
    'chat-message:user',
    'chat-answers',
    'chat-answers-note',
    'chat-message:agent',
  ]);
  // The answers reached the process: the fake built its AskUserQuestion result from the control_response.
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
  const ask = (await events(page, id)).find((e) => (e.payload as ToolPayload).name === 'AskUserQuestion')?.payload as ToolPayload | undefined;
  expect(ask?.result).toContain('"Which color should the button be?"="Green"');
  expect(ask?.result).toContain('"Which size should it be?"="Small"');
  expect((await detail(page, id)).questions.map((q) => [q.state, q.answerIndex])).toEqual([
    ['answered', 1],
    ['answered', 0],
  ]);

  // Send (the button) works too; the fake's default turn answers "OK".
  await input.fill('  Thanks.  ');
  await page.getByTestId('chat-send').click();
  await expect(input).toHaveValue('');
  await expect(chat.getByTestId('chat-text')).toHaveText([TASK, 'DONE', ASK, 'You chose a green button in small size.', 'Thanks.', 'OK']);
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');

  // Continue in terminal: the service refuses a message until the session is attached again; the draft stays.
  await page.getByTestId('session-handoff').click();
  await expect(page.getByTestId('handoff-state')).toHaveText('in terminal');
  await input.fill('Are you there?');
  await input.press('Enter');
  await expect(page.getByTestId('chat-error')).toHaveText('Not sent: the session continues in a terminal; attach it first');
  await expect(input).toHaveValue('Are you there?');
  await expect(chat.getByTestId('chat-text')).toHaveCount(6);
  // Picking a quick reply clears the refusal.
  await page.getByTestId('chat-quick-reply').first().click();
  await expect(input).toHaveValue('Accept recommended: feature-building · single-solution · UI-first · sequential');
  await expect(page.getByTestId('chat-error')).toHaveCount(0);
});

test('D26: Shift+Enter adds a line (nothing is sent), the field grows up to 8 lines, Enter sends the lines, the field shrinks back', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'chat-lines', 'Reply OK.');
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const chat = page.getByTestId('session-chat');
  const input = page.getByTestId('chat-input');
  const sendButton = page.getByTestId('chat-send');
  await expect(chat.getByTestId('chat-message')).toHaveCount(2);
  const oneLine = (await input.boundingBox())?.height ?? 0;
  const sendHeight = (await sendButton.boundingBox())?.height ?? 0;
  expect(oneLine).toBeGreaterThan(30);

  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith(`/api/sessions/${id}/messages`)) posts += 1;
  });
  await input.click();
  await page.keyboard.type('line one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('line two');
  await expect(input).toHaveValue('line one\nline two');
  expect(posts).toBe(0);
  // Two lines: the field is taller; Send keeps its one-line height.
  await expect.poll(async () => (await input.boundingBox())?.height ?? 0).toBeGreaterThan(oneLine + 10);
  expect(Math.round((await sendButton.boundingBox())?.height ?? 0)).toBe(Math.round(sendHeight));

  // Twelve lines: the field stops at 8 lines and scrolls.
  for (let line = 3; line <= 12; line += 1) {
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type(`line ${line}`);
  }
  const tall = (await input.boundingBox())?.height ?? 0;
  expect(tall).toBeLessThan(oneLine * 5);
  await expect(input).toHaveCSS('overflow-y', 'auto');
  expect(posts).toBe(0);

  // Enter sends every line; the bubble keeps them; the field is one line again.
  const text = Array.from({ length: 12 }, (_, index) => (index === 0 ? 'line one' : index === 1 ? 'line two' : `line ${index + 1}`)).join('\n');
  const posted = page.waitForResponse((r) => r.url().endsWith(`/api/sessions/${id}/messages`) && r.request().method() === 'POST');
  await page.keyboard.press('Enter');
  expect((await posted).request().postDataJSON()).toEqual({ text });
  await expect(input).toHaveValue('');
  await expect.poll(async () => Math.round((await input.boundingBox())?.height ?? 0)).toBe(Math.round(oneLine));
  const bubble = chat.locator('[data-testid="chat-message"][data-role="user"]').last().getByTestId('chat-text');
  expect(await bubble.innerText()).toBe(text);
});

test('a session started without a task: the first message shows what the developer typed; the answers block reaches the agent only (bug 2026-09-28)', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'chat-no-task', '');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const chat = page.getByTestId('session-chat');
  const input = page.getByTestId('chat-input');
  await input.fill('apply rules from AGENTS.md. Reply OK.');
  await input.press('Enter');
  // The bubble is the typed text, not empty and not the block.
  const bubble = chat.locator('[data-testid="chat-message"][data-role="user"]').first().getByTestId('chat-text');
  await expect(bubble).toHaveText('apply rules from AGENTS.md. Reply OK.');
  // What the agent got: the answers block first, then the typed text.
  await expect
    .poll(async () => {
      const list = await events(page, id);
      const user = list.find((event) => (event.payload as { type?: string } | null)?.type === 'user');
      return (user?.payload as { text?: string } | undefined)?.text ?? '';
    })
    .toMatch(new RegExp(`^${SESSION_START_HEADER[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*\\n\\napply rules from AGENTS\\.md\\. Reply OK\\.$`));
});
