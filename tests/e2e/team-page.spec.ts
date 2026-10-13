import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { openWithHub } from './question-world.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';

/**
 * D100 · the Team page (T3), on the real code path with fake-claude
 * (`docs/team.md` → *The Team page*): the switch brings the nav and sidebar entries;
 * review → adopt moves a session out of the list into a card whose chat works, and
 * Return puts it back in its sidebar folder; a member from a template; a Needs-you
 * question answered in place; Pause; the phone layout.
 */

let world: TeamWorld;

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-team-page');
});

test.afterAll(async () => {
  await world?.stop();
});

function row(page: Page, id: string) {
  return page.getByTestId('sidebar-sessions').locator(`a.sb-session[data-session-id="${id}"]`);
}

function card(page: Page, role: string) {
  return page.getByTestId('team-card').filter({ has: page.getByTestId('team-card-role').getByText(role, { exact: true }) });
}

async function removeAllMembers(page: Page): Promise<void> {
  const view = await world.call(page, 'GET', '/api/team');
  if (view.status !== 200) return;
  for (const member of view.body.members as Array<{ id: string }>) await world.call(page, 'DELETE', `/api/team/members/${member.id}`);
}

test.describe.configure({ mode: 'serial' });

test('the switch: off = no Team nav or sidebar entry; on = both appear', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await expect(page.getByTestId('nav-todos')).toBeVisible();
  await expect(page.getByTestId('nav-team')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-team')).toHaveCount(0);

  await page.goto(`${world.baseUrl}/settings/experimental`);
  await expect(page.locator('[data-row="experimental-team"]')).toContainText('Off: no Team page, no background work, and every team member goes back to the session list.');
  const toggle = page.locator('[data-row="experimental-team"]').getByTestId('setting-value');
  await expect(toggle).toHaveText('off');
  await toggle.click();
  await expect(toggle).toHaveText('on');
  await expect(page.getByTestId('nav-team')).toBeVisible();
  await expect(page.getByTestId('sidebar-team')).toHaveText('⚑Team · 0 members');

  await page.getByTestId('nav-team').click();
  await expect(page).toHaveURL(/\/team$/);
  await expect(page.getByTestId('team-empty')).toContainText('No team members yet');
  await expect(page.getByTestId('team-empty')).toContainText('Adopt one of your sessions, or start a new member from a template.');

  // The default name shows once ("Team"); a rename shows "Team · <name>" here and in the sidebar.
  await expect(page.getByTestId('team-title')).toHaveText('Team');
  await page.getByTestId('team-title').click();
  await page.getByTestId('team-title-input').fill('Acme');
  await page.getByTestId('team-title-input').press('Enter');
  await expect(page.getByTestId('team-title')).toHaveText('Team · Acme');
  await expect(page.getByTestId('sidebar-team')).toHaveText('⚑Team · Acme · 0 members');
  await page.getByTestId('team-title').click();
  await page.getByTestId('team-title-input').fill('');
  await page.getByTestId('team-title-input').press('Enter');
  await expect(page.getByTestId('team-title')).toHaveText('Team');
});

