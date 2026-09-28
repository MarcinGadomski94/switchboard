import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { type APIRequestContext, type BrowserContext, type Page, chromium, expect, request as playwrightRequest, test } from '@playwright/test';
import { FRAME_HELPER_ATTRIBUTE } from '../../src/core/site-tools.ts';
import { extensionsCommands, revealCommand } from '../../src/server/tools/frame-helper.ts';
import { REVEAL_FALLBACK, pasteHint, revealLabel, setupPlatform } from '../../src/web/tools/frame-helper-setup.ts';
import { REPO_ROOT, freeTestPorts, makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { type SiteStub, startSiteStub } from '../helpers/site-stub.ts';

/**
 * D35 oracle (docs/frame-helper.md → Guided setup): the guided frame-helper setup
 * on the real code path. The test server runs the setup's OS openers through
 * tools/fake-opener (`SWITCHBOARD_OPEN_COMMAND`, a default of every test server),
 * which records their argv in `FAKE_OPENER_LOG` and opens nothing: no real
 * Chrome, Safari, Finder or Explorer. Browsers are Playwright's bundled Chromium
 * only; the helper is the real unpacked extension, loaded as the D28 harness does
 * (`--load-extension`), or while a page is open through CDP's
 * `Extensions.loadUnpacked`. The signed-in site is the D28 https stub `site.test`,
 * which refuses every frame.
 */
const EXTENSION = path.join(REPO_ROOT, 'tools', 'frame-helper');
const SITE = 'site.test';

let tmp: string;
let log: string;
let server: ServerProcess;
let api: APIRequestContext;
let site: SiteStub;
let siteUrl: string;
let helperVersion: string;

/** The reveal button's label for the page's `[navigator.platform, navigator.userAgent]`. */
function revealLabelFor([platform, userAgent]: string[]): string {
  return revealLabel(setupPlatform(platform ?? '', userAgent ?? ''));
}

/** The fake opener's calls so far (each its argv). */
async function openerCalls(): Promise<string[][]> {
  try {
    return (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
  } catch {
    return [];
  }
}

/** The tool probes are answered in the browser (the service never resolves `site.test`): every tool is up. */
async function answerProbes(page: Page): Promise<void> {
  await page.route(/\/api\/tools\/[^/]+\/probe$/, (route) => route.fulfill({ status: 200, json: { state: 'up' } }));
}

/** A persistent Chromium profile that reaches `site.test` (the D28 harness's switches) plus `args`. */
function launchChromium(profile: string, args: string[], extra: Parameters<typeof chromium.launchPersistentContext>[1] = {}): Promise<BrowserContext> {
  return chromium.launchPersistentContext(path.join(tmp, profile), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    ...extra,
    args: [`--host-resolver-rules=MAP ${SITE} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1`, ...args],
  });
}

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-frame-helper-setup');
  log = path.join(tmp, 'opener.log');
  helperVersion = (JSON.parse(await readFile(path.join(EXTENSION, 'manifest.json'), 'utf8')) as { version: string }).version;
  site = await startSiteStub([SITE], (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    });
    res.end('<!doctype html><html><head><title>Jira stub</title></head><body><h1 data-testid="stub">Jira stub</h1></body></html>');
  });
  siteUrl = `https://${SITE}:${site.port}/`;
  const dataDir = path.join(tmp, 'data');
  server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir, FAKE_OPENER_LOG: log });
  const token = (await readFile(path.join(dataDir, 'sb_token'), 'utf8')).trim();
  api = await playwrightRequest.newContext({ baseURL: server.baseUrl, extraHTTPHeaders: { cookie: `sb_token=${token}` } });
  expect((await api.put('/api/tools', { data: [{ id: 'jira', name: 'Jira', url: siteUrl, description: 'PROJ board' }] })).status()).toBe(200);
});

test.beforeEach(async () => {
  await rm(log, { force: true });
});

test.afterAll(async () => {
  await api?.dispose();
  if (server) expect(await server.stop()).toBe(0);
  await site?.close();
  await removeTempDir(tmp);
});

