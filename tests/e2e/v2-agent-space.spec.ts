import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.0 · the agent view gives the chat the room: a one-row header
 * (≤ ~56 px on a desktop), a composer that grows with the text only up to about
 * a third of the screen and then scrolls inside, the chat keeping at least ~55 %
 * of the height, at 1440 × 900 and on a phone (390 × 844); a long message of
 * yours folds after about 12 lines with Show more; a code block's Copy and Save as
 * result sit in their own strip above the code, never over its first line.
 */
let world: QuestionWorld;
let sessionId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-agent-space', { env: { ...V2_SERVER_ENV } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function settled(page: Page, id: string): Promise<void> {
  await expect
    .poll(async () => page.evaluate(async (sid) => ((await (await fetch(`/api/sessions/${encodeURIComponent(sid)}`)).json()) as SessionDetail).status, id), { timeout: 20_000 })
    .toMatch(/^(done|idle)$/);
}

async function post(page: Page, id: string, text: string): Promise<void> {
  const status = await page.evaluate(
    async ({ sid, body }) => (await fetch(`/api/sessions/${encodeURIComponent(sid)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: body }) })).status,
    { sid: id, body: text },
  );
  expect(status).toBe(202);
}

const TABLE = ['```', '+--------+--------+', '| Acme   | Total  |', '+--------+--------+', '| North  |     12 |', '+--------+--------+', '```'].join('\n');
const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the long Acme brief.`).join('\n');

test('setup: an agent with a long message of yours and a reply with a code block', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'v2-space', 'Say hello.');
  sessionId = id;
  await settled(page, id);
  await post(page, id, `${LONG}\n[fake:say ${JSON.stringify(`The totals:\n\n${TABLE}\n\nDone.`)}]`);
  await settled(page, id);
});

async function measure(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await openWithHub(page, `${world.baseUrl}/agents/${sessionId}`);
  await expect(page.getByTestId('v2-agent-reply').last()).toContainText('Done.');
  const input = page.getByTestId('v2-agent-input');
  await input.fill(LONG);
  const header = await page.getByTestId('v2-agent-header').boundingBox();
  const dock = await page.getByTestId('v2-agent-dock').boundingBox();
  const chat = await page.getByTestId('v2-agent-chat').boundingBox();
  const box = await input.evaluate((el) => ({ height: el.getBoundingClientRect().height, scroll: el.scrollHeight, client: el.clientHeight, overflowY: getComputedStyle(el).overflowY }));
  console.log(`[space ${viewport.width}x${viewport.height}] header=${Math.round(header?.height ?? -1)} dock=${Math.round(dock?.height ?? -1)} chat=${Math.round(chat?.height ?? -1)} input=${Math.round(box.height)} (scroll ${box.scroll} > client ${box.client}, overflow-y ${box.overflowY})`);
  // The composer stays at about a third of the screen at most and scrolls inside.
  expect(dock?.height ?? 0).toBeLessThanOrEqual(viewport.height * 0.36);
  expect(box.scroll).toBeGreaterThan(box.client);
  expect(['auto', 'scroll']).toContain(box.overflowY);
  // The chat keeps most of the height.
  expect(chat?.height ?? 0).toBeGreaterThanOrEqual(viewport.height * 0.55);
  await input.fill('');
}

test('desktop 1440 × 900: a one-row header, a capped composer, the chat dominant', async ({ page }) => {
  await measure(page, { width: 1440, height: 900 });
  const header = await page.getByTestId('v2-agent-header').boundingBox();
  expect(header?.height ?? 99).toBeLessThanOrEqual(56);
  // The title, its status and the overflow ⓘ are in that row.
  await expect(page.getByTestId('v2-agent-title')).toBeVisible();
  await page.getByTestId('v2-agent-info').click();
  await expect(page.getByTestId('v2-agent-info-pop')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('phone 390 × 844: one header row (back, title, status, ⋯), a capped composer', async ({ page }) => {
  await measure(page, { width: 390, height: 844 });
  const header = await page.getByTestId('v2-agent-header').boundingBox();
  expect(header?.height ?? 99).toBeLessThanOrEqual(60);
  await expect(page.getByTestId('v2-agent-back')).toBeVisible();
  await expect(page.getByTestId('v2-agent-menu')).toBeVisible();
});

test('a long message of yours folds after about 12 lines with Show more', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWithHub(page, `${world.baseUrl}/agents/${sessionId}`);
  const mine = page.getByTestId('v2-agent-you').filter({ hasText: 'Line 1 of the long Acme brief.' });
  await expect(mine).toHaveCount(1);
  const more = mine.getByTestId('v2-agent-you-more');
  await expect(more).toHaveText('Show more');
  const pill = mine.locator('.v2-ag-pill');
  const folded = (await pill.boundingBox())?.height ?? 0;
  await more.click();
  await expect(more).toHaveText('Show less');
  const open = (await pill.boundingBox())?.height ?? 0;
  expect(folded).toBeLessThanOrEqual(15 * 1.45 * 12 + 40);
  expect(open).toBeGreaterThan(folded + 100);
});

test('a code block’s Copy and Save as result never cover its first line', async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await openWithHub(page, `${world.baseUrl}/agents/${sessionId}`);
    const block = page.getByTestId('v2-agent-reply').last().locator('.sb-md-code');
    await expect(block).toBeVisible();
    // The first text line of the block: a range over its first character's line.
    const line = await block.locator('pre').evaluate((pre) => {
      const range = document.createRange();
      const text = pre.firstChild?.firstChild ?? pre.firstChild;
      if (!text) return null;
      range.setStart(text, 0);
      range.setEnd(text, Math.min(20, text.textContent?.length ?? 0));
      const rect = range.getClientRects()[0];
      return rect ? { x: rect.left, y: rect.top, width: pre.getBoundingClientRect().width, height: rect.height, left: pre.getBoundingClientRect().left } : null;
    });
    expect(line).not.toBeNull();
    for (const id of ['chat-code-copy', 'chat-code-save']) {
      const button = await block.getByTestId(id).boundingBox();
      expect(button).not.toBeNull();
      if (!button || !line) continue;
      const overlapY = button.y < line.y + line.height && line.y < button.y + button.height;
      const overlapX = button.x < line.left + line.width && line.left < button.x + button.width;
      expect(overlapY && overlapX, `${id} at ${viewport.width}`).toBe(false);
      if (viewport.width < 768) expect(button.height).toBeGreaterThanOrEqual(44);
    }
    // Reachable by keyboard.
    await block.getByTestId('chat-code-copy').focus();
    await expect(block.getByTestId('chat-code-copy')).toBeFocused();
  }
});
