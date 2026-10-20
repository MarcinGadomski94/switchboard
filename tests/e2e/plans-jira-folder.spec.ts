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

test('a workspace folder: the picked repos, a new "Plan · …" session owns the draft and is asked for the order', async ({ page }) => {
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
  await expect(dialog.getByTestId('jira-create-blocked')).toHaveText('Pick the repositories the target branch lives in.');
  await dialog.getByTestId('jira-repos').getByTestId('jira-repo-mobile').check();
  await dialog.getByTestId('jira-base').fill('main');
  await dialog.getByTestId('jira-create').click();

  await expect(page.getByTestId('plan-title')).toHaveText('PROJ-10 Acme checkout');
  const planId = (await page.getByTestId('plan-page').getAttribute('data-plan-id')) as string;
  const plan = await world.plan(page, planId);
  expect(plan).toMatchObject({ state: 'draft', repos: ['mobile'], baseBranch: 'main', external: { system: 'jira', key: 'PROJ-10' } });
  const owner = (await world.call(page, 'GET', `/api/sessions/${plan.sourceSessionId}`)).body;
  expect(owner).toMatchObject({ title: 'Plan · PROJ-10 Acme checkout', folder: workspaceFolder, solutions: ['mobile'] });
  // PROJ-15 has no links: the new session's agent is asked to propose the order.
  await expect
    .poll(async () => JSON.stringify((await world.call(page, 'GET', `/api/sessions/${plan.sourceSessionId}/events`)).body).includes('Please propose the missing order'), { timeout: 20_000 })
    .toBe(true);
  // Its todos are the epic's tickets.
  expect(((await world.call(page, 'GET', `/api/sessions/${plan.sourceSessionId}/todos`)).body.todos as unknown[]).length).toBe(5);

  // The next import in this browser starts on this one's place: the workspace, its repo and the base branch.
  const next = await openImport(page);
  await expect(next.getByTestId('jira-where-folder')).toHaveValue(workspaceFolder);
  await next.getByTestId('jira-epic').fill('PROJ-10');
  await next.getByTestId('jira-preview').click();
  await expect(next.getByTestId('jira-repos').getByTestId('jira-repo-mobile')).toBeChecked();
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