test('review → adopt: the session leaves the list, its card appears, the chat works; Return puts it back in its folder', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await world.setTeam(page, true);
  const session = await world.startSession(page, 'board-watch', 'Reply with just OK.');
  await world.settle(page, session.id);
  await world.call(page, 'PUT', `/api/sessions/${session.id}/title`, { title: 'Board watch' });
  // Edit-heavy work, so the suggestions see a developer; a quiet session is not suggested.
  await world.pump(page, session.id, 'Edit', 14);
  const quiet = await world.startSession(page, 'quiet-chat', 'Reply with just OK.');
  await world.settle(page, quiet.id);
  const folderId = await world.placeInFolder(page, session.id, 'Work');
  await expect(row(page, session.id)).toBeVisible();

  await page.getByTestId('nav-team').click();
  await expect(page.getByTestId('team-banner')).toContainText('Switchboard found');
  await page.getByTestId('team-banner-review').click();
  const dialog = page.getByTestId('team-review-dialog');
  const suggestion = dialog.locator(`[data-testid="team-suggestion"][data-session-id="${session.id}"]`);
  await expect(suggestion).toContainText('← “Board watch”');
  await expect(suggestion.getByTestId('team-confidence')).toBeVisible();
  await expect(suggestion.getByTestId('team-suggestion-draft')).toContainText('Draft charter · owns');
  await expect(suggestion).toContainText('Developer');
  await expect(suggestion).toContainText('file tool calls edit: looks like implementation.');
  await expect(dialog.getByTestId('team-suggestion')).toHaveCount(1);
  await expect(dialog.locator(`[data-testid="team-not-suggested-row"][data-session-id="${quiet.id}"]`)).toContainText('too little activity or no clear role to tell');
  await suggestion.getByTestId('team-suggestion-adopt').click();

  const form = page.getByTestId('team-form-dialog');
  await expect(form.getByTestId('team-adopt-note')).toContainText('“Board watch” leaves your session list and lives in Team from now on');
  await expect(form.getByTestId('team-adopt-note')).toContainText('puts it back in “Work”, where it was');
  await expect(form.locator('[data-testid="team-form-gate"][data-gate="outward-facing"]')).toBeChecked();
  await expect(form.locator('[data-testid="team-form-gate"][data-gate="outward-facing"]')).toBeDisabled();
  await form.getByTestId('team-form-name').fill('Tracker');
  await form.getByTestId('team-form-submit').click();

  await expect(page.getByTestId('toast')).toContainText('“Board watch” moved from your session list into Team as Tracker');
  await page.getByTestId('toast').getByRole('button', { name: 'Close' }).click();
  await expect(row(page, session.id)).toHaveCount(0);
  await expect(card(page, 'Tracker')).toBeVisible();
  await expect(card(page, 'Tracker')).toContainText('from “Board watch”');
  await expect(page.getByTestId('sidebar-team')).toContainText('1 member');

  // The chat: the real session chat with its composer.
  await card(page, 'Tracker').click();
  const panel = page.getByTestId('team-panel');
  await expect(panel.getByTestId('team-panel-name')).toHaveText('Tracker');
  await expect(panel.getByTestId('team-tab-chat')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByTestId('team-tab-access')).toBeVisible();
  const before = await panel.locator('[data-testid="chat-message"][data-role="agent"]').count();
  await panel.getByTestId('chat-input').fill('Status please.');
  await panel.getByTestId('chat-send').click();
  await expect(panel.locator('[data-testid="chat-message"][data-role="user"]').last()).toContainText('Status please.');
  await expect.poll(() => panel.locator('[data-testid="chat-message"][data-role="agent"]').count(), { timeout: 20_000 }).toBeGreaterThan(before);

  // Return to sessions (back to "Work").
  await panel.getByTestId('team-panel-menu').click();
  const menu = page.getByTestId('team-member-menu');
  await expect(menu.getByTestId('team-menu-return')).toHaveText('↩ Return to sessions (back to “Work”)');
  await menu.getByTestId('team-menu-return').click();
  await expect(page.getByTestId('toast')).toContainText('“Board watch” is back in your session list (Work) as a plain session');
  await expect(row(page, session.id)).toBeVisible();
  await expect(row(page, session.id)).toHaveAttribute('data-team-returned', 'true');
  const layout = await world.call(page, 'GET', '/api/sidebar');
  expect((layout.body.folders as Array<{ id: string; sessionIds: string[] }>).find((f) => f.id === folderId)?.sessionIds).toContain(session.id);
  await expect(page.getByTestId('team-empty')).toBeVisible();
});

