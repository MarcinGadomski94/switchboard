import { type Page, expect, test } from '@playwright/test';
import { openWithHub } from '../question-world.ts';
import { type TeamWorld, startTeamWorld } from '../team-world.ts';
import { canonicalColors, writeReport } from './harness.ts';

/**
 * D100 · the Team page's visual check (T3). Not in the prototype: the design is the
 * developer's approved clickable mockup (`docs/team.md` → *The Team page*), so this
 * spec checks the design's rules rather than a pixel diff: the role colour of the
 * sidebar entry, each card's top border by status (working = run blue, needs you =
 * amber, idle = grey, paused / offline dimmed), the layout per size (desktop: three
 * cards across the full width at the top, then Needs you + Activity (330 px) | the
 * member panel; tablet: the same with a narrower left; phone: one column, Needs you
 * first, the member full screen with
 * "‹ Team"), the empty state, and no sideways overflow. It runs on the fake world
 * (demo mode never starts Team) and writes `team.md` plus a screenshot per state and
 * size to `test-results/visual/` (and `docs/visual/` with SWITCHBOARD_VISUAL_REPORT=1).
 *
 * Team off is covered by the existing visual specs (shell, sidebar, settings, inbox),
 * which must pass unchanged.
 */

const SIZES = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 1024, height: 768 },
  phone: { width: 390, height: 844 },
} as const;

type Size = keyof typeof SIZES;

let world: TeamWorld;
const lines: string[] = ['# Team page (D100) · visual check', '', 'The Team page is not in the prototype; its reference is the approved mockup described in `docs/team.md` → *The Team page*. Checked: role colour, status borders, layout per size, empty state, no sideways overflow.', ''];
const shots: Record<string, Buffer> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startTeamWorld('visual-team', { plain: true });
});

test.afterAll(async () => {
  await writeReport({ 'team.md': `${lines.join('\n')}\n`, ...Object.fromEntries(Object.entries(shots).map(([name, png]) => [name, png])) });
  await world?.stop();
});

async function noSidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

async function color(page: Page, selector: string, prop: string): Promise<string> {
  return page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
}

async function shoot(page: Page, name: string): Promise<void> {
  // Let the clock-driven parts (activity times) settle and the toast go.
  if (await page.getByTestId('toast').isVisible()) await page.getByTestId('toast').getByRole('button', { name: 'Close' }).click();
  shots[name] = await page.screenshot({ fullPage: false });
  lines.push(`- \`${name}\``);
}

test('empty state at desktop, tablet and phone', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await world.setTeam(page, true);
  lines.push('## Empty', '');
  for (const size of Object.keys(SIZES) as Size[]) {
    await page.setViewportSize(SIZES[size]);
    await page.goto(`${world.baseUrl}/team`);
    const empty = page.getByTestId('team-empty');
    await expect(empty).toContainText('No team members yet');
    await expect(empty.getByTestId('team-empty-review')).toHaveText('Review suggestions');
    await expect(empty.getByTestId('team-empty-add')).toHaveText('＋ Member');
    expect(await noSidewaysOverflow(page), size).toBeLessThanOrEqual(0);
    await shoot(page, `team-empty-${size}.png`);
  }
  lines.push('');
});

