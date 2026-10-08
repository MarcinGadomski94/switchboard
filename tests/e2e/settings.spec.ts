import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type APIRequestContext, type Page, expect, request as playwrightRequest, test } from '@playwright/test';
import type { Schedule, SolutionGroup, SystemInfo, Tool } from '../../src/core/api.ts';
import type { KnownSettings } from '../../src/core/settings.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { type StubServer, htmlPage, startStubServer } from '../helpers/stub-http.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';

/**
 * M8.2 oracle: Settings on the real code path (no demo seed, D13). The real
 * `node src/server/main.ts` with a temp data folder, a temp workspace (router
 * `AGENTS.md` + solution folders), fake-claude and fake gh as the CLIs, and local
 * stub servers standing in for the embedded tools, all on the lane's test ports.
 * Covers the seven sections and their rows, the preferences persisted in SQLite
 * (`GET/PUT /api/settings`, across a service restart), the tool editor (URL, Test,
 * Open, add, remove; gaps #13, #14) with the sidebar following, Send test (toast +
 * chime + OS notification, both mocked in the page) and Allow, Run setup again and
 * Rescan. The scan table's test runs on M6.1's real `GET /api/solutions` (D13).
 */
let tmp: string;
let workspace: string;
let dataDir: string;
let server: ServerProcess;
let api: APIRequestContext;
let env: Record<string, string>;
const stubs: StubServer[] = [];
let cmStub: StubServer;

async function stub(text: string): Promise<StubServer> {
  const server = await startStubServer(htmlPage(text));
  stubs.push(server);
  return server;
}

async function connect(): Promise<void> {
  await api?.dispose();
  const token = (await readFile(path.join(dataDir, 'sb_token'), 'utf8')).trim();
  api = await playwrightRequest.newContext({ baseURL: server.baseUrl, extraHTTPHeaders: { cookie: `sb_token=${token}` } });
}

async function getSettings(): Promise<KnownSettings> {
  const response = await api.get('/api/settings');
  expect(response.status()).toBe(200);
  return (await response.json()) as KnownSettings;
}

async function getTools(): Promise<Tool[]> {
  return (await (await api.get('/api/tools')).json()) as Tool[];
}

/** A settings row by its `data-row`. */
function row(page: Page, id: string) {
  return page.locator(`.sb-set-row[data-row="${id}"]`);
}

/** Records the page's `/api/*` responses (method, path, status). */
function recordApi(page: Page): Array<{ method: string; path: string; status: number }> {
  const calls: Array<{ method: string; path: string; status: number }> = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/')) calls.push({ method: response.request().method(), path: url.pathname, status: response.status() });
  });
  return calls;
}

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-settings');
  workspace = path.join(tmp, 'work space');
  dataDir = path.join(tmp, 'data');
  const claudeConfig = path.join(tmp, 'claude-config');
  await mkdir(claudeConfig, { recursive: true });
  // A fixture workspace: the router file and one solution per kind of folder.
  for (const folder of [
    'microfrontends/alpha-front/.git',
    'microfrontends/beta-front/.git',
    'mobile/.git',
    'other/tool-x',
    'deprecated/microfrontends/old-front',
    'infrastructure',
  ]) {
    await mkdir(path.join(workspace, ...folder.split('/')), { recursive: true });
  }
  await writeFile(path.join(workspace, 'AGENTS.md'), '# AGENTS.md (Workspace Router)\n\nFixture workspace for the Settings E2E.\n');
  cmStub = await stub('Codebase Memory stub');
  // D14: the workspace is a saved folder (the default) in the server's database.
  await seedFolderInDataDir(dataDir, workspace);
  env = {
    SWITCHBOARD_DATA_DIR: dataDir,
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: claudeConfig,
    FAKE_CLAUDE_SCENARIO: 'handoff-start',
  };
  server = await startServer(env);
  await connect();
  // Point Codebase Memory at a stub before any page loads: the sidebar probes it on load,
  // and the default http://localhost:13000 is the developer's machine.
  const defaults = await getTools();
  expect(defaults.map((t) => [t.id, t.url])).toEqual([
    ['cm', 'http://localhost:13000'],
    ['sw', null],
  ]);
  const put = await api.put('/api/tools', { data: [{ ...defaults[0], url: `http://127.0.0.1:${cmStub.port}` }, defaults[1]] });
  expect(put.status()).toBe(200);
});

