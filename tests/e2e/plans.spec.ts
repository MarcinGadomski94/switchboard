import { expect, test } from '@playwright/test';
import { openWithHub } from './question-world.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';

/**
 * D99 · the Plans page on the real path (`docs/plans.md` → *The Plans page*): fake-claude
 * runs, temp git, fake gh. One plan goes through the whole design: made from todos with
 * ＋ New plan, a dependency added and a loop refused, Start refused until a merge mode is
 * chosen, an item's question answered in the detail, an item running → in review → merged
 * from the detail → its dependent starting, Pause / Resume, the Timeline, and the phone's
 * List with the full-screen detail. With Plans off nothing of it shows.
 */

let world: PlansWorld;
let planId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startPlansWorld();
});

test.afterAll(async () => {
  await world?.stop();
});

test('off by default: no nav entry, /plans points to the switch', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await expect(page.getByTestId('nav-todos')).toBeVisible();
  await expect(page.getByTestId('nav-plans')).toHaveCount(0);
  await page.goto(`${world.baseUrl}/plans`);
  await expect(page.getByTestId('plans-off')).toContainText('Plans is off');
});

test('create a plan from todos, add a dependency (a loop refused), Start needs a merge mode', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await world.setPlans(page, true);
  const source = await world.sourceSession(page, 'epic-source');
  await world.addTodo(page, source, 'Add the contract', 45);
  await world.addTodo(page, source, 'Build the screen', 60);
  await world.addTodo(page, source, 'Ask about the button [fake:ask-2q]', 30);

  await page.goto(`${world.baseUrl}/inbox`);
  await expect(page.getByTestId('nav-plans')).toBeVisible();
  await page.getByTestId('nav-plans').click();
  await expect(page.getByTestId('plans-empty')).toBeVisible();

  // The Jira seam: nothing registered yet.
  await page.getByTestId('plans-import-jira').click();
  await expect(page.getByTestId('plans-note')).toHaveText(/Import from Jira is coming soon\./);

  await page.getByTestId('plans-new').click();
  const dialog = page.getByTestId('plan-new-dialog');
  await dialog.getByTestId('plan-new-session').selectOption(source);
  await dialog.getByTestId('plan-new-title').fill('PROJ-100 Acme checkout');
  await dialog.getByTestId('plan-new-target').fill(world.target);
  await dialog.getByTestId('plan-new-base').fill('main');
  await expect(dialog.getByTestId('plan-todo')).toHaveCount(3);
  for (const box of await dialog.getByTestId('plan-todo').all()) await box.check();
  await dialog.getByTestId('plan-new-create').click();
  await expect(page.getByTestId('plan-page')).toBeVisible();
  planId = (await page.getByTestId('plan-page').getAttribute('data-plan-id')) as string;
  await expect(page).toHaveURL(new RegExp(`/plans/${planId}$`));
  await expect(page.getByTestId('plan-card')).toHaveCount(3);
  await expect(page.getByTestId('plan-mode-chip')).toHaveText('Merge mode: not chosen yet');
  await expect(page.getByTestId('plan-target')).toHaveText(`⎇ ${world.target} → main`);
  await expect(page.getByTestId('plan-progress')).toContainText('0/3 done');

  // Ticket keys (the Jira lane fills them; here through the API), shown live (planChanged).
  const plan = await world.plan(page, planId);
  const keys = ['PROJ-1', 'PROJ-2', 'PROJ-3'];
  for (const [index, item] of plan.items.entries()) expect((await world.call(page, 'PUT', `/api/plans/${planId}/items/${item.id}`, { key: keys[index] })).status).toBe(200);
  const card = (key: string) => page.locator(`[data-testid="plan-card"][data-key="${key}"]`);
  await expect(card('PROJ-3')).toBeVisible();

  // Edit dependencies: 1 then 2 = "2 after 1".
  await page.getByTestId('plan-edit').click();
  await expect(page.getByTestId('plan-edit-hint')).toContainText('Click the ticket that must finish first.');
  await card('PROJ-1').click();
  await expect(page.getByTestId('plan-edit-hint')).toContainText('Now click the ticket that depends on 1…');
  await card('PROJ-2').click();
  await expect(page.getByTestId('plan-edge')).toHaveCount(1);
  await expect(card('PROJ-2').getByTestId('plan-card-status')).toHaveText('waiting on 1');
  // The reverse would be a loop: refused with a toast, nothing sent.
  await card('PROJ-2').click();
  await card('PROJ-1').click();
  await expect(page.getByTestId('toast')).toContainText('Refused: 2 already waits on 1 — that would be a loop');
  await page.getByTestId('toast').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('plan-edge')).toHaveCount(1);
  // An existing pair is removed with a click, then made again.
  await page.getByTestId('plan-edge-hit').click({ force: true });
  await expect(page.getByTestId('plan-edge')).toHaveCount(0);
  await card('PROJ-1').click();
  await card('PROJ-2').click();
  await expect(page.getByTestId('plan-edge')).toHaveCount(1);
  await page.getByTestId('plan-edit').click();
  await expect(page.getByTestId('plan-edit-hint')).toHaveCount(0);

  // Start needs a merge mode: no default, Start disabled until one is picked.
  await page.getByTestId('plan-start').click();
  const modes = page.getByTestId('plan-mode-dialog');
  await expect(modes).toContainText('How should finished tickets be merged into the epic branch?');
  await expect(modes).toContainText('You have to choose — there is no default.');
  await expect(modes.getByTestId('plan-mode-option')).toHaveCount(3);
  for (const option of await modes.getByTestId('plan-mode-option').all()) await expect(option).not.toBeChecked();
  await expect(modes.getByTestId('plan-mode-note')).toHaveText(`Always on: agents merge only into ${world.target} — never dev or master · checks must be green · a second conflict comes to your Inbox.`);
  await expect(modes.getByTestId('plan-mode-confirm')).toBeDisabled();
  await modes.locator('[data-mode="agents-with-holds"]').check();
  await expect(modes.getByTestId('plan-mode-hold')).toHaveCount(3);
  await modes.locator('[data-mode="developer"]').check();
  await expect(modes.getByTestId('plan-mode-confirm')).toBeEnabled();
  await modes.getByTestId('plan-mode-confirm').click();
  await expect(modes).toHaveCount(0);
  await expect(page.getByTestId('plan-state')).toHaveText('running');
  await expect(page.getByTestId('plan-mode-chip')).toHaveText('Merge: I merge each one');
  await expect(page.getByTestId('nav-plans-count')).toHaveText('1');
});

