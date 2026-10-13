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
  // The first team has no Delete team….
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
