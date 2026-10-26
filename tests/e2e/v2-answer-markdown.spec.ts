import { type Locator, type Page, expect, test } from '@playwright/test';
import type { InboxItem } from '../../src/core/api.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.0 · Markdown in the answer card (`docs/design/v2-decisions.md` →
 * *Fixes after 2.0* → *Markdown in the answer card*), real path: fake-claude asks
 * a question whose text has bold, inline code, a list, a link and a fenced block
 * (`[fake:questions]`), and a `turn_status` ask with inline Markdown (it is one line). The Needs-you page
 * and the in-chat card show real `<strong>`, `<code>`, `<li>` and `<pre>`, no raw
 * `**` or backticks; the link opens in a new tab with `rel` noopener; an option's
 * description stays a plain-text tooltip; a long question folds behind Show more in the
 * queue only. The same at phone width.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('e2e-v2-answer-markdown', { env: { ...V2_SERVER_ENV, FAKE_CLAUDE_MCP_RUN: '1' } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

const QUESTION = 'Deploy **Acme EU** with `npm run deploy`?\n\n- back up the Acme DB\n- then deploy\n\nSee [the Acme docs](https://acme.example/docs).\n\n```sh\nnpm run deploy -- --region eu\n```';
const QUESTIONS = [{ question: QUESTION, header: 'Region', multiSelect: false, options: [{ label: 'Acme EU', description: 'Uses **Frankfurt** via `eu-1`' }, { label: 'Acme US', description: 'Virginia' }] }];
const ASK_QUESTION = `[fake:ask-2q] Ask me. [fake:questions ${JSON.stringify(QUESTIONS)}]`;

// A turn_status ask is one line (≤ 300 characters, the server folds its whitespace): inline Markdown only.
const ASK = 'Should I run **the migration** on `acme-db`? Runbook: [Acme runbook](https://acme.example/runbook)';
const turnStatus = (ask: string): string => `Prepare the rollout. [fake:tool mcp__switchboard__turn_status ${JSON.stringify({ status: 'waiting_for_you', ask })}]`;
const LONG_QUESTION = `Which **Acme** steps should run?\n\n${Array.from({ length: 16 }, (_, index) => `- step ${index + 1}`).join('\n')}`;
const ASK_LONG = `[fake:ask-2q] Ask me. [fake:questions ${JSON.stringify([{ question: LONG_QUESTION, header: 'Steps', multiSelect: false, options: [{ label: 'All' }, { label: 'None' }] }])}]`;

async function inboxOf(page: Page, sessionId: string): Promise<InboxItem[]> {
  const items = await page.evaluate(async () => (await (await fetch('/api/inbox')).json()) as InboxItem[]);
  return items.filter((item) => item.sessionId === sessionId);
}

/** The card shows `scope`'s Markdown as elements: strong, code, li (and a safe link); no raw `**` or backticks. */
async function expectMarkdown(card: Locator, scope: Locator, link: string, items: number): Promise<void> {
  await expect(scope.locator('strong').first()).toBeVisible();
  await expect(scope.locator('code').first()).toBeAttached();
  await expect(scope.locator('li')).toHaveCount(items);
  const text = (await card.textContent()) ?? '';
  expect(text).not.toContain('**');
  expect(text).not.toContain('`');
  const anchor = scope.locator(`a[href="${link}"]`);
  await expect(anchor).toHaveCount(1);
  await expect(anchor).toHaveAttribute('target', '_blank');
  await expect(anchor).toHaveAttribute('rel', /\bnoopener\b/);
}

/** The question card: the question's Markdown, its fenced block in a <pre>, the option labels plain, the description a plain tooltip. */
async function expectQuestionCard(card: Locator): Promise<void> {
  await expect(card).toHaveAttribute('data-kind', 'question');
  const title = card.getByTestId('v2-answer-title');
  await expectMarkdown(card, title, 'https://acme.example/docs', 2);
  await expect(title.locator('strong')).toHaveText('Acme EU');
  await expect(title.locator('code').first()).toHaveText('npm run deploy');
  await expect(title.locator('pre')).toContainText('npm run deploy -- --region eu');
  await expect(card.locator('.v2-opt[data-option="0"]')).toHaveText(/Acme EU$/);
  await expect(card.locator('.v2-opt[data-option="0"]')).toHaveAttribute('title', 'Uses Frankfurt via eu-1');
}

test('Needs-you page and in-chat card: a Markdown question renders as Markdown', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'acme-md-question', ASK_QUESTION);
  await expect.poll(async () => (await inboxOf(page, id)).length, { timeout: 15_000 }).toBe(1);
  await openWithHub(page, `${world.baseUrl}/needs-you`);
  await expectQuestionCard(page.getByTestId('v2-needs-list').getByTestId('v2-answer-card').filter({ hasText: 'acme-md-question' }));
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  const chatCard = page.getByTestId('v2-agent-chat').getByTestId('v2-answer-card');
  await expect(chatCard).toHaveCount(1);
  await expectQuestionCard(chatCard);
  await expect(chatCard.getByTestId('v2-answer-more')).toHaveCount(0);
});

