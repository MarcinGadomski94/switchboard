import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, type BrowserContext, type Locator, type Page, expect, test } from '@playwright/test';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { TOKEN_FILE } from '../../src/server/token.ts';
import { type FakePushService, startFakePush } from '../helpers/fake-push.ts';
import { freeTestPorts, makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D73 oracle (`docs/devices.md`): pairing a phone end to end with two browser
 * contexts. The desktop (this machine's UI, 1440×900) switches device access on
 * and shows the QR code; the "phone" (390×844, touch, its own cookies) opens the
 * QR link on the device listener, pairs, and sees the sessions; notifications are
 * enabled on it (the browser's push subscription is a stand-in that points at the
 * fake push service, which verifies and decrypts what Switchboard sends); an
 * iPhone in a Safari tab is told to add the app to the Home Screen first; revoking
 * the phone on the desktop sends it back to the pairing page. Real server, fake
 * `tailscale`; the devices' origin is `http://localhost:<device port>`
 * (`SWITCHBOARD_DEVICE_TEST_ORIGIN`): a secure context like the real `https://…ts.net`.
 */

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const SESSION_TITLE = 'Checkout redesign';

let tmp: string;
let server: ServerProcess;
let push: FakePushService;
let devicePort: number;
let token: string;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-devices');
  const dataDir = path.join(tmp, 'data');
  // A session the phone should see.
  const store = await openStore(storeFile(dataDir));
  try {
    await store.sessions.create({ name: 'web', claudeSessionId: 'c-devices-1', title: SESSION_TITLE });
  } finally {
    await store.close();
  }
  const free = await freeTestPorts();
  push = await startFakePush(free.at(-1) as number);
  devicePort = free.at(-2) as number;
  server = await startServer({
    SWITCHBOARD_DATA_DIR: dataDir,
    SWITCHBOARD_DEVICE_TEST_ORIGIN: `http://localhost:${devicePort}`,
    SWITCHBOARD_PUSH_TEST_ENDPOINTS: push.origin,
  });
  token = (await readFile(path.join(dataDir, TOKEN_FILE), 'utf8')).trim();
  // The device listener's port is a test port (the default 13003 is never bound in tests).
  const answer = await fetch(`${server.baseUrl}/api/devices/access`, {
    method: 'PUT',
    headers: { cookie: `sb_token=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ port: devicePort }),
  });
  expect(answer.status).toBe(200);
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  await push?.close();
  await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

/** A phone context: 390×844, touch, its own cookie jar. */
async function phone(browser: Browser, userAgent: string): Promise<BrowserContext> {
  return browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent, deviceScaleFactor: 2 });
}

/** A tap on the phone (D74's phone layout: Settings → Devices is the detail page, nothing overlaps). */
async function press(target: Locator): Promise<void> {
  await expect(target).toBeEnabled();
  await target.tap();
}

/** On the desktop: Settings → Devices with device access on. */
async function ensureAccess(page: Page): Promise<void> {
  await page.goto(`${server.baseUrl}/settings/devices`);
  const toggle = page.getByTestId('devices-access');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await expect(page.getByTestId('devices-access-desc')).toHaveAttribute('data-state', 'ok');
}

/** On the desktop: Settings → Devices → Pair a device; the QR code's URL. */
async function makeCode(page: Page): Promise<string> {
  await page.getByTestId('devices-pair').click();
  const qr = page.getByTestId('devices-pairing').getByTestId('remote-qr');
  await expect(qr).toBeVisible();
  await expect(page.getByTestId('devices-code')).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  return (await qr.getAttribute('data-text')) as string;
}

/** On a phone: opens the QR link and pairs (the code comes from the link). */
async function pairPhone(context: BrowserContext, url: string, name?: string): Promise<Page> {
  const page = await context.newPage();
  await stubToolProbes(page);
  await page.goto(url);
  await expect(page.getByTestId('pair-machine')).toBeVisible();
  await expect(page.getByTestId('pair-code')).toHaveValue(new URL(url).hash.slice('#code='.length));
  if (name) await page.getByTestId('pair-name').fill(name);
  await page.getByTestId('pair-submit').click();
  await page.waitForURL(`http://localhost:${devicePort}/`);
  await page.getByTestId('shell').waitFor();
  return page;
}

/**
 * The phone's browser push, a stand-in pointing at the fake push service (headless
 * Chromium has no push service). Like a real browser it outlives page loads and
 * re-pairing: the permission and the subscription (with the `applicationServerKey`
 * it was made with) are kept in the origin's localStorage. `fake-push-prompts`
 * counts the permission prompts; `fake-push-unsubscribe-fails` makes
 * `unsubscribe()` fail (the browser keeps its subscription).
 */
async function fakeBrowserPush(context: BrowserContext, sub: { readonly endpoint: string; readonly keys: { readonly p256dh: string; readonly auth: string } }): Promise<void> {
  await context.addInitScript((subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) => {
    const stored = (): number[] | null => {
      const raw = localStorage.getItem('fake-push-sub');
      return raw ? (JSON.parse(raw) as number[]) : null;
    };
    const make = (key: number[]) => ({
      endpoint: subscription.endpoint,
      options: { applicationServerKey: new Uint8Array(key).buffer, userVisibleOnly: true },
      toJSON: () => ({ endpoint: subscription.endpoint, keys: subscription.keys }),
      unsubscribe: async () => {
        if (localStorage.getItem('fake-push-unsubscribe-fails') === '1') throw new Error('unsubscribe failed');
        localStorage.removeItem('fake-push-sub');
        return true;
      },
    });
    PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
      const key = options?.applicationServerKey;
      const bytes = key instanceof ArrayBuffer ? new Uint8Array(key) : ArrayBuffer.isView(key) ? new Uint8Array(key.buffer, key.byteOffset, key.byteLength) : new Uint8Array();
      localStorage.setItem('fake-push-sub', JSON.stringify(Array.from(bytes)));
      return make(Array.from(bytes)) as unknown as PushSubscription;
    };
    PushManager.prototype.getSubscription = async function () {
      const key = stored();
      return (key ? make(key) : null) as unknown as PushSubscription | null;
    };
    Object.defineProperty(Notification, 'permission', { get: () => (localStorage.getItem('fake-push-permission') ?? 'default') as NotificationPermission });
    Notification.requestPermission = async () => {
      localStorage.setItem('fake-push-prompts', String(Number(localStorage.getItem('fake-push-prompts') ?? '0') + 1));
      localStorage.setItem('fake-push-permission', 'granted');
      return 'granted';
    };
  }, { endpoint: sub.endpoint, keys: sub.keys });
}

/** A revoked phone's open page: once it is on the pairing page (by itself or by its next load), closed. */
async function leave(mobile: Page): Promise<void> {
  await mobile.goto(`http://localhost:${devicePort}/`).catch(() => undefined);
  await expect(mobile).toHaveURL(`http://localhost:${devicePort}/pair`);
  await expect(mobile.getByTestId('pair-form')).toBeVisible();
  await mobile.close();
}

/** The permission prompts the phone has shown so far. */
async function prompts(page: Page): Promise<number> {
  return page.evaluate(() => Number(localStorage.getItem('fake-push-prompts') ?? '0'));
}

/** The desktop's view of a paired device's notifications (`GET /api/devices`; `null` when no device has that name). */
async function devicePush(name: string): Promise<boolean | null> {
  const view = (await (await fetch(`${server.baseUrl}/api/devices`, { headers: { cookie: `sb_token=${token}` } })).json()) as { devices: Array<{ name: string; push: boolean }> };
  return view.devices.find((device) => device.name === name)?.push ?? null;
}

test('pairs a phone with a QR code, enables its notifications, and revokes it', async ({ page, browser }) => {
  // Desktop: device access is off by default; switching it on publishes it (fake tailscale serve).
  await page.goto(`${server.baseUrl}/settings/devices`);
  await expect(page.getByTestId('devices-access')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('devices-pair')).toBeDisabled();
  await page.getByTestId('devices-access').click();
  await expect(page.getByTestId('devices-access-desc')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('devices-access-desc')).toContainText(`http://localhost:${devicePort}`);
  const url = await makeCode(page);
  expect(url).toMatch(new RegExp(`^http://localhost:${devicePort}/pair#code=[0-9A-Z]{4}-[0-9A-Z]{4}$`));

  // The phone: an unpaired page load lands on the pairing page.
  const android = await phone(browser, ANDROID_UA);
  try {
    const probe = await android.newPage();
    await probe.goto(`http://localhost:${devicePort}/sessions`);
    await expect(probe).toHaveURL(`http://localhost:${devicePort}/pair`);
    await probe.close();
    // Its push subscription: a stand-in pointing at the fake push service (headless Chromium has no push service).
    const sub = push.subscribe();
    await fakeBrowserPush(android, sub);

    const mobile = await pairPhone(android, url, 'Pixel');
    // It sees this machine's sessions (D74: the phone layout, the sessions in the sidebar drawer behind ☰).
    await expect(mobile.getByTestId('app-bar')).toBeVisible();
    await mobile.getByTestId('drawer-open').tap();
    await expect(mobile.getByTestId('sidebar').getByText(SESSION_TITLE)).toBeVisible();
    await mobile.getByTestId('drawer-scrim').tap();
    // Its credential is an HttpOnly, Secure, SameSite=Lax cookie on the devices' origin only; never the install token.
    const cookies = await android.cookies();
    expect(cookies.map((c) => c.name)).toEqual(['__Host-sb_device']);
    expect(cookies[0]).toMatchObject({ domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });

    // The desktop's list shows it; the code is gone.
    await expect(page.getByTestId('devices-paired-note')).toHaveText('Paired: Pixel.');
    await expect(page.getByTestId('device').getByTestId('device-name')).toHaveText('Pixel');

    // The phone's own Settings → Devices (D74: Settings lists the sections on a phone, Devices opens as the detail page).
    await mobile.goto(`http://localhost:${devicePort}/settings`);
    await expect(mobile.getByTestId('view-settings')).toHaveAttribute('data-pane', 'list');
    await mobile.getByTestId('settings-nav-devices').tap();
    await expect(mobile).toHaveURL(`http://localhost:${devicePort}/settings/devices`);
    await expect(mobile.getByTestId('view-settings')).toHaveAttribute('data-pane', 'detail');
    await expect(mobile.getByTestId('settings-back')).toBeVisible();
    await expect(mobile.getByTestId('this-device-name')).toHaveText('Pixel');
    await expect(mobile.getByTestId('devices-access')).toHaveCount(0);
    await expect(mobile.getByTestId('device-push-desc')).toHaveAttribute('data-support', 'ready');
    await press(mobile.getByTestId('device-push-enable'));
    await expect(mobile.getByTestId('device-push-desc')).toHaveAttribute('data-enabled', 'true');
    await expect(mobile.getByTestId('device-push-turnFinished')).toHaveAttribute('aria-checked', 'true');
    await press(mobile.getByTestId('device-push-turnFinished'));
    await expect(mobile.getByTestId('device-push-turnFinished')).toHaveAttribute('aria-checked', 'false');
    await press(mobile.getByTestId('device-push-test'));
    await expect(mobile.getByTestId('device-note')).toHaveText('Test notification sent.');
    const [received] = await push.waitFor(1);
    expect(received?.payload).toMatchObject({ kind: 'test', title: 'Switchboard', url: '/settings/devices' });
    expect(push.refused).toEqual([]);
    await page.reload();
    await expect(page.getByTestId('device-detail')).toContainText('notifications on');

    // A local-only action is refused for the phone.
    const refused = await mobile.evaluate(async () => (await fetch('/api/devices/pairing', { method: 'POST' })).status);
    expect(refused).toBe(403);

    // Revoke on the desktop: the phone is back on the pairing page at its next load.
    await page.getByTestId('device-revoke').click();
    await expect(page.getByTestId('devices-empty')).toBeVisible();
    // Its open page may get there by itself (its /hub stream was cut; the next API answer is 401); else its next load does.
    await mobile.goto(`http://localhost:${devicePort}/`).catch(() => undefined);
    await expect(mobile).toHaveURL(`http://localhost:${devicePort}/pair`);
    await expect(mobile.getByTestId('pair-form')).toBeVisible();
  } finally {
    await android.close();
  }
});

test('an iPhone in a Safari tab is told to add the app to the Home Screen before notifications', async ({ page, browser }) => {
  await ensureAccess(page);
  const url = await makeCode(page);
  const iphone = await phone(browser, IPHONE_UA);
  try {
    const mobile = await pairPhone(iphone, url);
    await mobile.goto(`http://localhost:${devicePort}/settings/devices`);
    await expect(mobile.getByTestId('this-device-name')).toHaveText('iPhone · Safari');
    await expect(mobile.getByTestId('device-push-desc')).toHaveAttribute('data-support', 'ios-install');
    await expect(mobile.getByTestId('device-push-desc')).toContainText('Add to Home Screen');
    await expect(mobile.getByTestId('device-push-enable')).toBeDisabled();
  } finally {
    await iphone.close();
  }
});

test('a wrong code is refused on the pairing page', async ({ page, browser }) => {
  await ensureAccess(page);
  const context = await phone(browser, ANDROID_UA);
  try {
    const mobile = await context.newPage();
    await mobile.goto(`http://localhost:${devicePort}/pair`);
    await mobile.getByTestId('pair-code').fill(`${randomBytes(2).toString('hex').toUpperCase()}-ZZZZ`);
    await mobile.getByTestId('pair-submit').click();
    await expect(mobile.getByTestId('pair-error')).not.toBeEmpty();
    expect(await context.cookies()).toEqual([]);
  } finally {
    await context.close();
  }
});

test('D81 · the share sheet: the device origin’s app is a share target; a share opens "Add to which session?" and saves there (the local manifest has none)', async ({ page, browser }) => {
  // This machine's own UI is no share target.
  const local = await (await fetch(`${server.baseUrl}/manifest.webmanifest`)).json();
  expect(local.share_target).toBeUndefined();
  await ensureAccess(page);
  const url = await makeCode(page);
  const android = await phone(browser, ANDROID_UA);
  try {
    const mobile = await pairPhone(android, url, 'Pixel share');
    const manifest = await mobile.evaluate(async () => (await (await fetch('/manifest.webmanifest')).json()) as { share_target?: unknown });
    expect(manifest.share_target).toEqual({ action: '/share-target', method: 'POST', enctype: 'application/x-www-form-urlencoded', params: { title: 'title', text: 'text', url: 'url' } });
    // What Android does with a share: a POST navigation of the form to the share target (the service worker or the server answers 303 → /share?…).
    await mobile.evaluate(() => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/share-target';
      form.enctype = 'application/x-www-form-urlencoded';
      for (const [name, value] of [['title', 'Flaky test write-up'], ['text', 'Read before the retry work.'], ['url', 'https://example.com/flaky']]) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name as string;
        input.value = value as string;
        form.append(input);
      }
      document.body.append(form);
      form.submit();
    });
    await mobile.waitForURL(/\/share\?/);
    await expect(mobile.getByTestId('view-share')).toBeVisible();
    await expect(mobile.getByTestId('share-title')).toHaveValue('Flaky test write-up');
    await expect(mobile.getByTestId('share-note')).toHaveText('Read before the retry work.\n\nhttps://example.com/flaky');
    const target = mobile.getByTestId('share-session').filter({ hasText: SESSION_TITLE });
    await expect(target).toBeVisible();
    await mobile.screenshot({ path: path.join(process.env['SWITCHBOARD_SHOTS'] ?? path.join('test-results', 'shots'), 'share-picker-phone.png') });
    await press(target);
    await expect(mobile.getByTestId('share-saved')).toContainText(`Added to ${SESSION_TITLE}`);
    // Saved through the device's own credential (the capture route is a device route), bare and waiting for the agent.
    const sessions = (await (await fetch(`${server.baseUrl}/api/sessions`, { headers: { cookie: `sb_token=${token}` } })).json()) as Array<{ id: string; title: string | null }>;
    const id = sessions.find((s) => s.title === SESSION_TITLE)?.id as string;
    const list = (await (await fetch(`${server.baseUrl}/api/sessions/${id}/todos`, { headers: { cookie: `sb_token=${token}` } })).json()) as { todos: Array<Record<string, unknown>> };
    expect(list.todos.find((t) => t['title'] === 'Flaky test write-up')).toMatchObject({ capturedFrom: 'share', addedBy: 'developer', plan: 'No plan', priority: 'medium' });
  } finally {
    await android.close();
  }
});

test('D73 fix · re-pairing restores the notifications without asking; turned off stays off; a subscription for another key shows off', async ({ page, browser }) => {
  await ensureAccess(page);
  const android = await phone(browser, ANDROID_UA);
  // Every PUT /api/device/push the phone makes (a restore is one).
  const saves: string[] = [];
  android.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/device/push') saves.push(request.postData() ?? '');
  });
  try {
    await fakeBrowserPush(android, push.subscribe());
    // Paired, notifications enabled with one prompt, a toggle changed.
    let mobile = await pairPhone(android, await makeCode(page), 'Restore A');
    await mobile.goto(`http://localhost:${devicePort}/settings/devices`);
    await press(mobile.getByTestId('device-push-enable'));
    await expect(mobile.getByTestId('device-push-desc')).toHaveAttribute('data-enabled', 'true');
    await press(mobile.getByTestId('device-push-turnFinished'));
    await expect(mobile.getByTestId('device-push-turnFinished')).toHaveAttribute('aria-checked', 'false');
    expect(await prompts(mobile)).toBe(1);

    // Removed on the computer and paired again: the new device record has no subscription; the page sends the browser's back by itself.
    await page.goto(`${server.baseUrl}/settings/devices`);
    await page.getByTestId('device').filter({ hasText: 'Restore A' }).getByTestId('device-revoke').click();
    await expect(page.getByTestId('device').filter({ hasText: 'Restore A' })).toHaveCount(0);
    const before = saves.length;
    await leave(mobile);
    const restored = android.waitForEvent('request', (request) => request.method() === 'PUT' && new URL(request.url()).pathname === '/api/device/push');
    mobile = await pairPhone(android, await makeCode(page), 'Restore B');
    await restored;
    await expect.poll(() => devicePush('Restore B')).toBe(true);
    // No prompt, no new subscribe: only the existing subscription, without toggles (the defaults, as a fresh opt-in).
    expect(await prompts(mobile)).toBe(1);
    expect(saves.slice(before).map((body) => JSON.parse(body))).toEqual([{ subscription: { endpoint: expect.any(String), keys: { p256dh: expect.any(String), auth: expect.any(String) } } }]);
    await mobile.goto(`http://localhost:${devicePort}/settings/devices`);
    await expect(mobile.getByTestId('device-push-desc')).toHaveAttribute('data-enabled', 'true');
    await expect(mobile.getByTestId('device-push-turnFinished')).toHaveAttribute('aria-checked', 'true');
    // The restored subscription works.
    const received = push.received.length;
    await press(mobile.getByTestId('device-push-test'));
    await expect(mobile.getByTestId('device-note')).toHaveText('Test notification sent.');
    await push.waitFor(received + 1);

    // Turned off on purpose, and the browser even kept its subscription (unsubscribe failed): never restored, not on a reload nor after re-pairing.
    await mobile.evaluate(() => localStorage.setItem('fake-push-unsubscribe-fails', '1'));
    await press(mobile.getByTestId('device-push-disable'));
    await expect(mobile.getByTestId('device-push-desc')).toHaveAttribute('data-enabled', 'false');
    expect(await mobile.evaluate(() => localStorage.getItem('fake-push-sub'))).not.toBeNull();
    const offAt = saves.length;
    await mobile.reload();
    await expect(mobile.getByTestId('device-push-desc')).toHaveAttribute('data-enabled', 'false');
    await mobile.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.goto(`${server.baseUrl}/settings/devices`);
    await page.getByTestId('device').filter({ hasText: 'Restore B' }).getByTestId('device-revoke').click();
    await expect(page.getByTestId('device').filter({ hasText: 'Restore B' })).toHaveCount(0);
    await leave(mobile);
    mobile = await pairPhone(android, await makeCode(page), 'Restore C');
    await mobile.goto(`http://localhost:${devicePort}/settings/devices`);
    await expect(mobile.getByTestId('device-push-desc')).toHaveAttribute('data-enabled', 'false');
    await mobile.waitForTimeout(1_000);
    expect(saves.length).toBe(offAt);
    expect(await devicePush('Restore C')).toBe(false);
    expect(await prompts(mobile)).toBe(1);

    // Enabled again (the marker is cleared), then the browser's subscription turns out to be for another VAPID key (keys made anew):
    // shown as off and not restored; Enable replaces it, as before.
    await mobile.evaluate(() => localStorage.removeItem('fake-push-unsubscribe-fails'));
    await press(mobile.getByTestId('device-push-enable'));
    await expect(mobile.getByTestId('device-push-desc')).toHaveAttribute('data-enabled', 'true');
    expect(await mobile.evaluate(() => localStorage.getItem('switchboard.push.off'))).toBeNull();
    await mobile.evaluate(() => localStorage.setItem('fake-push-sub', JSON.stringify(Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : 9)))));
    const keyAt = saves.length;
    await mobile.reload();
    await expect(mobile.getByTestId('device-push-enable')).toBeVisible();
    await expect(mobile.getByTestId('device-push-desc')).toHaveAttribute('data-enabled', 'false');
    expect(saves.length).toBe(keyAt);
    expect(await prompts(mobile)).toBe(2);
    await press(mobile.getByTestId('device-push-enable'));
    await expect(mobile.getByTestId('device-push-desc')).toHaveAttribute('data-enabled', 'true');
    const vapid = await mobile.evaluate(async () => ((await (await fetch('/api/device')).json()) as { vapidPublicKey: string }).vapidPublicKey);
    const key = await mobile.evaluate(() => localStorage.getItem('fake-push-sub'));
    expect(Buffer.from(JSON.parse(key as string) as number[]).toString('base64url')).toBe(vapid);
  } finally {
    await android.close();
  }
});
