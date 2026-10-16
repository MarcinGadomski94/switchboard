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
 * cards in ONE row across the full width at the top (D100 follow-up 2026-10-14: it
 * scrolls sideways, the cards keep their width; a deliberate change of the approved
 * mockup's wrapping grid), then Needs you + Activity (330 px) | the member panel;
 * tablet: the same with a narrower left; phone: one column, Needs you first, the
 * cards in the team's order, the member full screen with
 * "‹ Team"), the empty state, and no sideways overflow. D100 follow-up 2026-10-14
 * (activity redesign): the left column's heads collapse and an activity entry is two
 * lines whose text uses the column's full width. D100 follow-up 2026-10-16: the whole
 * left column folds to a 44 px strip with the needs-you badge (desktop and tablet; the
 * expanded layout is unchanged). It runs on the fake world
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
  for (const quiet of [tracker, asker]) await expect(review.locator(`[data-testid="team-not-suggested-row"][data-session-id="${quiet.id}"]`)).toContainText('too little activity or no clear role to tell');
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

  // D100 follow-up 2026-10-16: the sidebar's member rows (expanded by default), their glyphs in the status colours.
  const glyph = (status: string) => `[data-testid="sidebar-team-member"][data-status="${status}"] [data-testid="sidebar-team-member-glyph"]`;
  await expect(page.getByTestId('sidebar-team-member')).toHaveCount(4);
  await expect(page.getByTestId('sidebar-team-toggle')).toHaveAttribute('aria-expanded', 'true');
  expect(await color(page, glyph('working'), 'color')).toBe(run);
  expect(await color(page, glyph('needs-you'), 'color')).toBe(need);
  await expect(page.locator(glyph('paused'))).toHaveText('⏸');
  const [muted] = await canonicalColors(page, ['#76756f']);
  expect(await color(page, '[data-testid="sidebar-team-member"] [data-testid="sidebar-team-member-line"]', 'color')).toBe(muted);
  // The status line sits at the row's right edge; the role name truncates before it.
  const rowBox = await page.getByTestId('sidebar-team-member').first().boundingBox();
  const lineBox = await page.getByTestId('sidebar-team-member-line').first().boundingBox();
  expect(Math.abs(rowBox!.x + rowBox!.width - 8 - (lineBox!.x + lineBox!.width))).toBeLessThanOrEqual(1);
  lines.push(`- sidebar member rows: expanded by default, glyphs working ${run} / needs you ${need} / paused ⏸, status line ${muted} at the right edge`);

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
  // D100 follow-up 2026-10-14: one row (every card on the same line, ~196 px each, never shrunk), no wrapping.
  const row = async () =>
    page.getByTestId('team-card').evaluateAll((cards) => cards.map((c) => c.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), width: Math.round(r.width) })));
  const deskRow = await row();
  expect(new Set(deskRow.map((c) => c.top)).size).toBe(1);
  for (const c of deskRow) expect(c.width).toBeGreaterThanOrEqual(180);
  const cardCols = deskRow.length;
  expect(await color(page, '[data-testid="team-panel-sub"]', 'color')).toBeTruthy();
  expect(await noSidewaysOverflow(page)).toBeLessThanOrEqual(0);
  lines.push(`- desktop: the cards in one row across the full width (${cardCols} cards, ${deskRow[0]?.width} px each; the row scrolls sideways when they do not fit), then Needs you + Activity (${desk.columns[0]}) | the member panel to the bottom`);
  // D100 follow-up 2026-10-14 (activity redesign, a deliberate change of the approved
  // mockup's three-column rows): both heads collapse (▾ / ▸, open by default); each entry
  // is two lines, icon · actor · time over the text, which uses the column's full width.
  await expect(page.getByTestId('team-activity-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('team-needs-toggle')).toHaveAttribute('aria-expanded', 'true');
  const entry = await page
    .getByTestId('team-activity-row')
    .first()
    .evaluate((row) => {
      const box = (selector: string) => row.querySelector(selector)?.getBoundingClientRect() ?? null;
      return { row: row.getBoundingClientRect(), head: box('.sb-team-act__head'), text: box('.sb-team-act__text'), time: box('.sb-team-act__time'), actorColor: getComputedStyle(row.querySelector('.sb-team-act__actor') as Element).color };
    });
  expect(entry.text!.top).toBeGreaterThanOrEqual(entry.head!.bottom - 1);
  expect(entry.text!.right).toBeGreaterThan(entry.row.right - 2);
  expect(entry.text!.width).toBeGreaterThan(entry.row.width - 24);
  expect(Math.round(entry.time!.right)).toBe(Math.round(entry.row.right));
  expect(entry.actorColor).toBe(roleFg);
  lines.push(`- desktop: Needs you and Activity collapse (▾ / ▸, open by default); an activity entry is two lines (icon · actor in ${roleFg} · time right-aligned, then the text across ${Math.round(entry.text!.width)} of the column's ${Math.round(entry.row.width)} px)`);
  await page.getByTestId('team-split').locator('.sb-team-left').screenshot().then((png) => {
    shots['team-left-column-desktop.png'] = png;
    lines.push('- `team-left-column-desktop.png`');
  });
  await shoot(page, 'team-populated-desktop.png');

  // D100 follow-up 2026-10-16: the whole left column folds to a 44 px strip (the
  // expanded layout above is unchanged): the needs-you count as an amber badge, ›, and
  // the member panel takes the freed width. Unfolded again before the tablet check.
  const panelBefore = desk.panel!.width;
  await page.getByTestId('team-left-collapse').click();
  await expect(page.getByTestId('team-split')).toHaveAttribute('data-left', 'collapsed');
  await expect.poll(async () => (await geometry()).columns[0]).toBe('44px');
  const folded = await geometry();
  expect(Math.round(folded.panel!.width)).toBe(Math.round(panelBefore + 330 - 44));
  expect(Math.round(folded.panel!.bottom)).toBe(Math.round(folded.split!.bottom));
  const strip = await page.getByTestId('team-left-strip').boundingBox();
  expect(Math.round(strip!.width)).toBe(44);
  const badgeBox = await page.getByTestId('team-left-badge').boundingBox();
  expect(badgeBox!.x).toBeGreaterThanOrEqual(strip!.x);
  expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(strip!.x + strip!.width);
  expect(await color(page, '[data-testid="team-left-badge"]', 'background-color')).toBe(need);
  await expect(page.getByTestId('team-left-badge')).toHaveText('1');
  await expect(page.getByTestId('team-left-expand')).toHaveText('›');
  expect(await noSidewaysOverflow(page)).toBeLessThanOrEqual(0);
  lines.push(`- desktop, left column folded: a ${Math.round(strip!.width)} px strip (› then the needs-you count as an amber badge ${need}), the member panel ${Math.round(panelBefore)} → ${Math.round(folded.panel!.width)} px`);
  await shoot(page, 'team-left-collapsed-desktop.png');
  await page.getByTestId('team-left-expand').click();
  await expect(page.getByTestId('team-split')).not.toHaveAttribute('data-left', /.*/);
  await expect.poll(async () => (await geometry()).columns[0]).toBe('330px');

  await page.setViewportSize(SIZES.tablet);
  await expect(page.getByTestId('view-team')).toHaveAttribute('data-layout', 'tablet');
  const tab = await geometry();
  expect(tab.columns.length).toBe(2);
  expect(tab.columns[0]).toBe('260px');
  expect(tab.cards!.bottom).toBeLessThanOrEqual(tab.split!.top + 1);
  const tabRow = await row();
  expect(new Set(tabRow.map((c) => c.top)).size).toBe(1);
  for (const c of tabRow) expect(c.width).toBeGreaterThanOrEqual(180);
  expect(await noSidewaysOverflow(page)).toBeLessThanOrEqual(0);
  lines.push(`- tablet: the cards in one row across the top (scrolling sideways when they do not fit), then Needs you + Activity (${tab.columns[0]}) | the member panel`);
  await shoot(page, 'team-populated-tablet.png');
  await page.getByTestId('team-left-collapse').click();
  await expect.poll(async () => (await geometry()).columns[0]).toBe('44px');
  expect(await noSidewaysOverflow(page)).toBeLessThanOrEqual(0);
  lines.push('- tablet, left column folded: the same 44 px strip');
  await shoot(page, 'team-left-collapsed-tablet.png');
  await page.getByTestId('team-left-expand').click();
  await expect.poll(async () => (await geometry()).columns[0]).toBe('260px');

  await page.setViewportSize(SIZES.phone);
  await expect(page.getByTestId('view-team')).toHaveAttribute('data-layout', 'phone');
  await page.reload();
  await expect(page.getByTestId('view-team')).toHaveAttribute('data-pane', 'list');
  const order = await page.getByTestId('team-body').evaluate((body) => [...body.children].map((child) => child.getAttribute('data-testid')));
  expect(order).toEqual(['team-needs-you', 'team-cards', 'team-activity']);
  // D100 follow-up 2026-10-14: the phone's list keeps the team's order (reorderable there too).
  await expect(page.getByTestId('team-card-role')).toHaveText(['Tracker', 'Release manager', 'Developer', 'On-call']);
  expect(await noSidewaysOverflow(page)).toBeLessThanOrEqual(0);
  lines.push('- phone: one column, Needs you first, then the cards in the team\'s order, then Activity');
  await shoot(page, 'team-populated-phone.png');
  if (await page.getByTestId('toast').isVisible()) await page.getByTestId('toast').getByRole('button', { name: 'Close' }).click();
  await page.locator('[data-testid="team-card"]').filter({ hasText: 'Tracker' }).click();
  await expect(page.getByTestId('team-back')).toContainText('Team');
  await expect(page.getByTestId('team-chat').getByTestId('chat-message').first()).toBeVisible({ timeout: 20_000 });
  expect(await noSidewaysOverflow(page)).toBeLessThanOrEqual(0);
  lines.push('- phone: the member panel full screen with ‹ Team');
  await shoot(page, 'team-member-phone.png');
});
