import { type CDPSession, type Locator, type Page, expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { openWithHub } from './question-world.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.4.12 · D74 in v2 (`docs/responsive.md` → *Touch*): v2 mounts classic's
 * long-press tooltip (`TouchTooltip`). On a phone (390 × 844, a touch screen) a long
 * press on an open answer option shows its description in a bubble and does not
 * answer; a normal tap still answers. A long press where it means something else
 * in v2 shows no bubble: a draggable card (the browser's drag) and a Project graph
 * step (its menu).
 * Chromium's touches go through CDP (`Input.dispatchTouchEvent`), as in
 * `responsive-touch.spec.ts`.
 */

test.describe.configure({ mode: 'serial' });

let world: TeamWorld;

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-v2-touch-tooltip', { env: { ...V2_SERVER_ENV, SWITCHBOARD_TEST_SECRET_STORE: 'memory' } });
});

test.afterAll(async () => {
  await world?.stop();
});

const Q = [{ question: 'Which Acme plan?', header: 'Plan', multiSelect: false, options: [{ label: 'Basic', description: 'One seat' }, { label: 'Team', description: 'Up to `10` seats' }] }];
const ask = (questions: unknown): string => `[fake:ask-2q] Ask me. [fake:questions ${JSON.stringify(questions)}]`;

async function inboxCount(page: Page, sessionId: string): Promise<number> {
  const items = await page.evaluate(async () => (await (await fetch('/api/inbox')).json()) as Array<{ sessionId: string }>);
  return items.filter((item) => item.sessionId === sessionId).length;
}

async function centre(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error('no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A finger held still on `target` for `ms`, then lifted. */
async function longPress(cdp: CDPSession, target: Locator, ms = 900): Promise<void> {
  const at = await centre(target);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
  await new Promise((resolve) => setTimeout(resolve, ms));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('phone: a long press on an answer option shows its description and does not answer; a tap answers', async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await stubToolProbes(page);
    await page.goto(`${world.baseUrl}/`);
    const { id } = await world.startSession(page, 'acme-touch', ask(Q));
    await expect.poll(() => inboxCount(page, id), { timeout: 20_000 }).toBe(1);
    await openWithHub(page, `${world.baseUrl}/needs-you`);
    const card = page.getByTestId('v2-needs-list').getByTestId('v2-answer-card');
    await expect(card).toHaveCount(1);
    const basic = card.locator('.v2-opt', { hasText: 'Basic' });
    const team = card.locator('.v2-opt', { hasText: 'Team' });
    const cdp = await context.newCDPSession(page);

    await longPress(cdp, basic);
    const bubble = page.getByTestId('touch-tooltip');
    await expect(bubble).toHaveText('One seat');
    // It sits above the option, inside the window.
    const tip = await bubble.boundingBox();
    const option = await basic.boundingBox();
    expect(tip && option && tip.y + tip.height <= option.y + 1).toBe(true);
    expect(tip && tip.x >= 0 && tip.x + tip.width <= 390).toBe(true);
    // The press did not answer: the card is still open, and the server still waits.
    await page.waitForTimeout(500);
    await expect(card).toHaveCount(1);
    await expect(page.getByTestId('v2-answered')).toHaveCount(0);
    expect(await inboxCount(page, id)).toBe(1);

    // The other option's description (Markdown in the question, plain text in the bubble).
    await longPress(cdp, team);
    await expect(bubble).toHaveText('Up to 10 seats');

    // Where a long press means something else in v2 it shows nothing: a draggable card (the browser's drag)
    // and a Project graph step (its menu). Stand-ins with a title, so only the skip rule keeps the bubble away
    // (the first, a plain element, shows that the stand-in itself would get one).
    await page.tap('[data-testid="v2-page-needs-you"] h1');
    await expect(bubble).toHaveCount(0);
    for (const [attr, shows] of [['data-plain', true], ['draggable', false], ['data-graph-node', false]] as const) {
      await page.evaluate((name) => {
        const el = document.createElement('div');
        el.setAttribute(name, name === 'draggable' ? 'true' : '');
        el.setAttribute('title', 'Not a tooltip here');
        el.setAttribute('data-testid', 'probe-skip');
        el.textContent = name;
        Object.assign(el.style, { position: 'fixed', left: '20px', top: '300px', width: '160px', height: '48px', zIndex: '50', background: '#ccc' });
        document.body.append(el);
      }, attr);
      await longPress(cdp, page.getByTestId('probe-skip'));
      if (shows) await expect(bubble, attr).toHaveText('Not a tooltip here');
      else {
        // Not a retrying check: a bubble would leave by itself after 3 s.
        await page.waitForTimeout(300);
        expect(await bubble.count(), attr).toBe(0);
      }
      await page.tap('[data-testid="v2-page-needs-you"] h1');
      await expect(bubble).toHaveCount(0);
      await page.evaluate(() => document.querySelector('[data-testid="probe-skip"]')?.remove());
    }

    // A normal tap still answers.
    await team.tap();
    await expect(card).toHaveCount(0);
    await expect.poll(() => inboxCount(page, id), { timeout: 20_000 }).toBe(0);
  } finally {
    await context.close();
  }
});

test('desktop (a fine pointer): no bubble, a long mouse press is a normal click', async ({ page }) => {
  await stubToolProbes(page);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'acme-desk', ask(Q));
  await expect.poll(() => inboxCount(page, id), { timeout: 20_000 }).toBe(1);
  await openWithHub(page, `${world.baseUrl}/needs-you`);
  const basic = page.getByTestId('v2-needs-list').getByTestId('v2-answer-card').locator('.v2-opt', { hasText: 'Basic' });
  await basic.click({ delay: 900 });
  await expect(page.getByTestId('touch-tooltip')).toHaveCount(0);
  await expect.poll(() => inboxCount(page, id), { timeout: 20_000 }).toBe(0);
});
