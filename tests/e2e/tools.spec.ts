import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type APIRequestContext, type Page, expect, request as playwrightRequest, test } from '@playwright/test';
import type { Session, Tool } from '../../src/core/api.ts';
import { DIRTY_FILE, projectId, readDirtyProjects, reindexPrompt } from '../../src/server/tools/codebase-memory.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { type StubServer, htmlPage, startStubServer, unusedTestPort } from '../helpers/stub-http.ts';

/**
 * M8.1 oracle: embedded tools on the real code path (no demo seed, D13). The real
 * `node src/server/main.ts` with a temp data folder, a temp workspace holding a
 * `.claude/.codebase-memory-dirty`, fake-claude as the CLI, and local stub servers
 * standing in for the tools, all on the lane's test ports. Covers the toolbar, the
 * server-side probe (the page never fetches the tool's origin itself), the iframe,
 * Reload, New tab, Edit, the "isn't configured" and "is not reachable" overlays
 * with Retry, and the Codebase Memory strip whose "Reindex n now" starts a real
 * (fake-claude) session from the built-in prompt (gap #4).
 */
let tmp: string;
let workspace: string;
let fakeLog: string;
let server: ServerProcess;
let api: APIRequestContext;
const stubs: StubServer[] = [];
let cmStub: StubServer;

async function stub(handler = htmlPage('Stub tool'), port?: number): Promise<StubServer> {
  const server = await startStubServer(handler, port);
  stubs.push(server);
  return server;
}

async function putTools(tools: ReadonlyArray<Partial<Tool>>): Promise<Tool[]> {
  const response = await api.put('/api/tools', { data: tools });
  expect(response.status()).toBe(200);
  return (await response.json()) as Tool[];
}

/** Records the page's requests: probes (`POST /api/tools/…/probe`) and anything sent to a stub's origin. */
function recordRequests(page: Page): { probes: string[]; toStubs: Array<{ url: string; type: string }> } {
  const probes: string[] = [];
  const toStubs: Array<{ url: string; type: string }> = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (req.method() === 'POST' && /^\/api\/tools\/[^/]+\/probe$/.test(url.pathname)) probes.push(url.pathname);
    if (stubs.some((s) => url.port === String(s.port))) toStubs.push({ url: req.url(), type: req.resourceType() });
  });
  return { probes, toStubs };
}

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-tools');
  workspace = path.join(tmp, 'work space');
  const claudeConfig = path.join(tmp, 'claude-config');
  fakeLog = path.join(tmp, 'fake.log');
  await mkdir(path.join(workspace, '.claude'), { recursive: true });
  await mkdir(claudeConfig, { recursive: true });
  const rootId = projectId(workspace);
  await writeFile(
    path.join(workspace, DIRTY_FILE),
    `${rootId}-microfrontends-acme-app-front\n${rootId}-nugets-components-library-nuget\n`,
  );
  cmStub = await stub(htmlPage('Codebase Memory stub'));
  const dataDir = path.join(tmp, 'data');
  server = await startServer({
    SWITCHBOARD_DATA_DIR: dataDir,
    SWITCHBOARD_WORKSPACE_ROOT: workspace,
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    CLAUDE_CONFIG_DIR: claudeConfig,
    FAKE_CLAUDE_SCENARIO: 'handoff-start',
    FAKE_CLAUDE_LOG: fakeLog,
  });
  const token = (await readFile(path.join(dataDir, 'sb_token'), 'utf8')).trim();
  api = await playwrightRequest.newContext({ baseURL: server.baseUrl, extraHTTPHeaders: { cookie: `sb_token=${token}` } });

  // The defaults of a fresh install, before anything is probed.
  const defaults = (await (await api.get('/api/tools')).json()) as Tool[];
  expect(defaults.map((t) => [t.id, t.name, t.url])).toEqual([
    ['cm', 'Codebase Memory', 'http://localhost:13000'],
    ['sw', 'Acme Tool', null],
  ]);
  // Point Codebase Memory at the stub before any page loads (the sidebar probes on load).
  await putTools([
    { ...defaults[0], url: `http://127.0.0.1:${cmStub.port}` },
    { ...defaults[1], url: null },
  ]);
});

test.afterAll(async () => {
  await api?.dispose();
  if (server) expect(await server.stop()).toBe(0);
  for (const s of stubs.splice(0)) await s.close();
  await removeTempDir(tmp);
});