test('populated: cards across the top, then Needs you | panel; phone one column with Needs you first', async ({ page }) => {
  await page.setViewportSize(SIZES.desktop);
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await world.setTeam(page, true);
  const tracker = await world.startSession(page, 'board-watch', 'Reply with just OK.');
  const asker = await world.startSession(page, 'release-prep', 'Reply with just OK.');
  const builder = await world.startSession(page, 'feature-build', 'Reply with just OK.');
  const monitor = await world.startSession(page, 'prod-sweep', 'Reply with just OK.');
  for (const s of [tracker, asker, builder, monitor]) await world.settle(page, s.id);
  await world.call(page, 'PUT', `/api/sessions/${tracker.id}/title`, { title: 'PROJ-123 board' });
  // Two sessions with a pattern (edit-heavy; a loop and reading); the other two have too little signal.
  test.setTimeout(120_000);
  await world.pump(page, builder.id, 'Edit', 14);
  expect((await world.call(page, 'POST', `/api/sessions/${monitor.id}/loops`, { prompt: 'Sweep production logs.', everyMinutes: 60, label: 'Production sweep' })).status).toBe(201);
  await world.pump(page, monitor.id, 'Read', 14);

  // The review and the Adopt form, before anything is adopted.
  await page.goto(`${world.baseUrl}/team`);
  await expect(page.getByTestId('team-banner')).toContainText('Switchboard found 2 sessions that look like team members.');
  await page.getByTestId('team-banner-review').click();
  const review = page.getByTestId('team-review-dialog');
  await expect(review.getByTestId('team-suggestion')).toHaveCount(2);
  await expect(review.locator(`[data-testid="team-suggestion"][data-session-id="${builder.id}"]`)).toContainText('Developer');
  await expect(review.locator(`[data-testid="team-suggestion"][data-session-id="${monitor.id}"]`)).toContainText('On-call / Production monitoring');
  for (const quiet of [tracker, asker]) await expect(review.locator(`[data-testid="team-not-suggested-row"][data-session-id="${quiet.id}"]`)).toContainText('too little activity to tell');
  await expect(review.getByTestId('team-suggestion-draft').first()).toContainText('Draft charter · owns');
  await expect(review.locator('[data-testid="team-confidence"][data-confidence="new"]').first()).toHaveText('new member');
  expect(await color(page, '[data-testid="team-confidence"][data-confidence="new"]', 'color')).toBe((await canonicalColors(page, ['oklch(0.78 0.09 300)']))[0]);
  lines.push('## Review and Adopt', '');
  await shoot(page, 'team-review-desktop.png');
  await review.getByTestId('team-suggestion-adopt').first().click();
  await expect(page.getByTestId('team-adopt-note')).toContainText('leaves your session list and lives in Team from now on');
  await shoot(page, 'team-adopt-desktop.png');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('team-form-dialog')).toHaveCount(0);
  lines.push('');
  await world.adopt(page, tracker.id, 'Tracker', { templateId: 'delivery-tracking', budget: { dailyPct: 20, profileId: null } });
  await world.adopt(page, asker.id, 'Release manager', { templateId: 'release-manager' });
  await world.adopt(page, builder.id, 'Developer', { templateId: 'developer' });
  const paused = await world.adopt(page, monitor.id, 'On-call', { templateId: 'on-call' });
  await world.call(page, 'POST', `/api/team/members/${paused.id}/pause`);
  await world.call(page, 'POST', `/api/sessions/${asker.id}/messages`, { text: '[fake:ask-delay] Ask me.' });
  await world.call(page, 'POST', `/api/sessions/${builder.id}/messages`, { text: '[fake:hold 120] Keep going.' });

  await page.goto(`${world.baseUrl}/team`);
  await expect(page.locator('[data-testid="team-need"][data-kind="questions"]')).toHaveCount(1, { timeout: 20_000 });
  const working = page.locator('[data-testid="team-card"][data-status="working"]');
  await expect(working).toHaveCount(1, { timeout: 20_000 });

  // Role colour: the sidebar entry.
  const [roleFg, roleBg] = await canonicalColors(page, ['oklch(0.78 0.09 300)', 'oklch(0.25 0.04 300)']);
  expect(await color(page, '[data-testid="sidebar-team"]', 'color')).toBe(roleFg);
  expect(await color(page, '[data-testid="sidebar-team"]', 'background-color')).toBe(roleBg);
  lines.push('## Populated', '', `- sidebar entry: color ${roleFg}, background ${roleBg}`);

  // Status borders.
  const [run, need, idle, control] = await canonicalColors(page, ['oklch(0.72 0.12 250)', 'oklch(0.8 0.14 70)', '#5a5955', '#2c2d32']);
  expect(await color(page, '[data-testid="team-card"][data-status="working"]', 'border-top-color')).toBe(run);
  expect(await color(page, '[data-testid="team-card"][data-status="needs-you"]', 'border-top-color')).toBe(need);
  expect(await color(page, '[data-testid="team-card"][data-status="paused"]', 'border-top-color')).toBe(control);
  expect(Number(await color(page, '[data-testid="team-card"][data-status="paused"]', 'opacity'))).toBeLessThan(1);
  const idleCards = page.locator('[data-testid="team-card"][data-status="idle"]');
  if ((await idleCards.count()) > 0) expect(await color(page, '[data-testid="team-card"][data-status="idle"]', 'border-top-color')).toBe(idle);
  expect(await color(page, '[data-testid="team-card"][data-status="working"]', 'border-top-width')).toBe('3px');
  lines.push(`- card top borders: working ${run}, needs you ${need}, idle ${idle}, paused / offline ${control} dimmed`);

  // Desktop: header, banner-free (all adopted); the cards across the full width, then Needs you | panel.
  await expect(page.getByTestId('team-title')).toHaveText('Team');
  await expect(page.getByTestId('sidebar-team').locator('.sb-team-entry__text')).toHaveText('Team · 4 members');
  await expect(page.getByTestId('team-counts')).toContainText('4 members · 1 working');
  await page.locator('[data-testid="team-card"]').filter({ hasText: 'Release manager' }).click();
  await expect(page.getByTestId('team-chat').getByTestId('chat-message').first()).toBeVisible({ timeout: 20_000 });
  const geometry = async () =>
    page.evaluate(() => {
      const box = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect() ?? null;
      const split = document.querySelector('[data-testid="team-split"]') as HTMLElement;
      return { main: box('team-body'), cards: box('team-cards'), split: box('team-split'), panel: box('team-panel'), needs: box('team-needs-you'), columns: getComputedStyle(split).gridTemplateColumns.split(' ') };
    });
  const desk = await geometry();
  expect(desk.columns.length).toBe(2);
  expect(desk.columns[0]).toBe('330px');
  // The cards span the page's width above the split (the grid's own padding aside).
  expect(desk.cards!.width).toBeGreaterThan(desk.main!.width - 60);
  expect(desk.cards!.bottom).toBeLessThanOrEqual(desk.split!.top + 1);
  expect(desk.needs!.left).toBeLessThan(desk.panel!.left);
  expect(Math.round(desk.panel!.bottom)).toBe(Math.round(desk.split!.bottom));
  const cardCols = await page.getByTestId('team-cards').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(cardCols).toBeGreaterThanOrEqual(4);
  expect(await color(page, '[data-testid="team-panel-sub"]', 'color')).toBeTruthy();
  expect(await noSidewaysOverflow(page)).toBeLessThanOrEqual(0);
  lines.push(`- desktop: the cards across the full width (${cardCols} per row), then Needs you + Activity (${desk.columns[0]}) | the member panel to the bottom`);
  await shoot(page, 'team-populated-desktop.png');

  await page.setViewportSize(SIZES.tablet);
  await expect(page.getByTestId('view-team')).toHaveAttribute('data-layout', 'tablet');
  const tab = await geometry();
  expect(tab.columns.length).toBe(2);
  expect(tab.columns[0]).toBe('260px');
  expect(tab.cards!.bottom).toBeLessThanOrEqual(tab.split!.top + 1);
  expect(await noSidewaysOverflow(page)).toBeLessThanOrEqual(0);
  lines.push(`- tablet: the cards wrap across the top, then Needs you + Activity (${tab.columns[0]}) | the member panel`);
  await shoot(page, 'team-populated-tablet.png');

  await page.setViewportSize(SIZES.phone);
  await expect(page.getByTestId('view-team')).toHaveAttribute('data-layout', 'phone');
  await page.reload();
  await expect(page.getByTestId('view-team')).toHaveAttribute('data-pane', 'list');
  const order = await page.getByTestId('team-body').evaluate((body) => [...body.children].map((child) => child.getAttribute('data-testid')));
  expect(order).toEqual(['team-needs-you', 'team-cards', 'team-activity']);
  await expect(page.getByTestId('team-card').first()).toHaveAttribute('data-status', 'needs-you');
  expect(await noSidewaysOverflow(page)).toBeLessThanOrEqual(0);
  lines.push('- phone: one column, Needs you first, then the cards (the members that need you on top), then Activity');
  await shoot(page, 'team-populated-phone.png');
  if (await page.getByTestId('toast').isVisible()) await page.getByTestId('toast').getByRole('button', { name: 'Close' }).click();
  await page.locator('[data-testid="team-card"]').filter({ hasText: 'Tracker' }).click();
  await expect(page.getByTestId('team-back')).toContainText('Team');
  await expect(page.getByTestId('team-chat').getByTestId('chat-message').first()).toBeVisible({ timeout: 20_000 });
  expect(await noSidewaysOverflow(page)).toBeLessThanOrEqual(0);
  lines.push('- phone: the member panel full screen with ‹ Team');
  await shoot(page, 'team-member-phone.png');
});
