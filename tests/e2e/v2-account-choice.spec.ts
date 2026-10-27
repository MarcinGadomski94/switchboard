import { type Page, expect, test } from '@playwright/test';
import type { AccountProfile } from '../../src/core/accounts.ts';
import type { Session } from '../../src/core/api.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D138 · choosing the account (`docs/accounts.md` → *Choosing the account*) in v2, on the real
 * path (fake claude, temp git, a second account "Private"; never a real CLI or login):
 * 1. the status pill's picker → the confirm with the counts → the agents move to Private and say
 *    "Account: Private (overall choice)" in their header;
 * 2. a Project's Start dialog sets its account: its own agent moves to it ("from project");
 * 3. at phone width (390×844) the pill's picker is there too; Automatic moves nothing.
 */

let world: PlansWorld;
let first = '';
let second = '';
let privateId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startPlansWorld({ ...V2_SERVER_ENV });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function session(page: Page, id: string): Promise<Session> {
  return (await world.call(page, 'GET', `/api/sessions/${id}`)).body as unknown as Session;
}

test('the pill’s account picker: confirm with the counts, the agents move and say where their account comes from', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/projects`);
  first = await world.sourceSession(page, 'acct-one');
  second = await world.sourceSession(page, 'acct-two');
  const created = await world.call(page, 'POST', '/api/accounts/profiles', { cli: 'claude', name: 'Private' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  privateId = (created.body as unknown as AccountProfile).id;

  await page.goto(`${world.baseUrl}/agents/${first}`);
  await page.getByTestId('v2-status-pill').click();
  const pop = page.getByTestId('v2-status-pop');
  const select = pop.getByTestId('v2-pill-account-choice-select');
  await expect(select).toHaveValue('');
  await select.selectOption(privateId);
  const confirm = page.getByTestId('v2-account-choice-confirm');
  await expect(confirm.getByTestId('v2-account-choice-text')).toHaveText('Move 2 agents to Private?');
  await confirm.getByTestId('v2-account-choice-move').click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByText('Moving 2 agents to Private.')).toBeVisible();

  for (const id of [first, second]) await expect.poll(async () => (await session(page, id)).profileName, { timeout: 30_000 }).toBe('Private');
  await expect(page.getByTestId('v2-agent-account-chip')).toHaveText('Account: Private (overall choice)');
  await expect(page.getByTestId('v2-agent-account-chip')).toHaveAttribute('data-source', 'overall');
  // The divider in the chat says why.
  await expect(page.getByTestId('v2-agent-divider').filter({ hasText: 'Switched account: Default → Private (overall choice)' })).toBeVisible();
  // The picker shows the choice; new agents start on it.
  await page.getByTestId('v2-status-pill').click();
  await expect(page.getByTestId('v2-status-pop').getByTestId('v2-pill-account-choice-select')).toHaveValue(privateId);
  await page.keyboard.press('Escape');
  const settings = (await world.call(page, 'GET', '/api/accounts')).body as { settings: { choice: Record<string, string> } };
  expect(settings.settings.choice).toEqual({ claude: privateId });
  // Settings › Usage & accounts shows the same choice.
  await page.goto(`${world.baseUrl}/settings/usage`);
  await expect(page.getByTestId('v2-account-choice-card').getByTestId('v2-set-account-choice-select')).toHaveValue(privateId);
});

test('a Project’s Start dialog sets its account: its own agent moves to it and says "from project"', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/projects`);
  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: first, title: 'Acme account', targetBranch: world.target, baseBranch: 'main', maxConcurrency: 1 });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const planId = created.body.id as string;
  const added = await world.call(page, 'POST', `/api/plans/${planId}/items`, { key: 'PROJ-1', todo: { title: 'Build it', estimateMinutes: 20 } });
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  await page.goto(`${world.baseUrl}/projects/${planId}`);
  await page.getByTestId('v2-project-start').click();
  const dialog = page.getByTestId('v2-start-dialog');
  await dialog.locator('[data-testid="v2-mode-option"][data-mode="developer"]').click();
  const account = dialog.getByTestId('v2-start-account');
  await expect(account).toHaveValue('');
  await expect(account.locator('option').first()).toHaveText('Automatic (your overall choice)');
  await account.selectOption('default-claude');
  await dialog.getByTestId('v2-start-go').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await world.plan(page, planId)).accounts ?? null).toEqual({ claude: 'default-claude' });
  await expect.poll(async () => (await session(page, first)).profileName, { timeout: 30_000 }).toBe('Default');
  expect((await session(page, first)).accountChoice).toMatchObject({ source: 'project', profileId: 'default-claude', project: { id: planId, title: 'Acme account' } });
  // Its first step's agent starts on the project's account too.
  const item = await world.itemIn(page, planId, 'PROJ-1', 'running');
  expect((await session(page, item.runSessionId as string)).profileName).toBe('Default');
  await page.goto(`${world.baseUrl}/agents/${first}`);
  await expect(page.getByTestId('v2-agent-account-chip')).toHaveText('Account: Default (from project)');
  // The other agent keeps the overall choice.
  expect((await session(page, second)).profileName).toBe('Private');
  // The project's ⋯ → Account… shows it.
  await page.goto(`${world.baseUrl}/projects/${planId}`);
  await page.getByTestId('v2-project-menu').click();
  await page.getByRole('menuitem', { name: 'Account…' }).click();
  await expect(page.getByTestId('v2-project-account-dialog').getByTestId('v2-project-account')).toHaveValue('default-claude');
});

test('phone width (390×844): the pill’s picker; Automatic moves nothing', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/agents/${second}`);
  const pill = page.getByTestId('v2-status-pill');
  await expect(pill).toBeVisible();
  await pill.click();
  const select = page.getByTestId('v2-status-pop').getByTestId('v2-pill-account-choice-select');
  await expect(select).toBeVisible();
  await expect(select).toHaveValue(privateId);
  const box = await page.getByTestId('v2-status-pop').boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390 + 1).toBe(true);
  await select.selectOption('');
  // Nothing moves, so no confirm: the choice is saved straight away.
  await expect(page.getByText('New agents use the first account with usage left.')).toBeVisible();
  await expect(page.getByTestId('v2-account-choice-confirm')).toHaveCount(0);
  const settings = (await world.call(page, 'GET', '/api/accounts')).body as { settings: { choice: Record<string, string> } };
  expect(settings.settings.choice).toEqual({});
  expect((await session(page, second)).profileName).toBe('Private');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