test('create from a template: Planner with its suggested loop', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/team`);
  await world.setTeam(page, true);
  await removeAllMembers(page);
  await page.getByTestId('team-empty-add').click();
  await page.getByTestId('team-add-template').click();
  const templates = page.getByTestId('team-template-dialog');
  await expect(templates.getByTestId('team-template')).toHaveCount(7);
  await templates.locator('[data-template-id="planner"]').click();
  const form = page.getByTestId('team-form-dialog');
  await expect(form.getByTestId('team-form-name')).toHaveValue('Planner');
  await expect(form.getByTestId('team-form-owns')).not.toHaveValue('');
  await expect(form.getByTestId('team-form-template-loop')).toBeChecked();
  await form.getByTestId('team-form-submit').click();
  await expect(card(page, 'Planner')).toBeVisible({ timeout: 20_000 });
  const view = await world.call(page, 'GET', '/api/team');
  const planner = (view.body.members as Array<{ name: string; templateId: string; rhythm: { loops: Array<{ label: string }> } }>).find((m) => m.name === 'Planner');
  expect(planner?.templateId).toBe('planner');
  expect(planner?.rhythm.loops.map((loop) => loop.label)).toEqual(['Morning planning']);
});

test('Needs you: a member\'s question is answered in place; Pause / Resume', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/team`);
  await world.setTeam(page, true);
  await removeAllMembers(page);
  const session = await world.startSession(page, 'env-asker', 'Reply with just OK.');
  await world.settle(page, session.id);
  await world.adopt(page, session.id, 'Deployer');
  await world.call(page, 'POST', `/api/sessions/${session.id}/messages`, { text: '[fake:ask-delay] Ask me.' });
  const need = page.getByTestId('team-need').filter({ hasText: 'Which environment should I target?' });
  await expect(need).toBeVisible({ timeout: 20_000 });
  await expect(need).toContainText('Deployer · question');
  await expect(card(page, 'Deployer')).toHaveAttribute('data-status', 'needs-you');
  await expect(page.getByTestId('team-counts')).toContainText('1 needs you');
  await need.getByTestId('team-need-option').filter({ hasText: 'Staging' }).click();
  await expect(need).toHaveCount(0, { timeout: 20_000 });

  await world.settle(page, session.id);
  await card(page, 'Deployer').click();
  const panel = page.getByTestId('team-panel');
  await panel.getByTestId('team-panel-pause').click();
  await expect(card(page, 'Deployer')).toHaveAttribute('data-status', 'paused');
  await expect(panel.getByTestId('team-panel-pause')).toHaveText('▶ Resume');
  await panel.getByTestId('team-panel-pause').click();
  await expect(panel.getByTestId('team-panel-pause')).toHaveText('⏸ Pause');
  await expect(card(page, 'Deployer')).not.toHaveAttribute('data-status', 'paused');
});

test('Needs you: an access request (T2); Set up… opens the member\'s Access tab at it', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/team`);
  await world.setTeam(page, true);
  await removeAllMembers(page);
  const session = await world.startSession(page, 'traffic-report', 'Reply with just OK.');
  await world.settle(page, session.id);
  const member = await world.adopt(page, session.id, 'Marketing monitoring');
  await world.settle(page, session.id);
  // The agent's side: the session's own agent token, from the MCP config Switchboard wrote for its spawn (as tests/e2e/team-access.spec.ts).
  const config = JSON.parse(await readFile(path.join(world.dataDir, 'agent-mcp', `${session.id}.json`), 'utf8')) as { mcpServers: { switchboard: { env: Record<string, string> } } };
  const asked = await fetch(`${world.baseUrl}/agent/v1/team/access`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.mcpServers.switchboard.env['SWITCHBOARD_TODO_TOKEN']}`, 'x-switchboard-session': session.id },
    body: JSON.stringify({
      kind: 'api-key',
      service: 'Acme Analytics',
      host: 'api.acme.example',
      why: 'Fetch the weekly traffic report for the summary.',
      scope: 'read-only, reports',
      fields: [{ name: 'ACME_ANALYTICS_KEY', label: 'API key', secret: true }],
    }),
  });
  expect(asked.status).toBe(201);
  const accessId = ((await asked.json()) as { access: { id: string } }).access.id;

  const need = page.locator('[data-testid="team-need"][data-kind="access"]');
  await expect(need).toBeVisible({ timeout: 20_000 });
  await expect(need).toContainText('Marketing monitoring · access');
  await expect(need.getByTestId('access-request-host')).toHaveText('api.acme.example');
  await need.getByTestId('access-request-setup').click();
  const panel = page.getByTestId('team-panel');
  await expect(panel).toHaveAttribute('data-member-id', member.id);
  await expect(panel.getByTestId('team-tab-access')).toHaveAttribute('aria-selected', 'true');
  const entry = panel.getByTestId(`access-entry-${accessId}`);
  await expect(entry).toHaveAttribute('data-status', 'requested');
  await expect(entry.getByTestId('access-form')).toBeVisible();
  await expect(entry.getByTestId('access-input-ACME_ANALYTICS_KEY')).toHaveAttribute('type', 'password');
  await page.screenshot({ path: test.info().outputPath('team-access-setup.png') });
});