test('Settings → Embedded tools → Frame helper without the helper: "Not detected yet"; Set up\'s buttons call the service and copy the path', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.baseUrl });
  const page = await context.newPage();
  try {
    await answerProbes(page);
    await page.goto(`${server.baseUrl}/settings/tools`);
    const row = page.getByTestId('settings-frame-helper');
    await expect(row.locator('.sb-set-row-label')).toHaveText('Frame helper');
    await expect(row.getByTestId('frame-helper-status')).toHaveText('Not detected yet');
    await expect(row.getByTestId('frame-helper-status')).toHaveAttribute('data-status', 'absent');
    // The row sits after the tool cards (the prototype's parts keep their places).
    await expect(page.getByTestId('settings-content').locator(':scope > *').last()).toHaveAttribute('data-testid', 'settings-frame-helper');
    await expect(page.getByTestId('frame-helper-setup')).toHaveCount(0);

    const toggle = row.getByTestId('frame-helper-setup-toggle');
    await expect(toggle).toHaveText('Set up');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = page.getByTestId('frame-helper-setup');
    await expect(panel.locator('.sb-fh-step')).toHaveCount(4);
    await expect(panel.locator('.sb-fh-step .sb-fh-text')).toHaveText([
      "Open Chrome's extensions page",
      'Turn on Developer mode (top right)',
      'Click Load unpacked and pick the folder',
      'Reload this tab',
    ]);
    await expect(panel.locator('.sb-fh-step button')).toHaveText(['Open extensions', revealLabelFor(await page.evaluate(() => [navigator.platform, navigator.userAgent])), 'Copy path', 'Reload tab']);
    // The Settings row carries the status; the panel does not repeat it.
    await expect(panel.getByTestId('frame-helper-status')).toHaveCount(0);
    await expect(panel.getByTestId('frame-helper-path')).toHaveText(EXTENSION);
    const platform = setupPlatform(await page.evaluate(() => navigator.platform), await page.evaluate(() => navigator.userAgent));
    await expect(panel.getByTestId('frame-helper-reveal')).toHaveText(revealLabel(platform));
    await expect(panel.getByTestId('frame-helper-paste-hint')).toHaveText(pasteHint(platform));

    // Step 1: the service runs this OS's opener for chrome://extensions (the fake records it).
    const opened = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/frame-helper/open-extensions');
    await panel.getByTestId('frame-helper-open-extensions').click();
    expect((await opened).status()).toBe(204);
    const [firstCandidate] = await extensionsCommands(process.platform, process.env);
    await expect.poll(openerCalls).toEqual([firstCandidate!.argv]);
    await expect(panel.getByTestId('frame-helper-extensions-error')).toHaveCount(0);

    // Step 3: Reveal (the OS file manager on the folder) and Copy path.
    const revealed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/frame-helper/reveal');
    await panel.getByTestId('frame-helper-reveal').click();
    expect((await revealed).status()).toBe(204);
    await expect.poll(openerCalls).toEqual([firstCandidate!.argv, revealCommand(process.platform, EXTENSION).argv]);
    await panel.getByTestId('frame-helper-copy').click();
    await expect(panel.getByTestId('frame-helper-copy')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(EXTENSION);
    await expect(panel.getByTestId('frame-helper-copy')).toHaveText('Copy path');

    // Close hides the panel.
    await toggle.click();
    await expect(toggle).toHaveText('Set up');
    await expect(page.getByTestId('frame-helper-setup')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('when the opener fails (502): "type chrome://extensions in the address bar"; a failed reveal says to copy the path', async ({ page }) => {
  // The service's 502 itself is covered in tests/server/api/frame-helper.test.ts; here the page's answer to it.
  await page.route('**/api/frame-helper/open-extensions', (route) =>
    route.fulfill({ status: 502, json: { error: 'open-failed', message: 'open -a Google Chrome chrome://extensions: Unable to find application named Google Chrome' } }),
  );
  await page.route('**/api/frame-helper/reveal', (route) => route.fulfill({ status: 502, json: { error: 'open-failed', message: 'open -R …: exit code 1' } }));
  await answerProbes(page);
  await page.goto(`${server.baseUrl}/settings/tools`);
  await page.getByTestId('frame-helper-setup-toggle').click();
  const panel = page.getByTestId('frame-helper-setup');
  await panel.getByTestId('frame-helper-open-extensions').click();
  const fallback = panel.getByTestId('frame-helper-extensions-error');
  await expect(fallback).toHaveText('Chrome did not open: type chrome://extensions in the address bar');
  await expect(fallback).toHaveAttribute('title', 'open -a Google Chrome chrome://extensions: Unable to find application named Google Chrome');
  await panel.getByTestId('frame-helper-reveal').click();
  await expect(panel.getByTestId('frame-helper-reveal-error')).toHaveText(REVEAL_FALLBACK);
  expect(await openerCalls()).toEqual([]);
});

test('a site tool\'s "needs the Switchboard frame helper" page has Set up frame helper next to Open in new tab', async ({ page }) => {
  await answerProbes(page);
  await page.goto(`${server.baseUrl}/tools/jira`);
  await expect(page.getByTestId('view-tool')).toHaveAttribute('data-frame-helper', 'absent');
  await expect(page.getByTestId('tool-overlay-action')).toHaveText('Open in new tab');
  const setUp = page.getByTestId('tool-overlay-setup');
  await expect(setUp).toHaveText('Set up frame helper');
  // Next to it, in the same actions row; outlined (SPEC: the first action is primary, the rest outlined).
  await expect(page.locator('.sb-tool-overlay-actions > *')).toHaveText(['Open in new tab', 'Set up frame helper']);
  const styles = await setUp.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopColor }));
  expect(styles).toEqual({ bg: 'rgba(0, 0, 0, 0)', border: 'rgb(44, 45, 50)' });
  await setUp.click();
  const panel = page.getByTestId('frame-helper-setup');
  // Here the panel carries its own status line.
  await expect(panel.getByTestId('frame-helper-status')).toHaveText('Not detected yet');
  await expect(panel.locator('.sb-fh-step')).toHaveCount(4);
  await expect(panel.getByTestId('frame-helper-path')).toHaveText(EXTENSION);
  await panel.getByTestId('frame-helper-open-extensions').click();
  const [firstCandidate] = await extensionsCommands(process.platform, process.env);
  await expect.poll(openerCalls).toEqual([firstCandidate!.argv]);
  await expect(page.getByTestId('tool-frame')).toHaveCount(0);
});

