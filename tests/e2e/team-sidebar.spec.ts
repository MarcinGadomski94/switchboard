import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { openDrawer, openPage, touchContext } from './responsive-world.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * D100 (E2E, real code path with fake-claude): Settings → Experimental → Team
 * switches Team on; an adopted member's session leaves the sidebar's SESSIONS
 * while the other session stays; switching Team off in Settings puts it back.
 * D100 follow-up 2026-10-16: each team folds (remembered across a reload) and lists
 * its members with a live status line; a member row opens it on the Team page; the
 * phone drawer has the same rows with 44 px targets.
 */
let tmp: string;
let server: ServerProcess;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-team');
  const workspace = path.join(tmp, 'work space');
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  await seedFolderInDataDir(path.join(tmp, 'data'), workspace);
  server = await startServer({
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    SWITCHBOARD_TUTORIAL: 'off',
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  await removeTempDir(tmp);
});

async function call(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ method: m, url: u, body: b }) => {
      const response = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    { method, url, body },
  );
}

async function start(page: Page, name: string): Promise<string> {
  const answer = await call(page, 'POST', '/api/sessions', { name, task: 'Reply with just OK.', workType: 'feature', mode: 'single', solutions: [], phase: 'ui-first', coordination: 'none', qa: null, worktrees: false, ultracode: false });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.id as string;
}

function row(page: Page, id: string) {
  return page.getByTestId('sidebar-sessions').locator(`a.sb-session[data-session-id="${id}"]`);
}

async function flipTeam(page: Page, to: 'on' | 'off'): Promise<void> {
  await page.goto(`${server.baseUrl}/settings/experimental`);
  const toggle = page.locator('[data-row="experimental-team"]').getByTestId('setting-value');
  await expect(toggle).toHaveText(to === 'on' ? 'off' : 'on');
  await toggle.click();
  await expect(toggle).toHaveText(to);
}

test('Team on: an adopted session leaves the sidebar; Team off: it is back', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const tracker = await start(page, 'tracker-run');
  const other = await start(page, 'other-run');
  await expect(row(page, tracker)).toBeVisible();
  await expect(row(page, other)).toBeVisible();

  // Off by default: the switch reads off and nothing is hidden.
  await flipTeam(page, 'on');
  const adopted = await call(page, 'POST', '/api/team/members', { sessionId: tracker, name: 'Tracker' });
  expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
  await expect(row(page, tracker)).toHaveCount(0);
  await expect(row(page, other)).toBeVisible();

  await flipTeam(page, 'off');
  await expect(row(page, tracker)).toBeVisible();
  await expect(row(page, other)).toBeVisible();
});

async function settle(page: Page, id: string, pattern: RegExp = /^(idle|done|need)$/): Promise<void> {
  await expect.poll(async () => (await call(page, 'GET', `/api/sessions/${id}`)).body?.status as string, { timeout: 20_000 }).toMatch(pattern);
}

async function adopt(page: Page, sessionId: string, name: string): Promise<string> {
  const answer = await call(page, 'POST', '/api/team/members', { sessionId, name });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.id as string;
}

function memberRow(page: Page, memberId: string) {
  return page.locator(`[data-testid="sidebar-team-member"][data-member-id="${memberId}"]`);
}

