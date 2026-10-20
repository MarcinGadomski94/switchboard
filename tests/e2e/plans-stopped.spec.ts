import { expect, test } from '@playwright/test';
import { openWithHub } from './question-world.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';

/**
 * D120 (real path: fake claude, temp git, fake gh; `docs/plans.md` → *Stopped items*): an item
 * whose agent ends its turn without marking its todo done turns red **"Stopped — needs you"**
 * once the grace period is over (shortened here, `SWITCHBOARD_PLAN_STOPPED_GRACE_MS`), with the
 * agent's last message as the reason; the Inbox shows "Stopped: <item> (<plan>)" with Open
 * session; a click on the item (graph card or list row) opens its run session, and ⓘ / Details
 * still shows its detail. Also at phone width.
 */
let world: PlansWorld;
let planId = '';
let runSessionId = '';
const LAST = 'Not finished, so the todo stays open. Left: re-run one CI check.';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startPlansWorld({ SWITCHBOARD_PLAN_STOPPED_GRACE_MS: '1500' });
});

test.afterAll(async () => {
  await world?.stop();
});

test('an item whose agent ended its turn without finishing turns red "Stopped" with the excerpt, and the Inbox says so', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await world.setPlans(page, true);
  const source = await world.sourceSession(page, 'stopped-source');
  const stops = await world.addTodo(page, source, `Fix check [fake:say ${JSON.stringify(LAST)}]`, 30);
  const after = await world.addTodo(page, source, 'Ship it', 30);
  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: source, title: 'Acme checkout', targetBranch: world.target, baseBranch: 'main', maxConcurrency: 1 });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  planId = created.body.id as string;
  const first = await world.call(page, 'POST', `/api/plans/${planId}/items`, { todoId: stops, key: 'PROJ-1' });
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  const second = await world.call(page, 'POST', `/api/plans/${planId}/items`, { todoId: after, key: 'PROJ-2', after: ['PROJ-1'] });
  expect(second.status, JSON.stringify(second.body)).toBe(201);
  const started = await world.call(page, 'POST', `/api/plans/${planId}/start`, { mergeMode: 'agents' });
  expect(started.status, JSON.stringify(started.body)).toBe(200);

  await page.goto(`${world.baseUrl}/plans/${planId}`);
  const card = (key: string) => page.locator(`[data-testid="plan-card"][data-key="${key}"]`);
  // Its run answers the brief and ends its turn; the todo stays open → stopped after the grace period.
  const item = await world.itemIn(page, planId, 'PROJ-1', 'stopped');
  runSessionId = item.runSessionId as string;
  expect(item.reason).toBe(LAST);
  await expect(card('PROJ-1')).toHaveAttribute('data-state', 'stopped');
  await expect(card('PROJ-1').getByTestId('plan-card-status')).toHaveText('Stopped — needs you');
  // Red: the state's colour is the failure red (as blocked), with its own icon.
  await expect(card('PROJ-1').locator('.sb-plan-card__icon')).toHaveAttribute('style', /--status-fail/);
  await expect(card('PROJ-1').locator('.sb-plan-card__icon')).toHaveText('■');
  await expect(card('PROJ-2')).toHaveAttribute('data-state', 'waiting');
  await expect(page.getByTestId('plan-stopped')).toHaveText('■ 1 stopped');
  await expect(page.getByTestId('plan-legend')).toContainText('stopped');

  // ⓘ shows the detail: "Stopped: <excerpt>" and a prominent Open session.
  await page.locator(`[data-testid="plan-card-details"][data-item-id="${item.id}"]`).click();
  const detail = page.getByTestId('plan-detail');
  await expect(detail).toHaveAttribute('data-state', 'stopped');
  await expect(detail.getByTestId('plan-detail-stopped-reason')).toHaveText(`Stopped: ${LAST}`);
  await expect(detail.getByTestId('plan-detail-stopped-open')).toBeVisible();

  // The Plans list card has the red count.
  await page.goto(`${world.baseUrl}/plans`);
  await expect(page.locator(`[data-testid="plan-summary"][data-plan-id="${planId}"]`).getByTestId('plan-summary-stopped')).toHaveText('■ 1 stopped');

  // The Inbox: "Stopped: PROJ-1 … (Acme checkout)" with the excerpt, Open session and Dismiss.
  await page.goto(`${world.baseUrl}/inbox`);
  const inboxCard = page.getByTestId('inbox-item').filter({ hasText: 'Stopped: PROJ-1' });
  await expect(inboxCard).toHaveCount(1, { timeout: 15_000 });
  await inboxCard.click();
  const inboxDetail = page.getByTestId('inbox-detail');
  await expect(inboxDetail.getByTestId('inbox-title')).toContainText('(Acme checkout)');
  await expect(inboxDetail.getByTestId('inbox-text')).toContainText(LAST);
  const actions = inboxDetail.getByTestId('inbox-action');
  await expect(actions).toHaveText(['Open session', 'Dismiss']);
  await actions.filter({ hasText: 'Open session' }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${runSessionId}`));
});

test('one click on the item (graph card, keyboard too) opens its run session', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/plans/${planId}`);
  const card = page.locator('[data-testid="plan-card"][data-key="PROJ-1"]');
  await expect(card).toHaveAttribute('data-state', 'stopped');
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${runSessionId}`));
  // Keyboard: focus the card and press Enter.
  await page.goto(`${world.baseUrl}/plans/${planId}`);
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/sessions/${runSessionId}`));
  // An item without a session keeps today's behaviour: the click shows its detail.
  await page.goto(`${world.baseUrl}/plans/${planId}`);
  await page.locator('[data-testid="plan-card"][data-key="PROJ-2"]').click();
  await expect(page.getByTestId('plan-detail')).toHaveAttribute('data-state', 'waiting');
  await expect(page).toHaveURL(new RegExp(`/plans/${planId}$`));
});

test('phone: the red row, Details, and a tap on the row opens the session', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${world.baseUrl}/plans/${planId}`);
  const row = page.locator('[data-testid="plan-row"][data-state="stopped"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Stopped — needs you');
  await expect(page.getByTestId('plan-stopped')).toHaveText('■ 1 stopped');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await row.getByTestId('plan-row-details').click();
  await expect(page.getByTestId('plan-detail-stopped-reason')).toHaveText(`Stopped: ${LAST}`);
  await page.getByTestId('plan-detail-back').click();
  await row.locator('.sb-plan-row__main').click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${runSessionId}`));
});

test('the developer replies: the item runs again and the Inbox item closes', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await expect(page.getByTestId('inbox-item').filter({ hasText: 'Stopped: PROJ-1' })).toHaveCount(1);
  // A long turn, so "running" can be seen before it stops again.
  const sent = await world.call(page, 'POST', `/api/sessions/${runSessionId}/messages`, { text: 'Re-run it, please. [fake:hold 4]' });
  expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
  await world.itemIn(page, planId, 'PROJ-1', 'running', 15_000);
  await expect(page.getByTestId('inbox-item').filter({ hasText: 'Stopped: PROJ-1' })).toHaveCount(0, { timeout: 15_000 });
});