test('Codebase Memory: toolbar, server-side probe, iframe, Reload, New tab, Edit', async ({ page }) => {
  const seen = recordRequests(page);
  await page.goto(`${server.baseUrl}/tools/cm`);
  const view = page.getByTestId('view-tool');
  await expect(view).toHaveAttribute('data-tool-id', 'cm');
  await expect(view).toHaveAttribute('data-tool-state', 'up');

  const toolbar = page.getByTestId('tool-toolbar');
  await expect(toolbar.locator('.sb-tool-bar-name')).toHaveText('Codebase Memory');
  await expect(toolbar.locator('.sb-tool-bar-desc')).toHaveText('code graph for your indexed solutions');
  await expect(page.locator('.sb-tool-url-text')).toHaveText(`http://127.0.0.1:${cmStub.port}`);
  await expect(page.getByTestId('tool-state')).toHaveText('connected');
  await expect(page.getByTestId('tool-overlay')).toHaveCount(0);
  const dot = await toolbar.locator('.sb-tool-bar-dot').evaluate((el) => getComputedStyle(el).backgroundColor);
  const done = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--status-done)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(dot).toBe(done);

  // The iframe shows the tool.
  const frame = page.getByTestId('tool-frame');
  await expect(frame).toHaveAttribute('src', `http://127.0.0.1:${cmStub.port}`);
  await expect(page.frameLocator('[data-testid="tool-frame"]').getByTestId('stub')).toHaveText('Codebase Memory stub');
  // Audit 2026-09-28: sandboxed, and the tool still loads and runs (no top navigation of Switchboard).
  await expect(page.getByTestId('tool-frame')).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');

  // Sidebar row: reachability dot + host.
  const row = page.getByTestId('sidebar-tools').locator('a').first();
  await expect(row).toHaveAttribute('data-tool-state', 'up');
  await expect(row.locator('.sb-tool-host')).toHaveText(`127.0.0.1:${cmStub.port}`);
  await expect(row).toHaveAttribute('aria-current', 'page');

  // The probe runs on the service: the page only ever loads the stub as the iframe document.
  await expect.poll(() => seen.probes.filter((p) => p === '/api/tools/cm/probe').length).toBeGreaterThanOrEqual(1);
  expect(seen.toStubs.length).toBeGreaterThan(0);
  expect(seen.toStubs.every((r) => r.type === 'document')).toBe(true);
  await expect.poll(() => cmStub.requests.length).toBeGreaterThanOrEqual(2); // probe GET + iframe GET

  // ↻ Reload: a new frame and a new probe.
  const probesBefore = seen.probes.length;
  const stubBefore = cmStub.requests.length;
  await page.getByTestId('tool-reload').click();
  await expect(frame).toHaveAttribute('data-frame-n', '1');
  await expect.poll(() => seen.probes.length).toBe(probesBefore + 1);
  await expect.poll(() => cmStub.requests.length).toBeGreaterThanOrEqual(stubBefore + 2);
  await expect(page.frameLocator('[data-testid="tool-frame"]').getByTestId('stub')).toHaveText('Codebase Memory stub');
  await expect(page.getByTestId('tool-state')).toHaveText('connected');

  // ↗ New tab opens the tool's URL.
  const newTab = page.getByTestId('tool-new-tab');
  await expect(newTab).toHaveAttribute('target', '_blank');
  await expect(newTab).toHaveAttribute('rel', 'noopener');
  const popupOpened = page.waitForEvent('popup');
  await newTab.click();
  const popup = await popupOpened;
  await popup.waitForLoadState();
  expect(popup.url()).toBe(`http://127.0.0.1:${cmStub.port}/`);
  await expect(popup.getByTestId('stub')).toHaveText('Codebase Memory stub');
  await popup.close();

  // Edit → Settings → Embedded tools.
  await page.getByTestId('tool-edit').click();
  await expect(page).toHaveURL(`${server.baseUrl}/settings/tools`);
  await expect(page.getByTestId('view-settings')).toHaveAttribute('data-section', 'tools');
});

test('Acme Tool without a URL: "isn\'t configured" → Set URL in Settings; nothing is probed', async ({ page }) => {
  const seen = recordRequests(page);
  await page.goto(`${server.baseUrl}/tools/sw`);
  const view = page.getByTestId('view-tool');
  await expect(view).toHaveAttribute('data-tool-state', 'unset');
  await expect(page.getByTestId('tool-overlay-title')).toHaveText("Acme Tool isn't configured");
  await expect(page.getByTestId('tool-overlay-text')).toHaveText('Add the URL where Acme Tool runs on this PC. It is saved in Switchboard.');
  await expect(page.locator('.sb-tool-url-text')).toHaveText('no URL set');
  await expect(page.getByTestId('tool-state')).toHaveText('not configured');
  await expect(page.getByTestId('tool-frame')).toHaveCount(0);
  await expect(page.getByTestId('cm-strip')).toHaveCount(0); // only Codebase Memory has the strip
  await expect(page.getByTestId('tool-new-tab')).not.toHaveAttribute('href', /.*/);
  const swRow = page.getByTestId('sidebar-tools').locator('a').nth(1);
  await expect(swRow.locator('.sb-tool-host')).toHaveText('set URL');
  await expect(swRow).toHaveAttribute('data-tool-state', 'unset');
  expect(seen.probes.filter((p) => p === '/api/tools/sw/probe')).toEqual([]);

  await page.getByTestId('tool-overlay-action').click();
  await expect(page).toHaveURL(`${server.baseUrl}/settings/tools`);
});

