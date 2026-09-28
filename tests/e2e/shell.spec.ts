import path from 'node:path';
import { expect, test } from '@playwright/test';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';

/**
 * The app shell on the real code path (no demo seed, D13): the built UI served by
 * `node src/server/main.ts`, its API calls reaching the real routes (501 until the
 * lanes land), client-side navigation between every view, deep links, modals and
 * the palette shortcut.
 */
let tmp: string;
let server: ServerProcess;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-shell');
  server = await startServer({ SWITCHBOARD_DATA_DIR: path.join(tmp, 'data') });
});

test.afterAll(async () => {
  await server?.stop();
  await removeTempDir(tmp);
});

// The sidebar probes the default tools on load; answered in the browser (tests/e2e/probes.ts).
test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

test('the shell renders from the real API and shows only what the API returns', async ({ page }) => {
  const apiCalls: Array<{ url: string; status: number; body: unknown }> = [];
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/')) return;
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    apiCalls.push({ url: url.pathname + url.search, status: response.status(), body });
  });

  await page.goto(`${server.baseUrl}/`);
  await expect(page.getByTestId('shell')).toBeVisible();
  await expect(page.getByTestId('view-inbox')).toBeAttached();
  await expect(page.getByTestId('nav-inbox')).toHaveAttribute('aria-current', 'page');

  // Every sidebar source was asked for and reached the real server: /api/sessions (M2.1),
  // /api/inbox (M3.2), /api/schedules (M7.1) and /api/artifacts (M7.3) answer with the empty list,
  // /api/tools (M8.1) with the default tools, the others still with the 501 placeholder.
  const expected = ['/api/sessions', '/api/tools', '/api/inbox', '/api/solutions', '/api/schedules', '/api/artifacts', '/api/system'];
  await expect.poll(() => expected.filter((url) => !apiCalls.some((call) => call.url === url))).toEqual([]);
  for (const call of apiCalls) {
    if (call.url === '/api/sessions' || call.url === '/api/inbox' || call.url === '/api/schedules') {
      // M7.1: no default schedules (gap #6), so /api/schedules is empty too.
      expect(call.status, call.url).toBe(200);
      expect(call.body, call.url).toEqual([]);
    } else if (call.url === '/api/solutions') {
      // M6.1: the real scanner; this server has no workspace root configured.
      expect(call.status, call.url).toBe(409);
      expect(call.body, call.url).toMatchObject({ error: 'workspace-not-configured' });
    } else if (call.url === '/api/tools') {
      expect(call.status, call.url).toBe(200);
      expect((call.body as Array<{ id: string }>).map((tool) => tool.id), call.url).toEqual(['cm', 'sw']);
    } else if (call.url.startsWith('/api/tools/')) {
      continue; // the probes (stubbed in the browser)
    } else if (call.url === '/api/artifacts') {
      expect(call.status, call.url).toBe(200); // M7.3: nothing produced yet
      expect(call.body, call.url).toEqual([]);
    } else if (call.url === '/api/system') {
      // M5.3: the real SystemProbe over the fake CLIs (tests/helpers/server-process.ts); no usage reading yet (M9.2).
      expect(call.status, call.url).toBe(200);
      expect(call.body, call.url).toMatchObject({ cliVersion: '2.1.283', signedIn: true, ghSignedIn: true, processes: 0 });
      expect(call.body, call.url).not.toHaveProperty('usagePct');
    } else if (call.url === '/api/setup') {
      // M5.3: the first-run check; test servers keep the wizard from opening by itself (SWITCHBOARD_SETUP_WIZARD=off).
      expect(call.status, call.url).toBe(200);
      expect(call.body, call.url).toMatchObject({ completedAt: null, autoOpen: false });
    } else {
      expect(call.status, call.url).toBe(501);
      expect(call.body, call.url).toMatchObject({ error: 'not-implemented' });
    }
  }

  // Nothing invented: no rows, no badges, the machine's CPU / RAM (M5.3), usage unknown until M9.2, the real address.
  await expect(page.getByTestId('sidebar-sessions').locator('a')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-tools').locator('a')).toHaveText(['Codebase Memorylocalhost:13000', 'Acme Toolset URL']);
  await expect(page.locator('.sb-badge')).toHaveText(['', '', '', '', '']);
  await expect(page.getByTestId('service-address')).toHaveText(`127.0.0.1:${server.port}`);
  await expect(page.getByTestId('process-count')).toHaveText('0 bg processes');
  await expect(page.locator('.sb-meter-value')).toHaveText([/^\d+%$/, /^\d+\.\d\/\d+ GB$/, 'unknown']);
});