test.afterAll(async () => {
  await api?.dispose();
  if (server) expect(await server.stop()).toBe(0);
  for (const s of stubs.splice(0)) await s.close();
  await removeTempDir(tmp);
});

test('the seven sections: nav, deep links, Claude Code rows from the service, Run setup again', async ({ page }) => {
  const documents: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documents.push(request.url());
  });
  await page.goto(`${server.baseUrl}/settings`);
  const view = page.getByTestId('view-settings');
  await expect(view).toHaveAttribute('data-section', 'claude');
  await expect(page.locator('.sb-set-nav-title')).toHaveText('Settings');
  await expect(page.locator('.sb-set-nav-item')).toHaveText([
    'Claude Code',
    'Folders',
    'Sessions & worktrees',
    'Notifications & usage',
    'Schedules',
    'Embedded tools',
    'GitHub',
    // D62: after the prototype's seven.
    'CLIs',
    'Accounts',
    // D48: after the prototype's seven.
    'Machines',
    // D73: after Machines.
    'Devices',
    // D55: after Machines (D73: after Devices).
    'Updates',
  ]);
  await expect(page.getByTestId('settings-nav-claude')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('nav-settings')).toHaveAttribute('aria-current', 'page');

  // Claude Code: what the service reports about itself; nothing invented.
  await expect(page.getByTestId('settings-title')).toHaveText('Claude Code');
  await expect(page.locator('.sb-set-row .sb-set-row-label')).toHaveText(['CLI', 'Account', 'Background service', 'Bind address', 'Start at login', 'Permissions']);
  await expect(row(page, 'service').getByTestId('setting-value')).toHaveText(`127.0.0.1:${server.port} · running`);
  await expect(row(page, 'bind').getByTestId('setting-value')).toHaveText('localhost only');
  await expect(row(page, 'start-at-login').getByTestId('start-at-login')).toHaveText('off'); // M9.1's real toggle; nothing installed
  await expect(row(page, 'permissions').getByTestId('setting-value')).toHaveText('managed by Claude Code');
  await page.getByTestId('settings-run-setup').click();
  await expect(page.getByTestId('modal-setup-wizard')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('modal-setup-wizard')).toHaveCount(0);

  // Every section by its nav item (client-side) and its URL.
  const sections: Array<[key: string, title: string]> = [
    ['workspace', 'Folders'],
    ['sessions', 'Sessions & worktrees'],
    ['notify', 'Notifications & usage'],
    ['schedules', 'Schedules'],
    ['tools', 'Embedded tools'],
    ['github', 'GitHub'],
    ['clis', 'CLIs'],
    ['machines', 'Machines'],
    ['devices', 'Devices'],
    ['updates', 'Updates'],
    ['claude', 'Claude Code'],
  ];
  for (const [key, title] of sections) {
    await page.getByTestId(`settings-nav-${key}`).click();
    await expect(page).toHaveURL(`${server.baseUrl}/settings/${key}`);
    await expect(view).toHaveAttribute('data-section', key);
    await expect(page.getByTestId('settings-title')).toHaveText(title);
    await expect(page.getByTestId(`settings-nav-${key}`)).toHaveAttribute('aria-current', 'page');
  }
  expect(documents).toEqual([`${server.baseUrl}/settings`]); // no full page loads
  await page.goto(`${server.baseUrl}/settings/github`);
  await expect(page.getByTestId('settings-title')).toHaveText('GitHub');
  await expect(row(page, 'pr-detection').getByTestId('setting-value')).toHaveText('every 5 min'); // the worktree manager's real interval
  await page.goto(`${server.baseUrl}/settings/nope`);
  await expect(view).toHaveAttribute('data-section', 'claude');
});

