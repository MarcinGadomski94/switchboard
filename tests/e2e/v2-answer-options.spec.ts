import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { InboxItem, SessionEvent } from '../../src/core/api.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.0 · v2 answer options (`docs/design/v2-decisions.md` → *Fixes after
 * 2.0*), real path: fake-claude asks, v2 shows what classic shows. A batch of two
 * questions (one single, one multi-select, `[fake:questions]`) shows the agent's
 * own options (descriptions as tooltips), checkboxes with Other…, and Send; the
 * agent receives the exact labels (joined per D128), from the Needs-you page and
 * from the in-chat card. A permission request offers Allow once / Deny. An agent's
 * text ask (D124) shows its words, a reply box and Not waiting, never a made-up
 * "Go ahead". The same at phone width.
 */

let world: QuestionWorld;
let tmp: string;
let logFile: string;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-v2-answer-options');
  logFile = path.join(tmp, 'fake.log');
  world = await startQuestionWorld('e2e-v2-answer-options', { env: { ...V2_SERVER_ENV, FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_MCP_RUN: '1' } });
});

test.afterAll(async () => {
  await world?.stop();
  if (tmp) await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

const REGION = 'Which Acme region should I deploy to?';
const PARTS = 'Which parts should I update?';
const QUESTIONS = [
  { question: REGION, header: 'Region', multiSelect: false, options: [{ label: 'Acme EU', description: 'Frankfurt' }, { label: 'Acme US', description: 'Virginia' }, { label: 'Both', description: 'EU first' }] },
  { question: PARTS, header: 'Parts', multiSelect: true, options: [{ label: 'Code', description: 'The source files' }, { label: 'Tests', description: 'Unit and E2E tests' }, { label: 'Docs', description: 'README and docs/' }] },
];
const ASK_BATCH = `[fake:ask-2q] Ask me. [fake:questions ${JSON.stringify(QUESTIONS)}]`;

async function controlResponses(): Promise<Array<{ response: { request_id: string; response: Record<string, unknown> } }>> {
  let text = '';
  try {
    text = await readFile(logFile, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { kind: string; line?: string })
    .filter((entry) => entry.kind === 'stdin' && (entry.line ?? '').includes('"control_response"'))
    .map((entry) => JSON.parse(entry.line as string) as { response: { request_id: string; response: Record<string, unknown> } });
}

async function inboxOf(page: Page, sessionId: string): Promise<InboxItem[]> {
  const items = await page.evaluate(async () => (await (await fetch('/api/inbox')).json()) as InboxItem[]);
  return items.filter((item) => item.sessionId === sessionId);
}

async function events(page: Page, id: string): Promise<SessionEvent[]> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`)).json()) as SessionEvent[], id);
}

/** The batch card shows the agent's options: buttons (with descriptions) for the single question, checkboxes + Other… for the multi-select one, and Send. */
async function expectBatchCard(card: Locator): Promise<void> {
  await expect(card).toHaveAttribute('data-kind', 'multi');
  const blocks = card.locator('.v2-qi-q');
  await expect(blocks).toHaveCount(2);
  await expect(card.locator('.v2-qi-title').filter({ hasText: REGION })).toHaveCount(1);
  await expect(card.locator('.v2-qi-title').filter({ hasText: PARTS })).toHaveCount(1);
  await expect(blocks.nth(0).locator('.v2-opt')).toHaveText(['Acme EU', 'Acme US', 'Both', 'Other…']);
  await expect(blocks.nth(0).locator('.v2-opt').first()).toHaveAttribute('title', 'Frankfurt');
  await expect(blocks.nth(1).getByRole('checkbox')).toHaveCount(4);
  for (const name of ['Code', 'Tests', 'Docs', 'Other…']) await expect(blocks.nth(1).getByRole('checkbox', { name, exact: true })).toHaveCount(1);
  await expect(blocks.nth(1).locator('label', { hasText: 'Tests' })).toHaveAttribute('title', 'Unit and E2E tests');
  await expect(card.getByRole('button', { name: 'Go ahead' })).toHaveCount(0);
  await expect(card.getByTestId('v2-answer-send')).toBeDisabled();
  // Fix after 2.4.6: each multi-select option's text gets room for a few words per line (it used
  // to get ~50px and broke after every word).
  const widths = await blocks.nth(1).locator('.v2-chk-grid .v2-chk > span:last-child').evaluateAll((spans) => spans.map((span) => span.getBoundingClientRect().width));
  for (const width of widths) expect(width).toBeGreaterThanOrEqual(120);
}

/** Picks Acme US + Code and Docs, sends; the agent gets the exact labels (D128 join) in one control_response. */
async function answerBatch(page: Page, card: Locator, sessionId: string, before: number): Promise<void> {
  const blocks = card.locator('.v2-qi-q');
  await blocks.nth(0).locator('.v2-opt', { hasText: 'Acme US' }).click();
  await blocks.nth(1).getByRole('checkbox', { name: 'Code', exact: true }).check();
  await blocks.nth(1).getByRole('checkbox', { name: 'Docs', exact: true }).check();
  await expect(card.getByTestId('v2-answer-send')).toBeEnabled();
  await card.getByTestId('v2-answer-send').click();
  await expect.poll(async () => (await controlResponses()).length, { timeout: 20_000 }).toBe(before + 1);
  expect((await controlResponses())[before]?.response.response).toMatchObject({ behavior: 'allow', updatedInput: { answers: { [REGION]: 'Acme US', [PARTS]: 'Code, Docs' } } });
  await expect.poll(async () => (await inboxOf(page, sessionId)).length, { timeout: 15_000 }).toBe(0);
}

test('a 2-question batch (single + multi-select) answered on the Needs-you page: the agent gets the exact labels', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/needs-you`);
  const before = (await controlResponses()).length;
  const { id } = await world.startSession(page, 'acme-batch', ASK_BATCH);
  const card = page.getByTestId('v2-needs-list').getByTestId('v2-answer-card');
  await expect(card).toHaveCount(1);
  await expectBatchCard(card);
  await answerBatch(page, card, id, before);
});

