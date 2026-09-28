import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type APIRequestContext, type BrowserContext, type Page, chromium, expect, request as playwrightRequest, test } from '@playwright/test';
import type { Tool } from '../../src/core/api.ts';
import { FRAME_HELPER_ATTRIBUTE } from '../../src/core/site-tools.ts';
import { makeTempDir, removeTempDir, REPO_ROOT } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { type SiteStub, startSiteStub } from '../helpers/site-stub.ts';
import { type ToolStub, htmlAnswer, startToolStub } from '../helpers/tool-stub.ts';

/**
 * D28 oracle (docs/frame-helper.md): a signed-in site in the tool frame through the
 * real Switchboard frame helper, loaded unpacked into Playwright's Chromium
 * (`launchPersistentContext` with `--load-extension`, new headless mode via
 * `channel: 'chromium'`). The "site" is an https stub on 127.0.0.1 named
 * `site.test` (a self-signed certificate, `--host-resolver-rules` maps the name,
 * certificate errors ignored in that test browser only) that refuses every frame
 * like Jira's login does: `X-Frame-Options: DENY` + `frame-ancestors 'none'`. Every
 * other host name fails to resolve in that browser, and the page's probes are
 * answered in the browser, so nothing leaves the machine.
 */
const EXTENSION = path.join(REPO_ROOT, 'tools', 'frame-helper');
const SITE = 'site.test';
const OUTSIDE = 'outside.test';

let tmp: string;
let server: ServerProcess;
let api: APIRequestContext;
let site: SiteStub;
let local: ToolStub;
let withHelper: BrowserContext;
let siteUrl: string;
let helperVersion: string;

/** The Jira stand-in: refuses every frame. `outside.test` is a page on another site that frames it. */
function siteHandler(): Parameters<typeof startSiteStub>[1] {
  return (req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (host === OUTSIDE) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>outside</title><h1>Another site</h1><iframe data-testid="outside-frame" src="https://${SITE}:${site.port}/"></iframe>`);
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    });
    res.end('<!doctype html><html><head><title>Jira stub</title></head><body><h1 data-testid="stub">Jira stub</h1></body></html>');
  };
}

/**
 * Answers every tool probe in the browser (the service never fetches `site.test`):
 * all tools are up; the site, like Jira, refuses framing (the service reports that
 * for a tool without a proxy; the site's view must not care).
 */
async function answerProbes(page: Page): Promise<void> {
  await page.route(/\/api\/tools\/[^/]+\/probe$/, (route) =>
    route.fulfill({ status: 200, json: new URL(route.request().url()).pathname === '/api/tools/jira/probe' ? { state: 'up', framing: 'refused' } : { state: 'up' } }),
  );
}

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-frame-helper');
  helperVersion = (JSON.parse(await readFile(path.join(EXTENSION, 'manifest.json'), 'utf8')) as { version: string }).version;
  site = await startSiteStub([SITE, OUTSIDE], siteHandler());
  siteUrl = `https://${SITE}:${site.port}/`;
  local = await startToolStub(htmlAnswer('Local tool stub', { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" }));
  const dataDir = path.join(tmp, 'data');
  server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir });
  const token = (await readFile(path.join(dataDir, 'sb_token'), 'utf8')).trim();
  api = await playwrightRequest.newContext({ baseURL: server.baseUrl, extraHTTPHeaders: { cookie: `sb_token=${token}` } });
  const put = await api.put('/api/tools', {
    data: [
      { id: 'jira', name: 'Jira', url: siteUrl, description: 'PROJ board' },
      { id: 'cm', name: 'Codebase Memory', url: local.origin },
    ],
  });
  expect(put.status()).toBe(200);
  withHelper = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      `--host-resolver-rules=MAP ${SITE} 127.0.0.1, MAP ${OUTSIDE} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1`,
    ],
  });
});

test.afterAll(async () => {
  await withHelper?.close();
  await api?.dispose();
  if (server) expect(await server.stop()).toBe(0);
  await site?.close();
  await local?.close();
  await removeTempDir(tmp);
});

