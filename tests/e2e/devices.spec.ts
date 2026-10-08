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

/**
 * A click on the phone's Settings page. Until the responsive layout (D74, a
 * parallel lane) lands, the desktop Settings nav overlaps the content at 390 px,
 * so the click is dispatched on the element rather than at its position.
 */
async function press(target: Locator): Promise<void> {
  await expect(target).toBeEnabled();
  await target.dispatchEvent('click');
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
    await android.addInitScript((subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) => {
      const fake = {
        endpoint: subscription.endpoint,
        options: { applicationServerKey: null },
        toJSON: () => ({ endpoint: subscription.endpoint, keys: subscription.keys }),
        unsubscribe: async () => true,
      };
      let subscribed = false;
      PushManager.prototype.subscribe = async function () {
        subscribed = true;
        return fake as unknown as PushSubscription;
      };
      PushManager.prototype.getSubscription = async function () {
        return (subscribed ? fake : null) as unknown as PushSubscription | null;
      };
      let permission: NotificationPermission = 'default';
      Object.defineProperty(Notification, 'permission', { get: () => permission });
      Notification.requestPermission = async () => {
        permission = 'granted';
        return permission;
      };
    }, { endpoint: sub.endpoint, keys: sub.keys });

    const mobile = await pairPhone(android, url, 'Pixel');
    // It sees this machine's sessions.
    await expect(mobile.getByText(SESSION_TITLE).first()).toBeVisible();
    // Its credential is an HttpOnly, Secure, SameSite=Strict cookie on the devices' origin only; never the install token.
    const cookies = await android.cookies();
    expect(cookies.map((c) => c.name)).toEqual(['__Host-sb_device']);
    expect(cookies[0]).toMatchObject({ domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Strict' });

    // The desktop's list shows it; the code is gone.
    await expect(page.getByTestId('devices-paired-note')).toHaveText('Paired: Pixel.');
    await expect(page.getByTestId('device').getByTestId('device-name')).toHaveText('Pixel');

    // The phone's own Settings → Devices: this device and its notifications.
    await mobile.goto(`http://localhost:${devicePort}/settings/devices`);
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
