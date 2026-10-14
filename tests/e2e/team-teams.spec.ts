import { type Page, expect, test } from '@playwright/test';
import { openWithHub } from './question-world.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';

/**
 * D100 follow-up 2026-10-14 · multiple teams on the Team page, on the real code path
 * with fake-claude (`docs/team.md` → *The Team page* → *Teams*): ＋ New team opens it
 * at `/team/{id}`, the sidebar lists one entry per team, the Adopt form's Team picker
 * defaults to the shown team, ⋯ Move to team ▸, Needs you per team and on the All
 * teams tab (Reply… opens the member in its team), reordering the tabs, `/team`
 * opening the last-used team, and Delete team returning its members to the list.
 */

let world: TeamWorld;

test.beforeAll(async () => {
  // A plain world (no git repo): no review cards, only the Needs-you items the test makes.
  world = await startTeamWorld('e2e-team-teams', { plain: true });
});

test.afterAll(async () => {
  await world?.stop();
});

test.describe.configure({ mode: 'serial' });

function card(page: Page, role: string) {
  return page.getByTestId('team-card').filter({ has: page.getByTestId('team-card-role').getByText(role, { exact: true }) });
}

function tab(page: Page, name: string) {
  return page.getByTestId('team-tab-team').filter({ has: page.locator('.sb-team-teamtab__name').getByText(name, { exact: true }) });
}

function entry(page: Page, name: string) {
  return page.getByTestId('sidebar-team').filter({ has: page.locator('.sb-team-entry__text').getByText(new RegExp(`^${name} · `)) });
}

/** The page's own toasts sit over the header's top right; close them before clicking there. */
async function closeToasts(page: Page): Promise<void> {
  while (await page.getByTestId('toast').first().isVisible()) await page.getByTestId('toast').first().getByRole('button', { name: 'Close' }).click();
}

async function sidebarTeams(page: Page): Promise<string[]> {
  return page.getByTestId('sidebar-team').locator('.sb-team-entry__text').allTextContents();
}

