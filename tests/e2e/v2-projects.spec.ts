import { type Page, expect, test } from '@playwright/test';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · lane P · the v2 Projects pages on the real path (fake claude, temp git, fake gh, the
 * fake Jira; never the real Jira): the project views (Steps / Board / Graph / Timeline,
 * remembered), Start with the approval mode and a subfolder (D130), Hold a step, Combine and
 * Send back (D102), a stopped step red with its agent's last message (D120), Re-read
 * dependencies from Jira (D117's diff), Delete a project (D117), and the phone's list.
 */

let world: PlansWorld;
let source = '';
const LAST = 'Not finished, so the task stays open. Left: re-run one CI check.';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startPlansWorld({ ...V2_SERVER_ENV, SWITCHBOARD_PLAN_STOPPED_GRACE_MS: '1500' });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function draft(page: Page, title: string, steps: readonly string[], chain = true): Promise<string> {
  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: source, title, targetBranch: world.target, baseBranch: 'main', maxConcurrency: 1 });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const planId = created.body.id as string;
  for (const [index, step] of steps.entries()) {
    const added = await world.call(page, 'POST', `/api/plans/${planId}/items`, { key: `PROJ-${index + 1}`, todo: { title: step, estimateMinutes: 20 }, ...(chain && index > 0 ? { after: [`PROJ-${index}`] } : {}) });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
  }
  return planId;
}

const step = (page: Page, key: string) => page.locator(`[data-testid="v2-step"][data-key="${key}"]`);

test('the project list and the four views (remembered)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${world.baseUrl}/projects`);
  source = await world.sourceSession(page, 'v2-projects');
  const planId = await draft(page, 'Acme views', ['API', 'UI', 'Docs']);
  await page.goto(`${world.baseUrl}/projects`);
  const card = page.locator(`[data-testid="v2-project-card"][data-plan-id="${planId}"]`);
  await expect(card).toContainText('Acme views');
  await expect(card).toContainText('0 of 3');
  await expect(card).toContainText('Not chosen yet');
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${planId}$`));
  await expect(page.getByTestId('v2-project-count')).toHaveText('0 of 3 steps done');
  await expect(step(page, 'PROJ-1')).toHaveAttribute('data-kind', 'ready');
  await expect(step(page, 'PROJ-2')).toHaveAttribute('data-kind', 'waiting');
  await expect(step(page, 'PROJ-2').getByTestId('v2-step-detail')).toHaveText('Waiting on 1');

  const views = page.getByTestId('v2-project-views');
  await views.getByRole('button', { name: 'Board' }).click();
  await expect(page.getByTestId('v2-project-board')).toBeVisible();
  await expect(page.locator('[data-column="working"] [data-testid="v2-board-card"]')).toHaveCount(3);
  await views.getByRole('button', { name: 'Graph' }).click();
  await expect(page.getByTestId('v2-graph-node')).toHaveCount(3);
  await expect(page.getByTestId('v2-graph-edge')).toHaveCount(2);
  await expect(page.locator('[data-testid="v2-graph-edge"][data-from="PROJ-1"][data-to="PROJ-2"]')).toHaveCount(1);
  await views.getByRole('button', { name: 'Timeline' }).click();
  await expect(page.getByTestId('v2-timeline-row')).toHaveCount(3);
  await expect(page.getByTestId('v2-timeline-summary')).toContainText('Projected finish');
  // Remembered across a reload.
  await page.reload();
  await expect(page.getByTestId('v2-project-view')).toHaveAttribute('data-view', 'timeline');
  await expect(views.getByRole('button', { name: 'Timeline' })).toHaveAttribute('aria-pressed', 'true');
  await views.getByRole('button', { name: 'Steps' }).click();
  await expect(page.getByTestId('v2-steps')).toBeVisible();
});

test('Start with the approval mode and a subfolder for its steps (D130), then Hold a step', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/projects`);
  const planId = await draft(page, 'Acme start', ['Build it', 'Ship it']);
  await page.goto(`${world.baseUrl}/projects/${planId}`);
  await page.getByTestId('v2-project-start').click();
  const dialog = page.getByTestId('v2-start-dialog');
  // No mode is pre-selected: Start waits for one.
  await expect(dialog.getByTestId('v2-start-go')).toBeDisabled();
  await expect(dialog.getByTestId('v2-start-folder')).toHaveValue('Acme start');
  await dialog.locator('[data-testid="v2-mode-option"][data-mode="developer"]').click();
  await dialog.getByTestId('v2-start-folder').fill('Acme run folder');
  await dialog.getByTestId('v2-start-go').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('v2-project-mode')).toHaveValue('developer');
  await expect.poll(async () => (await world.plan(page, planId)).sidebarFolder?.name ?? null).toBe('Acme run folder');
  await expect(page.locator('.v2-p-tag-link')).toHaveText('Acme run folder');

  // Hold the waiting step from its ⋯ menu; the chip says so; Release hold puts it back.
  await step(page, 'PROJ-2').getByTestId('v2-step-menu').click();
  await page.getByRole('menuitem', { name: 'Hold this step' }).click();
  await expect(step(page, 'PROJ-2')).toHaveAttribute('data-hold', 'true');
  await expect(step(page, 'PROJ-2')).toContainText('On hold');
  await expect.poll(async () => (await world.plan(page, planId)).items.find((item) => item.key === 'PROJ-2')?.hold).toBe(true);
  await step(page, 'PROJ-2').getByTestId('v2-step-menu').click();
  await page.getByRole('menuitem', { name: 'Release hold' }).click();
  await expect.poll(async () => (await world.plan(page, planId)).items.find((item) => item.key === 'PROJ-2')?.hold).toBe(false);
  // A disabled action says why.
  await step(page, 'PROJ-2').getByTestId('v2-step-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Reopen' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('v2-step-menu-menu')).toContainText('Only done steps can be reopened.');
  await page.keyboard.press('Escape');

  // Pause / Resume (Hold project).
  await page.getByTestId('v2-project-hold').click();
  await expect(page.getByTestId('v2-project-held')).toBeVisible();
  await page.getByTestId('v2-project-hold').click();
  await expect(page.getByTestId('v2-project-held')).toHaveCount(0);
});

