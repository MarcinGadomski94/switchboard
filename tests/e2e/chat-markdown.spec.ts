import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D20 oracle, real path (D13, no demo seed): `node src/server/main.ts` with
 * fake-claude as the CLI. An agent reply (`[fake:say]`) with Markdown renders as
 * Markdown in the chat: a heading, emphasis, a list, a table, a fenced block with
 * syntax colors and a box-drawing table that keeps its monospace columns. Raw HTML
 * in the developer's message and in the agent's reply shows as text (no element,
 * no script runs). A pasted bare URL in the developer's message becomes a link that
 * opens in a new tab (developer addition 2026-09-28). Plain text (two paragraphs,
 * a soft line break, wrapping) takes exactly the room it took as plain text before
 * D20. Only the chat renders Markdown.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('chat-markdown');
});

test.afterAll(async () => {
  await world?.stop();
});

const BOX = ['┌───────┬─────────┐', '│ Agent │ Status  │', '├───────┼─────────┤', '│ web   │ done    │', '└───────┴─────────┘'];

const REPLY = [
  '## Plan',
  '',
  'The **contract** is locked. Next:',
  '',
  '- web: `acme-app-front`',
  '- mobile',
  '',
  '| Agent | Status |',
  '|:--|--:|',
  '| web | done |',
  '| mobile | running |',
  '',
  '```ts',
  'const answer: number = 42;',
  '```',
  '',
  '```',
  ...BOX,
  '```',
].join('\n');

const HTML_REPLY = 'Raw: <script>window.__sbXss = 1</script> <img src="x" onerror="window.__sbXss = 2"> <b>not bold</b>';
const HTML_MESSAGE = `[fake:say ${JSON.stringify(HTML_REPLY)}] Mine: <img src=x onerror="window.__sbXss = 3"> <i>not italic</i>`;
const URL_MESSAGE = 'Docs: https://example.com/docs/chat.';
const PLAIN = [
  'First line of a plain answer',
  'second line right under it',
  '',
  'A second paragraph that is long enough to wrap onto more than one line in the chat column, because it keeps going with more and more words until it certainly wraps at least once or twice across the width of the chat area.',
].join('\n');

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return (await response.json()) as SessionDetail;
  }, id);
}

