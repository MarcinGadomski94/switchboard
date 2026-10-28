import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.0 (2.4.4) · compact teammate cards and pinned crews, on the real path (fake
 * claude; `SWITCHBOARD_TEST_SECRET_STORE=memory`): the crew page's cards are compact, four to a
 * row at 1440 px, with the long job description in a three-line scrollable box (keyboard
 * focus, a fade while more is below); ⋯ › Pin to sidebar puts the crew in the rail's Pinned
 * list, collapsed; its chevron shows the teammates (remembered per browser), a teammate row
 * opens its agent, an archived teammate is left out ("1 archived"), Unpin from the Crews
 * list takes it out; the phone (390 × 844) keeps its rows and scrolls the job description.
 */

let world: TeamWorld;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-v2-crews-pin', { plain: true, env: { ...V2_SERVER_ENV, SWITCHBOARD_TEST_SECRET_STORE: 'memory' } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

const LONG_OWNS =
  'Every change request in acme-app from the moment it opens: reads the diff and the linked ticket, checks the migration notes, runs the unit and the end-to-end suites, compares the screenshots against the design, and keeps a running list of what still blocks the merge.';
const LONG_PRODUCES =
  'A short verdict per change request (approve, approve with nits, or send back), a test plan for anything risky, a list of follow-up tickets for what it found outside the change, and a weekly digest of flaky tests with the commits that introduced them.';

async function member(page: Page, name: string, charter: Record<string, string>): Promise<{ id: string; sessionId: string }> {
  const session = await world.startSession(page, `${name.toLowerCase()}-run`, 'Reply with just OK.');
  await world.settle(page, session.id);
  const adopted = await world.adopt(page, session.id, name, { charter });
  return { id: adopted.id, sessionId: session.id };
}

const pinnedIds = async (page: Page): Promise<string[]> => ((await world.call(page, 'GET', '/api/sidebar')).body as { pinned: string[] }).pinned;

let reviewer = { id: '', sessionId: '' };
let builder = { id: '', sessionId: '' };

