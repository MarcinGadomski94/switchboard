import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';
import { writeReport } from './visual/harness.ts';

/**
 * D101 (E2E, the real server with the demo seed): the sidebar's navigation is an icon
 * grid (5 columns under "+ New session"; 4 with names in the phone / tablet drawer) and
 * the TOOLS section collapses. Each icon opens its view; every cell has its name as
 * `aria-label` and tooltip; the badges carry the counts the text items showed; Tab /
 * Enter / Space work; Team and Plans add their cells while switched on; the TOOLS state
 * survives a reload and "+ Add" still opens Settings → Embedded tools without toggling.
 * Screenshots go to `test-results/visual/` (and `docs/visual/` with `SWITCHBOARD_VISUAL_REPORT=1`).
 */
let tmp: string;
let server: ServerProcess;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-sidebar-icons');
  server = await startServer({ SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), SWITCHBOARD_DEMO: '1' });
});

test.afterAll(async () => {
  await server?.stop();
  await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

/** The grid's cells in order: test id, name, view root. */
const CELLS = [
  ['nav-inbox', 'Inbox', '/inbox', 'view-inbox'],
  ['nav-solutions', 'Solutions', '/solutions', 'view-solutions'],
  ['nav-schedules', 'Schedules & loops', '/schedules', 'view-schedules'],
  ['nav-mcp', 'MCP', '/mcp', 'view-mcp'],
  ['nav-artifacts', 'Artifacts', '/artifacts', 'view-artifacts'],
  ['nav-history', 'History', '/history', 'view-history'],
  ['nav-todos', 'Todos', '/todos', 'view-todos'],
] as const;

async function putSettings(page: Page, body: Record<string, unknown>): Promise<void> {
  const status = await page.evaluate(async (b) => (await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).status, body);
  expect(status).toBe(200);
}

async function openShell(page: Page, url = '/'): Promise<void> {
  await page.goto(`${server.baseUrl}${url}`);
  await expect(page.getByTestId('nav-grid')).toBeVisible();
  // The demo seed's Inbox count is the last badge to arrive with the sidebar's data.
  await expect(page.getByTestId('nav-inbox').locator('.sb-badge')).toHaveText('5');
}

async function sidebarShot(page: Page): Promise<Buffer> {
  const box = (await page.getByTestId('sidebar').boundingBox())!;
  return page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, page.viewportSize()!.height) } });
}

test('the nav is a 5-column icon grid under + New session; each icon opens its view; names as aria-label and tooltip', async ({ page }) => {
  await openShell(page);
  const geometry = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('[data-testid="nav-grid"]')!;
    const button = document.querySelector<HTMLElement>('[data-testid="new-session"]')!.getBoundingClientRect();
    const cells = [...nav.querySelectorAll<HTMLElement>('.sb-nav-item')].map((cell) => {
      const r = cell.getBoundingClientRect();
      const icon = cell.querySelector('svg')!.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, icon: [icon.width, icon.height], text: cell.textContent };
    });
    return { columns: getComputedStyle(nav).gridTemplateColumns.split(' ').length, button: { left: button.left, right: button.right, bottom: button.bottom }, cells };
  });
  expect(geometry.columns).toBe(5);
  expect(geometry.cells).toHaveLength(7);
  for (const cell of geometry.cells) {
    expect(cell.w).toBe(40);
    expect(cell.h).toBe(40);
    expect(cell.icon).toEqual([18, 18]);
  }
  // Two rows: five then two, the first row's ends on the button's edges.
  const rows = [...new Set(geometry.cells.map((c) => c.y))];
  expect(rows).toHaveLength(2);
  expect(geometry.cells[0]!.x).toBeCloseTo(geometry.button.left, 0);
  expect(geometry.cells[4]!.x + 40).toBeCloseTo(geometry.button.right, 0);
  expect(geometry.cells[5]!.x).toBeCloseTo(geometry.cells[0]!.x, 0);
  expect(rows[0]! - geometry.button.bottom).toBeCloseTo(8, 0);

  for (const [id, label, url, view] of CELLS) {
    const cell = page.getByTestId(id);
    await expect(cell).toHaveAttribute('aria-label', label);
    await expect(cell).toHaveAttribute('title', new RegExp(`^${label.replace(/[&]/g, '\\$&')}( · .+)?$`));
    await expect(page.getByRole('link', { name: label, exact: true })).toHaveCount(1);
    await cell.click();
    await expect(page).toHaveURL(new RegExp(`${url}$`));
    await expect(page.getByTestId(view)).toBeAttached();
    await expect(cell).toHaveAttribute('aria-current', 'page');
    // The selected style: the prototype's selected nav colours.
    expect(await cell.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color])).toEqual(['rgb(33, 34, 39)', 'rgb(240, 239, 235)']);
  }
  // The What's-new tours' anchors stay on the cells.
  for (const [id] of CELLS) await expect(page.getByTestId(id)).toHaveAttribute('data-tour', id.slice(4));
});