test('Needs-you page and in-chat card: a turn_status ask with Markdown renders as Markdown', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'acme-md-ask', turnStatus(ASK));
  await expect.poll(async () => (await inboxOf(page, id)).length, { timeout: 15_000 }).toBe(1);
  for (const [url, scope] of [
    [`${world.baseUrl}/needs-you`, 'v2-needs-list'],
    [`${world.baseUrl}/agents/${id}`, 'v2-agent-chat'],
  ] as const) {
    await openWithHub(page, url);
    const card = page.getByTestId(scope).locator('[data-testid="v2-answer-card"][data-kind="ask"]').filter({ hasText: 'acme-db' });
    await expect(card).toHaveCount(1);
    const ask = card.getByTestId('v2-answer-ask');
    await expectMarkdown(card, ask, 'https://acme.example/runbook', 0);
    await expect(ask.locator('strong')).toHaveText('the migration');
    await expect(ask.locator('code')).toHaveText('acme-db');
  }
});

test('a long question folds behind Show more on the Needs-you page, not in the chat', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'acme-md-long', ASK_LONG);
  await expect.poll(async () => (await inboxOf(page, id)).length, { timeout: 15_000 }).toBe(1);
  await openWithHub(page, `${world.baseUrl}/needs-you`);
  // The earlier tests' items still wait: this card is the one with the steps.
  const card = page.getByTestId('v2-needs-list').getByTestId('v2-answer-card').filter({ hasText: 'step 16' });
  const title = card.getByTestId('v2-answer-title');
  const more = card.getByTestId('v2-answer-more');
  await expect(more).toHaveText('Show more');
  await expect(title.locator('li')).toHaveCount(16);
  const folded = (await title.boundingBox())?.height ?? 0;
  await more.click();
  await expect(more).toHaveText('Show less');
  await expect.poll(async () => (await title.boundingBox())?.height ?? 0).toBeGreaterThan(folded + 40);
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  const chatCard = page.getByTestId('v2-agent-chat').getByTestId('v2-answer-card');
  await expect(chatCard).toHaveCount(1);
  await expect(chatCard.getByTestId('v2-answer-title').locator('li')).toHaveCount(16);
  await expect(chatCard.getByTestId('v2-answer-more')).toHaveCount(0);
});

test('phone width: the question card renders Markdown and its code block stays inside the card', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await stubToolProbes(page);
    await openWithHub(page, `${world.baseUrl}/`);
    await world.startSession(page, 'acme-md-phone', ASK_QUESTION);
    await expect(page.getByTestId('v2-tab-needs').locator('.v2-dot-badge')).toBeVisible();
    await page.getByTestId('v2-tab-needs').tap();
    const card = page.getByTestId('v2-answer-card').filter({ hasText: 'acme-md-phone' });
    await expect(card).toHaveCount(1);
    await expectQuestionCard(card);
    const box = await card.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    const code = await card.locator('.sb-md-code').boundingBox();
    expect((code?.x ?? 0) + (code?.width ?? 0)).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? 0));
  } finally {
    await context.close();
  }
});