test('a URL nobody answers: "is not reachable" (offline), then Retry once the tool runs', async ({ page }) => {
  const dead = await unusedTestPort(stubs.map((s) => s.port));
  const tools = (await (await api.get('/api/tools')).json()) as Tool[];
  await putTools([tools[0]!, { ...tools[1]!, url: `http://127.0.0.1:${dead}` }]);
  try {
    await page.goto(`${server.baseUrl}/tools/sw`);
    await expect(page.getByTestId('view-tool')).toHaveAttribute('data-tool-state', 'down');
    await expect(page.getByTestId('tool-overlay-title')).toHaveText(`127.0.0.1:${dead} is not reachable`);
    await expect(page.getByTestId('tool-overlay-text')).toHaveText(
      'Start Acme Tool on this PC and retry. If it runs but refuses to load in a frame (X-Frame-Options / frame-ancestors), use New tab.',
    );
    await expect(page.getByTestId('tool-state')).toHaveText('offline');
    await expect(page.getByTestId('tool-frame')).toHaveCount(0);
    await expect(page.getByTestId('tool-overlay-action')).toHaveText('Retry');

    // The tool starts; Retry probes again and shows it.
    await stub(htmlPage('Acme Tool stub'), dead);
    await page.getByTestId('tool-overlay-action').click();
    await expect(page.getByTestId('view-tool')).toHaveAttribute('data-tool-state', 'up');
    await expect(page.getByTestId('tool-overlay')).toHaveCount(0);
    await expect(page.getByTestId('tool-state')).toHaveText('connected');
    await expect(page.frameLocator('[data-testid="tool-frame"]').getByTestId('stub')).toHaveText('Acme Tool stub');
  } finally {
    await putTools([tools[0]!, { ...tools[1]!, url: null }]);
  }
});

test('Codebase Memory strip: the dirty projects and "Reindex 2 now" start a real session from the built-in prompt', async ({ page }) => {
  await page.goto(`${server.baseUrl}/tools/cm`);
  const strip = page.getByTestId('cm-strip');
  await expect(strip.locator('.sb-cm-strip-file')).toHaveText('.codebase-memory-dirty');
  await expect(strip.getByTestId('cm-dirty')).toHaveText(['acme-app-front', 'components-library-nuget']); // no time: the file keeps none
  await expect(strip.getByTestId('cm-dirty').first()).toHaveAttribute('title', path.join(workspace, 'microfrontends', 'acme-app-front'));
  await expect(strip.getByTestId('cm-note')).toHaveText(''); // the indexed count is unknown: never invented
  const button = strip.getByTestId('cm-reindex');
  await expect(button).toHaveText('Reindex 2 now');

  const started = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/codebase-memory/reindex');
  await button.click();
  const response = await started;
  expect(response.status()).toBe(201);
  const session = (await response.json()) as Session;
  expect(session).toMatchObject({ name: 'reindex-codebase-memory', workType: null, mode: null });
  await expect(button).toHaveText('✓ Reindex started');
  await expect(button).toHaveAttribute('href', `/sessions/${session.id}`); // the chat tab is the default path

  // The session runs through the real supervisor (fake-claude): it appears in the sidebar via /hub,
  // and its first stdin message is the built-in prompt listing the dirty projects.
  await expect(page.getByTestId('sidebar-sessions').locator('a', { hasText: 'reindex-codebase-memory' })).toHaveCount(1);
  const expected = reindexPrompt(await readDirtyProjects(workspace));
  await expect
    .poll(async () => {
      const log = await readFile(fakeLog, 'utf8').catch(() => '');
      const lines = log.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; line?: string; argv?: string[] });
      const stdin = lines.find((l) => l.kind === 'stdin');
      return stdin?.line ? (JSON.parse(stdin.line) as { message: { content: string } }).message.content : null;
    })
    .toBe(expected);
  const argv = (await readFile(fakeLog, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; argv?: string[] });
  // M5.3's system probe also runs the fake CLI (`--version`, `auth status`): take the session's start.
  expect(argv.find((l) => l.kind === 'argv' && l.argv?.includes('--session-id'))?.argv).toEqual(expect.arrayContaining(['--name', 'reindex-codebase-memory', '--session-id']));
  await expect
    .poll(async () => ((await (await api.get(`/api/sessions/${session.id}`)).json()) as Session).status, { timeout: 15_000 })
    .toMatch(/^(done|idle)$/);

  // The agent removes the lines it refreshed; the strip then has nothing to reindex.
  await writeFile(path.join(workspace, DIRTY_FILE), '');
  await page.reload();
  await expect(page.getByTestId('cm-strip').getByTestId('cm-dirty')).toHaveCount(0);
  await expect(page.getByTestId('cm-clean')).toHaveText('nothing to reindex');
  await expect(page.getByTestId('cm-reindex')).toHaveCount(0);
  expect((await api.post('/api/codebase-memory/reindex')).status()).toBe(409);
});
