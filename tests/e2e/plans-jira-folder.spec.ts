import { type Page, expect, test } from '@playwright/test';
import { openWithHub } from './question-world.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';

/**
 * D112 · Import from Jira without a session (real path: fake claude, temp git repos, the fake
 * Jira; never the real Jira). Plans → Import from Jira… asks for the epic and **Where it runs**;
 * Create plan starts a session "Plan · <plan title>" in the chosen folder that owns the plan (its
 * todos, its repos, the ask for the missing order). Cancel and every failure leave no session;
 * **Use an existing session instead** goes back to the session picker.
 */
let world: PlansWorld;
let repoFolder = '';
let workspaceFolder = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startPlansWorld();
});

test.afterAll(async () => {
  await world?.stop();
});

async function sessionNames(page: Page): Promise<string[]> {
  const answer = await world.call(page, 'GET', '/api/sessions?closed=include');
  return (answer.body as Array<{ name: string }>).map((session) => session.name).sort();
}

async function openImport(page: Page) {
  await page.goto(`${world.baseUrl}/plans`);
  await page.getByTestId('plans-import-jira').click();
  const dialog = page.getByTestId('jira-import');
  await expect(dialog.getByTestId('jira-where')).toBeVisible();
  return dialog;
}

test('a workspace folder: no repositories to pick, a new "Plan · …" session owns the draft and its agent picks them (D115)', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await world.setPlans(page, true);
  const folders = (await world.call(page, 'GET', '/api/folders')).body as Array<{ id: string; kind: string }>;
  workspaceFolder = folders.find((folder) => folder.kind === 'workspace')?.id as string;
  const added = await world.call(page, 'POST', '/api/folders', { path: world.git.mobile });
  expect(added.status).toBeLessThan(300);
  repoFolder = added.body.id as string;
  const before = await sessionNames(page);

  const dialog = await openImport(page);
  await dialog.getByTestId('jira-where-folder').selectOption(workspaceFolder);
  await expect(dialog.getByTestId('jira-where-cli')).toBeVisible();
  await expect(dialog.getByTestId('jira-where-model-button')).toBeVisible();
  await dialog.getByTestId('jira-epic').fill('PROJ-10');
  await dialog.getByTestId('jira-preview').click();
  await expect(dialog.getByTestId('jira-items').locator('li')).toHaveCount(5);
  // Nothing exists yet: the preview starts no session.
  expect(await sessionNames(page)).toEqual(before);
  // D115: nothing to pick: the plan's agent picks each item's repositories; the override is optional and collapsed.
  await expect(dialog.getByTestId('jira-repos-agent-note')).toContainText("The plan's agent picks each item's repositories");
  await expect(dialog.getByTestId('jira-repos-toggle')).toHaveText('Limit to repositories… (optional)');
  await expect(dialog.getByTestId('jira-repos').getByTestId('jira-repo-mobile')).toBeHidden();
  await expect(dialog.getByTestId('jira-create-blocked')).toHaveCount(0);
  await dialog.getByTestId('jira-base').fill('main');
  await dialog.getByTestId('jira-create').click();

  await expect(page.getByTestId('plan-title')).toHaveText('PROJ-10 Acme checkout');
  const planId = (await page.getByTestId('plan-page').getAttribute('data-plan-id')) as string;
  const plan = await world.plan(page, planId);
  expect(plan).toMatchObject({ state: 'draft', repos: [], reposPerItem: true, baseBranch: 'main', external: { system: 'jira', key: 'PROJ-10' } });
  const owner = (await world.call(page, 'GET', `/api/sessions/${plan.sourceSessionId}`)).body;
  expect(owner).toMatchObject({ title: 'Plan · PROJ-10 Acme checkout', folder: workspaceFolder, solutions: [] });
  // The items wait for the plan's agent to pick their repositories (the line above the plan, with Ask again; a card's status).
  await expect(page.getByTestId('plan-repos-waiting')).toContainText("5 items: Waiting for the plan's agent to pick repositories.");
  await expect(page.getByTestId('plan-repos-ask')).toBeVisible();
  const byKey = new Map(plan.items.map((item) => [item.key, item.id]));
  await expect(page.locator(`[data-testid="plan-card"][data-item-id="${byKey.get('PROJ-11')}"]`).getByTestId('plan-card-status')).toHaveText('waiting for repositories');
  // PROJ-15 has no links: one message asks the new session's agent for the order and the repositories.
  await expect
    .poll(async () => {
      const events = JSON.stringify((await world.call(page, 'GET', `/api/sessions/${plan.sourceSessionId}/events`)).body);
      return events.includes('Please propose the missing order') && events.includes('Also pick the repositories') && events.includes('plan_set_solutions');
    }, { timeout: 20_000 })
    .toBe(true);
  // Its todos are the epic's tickets.
  expect(((await world.call(page, 'GET', `/api/sessions/${plan.sourceSessionId}/todos`)).body.todos as unknown[]).length).toBe(5);

  // The agent answers with plan_set_solutions (its route, with its own token): applied at once.
  const set = await world.asAgent(plan.sourceSessionId, `/agent/v1/plans/${planId}/solutions`, {
    items: ['PROJ-11', 'PROJ-12', 'PROJ-13', 'PROJ-14', 'PROJ-15'].map((key) => ({ item: key, solutions: key === 'PROJ-11' ? ['web-front'] : ['mobile'] })),
  });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  await expect(page.getByTestId('plan-repos-waiting')).toHaveCount(0);
  const picked = await world.plan(page, planId);
  expect(picked.repos).toEqual(['web-front', 'mobile']);
  expect(picked.items.find((item) => item.key === 'PROJ-11')?.solutions).toEqual(['web-front']);
  // The items show their repositories (the List's repo line; the detail of PROJ-11).
  await page.getByTestId('plan-tab-list').click();
  await expect(page.locator(`[data-testid="plan-row"][data-item-id="${byKey.get('PROJ-11')}"]`)).toContainText('web-front');
  await expect(page.locator(`[data-testid="plan-row"][data-item-id="${byKey.get('PROJ-15')}"]`)).toContainText('mobile');

  // The next import in this browser starts on this one's place: the workspace and the base branch (repositories are never pre-picked).
  const next = await openImport(page);
  await expect(next.getByTestId('jira-where-folder')).toHaveValue(workspaceFolder);
  await next.getByTestId('jira-epic').fill('PROJ-10');
  await next.getByTestId('jira-preview').click();
  await next.getByTestId('jira-repos-toggle').click();
  await expect(next.getByTestId('jira-repos').getByTestId('jira-repo-mobile')).not.toBeChecked();
  await expect(next.getByTestId('jira-base')).toHaveValue('main');
  await next.getByRole('button', { name: 'Cancel' }).click();
});

