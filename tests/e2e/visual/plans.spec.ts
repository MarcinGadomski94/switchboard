import { type Page, expect, test } from '@playwright/test';
import type { Plan, PlanItem } from '../../../src/core/plans.ts';
import type { Review } from '../../../src/core/reviews.ts';
import { openWithHub } from '../question-world.ts';
import { type PlansWorld, startPlansWorld } from '../plans-world.ts';
import { canonicalColors, writeReport } from './harness.ts';

/**
 * D99 · the Plans page's visual check. Not in the prototype: the design is the developer's
 * approved clickable mockup (`docs/plans-ui.md` → *The Plans page*), so this spec checks the
 * design's rules rather than a pixel diff: each card's left border colour and icon by state
 * (waiting grey, running blue, question amber, in review violet, done green, blocked red),
 * the ⚑ you flag of hold items, the critical path (amber 2 px edges, dashed card outlines),
 * the final dashed ◇ node, the Timeline's segment colours, the layout per size (desktop:
 * graph and detail; tablet: the graph scrolls sideways inside its box, the page does not;
 * phone: the List and a full-screen detail), and no sideways page overflow. It runs on the
 * real path (fake claude, temp git; demo mode never runs plans) and writes `plans.md` plus a
 * screenshot per view and size to `test-results/visual/` (and `docs/visual/` with
 * SWITCHBOARD_VISUAL_REPORT=1).
 *
 * Plans off is covered by the existing visual specs (shell, session panel, settings), which
 * must pass unchanged.
 */

const SIZES = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 1024, height: 768 },
  phone: { width: 390, height: 844 },
} as const;

let world: PlansWorld;
let plan: Plan;
const lines: string[] = ['# Plans page (D99) · visual check', '', 'The Plans page is not in the prototype; its reference is the approved mockup described in `docs/plans-ui.md` → *The Plans page*. Checked: state colours and icons, hold flags, the critical path, the final node, timeline segments, layout per size, no sideways overflow.', ''];
const shots: Record<string, Buffer> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startPlansWorld();
});

test.afterAll(async () => {
  await writeReport({ 'plans.md': `${lines.join('\n')}\n`, ...shots });
  await world?.stop();
});

async function shoot(page: Page, name: string): Promise<void> {
  if (await page.getByTestId('toast').isVisible()) await page.getByTestId('toast').getByRole('button', { name: 'Close' }).click();
  await page.mouse.move(0, 0);
  shots[name] = await page.screenshot({ fullPage: false });
  lines.push(`- \`${name}\``);
}

async function style(page: Page, selector: string, prop: string): Promise<string> {
  return page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

const card = (key: string): string => `[data-testid="plan-card"][data-key="${key}"]`;

test('a plan in every state', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize(SIZES.desktop);
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await world.setPlans(page, true);
  const source = await world.sourceSession(page, 'acme-epic');
  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: source, title: 'PROJ-3100 Acme checkout', targetBranch: world.target, baseBranch: 'main', maxConcurrency: 4 });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = (created.body as Plan).id;
  const add = async (key: string, title: string, minutes: number, after: string[] = [], hold = false): Promise<void> => {
    const answer = await world.call(page, 'POST', `/api/plans/${id}/items`, { key, todo: { title, estimateMinutes: minutes }, after, hold });
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  };
  await add('PROJ-3151', 'Checkout API contract (ADR)', 45, [], true);
  await add('PROJ-3170', 'Receipt e-mail template', 30, [], true);
  await add('PROJ-3152', 'Checkout screen', 90, ['PROJ-3151'], true);
  await add('PROJ-3157', 'Payment form [fake:ask-2q]', 60, ['PROJ-3151']);
  await add('PROJ-3160', 'Order summary [fake:hold 600]', 120, ['PROJ-3151']);
  await add('PROJ-3165', 'Wire checkout to the API', 60, ['PROJ-3152', 'PROJ-3157']);
  await add('PROJ-3172', 'Checkout E2E', 45, ['PROJ-3165', 'PROJ-3160']);
  const started = await world.call(page, 'POST', `/api/plans/${id}/start`, { mergeMode: 'agents-with-holds' });
  expect(started.status, JSON.stringify(started.body)).toBe(200);

  // 3170: its review discarded → blocked. 3151: merged by me → done; then 3152 (in review), 3157 (asks), 3160 (works on).
  await world.agentWorks(page, id, 'PROJ-3170');
  await world.agentWorks(page, id, 'PROJ-3151');
  const reviewOf = async (key: string): Promise<Review> => {
    const item = (await world.itemIn(page, id, key, 'review')) as PlanItem;
    let found: Review | undefined;
    await expect
      .poll(async () => {
        found = ((await world.call(page, 'GET', '/api/reviews')).body as Review[]).find((review) => review.sessionId === item.runSessionId && review.state === 'pending');
        return found !== undefined;
      })
      .toBe(true);
    return found as Review;
  };
  const discard = await reviewOf('PROJ-3170');
  expect((await world.call(page, 'POST', `/api/reviews/${discard.id}/discard`, { confirm: true })).status).toBe(200);
  const merge = await reviewOf('PROJ-3151');
  expect((await world.call(page, 'POST', `/api/reviews/${merge.id}/merge`, {})).status).toBe(200);
  await world.itemIn(page, id, 'PROJ-3151', 'done');
  await world.itemIn(page, id, 'PROJ-3170', 'blocked');
  await world.agentWorks(page, id, 'PROJ-3152');
  await world.itemIn(page, id, 'PROJ-3152', 'review');
  await world.itemIn(page, id, 'PROJ-3157', 'question');
  await world.itemIn(page, id, 'PROJ-3160', 'running');
  plan = await world.plan(page, id);
  expect(plan.items.map((item) => `${item.key}:${item.state}`)).toEqual(['PROJ-3151:done', 'PROJ-3170:blocked', 'PROJ-3152:review', 'PROJ-3157:question', 'PROJ-3160:running', 'PROJ-3165:waiting', 'PROJ-3172:waiting']);
});

