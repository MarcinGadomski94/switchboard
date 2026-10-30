import { type Locator, type Page, expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { openWithHub } from './question-world.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.4.12 · v2 answer tooltips ("i dont see the tooltips when i hover on
 * answers within v2 theme"), real path: fake-claude asks AskUserQuestion with an
 * option description per option. Under the pointer, at the centre of every option,
 * the element hit (or an ancestor) carries the option's description as its `title`,
 * in every place v2 shows an answer card: Needs you, Home, the Board's quick answer,
 * the agent's chat, a crew page and the phone. Once answered, the line that replaces
 * the card keeps the chosen answers' descriptions as its tooltip (it showed only the
 * labels): the chat's line right after answering and the chat's record after a reload
 * (also of an answer given on Needs you, where the card just leaves with a toast).
 */

test.describe.configure({ mode: 'serial' });

let world: TeamWorld;

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-v2-answer-tooltips', { env: { ...V2_SERVER_ENV, SWITCHBOARD_TEST_SECRET_STORE: 'memory' } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

const BATCH = [
  { question: 'Which Acme region should I deploy to?', header: 'Region', multiSelect: false, options: [{ label: 'Acme EU', description: 'Frankfurt' }, { label: 'Acme US', description: 'Virginia' }] },
  { question: 'Which parts should I update?', header: 'Parts', multiSelect: true, options: [{ label: 'Code', description: 'The source files' }, { label: 'Tests', description: 'Unit and **E2E** tests' }] },
];
const SINGLE = [{ question: 'Which Acme plan?', header: 'Plan', multiSelect: false, options: [{ label: 'Basic', description: 'One seat' }, { label: 'Team', description: 'Up to `10` seats' }] }];
const ask = (questions: unknown): string => `[fake:ask-2q] Ask me. [fake:questions ${JSON.stringify(questions)}]`;

/** The option label → its tooltip (plain text). */
const TIPS: Record<string, string> = { 'Acme EU': 'Frankfurt', 'Acme US': 'Virginia', Code: 'The source files', Tests: 'Unit and E2E tests', Basic: 'One seat', Team: 'Up to 10 seats' };

let batchId = '';
let singleId = '';
let crewSessionId = '';

/** The `title` the pointer would show at the centre of `target`: the element hit there, or its nearest ancestor with one. */
async function tooltipUnderPointer(target: Locator): Promise<string | null> {
  await target.scrollIntoViewIfNeeded();
  await target.hover();
  return target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    let hit: Element | null = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) return `(covered by ${hit?.outerHTML.slice(0, 80) ?? 'nothing'})`;
    while (hit && !hit.getAttribute('title')) hit = hit.parentElement;
    return hit?.getAttribute('title') ?? null;
  });
}

/** Every agent option in `card` (buttons and checkbox rows, not Other…) shows its description under the pointer. */
async function expectOptionTips(card: Locator): Promise<void> {
  const options = card.locator('.v2-opt:not([data-option="other"]), .v2-chk');
  const count = await options.count();
  let checked = 0;
  for (let i = 0; i < count; i++) {
    const option = options.nth(i);
    const label = ((await option.textContent()) ?? '').replace(/^\d+/, '').trim();
    if (label === 'Other…') continue;
    expect(TIPS[label], `unexpected option ${label}`).toBeDefined();
    expect(await tooltipUnderPointer(option), label).toBe(TIPS[label]);
    checked += 1;
  }
  expect(checked).toBeGreaterThan(0);
}

async function inboxCount(page: Page, sessionId: string): Promise<number> {
  const items = await page.evaluate(async () => (await (await fetch('/api/inbox')).json()) as Array<{ sessionId: string }>);
  return items.filter((item) => item.sessionId === sessionId).length;
}

