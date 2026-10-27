import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { AccountProfile } from '../../src/core/accounts.ts';
import { THEME_STORAGE_KEY } from '../../src/web/theme.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D139 · the account needs you (`docs/accounts.md` → *The account needs you*), on the real path
 * (fake claude simulating Claude Code's "[ACTION REQUIRED]" exit through a marker file in the
 * account's own folder, temp git; never a real CLI or login):
 * 1. v2 desktop: a Project on the blocked account "Work" — its step shows "Stopped (account needs
 *    you)", new steps wait with the reason; a click on the stopped step (Steps, Graph) opens its
 *    details with Restart, Graph and Timeline nodes have the step menu; Needs you shows the item
 *    with the copyable command; the agent's chat has the divider; Retry stopped agents restarts it;
 * 2. v2 desktop: steps that failed with an error — per-step Restart and "Restart stopped steps (N)";
 * 3. phone (390×844): the Needs-you item, its command and Retry;
 * 4. classic: the Inbox item with the command and Retry; the plan page's per-item Restart and
 *    "Restart stopped steps (N)".
 */

const TERMS = '[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect on October 8, 2025. You must run `claude` to review the updated terms.';

let world: PlansWorld;
let work: AccountProfile;
let source = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startPlansWorld({ ...V2_SERVER_ENV, SWITCHBOARD_PLAN_STOPPED_GRACE_MS: '600000' });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

/** The fake's Work login refuses to run (`text` = what it prints; empty = the terms line) until {@link accept}. */
async function refuse(text = ''): Promise<void> {
  await writeFile(path.join(work.dir as string, '.fake-action-required'), text);
}

async function accept(): Promise<void> {
  await rm(path.join(work.dir as string, '.fake-action-required'), { force: true });
}

const command = (): string => `CLAUDE_CONFIG_DIR="${work.dir}" claude`;

/** A started Project on Work (no merge step) with independent steps, one at a time. */
async function project(page: Page, title: string, keys: readonly string[]): Promise<string> {
  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: source, title, maxConcurrency: 1 });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const planId = created.body.id as string;
  for (const key of keys) {
    const added = await world.call(page, 'POST', `/api/plans/${planId}/items`, { key, todo: { title: `Build ${key}`, estimateMinutes: 20 } });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
  }
  const started = await world.call(page, 'POST', `/api/plans/${planId}/start`, { mergeMode: 'none', accounts: { claude: work.id } });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  return planId;
}