async function roles(page: Page): Promise<string[]> {
  return page.getByTestId('team-cards').getByTestId('team-card-role').allTextContents();
}

test('D100 follow-up: a drag reorders the cards and survives a reload; ⋯ Move left / right and Alt+← / → move one place', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/team`);
  await world.setTeam(page, true);
  await removeAllMembers(page);
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    const session = await world.startSession(page, `order-${name.toLowerCase()}`, 'Reply with just OK.');
    await world.settle(page, session.id);
    await world.adopt(page, session.id, name);
  }
  await expect.poll(() => roles(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);

  // Mouse: Alpha dropped on Charlie's right half goes after it; the line shows while dragging.
  const box = await card(page, 'Charlie').boundingBox();
  await card(page, 'Alpha').dragTo(card(page, 'Charlie'), { targetPosition: { x: (box?.width ?? 180) - 12, y: 30 } });
  await expect.poll(() => roles(page)).toEqual(['Bravo', 'Charlie', 'Alpha']);
  // A click without moving still selects.
  await card(page, 'Bravo').click();
  await expect(page.getByTestId('team-panel')).toContainText('Bravo');
  await page.reload();
  await expect.poll(() => roles(page)).toEqual(['Bravo', 'Charlie', 'Alpha']);

  // ⋯ → Move right / Move left (disabled at the ends).
  await card(page, 'Bravo').getByTestId('team-card-menu').click();
  await expect(page.getByTestId('team-menu-order-back')).toHaveText('Move left');
  await expect(page.getByTestId('team-menu-order-back')).toBeDisabled();
  await page.getByTestId('team-menu-order-forward').click();
  await expect.poll(() => roles(page)).toEqual(['Charlie', 'Bravo', 'Alpha']);
  await card(page, 'Alpha').getByTestId('team-card-menu').click();
  await expect(page.getByTestId('team-menu-order-forward')).toBeDisabled();
  await page.getByTestId('team-menu-order-back').click();
  await expect.poll(() => roles(page)).toEqual(['Charlie', 'Alpha', 'Bravo']);

  // Keyboard: Alt+← on the focused card; focus stays on it.
  await card(page, 'Bravo').focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => roles(page)).toEqual(['Charlie', 'Bravo', 'Alpha']);
  await expect(card(page, 'Bravo')).toBeFocused();
  await page.reload();
  await expect.poll(() => roles(page)).toEqual(['Charlie', 'Bravo', 'Alpha']);
});

test('D100 follow-up: many members sit in one row that scrolls sideways; a member selected from Needs you is scrolled into view', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/team`);
  await world.setTeam(page, true);
  await removeAllMembers(page);
  const names = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  let last = '';
  for (const name of names) {
    const session = await world.startSession(page, `strip-${name.toLowerCase()}`, 'Reply with just OK.');
    await world.settle(page, session.id);
    await world.adopt(page, session.id, name);
    last = session.id;
  }
  await expect.poll(() => roles(page)).toEqual(names);
  const strip = page.getByTestId('team-cards');
  // One row: every card on the same line, at its own width (not shrunk), and the row is wider than the page.
  const boxes = await page.getByTestId('team-card').evaluateAll((cards) => cards.map((c) => c.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), width: Math.round(r.width) })));
  expect(new Set(boxes.map((b) => b.top)).size).toBe(1);
  for (const b of boxes) expect(b.width).toBeGreaterThanOrEqual(180);
  expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect(page.locator('.sb-team-strip-frame')).toHaveAttribute('data-fade-right', 'true');
  await expect(card(page, 'Nine')).not.toBeInViewport();
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(pageOverflow).toBeLessThanOrEqual(0);

  // Nine asks a question; Reply… in Needs you selects it and the strip brings its card into view.
  await world.call(page, 'POST', `/api/sessions/${last}/messages`, { text: '[fake:ask-delay] Ask me.' });
  const need = page.locator('[data-testid="team-need"][data-kind="questions"]');
  await expect(need).toBeVisible({ timeout: 20_000 });
  await need.getByRole('button', { name: 'Reply…' }).click();
  await expect(page.getByTestId('team-panel')).toContainText('Nine');
  await expect(card(page, 'Nine')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.sb-team-strip-frame')).toHaveAttribute('data-fade-left', 'true');
  await expect(page.locator('.sb-team-strip-frame')).not.toHaveAttribute('data-fade-right', /.*/);
  await page.screenshot({ path: test.info().outputPath('team-strip-scrolled.png') });
});

