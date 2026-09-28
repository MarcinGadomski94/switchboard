import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type APIRequestContext, type Page, expect, request as playwrightRequest, test } from '@playwright/test';
import type { Session, Tool } from '../../src/core/api.ts';
import { DIRTY_FILE, projectId, readDirtyProjects, reindexPrompt } from '../../src/server/tools/codebase-memory.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { type StubHandler, type StubServer, htmlPage, startStubServer, unusedTestPort } from '../helpers/stub-http.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';

/**
 * M8.1 oracle: embedded tools on the real code path (no demo seed, D13). The real
 * `node src/server/main.ts` with a temp data folder, a temp workspace holding a
 * `.claude/.codebase-memory-dirty`, fake-claude as the CLI, and local stub servers
 * standing in for the tools, all on the lane's test ports. Covers the toolbar, the
 * server-side probe (the page never fetches the tool's origin itself), the iframe,
 * Reload, New tab, Edit, the "isn't configured" and "is not reachable" overlays
 * with Retry, and the Codebase Memory strip whose "Reindex n now" starts a real
 * (fake-claude) session from the built-in prompt (gap #4). D15: the Codebase Memory
 * stand-in refuses framing like the real one (`frame-ancestors 'none'` +
 * `X-Frame-Options: DENY`), and the iframe still shows it through its framing proxy.
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

/** Records the page's requests: probes (`POST /api/tools/…/probe`), anything sent to a stub's origin, and to `proxyPort` (D15). */
function recordRequests(page: Page, proxyPort?: number): { probes: string[]; toStubs: Array<{ url: string; type: string }>; toProxy: Array<{ url: string; type: string }> } {
  const probes: string[] = [];
  const toStubs: Array<{ url: string; type: string }> = [];
  const toProxy: Array<{ url: string; type: string }> = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (req.method() === 'POST' && /^\/api\/tools\/[^/]+\/probe$/.test(url.pathname)) probes.push(url.pathname);
    if (stubs.some((s) => url.port === String(s.port))) toStubs.push({ url: req.url(), type: req.resourceType() });
    if (proxyPort !== undefined && url.port === String(proxyPort)) toProxy.push({ url: req.url(), type: req.resourceType() });
  });
  return { probes, toStubs, toProxy };
}

/** D15: the Codebase Memory stand-in answers like the real UI: it refuses every frame. */
function refusesFraming(text: string): StubHandler {
  return (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    });
    res.end(`<!doctype html><html><head><title>${text}</title></head><body><h1 data-testid="stub">${text}</h1></body></html>`);
  };
}

