import { type Browser, type BrowserContext, type Locator, type Page, expect, test } from '@playwright/test';
import { type FakePushService, type FakeSubscription, startFakePush } from '../helpers/fake-push.ts';
import { freeTestPorts } from '../helpers/net.ts';
import { type QuestionWorld, startQuestionWorld } from './question-world.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D87 oracle (`docs/devices.md` → *No notifications while Switchboard is open*):
 * two phones (390×844, touch, their own cookies) paired as devices with
 * notifications on (push subscriptions that are stand-ins pointing at the fake
 * push service, as in `devices.spec.ts`). Phone A has Switchboard open in front;
 * phone B has none open. A turn finishes on this machine (fake-claude): only B
 * gets a push, and A shows the happening as a toast. Then A's page goes to the
 * background (`visibilitychange` → hidden): the next finished turn reaches A as a
 * push too. Real server, fake `tailscale`; the devices' origin is
 * `http://localhost:<device port>` (`SWITCHBOARD_DEVICE_TEST_ORIGIN`).
 */

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

let world: QuestionWorld;
let push: FakePushService;
let devicePort: number;

test.beforeAll(async () => {
  const free = await freeTestPorts();
  push = await startFakePush(free.at(-1) as number);
  devicePort = free.at(-2) as number;
  world = await startQuestionWorld('e2e-device-quiet', {
    env: { SWITCHBOARD_DEVICE_TEST_ORIGIN: `http://localhost:${devicePort}`, SWITCHBOARD_PUSH_TEST_ENDPOINTS: push.origin },
  });
});

test.afterAll(async () => {
  await world?.stop();
  await push?.close();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

/** A phone context whose push subscription is a stand-in at the fake push service. */
async function phone(browser: Browser, subscription: FakeSubscription): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: ANDROID_UA, deviceScaleFactor: 2 });
  await context.addInitScript((sub: { endpoint: string; keys: { p256dh: string; auth: string } }) => {
    const fake = { endpoint: sub.endpoint, options: { applicationServerKey: null }, toJSON: () => ({ endpoint: sub.endpoint, keys: sub.keys }), unsubscribe: async () => true };
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
  }, { endpoint: subscription.endpoint, keys: subscription.keys });
  return context;
}

async function press(target: Locator): Promise<void> {
  await expect(target).toBeEnabled();
  await target.tap();
}

/** Desktop: device access on (on the test device port), a pairing code; the QR code's URL. */
async function makeCode(page: Page): Promise<string> {
  await page.goto(`${world.baseUrl}/settings/devices`);
  const toggle = page.getByTestId('devices-access');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await expect(page.getByTestId('devices-access-desc')).toHaveAttribute('data-state', 'ok');
  await page.getByTestId('devices-pair').click();
  const qr = page.getByTestId('devices-pairing').getByTestId('remote-qr');
  await expect(qr).toBeVisible();
  return (await qr.getAttribute('data-text')) as string;
}

/** Phone: pairs with the QR link, enables notifications in its Settings → Devices; the page (left on Settings → Devices). */
async function pairWithNotifications(context: BrowserContext, url: string, name: string): Promise<Page> {
  const mobile = await context.newPage();
  await stubToolProbes(mobile);
  await mobile.goto(url);
  await mobile.getByTestId('pair-name').fill(name);
  await mobile.getByTestId('pair-submit').click();
  await mobile.waitForURL(`http://localhost:${devicePort}/`);
  await mobile.getByTestId('shell').waitFor();
  await mobile.goto(`http://localhost:${devicePort}/settings/devices`);
  await press(mobile.getByTestId('device-push-enable'));
  await expect(mobile.getByTestId('device-push-desc')).toHaveAttribute('data-enabled', 'true');
  // D87: the note under the notification settings.
  await expect(mobile.getByTestId('device-push-quiet')).toHaveText('No notifications while Switchboard is open on this device.');
  return mobile;
}

