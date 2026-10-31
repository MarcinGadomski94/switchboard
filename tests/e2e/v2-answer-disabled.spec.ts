import { type CDPSession, type Locator, type Page, type Route, expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { openWithHub } from './question-world.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Issue #5 · v2: an answer card that cannot be answered (its paired computer is
 * offline: a disabled fieldset) still shows each option's description. Real path:
 * fake-claude asks AskUserQuestion with a description per option; the page's
 * `GET /api/inbox` is passed through with those items marked as a paired computer's
 * that is offline (the smallest honest setup: the card's only input for that state
 * is the item's `machine`). Then, on desktop, the element under the pointer at every
 * option carries its description as its `title`; on a phone (390 × 844, touch) a long
 * press shows it in the bubble. Clicking or tapping an option answers nothing (the
 * server still waits) and the card keeps its disabled look.
 */

test.describe.configure({ mode: 'serial' });

let world: TeamWorld;

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-v2-answer-disabled', { env: { ...V2_SERVER_ENV, SWITCHBOARD_TEST_SECRET_STORE: 'memory' } });
});

test.afterAll(async () => {
  await world?.stop();
});

const BATCH = [
  { question: 'Which Acme region should I deploy to?', header: 'Region', multiSelect: false, options: [{ label: 'Acme EU', description: 'Frankfurt' }, { label: 'Acme US', description: 'Virginia' }] },
  { question: 'Which parts should I update?', header: 'Parts', multiSelect: true, options: [{ label: 'Code', description: 'The source files' }, { label: 'Tests', description: 'Unit and **E2E** tests' }] },
];
const SINGLE = [{ question: 'Which Acme plan?', header: 'Plan', multiSelect: false, options: [{ label: 'Basic', description: 'One seat' }, { label: 'Team', description: 'Up to `10` seats' }] }];
const ask = (questions: unknown): string => `[fake:ask-2q] Ask me. [fake:questions ${JSON.stringify(questions)}]`;

/** The option label → its tooltip (plain text). */
const TIPS: Record<string, string> = { 'Acme EU': 'Frankfurt', 'Acme US': 'Virginia', Code: 'The source files', Tests: 'Unit and E2E tests', Basic: 'One seat', Team: 'Up to 10 seats' };

const OFFLINE = { id: 'studio-pc', name: 'Studio-PC', state: 'offline' };
let ids: string[] = [];

/** The page's Inbox, with the test's items as an offline paired computer's. */
async function markOffline(page: Page): Promise<void> {
  await page.route(/\/api\/inbox(\?.*)?$/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const items = (await response.json()) as Array<{ sessionId: string }>;
    await route.fulfill({ response, json: items.map((item) => (ids.includes(item.sessionId) ? { ...item, machine: OFFLINE } : item)) });
  });
}

/** The server's own Inbox (not through the page's stub): the items still waiting for `sessionId`. */
async function serverInboxCount(page: Page, sessionId: string): Promise<number> {
  const items = (await (await page.request.get(`${world.baseUrl}/api/inbox`)).json()) as Array<{ sessionId: string }>;
  return items.filter((item) => item.sessionId === sessionId).length;
}

/** The agent options of `card` (buttons and checkbox rows, not Other…), with their labels. */
async function optionsOf(card: Locator): Promise<Array<{ readonly label: string; readonly option: Locator }>> {
  const options = card.locator('.v2-opt:not([data-option="other"]), .v2-chk');
  const out: Array<{ label: string; option: Locator }> = [];
  for (let i = 0; i < (await options.count()); i++) {
    const option = options.nth(i);
    const label = ((await option.textContent()) ?? '').replace(/^\d+/, '').trim();
    if (label === 'Other…') continue;
    expect(TIPS[label], `unexpected option ${label}`).toBeDefined();
    out.push({ label, option });
  }
  expect(out.length).toBeGreaterThan(0);
  return out;
}

async function centre(target: Locator): Promise<{ x: number; y: number }> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * The `title` the pointer shows at the centre of `target`: the element hit there, or its nearest ancestor with one.
 * That element must not be a disabled control (some browsers give a disabled control no mouse events, so no tooltip
 * and no long press): "(disabled …)" when it is.
 */