test('answer a question in the detail; running → review → merged → its dependent starts', async ({ page }) => {
  test.setTimeout(120_000);
  await openWithHub(page, `${world.baseUrl}/plans/${planId}`);
  const card = (key: string) => page.locator(`[data-testid="plan-card"][data-key="${key}"]`);

  // PROJ-3 asks two questions: answered from the detail with the real question card.
  await world.itemIn(page, planId, 'PROJ-3', 'question');
  await expect(card('PROJ-3')).toHaveAttribute('data-state', 'question');
  await expect(card('PROJ-3').getByTestId('plan-card-status')).toHaveText('needs your answer');
  await card('PROJ-3').click();
  const detail = page.getByTestId('plan-detail');
  await expect(detail.getByTestId('question-card')).toBeVisible({ timeout: 15_000 });
  const questions = detail.getByTestId('question');
  await expect(questions).toHaveCount(2);
  await questions.nth(0).getByTestId('question-option').first().click();
  await questions.nth(1).getByTestId('question-option').first().click();
  await detail.getByTestId('question-send').click();
  await expect(card('PROJ-3')).not.toHaveAttribute('data-state', 'question', { timeout: 20_000 });

  // PROJ-1: its agent commits and ends its turn; in "I merge each one" it waits for my Merge.
  await world.agentWorks(page, planId, 'PROJ-1');
  await world.itemIn(page, planId, 'PROJ-1', 'review');
  await expect(card('PROJ-1')).toHaveAttribute('data-state', 'review');
  await expect(card('PROJ-2')).toHaveAttribute('data-state', 'waiting');
  await card('PROJ-1').click();
  await expect(detail.getByTestId('plan-detail-review')).toBeVisible();
  await expect(detail.getByTestId('plan-detail-merge')).toBeEnabled({ timeout: 15_000 });
  await expect(detail.getByTestId('plan-detail-diff')).toBeVisible();
  await detail.getByTestId('plan-detail-merge').click();
  await expect(card('PROJ-1')).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
  await expect(card('PROJ-1').getByTestId('plan-card-status')).toHaveText('done · merged');
  await expect(detail.getByTestId('plan-detail-done')).toHaveText(`Merged into ${world.target} · checks ✔`);
  // Its dependent starts by itself.
  await expect(card('PROJ-2')).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
  expect(await world.git.git(world.git.mobile, 'show', `${world.target}:PROJ-1.txt`)).toBe('PROJ-1');
  await expect(page.getByTestId('plan-progress')).toContainText('1/3 done');
});