test('the nav switches views client-side and deep links load the right view', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  await expect(page.getByTestId('shell')).toBeVisible();
  const documentRequests: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests.push(request.url());
  });

  const views: Array<[testId: string, path: string, view: string]> = [
    ['nav-solutions', '/solutions', 'view-solutions'],
    ['nav-schedules', '/schedules', 'view-schedules'],
    ['nav-artifacts', '/artifacts', 'view-artifacts'],
    ['nav-history', '/history', 'view-history'],
    ['nav-settings', '/settings', 'view-settings'],
    ['nav-inbox', '/inbox', 'view-inbox'],
  ];
  for (const [nav, urlPath, view] of views) {
    await page.getByTestId(nav).click();
    await expect(page).toHaveURL(`${server.baseUrl}${urlPath}`);
    await expect(page.getByTestId(view)).toBeAttached();
    await expect(page.getByTestId(nav)).toHaveAttribute('aria-current', 'page');
  }
  await page.getByTestId('add-tool').click();
  await expect(page).toHaveURL(`${server.baseUrl}/settings/tools`);
  await expect(page.getByTestId('view-settings')).toHaveAttribute('data-section', 'tools');
  expect(documentRequests).toEqual([]); // no full page loads

  await page.goBack();
  await expect(page).toHaveURL(`${server.baseUrl}/inbox`);
  await expect(page.getByTestId('view-inbox')).toBeAttached();

  // Deep links (the server answers index.html for UI routes).
  await page.goto(`${server.baseUrl}/sessions/some-session/timeline`);
  const session = page.getByTestId('view-session');
  await expect(session).toHaveAttribute('data-session-id', 'some-session');
  await expect(session).toHaveAttribute('data-tab', 'timeline');
  for (const part of ['session-header', 'session-timeline', 'session-right-panel']) {
    await expect(page.getByTestId(part)).toBeAttached();
  }
  await expect(page.getByTestId('session-chat')).toHaveCount(0);

  await page.goto(`${server.baseUrl}/sessions/some-session`);
  await expect(page.getByTestId('view-session')).toHaveAttribute('data-tab', 'chat');
  await expect(page.getByTestId('session-chat')).toBeAttached();

  await page.goto(`${server.baseUrl}/tools/cm`);
  await expect(page.getByTestId('view-tool')).toHaveAttribute('data-tool-id', 'cm');

  await page.goto(`${server.baseUrl}/no/such/page`);
  await expect(page.getByTestId('view-inbox')).toBeAttached();
});

test('modals: New session, palette button and ⌘K / Ctrl+K, Esc and overlay close', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  await expect(page.getByTestId('shell')).toBeVisible();

  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('modal-new-session')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('modal-new-session')).toHaveCount(0);

  await page.getByTestId('new-session').click();
  await page.getByTestId('modal-new-session').click(); // inside the panel: stays open
  await expect(page.getByTestId('modal-new-session')).toBeVisible();
  await page.mouse.click(5, 5); // on the overlay: closes
  await expect(page.getByTestId('modal-new-session')).toHaveCount(0);

  await page.getByTestId('open-palette').click();
  await expect(page.getByTestId('modal-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('modal-palette')).toHaveCount(0);

  await page.keyboard.press('Meta+k');
  await expect(page.getByTestId('modal-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('modal-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('modal-palette')).toHaveCount(0);
});