async function tooltipUnderPointer(page: Page, target: Locator): Promise<string | null> {
  const at = await centre(target);
  await page.mouse.move(at.x, at.y);
  return target.evaluate((el, point) => {
    let hit: Element | null = document.elementFromPoint(point.x, point.y);
    if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) return `(covered by ${hit?.outerHTML.slice(0, 80) ?? 'nothing'})`;
    if (hit.matches(':disabled')) return `(disabled ${hit.outerHTML.slice(0, 80)})`;
    while (hit && !hit.getAttribute('title')) hit = hit.parentElement;
    if (hit?.matches(':disabled')) return `(disabled ${hit.outerHTML.slice(0, 80)})`;
    return hit?.getAttribute('title') ?? null;
  }, at);
}

/** A finger held still on `target` for `ms`, then lifted. */
async function longPress(cdp: CDPSession, target: Locator, ms = 900): Promise<void> {
  const at = await centre(target);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
  await new Promise((resolve) => setTimeout(resolve, ms));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** The cards are disabled and look it; nothing was answered (on the page or on the server). */
async function expectStillWaiting(page: Page, cards: Locator): Promise<void> {
  await page.waitForTimeout(400);
  await expect(cards).toHaveCount(2);
  for (const card of await cards.all()) {
    await expect(card.getByTestId('v2-answer-offline')).toBeVisible();
    await expect(card.locator('fieldset.v2-qi-body')).toHaveAttribute('disabled', '');
    for (const checkbox of await card.getByRole('checkbox').all()) await expect(checkbox).not.toBeChecked();
  }
  // The disabled look: the questions (their options) are dimmed.
  for (const question of await cards.locator('.v2-qi-q').all()) expect(await question.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(1);
  await expect(page.getByTestId('v2-answered')).toHaveCount(0);
  for (const id of ids) expect(await serverInboxCount(page, id)).toBe(1);
}

test('desktop: on an offline computer\'s card each option shows its description under the pointer; clicking answers nothing', async ({ page }) => {
  test.setTimeout(120_000);
  await stubToolProbes(page);
  await page.goto(`${world.baseUrl}/`);
  const batch = await world.startSession(page, 'acme-off-batch', ask(BATCH));
  const single = await world.startSession(page, 'acme-off-single', ask(SINGLE));
  ids = [batch.id, single.id];
  for (const id of ids) await expect.poll(() => serverInboxCount(page, id), { timeout: 20_000 }).toBe(1);

  await markOffline(page);
  await openWithHub(page, `${world.baseUrl}/needs-you`);
  const cards = page.getByTestId('v2-needs-list').getByTestId('v2-answer-card');
  await expect(cards).toHaveCount(2);
  for (const card of await cards.all()) {
    await expect(card.getByTestId('v2-answer-offline')).toBeVisible();
    for (const { label, option } of await optionsOf(card)) expect(await tooltipUnderPointer(page, option), label).toBe(TIPS[label]);
  }
  // A click at the centre of every option (a real pointer, not a forced element click) chooses nothing.
  for (const card of await cards.all()) {
    for (const { option } of await optionsOf(card)) {
      const at = await centre(option);
      await page.mouse.click(at.x, at.y);
    }
  }
  await expectStillWaiting(page, cards);
});

test('phone: a long press on an offline computer\'s option shows its description; a tap answers nothing', async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await stubToolProbes(page);
    await markOffline(page);
    await openWithHub(page, `${world.baseUrl}/needs-you`);
    const cards = page.getByTestId('v2-needs-list').getByTestId('v2-answer-card');
    await expect(cards).toHaveCount(2);
    const cdp = await context.newCDPSession(page);
    const bubble = page.getByTestId('touch-tooltip');
    for (const card of await cards.all()) {
      for (const { label, option } of await optionsOf(card)) {
        await longPress(cdp, option);
        await expect(bubble, label).toHaveText(TIPS[label] as string);
        await page.tap('[data-testid="v2-page-needs-you"] h1');
        await expect(bubble).toHaveCount(0);
      }
    }
    for (const card of await cards.all()) {
      for (const { option } of await optionsOf(card)) {
        const at = await centre(option);
        await page.touchscreen.tap(at.x, at.y);
      }
    }
    await expectStillWaiting(page, cards);
  } finally {
    await context.close();
  }
});