test('v2: a Project on a blocked account — Stopped (account needs you), the details and step menus, Needs you with the command, the divider, Retry', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`${world.baseUrl}/projects`);
  source = await world.sourceSession(page, 'needs-you-source');
  // The project's own agent stays on its account (pinned), so only the steps run on Work.
  expect((await world.call(page, 'PUT', `/api/sessions/${source}/profile-pin`, { pinned: true })).status).toBe(200);
  const created = await world.call(page, 'POST', '/api/accounts/profiles', { cli: 'claude', name: 'Work' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  work = created.body as AccountProfile;
  await refuse();

  const planId = await project(page, 'Acme terms', ['PROJ-1', 'PROJ-2']);
  const stopped = await world.itemIn(page, planId, 'PROJ-1', 'stopped');
  const runId = stopped.runSessionId as string;
  await expect.poll(async () => (await world.plan(page, planId)).held).toBe('the account Work needs you');

  // Steps: the stopped step says why; new steps wait with the reason; Restart and "Restart stopped steps (1)".
  await page.goto(`${world.baseUrl}/projects/${planId}`);
  const row = page.locator('[data-testid="v2-step"][data-key="PROJ-1"]');
  await expect(row).toHaveAttribute('data-kind', 'stopped');
  await expect(row).toContainText('Stopped (account needs you)');
  await expect(row.getByTestId('v2-step-detail')).toContainText("the account Work needs you — accept Anthropic's updated terms");
  await expect(row.getByTestId('v2-step-restart')).toBeVisible();
  await expect(page.getByText('New steps wait: the account Work needs you')).toBeVisible();
  await expect(page.getByTestId('v2-project-restart-stopped')).toHaveText('Restart stopped steps (1)');
  // A click on the stopped step opens its details (not its stopped agent), with Restart first.
  await row.getByTestId('v2-step-open').click();
  const sheet = page.getByTestId('v2-step-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('v2-step-sheet-restart')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${planId}$`));
  // Restart while the account still needs you: refused with the reason.
  await sheet.getByTestId('v2-step-sheet-restart').click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'the account Work needs you' })).toBeVisible();

  // Board: the stopped card's click opens the details too; its ⋯ has Restart.
  await page.getByTestId('v2-project-views').getByRole('button', { name: 'Board' }).click();
  const card0 = page.locator('[data-testid="v2-board-card"][data-key="PROJ-1"]');
  await card0.getByText('Build PROJ-1').click();
  await expect(page.getByTestId('v2-step-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('v2-step-sheet')).toHaveCount(0);
  await card0.getByTestId('v2-step-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Restart' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Graph: the node's click opens the details; its ⋯ (and a right-click) is the step menu.
  await page.getByTestId('v2-project-views').getByRole('button', { name: 'Graph' }).click();
  const node = page.locator('[data-testid="v2-graph-node"][data-key="PROJ-1"]');
  await node.locator('rect').click({ position: { x: 30, y: 30 } });
  await expect(page.getByTestId('v2-step-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('v2-step-sheet')).toHaveCount(0);
  await node.getByTestId('v2-step-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Restart' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Mark done' })).toBeVisible();
  await page.keyboard.press('Escape');
  await node.locator('rect').click({ button: 'right', position: { x: 30, y: 30 } });
  await expect(page.getByRole('menuitem', { name: 'Restart' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Timeline: each row has the step menu too.
  await page.getByTestId('v2-project-views').getByRole('button', { name: 'Timeline' }).click();
  await page.locator('[data-testid="v2-timeline-row"][data-key="PROJ-1"]').getByTestId('v2-step-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Restart' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Needs you: one item, the CLI's words, the command (copyable), Retry stopped agents.
  await page.goto(`${world.baseUrl}/needs-you`);
  const card = page.getByTestId('v2-needs-list').locator('.v2-qi').filter({ hasText: 'Work (Claude Code) needs you' });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Work (Claude Code) needs you: accept Anthropic's updated terms");
  // The detail is Markdown in v2: the CLI's `claude` is shown as code.
  await expect(card).toContainText('[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect on October 8, 2025.');
  await expect(card.getByTestId('v2-answer-command-text')).toHaveText(command());
  await expect(card.getByTestId('v2-answer-command-button')).toBeVisible();

  // The stopped agent's chat says why, with the command.
  await page.goto(`${world.baseUrl}/agents/${runId}`);
  const divider = page.getByTestId('v2-agent-divider').filter({ hasText: "Stopped: the account Work needs you — accept Anthropic's updated terms" });
  await expect(divider).toBeVisible();
  await expect(divider.getByTestId('v2-agent-divider-command-text')).toHaveText(command());

  // The developer accepts in a terminal, then Retry stopped agents: the same agent runs on.
  await accept();
  await page.goto(`${world.baseUrl}/needs-you`);
  await card.getByRole('button', { name: 'Retry stopped agents' }).click();
  await expect(card).toHaveCount(0, { timeout: 20_000 });
  const back = await world.itemIn(page, planId, 'PROJ-1', 'running');
  expect(back.runSessionId).toBe(runId);
  await expect.poll(async () => (await world.plan(page, planId)).held, { timeout: 30_000 }).toBeNull();
});

test('v2: steps that failed with an error — per-step Restart and "Restart stopped steps (N)"', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`${world.baseUrl}/projects`);
  await refuse('fake: something else broke');
  const planId = await project(page, 'Acme errors', ['ERR-1', 'ERR-2', 'ERR-3']);
  // A failed step holds no slot: the next ones start (and fail the same way).
  for (const key of ['ERR-1', 'ERR-2', 'ERR-3']) await world.itemIn(page, planId, key, 'stopped');
  await accept();
  await page.goto(`${world.baseUrl}/projects/${planId}`);
  const first = page.locator('[data-testid="v2-step"][data-key="ERR-1"]');
  await expect(first).toContainText('its session stopped with an error');
  await expect(page.getByTestId('v2-project-restart-stopped')).toHaveText('Restart stopped steps (3)');
  await first.getByTestId('v2-step-restart').click();
  await world.itemIn(page, planId, 'ERR-1', 'running');
  await expect(page.getByTestId('v2-project-restart-stopped')).toHaveText('Restart stopped steps (2)');
  await page.getByTestId('v2-project-restart-stopped').click();
  for (const key of ['ERR-2', 'ERR-3']) await world.itemIn(page, planId, key, 'running');
  await expect(page.getByTestId('v2-project-restart-stopped')).toHaveCount(0);
});

test('phone (390×844): the Needs-you item, its command and Retry', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/needs-you`);
  await refuse();
  const folder = await world.call(page, 'POST', '/api/folders', { path: world.git.mobile });
  const started = await world.call(page, 'POST', '/api/sessions', { simple: true, name: 'phone-work', title: 'Phone work', task: 'Hello', folder: folder.body.id, worktrees: false, profileId: work.id });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const id = started.body.id as string;
  await expect.poll(async () => (await world.call(page, 'GET', `/api/sessions/${id}`)).body.status, { timeout: 20_000 }).toBe('fail');
  const card = page.getByTestId('v2-needs-list').locator('.v2-qi').filter({ hasText: 'Work (Claude Code) needs you' });
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await expect(card.getByTestId('v2-answer-command-text')).toHaveText(command());
  await expect(card.getByTestId('v2-answer-command-text')).toBeInViewport();
  await accept();
  await card.getByRole('button', { name: 'Retry stopped agents' }).click();
  await expect(card).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(async () => (await world.call(page, 'GET', `/api/sessions/${id}`)).body.status, { timeout: 30_000 }).not.toBe('fail');
});

test('classic: the Inbox item with the command and Retry; the plan page’s Restart and "Restart stopped steps (N)"', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript((key: string) => window.localStorage.setItem(key, 'classic'), THEME_STORAGE_KEY);
  await page.goto(`${world.baseUrl}/inbox`);
  await refuse();
  const folder = await world.call(page, 'POST', '/api/folders', { path: world.git.mobile });
  const started = await world.call(page, 'POST', '/api/sessions', { simple: true, name: 'classic-work', title: 'Classic work', task: 'Hello', folder: folder.body.id, worktrees: false, profileId: work.id });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const id = started.body.id as string;
  const item = page.getByTestId('inbox-item').filter({ hasText: 'Work (Claude Code) needs you' });
  await expect(item).toHaveCount(1, { timeout: 20_000 });
  await item.click();
  const detail = page.getByTestId('inbox-detail');
  await expect(detail.getByTestId('inbox-title')).toHaveText("Work (Claude Code) needs you: accept Anthropic's updated terms");
  await expect(detail.getByTestId('inbox-text')).toContainText(TERMS);
  await expect(detail.getByTestId('inbox-command-text')).toHaveText(command());
  await expect(detail.getByTestId('inbox-command-button')).toBeVisible();
  await accept();
  await detail.getByTestId('inbox-action').filter({ hasText: 'Retry stopped agents' }).click();
  await expect(item).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(async () => (await world.call(page, 'GET', `/api/sessions/${id}`)).body.status, { timeout: 30_000 }).not.toBe('fail');

  // The plan page: stopped items (an error) with Restart, and "Restart stopped steps (N)".
  await refuse('fake: something else broke');
  const planId = await project(page, 'Acme classic', ['CLS-1', 'CLS-2']);
  for (const key of ['CLS-1', 'CLS-2']) await world.itemIn(page, planId, key, 'stopped');
  await accept();
  await page.goto(`${world.baseUrl}/plans/${planId}`);
  const restartAll = page.getByTestId('plan-restart-stopped');
  await expect(restartAll).toContainText('Restart stopped steps (2)');
  await page.getByTestId('plan-tab-list').click();
  const rows = page.getByTestId('plan-row');
  // A stopped row opens its detail (not its failed session): Restart is there too.
  await rows.filter({ hasText: 'CLS-1' }).locator('.sb-plan-row__main').click();
  await expect(page.getByTestId('plan-detail-restart')).toBeVisible();
  await rows.filter({ hasText: 'CLS-1' }).getByTestId('plan-row-restart').click();
  await world.itemIn(page, planId, 'CLS-1', 'running');
  await expect(restartAll).toContainText('Restart stopped steps (1)');
  await restartAll.click();
  await world.itemIn(page, planId, 'CLS-2', 'running');
  await expect(restartAll).toHaveCount(0);
});