function pushesTo(subscription: FakeSubscription): Array<{ kind: string; title: string; url: string }> {
  const path = new URL(subscription.endpoint).pathname;
  return push.received.filter((p) => p.path === path).map((p) => p.payload as { kind: string; title: string; url: string });
}

test('D87 · no system notification while Switchboard is open on the phone (a toast instead); in the background the push comes', async ({ page, browser }) => {
  // The device listener on a test port (the default 13003 is never bound in tests).
  await page.goto(`${world.baseUrl}/settings/devices`);
  const access = await page.evaluate(
    async (port) => (await fetch('/api/devices/access', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port }) })).status,
    devicePort,
  );
  expect(access).toBe(200);
  const subA = push.subscribe();
  const subB = push.subscribe();
  const contextA = await phone(browser, subA);
  const contextB = await phone(browser, subB);
  try {
    const phoneA = await pairWithNotifications(contextA, await makeCode(page), 'Pixel A');
    const phoneB = await pairWithNotifications(contextB, await makeCode(page), 'Pixel B');
    // B has no Switchboard page open; A has it open in front, its /hub stream connected and its presence reported.
    await phoneB.close();
    const hubA = phoneA.waitForResponse((response) => new URL(response.url()).pathname === '/hub');
    const presentA = phoneA.waitForResponse((response) => new URL(response.url()).pathname === '/api/device/presence' && response.request().postDataJSON()?.visible === true);
    await phoneA.goto(`http://localhost:${devicePort}/inbox`);
    expect((await hubA).status()).toBe(200);
    expect((await presentA).status()).toBe(204);
    expect(await phoneA.evaluate(() => document.visibilityState)).toBe('visible');

    // A turn finishes on this machine.
    await page.goto(`${world.baseUrl}/inbox`);
    const first = await world.startSession(page, 'quiet-one', 'Say hello.');
    await expect.poll(() => pushesTo(subB).length, { timeout: 20_000 }).toBe(1);
    expect(pushesTo(subB)[0]).toMatchObject({ kind: 'turnFinished', url: `/sessions/${first.id}` });
    // A shows it as a toast (Jump to session opens it) and got no push.
    const toast = phoneA.getByTestId('toast');
    await expect(toast).toBeVisible();
    await expect(toast.locator('.sb-toast-title')).toHaveText(pushesTo(subB)[0]?.title as string);
    await expect(toast.locator('.sb-toast-sub')).toHaveText('finished · now');
    await expect(toast.getByTestId('toast-jump')).toBeVisible();
    await phoneA.waitForTimeout(1_000);
    expect(pushesTo(subA)).toEqual([]);
    expect(push.refused).toEqual([]);
    await toast.getByRole('button', { name: 'Later' }).tap();
    await expect(toast).toHaveCount(0);

    // A goes to the background: its page reports hidden.
    const hiddenA = phoneA.waitForResponse((response) => new URL(response.url()).pathname === '/api/device/presence' && response.request().postDataJSON()?.visible === false);
    await phoneA.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect((await hiddenA).status()).toBe(204);

    // The next finished turn reaches both phones as a push; the one A saw in the app is not sent later.
    const second = await world.startSession(page, 'quiet-two', 'Say hello again.');
    await expect.poll(() => pushesTo(subA).length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => pushesTo(subB).length, { timeout: 20_000 }).toBe(2);
    expect(pushesTo(subA)[0]).toMatchObject({ kind: 'turnFinished', url: `/sessions/${second.id}` });
    expect(pushesTo(subB)[1]).toMatchObject({ kind: 'turnFinished', url: `/sessions/${second.id}` });

    // Closing A's page altogether (its stream drops): still pushed.
    await phoneA.close();
    await page.evaluate(async (id) => {
      await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'And once more.' }) });
    }, second.id);
    await expect.poll(() => pushesTo(subA).length, { timeout: 20_000 }).toBe(2);
    expect(push.refused).toEqual([]);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