test('a plain git repo folder: the session runs in the repo, no repositories to pick', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/inbox`);
  const dialog = await openImport(page);
  await dialog.getByTestId('jira-where-folder').selectOption(repoFolder);
  await expect(dialog.getByTestId('jira-where-check')).toContainText('git repo');
  await dialog.getByTestId('jira-epic').fill('PROJ-10');
  await dialog.getByTestId('jira-preview').click();
  await expect(dialog.getByTestId('jira-items').locator('li')).toHaveCount(5);
  await dialog.getByTestId('jira-base').fill('main');
  // A repo folder is its own repository: nothing to pick.
  await expect(dialog.getByTestId('jira-repos')).toHaveCount(0);
  await dialog.getByTestId('jira-target').fill('feature/PROJ-10-acme-repo');
  // The session's title follows the plan title as edited in the dialog.
  await dialog.getByTestId('jira-title').fill('PROJ-10 Acme repo checkout');
  await dialog.getByTestId('jira-create').click();
  await expect(page.getByTestId('plan-title')).toHaveText('PROJ-10 Acme repo checkout');
  const planId = (await page.getByTestId('plan-page').getAttribute('data-plan-id')) as string;
  const plan = await world.plan(page, planId);
  expect(plan.repos).toEqual(['mobile']);
  const owner = (await world.call(page, 'GET', `/api/sessions/${plan.sourceSessionId}`)).body;
  expect(owner).toMatchObject({ name: 'plan-proj-10-2', title: 'Plan · PROJ-10 Acme repo checkout', folder: repoFolder, folderKind: 'repo' });
});

test('Cancel, a missing epic and a refused Create plan leave no session behind', async ({ page }) => {
  test.setTimeout(60_000);
  await openWithHub(page, `${world.baseUrl}/inbox`);
  const before = await sessionNames(page);

  let dialog = await openImport(page);
  await dialog.getByTestId('jira-epic').fill('PROJ-10');
  await dialog.getByTestId('jira-preview').click();
  await expect(dialog.getByTestId('jira-items').locator('li')).toHaveCount(5);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('jira-import')).toHaveCount(0);

  dialog = await openImport(page);
  await dialog.getByTestId('jira-epic').fill('PROJ-404');
  await dialog.getByTestId('jira-preview').click();
  await expect(dialog.getByTestId('jira-error')).toBeVisible();

  await dialog.getByTestId('jira-epic').fill('PROJ-10');
  await dialog.getByTestId('jira-preview').click();
  await expect(dialog.getByTestId('jira-items').locator('li')).toHaveCount(5);
  await dialog.getByTestId('jira-where-folder').selectOption(repoFolder);
  await dialog.getByTestId('jira-target').fill('not a branch');
  await dialog.getByTestId('jira-create').click();
  // The session was started for it, then closed and deleted again; the reason shows by the button.
  await expect(dialog.getByTestId('jira-create-error')).toBeVisible();
  await expect(dialog.getByTestId('jira-target-error')).toBeVisible();
  expect(await sessionNames(page)).toEqual(before);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await sessionNames(page)).toEqual(before);
});

test('"Use an existing session instead" goes to the session picker, and back', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/inbox`);
  const dialog = await openImport(page);
  await dialog.getByTestId('jira-use-session').click();
  const picker = page.getByTestId('plan-jira-source-dialog');
  await expect(picker).toBeVisible();
  await expect(page.getByTestId('jira-import')).toHaveCount(0);
  await picker.getByTestId('plan-jira-source-folder').click();
  await expect(page.getByTestId('jira-import').getByTestId('jira-where')).toBeVisible();
});

test('360 px: Where it runs fits the phone width', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openWithHub(page, `${world.baseUrl}/inbox`);
  const dialog = await openImport(page);
  const where = dialog.getByTestId('jira-where');
  const box = await where.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});