test('Folders (D14): the saved default folder with its kind and check line; its scan; Rescan scans again', async ({ page }) => {
  const calls = recordApi(page);
  await page.goto(`${server.baseUrl}/settings/workspace`);
  const folder = page.getByTestId('settings-folder');
  await expect(folder).toHaveCount(1);
  await expect(folder.getByTestId('settings-folder-name')).toHaveText('work space');
  await expect(folder.getByTestId('settings-folder-kind')).toHaveText('workspace');
  await expect(folder.getByTestId('settings-folder-default')).toHaveText('default');
  await expect(folder.getByTestId('settings-folder-path')).toHaveText(workspace);
  await expect(folder.getByTestId('settings-folder-check')).toHaveText('✓ AGENTS.md (Workspace Router) · 6 solutions');
  await expect(folder.getByTestId('settings-folder-make-default')).toHaveCount(0);
  await expect(row(page, 'workspace-root').locator('.sb-set-row-label')).toHaveText('Solutions in work space');
  await expect(row(page, 'workspace-root').locator('.sb-set-row-desc')).toHaveText(workspace);
  // The sidebar (conflict badge) and the section each ask once on load.
  await expect.poll(() => calls.filter((c) => c.path === '/api/solutions').length).toBe(2);
  await page.getByTestId('settings-rescan').click();
  await expect.poll(() => calls.filter((c) => c.path === '/api/solutions').length).toBe(3);
  expect(await getSettings()).toMatchObject({ 'workspace.root': workspace, 'workspace.router': 'AGENTS.md (Workspace Router)' });
  // /settings/folders opens the same section.
  await page.goto(`${server.baseUrl}/settings/folders`);
  await expect(page.getByTestId('view-settings')).toHaveAttribute('data-section', 'workspace');
  await expect(page.getByTestId('settings-title')).toHaveText('Folders');
});

test('Folders scan table + GitHub repositories from the real scan (M6.1 GET /api/solutions)', async ({ page }) => {
  await page.goto(`${server.baseUrl}/settings/workspace`);
  const scan = page.getByTestId('settings-scan');
  await expect(scan.locator('.sb-set-scan-row')).toHaveCount(5, { timeout: 5_000 });
  await expect(scan.locator('.sb-set-scan-folder')).toHaveText(['microfrontends/', 'mobile/', 'other/', 'deprecated/', 'infrastructure/']);
  await expect(scan.locator('.sb-set-scan-count')).toHaveText(['2', '1', '1', '1', '1']);
  await expect(scan.locator('.sb-set-scan-examples')).toHaveText(['alpha-front, beta-front', 'mobile', 'tool-x', 'old-front', 'infrastructure']);
  await expect(scan.locator('.sb-set-scan-rule')).toHaveText(['editable', 'editable', 'on request only', 'read-only', 'read-only']);
  await page.getByTestId('settings-nav-github').click();
  await expect(row(page, 'repositories').getByTestId('setting-value')).toHaveText('6 repos');
});

