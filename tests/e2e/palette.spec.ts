import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import type { Session, SolutionGroup, Tool } from '../../src/core/api.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../helpers/git.ts';
import { REPO_ROOT } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * The ⌘K / Ctrl+K palette (M8.3) on the real code path (D13, no demo seed):
 * `node src/server/main.ts` with fake-claude as the CLI, a fake gh and a temp
 * workspace of real git repos laid out by the router rules. Sessions are started
 * through the API from the page; the palette lists what `GET /api/sessions`,
 * `GET /api/solutions` and `GET /api/tools` return, after the six views and
 * "New session", filters, moves with ↑ ↓, picks with Enter or a click, and
 * closes with Esc.
 */
let world: GitWorld;
let server: ServerProcess;

test.beforeAll(async () => {
  world = await makeGitWorld();
  const ws = world.workspace;
  await writeFile(path.join(ws, 'AGENTS.md'), await readFile(path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md'), 'utf8'));
  await world.makeRepo(path.join(ws, 'microfrontends', 'auth-front'));
  await world.makeRepo(path.join(ws, 'nugets', 'idle-nuget'));
  await world.makeRepo(path.join(ws, 'other', 'it-tool'));
  await world.makeRepo(path.join(ws, 'deprecated', 'microfrontends', 'old-front'));
  const claudeConfig = path.join(world.root, 'claude-config');
  await mkdir(claudeConfig, { recursive: true });
  server = await startServer({
    SWITCHBOARD_DATA_DIR: path.join(world.root, 'data'),
    SWITCHBOARD_WORKSPACE_ROOT: ws,
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: claudeConfig,
    FAKE_GH_PRS: world.prsFile,
    GIT_CONFIG_GLOBAL: String(world.env['GIT_CONFIG_GLOBAL']),
    GIT_CONFIG_NOSYSTEM: '1',
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  await world?.cleanup();
});

/** Starts a session through the API from the page (same origin, the sb_token cookie). */
async function startSession(page: Page, body: Record<string, unknown>): Promise<Session> {
  const { status, json } = await page.evaluate(async (payload) => {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Say OK.', workType: 'feature', coordination: 'none', qa: null, ultracode: false, worktrees: false, ...payload }),
    });
    return { status: response.status, json: (await response.json()) as unknown };
  }, body);
  expect(status, JSON.stringify(json)).toBe(201);
  return json as Session;
}

async function getJson<T>(page: Page, url: string): Promise<{ status: number; body: T }> {
  return page.evaluate(async (target) => {
    const response = await fetch(target);
    return { status: response.status, body: (await response.json()) as T };
  }, url);
}

/** The palette's rows as `kind | label | hint` (DOM text; the kind is upper-cased by CSS only). */
async function rows(page: Page): Promise<string[]> {
  return page.getByTestId('palette-row').evaluateAll((els) =>
    els.map((el) => [...el.children].map((child) => child.textContent ?? '').join(' | ')),
  );
}

async function selectedRow(page: Page): Promise<string | null> {
  const selected = page.locator('[data-testid="palette-row"][aria-selected="true"]');
  if ((await selected.count()) !== 1) return null;
  return selected.evaluate((el) => [...el.children].map((child) => child.textContent ?? '').join(' | '));
}

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('modal-palette')).toBeVisible();
  await expect(page.getByTestId('palette-input')).toBeFocused();
}

const VIEW_ROWS = [
  'view | Inbox | ',
  'view | Solutions | ',
  'view | Schedules & loops | ',
  'view | Artifacts | ',
  'view | History | ',
  'view | Settings | ',
  'action | New session | ',
];

