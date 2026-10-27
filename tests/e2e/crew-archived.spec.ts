import { type Page, expect, test } from '@playwright/test';
import { THEME_STORAGE_KEY } from '../../src/web/theme.ts';
import { stubToolProbes } from './probes.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * 2026-10-27 (D137 follow-up, the developer chose B) · archiving a teammate's chat hides it
 * from its crew, never removes it: on the real path (fake claude, `SWITCHBOARD_TEST_SECRET_STORE=memory`),
 * a teammate archived from its own chat leaves the v2 crew page (live) and the Crews list's
 * counts, the crew says "1 archived teammate · Show in Archived" (the link opens Archived, which
 * lists it under its teammate's name), and Restore brings it back into the crew with its role.
 * The same on the phone (390 × 844) and on the classic Team page (History restores it there).
 */

let world: TeamWorld;
let developer = { id: '', sessionId: '' };
let builder = { id: '', sessionId: '' };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-crew-archived', { plain: true, env: { ...V2_SERVER_ENV, SWITCHBOARD_TEST_SECRET_STORE: 'memory' } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function member(page: Page, name: string, charter: Record<string, string>): Promise<{ id: string; sessionId: string }> {
  const session = await world.startSession(page, `${name.toLowerCase()}-run`, 'Reply with just OK.');
  await world.settle(page, session.id);
  const adopted = await world.adopt(page, session.id, name, { charter });
  return { id: adopted.id, sessionId: session.id };
}

const memberArchived = async (page: Page, id: string): Promise<boolean | undefined> => ((await world.call(page, 'GET', `/api/team/members/${id}`)).body as { archived?: boolean }).archived;