test('desktop: the graph, its colours and the critical path; the detail; the timeline; the list; the dialog', async ({ page }) => {
  await page.setViewportSize(SIZES.desktop);
  await openWithHub(page, `${world.baseUrl}/plans`);
  await expect(page.getByTestId('plan-summary')).toHaveCount(1);
  lines.push('## Desktop (1440 × 900)', '');
  await shoot(page, 'plans-list-desktop.png');

  await page.goto(`${world.baseUrl}/plans/${plan.id}`);
  await expect(page.getByTestId('plan-card')).toHaveCount(7);
  await expect(page.getByTestId('plan-mode-chip')).toHaveText('Merge: agents · hold ⚑ 3151, 3170, 3152');
  await expect(page.getByTestId('plan-progress')).toContainText('1/7 done');
  const [idle, run, need, done, fail, review] = await canonicalColors(page, ['#5a5955', 'oklch(0.72 0.12 250)', 'oklch(0.8 0.14 70)', 'oklch(0.74 0.13 150)', 'oklch(0.68 0.17 25)', 'oklch(0.75 0.12 310)']);
  const expected: Record<string, [string | null | undefined, string]> = {
    'PROJ-3151': [done, '✔'],
    'PROJ-3170': [fail, '✖'],
    'PROJ-3152': [review, '◐'],
    'PROJ-3157': [need, '?'],
    'PROJ-3160': [run, '●'],
    'PROJ-3165': [idle, '○'],
  };
  for (const [key, [colour, icon]] of Object.entries(expected)) {
    expect(await style(page, card(key), 'border-left-color'), key).toBe(colour);
    expect(await style(page, card(key), 'border-left-width'), key).toBe('3px');
    await expect(page.locator(card(key)).locator('.sb-plan-card__icon')).toHaveText(icon);
  }
  expect(await style(page, card('PROJ-3165'), 'width')).toBe('190px');
  await expect(page.locator(card('PROJ-3151')).getByTestId('plan-card-hold')).toHaveText('⚑ you');
  await expect(page.locator(card('PROJ-3157')).getByTestId('plan-card-status')).toHaveText('needs your answer');
  await expect(page.locator(card('PROJ-3165')).getByTestId('plan-card-status')).toHaveText('waiting on 3152, 3157');
  lines.push(`- card left borders: done ${done}, blocked ${fail}, review ${review}, question ${need}, running ${run}, waiting ${idle}`);

  // The critical path: amber 2 px edges and dashed outlines.
  const onPath = plan.criticalPath.itemIds;
  expect(onPath.length).toBeGreaterThan(1);
  const firstKey = plan.items.find((item) => item.id === onPath[0])?.key as string;
  expect(await style(page, card(firstKey), 'outline-style')).toBe('dashed');
  expect(await style(page, card(firstKey), 'outline-color')).toBe(need);
  const criticalEdge = page.locator('.sb-plan-edge[data-critical]').first();
  expect(await criticalEdge.evaluate((el) => getComputedStyle(el).getPropertyValue('stroke-width'))).toBe('2px');
  expect(await criticalEdge.evaluate((el) => getComputedStyle(el).getPropertyValue('stroke'))).toBe(need);
  expect(await style(page, '[data-testid="plan-final"]', 'border-top-style')).toBe('dashed');
  await expect(page.getByTestId('plan-final')).toHaveText(`◇ ${world.target} → main · yours`);
  lines.push(`- critical path ${onPath.length} items: edges 2px ${need}, cards outlined dashed; final node dashed`);
  // Off: no amber.
  await page.getByTestId('plan-critical-chip').click();
  await expect(page.locator('.sb-plan-edge[data-critical]')).toHaveCount(0);
  await page.getByTestId('plan-critical-chip').click();

  // A DAG wider than the panel scrolls sideways (a fade on the side with more); scrolled to the end, the final node shows whole.
  const scroller = page.getByTestId('plan-graph');
  const wide = await scroller.evaluate((el) => el.scrollWidth > el.clientWidth);
  if (wide) {
    await expect(page.locator('.sb-plan-graph-frame')).toHaveAttribute('data-fade-right', 'true');
    await scroller.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    await expect(page.locator('.sb-plan-graph-frame')).not.toHaveAttribute('data-fade-right', 'true');
    await expect(page.locator('.sb-plan-graph-frame')).toHaveAttribute('data-fade-left', 'true');
  }
  const finalBox = await page.getByTestId('plan-final').boundingBox();
  const scrollBox = await scroller.boundingBox();
  expect(finalBox && scrollBox && finalBox.x >= scrollBox.x && finalBox.x + finalBox.width <= scrollBox.x + scrollBox.width).toBe(true);
  lines.push(`- graph: ${wide ? 'wider than the panel: scrolls sideways with an edge fade; scrolled to the end the final node shows whole' : 'fits the panel'}`);
  if (wide) await shoot(page, 'plans-graph-end-desktop.png');
  await scroller.evaluate((el) => el.scrollTo({ left: 0 }));

  await page.locator(card('PROJ-3152')).click();
  await expect(page.getByTestId('plan-detail-review')).toBeVisible();
  await page.getByTestId('plan-graph').scrollIntoViewIfNeeded();
  await shoot(page, 'plans-graph-desktop.png');
  await page.getByTestId('plan-detail').scrollIntoViewIfNeeded();
  await shoot(page, 'plans-detail-review-desktop.png');
  await page.locator(card('PROJ-3157')).click();
  await expect(page.getByTestId('plan-detail').getByTestId('question-card')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('plan-detail').scrollIntoViewIfNeeded();
  await shoot(page, 'plans-detail-question-desktop.png');
  await page.locator(card('PROJ-3170')).click();
  expect(await style(page, '[data-testid="plan-detail-reason"]', 'border-left-color')).toBe(fail);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  await page.getByTestId('plan-tab-timeline').click();
  await expect(page.getByTestId('plan-timeline-row')).toHaveCount(7);
  expect(await style(page, '[data-testid="plan-segment"][data-kind="working"]', 'background-color')).toBe(run);
  expect(await style(page, '[data-testid="plan-segment"][data-kind="you"]', 'background-color')).toBe(need);
  expect(await style(page, '[data-testid="plan-segment"][data-kind="projected"]', 'border-top-style')).toBe('dashed');
  await expect(page.getByTestId('plan-timeline-summary')).toHaveText(/^Waiting on you: .* · Projected finish: /);
  lines.push(`- timeline: working ${run}, waiting on you ${need}, projected dashed`);
  await shoot(page, 'plans-timeline-desktop.png');

  await page.getByTestId('plan-tab-list').click();
  await expect(page.getByTestId('plan-row')).toHaveCount(7);
  await expect(page.getByTestId('plan-row-answer')).toHaveCount(1);
  await expect(page.getByTestId('plan-row-merge')).toHaveCount(1);
  await shoot(page, 'plans-list-view-desktop.png');

  await page.getByTestId('plan-mode-chip').click();
  await expect(page.getByTestId('plan-mode-dialog')).toBeVisible();
  await page.locator('[data-testid="plan-mode-dialog"] [data-mode="agents-with-holds"]').check();
  await shoot(page, 'plans-mode-dialog-desktop.png');
  await page.keyboard.press('Escape');
  lines.push('');
});

test('tablet: the graph scrolls sideways inside its box', async ({ page }) => {
  await page.setViewportSize(SIZES.tablet);
  await openWithHub(page, `${world.baseUrl}/plans/${plan.id}`);
  await expect(page.getByTestId('plan-card')).toHaveCount(7);
  const box = await page.getByTestId('plan-graph').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, overflowX: getComputedStyle(el).overflowX }));
  expect(box.overflowX).toBe('auto');
  expect(box.scroll).toBeGreaterThan(box.client);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.getByTestId('plan-graph').evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  const finalBox = await page.getByTestId('plan-final').boundingBox();
  const scrollBox = await page.getByTestId('plan-graph').boundingBox();
  expect(finalBox && scrollBox && finalBox.x + finalBox.width <= scrollBox.x + scrollBox.width).toBe(true);
  await page.getByTestId('plan-graph').evaluate((el) => el.scrollTo({ left: 0 }));
  lines.push('## Tablet (1024 × 768)', '', `- graph ${box.scroll}px wide in a ${box.client}px box (scrolls sideways, fade on the right; the final node whole at the end); the page does not`);
  await shoot(page, 'plans-graph-tablet.png');
  lines.push('');
});

test('phone: the List, then a full-screen detail', async ({ page }) => {
  await page.setViewportSize(SIZES.phone);
  await openWithHub(page, `${world.baseUrl}/plans/${plan.id}`);
  await expect(page.getByTestId('plan-row')).toHaveCount(7);
  await expect(page.getByTestId('plan-graph')).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  lines.push('## Phone (390 × 844)', '');
  await shoot(page, 'plans-list-phone.png');
  await page.locator('[data-testid="plan-row"]').filter({ hasText: 'PROJ-3157' }).locator('.sb-plan-row__main').click();
  await expect(page.getByTestId('plan-detail').getByTestId('question-card')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('plan-detail-back')).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shoot(page, 'plans-detail-phone.png');
  lines.push('');
});