test('Combine and Send back a step ready for approval', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto(`${world.baseUrl}/projects`);
  const planId = await draft(page, 'Acme approve', ['Card'], false);
  expect((await world.call(page, 'POST', `/api/plans/${planId}/start`, { mergeMode: 'developer' })).status).toBe(200);
  await page.goto(`${world.baseUrl}/projects/${planId}`);
  await world.agentWorks(page, planId, 'PROJ-1');
  await world.itemIn(page, planId, 'PROJ-1', 'ready-to-merge', 45_000);
  await expect(step(page, 'PROJ-1')).toHaveAttribute('data-kind', 'approval');
  await expect(step(page, 'PROJ-1').getByTestId('v2-status')).toHaveText('Ready for approval');

  // Send back with a note: the step works again.
  await step(page, 'PROJ-1').getByTestId('v2-step-sendback').click();
  const sendBack = page.getByTestId('v2-sendback-dialog');
  await expect(sendBack.getByTestId('v2-sendback-go')).toBeDisabled();
  await sendBack.getByTestId('v2-sendback-text').fill('Please also cover the empty card.');
  await sendBack.getByTestId('v2-sendback-go').click();
  await expect(sendBack).toHaveCount(0);
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'sent back with your note' })).toBeVisible();
  const item = await world.itemIn(page, planId, 'PROJ-1', 'running', 30_000);

  // Its agent finishes again (its branch already has its commit): ready again → Combine.
  const runId = item.runSessionId as string;
  await expect.poll(async () => (await world.call(page, 'GET', `/api/sessions/${runId}`)).body.status, { timeout: 30_000 }).not.toBe('run');
  expect((await world.call(page, 'PUT', `/api/sessions/${source}/todos/${item.todoId}`, { state: 'done' })).status).toBeLessThan(300);
  expect((await world.call(page, 'POST', `/api/sessions/${runId}/messages`, { text: 'Finished again.' })).status).toBeLessThan(300);
  await world.itemIn(page, planId, 'PROJ-1', 'ready-to-merge', 45_000);
  await expect(step(page, 'PROJ-1').getByTestId('v2-step-combine')).toBeVisible();
  await step(page, 'PROJ-1').getByTestId('v2-step-combine').click();
  await world.itemIn(page, planId, 'PROJ-1', 'done', 30_000);
  await expect(step(page, 'PROJ-1')).toHaveAttribute('data-kind', 'done');
  await expect(page.getByTestId('v2-project-count')).toHaveText('1 of 1 steps done');
});