test('teams: ＋ New team, one sidebar entry per team, the Adopt form\'s Team picker, ⋯ Move to team ▸, Needs you per team and All teams, reorder, /team, Delete team', async ({ page }) => {
  test.setTimeout(120_000);
  await openWithHub(page, `${world.baseUrl}/team`);
  await world.setTeam(page, true);
  const quiet = await world.startSession(page, 'teams-quiet', 'Reply with just OK.');
  const asker = await world.startSession(page, 'teams-asker', 'Reply with just OK.');
  for (const s of [quiet, asker]) await world.settle(page, s.id);
  await world.adopt(page, quiet.id, 'Developer');
  await page.goto(`${world.baseUrl}/team`);
  await expect(page).toHaveURL(/\/team\/team$/);
  await expect(page.getByTestId('team-tab-team')).toHaveCount(2); // Team + All teams
  await expect.poll(() => sidebarTeams(page)).toEqual(['Team · 1 member']);

  // ＋ New team: it opens, empty, at /team/{id}; the sidebar gets its entry.
  await page.getByTestId('team-new').click();
  await page.getByTestId('team-new-name').fill('Growth');
  await page.getByTestId('team-new-create').click();
  await expect(page).toHaveURL(/\/team\/[0-9a-f-]{36}$/);
  const growthId = (/\/team\/([^/]+)$/.exec(page.url()) as RegExpExecArray)[1] as string;
  await expect(page.getByTestId('team-title')).toHaveText('Team · Growth');
  await expect(page.getByTestId('team-empty')).toBeVisible();
  await expect(tab(page, 'Growth')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => sidebarTeams(page)).toEqual(['Team · 1 member', 'Growth · 0 members']);
  await expect(entry(page, 'Growth')).toHaveAttribute('aria-current', 'page');

  // ＋ Member → Adopt: the form's Team picker defaults to the shown team.
  await closeToasts(page);
  await page.getByTestId('team-add').click();
  await page.getByTestId('team-add-adopt').click();
  await page.locator(`[data-testid="team-session-pick"][data-session-id="${asker.id}"]`).click();
  await expect(page.getByTestId('team-form-team')).toHaveValue(growthId);
  await page.getByTestId('team-form-name').fill('Asker');
  await page.getByTestId('team-form-submit').click();
  await expect(card(page, 'Asker')).toBeVisible();
  await expect.poll(() => sidebarTeams(page)).toEqual(['Team · 1 member', 'Growth · 1 member']);

  // Needs you per team: Asker's question shows on Growth (tab and sidebar counts), not on Team.
  await world.call(page, 'POST', `/api/sessions/${asker.id}/messages`, { text: '[fake:ask-delay] Ask me.' });
  await expect(page.locator('[data-testid="team-need"][data-kind="questions"]')).toHaveCount(1, { timeout: 20_000 });
  await expect(tab(page, 'Growth').getByTestId('team-tab-need')).toHaveText('1');
  await expect(entry(page, 'Growth').getByTestId('sidebar-team-need')).toHaveText('1');
  await expect(entry(page, 'Team').getByTestId('sidebar-team-need')).toHaveCount(0);
  await tab(page, 'Team').click();
  await expect(page).toHaveURL(/\/team\/team$/);
  await expect(card(page, 'Developer')).toBeVisible();
  await expect(page.locator('[data-testid="team-need"][data-kind="questions"]')).toHaveCount(0);

  // All teams: every team's items, labelled with the team; Reply… opens the member in its team.
  await tab(page, 'All teams').click();
  await expect(page).toHaveURL(/\/team\/all$/);
  const need = page.locator('[data-testid="team-need"][data-kind="questions"]');
  await expect(need).toHaveCount(1);
  await expect(need.getByTestId('team-need-team')).toHaveText('Growth ·');
  await closeToasts(page);
  await need.getByRole('button', { name: 'Reply…' }).click();
  await expect(page).toHaveURL(new RegExp(`/team/${growthId}$`));
  await expect(page.getByTestId('team-panel')).toContainText('Asker');
  await expect(page.getByTestId('team-panel')).toHaveAttribute('data-member-id', /.+/);

  // ⋯ Move to team ▸ Team: Asker leaves Growth and shows in Team (its question with it).
  await closeToasts(page);
  await card(page, 'Asker').getByTestId('team-card-menu').click();
  await page.locator('[data-testid="team-menu-team"][data-team-id="team"]').click();
  await expect(card(page, 'Asker')).toHaveCount(0);
  await expect.poll(() => sidebarTeams(page)).toEqual(['Team · 2 members', 'Growth · 0 members']);
  await entry(page, 'Team').click();
  await expect(page).toHaveURL(/\/team\/team$/);
  await expect(card(page, 'Asker')).toBeVisible();
  await expect(page.locator('[data-testid="team-need"][data-kind="questions"]')).toHaveCount(1);

  // Reorder the teams: drag Growth before Team; the sidebar follows.
  const first = await tab(page, 'Team').boundingBox();
  await tab(page, 'Growth').dragTo(tab(page, 'Team'), { targetPosition: { x: 4, y: (first?.height ?? 30) / 2 } });
  await expect.poll(() => sidebarTeams(page)).toEqual(['Growth · 0 members', 'Team · 2 members']);

  // /team opens the last-used team.
  await tab(page, 'Growth').click();
  await expect(page).toHaveURL(new RegExp(`/team/${growthId}$`));
  await page.goto(`${world.baseUrl}/team`);
  await expect(page).toHaveURL(new RegExp(`/team/${growthId}$`));

  // Delete team: asks first; Asker (moved back to Growth) returns to the session list, never deleted.
  const asked = await world.call(page, 'POST', `/api/team/members/${(await world.call(page, 'GET', '/api/team')).body.members.find((m: { name: string }) => m.name === 'Asker').id}/team`, { teamId: growthId });
  expect(asked.status).toBe(200);
  await expect(card(page, 'Asker')).toBeVisible();
  await expect(page.getByTestId('sidebar-sessions').locator(`a.sb-session[data-session-id="${asker.id}"]`)).toHaveCount(0);
  await closeToasts(page);
  await page.getByTestId('team-delete').click();
  await expect(page.getByTestId('team-delete-note')).toContainText('back to your session list');
  await page.getByTestId('team-delete-confirm').click();
  await expect(page).toHaveURL(/\/team\/team$/);
  await expect.poll(() => sidebarTeams(page)).toEqual(['Team · 1 member']);
  await expect(page.getByTestId('sidebar-sessions').locator(`a.sb-session[data-session-id="${asker.id}"]`)).toBeVisible();
  // The last team has no Delete team….
  await expect(page.getByTestId('team-delete')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('team-teams.png') });
});

