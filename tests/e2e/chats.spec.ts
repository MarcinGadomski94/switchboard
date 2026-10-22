import { mkdir } from 'node:fs/promises';
import { type Page, expect, test } from '@playwright/test';
import type { Session, SessionDetail } from '../../src/core/api.ts';
import { CHAT_LOCKED_HINT } from '../../src/core/chats.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { openDrawer, touchContext } from './responsive-world.ts';

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
  // No chats yet: the CHATS header is there anyway (0), with "+ New chat"; its list is empty.
  await expect(page.getByTestId('sidebar-chats-head')).toContainText('Chats');
  await expect(page.getByTestId('chats-count')).toHaveText('0');
  await expect(page.getByTestId('sidebar-chat')).toHaveCount(0);
  await expect(page.getByTestId('sessions-head')).toContainText('Sessions');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sidebar-no-chats.png` });
  await page.getByTestId('sidebar-new-chat').click();
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
  await expect(page.getByTestId('sidebar-chats-head')).toContainText('Chats');
  await expect(page.getByTestId('chats-count')).toHaveText('1');
  await expect(chats.locator(`a.sb-chat-row[data-session-id="${id}"]`)).toContainText('How should we split the billing module?');
  await expect(chats.getByTestId('sidebar-chat-line')).toHaveText('plan mode');
  await expect(page.getByTestId('sidebar-sessions').locator(`a.sb-session[data-session-id="${id}"]`)).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-view.png` });

  // "+ New chat" in the CHATS label opens the form again.
  await page.getByTestId('sidebar-new-chat').click();
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