test('palette: views, New session, sessions and solutions from the real API; filter, max 10, ↑↓ Enter, click, Esc', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  await expect(page.getByTestId('shell')).toBeVisible();
  const web = await startSession(page, { name: 'palette-web', mode: 'orchestrator', phase: 'ui-first', solutions: ['web-front'] });
  const mobile = await startSession(page, { name: 'palette-mobile', mode: 'single', phase: 'integration', solutions: ['mobile'] });
  await expect(page.getByTestId('sidebar-sessions').locator('a')).toHaveCount(2);

  // What the API returns decides the list (tools: M8.1 in another lane; see the tools test).
  const sessions = await getJson<Session[]>(page, '/api/sessions');
  const solutions = await getJson<SolutionGroup[]>(page, '/api/solutions');
  const tools = await getJson<Tool[]>(page, '/api/tools');
  expect(sessions.status).toBe(200);
  expect(solutions.status).toBe(200);
  const modeLine: Record<string, string> = { 'palette-web': 'orch · feature · UI-first', 'palette-mobile': 'single · feature · integration' };
  const all = [
    ...VIEW_ROWS,
    ...(tools.status === 200 ? tools.body.map((t) => `tool | ${t.name} | ${(t.url ?? '').replace(/^https?:\/\//, '')}`) : []),
    ...sessions.body.map((s) => `session | ${s.name} | ${modeLine[s.name]}`),
    ...solutions.body.flatMap((g) => g.solutions.map((s) => `solution | ${s.name} | ${g.folder}`)),
  ];
  expect(all.length).toBeGreaterThan(10);

  // ⌘K / Ctrl+K opens it with the input focused, the prototype's placeholder, and at most 10 results.
  await openPalette(page);
  const input = page.getByTestId('palette-input');
  await expect(input).toHaveAttribute('placeholder', 'Jump to a session, solution, view or tool…');
  await expect(input).toHaveValue('');
  await expect.poll(() => rows(page)).toEqual(all.slice(0, 10));
  expect(await selectedRow(page)).toBe('view | Inbox | ');

  // Filter: by label, kind and hint, case-insensitive, in list order.
  await input.fill('PALETTE-');
  await expect.poll(() => rows(page)).toEqual(sessions.body.map((s) => `session | ${s.name} | ${modeLine[s.name]}`));
  await input.fill('solution');
  const solutionRows = all.filter((row) => row.startsWith('solution | ') || row === 'view | Solutions | ');
  await expect.poll(() => rows(page)).toEqual(solutionRows);
  expect(solutionRows).toEqual([
    'view | Solutions | ',
    'solution | auth-front | microfrontends/',
    'solution | web-front | microfrontends/',
    'solution | mobile | mobile/',
    'solution | idle-nuget | nugets/',
    'solution | it-tool | other/',
    'solution | old-front | read-only',
  ]);
  await input.fill('microfrontends/');
  await expect.poll(() => rows(page)).toEqual(['solution | auth-front | microfrontends/', 'solution | web-front | microfrontends/']);
  await input.fill('integration');
  await expect.poll(() => rows(page)).toEqual(['session | palette-mobile | single · feature · integration']);
  await input.fill('no such thing');
  await expect.poll(() => rows(page)).toEqual([]);
  expect(await selectedRow(page)).toBeNull();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('modal-palette')).toBeVisible(); // nothing to pick

  // ↑ ↓ move the highlight and stop at both ends; typing highlights the first result again.
  await input.fill('solution');
  expect(await selectedRow(page)).toBe('view | Solutions | ');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => selectedRow(page)).toBe('solution | web-front | microfrontends/');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => selectedRow(page)).toBe('solution | auth-front | microfrontends/');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp');
  await expect.poll(() => selectedRow(page)).toBe('view | Solutions | ');
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
  await expect.poll(() => selectedRow(page)).toBe('solution | old-front | read-only');
  await expect(page.locator('[data-testid="palette-row"][aria-selected="true"]')).toHaveCSS('background-color', 'rgb(42, 43, 48)');
  await expect(page.locator('[data-testid="palette-row"][aria-selected="false"]').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(input).toHaveValue('solution'); // the arrows do not move the caret into the text
  await input.fill('solution ');
  expect(await selectedRow(page)).toBe('solution | auth-front | microfrontends/');

  // Enter on a solution: Solutions opens with that solution selected (not the first row).
  await input.fill('mobile/');
  await expect.poll(() => rows(page)).toEqual(['solution | mobile | mobile/']);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('modal-palette')).toHaveCount(0);
  await expect(page).toHaveURL(`${server.baseUrl}/solutions`);
  await expect(page.getByTestId('solution-detail')).toHaveAttribute('data-solution', 'mobile');
  await expect(page.locator('[data-testid="solution-row"][data-solution="mobile"]')).toHaveAttribute('data-selected', 'true');

  // …and while Solutions is already open.
  await openPalette(page);
  await input.fill('idle-nuget');
  // Each opening loads the lists again; the solution row shows once GET /api/solutions has answered.
  await expect.poll(() => rows(page)).toEqual(['solution | idle-nuget | nugets/']);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('solution-detail')).toHaveAttribute('data-solution', 'idle-nuget');
  await expect(page.locator('[data-testid="solution-row"][data-solution="idle-nuget"]')).toHaveAttribute('data-selected', 'true');

  // Enter on a session opens its chat.
  await openPalette(page);
  await input.fill('palette-web');
  await expect.poll(() => rows(page)).toEqual(['session | palette-web | orch · feature · UI-first']);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${server.baseUrl}/sessions/${encodeURIComponent(web.id)}`);
  await expect(page.getByTestId('view-session')).toHaveAttribute('data-session-id', web.id);
  await expect(page.getByTestId('view-session')).toHaveAttribute('data-tab', 'chat');

  // A click picks too; views navigate client-side.
  await openPalette(page);
  await input.fill('sched');
  await page.getByTestId('palette-row').filter({ hasText: 'Schedules & loops' }).click();
  await expect(page).toHaveURL(`${server.baseUrl}/schedules`);
  await expect(page.getByTestId('view-schedules')).toBeAttached();
  await openPalette(page);
  await input.fill('settings');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${server.baseUrl}/settings`);
  await openPalette(page);
  await page.keyboard.press('Enter'); // the first result: Inbox
  await expect(page).toHaveURL(`${server.baseUrl}/inbox`);
  await expect(page.getByTestId('nav-inbox')).toHaveAttribute('aria-current', 'page');

  // "New session" opens the New-session modal in place of the palette.
  await openPalette(page);
  await input.fill('new');
  await expect.poll(() => rows(page)).toEqual(['action | New session | ']);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('modal-new-session')).toBeVisible();
  await expect(page.getByTestId('modal-palette')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('modal-new-session')).toHaveCount(0);

  // Esc and the overlay close it; reopening (and ⌘K while open) starts from an empty query.
  await openPalette(page);
  await input.fill('abc');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('modal-palette')).toHaveCount(0);
  await openPalette(page);
  await expect(input).toHaveValue('');
  await input.fill('mobile');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Meta+k');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect.poll(() => rows(page)).toEqual(all.slice(0, 10));
  expect(await selectedRow(page)).toBe('view | Inbox | ');
  await page.mouse.click(5, 5);
  await expect(page.getByTestId('modal-palette')).toHaveCount(0);
  await page.getByTestId('open-palette').click();
  await expect(page.getByTestId('modal-palette')).toBeVisible();
  await expect(input).toBeFocused();

  // The session results follow /hub while the palette is open.
  await input.fill('palette-');
  await expect.poll(() => rows(page)).toHaveLength(2);
  const late = await startSession(page, { name: 'palette-late', mode: 'single', phase: 'ui-first', solutions: ['auth-front'] });
  await expect.poll(() => rows(page), { timeout: 10_000 }).toContain('session | palette-late | single · feature · UI-first');
  await input.fill('palette-late');
  await expect.poll(() => rows(page)).toEqual(['session | palette-late | single · feature · UI-first']);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('view-session')).toHaveAttribute('data-session-id', late.id);
  expect(mobile.id).not.toBe(late.id);
});