test('phone: cards in a list with Needs you first; the member opens full screen with ‹ Team', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${world.baseUrl}/team`);
  await world.setTeam(page, true);
  await removeAllMembers(page);
  const quiet = await world.startSession(page, 'quiet-one', 'Reply with just OK.');
  const asker = await world.startSession(page, 'asker-one', 'Reply with just OK.');
  await world.settle(page, quiet.id);
  await world.settle(page, asker.id);
  await world.adopt(page, quiet.id, 'Quiet');
  await world.adopt(page, asker.id, 'Asker');
  await world.call(page, 'POST', `/api/sessions/${asker.id}/messages`, { text: '[fake:ask-delay] Ask me.' });
  // (Both may also get a review card for the repo's changes; the question is Asker's.)
  await expect(page.locator('[data-testid="team-need"][data-kind="questions"]')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId('view-team')).toHaveAttribute('data-pane', 'list');
  // Needs you comes first, then the cards in the team's order (D100 follow-up 2026-10-14: reorderable on the phone too).
  const order = await page.getByTestId('team-body').evaluate((body) => [...body.children].map((child) => child.getAttribute('data-testid')));
  expect(order).toEqual(['team-needs-you', 'team-cards', 'team-activity']);
  await expect(page.getByTestId('team-card').first()).toHaveAttribute('data-member-id', /.+/);
  await expect.poll(() => roles(page)).toEqual(['Quiet', 'Asker']);
  // ⋯ → Move up puts Asker first.
  await card(page, 'Asker').getByTestId('team-card-menu').click();
  await expect(page.getByTestId('team-menu-order-forward')).toHaveText('Move down');
  await page.getByTestId('team-menu-order-back').click();
  await expect.poll(() => roles(page)).toEqual(['Asker', 'Quiet']);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // (The question's own toast would sit over the page's top.)
  while (await page.getByTestId('toast').isVisible()) await page.getByTestId('toast').getByRole('button', { name: 'Close' }).click();
  await card(page, 'Quiet').click();
  await expect(page.getByTestId('view-team')).toHaveAttribute('data-pane', 'detail');
  await expect(page.getByTestId('team-panel')).toBeVisible();
  await expect(page.getByTestId('team-cards')).toHaveCount(0);
  await page.getByTestId('team-back').click();
  await expect(page.getByTestId('view-team')).toHaveAttribute('data-pane', 'list');
  await expect(page.getByTestId('team-cards')).toBeVisible();
});
