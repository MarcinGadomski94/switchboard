import { expect, test } from '@playwright/test';
import { openWithHub } from './question-world.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';

/**
 * D115 follow-ups 2026-10-20 (real path: fake claude, temp git repos, no Jira): a New plan in a
 * workspace session without solutions asks its agent by itself (one message for the items added
 * in a row); when the agent does not pick the repositories in time, the Inbox shows a Needs-you
 * item ("Pick repositories") naming the plan and how many items wait, with **Ask again** (which
 * asks again and re-arms the check) and **Open plan**; it goes once every item has repositories.
 * The server's wait is shortened (`SWITCHBOARD_PLAN_PICK_REPOS_MS`), never 15 minutes.
 */
let world: PlansWorld;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startPlansWorld({ SWITCHBOARD_PLAN_PICK_REPOS_MS: '2500' });
});

test.afterAll(async () => {
  await world?.stop();
});

test('a waiting plan raises "Pick repositories" in the Inbox; Ask again asks again; it goes once the items have repositories', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await world.setPlans(page, true);
  const folders = (await world.call(page, 'GET', '/api/folders')).body as Array<{ id: string; kind: string }>;
  const workspace = folders.find((folder) => folder.kind === 'workspace')?.id as string;
  const started = await world.call(page, 'POST', '/api/sessions', { simple: true, name: 'acme-source', title: 'Acme source', task: 'Hello', folder: workspace, worktrees: false });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const sourceId = started.body.id as string;
  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: sourceId, title: 'Acme checkout', targetBranch: 'feature/PROJ-10-acme-checkout', baseBranch: 'main' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const planId = created.body.id as string;
  expect(created.body.reposPerItem).toBe(true);
  const itemIds: string[] = [];
  for (const title of ['Cart API', 'Checkout page']) {
    const added = await world.call(page, 'POST', `/api/plans/${planId}/items`, { todo: { title } });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    itemIds.push(added.body.itemId as string);
  }

  // Not picked in time: the Needs-you item arrives live.
  const card = page.getByTestId('inbox-item').filter({ hasText: 'Pick repositories' });
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await expect(card).toContainText('2 items of "Acme checkout" wait for repositories');
  await card.click();
  const detail = page.getByTestId('inbox-detail');
  await expect(detail.getByTestId('inbox-title')).toHaveText('2 items of "Acme checkout" wait for repositories');
  await expect(detail.getByTestId('inbox-text')).toContainText('"Cart API", "Checkout page"');
  const actions = detail.getByTestId('inbox-action');
  await expect(actions).toHaveText(['Ask again', 'Open plan', 'Dismiss']);

  // Ask again: the item closes; the check is armed again, so (still nothing picked) a new one arrives.
  await actions.filter({ hasText: 'Ask again' }).click();
  await expect(card).toHaveCount(0);
  await expect(card).toHaveCount(1, { timeout: 30_000 });

  // Open plan goes to the plan (the item stays).
  await card.click();
  await detail.getByTestId('inbox-action').filter({ hasText: 'Open plan' }).click();
  await expect(page.getByTestId('plan-title')).toHaveText('Acme checkout');
  await expect(page.getByTestId('plan-repos-waiting')).toContainText("2 items: Waiting for the plan's agent to pick repositories.");

  // Every item gets its repositories: the Inbox item goes.
  for (const itemId of itemIds) {
    const set = await world.call(page, 'PUT', `/api/plans/${planId}/items/${itemId}`, { solutions: ['mobile'] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
  }
  await page.goto(`${world.baseUrl}/inbox`);
  await expect(page.getByTestId('view-inbox')).toBeVisible();
  await expect(page.getByTestId('inbox-item').filter({ hasText: 'Pick repositories' })).toHaveCount(0);
});