test('with the frame helper: the site opens in a direct frame of its own URL, no proxy, no login banner', async () => {
  const tools = (await (await api.get('/api/tools')).json()) as Tool[];
  expect(tools.map((t) => [t.id, t.frameUrl === null])).toEqual([
    ['jira', true], // a site: no D15 proxy
    ['cm', false], // a local tool keeps its proxy
  ]);
  const page = await withHelper.newPage();
  await answerProbes(page);
  const checks: string[] = [];
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/frame-helper/check') checks.push(req.resourceType());
  });
  await page.goto(`${server.baseUrl}/tools/jira`);
  await expect(page.locator('html')).toHaveAttribute(FRAME_HELPER_ATTRIBUTE, helperVersion);
  const view = page.getByTestId('view-tool');
  await expect(view).toHaveAttribute('data-frame-helper', 'ready');
  expect(checks).toEqual(['document']); // one capability check, a frame of Switchboard's own refusing page
  await expect(page.getByTestId('frame-helper-check')).toHaveCount(0); // removed after the check

  const frame = page.getByTestId('tool-frame');
  await expect(frame).toHaveAttribute('src', siteUrl);
  await expect(frame).toHaveAttribute('data-frame-mode', 'site');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-storage-access-by-user-activation');
  // The stub answers `X-Frame-Options: DENY` + `frame-ancestors 'none'`, yet it shows: the helper removed both.
  await expect(page.frameLocator('[data-testid="tool-frame"]').getByTestId('stub')).toHaveText('Jira stub');
  await expect(page.getByTestId('tool-overlay')).toHaveCount(0); // the probe's `framing: "refused"` does not matter for a site
  // Chromium allows third-party cookies, so hasStorageAccess() is true: no "Allow" banner inside the frame.
  await expect(page.frameLocator('[data-testid="tool-frame"]').locator('#sb-frame-helper-storage')).toHaveCount(0);
  expect(site.requests.filter((r) => r.host === `${SITE}:${site.port}`).map((r) => r.dest)).toContain('iframe');
  await expect(page.getByTestId('tool-new-tab')).toHaveAttribute('href', siteUrl);

  // A local tool is unchanged: framed through its D15 proxy (the helper does not get in the way).
  await page.goto(`${server.baseUrl}/tools/cm`);
  const cm = tools.find((t) => t.id === 'cm')!;
  await expect(page.getByTestId('tool-frame')).toHaveAttribute('src', cm.frameUrl!);
  await expect(page.getByTestId('tool-frame')).toHaveAttribute('data-frame-mode', 'proxy');
  await expect(page.getByTestId('view-tool')).not.toHaveAttribute('data-frame-helper', /.*/);
  await expect(page.frameLocator('[data-testid="tool-frame"]').getByTestId('stub')).toHaveText('Local tool stub');
  await page.close();
});

test('scope: with the helper loaded, a page that is not on loopback framing the same site is still refused', async () => {
  const page = await withHelper.newPage();
  const messages: string[] = [];
  page.on('console', (message) => messages.push(message.text()));
  const before = site.requests.length;
  await page.goto(`https://${OUTSIDE}:${site.port}/`);
  await expect(page.getByRole('heading', { name: 'Another site' })).toBeVisible();
  // The frame was requested (so the rule saw it) and the browser still refused it: its headers were kept.
  await expect.poll(() => site.requests.slice(before).some((r) => r.host === `${SITE}:${site.port}` && r.dest === 'iframe')).toBe(true);
  await expect.poll(() => messages.some((text) => text.includes(`Framing '${siteUrl}'`) && text.includes("frame-ancestors 'none'"))).toBe(true);
  await expect(page.frameLocator('[data-testid="outside-frame"]').getByTestId('stub')).toHaveCount(0);
  expect(page.frames().some((frame) => frame.url() === siteUrl)).toBe(false);
  // No marker outside loopback pages either.
  await expect(page.locator('html')).not.toHaveAttribute(FRAME_HELPER_ATTRIBUTE, /.*/);
  await page.close();
});

test('without the frame helper: "needs the Switchboard frame helper" with Open in new tab, and no frame', async ({ page }) => {
  await answerProbes(page);
  await page.goto(`${server.baseUrl}/tools/jira`);
  const view = page.getByTestId('view-tool');
  await expect(view).toHaveAttribute('data-tool-state', 'up');
  await expect(view).toHaveAttribute('data-frame-helper', 'absent');
  await expect(page.getByTestId('tool-overlay-title')).toHaveText(`${SITE}:${site.port} needs the Switchboard frame helper to open here`);
  await expect(page.getByTestId('tool-overlay-text')).toHaveText('Install it once (Chrome and Safari): docs/frame-helper.md');
  const action = page.getByTestId('tool-overlay-action');
  await expect(action).toHaveText('Open in new tab');
  await expect(action).toHaveAttribute('href', siteUrl);
  await expect(action).toHaveAttribute('target', '_blank');
  await expect(action).toHaveAttribute('rel', 'noopener');
  await expect(page.getByTestId('tool-frame')).toHaveCount(0);
  await expect(page.getByTestId('frame-helper-check')).toHaveCount(0); // no marker: nothing to check
  // Styled like the D15 fallback: the same overlay card and button classes.
  await expect(page.locator('.sb-tool-overlay .sb-tool-overlay-card .sb-tool-overlay-button')).toHaveText('Open in new tab');
});

test('the helper is there but cannot remove the headers (Safari today): "can\'t open in a frame in this browser"', async ({ page }) => {
  // The marker without a working helper: this browser has no extension, so the capability check frame is refused.
  await page.addInitScript((attribute) => {
    const mark = (): void => document.documentElement?.setAttribute(attribute, '1.0.0');
    mark();
    document.addEventListener('DOMContentLoaded', mark);
  }, FRAME_HELPER_ATTRIBUTE);
  await answerProbes(page);
  await page.goto(`${server.baseUrl}/tools/jira`);
  await expect(page.getByTestId('view-tool')).toHaveAttribute('data-frame-helper', 'blocked');
  await expect(page.getByTestId('tool-overlay-title')).toHaveText(`${SITE}:${site.port} can't open in a frame in this browser`);
  await expect(page.getByTestId('tool-overlay-text')).toContainText('The Switchboard frame helper is installed');
  await expect(page.getByTestId('tool-overlay-text')).toContainText('docs/frame-helper.md');
  await expect(page.getByTestId('tool-overlay-action')).toHaveAttribute('href', siteUrl);
  await expect(page.getByTestId('tool-frame')).toHaveCount(0);
});