test('SESSIONS and CHATS fold to their headers (▾ / ▸, with their counts), kept per install', async ({ page }) => {
  test.setTimeout(60_000);
  await openWithHub(page, `${world.baseUrl}/`);
  const setting = (key: string) => page.evaluate(async (k) => (await (await fetch('/api/settings')).json())[k] as unknown, key);
  await expect(page.getByTestId('sidebar-chat').first()).toBeVisible();
  const chatCount = await page.getByTestId('chats-count').textContent();
  // Fold both.
  await page.getByTestId('chats-toggle').click();
  await page.getByTestId('sessions-toggle').click();
  await expect(page.getByTestId('chats-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('sessions-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('chats-toggle')).toContainText('▸');
  await expect(page.getByTestId('sidebar-chats')).toBeHidden();
  await expect(page.getByTestId('sidebar-sessions')).toBeHidden();
  // A folded section still shows its count; "+ New chat" stays on the header.
  await expect(page.getByTestId('chats-count')).toHaveText(chatCount ?? '');
  await expect(page.getByTestId('sidebar-new-chat')).toBeVisible();
  await expect.poll(() => setting('ui.chatsCollapsed')).toBe(true);
  await expect.poll(() => setting('ui.sessionsCollapsed')).toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sidebar-folded.png` });
  // Kept across a reload (read before the first paint).
  await page.reload();
  await expect(page.getByTestId('chats-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('sidebar-sessions')).toBeHidden();
  // ⌘K → Chats unfolds CHATS.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('palette-input').fill('chats');
  await page.getByTestId('palette-row').filter({ hasText: 'Chats' }).first().click();
  await expect(page.getByTestId('sidebar-chats')).toBeVisible();
  await expect.poll(() => setting('ui.chatsCollapsed')).toBe(false);
  // Unfold SESSIONS again.
  await page.getByTestId('sessions-toggle').click();
  await expect(page.getByTestId('sidebar-sessions')).toBeVisible();
  await expect.poll(() => setting('ui.sessionsCollapsed')).toBe(false);
});

/** Starts a chat through the API and waits for its first turn to end. */
async function chatDone(page: Page, message: string): Promise<Session> {
  const chat = await api<Session>(page, 'POST', '/api/chats', { message });
  await expect.poll(async () => (await api<SessionDetail>(page, 'GET', `/api/sessions/${chat.id}`)).status, { timeout: 15_000 }).toBe('done');
  return chat;
}

test('Rename (2026-10-22) from the sidebar row ⋯: Rename… edits the title in place; Esc cancels; Enter saves (trimmed); it persists after a reload; a double-click edits too', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/`);
  const chat = await chatDone(page, 'Plan the Acme invoices');
  await openWithHub(page, `${world.baseUrl}/`);
  const row = page.getByTestId('sidebar-chats').locator(`a.sb-chat-row[data-session-id="${chat.id}"]`);
  await expect(row.locator('.sb-session-name')).toHaveText('Plan the Acme invoices');

  // Keyboard only: focus the row's ⋯, open it, Enter on Rename….
  await row.getByTestId('sidebar-chat-menu').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('sidebar-chat-menu-rename')).toBeFocused();
  await page.keyboard.press('Enter');
  const input = row.getByTestId('title-input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Plan the Acme invoices');
  await expect(input).toHaveAttribute('aria-label', 'Chat title');
  // Esc cancels: nothing saved.
  await input.fill('Discarded');
  await page.keyboard.press('Escape');
  await expect(row.getByTestId('title-input')).toHaveCount(0);
  await expect(row.locator('.sb-session-name')).toHaveText('Plan the Acme invoices');
  expect((await api<SessionDetail>(page, 'GET', `/api/sessions/${chat.id}`)).title).toBe('Plan the Acme invoices');

  // Enter saves, trimmed; the URL stays (the row's link is not followed).
  const before = page.url();
  await row.hover();
  await row.getByTestId('sidebar-chat-menu').click();
  await page.getByTestId('sidebar-chat-menu-rename').click();
  await row.getByTestId('title-input').fill('  Acme invoice plan  ');
  await page.keyboard.press('Enter');
  await expect(row.locator('.sb-session-name')).toHaveText('Acme invoice plan');
  expect(page.url()).toBe(before);
  await expect.poll(async () => (await api<SessionDetail>(page, 'GET', `/api/sessions/${chat.id}`)).title).toBe('Acme invoice plan');

  // A reload keeps it.
  await openWithHub(page, `${world.baseUrl}/`);
  await expect(row.locator('.sb-session-name')).toHaveText('Acme invoice plan');

  // A double-click on the title edits it too (like a session row).
  await row.locator('.sb-session-name').dblclick();
  await row.getByTestId('title-input').fill('Acme invoices, round two');
  await page.keyboard.press('Enter');
  await expect(row.locator('.sb-session-name')).toHaveText('Acme invoices, round two');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-renamed-sidebar.png` });
});

test('Rename (2026-10-22) from the chat header: a click on the title and ⋯ → Rename…; Esc cancels; an emptied field reverts; persists after a reload', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/`);
  const chat = await chatDone(page, 'Plan the Acme search');
  await openWithHub(page, `${world.baseUrl}/sessions/${chat.id}`);
  const name = page.getByTestId('session-name');
  await expect(name).toHaveText('Plan the Acme search');

  // A click on the title: Esc cancels.
  await name.click();
  const input = page.getByTestId('session-header').getByTestId('title-input');
  await expect(input).toBeFocused();
  await input.fill('Not this');
  await page.keyboard.press('Escape');
  await expect(name).toHaveText('Plan the Acme search');

  // ⋯ → Rename…: Enter saves.
  await page.getByTestId('chat-menu').click();
  await page.getByTestId('chat-rename').click();
  await expect(input).toBeFocused();
  await input.fill('Acme search plan');
  await page.keyboard.press('Enter');
  await expect(name).toHaveText('Acme search plan');
  // The sidebar row follows (sessionUpdated).
  await expect(page.getByTestId('sidebar-chats').locator(`a.sb-chat-row[data-session-id="${chat.id}"] .sb-session-name`)).toHaveText('Acme search plan');

  // An emptied field on a titled chat clears the title: back to the chat's own name (the session rule).
  await name.click();
  await input.fill('   ');
  await page.keyboard.press('Enter');
  const cleared = await api<SessionDetail>(page, 'GET', `/api/sessions/${chat.id}`);
  await expect.poll(async () => (await api<SessionDetail>(page, 'GET', `/api/sessions/${chat.id}`)).title).toBeNull();
  await expect(name).toHaveText(cleared.name);

  // Named again, then a reload keeps it.
  await name.click();
  await input.fill('Acme search plan');
  await page.keyboard.press('Enter');
  await expect(name).toHaveText('Acme search plan');
  await openWithHub(page, `${world.baseUrl}/sessions/${chat.id}`);
  await expect(page.getByTestId('session-name')).toHaveText('Acme search plan');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-renamed-header.png` });
});

test('Rename (2026-10-22) at phone width (360, touch): the row ⋯ → Rename… in the drawer; the header ⋯ → Rename…', async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await touchContext(browser, { name: 'phone portrait', width: 360, height: 740 });
  const page = await context.newPage();
  try {
    await openWithHub(page, `${world.baseUrl}/`);
    const chat = await chatDone(page, 'Plan the Acme phone app');
    await openWithHub(page, `${world.baseUrl}/sessions/${chat.id}`);
    await openDrawer(page);
    const row = page.getByTestId('sidebar-chats').locator(`a.sb-chat-row[data-session-id="${chat.id}"]`);
    await row.getByTestId('sidebar-chat-menu').tap();
    // On a touch screen the menu also closes the chat (the × needs a hover).
    await expect(page.getByTestId('sidebar-chat-menu-close')).toBeVisible();
    await page.getByTestId('sidebar-chat-menu-rename').tap();
    const input = row.getByTestId('title-input');
    await expect(input).toBeVisible();
    const box = await input.boundingBox();
    expect(box && box.x + box.width <= 360).toBe(true);
    await input.fill('Acme phone plan');
    await page.keyboard.press('Enter');
    await expect(row.locator('.sb-session-name')).toHaveText('Acme phone plan');
    await expect.poll(async () => (await api<SessionDetail>(page, 'GET', `/api/sessions/${chat.id}`)).title).toBe('Acme phone plan');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-renamed-phone.png` });

    // The header's ⋯ → Rename… (the drawer closed).
    await page.keyboard.press('Escape');
    await openWithHub(page, `${world.baseUrl}/sessions/${chat.id}`);
    await page.getByTestId('chat-menu').tap();
    await page.getByTestId('chat-rename').tap();
    const field = page.getByTestId('session-header').getByTestId('title-input');
    await field.fill('Acme phone plan v2');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('session-name')).toHaveText('Acme phone plan v2');
  } finally {
    await context.close();
  }
});
