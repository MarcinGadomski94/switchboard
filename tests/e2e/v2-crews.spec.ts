import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · lane P · the v2 Crews pages on the real path (fake claude; the OS keychain never
 * touched: `SWITCHBOARD_TEST_SECRET_STORE=memory`): the crews list reordered by drag and by
 * ⋯ › Move down, a teammate moved to another crew and back with Undo, Needs you's access link
 * (`?member=&tab=access`) opening the Access tab where Add key sets it up, a proposed job
 * description accepted (D105), and the phone's Crews › crew › teammate drill-down.
 */

let world: TeamWorld;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-v2-crews', { plain: true, env: { ...V2_SERVER_ENV, SWITCHBOARD_TEST_SECRET_STORE: 'memory' } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

/** The session's own agent calls the agent API (its token from the MCP config Switchboard wrote for its spawn). */
async function asAgent(sessionId: string, url: string, body: unknown): Promise<{ status: number; body: any }> {
  const config = JSON.parse(await readFile(path.join(world.dataDir, 'agent-mcp', `${sessionId}.json`), 'utf8')) as { mcpServers: { switchboard: { env: Record<string, string> } } };
  const response = await fetch(`${world.baseUrl}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.mcpServers.switchboard.env['SWITCHBOARD_TODO_TOKEN']}`, 'x-switchboard-session': sessionId },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function member(page: Page, name: string, teamId?: string): Promise<{ id: string; sessionId: string }> {
  const session = await world.startSession(page, `${name.toLowerCase()}-run`, 'Reply with just OK.');
  await world.settle(page, session.id);
  const adopted = await world.adopt(page, session.id, name, teamId ? { teamId } : {});
  return { id: adopted.id, sessionId: session.id };
}

const teamOrder = async (page: Page): Promise<string[]> => ((await world.call(page, 'GET', '/api/team/teams')).body as Array<{ name: string }>).map((team) => team.name);

let developer = { id: '', sessionId: '' };
let reviewer = { id: '', sessionId: '' };
let mobileId = '';

test('the crews list in order: drag to reorder, and ⋯ › Move down', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${world.baseUrl}/crews`);
  developer = await member(page, 'Developer');
  reviewer = await member(page, 'Reviewer');
  mobileId = (await world.call(page, 'POST', '/api/team/teams', { name: 'Acme Mobile' })).body.id as string;
  await world.call(page, 'POST', '/api/team/teams', { name: 'Acme Growth' });
  await page.goto(`${world.baseUrl}/crews`);
  const cards = page.getByTestId('v2-crew-card');
  await expect(cards.locator('h3')).toHaveText(['Team', 'Acme Mobile', 'Acme Growth']);
  await expect(cards.first()).toContainText('1st in your order · 2 teammates');

  // Drag Acme Growth onto Team: it takes the first place.
  await cards.nth(2).dragTo(cards.nth(0));
  await expect(cards.locator('h3')).toHaveText(['Acme Growth', 'Team', 'Acme Mobile']);
  await expect.poll(() => teamOrder(page)).toEqual(['Acme Growth', 'Team', 'Acme Mobile']);

  // Keyboard / menu: Move down.
  await cards.nth(0).getByTestId('v2-crew-menu').click();
  await page.getByRole('menuitem', { name: 'Move down' }).click();
  await expect.poll(() => teamOrder(page)).toEqual(['Team', 'Acme Growth', 'Acme Mobile']);
  await expect(cards.locator('h3')).toHaveText(['Team', 'Acme Growth', 'Acme Mobile']);
  // Move up is off at the top, and says why.
  await cards.nth(0).getByTestId('v2-crew-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Move up' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('v2-crew-menu-menu')).toContainText('Already first.');
  await page.keyboard.press('Escape');
  // Undo of the last reorder from its toast.
  await page.getByTestId('v2-toast').filter({ hasText: 'Order synced' }).last().getByTestId('v2-toast-undo').click();
  await expect.poll(() => teamOrder(page)).toEqual(['Acme Growth', 'Team', 'Acme Mobile']);
});

test('move a teammate to another crew, then Undo puts it back in its place', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${world.baseUrl}/crews/team`);
  const mates = page.getByTestId('v2-teammate');
  await expect(mates.locator('h3')).toHaveText(['Developer', 'Reviewer']);
  await mates.first().getByTestId('v2-teammate-menu').click();
  await page.getByRole('menuitem', { name: 'Move to crew…' }).click();
  const dialog = page.getByTestId('v2-move-crew');
  await dialog.locator(`[data-testid="v2-move-crew-option"][data-crew="${mobileId}"]`).click();
  await dialog.getByTestId('v2-move-crew-go').click();
  await expect(dialog).toHaveCount(0);
  await expect(mates.locator('h3')).toHaveText(['Reviewer']);
  await expect.poll(async () => (await world.call(page, 'GET', `/api/team?teamId=${mobileId}`)).body.members.map((entry: { name: string }) => entry.name)).toEqual(['Developer']);
  const toast = page.getByTestId('v2-toast').filter({ hasText: 'Moved Developer to Acme Mobile' });
  await expect(toast).toBeVisible();
  await toast.getByTestId('v2-toast-undo').click();
  await expect(mates.locator('h3')).toHaveText(['Developer', 'Reviewer']);
  await expect.poll(async () => (await world.call(page, 'GET', '/api/team?teamId=team')).body.members.map((entry: { name: string }) => entry.name)).toEqual(['Developer', 'Reviewer']);
  // ⋯ › Open chat peeks at the teammate's agent (lane X); the crew page stays.
  await mates.first().getByTestId('v2-teammate-menu').click();
  await page.getByRole('menuitem', { name: 'Open chat' }).click();
  await expect(page.getByTestId('v2-agent-peek')).toBeVisible();
  await expect(page).toHaveURL(/\/crews\/team$/);
  await page.keyboard.press('Escape');
});