test('the same batch from the in-chat card of the agent view', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const before = (await controlResponses()).length;
  const { id } = await world.startSession(page, 'acme-chat-batch', ASK_BATCH);
  await expect.poll(async () => (await inboxOf(page, id)).length).toBe(1);
  await openWithHub(page, `${world.baseUrl}/agents/${id}`);
  const card = page.getByTestId('v2-agent-chat').getByTestId('v2-answer-card');
  await expect(card).toHaveCount(1);
  await expectBatchCard(card);
  await answerBatch(page, card, id, before);
  await expect(page.getByTestId('v2-agent-chat').getByTestId('v2-answered')).toContainText('Acme US, Code, Docs');
});

test('a permission request: Allow once / Deny, as classic', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'acme-perm', '[fake:perm-allow] Run the command.');
  await expect.poll(async () => (await inboxOf(page, id)).length).toBe(1);
  for (const url of [`${world.baseUrl}/needs-you`, `${world.baseUrl}/agents/${id}`]) {
    await openWithHub(page, url);
    const card = page.locator('[data-testid="v2-answer-card"][data-kind="approval"]');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.v2-qi-actions button')).toHaveText([/Allow once$/, /Deny$/]);
  }
  await page.locator('[data-testid="v2-answer-card"]').getByRole('button', { name: /Allow once/ }).click();
  await expect.poll(async () => (await inboxOf(page, id)).length, { timeout: 15_000 }).toBe(0);
});

test("an agent's text ask (D124): its words, detected, a reply box and Not waiting, no made-up Go ahead; the reply reaches the agent", async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const ask = 'Which region should I use, Acme EU or Acme US?';
  const { id } = await world.startSession(page, 'acme-text-ask', `Deploy. [fake:say "I can deploy to two regions:\\n1. Acme EU\\n2. Acme US\\n\\n${ask}"]`);
  await expect.poll(async () => (await inboxOf(page, id)).length, { timeout: 15_000 }).toBe(1);
  for (const url of [`${world.baseUrl}/needs-you`, `${world.baseUrl}/agents/${id}`]) {
    await openWithHub(page, url);
    const card = page.locator('[data-testid="v2-answer-card"][data-kind="ask"]');
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId('v2-answer-ask')).toHaveText(ask);
    await expect(card.getByTestId('v2-answer-detected')).toBeVisible();
    await expect(card.getByRole('textbox')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Go ahead' })).toHaveCount(0);
    await expect(card.locator('[data-action]')).toHaveText([/Not waiting$/]);
  }
  const card = page.locator('[data-testid="v2-answer-card"][data-kind="ask"]');
  await card.getByRole('textbox').fill('Acme EU');
  await card.getByRole('button', { name: 'Send' }).click();
  await expect.poll(async () => JSON.stringify(await events(page, id)).includes('Acme EU'), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await inboxOf(page, id)).length, { timeout: 15_000 }).toBe(0);
});

test('phone width: the batch card shows the agent options and answers with taps', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await stubToolProbes(page);
    await openWithHub(page, `${world.baseUrl}/`);
    const before = (await controlResponses()).length;
    const { id } = await world.startSession(page, 'acme-phone-batch', ASK_BATCH);
    await expect(page.getByTestId('v2-tab-needs').locator('.v2-dot-badge')).toHaveText('1');
    await page.getByTestId('v2-tab-needs').tap();
    const card = page.getByTestId('v2-answer-card');
    await expect(card).toHaveCount(1);
    await expectBatchCard(card);
    await expect(card.locator('.v2-num')).toHaveCount(0);
    const box = await card.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await answerBatch(page, card, id, before);
  } finally {
    await context.close();
  }
});