test('a stopped step shows red with its agent’s last message, and a click opens its agent', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/projects`);
  const todo = await world.addTodo(page, source, `Fix check [fake:say ${JSON.stringify(LAST)}]`, 30);
  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: source, title: 'Acme stopped', targetBranch: world.target, baseBranch: 'main', maxConcurrency: 1 });
  const planId = created.body.id as string;
  expect((await world.call(page, 'POST', `/api/plans/${planId}/items`, { todoId: todo, key: 'PROJ-7' })).status).toBe(201);
  expect((await world.call(page, 'POST', `/api/plans/${planId}/start`, { mergeMode: 'agents' })).status).toBe(200);
  const item = await world.itemIn(page, planId, 'PROJ-7', 'stopped', 60_000);
  await page.goto(`${world.baseUrl}/projects/${planId}`);
  const row = step(page, 'PROJ-7');
  await expect(row).toHaveAttribute('data-kind', 'stopped');
  await expect(row).toHaveAttribute('data-tone', 'red');
  await expect(row.getByTestId('v2-step-detail')).toHaveText(`Stopped — needs you. ${LAST}`);
  await expect(row.getByTestId('v2-status')).toHaveText('Stopped — needs you');
  // The card on the list counts it.
  await page.goto(`${world.baseUrl}/projects`);
  await expect(page.locator(`[data-testid="v2-project-card"][data-plan-id="${planId}"]`)).toContainText('1 stopped');
  await page.goto(`${world.baseUrl}/projects/${planId}`);
  // Details show the message; a click on the step opens its agent.
  await row.getByTestId('v2-step-details').click();
  await expect(page.getByTestId('v2-step-sheet-detail')).toHaveText(`Stopped: ${LAST}`);
  await page.keyboard.press('Escape');
  await row.getByTestId('v2-step-open').click();
  await expect(page).toHaveURL(new RegExp(`/agents/${item.runSessionId as string}$`));
});

test('Re-read dependencies from Jira shows the change, then applies it', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${world.baseUrl}/projects`);
  const imported = await world.call(page, 'POST', `/api/sessions/${source}/plans/jira/import`, { epic: 'PROJ-10', targetBranch: 'feature/PROJ-10-acme-checkout' });
  expect(imported.status, JSON.stringify(imported.body)).toBe(201);
  const planId = imported.body.plan.id as string;
  const ids: Record<string, string> = Object.fromEntries((imported.body.plan.items as Array<{ key: string; id: string }>).map((entry) => [entry.key, entry.id]));
  // An import made before D117: PROJ-11 → PROJ-12 the wrong way round.
  expect((await world.call(page, 'DELETE', `/api/plans/${planId}/edges/${ids['PROJ-11']}/${ids['PROJ-12']}`)).status).toBe(200);
  expect((await world.call(page, 'POST', `/api/plans/${planId}/edges`, { from: ids['PROJ-12'], to: ids['PROJ-11'] })).status).toBe(200);

  await page.goto(`${world.baseUrl}/projects/${planId}`);
  await expect(page.locator('.v2-p-project-title')).toContainText('PROJ-10');
  await page.getByTestId('v2-project-menu').click();
  await page.getByRole('menuitem', { name: 'Re-read dependencies from Jira…' }).click();
  const dialog = page.getByTestId('v2-reread-dialog');
  await expect(dialog.getByTestId('v2-reread-removed').locator('li')).toHaveText(['− PROJ-11 waits on PROJ-12']);
  await expect(dialog.getByTestId('v2-reread-added').locator('li')).toHaveText(['+ PROJ-12 waits on PROJ-11']);
  await dialog.getByTestId('v2-reread-apply').click();
  await expect(dialog).toHaveCount(0);
  const edges = (await world.plan(page, planId)).edges.map((edge) => `${edge.from}>${edge.to}`);
  expect(edges).toContain(`${ids['PROJ-11']}>${ids['PROJ-12']}`);
  expect(edges).not.toContain(`${ids['PROJ-12']}>${ids['PROJ-11']}`);
  // A second read finds nothing to change.
  await page.getByTestId('v2-project-menu').click();
  await page.getByRole('menuitem', { name: 'Re-read dependencies from Jira…' }).click();
  await expect(dialog.getByTestId('v2-reread-none')).toBeVisible();
  await expect(dialog.getByTestId('v2-reread-apply')).toHaveCount(0);
  await dialog.getByTestId('v2-reread-cancel').click();
  // From Jira: the activity says what happened.
  await page.getByTestId('v2-from-jira').locator('summary').click();
  await expect(page.getByTestId('v2-jira-activity').locator('li').first()).toContainText('Re-read dependencies from PROJ-10');
});

test('delete a project (a running one is cancelled and its running steps stop)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${world.baseUrl}/projects`);
  const planId = await draft(page, 'Acme delete', ['Slow step [fake:hold 60]'], false);
  expect((await world.call(page, 'POST', `/api/plans/${planId}/start`, { mergeMode: 'developer' })).status).toBe(200);
  await world.itemIn(page, planId, 'PROJ-1', 'running');
  await page.goto(`${world.baseUrl}/projects/${planId}`);
  await page.getByTestId('v2-project-menu').click();
  await page.getByRole('menuitem', { name: 'Delete project…' }).click();
  const confirm = page.getByTestId('v2-delete-project');
  await expect(confirm.getByTestId('v2-delete-project-note')).toContainText('it is cancelled first and its 1 running step stop');
  await confirm.getByTestId('v2-delete-project-go').click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.locator(`[data-testid="v2-project-card"][data-plan-id="${planId}"]`)).toHaveCount(0);
  expect((await world.call(page, 'GET', `/api/plans/${planId}`)).status).toBe(404);
});

test('phone: the list, then a project as its steps list', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/projects`);
  const card = page.getByTestId('v2-project-card').filter({ hasText: 'Acme views' });
  await card.click();
  await expect(page.getByTestId('v2-steps')).toBeVisible();
  await expect(page.getByTestId('v2-project-views')).toHaveCount(0);
  await expect(step(page, 'PROJ-1')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const box = await step(page, 'PROJ-1').getByTestId('v2-step-menu').boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
});