test('v2: archived from its chat, a teammate leaves its crew (live) and the Crews counts; Archived restores it with its role', async ({ page, context }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/crews`);
  developer = await member(page, 'Developer', { owns: 'the checkout code', produces: 'changes with tests', neverDoes: 'releases' });
  builder = await member(page, 'Builder', { owns: 'the build pipeline', produces: 'green builds', neverDoes: 'merges' });

  // The crew page stays open in its own tab: it follows the archive live.
  const crewPage = await context.newPage();
  await stubToolProbes(crewPage);
  await crewPage.goto(`${world.baseUrl}/crews/team`);
  const mates = crewPage.getByTestId('v2-teammate');
  await expect(mates.locator('h3')).toHaveText(['Developer', 'Builder']);
  await expect(crewPage.getByTestId('v2-crew-archived')).toHaveCount(0);

  // Archive Builder from its own chat (⋯ › Archive agent; it is live, so it asks first).
  await page.goto(`${world.baseUrl}/agents/${encodeURIComponent(builder.sessionId)}`);
  await page.getByTestId('v2-agent-menu').click();
  await page.getByRole('menuitem', { name: 'Archive agent' }).click();
  await page.getByTestId('v2-agent-close-confirm-yes').click();
  await expect.poll(() => memberArchived(page, builder.id)).toBe(true);

  // Live: it leaves the crew page; the quiet line says where it is.
  await expect(mates.locator('h3')).toHaveText(['Developer']);
  await expect(crewPage.locator('.v2-c-crew-sub')).toContainText('1 teammate · 0 working');
  await expect(crewPage.getByTestId('v2-crew-archived')).toHaveText('1 archived teammate · Show in Archived');
  await crewPage.close();

  // The Crews list counts only the shown teammates, and its card has the same line.
  await page.goto(`${world.baseUrl}/crews`);
  const card = page.getByTestId('v2-crew-card').filter({ hasText: 'Team' });
  await expect(card).toContainText('1st in your order · 1 teammate');
  await expect(card.locator('.v2-c-avs > span')).toHaveCount(1);
  await expect(card.getByTestId('v2-crew-archived')).toHaveText('1 archived teammate · Show in Archived');

  // The link opens Archived (not the crew), which lists it under its teammate's name, kept for its crew.
  await card.getByTestId('v2-crew-archived-link').click();
  await expect(page).toHaveURL(/\/agents\?show=closed$/);
  const row = page.locator(`[data-testid="v2-closed-row"][data-session="${builder.sessionId}"]`);
  await expect(row.locator('.v2-ttl')).toHaveText('Builder');
  await expect(row.getByTestId('v2-closed-countdown')).toHaveText(' · Kept: a teammate in a crew');
  await row.getByTestId('v2-closed-reopen').click();
  await expect(row).toHaveCount(0);
  await expect.poll(() => memberArchived(page, builder.id)).toBe(false);

  // Back in its crew, with its role and job description.
  await page.goto(`${world.baseUrl}/crews/team`);
  await expect(page.getByTestId('v2-teammate').locator('h3')).toHaveText(['Developer', 'Builder']);
  await expect(page.locator(`[data-testid="v2-teammate"][data-member="${builder.id}"]`).getByTestId('v2-teammate-jd')).toHaveText('the build pipeline green builds');
  await expect(page.getByTestId('v2-crew-archived')).toHaveCount(0);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('v2 at 390 × 844: the archived teammate leaves the crew list; a crew with every teammate archived still shows, with the line', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`${world.baseUrl}/crews/team`);
    await world.call(page, 'POST', `/api/sessions/${encodeURIComponent(builder.sessionId)}/close`, { confirm: true });
    await world.call(page, 'POST', `/api/sessions/${encodeURIComponent(developer.sessionId)}/close`, { confirm: true });
    await expect.poll(() => memberArchived(page, developer.id)).toBe(true);
    await page.reload();
    await expect(page.getByTestId('v2-teammate-row')).toHaveCount(0);
    await expect(page.getByTestId('v2-crew-empty')).toContainText('Every teammate of this crew is archived.');
    await expect(page.getByTestId('v2-crew-archived')).toHaveText('2 archived teammates · Show in Archived');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    // The link is a full-size touch target.
    const box = await page.getByTestId('v2-crew-archived-link').boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    await page.goto(`${world.baseUrl}/crews`);
    const row = page.getByTestId('v2-crew-row').filter({ hasText: 'Team' });
    await expect(row).toContainText('0 teammates · 0 working · 2 archived teammates');

    // Restore one from Archived on the phone: back in the crew's list.
    await page.goto(`${world.baseUrl}/agents?show=closed`);
    await page.locator(`[data-testid="v2-closed-row"][data-session="${developer.sessionId}"]`).getByTestId('v2-closed-reopen').click();
    await expect.poll(() => memberArchived(page, developer.id)).toBe(false);
    await page.goto(`${world.baseUrl}/crews/team`);
    await expect(page.getByTestId('v2-teammate-row')).toHaveText([/Developer/]);
    await expect(page.getByTestId('v2-crew-archived')).toHaveText('1 archived teammate · Show in Archived');
  });
});

test('classic: the Team page and the sidebar hide the archived member; History restores it with its role', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript((key: string) => window.localStorage.setItem(key, 'classic'), THEME_STORAGE_KEY);
  await page.goto(`${world.baseUrl}/team/team`);
  // Builder is still archived from the phone test.
  await expect(page.getByTestId('team-card').getByTestId('team-card-role')).toHaveText(['Developer']);
  await expect(page.getByTestId('team-counts')).toHaveText('1 member · 0 working · 0 need you');
  await expect(page.getByTestId('team-archived')).toHaveText('1 archived member · Show in History');
  await expect(page.getByTestId('sidebar-team')).toContainText('Team · 1 member');
  await expect(page.getByTestId('sidebar-team-member')).toHaveCount(1);

  await page.getByTestId('team-archived-link').click();
  await expect(page).toHaveURL(/\/history$/);
  await page.locator(`[data-testid="history-row"][data-session-id="${builder.sessionId}"]`).getByTestId('history-reopen').click();
  await expect.poll(() => memberArchived(page, builder.id)).toBe(false);

  await page.goto(`${world.baseUrl}/team/team`);
  await expect(page.getByTestId('team-card').getByTestId('team-card-role')).toHaveText(['Developer', 'Builder']);
  await expect(page.getByTestId('team-archived')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-team-member')).toHaveCount(2);
  const back = (await world.call(page, 'GET', `/api/team/members/${builder.id}`)).body as { name: string; charter: { owns: string } };
  expect(back).toMatchObject({ name: 'Builder', charter: { owns: 'the build pipeline' } });
});