test('Sessions & worktrees and the usage threshold persist in SQLite, also across a service restart', async ({ page }) => {
  const calls = recordApi(page);
  await page.goto(`${server.baseUrl}/settings/sessions`);
  await expect(page.locator('.sb-set-row .sb-set-row-label')).toHaveText([
    'Working folder',
    'Worktree per session',
    'Worktree location',
    'Cleanup',
    'Ultracode by default',
    'Session-start questions',
    'Remind the agent to finish started todos',
    'Standing instruction for agents',
    // D82: the Model by task rules (off: none).
    'Model by task',
    // D83: the fresh-session offer (on, at 80 %).
    'Fresh session when the context fills',
  ]);
  await expect(page.locator('.sb-set-row').getByTestId('setting-value')).toHaveText([
    "the session's folder",
    'on',
    '../{repo}-wt-{session}',
    'keep until merged',
    'off',
    'from AGENTS.md',
    'on',
    'on',
    'on',
  ]);
  const ultracode = row(page, 'ultracode').getByRole('switch');
  const worktrees = row(page, 'worktrees').getByRole('switch');
  await ultracode.click();
  await expect(ultracode).toHaveText('on');
  await expect(ultracode).toHaveAttribute('aria-checked', 'true');
  await worktrees.click();
  await expect(worktrees).toHaveText('off');
  // D75: the todo finish reminder (on by default).
  const reminder = row(page, 'todo-reminder').getByRole('switch');
  await reminder.click();
  await expect(reminder).toHaveText('off');
  expect(calls.filter((c) => c.method === 'PUT' && c.path === '/api/settings').map((c) => c.status)).toEqual([200, 200, 200]);
  expect(await getSettings()).toMatchObject({ 'sessions.ultracode': true, 'sessions.worktrees': false, 'sessions.todoReminder': false });

  await page.getByTestId('settings-nav-notify').click();
  const threshold = row(page, 'warn-at').locator('select');
  await expect(threshold).toHaveValue('90');
  await threshold.selectOption('80');
  await expect.poll(async () => (await getSettings())['usage.warnAtPct']).toBe(80);
  await expect(row(page, 'near-limit').getByTestId('setting-value')).toHaveText('just warn');

  // The service restarts on the same data folder: the preferences come back from SQLite.
  expect(await server.stop()).toBe(0);
  server = await startServer(env);
  await connect();
  expect(await getSettings()).toMatchObject({ 'sessions.ultracode': true, 'sessions.worktrees': false, 'usage.warnAtPct': 80, 'sessions.todoReminder': false });
  await page.goto(`${server.baseUrl}/settings/sessions`);
  await expect(row(page, 'ultracode').getByRole('switch')).toHaveText('on');
  await expect(row(page, 'todo-reminder').getByRole('switch')).toHaveText('off');
  await expect(row(page, 'worktrees').getByRole('switch')).toHaveText('off');
  await page.goto(`${server.baseUrl}/settings/notify`);
  await expect(row(page, 'warn-at').locator('select')).toHaveValue('80');

  // Back to the defaults for the other tests.
  const reset = await api.put('/api/settings', { data: { 'sessions.ultracode': false, 'sessions.worktrees': true, 'usage.warnAtPct': 90, 'sessions.todoReminder': true } });
  expect(reset.status()).toBe(200);
});

