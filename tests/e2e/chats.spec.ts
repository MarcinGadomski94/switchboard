import { mkdir } from 'node:fs/promises';
import { type Page, expect, test } from '@playwright/test';
import type { Session, SessionDetail } from '../../src/core/api.ts';
import { CHAT_LOCKED_HINT } from '../../src/core/chats.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D106 on the real path (D13, fake-claude): a chat started from the sidebar and from
 * ⌘K, its own CHATS section (SESSIONS never lists it), the chat badge and the locked
 * plan-mode hint in its header (no Diff tab), and ⋯ → Continue as session… carrying
 * it into a new session through the New-session form. `CHATS_SHOTS=<dir>` writes screenshots.
 */
let world: QuestionWorld;
const SHOTS = process.env['CHATS_SHOTS'] ?? null;

test.beforeAll(async () => {
  world = await startQuestionWorld('chats');
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

function chatIdOf(page: Page): string {
  return decodeURIComponent(new URL(page.url()).pathname.split('/')[2] ?? '');
}

test('New chat from the sidebar: its own CHATS section, the chat badge, the locked plan-mode hint, no Diff tab', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/`);
  // No chats yet: no CHATS section; the SESSIONS label's chat button is the way in.
  await expect(page.getByTestId('sidebar-chats')).toHaveCount(0);
  await page.getByTestId('sidebar-sessions-new-chat').click();
  const form = page.getByTestId('modal-new-chat');
  await expect(form).toBeVisible();
  await expect(form.getByTestId('nc-sub')).toHaveText(CHAT_LOCKED_HINT);
  await form.getByTestId('nc-message').fill('How should we split the billing module?\nThink it through with me.');
  await expect(form.getByTestId('nc-title-preview')).toHaveText('Title: How should we split the billing module?');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/new-chat-form.png` });
  await form.getByTestId('nc-start').click();
  await expect(form).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/sessions\//);
  const id = chatIdOf(page);
  await expect.poll(async () => (await api<SessionDetail>(page, 'GET', `/api/sessions/${id}`)).status, { timeout: 15_000 }).toBe('done');

  // The header: title, the chat badge, the locked mode with its hint; no Diff tab; no terminal / Remote.
  await expect(page.getByTestId('session-name')).toHaveText('How should we split the billing module?');
  await expect(page.getByTestId('session-chat-badge')).toHaveText('chat');
  const locked = page.getByTestId('chat-mode-locked');
  await expect(locked).toContainText('Plan mode');
  await expect(locked).toHaveAttribute('title', CHAT_LOCKED_HINT);
  await expect(page.getByTestId('session-tab-diff')).toHaveCount(0);
  await expect(page.getByTestId('session-tab-chat')).toBeVisible();
  await expect(page.getByTestId('session-handoff')).toHaveCount(0);
  await expect(page.getByTestId('session-remote')).toHaveCount(0);

  // The sidebar: CHATS lists it (SESSIONS does not).
  const chats = page.getByTestId('sidebar-chats');
  await expect(chats.getByTestId('sidebar-chats-head')).toContainText('Chats');
  await expect(chats.locator(`a.sb-chat-row[data-session-id="${id}"]`)).toContainText('How should we split the billing module?');
  await expect(chats.getByTestId('sidebar-chat-line')).toHaveText('plan mode');
  await expect(page.getByTestId('sidebar-sessions').locator(`a.sb-session[data-session-id="${id}"]`)).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-view.png` });

  // "+ New chat" in the CHATS label opens the form too.
  await chats.getByTestId('sidebar-new-chat').click();
  await expect(page.getByTestId('modal-new-chat')).toBeVisible();
  await page.getByTestId('nc-cancel').click();
  await expect(page.getByTestId('modal-new-chat')).toHaveCount(0);
});

test('⌘K: New chat and Chats', async ({ page }) => {
  test.setTimeout(60_000);
  await openWithHub(page, `${world.baseUrl}/`);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('palette-input').fill('new chat');
  await expect(page.getByTestId('palette-row').first()).toContainText('New chat');
  await page.keyboard.press('Enter');
  const form = page.getByTestId('modal-new-chat');
  await expect(form).toBeVisible();
  await form.getByTestId('nc-message').fill('A second question to think about');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(form).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/sessions\//);
  const id = chatIdOf(page);
  await expect(page.getByTestId('session-chat-badge')).toBeVisible();

  // Chats: the palette lists the chat, and "Chats" focuses the CHATS section.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('palette-input').fill('second question');
  await expect(page.getByTestId('palette-row').first()).toContainText('A second question to think about');
  await page.getByTestId('palette-input').fill('chats');
  await expect(page.getByTestId('palette-row').filter({ hasText: /^.*Chats/ }).first()).toBeVisible();
  await page.getByTestId('palette-row').filter({ hasText: 'Chats' }).first().click();
  await expect(page.getByTestId('modal-palette')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-chats-head')).toBeFocused();
  await expect(page.getByTestId('sidebar-chats').locator(`a.sb-chat-row[data-session-id="${id}"]`)).toBeVisible();
});

test('⋯ → Continue as session… opens the New-session form pre-filled; the new session carries the chat; the chat stays, "continued as"', async ({ page }) => {
  test.setTimeout(120_000);
  await openWithHub(page, `${world.baseUrl}/`);
  const chat = await api<Session>(page, 'POST', '/api/chats', { message: 'Plan the login rework' });
  await expect.poll(async () => (await api<SessionDetail>(page, 'GET', `/api/sessions/${chat.id}`)).status, { timeout: 15_000 }).toBe('done');
  await openWithHub(page, `${world.baseUrl}/sessions/${chat.id}`);
  await page.getByTestId('chat-menu').click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-menu.png` });
  await page.getByTestId('chat-continue-as-session').click();
  const form = page.getByTestId('modal-new-session');
  await expect(form).toBeVisible();
  await expect(form.getByTestId('ns-from-chat')).toContainText('Continues the chat “Plan the login rework”');
  // The remembered (Simple) form on a fresh install.
  await expect(form).toHaveAttribute('data-mode', 'simple');
  await form.getByTestId('ns-message').fill('Implement the plan.');
  await form.getByTestId('ns-simple-title').fill('Login rework');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/continue-as-session-form.png` });
  await form.getByTestId('ns-start').click();
  await expect(form).toHaveCount(0);
  await expect.poll(() => chatIdOf(page)).not.toBe(chat.id);
  const sessionId = chatIdOf(page);
  const session = await api<SessionDetail>(page, 'GET', `/api/sessions/${sessionId}`);
  expect(session.kind).toBeUndefined();
  expect(session.continuedFrom).toEqual({ sessionId: chat.id, title: 'Plan the login rework' });
  // The new session's chat starts with the divider back to the chat.
  await expect(page.getByTestId('chat-divider-link').filter({ hasText: 'Continued from the chat Plan the login rework' })).toBeVisible();

  // The chat stays in CHATS, "continued as Login rework", with a link.
  const row = page.getByTestId('sidebar-chats').locator(`a.sb-chat-row[data-session-id="${chat.id}"]`);
  await expect(row.getByTestId('sidebar-chat-line')).toHaveText('continued as Login rework');
  await row.click();
  await expect(page.getByTestId('session-continued-in-note')).toContainText('Continued as Login rework');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-continued.png` });
  await page.getByTestId('session-continued-in-link').click();
  await expect.poll(() => chatIdOf(page)).toBe(sessionId);
});