test('the badges carry the counts: Inbox amber, Solutions "!" with "1 conflict" in the tooltip, Artifacts, Todos', async ({ page }) => {
  await openShell(page);
  const inbox = page.getByTestId('nav-inbox');
  await expect(inbox.locator('.sb-badge')).toHaveAttribute('data-kind', 'need');
  await expect(inbox).toHaveAttribute('title', 'Inbox · 5 items waiting');
  const solutions = page.getByTestId('nav-solutions');
  await expect(solutions.locator('.sb-badge')).toHaveText('!');
  await expect(solutions.locator('.sb-badge')).toHaveAttribute('data-kind', 'warn');
  await expect(solutions).toHaveAttribute('title', 'Solutions · 1 conflict');
  await expect(page.getByTestId('nav-artifacts').locator('.sb-badge')).toHaveText('13');
  await expect(page.getByTestId('nav-artifacts')).toHaveAttribute('title', 'Artifacts · 13 artifacts');
  // MCP and History have no count: their badge draws nothing.
  for (const id of ['nav-mcp', 'nav-history']) {
    await expect(page.getByTestId(id).locator('.sb-badge')).toHaveText('');
    await expect(page.getByTestId(id).locator('.sb-badge')).toBeHidden();
  }
  // The badge sits on the icon cell's top-right corner, amber with dark text for Inbox.
  const placed = await inbox.evaluate((cell) => {
    const c = cell.getBoundingClientRect();
    const b = cell.querySelector<HTMLElement>('.sb-badge')!;
    const r = b.getBoundingClientRect();
    return { right: r.right - c.right, top: r.top - c.top, bg: getComputedStyle(b).backgroundColor, fg: getComputedStyle(b).color };
  });
  expect(placed.right).toBeCloseTo(3, 0);
  expect(placed.top).toBeCloseTo(-3, 0);
  expect(placed.fg).toBe('rgb(17, 18, 20)');
  // Todos: the open todos of the open sessions (the demo seed's count, whatever it is, as text and tooltip).
  const todos = page.getByTestId('nav-todos');
  const todoText = (await todos.locator('.sb-badge').textContent()) ?? '';
  if (todoText) await expect(todos).toHaveAttribute('title', new RegExp(`^Todos · ${todoText} open todos?$`));
  else await expect(todos).toHaveAttribute('title', 'Todos');
});

test('keyboard: Tab reaches each cell with a visible ring; Enter and Space open it', async ({ page }) => {
  await openShell(page, '/inbox');
  await page.getByTestId('new-session').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('nav-inbox')).toBeFocused();
  const ring = await page.getByTestId('nav-inbox').evaluate((el) => [getComputedStyle(el).outlineStyle, getComputedStyle(el).outlineWidth]);
  expect(ring).toEqual(['solid', '2px']);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('nav-solutions')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/solutions$/);
  await page.getByTestId('nav-solutions').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('nav-schedules')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/\/schedules$/);
  await expect(page.getByTestId('nav-schedules')).toHaveAttribute('aria-current', 'page');
});

test('the desktop sidebar with Team and Plans off: seven cells, nothing of theirs', async ({ page }) => {
  await openShell(page);
  await expect(page.getByTestId('nav-team')).toHaveCount(0);
  await expect(page.getByTestId('nav-plans')).toHaveCount(0);
  await writeReport({ 'sidebar-icons-desktop.png': await sidebarShot(page) });
});

test.describe('Team and Plans switched on', () => {
  // Team does not start in demo mode: a plain server (no demo seed) for these two.
  let plain: ServerProcess;
  let plainTmp: string;

  test.beforeAll(async () => {
    plainTmp = await makeTempDir('e2e-sidebar-icons-switches');
    plain = await startServer({ SWITCHBOARD_DATA_DIR: path.join(plainTmp, 'data'), SWITCHBOARD_TUTORIAL: 'off' });
  });

  test.afterAll(async () => {
    await plain?.stop();
    await removeTempDir(plainTmp);
  });

  test('Team and Plans add their cells (Team ⚑ in the role colour while open); the grid stays two rows', async ({ page }) => {
    await page.goto(`${plain.baseUrl}/`);
    await expect(page.getByTestId('nav-grid')).toBeVisible();
    await expect(page.getByTestId('nav-team')).toHaveCount(0);
    await putSettings(page, { 'experimental.team': true, 'experimental.plans': true });
    await page.reload();
    const team = page.getByTestId('nav-team');
    const plans = page.getByTestId('nav-plans');
    await expect(team).toBeVisible();
    await expect(plans).toBeVisible();
    await expect(team).toHaveAttribute('aria-label', 'Team');
    await expect(plans).toHaveAttribute('aria-label', 'Plans');
    await expect(team).toHaveAttribute('data-tour', 'team');
    await expect(plans).toHaveAttribute('data-tour', 'plans');
    await expect(page.getByTestId('nav-plans-count')).toHaveText('');
    expect(await page.getByTestId('nav-grid').locator('.sb-nav-item').count()).toBe(9);
    const rows = await page.getByTestId('nav-grid').evaluate((nav) => new Set([...nav.querySelectorAll('.sb-nav-item')].map((c) => c.getBoundingClientRect().y)).size);
    expect(rows).toBe(2);
    const neutral = await team.evaluate((el) => getComputedStyle(el).color);
    await writeReport({ 'sidebar-icons-desktop-team-plans.png': await sidebarShot(page) });
    await team.click();
    await expect(page).toHaveURL(/\/team$/);
    await expect(team).toHaveAttribute('aria-current', 'page');
    const active = await team.evaluate((el) => getComputedStyle(el).color);
    expect(active).not.toBe(neutral);
    expect(active).not.toBe('rgb(240, 239, 235)');
    await plans.click();
    await expect(page).toHaveURL(/\/plans$/);
    await expect(plans).toHaveAttribute('aria-current', 'page');

    await putSettings(page, { 'experimental.team': false, 'experimental.plans': false });
    await page.reload();
    await expect(page.getByTestId('nav-grid')).toBeVisible();
    await expect(page.getByTestId('nav-team')).toHaveCount(0);
    await expect(page.getByTestId('nav-plans')).toHaveCount(0);
  });
});