test('"can\'t open in a frame in this browser" (a helper that cannot remove the headers) has no Set up button', async ({ page }) => {
  // The marker without a working helper, as the D28 spec fakes Safari.
  await page.addInitScript((attribute) => {
    const mark = (): void => document.documentElement?.setAttribute(attribute, '2.0.0');
    mark();
    document.addEventListener('DOMContentLoaded', mark);
  }, FRAME_HELPER_ATTRIBUTE);
  await answerProbes(page);
  await page.goto(`${server.baseUrl}/tools/jira`);
  await expect(page.getByTestId('view-tool')).toHaveAttribute('data-frame-helper', 'blocked');
  await expect(page.getByTestId('tool-overlay-action')).toHaveText('Open in new tab');
  await expect(page.getByTestId('tool-overlay-setup')).toHaveCount(0);
});

test('with the unpacked helper loaded (the D28 harness): "Frame helper 2.0.0 is on ✓"', async () => {
  const context = await launchChromium('profile-loaded', [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`]);
  try {
    const page = await context.newPage();
    await answerProbes(page);
    await page.goto(`${server.baseUrl}/settings/tools`);
    await expect(page.locator('html')).toHaveAttribute(FRAME_HELPER_ATTRIBUTE, helperVersion);
    const status = page.getByTestId('settings-frame-helper').getByTestId('frame-helper-status');
    await expect(status).toHaveText(`Frame helper ${helperVersion} is on ✓`);
    expect(helperVersion).toBe('2.0.0');
    await expect(status).toHaveAttribute('data-status', 'on');
    // Green: the SPEC's status done color.
    const color = await status.evaluate((el) => getComputedStyle(el).color);
    const done = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--status-done)';
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    });
    expect(color).toBe(done);
  } finally {
    await context.close();
  }
});

test('loading the helper while the "needs the frame helper" page is open: Chrome adds it to new pages only, so step 4 reloads and the site frames by itself', async () => {
  // A free test port for the browser's DevTools endpoint (CDP `Extensions.loadUnpacked` needs it).
  const [debugPort] = (await freeTestPorts()).filter((port) => port !== server.port);
  expect(debugPort).toBeDefined();
  const context = await launchChromium('profile-late', ['--enable-unsafe-extension-debugging', `--remote-debugging-port=${debugPort}`], {
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  const devtools = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  try {
    const page = await context.newPage();
    await answerProbes(page);
    await page.goto(`${server.baseUrl}/tools/jira`);
    const view = page.getByTestId('view-tool');
    await expect(view).toHaveAttribute('data-frame-helper', 'absent');
    await page.getByTestId('tool-overlay-setup').click();
    const status = page.getByTestId('frame-helper-setup').getByTestId('frame-helper-status');
    await expect(status).toHaveText('Not detected yet');

    // The developer's "Load unpacked", done by CDP.
    const cdp = await devtools.newBrowserCDPSession();
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXTENSION });
    expect(loaded.id).toMatch(/^[a-p]{32}$/);
    // Two of the panel's 2 s re-reads later the open page still has no marker: Chrome injects content scripts only into pages loaded after the install.
    await page.waitForTimeout(4_500);
    await expect(status).toHaveText('Not detected yet');
    await expect(page.locator('html')).not.toHaveAttribute(FRAME_HELPER_ATTRIBUTE, /.*/);

    // Step 4: reload this tab. The view checks the helper again and frames the site by itself.
    await page.getByTestId('frame-helper-reload').click();
    await expect(page.locator('html')).toHaveAttribute(FRAME_HELPER_ATTRIBUTE, helperVersion);
    await expect(view).toHaveAttribute('data-frame-helper', 'ready');
    await expect(page.getByTestId('tool-frame')).toHaveAttribute('src', siteUrl);
    await expect(page.frameLocator('[data-testid="tool-frame"]').getByTestId('stub')).toHaveText('Jira stub');
    await expect(page.getByTestId('tool-overlay')).toHaveCount(0);

    // And Settings reads it as on.
    await page.goto(`${server.baseUrl}/settings/tools`);
    await expect(page.getByTestId('settings-frame-helper').getByTestId('frame-helper-status')).toHaveText(`Frame helper ${helperVersion} is on ✓`);
  } finally {
    await devtools.close();
    await context.close();
  }
  expect(await openerCalls()).toEqual([]);
});
