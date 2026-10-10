import { type Page, expect, test } from '@playwright/test';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { appendHistory } from '../../tools/bench/world.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D95 · long sessions (`docs/performance.md`): a real fake-claude session grown to
 * ≈13,000 events (≈32 MB, the synthetic history of the benchmark harness) and a
 * second one of ≈2,000. Guards:
 * 1. **The chat renders a window, not the history.** Opening the big session shows
 *    its newest message with at most {@link MAX_MESSAGES} message nodes (the whole
 *    history is ≈2,100) and the "Show earlier messages" row; loading earlier
 *    messages adds them in front without moving the message that was on top.
 * 2. **Switching sessions does not grow the page.** The JS heap (after a forced
 *    GC) and the renderer's node count after five rounds of switching between the
 *    two sessions stay where they were after the first round, and the heap stays
 *    under 30 MB (≈15 MB measured; ≈50 MB when every visit kept a whole history).
 */
test.use({ trace: 'off' });

const MAX_MESSAGES = 400;

let world: QuestionWorld;
let big = '';
let medium = '';

async function grow(id: string, events: number, seed: number): Promise<void> {
  const store = await openStore(storeFile(world.dataDir));
  try {
    const main = (await store.agents.listBySession(id)).find((agent) => agent.kind === 'main');
    if (!main) throw new Error('no main agent');
    const now = Date.now();
    appendHistory(store, id, main.id, events, { seed, startMs: now - 14 * 86_400_000, endMs: now - 10 * 60_000, liveCron: false });
  } finally {
    await store.close();
  }
}

async function startDone(page: Page, name: string): Promise<string> {
  const { id } = await world.startSession(page, name, 'Say hello.');
  await expect.poll(async () => page.evaluate(async (sid) => ((await (await fetch(`/api/sessions/${sid}`)).json()) as { status: string }).status, id), { timeout: 15_000 }).toBe('done');
  return id;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  world = await startQuestionWorld('long-session');
  const page = await browser.newPage();
  await page.goto(world.baseUrl);
  big = await startDone(page, 'long-big');
  medium = await startDone(page, 'long-medium');
  await page.close();
  await grow(big, 13_000, 1);
  await grow(medium, 2_000, 2);
});

test.afterAll(async () => {
  await world?.stop();
});

/** Opens a session through the app's router (as the sidebar does) and waits for its chat. */
async function show(page: Page, id: string): Promise<void> {
  await page.evaluate((url) => {
    history.pushState({}, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  }, `/sessions/${id}`);
  await expect(page.locator(`[data-testid="session-chat"][data-session-id="${id}"] [data-testid="chat-message"]`).first()).toBeVisible({ timeout: 30_000 });
}

test('a 13k-event session opens on its newest page; earlier messages load in front without moving the view', async ({ page }) => {
  test.setTimeout(120_000);
  await openWithHub(page, `${world.baseUrl}/sessions/${big}`);
  const chat = page.getByTestId('session-chat');
  const messages = chat.getByTestId('chat-message');
  // The fake session's own first turn is the newest: its reply is the last message.
  const reply = await page.evaluate(async (sid) => {
    const events = (await (await fetch(`/api/sessions/${sid}/events?limit=20`)).json()) as Array<{ payload: { type?: string; text?: string } | null }>;
    return events.filter((event) => event.payload?.type === 'assistant').at(-1)?.payload?.text ?? '';
  }, big);
  expect(reply).not.toBe('');
  await expect(messages.last()).toContainText(reply.split('\n')[0]?.slice(0, 30) ?? '', { timeout: 30_000 });
  const first = await messages.count();
  expect(first).toBeGreaterThan(20);
  expect(first).toBeLessThanOrEqual(MAX_MESSAGES);
  await expect(page.getByTestId('chat-older')).toBeVisible();

  // At the top, the next page comes in front; a user message near the top (not the first item, which may merge
  // with the text before it) stays where it was on screen.
  const anchor = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="session-chat"]')!;
    el.scrollTop = 0;
    const node = [...el.querySelectorAll('[data-testid="chat-message"][data-role="user"]')][1]!;
    return { text: node.textContent ?? '', top: node.getBoundingClientRect().top };
  });
  const before = anchor.top;
  await expect.poll(async () => messages.count(), { timeout: 15_000 }).toBeGreaterThan(first);
  const after = await page.evaluate((text) => {
    const nodes = [...document.querySelectorAll('[data-testid="session-chat"] [data-testid="chat-message"][data-role="user"]')];
    const node = nodes.find((candidate) => candidate.textContent === text);
    return node ? node.getBoundingClientRect().top : null;
  }, anchor.text);
  expect(after).not.toBeNull();
  // The message that was on top stays where it was (the new page went above it, out of view).
  expect(Math.abs((after ?? 0) - before)).toBeLessThanOrEqual(2);

  // The button loads the next page too (keyboard users, a scroll that does not reach the top).
  const count = await messages.count();
  await page.getByTestId('chat-older-load').click();
  await expect.poll(async () => messages.count(), { timeout: 15_000 }).toBeGreaterThan(count);
});

test('switching between long sessions does not grow the heap or the node count', async ({ page }) => {
  test.setTimeout(180_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const measure = async (): Promise<{ heapMb: number; nodes: number }> => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = (await cdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> };
    const get = (name: string): number => metrics.find((m) => m.name === name)?.value ?? 0;
    return { heapMb: get('JSHeapUsedSize') / 1e6, nodes: get('Nodes') };
  };
  await openWithHub(page, `${world.baseUrl}/inbox`);
  const round = async (): Promise<void> => {
    for (const id of [big, medium]) {
      await show(page, id);
      await page.waitForTimeout(500);
    }
    await page.evaluate(() => {
      history.pushState({}, '', '/inbox');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByTestId('session-chat')).toHaveCount(0);
    await page.waitForTimeout(300);
  };
  await round();
  const first = await measure();
  for (let i = 0; i < 4; i += 1) await round();
  const last = await measure();
  expect(last.heapMb, `heap after 5 rounds ${last.heapMb.toFixed(1)} MB vs ${first.heapMb.toFixed(1)} MB after 1`).toBeLessThanOrEqual(first.heapMb + 8);
  expect(last.nodes, `renderer nodes after 5 rounds ${last.nodes} vs ${first.nodes} after 1`).toBeLessThanOrEqual(first.nodes + 2_000);
  // Back on the Inbox the cache holds two pages a session at most: ≈15 MB here (≈50 MB with whole histories before D95).
  expect(last.heapMb, 'heap on the Inbox after visiting the long sessions').toBeLessThanOrEqual(30);
});
