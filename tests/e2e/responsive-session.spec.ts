import { expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { SIZES, expectInsideWindow, expectNoOverflow, newTouchPage, touchContext } from './responsive-world.ts';

/**
 * D74 oracle (docs/responsive.md → Session view), real path (fake-claude, no demo
 * seed): at every compact size a session is usable on a touch screen: the
 * composer is on screen at the bottom, a message sent with its Send button gets
 * the agent's reply, the tabs switch, the right panel opens as a drawer (tablet)
 * or a bottom sheet (phone) from the header and its scrim closes it; nothing
 * overflows sideways.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('responsive-session');
});

test.afterAll(async () => {
  await world?.stop();
});

async function detail(page: import('@playwright/test').Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as SessionDetail, id);
}

// The four sizes and a common phone (390×844), where a too-wide sheet once showed.
for (const size of [...SIZES, { name: 'phone portrait (390)', width: 390, height: 844 }]) {
  test(`${size.name} ${size.width}×${size.height}: send a message, switch tabs, open the right panel`, async ({ browser }) => {
    const context = await touchContext(browser, size);
    const page = await newTouchPage(context);
    await page.goto(`${world.baseUrl}/`);
    const { id } = await world.startSession(page, `responsive-${size.width}`, 'Reply with exactly: first-ok');
    await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
    // The first turn's reply, then Send is back (no turn running).
    await expect(page.getByTestId('session-chat').getByTestId('chat-text').last()).toHaveText('OK', { timeout: 20_000 });
    await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: 20_000 });

    // The composer: on screen, at the bottom.
    const input = page.getByTestId('chat-input');
    const send = page.getByTestId('chat-send');
    await expectInsideWindow(input, size, 'composer field');
    await expectInsideWindow(send, size, 'Send');
    const field = await input.boundingBox();
    expect(field && field.y + field.height).toBeGreaterThan(size.height - 120);

    await input.fill('Reply with exactly: touch-ok');
    await send.tap();
    const chat = page.getByTestId('session-chat');
    await expect(chat.locator('[data-testid="chat-message"][data-role="user"]').filter({ hasText: 'touch-ok' })).toBeVisible();
    await expect.poll(async () => (await detail(page, id)).status, { timeout: 20_000 }).toBe('done');
    // Two messages and two replies.
    await expect(chat.getByTestId('chat-text')).toHaveCount(4, { timeout: 20_000 });
    await expect(chat.getByTestId('chat-text').last()).toHaveText('OK');
    await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: 20_000 });
    await expectNoOverflow(page, size.width, 'session chat');

    // A wide code block and a wide table scroll inside themselves, never the page.
    const wide = [
      'Code:',
      '',
      '```',
      `const line = '${'x'.repeat(240)}';`,
      '```',
      '',
      '| Column one | Column two | Column three | Column four | Column five | Column six |',
      '|---|---|---|---|---|---|',
      `| ${'a'.repeat(30)} | ${'b'.repeat(30)} | ${'c'.repeat(30)} | ${'d'.repeat(30)} | ${'e'.repeat(30)} | ${'f'.repeat(30)} |`,
    ].join('\n');
    await input.fill(`[fake:say "${JSON.stringify(wide).slice(1, -1)}"] Show wide content.`);
    await send.tap();
    const code = chat.locator('.sb-md pre').last();
    await expect(code).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: 20_000 });
    expect(await code.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expectInsideWindow(code, { ...size, height: 100_000 }, 'code block');
    await expectNoOverflow(page, size.width, 'wide code and table');

    // The tabs.
    for (const tab of ['timeline', 'diff', 'artifacts', 'chat'] as const) {
      await page.getByTestId(`session-tab-${tab}`).tap();
      await expect(page.getByTestId('view-session')).toHaveAttribute('data-tab', tab);
      await expectNoOverflow(page, size.width, `tab ${tab}`);
    }

    // The right panel: a drawer / bottom sheet from the header's panel button.
    const panel = page.getByTestId('session-right-panel');
    await expect(panel).toHaveAttribute('inert', '');
    await page.getByTestId('panel-open').tap();
    await expect(panel).not.toHaveAttribute('inert');
    await page.waitForTimeout(250);
    await expectInsideWindow(panel, size, 'right panel');
    await expectNoOverflow(page, size.width, 'right panel open');
    await expect(panel.getByTestId('agent-card').first()).toBeVisible();
    if (size.width < 768) {
      const sheet = await panel.boundingBox();
      // A bottom sheet: the full width, anchored at the bottom.
      expect(sheet?.width).toBe(size.width);
      expect(Math.round((sheet?.y ?? 0) + (sheet?.height ?? 0))).toBe(size.height);
    }
    await page.getByTestId('panel-scrim').click({ position: { x: 8, y: 8 } });
    await expect(panel).toHaveAttribute('inert', '');
    await context.close();
  });
}