test('agent Markdown (heading, list, table, highlighted code, box table), raw HTML as text, a pasted URL opens in a new tab', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'markdown-e2e', `Show the plan. [fake:say ${JSON.stringify(REPLY)}]`);
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);

  const chat = page.getByTestId('session-chat');
  const agents = chat.locator('[data-testid="chat-message"][data-role="agent"]');
  const users = chat.locator('[data-testid="chat-message"][data-role="user"]');
  await expect(agents).toHaveCount(1);
  const reply = agents.first().getByTestId('chat-markdown');

  // Heading, emphasis, list with inline code.
  await expect(reply.locator('h2')).toHaveText('Plan');
  await expect(reply.locator('p').first()).toHaveText('The contract is locked. Next:');
  await expect(reply.locator('strong')).toHaveText('contract');
  await expect(reply.locator('ul > li')).toHaveText(['web: acme-app-front', 'mobile']);
  await expect(reply.locator('li code')).toHaveText('acme-app-front');
  await expect(reply.locator('li code')).toHaveCSS('font-family', /Geist Mono/);

  // The table, with the delimiter row's alignment.
  await expect(reply.locator('table th')).toHaveText(['Agent', 'Status']);
  await expect(reply.locator('table td')).toHaveText(['web', 'done', 'mobile', 'running']);
  await expect(reply.locator('table th').nth(1)).toHaveCSS('text-align', 'right');

  // The fenced TypeScript block: highlight classes, colors that differ from the plain code text, bg-code, mono.
  const code = reply.locator('pre code.language-ts');
  await expect(code).toHaveClass(/\bhljs\b/);
  await expect(code).toHaveText('const answer: number = 42;');
  await expect(code.locator('.hljs-keyword')).toHaveText('const');
  await expect(code.locator('.hljs-number')).toHaveText('42');
  const colors = await code.evaluate((el) => ({
    text: getComputedStyle(el).color,
    keyword: getComputedStyle(el.querySelector('.hljs-keyword') as Element).color,
    number: getComputedStyle(el.querySelector('.hljs-number') as Element).color,
  }));
  expect(new Set([colors.text, colors.keyword, colors.number]).size).toBe(3);
  const pre = reply.locator('pre').first();
  await expect(pre).toHaveCSS('background-color', 'rgb(12, 13, 15)');
  await expect(pre).toHaveCSS('font-family', /Geist Mono/);

  // D92: Copy puts the block's code (without the tool labels) on the clipboard, then reads "Copied ✓" for a moment.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: world.baseUrl });
  const block = reply.locator('.sb-md-code').first();
  await block.hover();
  const copy = block.getByTestId('chat-code-copy');
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(copy).toHaveAttribute('data-state', 'copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const answer: number = 42;');
  await expect(copy).toHaveAttribute('data-state', 'idle', { timeout: 4000 });
  // The tool labels are CSS-drawn: the message's own text never contains them.
  expect(await reply.textContent()).not.toContain('Copy');

  // The box-drawing table: every character and space kept, never wrapped, every line equally wide (monospace).
  const box = reply.locator('pre').nth(1);
  await expect(box).toHaveCSS('white-space', 'pre');
  const boxText = await box.evaluate((el) => el.textContent ?? '');
  expect(boxText).toBe(`${BOX.join('\n')}\n`);
  const widths = await box.evaluate((el) => {
    const node = el.querySelector('code')?.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return [];
    const text = node.textContent ?? '';
    const out: number[] = [];
    let start = 0;
    for (const line of text.split('\n').filter((l) => l !== '')) {
      const range = document.createRange();
      const at = text.indexOf(line, start);
      range.setStart(node, at);
      range.setEnd(node, at + line.length);
      out.push(range.getBoundingClientRect().width);
      start = at + line.length;
    }
    return out;
  });
  expect(widths).toHaveLength(BOX.length);
  for (const width of widths) expect(Math.abs(width - (widths[0] ?? 0))).toBeLessThan(0.5);

  // Raw HTML in the developer's message and in the agent's reply shows as text; nothing runs.
  const input = page.getByTestId('chat-input');
  await input.fill(HTML_MESSAGE);
  await input.press('Enter');
  await expect(agents).toHaveCount(2);
  await expect(users.nth(1).getByTestId('chat-text')).toHaveText(
    `[fake:say "Raw: <script>window.__sbXss = 1</script> <img src="x" onerror="window.__sbXss = 2"> <b>not bold</b>"] Mine: <img src=x onerror="window.__sbXss = 3"> <i>not italic</i>`,
  );
  await expect(agents.nth(1).getByTestId('chat-text')).toHaveText(HTML_REPLY);
  await expect(chat.locator('script, img, b, i, iframe')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __sbXss?: number }).__sbXss)).toBeUndefined();
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');

  // A pasted URL: plain in the field, a link once sent (trailing period outside), opening in a new tab.
  await input.fill(URL_MESSAGE);
  await expect(input).toHaveValue(URL_MESSAGE);
  await input.press('Enter');
  const bubble = users.nth(2).getByTestId('chat-text');
  await expect(bubble).toHaveText(URL_MESSAGE);
  const link = bubble.locator('a');
  await expect(link).toHaveText('https://example.com/docs/chat');
  await expect(link).toHaveAttribute('href', 'https://example.com/docs/chat');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  // Never the network: the context answers example.com itself.
  await page.context().route('https://example.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>stub</title><p data-testid="stub">example.com stub</p>' }),
  );
  const opened = page.context().waitForEvent('page');
  await link.click();
  const tab = await opened;
  await tab.waitForLoadState();
  expect(tab.url()).toBe('https://example.com/docs/chat');
  await expect(tab.getByTestId('stub')).toHaveText('example.com stub');
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await tab.close();
  expect(page.url()).toBe(`${world.baseUrl}/sessions/${id}`);
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');

  // Plain text without Markdown takes exactly the room the pre-D20 plain text took (the same bubble with the raw text in it).
  await input.fill(`[fake:say ${JSON.stringify(PLAIN)}]`);
  await input.press('Enter');
  await expect(agents).toHaveCount(4);
  const plain = agents.nth(3).getByTestId('chat-text');
  await expect(plain.locator('p')).toHaveCount(2);
  const boxes = await plain.evaluate((bubble, text) => {
    const twin = bubble.cloneNode(false) as HTMLElement;
    twin.textContent = text;
    bubble.after(twin);
    const rendered = bubble.getBoundingClientRect();
    const before = twin.getBoundingClientRect();
    twin.remove();
    return { rendered: [rendered.width, rendered.height], before: [before.width, before.height] };
  }, PLAIN);
  expect(boxes.rendered[1]).toBeGreaterThan(80);
  expect(Math.abs((boxes.rendered[0] ?? 0) - (boxes.before[0] ?? 0))).toBeLessThan(0.5);
  expect(Math.abs((boxes.rendered[1] ?? 0) - (boxes.before[1] ?? 0))).toBeLessThan(0.5);
  await expect.poll(async () => (await detail(page, id)).status).toBe('done');

  // Only the chat renders Markdown (the terminal tail and the rest of the page stay plain text).
  const markdownBlocks = await page.evaluate(() => [...document.querySelectorAll('[data-testid="chat-markdown"]')].map((el) => el.closest('[data-testid="session-chat"]') !== null));
  expect(markdownBlocks.length).toBeGreaterThan(0);
  expect(markdownBlocks.every(Boolean)).toBe(true);
});