test('pause and resume', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/plans/${planId}`);
  await page.getByTestId('plan-pause').click();
  await expect(page.getByTestId('plan-state')).toHaveText('paused');
  await expect(page.getByTestId('plan-resume')).toBeVisible();
  await expect(page.getByTestId('nav-plans-count')).toHaveText('');
  await page.getByTestId('plan-resume').click();
  await expect(page.getByTestId('plan-state')).toHaveText('running');
  await expect(page.getByTestId('plan-pause')).toBeVisible();
});

test('the timeline renders', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/plans/${planId}`);
  await page.getByTestId('plan-tab-timeline').click();
  const timeline = page.getByTestId('plan-timeline');
  await expect(timeline.getByTestId('plan-timeline-row')).toHaveCount(3);
  await expect(timeline.getByTestId('plan-timeline-group')).toHaveCount(1);
  await expect(page.getByTestId('plan-timeline-summary')).toHaveText(/^Waiting on you: [\d.]+ h of [\d.]+ · (longest: .* · )?Projected finish: /);
  const row = (key: string) => timeline.locator('[data-testid="plan-timeline-row"]').filter({ hasText: key });
  await expect(row('PROJ-1').locator('[data-kind="working"]')).toHaveCount(1);
  await expect(row('PROJ-2').locator('[data-kind="projected"]')).toHaveCount(1);
  await expect(page.getByTestId('plan-timeline-now')).toBeVisible();
  // A row selects its item.
  await row('PROJ-2').click();
  await expect(page.getByTestId('plan-detail')).toHaveAttribute('data-state', 'running');
});

test('phone: the List and a full-screen detail', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${world.baseUrl}/plans/${planId}`);
  await expect(page.getByTestId('plan-list')).toBeVisible();
  await expect(page.getByTestId('plan-tab-graph')).toHaveCount(0);
  await expect(page.getByTestId('plan-row')).toHaveCount(3);
  await expect(page.locator('[data-testid="plan-row"][data-state="done"]')).toContainText('done · merged');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.locator('[data-testid="plan-row"]').filter({ hasText: 'PROJ-2' }).locator('.sb-plan-row__main').click();
  await expect(page.getByTestId('plan-detail')).toBeVisible();
  await expect(page.getByTestId('plan-list')).toHaveCount(0);
  await page.getByTestId('plan-detail-back').click();
  await expect(page.getByTestId('plan-list')).toBeVisible();
});

test("the session's Plan tab links to its plan", async ({ page }) => {
  const plan = await (async () => {
    await openWithHub(page, `${world.baseUrl}/inbox`);
    return world.plan(page, planId);
  })();
  await page.goto(`${world.baseUrl}/sessions/${plan.sourceSessionId}`);
  const tab = page.getByTestId('session-plan-tab');
  await expect(tab).toBeVisible();
  await tab.getByTestId('session-plan-link').click();
  await expect(page).toHaveURL(new RegExp(`/plans/${planId}$`));
});

test('switched off while running: nothing of Plans shows; on again, the plan is paused with the reason', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/plans/${planId}`);
  await expect(page.getByTestId('plan-state')).toHaveText('running');
  await world.setPlans(page, false);
  await page.goto(`${world.baseUrl}/plans/${planId}`);
  await expect(page.getByTestId('plans-off')).toBeVisible();
  await expect(page.getByTestId('nav-plans')).toHaveCount(0);
  await world.setPlans(page, true);
  await page.goto(`${world.baseUrl}/plans/${planId}`);
  await expect(page.getByTestId('plan-state')).toHaveText('paused · Plans was switched off');
  await page.getByTestId('plan-resume').click();
  await expect(page.getByTestId('plan-state')).toHaveText('running');
});