test('old routes keep working for the first team; a second team shows in the switcher on the phone', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/team`);
  await world.setTeam(page, true);
  const view = await world.call(page, 'GET', '/api/team');
  expect(view.status).toBe(200);
  expect(view.body.team.id).toBe('team');
  const ops = await world.call(page, 'POST', '/api/team/teams', { name: 'Ops' });
  expect(ops.status).toBe(201);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/team/${ops.body.id}`);
  await expect(page.getByTestId('team-title')).toHaveText('Team · Ops');
  await expect(tab(page, 'Ops')).toHaveAttribute('aria-selected', 'true');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath('team-teams-phone.png') });
  expect((await world.call(page, 'DELETE', `/api/team/teams/${ops.body.id}`)).status).toBe(200);
});

test('the first team is deletable once another exists: its member returns, the page and the old routes go to the first remaining team', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/team`);
  await world.setTeam(page, true);
  const lone = await world.startSession(page, 'teams-lone', 'Reply with just OK.');
  await world.settle(page, lone.id);
  await world.adopt(page, lone.id, 'Lone');
  const ops = await world.call(page, 'POST', '/api/team/teams', { name: 'Ops' });
  expect(ops.status).toBe(201);
  await page.goto(`${world.baseUrl}/team/team`);
  await expect(page.getByTestId('team-card').filter({ hasText: 'Lone' })).toBeVisible();
  await closeToasts(page);
  await page.getByTestId('team-delete').click();
  await page.getByTestId('team-delete-confirm').click();
  await expect(page).toHaveURL(new RegExp(`/team/${ops.body.id}$`));
  await expect.poll(() => sidebarTeams(page)).toEqual(['Ops · 0 members']);
  await expect(page.getByTestId('sidebar-sessions').locator(`a.sb-session[data-session-id="${lone.id}"]`)).toBeVisible();
  expect((await world.call(page, 'GET', '/api/team')).body.team.id).toBe(ops.body.id);
  await page.goto(`${world.baseUrl}/team`);
  await expect(page).toHaveURL(new RegExp(`/team/${ops.body.id}$`));
  await expect(page.getByTestId('team-delete')).toHaveCount(0);
});

test('drag to move between teams (D100 follow-up 2026-10-14): a card dropped on another team\'s tab moves there, Undo puts it back in its place; Settings → Team moves it; ⋯ by keyboard', async ({ page }) => {
  test.setTimeout(120_000);
  await openWithHub(page, `${world.baseUrl}/team`);
  await world.setTeam(page, true);
  const home = (await world.call(page, 'GET', '/api/team/teams')).body[0] as { id: string; name: string };
  const growth = await world.call(page, 'POST', '/api/team/teams', { name: 'Growth' });
  expect(growth.status).toBe(201);
  for (const role of ['Alpha', 'Bravo', 'Charlie']) {
    const s = await world.startSession(page, `drag-${role.toLowerCase()}`, 'Reply with just OK.');
    await world.settle(page, s.id);
    await world.adopt(page, s.id, role, { teamId: home.id });
  }
  await page.goto(`${world.baseUrl}/team/${home.id}`);
  const roles = () => page.getByTestId('team-card-role').allTextContents();
  await expect.poll(roles).toEqual(['Alpha', 'Bravo', 'Charlie']);
  await closeToasts(page);

  // While Bravo's card is held, Growth's tab is a drop target; its own team's tab and All teams are not.
  const box = async (name: string) => (await tab(page, name).boundingBox()) as { x: number; y: number; width: number; height: number };
  const from = (await card(page, 'Bravo').boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  const to = await box('Growth');
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + 30, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await expect(tab(page, 'Growth')).toHaveAttribute('data-member-drop', '');
  await page.mouse.move(to.x + to.width / 2 + 2, to.y + to.height / 2, { steps: 2 });
  await expect(tab(page, 'Growth')).toHaveAttribute('data-drop-over', '');
  await expect(tab(page, home.name)).not.toHaveAttribute('data-member-drop', '');
  await expect(tab(page, 'All teams')).not.toHaveAttribute('data-member-drop', '');
  await page.mouse.up();

  // Moved: the toast says so, the card left this team and shows in Growth.
  await expect(page.getByTestId('toast')).toContainText('Moved Bravo to Growth');
  await expect.poll(roles).toEqual(['Alpha', 'Charlie']);
  await expect(page.locator('[data-member-drop]')).toHaveCount(0);
  expect(((await world.call(page, 'GET', `/api/team?teamId=${growth.body.id}`)).body.members as Array<{ name: string }>).map((m) => m.name)).toEqual(['Bravo']);

  // Undo: back in its old team, in its old place.
  await page.getByTestId('toast-action').click();
  await expect.poll(roles).toEqual(['Alpha', 'Bravo', 'Charlie']);
  expect((await world.call(page, 'GET', `/api/team?teamId=${growth.body.id}`)).body.members).toEqual([]);

  // A drop on the strip still reorders (Charlie before Alpha).
  const alpha = (await card(page, 'Alpha').boundingBox()) as { x: number; y: number; width: number; height: number };
  await card(page, 'Charlie').dragTo(card(page, 'Alpha'), { targetPosition: { x: 4, y: alpha.height / 2 } });
  await expect.poll(roles).toEqual(['Charlie', 'Alpha', 'Bravo']);

  // Settings → Team: shows the current team; another pick moves it (same toast, with Undo).
  await card(page, 'Alpha').click();
  await page.getByTestId('team-tab-settings').click();
  await expect(page.getByTestId('team-settings-team')).toHaveValue(home.id);
  await page.getByTestId('team-settings-team').selectOption(growth.body.id);
  await expect(page.getByTestId('toast')).toContainText('Moved Alpha to Growth');
  await expect.poll(roles).toEqual(['Charlie', 'Bravo']);
  await tab(page, 'Growth').click();
  await expect.poll(roles).toEqual(['Alpha']);

  // Touch: a long press lifts Alpha's card; the finger over the home team's tab lights it up, releasing there moves it.
  await closeToasts(page);
  const fromTouch = (await card(page, 'Alpha').boundingBox()) as { x: number; y: number; width: number; height: number };
  const homeTab = await box(home.name);
  const lit = await page.evaluate(
    async ({ start, end }) => {
      const fire = (type: string, at: { x: number; y: number }): void => {
        const target = document.elementFromPoint(at.x, at.y) ?? document.body;
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: at.x, clientY: at.y }));
      };
      const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
      fire('pointerdown', start);
      await wait(550);
      for (let i = 1; i <= 10; i += 1) {
        fire('pointermove', { x: start.x + ((end.x - start.x) * i) / 10, y: start.y + ((end.y - start.y) * i) / 10 });
        await wait(20);
      }
      await wait(50);
      const over = document.querySelector('[data-drop-over]')?.getAttribute('data-team-id') ?? null;
      fire('pointerup', end);
      return over;
    },
    { start: { x: fromTouch.x + fromTouch.width / 2, y: fromTouch.y + 20 }, end: { x: homeTab.x + homeTab.width / 2, y: homeTab.y + homeTab.height / 2 } },
  );
  expect(lit).toBe(home.id);
  await expect(page.getByTestId('toast')).toContainText(`Moved Alpha to ${home.name}`);
  await expect.poll(roles).toEqual([]);

  // Keyboard: ⋯ opens with the focus on its first entry; the team entries name the teams.
  await tab(page, home.name).click();
  await expect.poll(roles).toEqual(['Charlie', 'Bravo', 'Alpha']);
  await closeToasts(page);
  await card(page, 'Alpha').getByTestId('team-card-menu').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('team-member-menu')).toBeVisible();
  await expect(page.locator('[role="menuitem"]:focus')).toHaveCount(1);
  const toGrowth = page.locator(`[data-testid="team-menu-team"][data-team-id="${growth.body.id}"]`);
  await expect(toGrowth).toHaveText('Move to team ▸ Growth');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await expect(toGrowth).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('toast')).toContainText('Moved Alpha to Growth');
  await expect.poll(roles).toEqual(['Charlie', 'Bravo']);
  await page.screenshot({ path: test.info().outputPath('team-teams-drag.png') });
  expect((await world.call(page, 'DELETE', `/api/team/teams/${growth.body.id}`)).status).toBe(200);
});
