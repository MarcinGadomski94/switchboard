import { type Page, expect, test } from '@playwright/test';
import { openWithHub } from './question-world.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';

/**
 * D117 (`docs/plans-ui.md` → *Deleting a plan*, *The Jira section*): a plan is deleted from the
 * Plans list's row ⋯ and from the plan page's **Delete plan…** (a running one is cancelled first);
 * a draft Jira plan's **Re-read dependencies from Jira** lists the change, then applies it. Real
 * path: fake-claude, temp git, the fake Jira (never the real Jira).
 */

let world: PlansWorld;
let source = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startPlansWorld();
});

test.afterAll(async () => {
  await world?.stop();
});

async function draft(page: Page, title: string, todos: readonly string[] = ['Acme step']): Promise<string> {
  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: source, title, targetBranch: world.target, baseBranch: 'main' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const planId = created.body.id as string;
  for (const [index, todo] of todos.entries()) expect((await world.call(page, 'POST', `/api/plans/${planId}/items`, { key: `PROJ-${index + 1}`, todo: { title: todo, estimateMinutes: 20 } })).status).toBe(201);
  return planId;
}

test('delete a draft from the Plans list ⋯', async ({ page }) => {
  test.setTimeout(60_000);
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await world.setPlans(page, true);
  source = await world.sourceSession(page, 'plans-delete');
  const planId = await draft(page, 'Acme list delete');
  await page.goto(`${world.baseUrl}/plans`);
  const row = page.locator('.sb-plan-summary-item').filter({ has: page.locator(`[data-plan-id="${planId}"]`) });
  const more = row.getByTestId('plan-row-menu');
  await expect(more).toHaveAttribute('aria-label', 'Actions for Acme list delete');
  // The ⋯ is outside the row's link: it never opens the plan.
  await expect(row.locator('a').getByTestId('plan-row-menu')).toHaveCount(0);
  // Keyboard: Enter opens the menu with Delete… focused; Esc closes it back on ⋯.
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('plan-row-delete')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
  await more.click();
  await page.getByTestId('plan-row-delete').click();
  const confirm = page.getByTestId('plan-delete-confirm');
  await expect(confirm).toContainText('Delete “Acme list delete”? Its items\' todos and their sessions stay; only the plan goes.');
  await expect(page.getByTestId('plan-delete-note')).toHaveCount(0);
  await expect(page.getByTestId('plan-delete-cancel')).toBeFocused();
  await page.getByTestId('plan-delete-yes').click();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator(`[data-testid="plan-summary"][data-plan-id="${planId}"]`)).toHaveCount(0);
  expect((await world.call(page, 'GET', `/api/plans/${planId}`)).status).toBe(404);
  // The todo stays in its session.
  const todos = (await world.call(page, 'GET', `/api/sessions/${source}/todos`)).body.todos as Array<{ title: string }>;
  expect(todos.map((todo) => todo.title)).toContain('Acme step');
});

