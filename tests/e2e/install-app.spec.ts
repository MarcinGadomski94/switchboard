import path from 'node:path';
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import { INSTALL_APP_DESCRIPTION } from '../../src/web/views/settings/install-app.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer, startServerOn } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D34 oracle (docs/install-app.md): Switchboard is installable from Playwright's
 * bundled Chromium (manifest linked, no installability errors), its service worker
 * registers at `/`, controls the page and caches only the offline page, the token
 * cookie rule holds through the worker, a navigation with the service stopped shows
 * the offline page whose Retry loads the app once the service is back, and
 * Settings → Install as app follows the browser's offer (a synthetic
 * `beforeinstallprompt`), an installed app's display mode and Safari. Real server
 * (`node src/server/main.ts`) on a test port with a temp data folder, no demo seed.
 */

const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';

let tmp: string;
let env: Record<string, string>;
let server: ServerProcess;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-install-app');
  env = { SWITCHBOARD_DATA_DIR: path.join(tmp, 'data') };
  server = await startServer(env);
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  await removeTempDir(tmp);
});

// The sidebar probes the default tools on load; answered in the browser (tests/e2e/probes.ts).
test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

/** Opens `route` and waits until the service worker controls the page. */
async function openControlled(page: Page, route = '/'): Promise<void> {
  await page.goto(`${server.baseUrl}${route}`);
  await page.getByTestId('shell').waitFor();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

/** Dispatches a `beforeinstallprompt` like Chrome's; its `prompt()` calls are counted in `window.__installPrompts`. */
async function offerInstall(page: Page): Promise<void> {
  await page.evaluate(() => {
    const counter = window as unknown as { __installPrompts: number };
    counter.__installPrompts = 0;
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: async () => {
        counter.__installPrompts += 1;
      },
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    });
    window.dispatchEvent(event);
  });
}

/** The `data-row` of every row in the open settings section, in order. */
function settingsRows(page: Page): Promise<string[]> {
  return page.getByTestId('settings-content').locator('[data-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row') ?? ''));
}

/** Opens Settings → Claude Code and waits for its rows (the Start at login value loads last). */
async function openClaudeSettings(page: Page): Promise<void> {
  await page.goto(`${server.baseUrl}/settings`);
  await expect(page.getByTestId('settings-content').locator('[data-row="permissions"]')).toBeVisible();
  await expect(page.getByTestId('start-at-login')).not.toHaveText('…');
}

/** A context whose `(display-mode: standalone)` matches, as in an installed app's window. */
async function standaloneContext(browser: Browser, userAgent?: string): Promise<BrowserContext> {
  const context = await browser.newContext(userAgent ? { userAgent } : {});
  await context.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => real(query === '(display-mode: standalone)' ? 'all' : query);
  });
  return context;
}

test('the page links the manifest and Chromium reports the app installable', async ({ page }) => {
  await openControlled(page);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  const cdp = await page.context().newCDPSession(page);
  const manifest = await cdp.send('Page.getAppManifest');
  expect(manifest.url).toBe(`${server.baseUrl}/manifest.webmanifest`);
  expect(manifest.errors).toEqual([]);
  expect(JSON.parse(manifest.data ?? '{}')).toMatchObject({ name: 'Switchboard', short_name: 'Switchboard', start_url: '/', display: 'standalone' });
  await expect.poll(async () => (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, { timeout: 10_000 }).toEqual([]);
});

test('the service worker registers at /, controls the page and caches only the offline page', async ({ page }) => {
  await openControlled(page);
  const registration = await page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    return { scope: ready.scope, script: ready.active?.scriptURL ?? null, preload: (await ready.navigationPreload.getState()).enabled };
  });
  expect(registration).toEqual({ scope: `${server.baseUrl}/`, script: `${server.baseUrl}/sw.js`, preload: true });
  const cached = await page.evaluate(async () => {
    const out: Record<string, string[]> = {};
    for (const name of await caches.keys()) out[name] = (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname);
    return out;
  });
  expect(cached).toEqual({ 'switchboard-offline-v1': ['/offline.html'] });

  // The API and the /hub stream work as before (the worker never answers them).
  expect(await page.evaluate(async () => (await fetch('/api/sessions')).status)).toBe(200);
  const hubOpened = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const source = new EventSource('/hub');
        source.onopen = () => {
          source.close();
          resolve(true);
        };
        source.onerror = () => {
          source.close();
          resolve(false);
        };
      }),
  );
  expect(hubOpened).toBe(true);

  // A reload goes through the worker to the service: the page as served (no-store), nothing from a cache.
  const reloaded = await page.reload();
  expect(reloaded?.fromServiceWorker()).toBe(true);
  expect(reloaded?.status()).toBe(200);
  expect(reloaded?.headers()['cache-control']).toBe('no-store');
  await page.getByTestId('shell').waitFor();
});