test('every open answer card shows each option description under the pointer: Needs you, Home, Board, chat, crew', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/`);
  batchId = (await world.startSession(page, 'acme-batch', ask(BATCH))).id;
  singleId = (await world.startSession(page, 'acme-single', ask(SINGLE))).id;
  // A teammate asks too (its card shows on its crew page).
  const mate = await world.startSession(page, 'acme-mate', 'Reply with just OK.');
  await world.settle(page, mate.id);
  await world.adopt(page, mate.id, 'Developer');
  crewSessionId = mate.id;
  const sent = await world.call(page, 'POST', `/api/sessions/${mate.id}/messages`, { text: ask(SINGLE) });
  expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
  for (const id of [batchId, singleId, crewSessionId]) await expect.poll(() => inboxCount(page, id), { timeout: 20_000 }).toBe(1);

  await openWithHub(page, `${world.baseUrl}/needs-you`);
  const needs = page.getByTestId('v2-needs-list').getByTestId('v2-answer-card');
  await expect(needs).toHaveCount(3);
  for (const card of await needs.all()) await expectOptionTips(card);

  await openWithHub(page, `${world.baseUrl}/`);
  const home = page.getByTestId('v2-answer-card');
  await expect(home.first()).toBeVisible();
  for (const card of await home.all()) await expectOptionTips(card);

  await page.goto(`${world.baseUrl}/agents`);
  await page.getByTestId('v2-agents-view').locator('[data-value="board"]').click();
  await page.locator(`[data-testid="v2-bcard"][data-session="${singleId}"]`).getByTestId('v2-bcard-answer').click();
  await expect(page.getByTestId('v2-qpop')).toBeVisible();
  await expectOptionTips(page.getByTestId('v2-qpop').getByTestId('v2-answer-card'));
  await page.keyboard.press('Escape');

  for (const id of [batchId, singleId]) {
    await openWithHub(page, `${world.baseUrl}/agents/${id}`);
    const card = page.getByTestId('v2-agent-chat').getByTestId('v2-answer-card');
    await expect(card).toHaveCount(1);
    await expectOptionTips(card);
  }

  await openWithHub(page, `${world.baseUrl}/crews/team`);
  const crewCard = page.getByTestId('v2-teammate').getByTestId('v2-answer-card');
  await expect(crewCard).toHaveCount(1);
  await expectOptionTips(crewCard);
});

test('phone width: the open cards carry the descriptions (Needs you, chat), and the chat’s answered line keeps the chosen one', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await stubToolProbes(page);
    await openWithHub(page, `${world.baseUrl}/needs-you`);
    await expect(page.locator('[data-testid="v2-answer-card"]').filter({ hasText: 'Which Acme plan?' }).first()).toBeVisible();
    for (const card of await page.getByTestId('v2-answer-card').all()) await expectOptionTips(card);
    // Answer the teammate's question in its chat: the line that replaces the card keeps "Team: Up to 10 seats".
    await openWithHub(page, `${world.baseUrl}/agents/${crewSessionId}`);
    const chat = page.getByTestId('v2-agent-chat');
    await expectOptionTips(chat.getByTestId('v2-answer-card'));
    await chat.getByTestId('v2-answer-card').locator('.v2-opt', { hasText: 'Team' }).tap();
    const line = chat.getByTestId('v2-answered').locator('b.v2-grow');
    await expect(line).toContainText('Team');
    expect(await tooltipUnderPointer(line)).toBe('Team: Up to 10 seats');
    await expect.poll(() => inboxCount(page, crewSessionId), { timeout: 20_000 }).toBe(0);
  } finally {
    await context.close();
  }
});

test('answered: the chat line keeps the chosen answers’ descriptions as its tooltip, also after a reload and for an answer given on Needs you', async ({ page }) => {
  test.setTimeout(90_000);
  // The single question, from Needs you (the card leaves; its chat keeps the answer, below).
  await openWithHub(page, `${world.baseUrl}/needs-you`);
  const single = page.getByTestId('v2-needs-list').locator('[data-testid="v2-answer-card"]').filter({ hasText: 'Which Acme plan?' }).filter({ hasNot: page.locator('.v2-chip', { hasText: 'Developer' }) });
  await expect(single).toHaveCount(1);
  await single.locator('.v2-opt', { hasText: 'Basic' }).click();
  await expect.poll(() => inboxCount(page, singleId), { timeout: 20_000 }).toBe(0);

  // The batch, from its chat.
  await openWithHub(page, `${world.baseUrl}/agents/${batchId}`);
  const chat = page.getByTestId('v2-agent-chat');
  const card = chat.getByTestId('v2-answer-card');
  await expect(card).toHaveCount(1);
  await card.locator('.v2-qi-q').nth(0).locator('.v2-opt', { hasText: 'Acme US' }).click();
  await card.locator('.v2-qi-q').nth(1).getByRole('checkbox', { name: 'Tests', exact: true }).check();
  await card.getByTestId('v2-answer-send').click();
  const chatLine = chat.getByTestId('v2-answered').locator('b.v2-grow');
  await expect(chatLine).toContainText('Acme US, Tests');
  expect(await tooltipUnderPointer(chatLine)).toBe('Acme US: Virginia\nTests: Unit and E2E tests');
  await expect.poll(() => inboxCount(page, batchId), { timeout: 20_000 }).toBe(0);

  // After a reload the chat shows the server's record of the answer: the same tooltip.
  await openWithHub(page, `${world.baseUrl}/agents/${batchId}`);
  const recorded = page.getByTestId('v2-agent-chat').getByTestId('v2-agent-answered').locator('b.v2-grow');
  await expect(recorded).toContainText('Acme US, Tests');
  expect(await tooltipUnderPointer(recorded)).toBe('Acme US: Virginia\nTests: Unit and E2E tests');
  // The single question's chat too.
  await openWithHub(page, `${world.baseUrl}/agents/${singleId}`);
  const singleRow = page.getByTestId('v2-agent-chat').getByTestId('v2-agent-answered').locator('b.v2-grow');
  await expect(singleRow).toContainText('Basic');
  expect(await tooltipUnderPointer(singleRow)).toBe('Basic: One seat');
});