test('compact teammate cards: four to a row, the long job description scrolls in a short box', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/crews`);
  reviewer = await member(page, 'Reviewer', { owns: LONG_OWNS, produces: LONG_PRODUCES, neverDoes: 'Merges or deploys.' });
  builder = await member(page, 'Builder', { owns: 'The build pipeline.', produces: 'Green builds.', neverDoes: 'Edits tests.' });
  await member(page, 'Writer', { owns: 'The docs.', produces: 'Release notes.', neverDoes: 'Ships code.' });
  await member(page, 'Planner', { owns: 'The roadmap.', produces: 'Plans.', neverDoes: 'Codes.' });
  await page.goto(`${world.baseUrl}/crews/team`);
  const cards = page.getByTestId('v2-teammate');
  await expect(cards).toHaveCount(4);

  // Four to a row at 1440 px, and each card stays compact even with the long text.
  const boxes = await Promise.all([0, 1, 2, 3].map(async (index) => cards.nth(index).boundingBox()));
  const tops = new Set(boxes.map((box) => Math.round(box?.y ?? -1)));
  expect(tops.size, JSON.stringify(boxes)).toBe(1);
  for (const box of boxes) expect(box?.height ?? 0).toBeLessThan(320);

  // The long one scrolls: a focusable labelled region, three lines tall, faded at the bottom.
  const long = page.locator(`[data-testid="v2-teammate"][data-member="${reviewer.id}"]`);
  const region = long.getByRole('region', { name: 'Job description of Reviewer' });
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute('tabindex', '0');
  await expect(region).toContainText('weekly digest of flaky tests');
  const size = await region.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  expect(size.client).toBeLessThan(70);
  expect(size.scroll).toBeGreaterThan(size.client);
  const wrap = long.locator('.v2-c-scrollwrap');
  await expect(wrap).toHaveAttribute('data-overflow');
  await expect(wrap).not.toHaveAttribute('data-end');
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join('test-results', 'v2-crews-compact-1440-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join('test-results', 'v2-crews-compact-1440-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  // Each card's buttons stay on one row.
  const foot = await long.locator('.v2-c-mate-foot').boundingBox();
  expect(foot?.height ?? 0).toBeLessThan(44);

  // The keyboard scrolls it to the end; the fade goes.
  await region.focus();
  await page.keyboard.press('End');
  await expect.poll(() => region.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(wrap).toHaveAttribute('data-end');
  // A short one fits: no scroll box to tab into.
  const short = page.locator(`[data-testid="v2-teammate"][data-member="${builder.id}"]`).getByTestId('v2-teammate-jd');
  await expect(short).toHaveText('The build pipeline. Green builds.');
  await expect(short).not.toHaveAttribute('tabindex', '0');

  // Every action the card had is still there.
  await expect(long.getByTestId('v2-teammate-menu')).toBeVisible();
  await expect(long.getByTestId('v2-teammate-budget-edit')).toBeVisible();
  await expect(long.getByTestId('v2-teammate-access')).toBeVisible();
  await expect(long.getByTestId('v2-teammate-details')).toBeVisible();

});

test('pin a crew from its ⋯ menu: in the rail, expand to its teammates, open one, unpin', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${world.baseUrl}/crews/team`);
  const rail = page.getByTestId('v2-rail-pins');
  await expect(rail).toContainText('Pin agents or crews from their ⋯ menu.');

  await page.getByTestId('v2-crew-menu').click();
  await page.getByRole('menuitem', { name: 'Pin to sidebar' }).click();
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Pinned “Team” to the sidebar.' })).toBeVisible();
  await expect.poll(() => pinnedIds(page)).toEqual(['crew~team']);

  // In the rail, collapsed by default.
  const pinned = rail.locator('[data-testid="v2-pin-crew"][data-crew="team"]');
  await expect(pinned).toBeVisible();
  await expect(rail).not.toContainText('Pin agents or crews');
  const toggle = pinned.getByTestId('v2-pin-crew-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAccessibleName('Show the teammates of Team');
  await expect(pinned.getByTestId('v2-pin-mate')).toHaveCount(0);

  // The keyboard: → opens, ← closes; a click opens.
  await toggle.focus();
  await page.keyboard.press('ArrowRight');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const mates = pinned.getByTestId('v2-pin-mate');
  await expect(mates.locator('.v2-pin-name')).toHaveText(['Reviewer', 'Builder', 'Writer', 'Planner']);

  await page.mouse.move(0, 0);
  await toggle.blur();
  await page.waitForTimeout(300); // the chevron's turn
  await page.getByTestId('v2-rail').screenshot({ path: path.join('test-results', 'v2-crews-rail-expanded.png') });

  // Remembered per browser across a reload.
  await page.reload();
  await expect(rail.locator('[data-testid="v2-pin-crew"][data-crew="team"]').getByTestId('v2-pin-crew-toggle')).toHaveAttribute('aria-expanded', 'true');

  // A teammate row opens its agent; the crew row opens the crew page.
  await mates.filter({ hasText: 'Builder' }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${builder.sessionId}$`));
  await pinned.getByTestId('v2-pin-crew-link').click();
  await expect(page).toHaveURL(/\/crews\/team$/);
  await expect(pinned.getByTestId('v2-pin-crew-link')).toHaveAttribute('aria-current', 'page');

  // An archived teammate leaves the list: "1 archived".
  const closed = await world.call(page, 'POST', `/api/sessions/${builder.sessionId}/close`, { confirm: true });
  expect(closed.status, JSON.stringify(closed.body)).toBeLessThan(300);
  await expect(mates.locator('.v2-pin-name')).toHaveText(['Reviewer', 'Writer', 'Planner'], { timeout: 20_000 });
  await expect(pinned.getByTestId('v2-pin-crew-archived')).toHaveText('1 archived');

  // Collapsed is remembered too.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(rail.locator('[data-testid="v2-pin-crew"][data-crew="team"]').getByTestId('v2-pin-crew-toggle')).toHaveAttribute('aria-expanded', 'false');

  // Unpin from the Crews list's ⋯.
  await page.goto(`${world.baseUrl}/crews`);
  const card = page.locator('[data-testid="v2-crew-card"][data-crew="team"]');
  await card.getByTestId('v2-crew-menu').click();
  await page.getByRole('menuitem', { name: 'Unpin from sidebar' }).click();
  await expect(rail.locator('[data-testid="v2-pin-crew"]')).toHaveCount(0);
  await expect.poll(() => pinnedIds(page)).toEqual([]);
  await expect(rail).toContainText('Pin agents or crews from their ⋯ menu.');
  // Undo pins it again, where it was.
  await page.getByTestId('v2-toast').filter({ hasText: 'Unpinned “Team”.' }).getByTestId('v2-toast-undo').click();
  await expect.poll(() => pinnedIds(page)).toEqual(['crew~team']);
  await expect(rail.locator('[data-testid="v2-pin-crew"][data-crew="team"]')).toBeVisible();
});

test('phone 390 × 844: teammate rows, the job description scrolls, Pin to sidebar in ⋯', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/crews/team`);
  await expect(page.getByTestId('v2-rail')).toHaveCount(0);
  const row = page.locator(`[data-testid="v2-teammate-row"][data-member="${reviewer.id}"]`);
  await expect(row).toBeVisible();
  expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  // The crew's ⋯ offers Unpin (pinned in the last test: the layout is the computer's).
  await page.getByTestId('v2-crew-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Unpin from sidebar' })).toBeVisible();
  await page.keyboard.press('Escape');

  await row.click();
  const region = page.getByRole('region', { name: 'Job description of Reviewer' });
  await expect(region).toBeVisible();
  const size = await region.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  expect(size.client).toBeLessThan(110);
  expect(size.scroll).toBeGreaterThan(size.client);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join('test-results', 'v2-crews-phone-390.png') });
});