test('D100 follow-up 2026-10-16: member rows with live status; folding is remembered; a row opens the member', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const builder = await start(page, 'builder-run');
  const idler = await start(page, 'idler-run');
  const asker = await start(page, 'asker-run');
  const rester = await start(page, 'rester-run');
  for (const id of [builder, idler, asker, rester]) await settle(page, id);
  await flipTeam(page, 'on');
  // The first test's member returns (only this test's members are listed).
  for (const member of (await call(page, 'GET', '/api/team')).body.members as Array<{ id: string }>) await call(page, 'DELETE', `/api/team/members/${member.id}`);
  const builderId = await adopt(page, builder, 'Builder');
  const idlerId = await adopt(page, idler, 'Idler with a rather long role name');
  const askerId = await adopt(page, asker, 'Asker');
  const resterId = await adopt(page, rester, 'Rester');

  // Builder: a todo in progress and a turn that runs for a while.
  const added = await call(page, 'POST', `/api/sessions/${builder}/todos`, { title: 'Wire the sidebar member rows' });
  expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
  const todoId = (added.body.todo?.id ?? added.body.todos?.[0]?.id) as string;
  expect((await call(page, 'PUT', `/api/sessions/${builder}/todos/${todoId}`, { state: 'in_progress' })).status).toBe(200);
  expect((await call(page, 'POST', `/api/sessions/${builder}/messages`, { text: '[fake:hold 60] Build it.' })).status).toBeLessThan(300);
  await settle(page, builder, /^run$/);
  // Asker: a question waits for the developer. Rester: paused.
  expect((await call(page, 'POST', `/api/sessions/${asker}/messages`, { text: '[fake:ask-2q] Ask me.' })).status).toBeLessThan(300);
  await settle(page, asker, /^need$/);
  expect((await call(page, 'POST', `/api/team/members/${resterId}/pause`)).status).toBe(200);

  await page.goto(`${server.baseUrl}/inbox`);
  const group = page.locator('[data-testid="sidebar-team-group"][data-team-id="team"]');
  await expect(group.getByTestId('sidebar-team-toggle')).toHaveAttribute('aria-expanded', 'true');
  // In the team's order, each with its glyph and its line.
  await expect(group.getByTestId('sidebar-team-member')).toHaveCount(4);
  await expect(group.getByTestId('sidebar-team-member').nth(0)).toHaveAttribute('data-member-id', builderId);
  await expect(memberRow(page, builderId)).toHaveAttribute('data-status', 'working');
  await expect(memberRow(page, builderId).getByTestId('sidebar-team-member-glyph')).toHaveText('●');
  await expect(memberRow(page, builderId).getByTestId('sidebar-team-member-line')).toHaveText(/^Wire the sideba… · \d+m$/);
  await expect(memberRow(page, builderId)).toHaveAttribute('title', 'Builder · working on Wire the sidebar member rows');
  await expect(memberRow(page, idlerId)).toHaveAttribute('data-status', 'idle');
  await expect(memberRow(page, idlerId).getByTestId('sidebar-team-member-glyph')).toHaveText('○');
  await expect(memberRow(page, idlerId).getByTestId('sidebar-team-member-line')).toHaveText(/^idle · \d+m$/);
  await expect(memberRow(page, idlerId)).toHaveAttribute('title', 'Idler with a rather long role name · idle');
  await expect(memberRow(page, askerId).getByTestId('sidebar-team-member-glyph')).toHaveText('?');
  await expect(memberRow(page, askerId).getByTestId('sidebar-team-member-line')).toHaveText('needs you');
  await expect(memberRow(page, resterId).getByTestId('sidebar-team-member-glyph')).toHaveText('⏸');
  await expect(memberRow(page, resterId).getByTestId('sidebar-team-member-line')).toHaveText('paused');
  // The team row keeps its needs-you count.
  await expect(group.getByTestId('sidebar-team-need')).toHaveText('1');
  await page.getByTestId('sidebar').screenshot({ path: test.info().outputPath('team-sidebar-expanded.png') });

  // Live: the builder's turn is interrupted and it goes idle without a reload.
  expect((await call(page, 'POST', `/api/sessions/${builder}/interrupt`)).status).toBeLessThan(300);
  await expect(memberRow(page, builderId)).toHaveAttribute('data-status', 'idle', { timeout: 15_000 });
  await expect(memberRow(page, builderId).getByTestId('sidebar-team-member-line')).toHaveText(/^idle · \d+m$/);

  // Folded: no rows, a summary; remembered across a reload; unfolded again likewise.
  await group.getByTestId('sidebar-team-toggle').click();
  await expect(group.getByTestId('sidebar-team-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(group.getByTestId('sidebar-team-member')).toHaveCount(0);
  await expect(group.getByTestId('sidebar-team-summary')).toHaveText('2 idle · 1 paused');
  await expect(group.getByTestId('sidebar-team-need')).toHaveText('1');
  await expect.poll(async () => ((await call(page, 'GET', '/api/team/teams')).body as Array<{ id: string; collapsed?: boolean }>).find((t) => t.id === 'team')?.collapsed).toBe(true);
  await page.reload();
  await expect(group.getByTestId('sidebar-team-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(group.getByTestId('sidebar-team-member')).toHaveCount(0);
  await group.getByTestId('sidebar-team-toggle').press('Enter');
  await expect(group.getByTestId('sidebar-team-member')).toHaveCount(4);
  await expect.poll(async () => ((await call(page, 'GET', '/api/team/teams')).body as Array<{ id: string; collapsed?: boolean }>).find((t) => t.id === 'team')?.collapsed).toBe(false);
  await page.reload();
  await expect(group.getByTestId('sidebar-team-member')).toHaveCount(4);

  // A member row opens the member on the Team page, selected, on its chat (also from the Team page itself).
  await memberRow(page, idlerId).click();
  await expect(page).toHaveURL(/\/team\/team$/);
  await expect(page.getByTestId('team-panel')).toHaveAttribute('data-member-id', idlerId);
  await expect(page.getByTestId('team-chat')).toBeVisible();
  await memberRow(page, askerId).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('team-panel')).toHaveAttribute('data-member-id', askerId);

  // The phone drawer: the same rows, 44 px targets; a row closes the drawer and opens the member.
  const context = await touchContext(page.context().browser()!, { name: 'phone', width: 390, height: 844 });
  await context.addCookies(await page.context().cookies());
  const phone = await context.newPage();
  await openPage(phone, server.baseUrl, '/inbox');
  await openDrawer(phone);
  const phoneGroup = phone.locator('[data-testid="sidebar-team-group"][data-team-id="team"]');
  await expect(phoneGroup.getByTestId('sidebar-team-member')).toHaveCount(4);
  for (const target of [phoneGroup.getByTestId('sidebar-team-toggle'), phoneGroup.getByTestId('sidebar-team-member').first()]) {
    const box = await target.boundingBox();
    expect(box && Math.round(box.height)).toBeGreaterThanOrEqual(44);
    expect(box && Math.round(box.width)).toBeGreaterThanOrEqual(44);
  }
  await phone.locator(`[data-testid="sidebar-team-member"][data-member-id="${resterId}"]`).click();
  await expect(phone.getByTestId('shell')).toHaveAttribute('data-drawer', 'closed');
  await expect(phone.getByTestId('team-panel')).toHaveAttribute('data-member-id', resterId);
  await context.close();

  // Team off: nothing of it renders.
  await flipTeam(page, 'off');
  await page.goto(`${server.baseUrl}/inbox`);
  await expect(page.getByTestId('sidebar-teams')).toHaveCount(0);
});