test('Notifications & usage: Send test fires the toast, the chime and the OS notification; Allow asks for permission', async ({ page }) => {
  // Mock the browser's Notification and AudioContext (recorded on window.__sb).
  await page.addInitScript(() => {
    const record = { notifications: [] as Array<[string, string]>, requests: 0, tones: [] as number[] };
    (window as unknown as { __sb: typeof record }).__sb = record;
    class FakeNotification {
      static permission: NotificationPermission = 'default';
      static requestPermission(): Promise<NotificationPermission> {
        record.requests += 1;
        FakeNotification.permission = 'granted';
        return Promise.resolve('granted');
      }
      constructor(title: string, options?: NotificationOptions) {
        record.notifications.push([title, options?.body ?? '']);
      }
    }
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      createOscillator() {
        const node = {
          frequency: { value: 0 },
          connect: (target: unknown) => target,
          start: () => record.tones.push(node.frequency.value),
          stop: () => undefined,
        };
        return node;
      }
      createGain() {
        return { gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, connect: (target: unknown) => target };
      }
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
    Object.defineProperty(window, 'AudioContext', { value: FakeAudioContext, configurable: true });
  });
  await page.goto(`${server.baseUrl}/settings/notify`);
  await expect(page.locator('.sb-set-row .sb-set-row-label')).toHaveText(['In-app toast + sound', 'OS notifications', 'Warn at Max usage', 'Near the limit']);
  const osState = row(page, 'os-notifications').getByTestId('setting-value');
  await expect(osState).toHaveText('not asked yet');

  await page.getByTestId('settings-allow-notifications').click();
  await expect(osState).toHaveText('✓ allowed');
  const recorded = () => page.evaluate(() => (window as unknown as { __sb: { notifications: Array<[string, string]>; requests: number; tones: number[] } }).__sb);
  expect((await recorded()).requests).toBe(1);
  expect((await recorded()).notifications).toEqual([['Switchboard', 'Notifications are on.']]);

  await page.getByTestId('settings-send-test').click();
  const toast = page.getByTestId('toast');
  await expect(toast.locator('.sb-toast-title')).toHaveText('Test notification');
  await expect(toast.locator('.sb-toast-sub')).toHaveText('now');
  await expect(toast.locator('.sb-toast-branch')).toHaveText('this is how questions arrive');
  await expect(toast.locator('.sb-toast-text')).toHaveText('Sound, toast and OS notification all fire together.');
  await expect(toast.getByText('Jump to session')).toHaveCount(0); // no session behind a test
  expect((await recorded()).tones).toEqual([784, 1046]);
  expect((await recorded()).notifications).toEqual([
    ['Switchboard', 'Notifications are on.'],
    ['Switchboard', 'Test notification'],
  ]);
  await toast.getByText('Later').click();
  await expect(toast).toHaveCount(0);
});