test('TOOLS collapses from its header, shows the count, survives a reload; + Add still opens Settings without toggling', async ({ page }) => {
  // Every tool reachable: the collapsed header has no dot.
  await stubToolProbes(page, 'up');
  await openShell(page);
  const toggle = page.getByTestId('tools-toggle');
  const list = page.getByTestId('sidebar-tools');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveText('▾Tools');
  await expect(list.locator('.sb-tool')).toHaveCount(2);
  await writeReport({ 'sidebar-icons-tools-expanded.png': await sidebarShot(page) });

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveText('▸Tools(2)');
  await expect(list).toBeHidden();
  await expect(page.getByTestId('tools-attention')).toHaveCount(0);
  await writeReport({ 'sidebar-icons-tools-collapsed.png': await sidebarShot(page) });

  // Stored by the service: the reload keeps it collapsed (no flash: it is read before the first paint).
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/settings')).json())['ui.toolsCollapsed'])).toBe(true);
  await page.reload();
  await expect(page.getByTestId('tools-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('sidebar-tools')).toBeHidden();

  // + Add opens Settings → Embedded tools and leaves the section as it is.
  await page.getByTestId('add-tool').click();
  await expect(page).toHaveURL(/\/settings\/tools$/);
  await expect(page.getByTestId('tools-toggle')).toHaveAttribute('aria-expanded', 'false');

  // Keyboard: the header's toggle is a button (Enter expands it again).
  await page.getByTestId('tools-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tools-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('sidebar-tools').locator('.sb-tool')).toHaveCount(2);
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/settings')).json())['ui.toolsCollapsed'])).toBe(false);
});

test('a stopped tool shows a dot on the collapsed TOOLS header', async ({ page }) => {
  // The probes answer "down" (beforeEach).
  await openShell(page);
  await expect(page.locator('.sb-tool[data-tool-state="down"]').first()).toBeVisible();
  await expect(page.getByTestId('tools-attention')).toHaveCount(0);
  await page.getByTestId('tools-toggle').click();
  await expect(page.getByTestId('tools-attention')).toBeVisible();
  await page.getByTestId('tools-toggle').click();
  await expect(page.getByTestId('tools-attention')).toHaveCount(0);
});

test.describe('phone drawer', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the drawer shows the grid in 4 columns with names under the icons; tap targets ≥ 44 px; a tap opens the view', async ({ page }) => {
    await page.goto(`${server.baseUrl}/inbox`);
    await page.getByTestId('drawer-open').tap();
    const nav = page.getByTestId('nav-grid');
    await expect(nav).toBeVisible();
    // The drawer has slid in.
    await expect.poll(() => page.getByTestId('sidebar').evaluate((el) => getComputedStyle(el).transform)).toBe('none');
    const cells = await nav.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>('.sb-nav-item')].map((cell) => {
        const r = cell.getBoundingClientRect();
        return { y: Math.round(r.y), w: r.width, h: r.height, name: cell.querySelector('.sb-nav-name')?.textContent ?? null };
      }),
    );
    expect(cells.map((c) => c.name)).toEqual(CELLS.map(([, label]) => label));
    expect(new Set(cells.slice(0, 4).map((c) => c.y)).size).toBe(1);
    expect(cells[4]!.y).toBeGreaterThan(cells[0]!.y);
    for (const cell of cells) {
      expect(cell.w).toBeGreaterThanOrEqual(44);
      expect(cell.h).toBeGreaterThanOrEqual(44);
    }
    await writeReport({ 'sidebar-icons-phone-drawer.png': await page.screenshot() });
    await page.getByTestId('nav-todos').tap();
    await expect(page).toHaveURL(/\/todos$/);
    await expect(page.getByTestId('view-todos')).toBeAttached();
  });
});
