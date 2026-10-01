import { rm } from 'node:fs/promises';
import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail, SessionEvent } from '../../src/core/api.ts';
import { type AssistantPayload, PAYLOAD_TEXT_LIMIT } from '../../src/core/event-payload.ts';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { TRANSCRIPT_GONE } from '../../src/server/sessions/full-event.ts';
import { claudeConfigDir, findTranscriptFile } from '../../src/server/supervisor/attach.ts';
import { SAY_LONG_END } from '../../tools/fake-claude/scenarios.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * Fix · long messages, real path (D13, no demo seed): `node src/server/main.ts`
 * with fake-claude as the CLI. A reply over 4,000 characters shows whole in the
 * chat. A reply stored cut before the fix (seeded into the database: its text cut
 * at 4,000, no flag) shows "Message cut at 4,000 characters · Show full message";
 * the button restores it from the session's CLI transcript, and it stays whole
 * after a reload (written back). With the transcript gone, the note says so.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('long-messages');
});

test.afterAll(async () => {
  await world?.stop();
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as SessionDetail, id);
}

async function events(page: Page, id: string): Promise<SessionEvent[]> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`)).json()) as SessionEvent[], id);
}

/** Runs a session whose reply is `chars` long; answers its id, its CLI session id and its reply's event. */
async function longReplySession(page: Page, name: string, chars: number): Promise<{ id: string; claudeSessionId: string; reply: SessionEvent }> {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, name, `Write a long reply. [fake:say-long ${chars}]`);
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
  const reply = (await events(page, id)).find((event) => (event.payload as { type?: string }).type === 'assistant');
  expect(reply).toBeDefined();
  return { id, claudeSessionId: (await detail(page, id)).claudeSessionId, reply: reply as SessionEvent };
}

/** Stores the event as the recorder did before the fix: its text cut at 4,000 characters, no flag. */
async function cutLikeBefore(event: SessionEvent): Promise<void> {
  const store = await openStore(storeFile(world.dataDir));
  try {
    const payload = event.payload as AssistantPayload;
    await store.events.update(event.id, { payload: { type: 'assistant', text: payload.text.slice(0, PAYLOAD_TEXT_LIMIT), messageId: payload.messageId } });
  } finally {
    await store.close();
  }
}

test('a 9,000-character reply shows whole, with no cut note', async ({ page }) => {
  const { id, reply } = await longReplySession(page, 'long-reply-e2e', 9000);
  expect((reply.payload as AssistantPayload).text).toHaveLength(9000);
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const agent = page.getByTestId('session-chat').locator('[data-testid="chat-message"][data-role="agent"]');
  await expect(agent).toHaveCount(1);
  await expect(agent.getByTestId('chat-markdown')).toContainText('Paragraph 1:');
  await expect(agent.getByTestId('chat-markdown')).toContainText(SAY_LONG_END);
  await expect(page.getByTestId('chat-cut')).toHaveCount(0);
});

test('a reply stored cut before the fix: "Show full message" restores it from the transcript, and it stays whole', async ({ page }) => {
  const { id, reply } = await longReplySession(page, 'cut-reply-e2e', 7000);
  await cutLikeBefore(reply);
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const agent = page.getByTestId('session-chat').locator('[data-testid="chat-message"][data-role="agent"]');
  await expect(agent).toHaveCount(1);
  const note = agent.getByTestId('chat-cut');
  await expect(note).toBeVisible();
  await expect(note.getByTestId('chat-cut-note')).toHaveText('Message cut at 4,000 characters');
  await expect(agent.getByTestId('chat-markdown')).not.toContainText(SAY_LONG_END);

  await note.getByRole('button', { name: 'Show full message' }).click();
  await expect(agent.getByTestId('chat-markdown')).toContainText(SAY_LONG_END);
  await expect(page.getByTestId('chat-cut')).toHaveCount(0);

  // Written back: a fresh load shows it whole without asking again.
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(agent.getByTestId('chat-markdown')).toContainText(SAY_LONG_END);
  await expect(page.getByTestId('chat-cut')).toHaveCount(0);
  const stored = (await events(page, id)).find((event) => event.id === reply.id);
  expect((stored?.payload as AssistantPayload).text).toHaveLength(7000);
});

test('with the transcript gone, the note says the full text cannot be restored', async ({ page }) => {
  const { id, claudeSessionId, reply } = await longReplySession(page, 'gone-reply-e2e', 5000);
  await cutLikeBefore(reply);
  const transcript = await findTranscriptFile(claudeConfigDir({ CLAUDE_CONFIG_DIR: world.configDir }), claudeSessionId);
  expect(transcript).not.toBeNull();
  await rm(transcript as string);
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const note = page.getByTestId('chat-cut');
  await note.getByRole('button', { name: 'Show full message' }).click();
  await expect(note.getByTestId('chat-cut-error')).toHaveText(TRANSCRIPT_GONE);
  await expect(note).toHaveAttribute('data-state', 'failed');
  await expect(note.getByRole('button', { name: 'Show full message' })).toBeVisible();
});