test('Embedded tools: URL saved by Switchboard, Test, Open, add and remove; the sidebar follows', async ({ page }) => {
  const swStub = await stub('Acme Tool stub');
  const docsStub = await stub('Docs stub');
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(`${server.baseUrl}/settings/tools`);
  await expect(page.getByTestId('settings-title')).toHaveText('Embedded tools');
  await expect(page.locator('.sb-set-lede')).toHaveText(
    'Local web apps shown under Tools in the sidebar and opened in the main area. URLs are saved in Switchboard.',
  );
  const cards = page.getByTestId('settings-tools').locator('.sb-set-tool[data-tool]');
  await expect(cards.locator('.sb-set-tool-name')).toHaveText(['Codebase Memory', 'Acme Tool']);
  await expect(cards.locator('.sb-set-tool-desc')).toHaveText(['code graph for your indexed solutions', 'AI chat connected to other tools']);
  const cm = page.locator('.sb-set-tool[data-tool="cm"]');
  const sw = page.locator('.sb-set-tool[data-tool="sw"]');
  await expect(cm.getByTestId('settings-tool-url')).toHaveValue(`http://127.0.0.1:${cmStub.port}`);
  await expect(cm.getByTestId('settings-tool-state')).toHaveText('reachable'); // the sidebar's load-time probe, through the service
  await expect(sw.getByTestId('settings-tool-url')).toHaveValue('');
  await expect(sw.getByTestId('settings-tool-url')).toHaveAttribute('placeholder', 'http://localhost:PORT');
  await expect(sw.getByTestId('settings-tool-state')).toHaveText('not tested');

  // An invalid URL is refused by the service; nothing changes.
  const swUrl = sw.getByTestId('settings-tool-url');
  await swUrl.fill('ftp://127.0.0.1/files');
  await swUrl.press('Enter');
  await expect(sw.getByTestId('settings-tool-error')).toHaveText('The URL must be an http:// or https:// address');
  expect((await getTools()).find((t) => t.id === 'sw')?.url).toBeNull();

  // A valid URL is saved on blur; the sidebar row shows its host.
  const swAddress = `http://127.0.0.1:${swStub.port}`;
  await swUrl.fill(swAddress);
  await swUrl.blur();
  await expect.poll(async () => (await getTools()).find((t) => t.id === 'sw')?.url).toBe(swAddress);
  await expect(sw.getByTestId('settings-tool-error')).toHaveCount(0);
  const sidebarRows = page.getByTestId('sidebar-tools').locator('a');
  await expect(sidebarRows.nth(1).locator('.sb-tool-host')).toHaveText(`127.0.0.1:${swStub.port}`);
  // The sidebar reloads its tools and probes the new URL (M8.1: probe state keyed by id + URL).
  await expect(sw.getByTestId('settings-tool-state')).toHaveText('reachable');

  // Test probes again, through the service (the page never fetches the tool itself).
  const probes = swStub.requests.length;
  const probeCall = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/tools/sw/probe');
  await sw.getByTestId('settings-tool-test').click();
  expect((await probeCall).status()).toBe(200);
  await expect(sw.getByTestId('settings-tool-state')).toHaveText('reachable');
  await expect.poll(() => swStub.requests.length).toBeGreaterThan(probes);

  // Clearing the URL: saved as not configured, "not set" without a request.
  await swUrl.fill('');
  await swUrl.press('Enter');
  await expect(sw.getByTestId('settings-tool-state')).toHaveText('not set');
  await expect.poll(async () => (await getTools()).find((t) => t.id === 'sw')?.url).toBeNull();
  await expect(sidebarRows.nth(1).locator('.sb-tool-host')).toHaveText('set URL');

  // Add a tool (gap #14): it appears here and in the sidebar, saved by the service.
  const add = page.getByTestId('settings-add-tool');
  await add.getByRole('button', { name: 'Add' }).click();
  await expect(add.getByRole('alert')).toHaveText('Give the tool a name.');
  await add.getByLabel('Tool name').fill('Docs');
  await add.getByLabel('Tool URL').fill(`http://127.0.0.1:${docsStub.port}`);
  await add.getByRole('button', { name: 'Add' }).click();
  await expect(cards.locator('.sb-set-tool-name')).toHaveText(['Codebase Memory', 'Acme Tool', 'Docs']);
  await expect(add.getByLabel('Tool name')).toHaveValue('');
  await expect(sidebarRows.locator('.sb-tool-name')).toHaveText(['Codebase Memory', 'Acme Tool', 'Docs']);
  const tools = await getTools();
  const docs = tools.find((t) => t.name === 'Docs');
  expect(docs).toMatchObject({ url: `http://127.0.0.1:${docsStub.port}`, description: null, showInSidebar: true });

  // Open → the tool view with the tool in its frame.
  await page.locator(`.sb-set-tool[data-tool="${docs!.id}"]`).getByTestId('settings-tool-open').click();
  await expect(page).toHaveURL(`${server.baseUrl}/tools/${docs!.id}`);
  await expect(page.frameLocator('[data-testid="tool-frame"]').getByTestId('stub')).toHaveText('Docs stub');

  // Remove it again (after a confirm); it is gone here, in the sidebar and in the service.
  await page.getByTestId('tool-edit').click();
  await expect(page).toHaveURL(`${server.baseUrl}/settings/tools`);
  await page.locator(`.sb-set-tool[data-tool="${docs!.id}"]`).getByTestId('settings-tool-remove').click();
  await expect(cards.locator('.sb-set-tool-name')).toHaveText(['Codebase Memory', 'Acme Tool']);
  await expect(sidebarRows.locator('.sb-tool-name')).toHaveText(['Codebase Memory', 'Acme Tool']);
  expect((await getTools()).map((t) => t.id)).toEqual(['cm', 'sw']);

  // A reload shows what the service stored.
  await page.reload();
  await expect(cards.locator('.sb-set-tool-name')).toHaveText(['Codebase Memory', 'Acme Tool']);
  await expect(sw.getByTestId('settings-tool-url')).toHaveValue('');
});

