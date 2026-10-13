import { type Page, expect, test } from '@playwright/test';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { appendHistory } from '../../tools/bench/world.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D97 · search across everything (`docs/search.md`) on the real path (fake-claude):
 * a session grown to ≈3,000 events with an old exchange about the "zanzibar ledger"
 * near its start (outside the newest page the chat loads). The Search page finds
 * both messages with highlighted snippets, grouped and filtered by scope; a result
 * opens the chat at that exact message (loaded `around` it, scrolled to it and
 * highlighted, the later messages a page away with Jump to latest); the ⌘K
 * palette's `?` searches too; ⌘⇧F / Ctrl+Shift+F opens the page; on phones and
 * tablets the app bar's Search opens it and nothing overflows; the page follows
 * the Artifacts page's design (head, chips).
 */
test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off' });

let world: QuestionWorld;
let sessionId = '';
let question = 0;
let answer = 0;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  world = await startQuestionWorld('search');
  const page = await browser.newPage();
  await page.goto(world.baseUrl);
  sessionId = (await world.startSession(page, 'search-big', 'Say hello.')).id;
  await expect
    .poll(async () => page.evaluate(async (sid) => ((await (await fetch(`/api/sessions/${sid}`)).json()) as { status: string }).status, sessionId), { timeout: 15_000 })
    .toBe('done');
  await page.close();
  const store = await openStore(storeFile(world.dataDir));
  try {
    const main = (await store.agents.listBySession(sessionId)).find((agent) => agent.kind === 'main');
    if (!main) throw new Error('no main agent');
    const now = Date.now();
    appendHistory(store, sessionId, main.id, 3_000, { seed: 7, startMs: now - 14 * 86_400_000, endMs: now - 10 * 60_000, liveCron: false, index: true });
    // An old exchange near the session's start: written through the repository, so it is indexed as the server would.
    const at = (offsetMs: number): string => new Date(now - 13.5 * 86_400_000 + offsetMs).toISOString();
    question = (await store.events.append({ sessionId, agentId: main.id, kind: 'text', ts: at(0), payload: { type: 'user', text: 'Where does the zanzibar ledger reconcile?', origin: 'user', delivered: true } })).id;
    answer = (await store.events.append({ sessionId, agentId: main.id, kind: 'text', ts: at(1_000), payload: { type: 'assistant', text: 'The zanzibar ledger reconciles nightly in the billing job.', messageId: 'msg-zanzibar' } })).id;
  } finally {
    await store.close();
  }
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function search(page: Page, text: string): Promise<void> {
  await page.getByTestId('search-input').fill(text);
  await expect(page.getByTestId('view-search')).not.toHaveAttribute('aria-busy', 'true');
}