test('delete a draft from the plan page', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/inbox`);
  const planId = await draft(page, 'Acme page delete');
  await page.goto(`${world.baseUrl}/plans/${planId}`);
  await expect(page.getByTestId('plan-page')).toBeVisible();
  await page.getByTestId('plan-delete').click();
  await expect(page.getByTestId('plan-delete-confirm')).toContainText('Delete “Acme page delete”?');
  // Cancel keeps it.
  await page.getByTestId('plan-delete-cancel').click();
  await expect(page.getByTestId('plan-page')).toBeVisible();
  await page.getByTestId('plan-delete').click();
  await page.getByTestId('plan-delete-yes').click();
  await expect(page).toHaveURL(new RegExp('/plans$'));
  await expect(page.getByTestId('plans-page')).toBeVisible();
  await expect(page.locator(`[data-testid="plan-summary"][data-plan-id="${planId}"]`)).toHaveCount(0);
  expect((await world.call(page, 'GET', `/api/plans/${planId}`)).status).toBe(404);
});

test('delete a running plan: it is cancelled first and its working session stopped, then deleted', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/inbox`);
  // [fake:hold 60]: the item's turn keeps working until it is stopped.
  const planId = await draft(page, 'Acme running delete', ['Acme running step [fake:hold 60]']);
  expect((await world.call(page, 'POST', `/api/plans/${planId}/start`, { mergeMode: 'developer' })).status).toBe(200);
  const item = await world.itemIn(page, planId, 'PROJ-1', 'running');
  const runId = item.runSessionId as string;
  await expect.poll(async () => (await world.call(page, 'GET', `/api/sessions/${runId}`)).body.status, { timeout: 20_000 }).toBe('run');
  // The server alone refuses a running plan (plain DELETE is unchanged).
  expect((await world.call(page, 'DELETE', `/api/plans/${planId}`)).body.error).toBe('running');
  await page.goto(`${world.baseUrl}/plans/${planId}`);
  await expect(page.getByTestId('plan-state')).toHaveAttribute('data-state', 'running');
  await page.getByTestId('plan-delete').click();
  await expect(page.getByTestId('plan-delete-note')).toHaveText('It is running: it is cancelled first and its running session is stopped (they stay in the sidebar); then the plan is deleted.');
  await page.getByTestId('plan-delete-yes').click();
  await expect(page).toHaveURL(new RegExp('/plans$'));
  expect((await world.call(page, 'GET', `/api/plans/${planId}`)).status).toBe(404);
  // Its session was stopped, not closed: it stays.
  await expect.poll(async () => (await world.call(page, 'GET', `/api/sessions/${runId}`)).body.status, { timeout: 20_000 }).not.toBe('run');
  const session = (await world.call(page, 'GET', `/api/sessions/${runId}`)).body;
  expect(session.closedAt ?? null).toBeNull();
});

test('Re-read dependencies from Jira on a draft Jira plan lists the change, then applies it', async ({ page }) => {
  test.setTimeout(60_000);
  await openWithHub(page, `${world.baseUrl}/inbox`);
  const imported = await world.call(page, 'POST', `/api/sessions/${source}/plans/jira/import`, { epic: 'PROJ-10', targetBranch: 'feature/PROJ-10-acme-checkout' });
  expect(imported.status, JSON.stringify(imported.body)).toBe(201);
  const planId = imported.body.plan.id as string;
  const ids: Record<string, string> = Object.fromEntries((imported.body.plan.items as Array<{ key: string; id: string }>).map((item) => [item.key, item.id]));
  // An import made before the fix: PROJ-11 → PROJ-12 the wrong way round.
  expect((await world.call(page, 'DELETE', `/api/plans/${planId}/edges/${ids['PROJ-11']}/${ids['PROJ-12']}`)).status).toBe(200);
  expect((await world.call(page, 'POST', `/api/plans/${planId}/edges`, { from: ids['PROJ-12'], to: ids['PROJ-11'] })).status).toBe(200);

  await page.goto(`${world.baseUrl}/plans/${planId}`);
  await page.getByTestId('plan-jira-reread').click();
  const dialog = page.getByTestId('plan-jira-relink');
  await expect(dialog.getByTestId('plan-jira-relink-removed').locator('li')).toHaveText(['PROJ-11 waits on PROJ-12']);
  await expect(dialog.getByTestId('plan-jira-relink-added').locator('li')).toHaveText(['PROJ-12 waits on PROJ-11']);
  await dialog.getByTestId('plan-jira-relink-apply').click();
  await expect(dialog).toHaveCount(0);
  const edges = (await world.plan(page, planId)).edges.map((edge) => `${edge.from}>${edge.to}`);
  expect(edges).toContain(`${ids['PROJ-11']}>${ids['PROJ-12']}`);
  expect(edges).not.toContain(`${ids['PROJ-12']}>${ids['PROJ-11']}`);
  await expect(page.getByTestId('plan-jira-activity').locator('li').first()).toContainText('Re-read dependencies from PROJ-10: 1 removed, 1 added');
  // A second read finds nothing to change.
  await page.getByTestId('plan-jira-reread').click();
  await expect(dialog).toContainText('nothing to change');
  await expect(dialog.getByTestId('plan-jira-relink-apply')).toHaveCount(0);
  await dialog.getByTestId('plan-jira-relink-cancel').click();
  await expect(dialog).toHaveCount(0);
});