test('palette: tool results come from GET /api/tools and open the tool view', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  await expect(page.getByTestId('shell')).toBeVisible();
  const status = await page.evaluate(async () => (await fetch('/api/tools')).status);
  // D13: GET/PUT /api/tools are M8.1 (lane w1-tools, not merged into this lane yet). Until the merge wires
  // them, this test is expected to fail; after it, the condition is false and the test must pass.
  test.fail(status === 501, 'GET /api/tools answers 501 in this lane (M8.1 lands with lane/w1-tools)');

  const tools = [
    { id: 'cm', name: 'Codebase Memory', url: `${server.baseUrl}/`, description: 'code graph for your indexed solutions', showInSidebar: true },
    { id: 'sw', name: 'Acme Tool', url: null, description: 'AI chat connected to other tools', showInSidebar: true },
  ];
  const put = await page.evaluate(async (body) => {
    const response = await fetch('/api/tools', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return response.status;
  }, tools);
  expect(put).toBe(200);

  await openPalette(page);
  const input = page.getByTestId('palette-input');
  await input.fill('tool');
  await expect
    .poll(() => rows(page))
    .toEqual([`tool | Codebase Memory | 127.0.0.1:${server.port}/`, 'tool | Acme Tool | ', 'solution | it-tool | other/']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${server.baseUrl}/tools/sw`);
  await expect(page.getByTestId('view-tool')).toHaveAttribute('data-tool-id', 'sw');
  await expect(page.getByTestId('modal-palette')).toHaveCount(0);
});