test('rows render contract-shaped data from /api/system, /api/schedules and /api/solutions (lanes M5.3, M7.1, M6.1)', async ({ page }) => {
  // Those routes answer 501 in this lane; this test pins how Settings renders their contract
  // shapes, answered in the browser. The real-path tests above cover everything this lane serves.
  const system: SystemInfo = {
    cli: '/opt/bin/claude',
    cliVersion: '2.1.283',
    signedIn: true,
    ghSignedIn: true,
    cpu: 10,
    ramUsed: 1,
    ramTotal: 2,
    processes: 0,
  };
  const schedules: Schedule[] = [
    {
      id: 's1',
      name: 'nightly-check',
      description: 'Build on main',
      cron: '0 2 * * *',
      paused: false,
      template: null,
      runs: [{ ts: '2026-09-27T02:00:00.000Z', result: 'fail', summary: null }],
      nextRunAt: null,
    },
    { id: 's2', name: 'weekly-audit', description: 'Audit packages', cron: '15 7 * * 1', paused: true, template: null, runs: [], nextRunAt: null },
  ];
  const at = (...parts: string[]): string => path.join(workspace, ...parts);
  const solution = (name: string, full: string, rule: 'editable' | 'on-request' | 'read-only') => ({
    name,
    path: full,
    relativePath: path.relative(workspace, full).split(path.sep).join('/'),
    type: 'Web',
    status: 'idle' as const,
    rule,
    phase: '—',
    changes: '—',
    flag: '',
    conflict: false,
    conflictSessions: [],
    branches: [],
    ledger: null,
    artifacts: [],
    codebaseMemory: 'fresh' as const,
  });
  const groups: SolutionGroup[] = [
    { folder: 'microfrontends/', note: '', rule: 'editable', solutions: [solution('alpha-front', at('microfrontends', 'alpha-front'), 'editable')] },
    {
      folder: 'read-only',
      note: 'deprecated/ · infrastructure/ · never edited',
      rule: 'read-only',
      solutions: [solution('infrastructure', at('infrastructure'), 'read-only'), solution('old-front', at('deprecated', 'microfrontends', 'old-front'), 'read-only')],
    },
  ];
  await page.route('**/api/system', (route) => route.fulfill({ json: system }));
  await page.route('**/api/schedules', (route) => route.fulfill({ json: schedules }));
  // D14: Settings → Folders asks for its folder's scan (`?folder=<id>`).
  await page.route(/\/api\/solutions(\?.*)?$/, (route) => route.fulfill({ json: groups }));

  await page.goto(`${server.baseUrl}/settings/claude`);
  await expect(row(page, 'cli').locator('.sb-set-row-desc')).toHaveText('/opt/bin/claude');
  await expect(row(page, 'cli').getByTestId('setting-value')).toHaveText('detected');
  await expect(row(page, 'account').getByTestId('setting-value')).toHaveText('signed in');

  await page.getByTestId('settings-nav-schedules').click();
  const rows = page.locator('.sb-set-sched');
  await expect(rows.locator('.sb-set-sched-name')).toHaveText(['nightly-check', 'weekly-audit']);
  await expect(rows.locator('.sb-set-sched-cron')).toHaveText(['02:00 daily', 'Mon 07:15']);
  await expect(rows.locator('.sb-set-sched-desc')).toHaveText(['Build on main', 'Audit packages']);
  const dots = await rows.locator('.sb-set-sched-dot').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  const colors = await page.evaluate(() =>
    ['--status-fail', '--status-idle'].map((name) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }),
  );
  expect(dots).toEqual(colors);

  await page.getByTestId('settings-nav-workspace').click();
  const scan = page.getByTestId('settings-scan');
  await expect(scan.locator('.sb-set-scan-folder')).toHaveText(['microfrontends/', 'deprecated/', 'infrastructure/']);
  await expect(scan.locator('.sb-set-scan-rule')).toHaveText(['editable', 'read-only', 'read-only']);

  await page.getByTestId('settings-nav-github').click();
  await expect(row(page, 'gh-login').getByTestId('setting-value')).toHaveText('✓ signed in');
  await expect(row(page, 'repositories').getByTestId('setting-value')).toHaveText('3 repos');
});