test('through the worker a typed URL still gets the token cookie and a link from another site does not', async ({ page, context }) => {
  await openControlled(page);
  await context.clearCookies();
  const typed = await page.goto(`${server.baseUrl}/inbox`);
  expect(typed?.fromServiceWorker()).toBe(true);
  expect((await context.cookies(server.baseUrl)).map((cookie) => cookie.name)).toContain('sb_token');

  // A page that is not Switchboard links to it: the worker answers the navigation, but the service sees a cross-site load.
  await context.clearCookies();
  const other = await context.newPage();
  await stubToolProbes(other);
  await other.setContent(`<a href="${server.baseUrl}/inbox">Switchboard</a>`);
  const navigated = other.waitForResponse((response) => response.url() === `${server.baseUrl}/inbox`);
  await other.getByRole('link', { name: 'Switchboard' }).click();
  expect((await navigated).fromServiceWorker()).toBe(true);
  await expect(other).toHaveTitle('Switchboard');
  expect((await context.cookies(server.baseUrl)).map((cookie) => cookie.name)).not.toContain('sb_token');
  expect(await other.evaluate(async () => (await fetch('/api/sessions')).status)).toBe(401);
  await other.close();
});

test('with the service stopped a navigation shows the offline page; Retry loads the app once it is back', async ({ page }) => {
  await openControlled(page, '/inbox');
  const { port } = server;
  expect(await server.stop()).toBe(0);

  const offline = await page.goto(`${server.baseUrl}/inbox`);
  expect(offline?.fromServiceWorker()).toBe(true);
  await expect(page).toHaveTitle("Switchboard isn't running");
  await expect(page.getByTestId('offline-title')).toHaveText(`Switchboard isn't running on 127.0.0.1:${port}`);
  await expect(page.getByTestId('offline-help')).toHaveText('Start it with npm start in the repo, or turn on Settings → Start at login.');
  const retry = page.getByTestId('offline-retry');
  await expect(retry).toHaveText('Retry');
  await expect(retry).toBeFocused();
  // On the page's SPEC colors (it cannot load the app's CSS from a stopped service).
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(11, 12, 13)');

  // Still down: Retry lands on the offline page again.
  await Promise.all([page.waitForEvent('load'), retry.click()]);
  await expect(page.getByTestId('offline-title')).toBeVisible();
  await expect(page).toHaveURL(`${server.baseUrl}/inbox`);

  // Back on the same address and data folder: Retry loads the app, with its cookie.
  server = await startServerOn(port, env);
  await Promise.all([page.waitForEvent('load'), page.getByTestId('offline-retry').click()]);
  await page.getByTestId('shell').waitFor();
  await expect(page).toHaveURL(`${server.baseUrl}/inbox`);
  await expect(page).toHaveTitle('Switchboard');
  expect(await page.evaluate(async () => (await fetch('/api/sessions')).status)).toBe(200);
});

test('Settings → Install as app shows while the browser offers installation and opens its dialog once', async ({ page }) => {
  await openClaudeSettings(page);
  // The test Chromium offers no installation by itself: no row, no hint.
  expect(await settingsRows(page)).toEqual(['cli', 'account', 'service', 'bind', 'start-at-login', 'permissions']);

  await offerInstall(page);
  const row = page.locator('[data-row="install-app"]');
  await expect(row.locator('.sb-set-row-label')).toHaveText('Install as app');
  await expect(row.locator('.sb-set-row-desc')).toHaveText(INSTALL_APP_DESCRIPTION);
  await expect(page.getByTestId('settings-install-app')).toHaveText('Install');
  expect(await settingsRows(page)).toEqual(['cli', 'account', 'service', 'bind', 'start-at-login', 'install-app', 'permissions']);

  await page.getByTestId('settings-install-app').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __installPrompts: number }).__installPrompts)).toBe(1);
  // One dialog per offer: the row goes until the browser offers again.
  await expect(row).toHaveCount(0);
  await offerInstall(page);
  await expect(row).toBeVisible();
  // Installed from the browser's own menu meanwhile: the offer is gone.
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(row).toHaveCount(0);
});

test("Safari shows the one-line hint 'Install: File → Add to Dock…' instead", async ({ browser }) => {
  const context = await browser.newContext({ userAgent: SAFARI_UA });
  try {
    const page = await context.newPage();
    await stubToolProbes(page);
    await openClaudeSettings(page);
    await expect(page.getByTestId('settings-install-hint')).toHaveText('Install: File → Add to Dock…');
    await expect(page.getByTestId('settings-install-app')).toHaveCount(0);
    expect(await settingsRows(page)).toEqual(['cli', 'account', 'service', 'bind', 'start-at-login', 'install-app', 'permissions']);
  } finally {
    await context.close();
  }
});

test('an installed app (display-mode: standalone) shows neither the button nor the hint', async ({ browser }) => {
  for (const userAgent of [undefined, SAFARI_UA]) {
    const context = await standaloneContext(browser, userAgent);
    try {
      const page = await context.newPage();
      await stubToolProbes(page);
      await openClaudeSettings(page);
      expect(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches)).toBe(true);
      await offerInstall(page);
      // Give the row every chance to appear before asserting it does not.
      await page.getByTestId('settings-nav-sessions').click();
      await page.getByTestId('settings-nav-claude').click();
      await expect(page.getByTestId('settings-content').locator('[data-row="permissions"]')).toBeVisible();
      expect(await settingsRows(page), userAgent ?? 'Chromium').toEqual(['cli', 'account', 'service', 'bind', 'start-at-login', 'permissions']);
    } finally {
      await context.close();
    }
  }
});
