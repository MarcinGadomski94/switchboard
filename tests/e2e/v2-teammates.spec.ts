import { type Page, expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.0 · a teammate lives in Crews only, under its teammate's name: a
 * session adopted into a crew leaves the Agents page (List, Chats, Board, the
 * folder tree) and shows in Crews; its chat names it by its teammate's name with
 * its crew (header, tab title, peek), rename goes through the crew, and Return to
 * agents brings it back under its own name. The rail's Recent lists the agents
 * opened last, newest first.
 */
let world: TeamWorld;
let mate = { id: '', sessionId: '' };
let plain = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-v2-teammates', { plain: true, env: { ...V2_SERVER_ENV, SWITCHBOARD_TEST_SECRET_STORE: 'memory' } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function agentsView(page: Page, view: 'list' | 'chats' | 'board'): Promise<void> {
  await page.getByTestId('v2-agents-view').locator(`[data-value="${view}"]`).click();
}

test('a session adopted into a crew leaves Agents (List, Chats, Board, tree) and shows in Crews', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${world.baseUrl}/agents`);
  const one = await world.startSession(page, 'acme-review-run', 'Reply with just OK.');
  await world.settle(page, one.id);
  const two = await world.startSession(page, 'acme-plain-run', 'Reply with just OK.');
  await world.settle(page, two.id);
  plain = two.id;
  const adopted = await world.adopt(page, one.id, 'Reviewer/QA');
  mate = { id: adopted.id, sessionId: one.id };

  await page.goto(`${world.baseUrl}/agents`);
  const row = (id: string) => page.locator(`[data-testid="v2-agent-row"][data-session="${id}"]`);
  await agentsView(page, 'list');
  await expect(row(plain)).toHaveCount(1);
  await expect(row(mate.sessionId)).toHaveCount(0);
  await expect(page.getByTestId('v2-crew-group')).toHaveCount(0);
  await agentsView(page, 'chats');
  await expect(row(plain)).toHaveCount(1);
  await expect(row(mate.sessionId)).toHaveCount(0);
  await agentsView(page, 'board');
  await expect(page.locator(`[data-testid="v2-bcard"][data-session="${plain}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-testid="v2-bcard"][data-session="${mate.sessionId}"]`)).toHaveCount(0);
  // Group rows by: Project | Folder (no Crew).
  await expect(page.getByTestId('v2-groupby').locator('[data-value]')).toHaveCount(2);
  await expect(page.getByTestId('v2-groupby').locator('[data-value="crew"]')).toHaveCount(0);
  // The tree: no Crews section, the teammate nowhere, the counts without it.
  const tree = page.getByTestId('v2-ftree');
  await expect(tree.getByTestId('v2-tree-crew')).toHaveCount(0);
  await expect(tree.locator(`[data-testid="v2-tree-agent"][data-session="${mate.sessionId}"]`)).toHaveCount(0);
  await expect(tree.locator(`[data-testid="v2-tree-agent"][data-session="${plain}"]`)).toHaveCount(1);

  // Crews owns it.
  await page.goto(`${world.baseUrl}/crews/team`);
  await expect(page.locator(`[data-testid="v2-teammate"][data-member="${mate.id}"]`)).toContainText('Reviewer/QA');
});

test('its chat opens by link and names it by its teammate name and crew; rename goes through the crew', async ({ page }) => {
  await page.goto(`${world.baseUrl}/agents/${mate.sessionId}`);
  await expect(page.getByTestId('v2-agent-title')).toHaveText('Reviewer/QA');
  await expect(page.getByTestId('v2-agent-header').getByTestId('v2-crew-tag')).toHaveText('· Team');
  await expect(page).toHaveTitle('Reviewer/QA · Switchboard');
  // Back goes to its crew, not to Agents.
  await expect(page.getByTestId('v2-agent-back')).toHaveAttribute('href', '/crews/team');
  // Rename renames the teammate.
  await page.getByTestId('v2-agent-title').click();
  await page.getByTestId('v2-agent-title-field').fill('Reviewer');
  await page.getByTestId('v2-agent-title-field').press('Enter');
  await expect.poll(async () => (await world.call(page, 'GET', `/api/team/members/${mate.id}`)).body.name).toBe('Reviewer');
  await expect(page.getByTestId('v2-agent-title')).toHaveText('Reviewer');
  // The peek says the same.
  await page.goto(`${world.baseUrl}/crews/team`);
  await page.waitForFunction(() => typeof (window as unknown as { __sbV2Peek?: unknown }).__sbV2Peek === 'function');
  await page.evaluate((id) => (window as unknown as { __sbV2Peek: (id: string) => void }).__sbV2Peek(id), mate.sessionId);
  await expect(page.getByTestId('v2-agent-peek-name')).toContainText('Reviewer');
  await expect(page.getByTestId('v2-agent-peek-name').getByTestId('v2-crew-tag')).toHaveText('· Team');
  await page.keyboard.press('Escape');
});

test('Return to agents brings it back to the Agents page under its own name', async ({ page }) => {
  await page.goto(`${world.baseUrl}/agents/${mate.sessionId}`);
  await expect(page.getByTestId('v2-agent-title')).toHaveText('Reviewer');
  await page.getByTestId('v2-agent-menu').click();
  await page.getByTestId('v2-agent-menu-list').getByRole('menuitem', { name: 'Return to agents' }).click();
  await expect(page.getByTestId('v2-agent-title')).toHaveText('acme-review-run');
  await expect(page.getByTestId('v2-agent-header').getByTestId('v2-crew-tag')).toHaveCount(0);
  await expect(page.getByTestId('v2-agent-back')).toHaveAttribute('href', '/agents');
  await page.goto(`${world.baseUrl}/agents`);
  await agentsView(page, 'list');
  await expect(page.locator(`[data-testid="v2-agent-row"][data-session="${mate.sessionId}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-testid="v2-tree-agent"][data-session="${mate.sessionId}"]`)).toHaveCount(1);
});

test('the rail’s Recent: opening two agents lists them newest first', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  await page.evaluate(() => window.localStorage.removeItem('switchboard.v2.recent'));
  await page.goto(`${world.baseUrl}/agents/${plain}`);
  await expect(page.getByTestId('v2-agent-title')).toBeVisible();
  await page.goto(`${world.baseUrl}/agents/${mate.sessionId}`);
  await expect(page.getByTestId('v2-agent-title')).toBeVisible();
  const items = page.getByTestId('v2-recent').getByTestId('v2-recent-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute('data-session', mate.sessionId);
  await expect(items.nth(1)).toHaveAttribute('data-session', plain);
  // Folding is remembered; Clear recent empties it.
  await page.getByTestId('v2-recent-toggle').click();
  await expect(items).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('v2-recent-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('v2-recent-toggle').click();
  await expect(items).toHaveCount(2);
  await page.getByTestId('v2-recent-menu').click();
  await page.getByTestId('v2-recent-menu-list').getByRole('menuitem', { name: 'Clear recent' }).click();
  await expect(page.getByTestId('v2-recent')).toHaveCount(0);
});