test('the Search page finds the old messages, highlighted and grouped; a result opens the chat at that exact message', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/search`);
  await expect(page.getByTestId('search-input')).toBeFocused();
  await expect(page.getByTestId('search-chip')).toHaveText(['All', 'Conversations', 'Artifacts', 'Todos', 'History']);
  await search(page, 'zanzibar ledger');
  const group = page.locator('[data-testid="search-group"][data-scope="conversations"]');
  await expect(group.getByTestId('search-result')).toHaveCount(2);
  await expect(page.getByTestId('search-group')).toHaveCount(1);
  await expect(group.getByTestId('search-group-count')).toHaveText('2');
  const hit = group.locator(`[data-result-id="e:${question}"]`);
  await expect(hit.getByTestId('search-kind')).toHaveText('You');
  await expect(hit.getByTestId('search-title')).toHaveText('search-big');
  await expect(hit.getByTestId('search-mark')).toHaveText(['zanzibar', 'ledger']);
  await expect(page).toHaveURL(/\/search\?q=zanzibar\+ledger$/);

  // The message is far older than the chat's newest page: it is read around the event.
  const around = page.waitForRequest((request) => request.url().includes(`/events?limit=1000&around=${question}`));
  await hit.click();
  await around;
  await expect(page).toHaveURL(`${world.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events/${question}`);
  const chat = page.getByTestId('session-chat');
  const target = chat.locator(`[data-testid="chat-message"][data-event-id="${question}"]`);
  await expect(target).toHaveAttribute('data-search-hit', 'true', { timeout: 30_000 });
  await expect(target).toContainText('Where does the zanzibar ledger reconcile?');
  await expect(target).toBeInViewport();
  // Centred: its middle is within the middle half of the conversation.
  const box = (await target.boundingBox())!;
  const frame = (await chat.boundingBox())!;
  const middle = box.y + box.height / 2;
  expect(middle).toBeGreaterThan(frame.y + frame.height * 0.2);
  expect(middle).toBeLessThan(frame.y + frame.height * 0.8);
  // The highlight fades out and goes.
  await expect(target).not.toHaveAttribute('data-search-hit', 'true', { timeout: 6_000 });
  // The newest messages are a page away: the row under the window, and Jump to latest.
  await expect(page.getByTestId('chat-newer')).toBeVisible();
  await page.getByTestId('chat-newer-latest').click();
  await expect(page.getByTestId('chat-newer')).toHaveCount(0);
  const reply = await page.evaluate(async (sid) => {
    const events = (await (await fetch(`/api/sessions/${sid}/events?limit=20`)).json()) as Array<{ payload: { type?: string; text?: string } | null }>;
    return events.filter((event) => event.payload?.type === 'assistant').at(-1)?.payload?.text ?? '';
  }, sessionId);
  await expect(chat.getByTestId('chat-message').last()).toContainText(reply.split('\n')[0]?.slice(0, 30) ?? '', { timeout: 30_000 });
});

test('scope chips, the keyboard, ⌘⇧F / Ctrl+Shift+F and Back', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  await page.keyboard.press('ControlOrMeta+Shift+f');
  await expect(page.getByTestId('view-search')).toBeVisible();
  await expect(page.getByTestId('search-input')).toBeFocused();
  await search(page, 'zanzibar');
  await page.locator('[data-testid="search-chip"][data-chip="todos"]').click();
  await expect(page).toHaveURL(/scope=todos/);
  await expect(page.getByTestId('search-empty')).toHaveText('No matches.');
  await page.locator('[data-testid="search-chip"][data-chip="conversations"]').click();
  await expect(page.getByTestId('search-result')).toHaveCount(2);
  // ↓ highlights the second row, Enter opens it (the agent's answer).
  await page.getByTestId('search-input').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-testid="search-result"][data-selected="true"]')).toHaveCount(1);
  const id = await page.locator('[data-testid="search-result"][data-selected="true"]').getAttribute('data-result-id');
  await page.keyboard.press('Enter');
  const eventId = Number(id?.slice(2));
  expect([question, answer]).toContain(eventId);
  await expect(page.locator(`[data-testid="chat-message"][data-event-id="${eventId}"]`)).toBeVisible({ timeout: 30_000 });
  // Back: the page with its query and chip.
  await page.goBack();
  await expect(page.getByTestId('search-input')).toHaveValue('zanzibar');
  await expect(page.locator('[data-testid="search-chip"][data-chip="conversations"]')).toHaveAttribute('aria-pressed', 'true');
});

test('the ⌘K palette searches with "?": its best results open the message, its last row the Search page', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('palette-input').fill('?');
  await expect(page.getByTestId('palette-row')).toHaveText(['searchSearch everything…type what to find']);
  await page.getByTestId('palette-input').fill('?zanzibar');
  const rows = page.getByTestId('palette-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.last()).toContainText('All results for “zanzibar”');
  await expect(rows.first()).toContainText('zanzibar');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}/events/(${question}|${answer})$`));
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('palette-input').fill('?zanzibar');
  await expect(rows).toHaveCount(3);
  await rows.last().click();
  await expect(page.getByTestId('view-search')).toBeVisible();
  await expect(page.getByTestId('search-input')).toHaveValue('zanzibar');
  await expect(page.getByTestId('search-result')).toHaveCount(2);
});

test('the page follows the Artifacts page\'s design (head, title, chips)', async ({ page }) => {
  const styles = async (selector: string): Promise<Record<string, string>> =>
    page.locator(selector).first().evaluate((el) => {
      const s = getComputedStyle(el);
      const out: Record<string, string> = {};
      for (const prop of ['font-size', 'font-family', 'padding-top', 'padding-left', 'border-top-left-radius', 'background-color', 'color', 'border-bottom-color']) out[prop] = s.getPropertyValue(prop);
      return out;
    });
  await openWithHub(page, `${world.baseUrl}/artifacts`);
  const artifacts = { head: await styles('.sb-art-head'), title: await styles('.sb-art-title'), chip: await styles('.sb-art-filter[aria-pressed="false"]'), on: await styles('.sb-art-filter[aria-pressed="true"]') };
  await page.goto(`${world.baseUrl}/search`);
  expect(await styles('.sb-search-head')).toEqual(artifacts.head);
  expect(await styles('.sb-search-title')).toEqual(artifacts.title);
  expect(await styles('.sb-search-chip[aria-pressed="false"]')).toEqual(artifacts.chip);
  expect(await styles('.sb-search-chip[aria-pressed="true"]')).toEqual(artifacts.on);
});

for (const [name, viewport] of [
  ['phone', { width: 360, height: 740 }],
  ['tablet', { width: 768, height: 1024 }],
] as const) {
  test(`${name} (${viewport.width}px): the app bar's Search opens the page; results fit the width`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openWithHub(page, `${world.baseUrl}/`);
    await page.getByTestId('app-bar-search').click();
    await expect(page.getByTestId('view-search')).toBeVisible();
    await expect(page.getByTestId('app-bar-title')).toHaveText('Search');
    await expect(page.getByTestId('app-bar-search')).toHaveAttribute('aria-current', 'page');
    await search(page, 'zanzibar');
    await expect(page.getByTestId('search-result')).toHaveCount(2);
    const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth, results: document.querySelector('[data-testid="search-results"]')!.scrollWidth - document.querySelector('[data-testid="search-results"]')!.clientWidth }));
    expect(overflow.doc).toBeLessThanOrEqual(overflow.view);
    expect(overflow.results).toBeLessThanOrEqual(0);
    for (const row of await page.getByTestId('search-result').all()) {
      const box = (await row.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
    }
    await page.screenshot({ path: test.info().outputPath(`search-${name}.png`) });
    await page.getByTestId('search-result').first().click();
    await expect(page.locator('[data-testid="session-chat"] [data-search-hit="true"]')).toBeVisible({ timeout: 30_000 });
  });
}
