import { expect, test } from '@playwright/test';
import { openWithHub } from './question-world.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';

/**
 * D99 · the Plans page on the real path (`docs/plans-ui.md` → *The Plans page*): fake-claude
 * runs, temp git, fake gh. One plan goes through the whole design: made from todos with
 * ＋ New plan, a dependency added and a loop refused, Start refused until a merge mode is
 * chosen, an item's question answered in the detail, an item running → ready to merge → merged
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
  // D99 follow-up 2026-10-15: a fourth option, no merging.
  await expect(modes.getByTestId('plan-mode-option')).toHaveCount(4);
  for (const option of await modes.getByTestId('plan-mode-option').all()) await expect(option).not.toBeChecked();
  await expect(modes.getByTestId('plan-mode-note')).toHaveText(`Always on: agents merge only into ${world.target} · checks must be green · a second conflict comes to your Inbox.`);
  await expect(modes.getByTestId('plan-mode-ack')).toHaveCount(0);
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

test('answer a question in the detail; running → ready to merge → merged → its dependent starts', async ({ page }) => {
  test.setTimeout(120_000);
  await openWithHub(page, `${world.baseUrl}/plans/${planId}`);
  const card = (key: string) => page.locator(`[data-testid="plan-card"][data-key="${key}"]`);

  // PROJ-3 asks two questions: answered from the detail with the real question card.
  await world.itemIn(page, planId, 'PROJ-3', 'question');
  await expect(card('PROJ-3')).toHaveAttribute('data-state', 'question');
  await expect(card('PROJ-3').getByTestId('plan-card-status')).toHaveText('needs your answer');
  // D120: a card with a run session opens it; its ⓘ (the button right after it) shows the detail.
  const details = (key: string) => card(key).locator('xpath=following-sibling::*[1][@data-testid="plan-card-details"]');
  await details('PROJ-3').click();
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
  await world.itemIn(page, planId, 'PROJ-1', 'ready-to-merge');
  await expect(card('PROJ-1')).toHaveAttribute('data-state', 'ready-to-merge');
  await expect(card('PROJ-2')).toHaveAttribute('data-state', 'waiting');
  await details('PROJ-1').click();
  await expect(detail.getByTestId('plan-detail-merge-step')).toBeVisible();
  await expect(card('PROJ-1').getByTestId('plan-card-status')).toHaveText('waiting for your merge');
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
  // From the core's history: PROJ-1 worked, then waited on my Merge (a waiting-you span, though it is done now).
  await expect(row('PROJ-1').locator('[data-kind="working"]')).not.toHaveCount(0);
  await expect(row('PROJ-1').locator('[data-kind="you"]')).not.toHaveCount(0);
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
  // D120: a row with a run session opens it; Details shows the detail.
  await page.locator('[data-testid="plan-row"]').filter({ hasText: 'PROJ-2' }).getByTestId('plan-row-details').click();
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

test('import from Jira via the list: the draft opens, Propose order asks, a proposal ✓ adds an edge in the graph', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/plans`);
  const source = (await world.plan(page, planId)).sourceSessionId;
  await page.getByTestId('plans-import-jira').click();
  // D112: the import starts in a folder; an existing session on request.
  await page.getByTestId('jira-import').getByTestId('jira-use-session').click();
  const picker = page.getByTestId('plan-jira-source-dialog');
  await picker.getByTestId('plan-jira-source-session').selectOption(source);
  await picker.getByTestId('plan-jira-source-continue').click();
  const dialog = page.getByTestId('jira-import');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-tour="plans-jira-epic"]')).toBeVisible();
  await dialog.getByTestId('jira-epic').fill('PROJ-10');
  await dialog.getByTestId('jira-preview').click();
  await expect(dialog.getByTestId('jira-items').locator('li')).toHaveCount(5);
  await dialog.getByTestId('jira-target').fill('feature/PROJ-10-acme-checkout');
  await dialog.getByTestId('jira-create').click();

  // The draft opens: five tickets, its Jira section under the header.
  await expect(page.getByTestId('plan-title')).toHaveText('PROJ-10 Acme checkout');
  const jiraPlanId = (await page.getByTestId('plan-page').getAttribute('data-plan-id')) as string;
  await expect(page).toHaveURL(new RegExp(`/plans/${jiraPlanId}$`));
  await expect(page.getByTestId('plan-card')).toHaveCount(5);
  await expect(page.getByTestId('plan-external')).toHaveText('PROJ-10');
  await expect(page.getByTestId('plan-jira-section')).toBeVisible();
  await page.getByTestId('plan-jira-toggle').click();
  await expect(page.getByTestId('plan-jira-sync')).toHaveCount(0);
  await page.getByTestId('plan-jira-toggle').click();
  const edgesBefore = await page.getByTestId('plan-edge').count();

  // Propose order asks the source session.
  await page.getByTestId('plan-propose-order').click();
  await expect(page.getByTestId('toast')).toContainText('to propose the order — suggestions will appear above the graph');
  await page.getByTestId('toast').getByRole('button', { name: 'Close' }).click();

  // Its agent proposes; the proposal shows above the graph and ✓ adds the edge.
  const plan = await world.plan(page, jiraPlanId);
  const id = (key: string): string => plan.items.find((item) => item.key === key)?.id as string;
  const proposed = await world.asAgent(source, `/agent/v1/plans/${jiraPlanId}/proposals`, { proposals: [{ from: 'PROJ-14', to: 'PROJ-15', reason: 'the receipt needs the payment provider' }] });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const proposal = (proposed.body.added as Array<{ id: string }>)[0]?.id as string;
  const list = page.getByTestId('plan-proposals');
  await expect(list).toContainText('PROJ-15 should wait on PROJ-14');
  const listBox = await list.boundingBox();
  const graphBox = await page.getByTestId('plan-graph').boundingBox();
  expect((listBox?.y ?? 0) < (graphBox?.y ?? 0)).toBe(true);
  await page.getByTestId(`plan-proposal-accept-${proposal}`).click();
  await expect(list).toHaveCount(0);
  await expect(page.getByTestId('plan-edge')).toHaveCount(edgesBefore + 1);
  await expect(page.locator(`[data-testid="plan-edge"][data-from="${id('PROJ-14')}"][data-to="${id('PROJ-15')}"]`)).toHaveCount(1);
});

test("the session's Plan strip imports from Jira with that session", async ({ page }) => {
  const source = await (async () => {
    await openWithHub(page, `${world.baseUrl}/inbox`);
    return (await world.plan(page, planId)).sourceSessionId;
  })();
  await page.goto(`${world.baseUrl}/sessions/${source}`);
  await page.getByTestId('session-plan-import').click();
  await expect(page.getByTestId('jira-import')).toBeVisible();
  // D112: the strip's import stays with its session: no folder to pick.
  await expect(page.getByTestId('jira-where')).toHaveCount(0);
  await expect(page.getByTestId('jira-use-session')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('jira-import')).toHaveCount(0);
});

test("What's new: the Plans tour is listed while Plans is on, and replays", async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/settings/tutorial`);
  const row = page.locator('.sb-set-row[data-row="whats-new-plans"]');
  await expect(row).toContainText('Plans (experimental)');
  await expect(row).toContainText('1.17.0');
  // D99 follow-up 2026-10-15: its own tour, also only while Plans is on.
  await expect(page.locator('.sb-set-row[data-row="whats-new-plans-any"]')).toContainText('Plans for anything');
  await expect(page.locator('.sb-set-row[data-row="whats-new-plans-any"]')).toContainText('1.22.0');
  await page.getByTestId('whats-new-replay-plans').click();
  await expect(page.getByTestId('tour-card').getByTestId('tour-kicker')).toHaveText("What's new · Plans (experimental)");
  await page.getByTestId('tour-next').click();
  await expect(page).toHaveURL(/\/plans$/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tour')).toHaveCount(0);
});

test('D99 follow-up 2026-10-15: a plan without a target branch (New plan, Start offers only "No merging"); agents into dev need the ticked warning', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/plans`);
  const source = await world.sourceSession(page, 'anything-source');
  await world.addTodo(page, source, 'Read the vendor docs', 20);
  await page.goto(`${world.baseUrl}/plans`);
  await page.getByTestId('plans-new').click();
  const dialog = page.getByTestId('plan-new-dialog');
  await dialog.getByTestId('plan-new-session').selectOption(source);
  await dialog.getByTestId('plan-new-title').fill('Vendor research');
  await expect(dialog.getByTestId('plan-new-no-target')).toHaveText('No target — items finish when marked done');
  await dialog.getByTestId('plan-todo').first().check();
  await expect(dialog.getByTestId('plan-new-create')).toBeEnabled();
  await dialog.getByTestId('plan-new-create').click();
  await expect(page.getByTestId('plan-page')).toBeVisible();
  const freeId = (await page.getByTestId('plan-page').getAttribute('data-plan-id')) as string;
  await expect(page.getByTestId('plan-target')).toHaveText('No merge step');
  await expect(page.getByTestId('plan-mode-chip')).toHaveText('No merge step');
  await page.getByTestId('plan-start').click();
  const modes = page.getByTestId('plan-mode-dialog');
  await expect(modes).toContainText('This plan has no target branch: nothing is merged.');
  await expect(modes.getByTestId('plan-mode-option')).toHaveCount(1);
  await expect(modes.locator('[data-mode="none"]')).toBeChecked();
  await expect(modes).toContainText('No merging');
  await modes.getByTestId('plan-mode-confirm').click();
  await expect(modes).toHaveCount(0);
  await expect(page.getByTestId('plan-state')).toHaveText('running');
  expect((await world.plan(page, freeId)).mergeMode).toBe('none');
  expect((await world.call(page, 'POST', `/api/plans/${freeId}/cancel`)).status).toBe(200);

  // dev as the target: "Agents merge" shows the warning, which must be ticked.
  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: source, title: 'Hotfix into dev', targetBranch: 'dev', baseBranch: 'main' });
  expect(created.status).toBe(201);
  const devId = created.body.id as string;
  await world.addTodo(page, source, 'Fix the footer', 20);
  const todos = (await world.call(page, 'GET', `/api/sessions/${source}/todos`)).body.todos as Array<{ id: string; title: string }>;
  const footer = todos.find((todo) => todo.title === 'Fix the footer')?.id as string;
  expect((await world.call(page, 'POST', `/api/plans/${devId}/items`, { todoId: footer })).status).toBe(201);
  await page.goto(`${world.baseUrl}/plans/${devId}`);
  await expect(page.getByTestId('plan-target')).toHaveText('⎇ dev → main');
  await page.getByTestId('plan-start').click();
  await expect(modes.getByTestId('plan-mode-option')).toHaveCount(4);
  await modes.locator('[data-mode="developer"]').check();
  await expect(modes.getByTestId('plan-mode-ack')).toHaveCount(0);
  await modes.locator('[data-mode="agents"]').check();
  await expect(modes.getByTestId('plan-mode-ack')).toHaveText('⚠ Agents will merge straight into dev');
  await expect(modes.getByTestId('plan-mode-confirm')).toBeDisabled();
  await modes.getByTestId('plan-mode-ack-check').check();
  await expect(modes.getByTestId('plan-mode-confirm')).toBeEnabled();
  await modes.getByTestId('plan-mode-confirm').click();
  await expect(modes).toHaveCount(0);
  await expect(page.getByTestId('plan-state')).toHaveText('running');
  await expect(page.getByTestId('plan-target')).toHaveText('⎇ dev (agents merge — acknowledged)');
  expect((await world.plan(page, devId)).allowProtectedTarget).toBe(true);
  expect((await world.call(page, 'POST', `/api/plans/${devId}/cancel`)).status).toBe(200);
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
