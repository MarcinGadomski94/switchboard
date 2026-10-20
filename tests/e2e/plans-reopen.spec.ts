import { expect, test } from '@playwright/test';
import { openWithHub } from './question-world.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';

/**
 * D121 (real path: fake claude, temp git, fake gh; `docs/plans.md` → *Merge step*): a done item
 * of a running plan has **Reopen** in its detail and in its list row's ⋯. Reopen puts it back to
 * work (its todo open again) and the dependent that started while it was done shows the warning
 * "started before PROJ-1 was merged — its branch may lack that work" (⚠ on its row, the note in
 * its detail).
 */
let world: PlansWorld;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startPlansWorld();
});

test.afterAll(async () => {
  await world?.stop();
});

test('Reopen a done item from the list ⋯; its early-started dependent shows the warning', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/plans`);
  await world.setPlans(page, true);
  const source = await world.sourceSession(page, 'reopen-source');
  const first = await world.addTodo(page, source, 'Cart API [fake:hold 60]', 30);
  const second = await world.addTodo(page, source, 'Cart page [fake:hold 60]', 30);
  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: source, title: 'Acme checkout', targetBranch: world.target, baseBranch: 'main', maxConcurrency: 2 });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const planId = created.body.id as string;
  expect((await world.call(page, 'POST', `/api/plans/${planId}/items`, { todoId: first, key: 'PROJ-1' })).status).toBe(201);
  expect((await world.call(page, 'POST', `/api/plans/${planId}/items`, { todoId: second, key: 'PROJ-2', after: ['PROJ-1'] })).status).toBe(201);
  expect((await world.call(page, 'POST', `/api/plans/${planId}/start`, { mergeMode: 'agents' })).status).toBe(200);
  const a = await world.itemIn(page, planId, 'PROJ-1', 'running');
  // Counted done (the way a false merge did it): PROJ-2 starts on it.
  expect((await world.call(page, 'POST', `/api/plans/${planId}/items/${a.id}/done`)).status).toBe(200);
  await world.itemIn(page, planId, 'PROJ-2', 'running');

  await page.goto(`${world.baseUrl}/plans/${planId}`);
  // The detail of the done item has Reopen.
  await page.locator(`[data-testid="plan-card-details"][data-item-id="${a.id}"]`).click();
  await expect(page.getByTestId('plan-detail')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('plan-detail-reopen')).toBeVisible();

  // The list row's ⋯ → Reopen.
  await page.getByTestId('plan-tab-list').click();
  const row = (key: string) => page.locator('[data-testid="plan-row"]').filter({ hasText: key });
  await expect(row('PROJ-1')).toHaveAttribute('data-state', 'done');
  await row('PROJ-1').getByTestId('plan-row-more').click();
  await row('PROJ-1').getByTestId('plan-row-reopen').click();
  await expect(row('PROJ-1')).not.toHaveAttribute('data-state', 'done');
  expect((await world.plan(page, planId)).items.find((item) => item.key === 'PROJ-1')).toMatchObject({ storedState: 'running', doneAt: null, note: 'Reopened: reopened by you' });

  // The dependent that started early: ⚠ on its row, the warning in its detail; it keeps running.
  const warning = 'started before PROJ-1 was merged — its branch may lack that work';
  await expect(row('PROJ-2').getByTestId('plan-row-warning')).toBeVisible();
  await expect(row('PROJ-2').getByTestId('plan-row-warning')).toHaveAttribute('title', warning);
  await row('PROJ-2').getByTestId('plan-row-details').click();
  await expect(page.getByTestId('plan-detail-note')).toContainText(warning);
  await expect(page.getByTestId('plan-detail')).toHaveAttribute('data-state', 'running');
});