/** The saved tool `id` as the API shows it now (its `frameUrl` included). */
async function toolOf(id: string): Promise<Tool> {
  const tool = ((await (await api.get('/api/tools')).json()) as Tool[]).find((t) => t.id === id);
  if (!tool) throw new Error(`no tool ${id}`);
  return tool;
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
  cmStub = await stub(refusesFraming('Codebase Memory stub'));
  const dataDir = path.join(tmp, 'data');
  // D14: the workspace is a saved folder (the default) in the server's database.
  await seedFolderInDataDir(dataDir, workspace);
  server = await startServer({
    SWITCHBOARD_DATA_DIR: dataDir,
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
  // D15: the iframe loads the tool's framing proxy, its own loopback port.
  const cm = await toolOf('cm');
  expect(cm.frameUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  const proxyPort = Number(new URL(cm.frameUrl!).port);
  expect([server.port, cmStub.port]).not.toContain(proxyPort);
  const seen = recordRequests(page, proxyPort);
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

  // The iframe shows the tool, although it answers `frame-ancestors 'none'` + `X-Frame-Options: DENY`: through its proxy (D15).
  const frame = page.getByTestId('tool-frame');
  await expect(frame).toHaveAttribute('src', cm.frameUrl!);
  await expect(page.frameLocator('[data-testid="tool-frame"]').getByTestId('stub')).toHaveText('Codebase Memory stub');
  // Audit 2026-09-28: sandboxed, and the tool still loads and runs (no top navigation of Switchboard).
  await expect(page.getByTestId('tool-frame')).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');

  // Sidebar row: reachability dot + host.
  const row = page.getByTestId('sidebar-tools').locator('a').first();
  await expect(row).toHaveAttribute('data-tool-state', 'up');
  await expect(row.locator('.sb-tool-host')).toHaveText(`127.0.0.1:${cmStub.port}`);
  await expect(row).toHaveAttribute('aria-current', 'page');

  // The probe runs on the service, the frame through the proxy: the page never loads the tool's own origin.
  await expect.poll(() => seen.probes.filter((p) => p === '/api/tools/cm/probe').length).toBeGreaterThanOrEqual(1);
  expect(seen.toStubs).toEqual([]);
  expect(seen.toProxy.length).toBeGreaterThan(0);
  expect(seen.toProxy.every((r) => r.type === 'document')).toBe(true);
  await expect.poll(() => cmStub.requests.length).toBeGreaterThanOrEqual(2); // probe GET + iframe GET (via the proxy)
  await expect(page.getByTestId('tool-overlay')).toHaveCount(0); // the service knows the proxy frames it: no "refuses" fallback

  // ↻ Reload: a new frame and a new probe.
  const probesBefore = seen.probes.length;
  const stubBefore = cmStub.requests.length;
  await page.getByTestId('tool-reload').click();
  await expect(frame).toHaveAttribute('data-frame-n', '1');
  await expect.poll(() => seen.probes.length).toBe(probesBefore + 1);
  await expect.poll(() => cmStub.requests.length).toBeGreaterThanOrEqual(stubBefore + 2);
  await expect(page.frameLocator('[data-testid="tool-frame"]').getByTestId('stub')).toHaveText('Codebase Memory stub');
  await expect(page.getByTestId('tool-state')).toHaveText('connected');

  // ↗ New tab opens the tool's own URL (not the proxy).
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
    // D15: its proxy started when the URL was saved and forwards to the tool once it runs.
    await expect(page.getByTestId('tool-frame')).toHaveAttribute('src', (await toolOf('sw')).frameUrl!);
  } finally {
    await putTools([tools[0]!, { ...tools[1]!, url: null }]);
  }
});

test('D15 fallback: no framing proxy and the tool refuses framing → "refuses to load in a frame" with New tab', async ({ page }) => {
  // The service reports `framing: "refused"` only while no proxy runs for the tool (demo mode, a proxy
  // that failed to start; tests/server/api/tool-frames.test.ts drives that for real). Here the page gets
  // that answer, with `frameUrl: null`, from the browser; everything else is the real service.
  const tools = (await (await api.get('/api/tools')).json()) as Tool[];
  await page.route(/\/api\/tools$/, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ status: 200, json: tools.map((t) => ({ ...t, frameUrl: null })) }) : route.continue(),
  );
  await page.route(/\/api\/tools\/cm\/probe$/, (route) => route.fulfill({ status: 200, json: { state: 'up', framing: 'refused' } }));
  await page.goto(`${server.baseUrl}/tools/cm`);
  await expect(page.getByTestId('view-tool')).toHaveAttribute('data-tool-state', 'up');
  await expect(page.getByTestId('tool-state')).toHaveText('connected');
  await expect(page.getByTestId('tool-overlay-title')).toHaveText(`127.0.0.1:${cmStub.port} refuses to load in a frame`);
  await expect(page.getByTestId('tool-overlay-text')).toHaveText(
    'Codebase Memory runs but refuses to load in a frame (X-Frame-Options / frame-ancestors), use New tab.',
  );
  await expect(page.getByTestId('tool-frame')).toHaveCount(0);
  const action = page.getByTestId('tool-overlay-action');
  await expect(action).toHaveText('↗ New tab');
  await expect(action).toHaveAttribute('href', `http://127.0.0.1:${cmStub.port}`);
  await expect(action).toHaveAttribute('target', '_blank');
  await expect(action).toHaveAttribute('rel', 'noopener');
  const popupOpened = page.waitForEvent('popup');
  await action.click();
  const popup = await popupOpened;
  await popup.waitForLoadState();
  await expect(popup.getByTestId('stub')).toHaveText('Codebase Memory stub');
  await popup.close();

  // Without a refusal and without a proxy the tool's own URL is framed directly…
  await page.unroute(/\/api\/tools\/cm\/probe$/);
  await page.getByTestId('tool-reload').click();
  await expect(page.getByTestId('tool-overlay')).toHaveCount(0);
  await expect(page.getByTestId('tool-frame')).toHaveAttribute('src', `http://127.0.0.1:${cmStub.port}`);
  // …and the browser blocks it (frame-ancestors 'none'): the blank frame D15's proxy is there for.
  await expect.poll(() => page.frames().some((frame) => frame.url().startsWith('chrome-error:'))).toBe(true);
  await expect(page.frameLocator('[data-testid="tool-frame"]').getByTestId('stub')).toHaveCount(0);
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
