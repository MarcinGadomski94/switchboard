import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type APIRequestContext,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Worker,
  chromium,
  expect,
  request as playwrightRequest,
  test,
} from '@playwright/test';
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
 * `channel: 'chromium'`). The "sites" are an https stub on 127.0.0.1 named
 * `site.test` (the saved site tool) and `other.test` (not a saved tool), with a
 * self-signed certificate (`--host-resolver-rules` maps the names, certificate
 * errors ignored in that test browser only); both refuse every frame like Jira's
 * login does: `X-Frame-Options: DENY` + `frame-ancestors 'none'`. Every other host
 * name fails to resolve in that browser, and the page's probes are answered in the
 * browser, so nothing leaves the machine.
 * D28 ruling (narrowed scope): the helper's rules are session rules for
 * Switchboard's own tab and the saved site tools' hosts only, read back from the
 * extension's service worker (`chrome.declarativeNetRequest.getSessionRules()`).
 */
const EXTENSION = path.join(REPO_ROOT, 'tools', 'frame-helper');
const SITE = 'site.test';
const OTHER = 'other.test';
const OUTSIDE = 'outside.test';

let tmp: string;
let server: ServerProcess;
let api: APIRequestContext;
let site: SiteStub;
let local: ToolStub;
let loopbackPage: ToolStub;
let withHelper: BrowserContext;
let siteUrl: string;
let otherUrl: string;
let helperVersion: string;
let savedTools: Array<Pick<Tool, 'id' | 'name' | 'url' | 'description'>>;