test('Needs you’s access link opens the teammate’s Access tab; Add key sets it up', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${world.baseUrl}/crews/team`);
  const asked = await asAgent(developer.sessionId, '/agent/v1/team/access', {
    kind: 'api-key',
    service: 'Acme Analytics',
    host: 'api.acme.example',
    why: 'Fetch the weekly traffic report.',
    scope: 'read-only, reports',
    fields: [{ name: 'ACME_ANALYTICS_KEY', label: 'API key', secret: true, help: 'A read-only key.' }],
  });
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  // The ask is answerable inline on the teammate's card.
  const card = page.locator(`[data-testid="v2-teammate"][data-member="${developer.id}"]`);
  await expect(card.getByTestId('v2-answer-card')).toHaveCount(1);

  await page.goto(`${world.baseUrl}/crews/team?member=${developer.id}&tab=access`);
  const sheet = page.getByTestId('v2-teammate-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('tab', { name: 'Access' })).toHaveAttribute('aria-selected', 'true');
  const entry = sheet.getByTestId('v2-access-entry');
  await expect(entry).toContainText('Acme Analytics');
  await expect(entry).toContainText('api.acme.example');
  // The form is open on the access that waits; the field is a password field.
  const field = entry.locator('[data-testid="v2-access-field"][data-field="ACME_ANALYTICS_KEY"]');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill('acme-e2e-key-5c1d9f7a');
  await entry.getByTestId('v2-access-save').click();
  await expect(entry).toHaveAttribute('data-status', 'ready');
  await expect.poll(async () => (await world.call(page, 'GET', `/api/team/members/${developer.id}/access`)).body.entries[0].status).toBe('ready');
  // The value never comes back.
  expect(JSON.stringify((await world.call(page, 'GET', `/api/team/members/${developer.id}/access`)).body)).not.toContain('acme-e2e-key-5c1d9f7a');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/crews\/team$/);
});

test('a proposed job description is accepted from the teammate’s card', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${world.baseUrl}/crews/team`);
  const proposed = await asAgent(reviewer.sessionId, '/agent/v1/team/charter', {
    owns: 'Reviews of every change request in acme-app.',
    produces: 'A test plan per change and a short verdict.',
    neverDoes: 'Merges or deploys.',
    howItWorks: 'Reads each change request when it opens, runs the tests, comments.',
    notes: 'Drafted from this session.',
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBeLessThan(300);
  const card = page.locator(`[data-testid="v2-teammate"][data-member="${reviewer.id}"]`);
  // The shared answer card shows the proposal with Accept / Edit / Dismiss (the card's own block stays out of its way).
  const proposal = card.locator('[data-testid="v2-answer-card"][data-kind="jd"]');
  await expect(proposal).toContainText('Reviews of every change request in acme-app.');
  await expect(card.getByTestId('v2-charter-proposal')).toHaveCount(0);
  await proposal.getByRole('button', { name: 'Accept' }).click();
  await expect(proposal).toHaveCount(0);
  await expect(card.getByTestId('v2-teammate-jd')).toContainText('Reviews of every change request in acme-app.', { timeout: 20_000 });
  await expect.poll(async () => (await world.call(page, 'GET', '/api/team?teamId=team')).body.members.find((entry: { id: string }) => entry.id === reviewer.id).charter.owns, { timeout: 20_000 }).toBe('Reviews of every change request in acme-app.');
});

test('phone: Crews › crew › teammate drill-down with a breadcrumb', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/crews`);
  await page.locator('[data-testid="v2-crew-row"][data-crew="team"]').click();
  await expect(page).toHaveURL(/\/crews\/team$/);
  await expect(page.getByTestId('v2-crew-crumb')).toHaveText(/Crews.*Team/);
  await page.locator(`[data-testid="v2-teammate-row"][data-member="${developer.id}"]`).click();
  const crumb = page.getByTestId('v2-crew-crumb');
  await expect(crumb).toHaveText(/Crews.*Team.*Developer/);
  await expect(page.getByTestId('v2-teammate-panel')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await crumb.getByRole('link', { name: 'Team' }).click();
  await expect(page.locator(`[data-testid="v2-teammate-row"][data-member="${developer.id}"]`)).toBeVisible();
  const row = await page.locator('[data-testid="v2-teammate-row"]').first().boundingBox();
  expect(row?.height ?? 0).toBeGreaterThanOrEqual(44);
});