/** The Jira stand-in and a second site that is not a saved tool: both refuse every frame. `outside.test` is a page on another site that frames the first. */
function siteHandler(): Parameters<typeof startSiteStub>[1] {
  return (req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (host === OUTSIDE) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>outside</title><h1>Another site</h1><iframe data-testid="outside-frame" src="https://${SITE}:${site.port}/"></iframe>`);
      return;
    }
    const text = host === OTHER ? 'Other site stub' : 'Jira stub';
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    });
    res.end(`<!doctype html><html><head><title>${text}</title></head><body><h1 data-testid="stub">${text}</h1></body></html>`);
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

/** One declarativeNetRequest session rule, as the helper's service worker reports it. */
interface SessionRule {
  readonly id: number;
  readonly priority: number;
  readonly action: { readonly type: string; readonly responseHeaders: Array<{ header: string; operation: string }> };
  readonly condition: { readonly tabIds: number[]; readonly resourceTypes: string[]; readonly requestDomains: string[] };
}

/** The helper's service worker (a loopback page load or a tab event wakes it); never Switchboard's own `/sw.js` (D34). */
async function helperWorker(): Promise<Worker> {
  const isHelper = (worker: Worker): boolean => worker.url().startsWith('chrome-extension://');
  return withHelper.serviceWorkers().find(isHelper) ?? (await withHelper.waitForEvent('serviceworker', { predicate: isHelper }));
}

/** The helper's session rules right now. */
async function sessionRules(): Promise<SessionRule[]> {
  const worker = await helperWorker();
  return worker.evaluate(() => {
    const api = (globalThis as unknown as { chrome: { declarativeNetRequest: { getSessionRules(): Promise<unknown[]> } } }).chrome;
    return api.declarativeNetRequest.getSessionRules();
  }) as Promise<SessionRule[]>;
}

/** Each rule as `[tab count, hosts]`; the tab ids themselves are the browser's. */
async function ruleHosts(): Promise<Array<[number, string[]]>> {
  return (await sessionRules()).map((rule) => [rule.condition.tabIds.length, rule.condition.requestDomains]);
}

/** Switchboard at a site tool's view, with the helper ready (its host list confirmed for this tab). */
async function openSwitchboard(): Promise<Page> {
  const page = await withHelper.newPage();
  await answerProbes(page);
  await page.goto(`${server.baseUrl}/tools/jira`);
  await expect(page.getByTestId('view-tool')).toHaveAttribute('data-frame-helper', 'ready');
  return page;
}

/** Adds a plain `<iframe>` of `url` to `page` (as a script on that page would). */
async function injectFrame(page: Page, url: string, testId: string): Promise<void> {
  await page.evaluate(
    ([src, id]) => {
      const frame = document.createElement('iframe');
      frame.src = src;
      frame.setAttribute('data-testid', id);
      document.body.append(frame);
    },
    [url, testId] as const,
  );
}

/** Chromium's console line for a frame refused by `frame-ancestors 'none'`. */
function refusedFrame(messages: readonly ConsoleMessage[], url: string): boolean {
  return messages.some((message) => message.text().includes(`Framing '${url}'`) && message.text().includes("frame-ancestors 'none'"));
}

/** Asserts that `url`, framed in `page` by `testId`, was requested and refused (its headers kept). */
async function expectRefused(page: Page, messages: readonly ConsoleMessage[], url: string, testId: string, before: number): Promise<void> {
  const host = new URL(url).host;
  await expect.poll(() => site.requests.slice(before).some((r) => r.host === host && r.dest === 'iframe')).toBe(true);
  await expect.poll(() => refusedFrame(messages, url)).toBe(true);
  await expect(page.frameLocator(`[data-testid="${testId}"]`).getByTestId('stub')).toHaveCount(0);
  expect(page.frames().some((frame) => frame.url() === url)).toBe(false);
}

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-frame-helper');
  helperVersion = (JSON.parse(await readFile(path.join(EXTENSION, 'manifest.json'), 'utf8')) as { version: string }).version;
  site = await startSiteStub([SITE, OTHER, OUTSIDE], siteHandler());
  siteUrl = `https://${SITE}:${site.port}/`;
  otherUrl = `https://${OTHER}:${site.port}/`;
  local = await startToolStub(htmlAnswer('Local tool stub', { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" }));
  // A loopback page that is not Switchboard (another local dev server) framing the saved site.
  loopbackPage = await startToolStub((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>local page</title><h1>Another local page</h1><iframe data-testid="loopback-frame" src="${siteUrl}"></iframe>`);
  });
  const dataDir = path.join(tmp, 'data');
  server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir });
  const token = (await readFile(path.join(dataDir, 'sb_token'), 'utf8')).trim();
  api = await playwrightRequest.newContext({ baseURL: server.baseUrl, extraHTTPHeaders: { cookie: `sb_token=${token}` } });
  savedTools = [
    { id: 'jira', name: 'Jira', url: siteUrl, description: 'PROJ board' },
    { id: 'cm', name: 'Codebase Memory', url: local.origin, description: null },
  ];
  const put = await api.put('/api/tools', { data: savedTools });
  expect(put.status()).toBe(200);
  withHelper = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      `--host-resolver-rules=MAP ${SITE} 127.0.0.1, MAP ${OTHER} 127.0.0.1, MAP ${OUTSIDE} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1`,
    ],
  });
});

test.afterAll(async () => {
  await withHelper?.close();
  await api?.dispose();
  if (server) expect(await server.stop()).toBe(0);
  await site?.close();
  await local?.close();
  await loopbackPage?.close();
  await removeTempDir(tmp);
});

test('with the frame helper: a saved site tool opens in a direct frame of its own URL; the only rule is for Switchboard\'s tab and its hosts', async () => {
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

  // The helper's one rule: this tab, sub_frames, Switchboard's own host (the check) and the saved site's host.
  await expect.poll(async () => (await sessionRules()).length).toBe(1);
  const rules = await sessionRules();
  expect(rules[0]).toMatchObject({
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' },
      ],
    },
    condition: { resourceTypes: ['sub_frame'], requestDomains: ['127.0.0.1', SITE] },
  });
  expect(rules[0]!.condition.tabIds).toEqual([rules[0]!.id]);

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

test("scope: in Switchboard's own tab, an https host that is not a saved tool is still refused", async () => {
  const page = await openSwitchboard();
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => messages.push(message));
  const before = site.requests.length;
  await injectFrame(page, otherUrl, 'unsaved-frame');
  await expectRefused(page, messages, otherUrl, 'unsaved-frame', before);
  // The same kind of frame of the saved host shows (the control): only the listed hosts are opened up.
  await injectFrame(page, siteUrl, 'saved-frame');
  await expect(page.frameLocator('[data-testid="saved-frame"]').getByTestId('stub')).toHaveText('Jira stub');
  await expect.poll(ruleHosts).toEqual([[1, ['127.0.0.1', SITE]]]);
  await page.close();
});

test('scope: a loopback page that is not Switchboard, in another tab, framing the saved host is refused', async () => {
  const switchboard = await openSwitchboard();
  await expect(switchboard.frameLocator('[data-testid="tool-frame"]').getByTestId('stub')).toHaveText('Jira stub');
  const page = await withHelper.newPage();
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => messages.push(message));
  const before = site.requests.length;
  await page.goto(loopbackPage.origin);
  await expect(page.getByRole('heading', { name: 'Another local page' })).toBeVisible();
  await expectRefused(page, messages, siteUrl, 'loopback-frame', before);
  // The helper still marks every loopback page, but its rule stays Switchboard's tab's alone.
  await expect(page.locator('html')).toHaveAttribute(FRAME_HELPER_ATTRIBUTE, helperVersion);
  await expect.poll(ruleHosts).toEqual([[1, ['127.0.0.1', SITE]]]);
  await page.close();
  await switchboard.close();
});

test('scope: with the helper loaded, a page that is not on loopback framing the same site is still refused', async () => {
  // Switchboard's tab has its rule meanwhile.
  const switchboard = await openSwitchboard();
  await expect.poll(ruleHosts).toEqual([[1, ['127.0.0.1', SITE]]]);
  const page = await withHelper.newPage();
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => messages.push(message));
  const before = site.requests.length;
  await page.goto(`https://${OUTSIDE}:${site.port}/`);
  await expect(page.getByRole('heading', { name: 'Another site' })).toBeVisible();
  // The frame was requested (so a rule could see it) and the browser still refused it: its headers were kept.
  await expectRefused(page, messages, siteUrl, 'outside-frame', before);
  // No marker outside loopback pages either.
  await expect(page.locator('html')).not.toHaveAttribute(FRAME_HELPER_ATTRIBUTE, /.*/);
  await page.close();
  await switchboard.close();
});

test("a removed tool's host is refused again; the tab's rule goes when it leaves Switchboard or closes", async () => {
  const page = await openSwitchboard();
  page.on('dialog', (dialog) => void dialog.accept());
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => messages.push(message));
  try {
    await page.getByTestId('tool-edit').click();
    await expect(page).toHaveURL(`${server.baseUrl}/settings/tools`);
    await page.locator('.sb-set-tool[data-tool="jira"]').getByTestId('settings-tool-remove').click();
    await expect(page.getByTestId('sidebar-tools').locator('.sb-tool-name')).toHaveText(['Codebase Memory']);
    // The page gave the helper its new list: only its own host is left.
    await expect.poll(ruleHosts).toEqual([[1, ['127.0.0.1']]]);
    const before = site.requests.length;
    await injectFrame(page, siteUrl, 'removed-frame');
    await expectRefused(page, messages, siteUrl, 'removed-frame', before);

    // Leaving Switchboard (another site in the same tab) drops the tab's rule.
    await page.goto(`https://${OUTSIDE}:${site.port}/`);
    await expect.poll(ruleHosts).toEqual([]);
  } finally {
    expect((await api.put('/api/tools', { data: savedTools })).status()).toBe(200);
    await page.close();
  }
  // Closing Switchboard's tab drops it too.
  const again = await openSwitchboard();
  await expect.poll(ruleHosts).toEqual([[1, ['127.0.0.1', SITE]]]);
  await again.close();
  await expect.poll(ruleHosts).toEqual([]);
});

test('without the frame helper: "needs the Switchboard frame helper" with Open in new tab, and no frame', async ({ page }) => {
  await answerProbes(page);
  await page.goto(`${server.baseUrl}/tools/jira`);
  const view = page.getByTestId('view-tool');
  await expect(view).toHaveAttribute('data-tool-state', 'up');
  await expect(view).toHaveAttribute('data-frame-helper', 'absent');
  await expect(page.getByTestId('tool-overlay-title')).toHaveText(`${SITE}:${site.port} needs the Switchboard frame helper to open here`);
  await expect(page.getByTestId('tool-overlay-text')).toHaveText('Install it once in Chrome: docs/frame-helper.md (Safari can’t frame signed-in sites: open it in a new tab)');
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
