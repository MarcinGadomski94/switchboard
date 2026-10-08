import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { DeviceAccessState } from '../../src/core/devices.ts';
import { type PushEnvironment, isIos, pushSupport, pushSupportText, vapidKeyBytes } from '../../src/web/pwa/push-support.ts';
import { accessDescription, accessProblem, deviceDetail } from '../../src/web/views/settings/devices.ts';
import { REPO_ROOT } from '../helpers/net.ts';

/** D73: the device UI's pure parts and the service worker's push handlers. */

const READY: PushEnvironment = {
  secureContext: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
  maxTouchPoints: 5,
  standalone: false,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: 'default',
};
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

describe('D73 push support on a device', () => {
  it('says what the device can do', () => {
    expect(pushSupport(READY)).toBe('ready');
    expect(pushSupport({ ...READY, secureContext: false })).toBe('insecure');
    expect(pushSupport({ ...READY, userAgent: IPHONE })).toBe('ios-install');
    expect(pushSupport({ ...READY, userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5 })).toBe('ios-install');
    expect(pushSupport({ ...READY, userAgent: IPHONE, standalone: true })).toBe('ready');
    expect(pushSupport({ ...READY, hasPushManager: false })).toBe('unsupported');
    expect(pushSupport({ ...READY, permission: 'denied' })).toBe('denied');
    expect(isIos(IPAD_DESKTOP_UA, 0)).toBe(false);
    expect(pushSupportText('ios-install')).toContain('Add to Home Screen');
    expect(pushSupportText('ready')).toBeNull();
  });

  it('turns the base64url VAPID key into bytes', () => {
    const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
    expect(Buffer.from(vapidKeyBytes(key))).toEqual(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]));
  });
});

describe('D73 Settings → Devices copy', () => {
  const base: DeviceAccessState = { enabled: true, port: 13003, httpsPort: 8443, listening: '127.0.0.1:13003', origin: 'https://devbox.example-tailnet.ts.net:8443', https: 'ok', message: null, actionUrl: null };
  it('describes the access switch', () => {
    expect(accessDescription({ ...base, enabled: false, https: 'off' })).toMatch(/^Off\./);
    expect(accessDescription(base)).toBe('On: https://devbox.example-tailnet.ts.net:8443 → 127.0.0.1:13003');
    expect(accessDescription({ ...base, https: 'no-https', message: 'Turn on HTTPS certificates' })).toBe('Turn on HTTPS certificates');
    expect(accessProblem({ ...base, https: 'no-https' })).toBe(true);
    expect(accessProblem(base)).toBe(false);
  });
  it('describes a device', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    expect(deviceDetail({ id: 'a', name: 'Phone', userAgent: null, pairedAt: '2026-10-06T12:00:00Z', lastSeenAt: '2026-10-08T11:59:30Z', push: true }, now)).toBe('paired 2d ago · seen just now · notifications on');
    expect(deviceDetail({ id: 'a', name: 'Phone', userAgent: null, pairedAt: '2026-10-08T11:59:59Z', lastSeenAt: null, push: false }, now)).toBe('paired just now · never seen · notifications off');
  });
});

/** sw.js in a fake worker scope with notifications and clients (D87: their visibility, messages, the browser). */
async function loadWorker(windows: Array<{ url: string; visibilityState?: string }>, userAgent: string = ANDROID_CHROME) {
  const code = await readFile(path.join(REPO_ROOT, 'src', 'web', 'public', 'sw.js'), 'utf8');
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const calls: string[] = [];
  const posted: Array<{ url: string; message: unknown }> = [];
  const clientList = windows.map((w) => ({
    url: w.url,
    visibilityState: w.visibilityState ?? 'hidden',
    postMessage(message: unknown) {
      posted.push({ url: w.url, message });
    },
    async focus() {
      calls.push(`focus ${w.url}`);
      return this;
    },
    async navigate(url: string) {
      calls.push(`navigate ${url}`);
      return this;
    },
  }));
  const self = {
    location: new URL('https://devbox.example-tailnet.ts.net:8443/sw.js'),
    navigator: { userAgent },
    addEventListener(type: string, listener: (event: unknown) => void) {
      (listeners[type] ??= []).push(listener);
    },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }),
    },
    clients: {
      matchAll: async () => clientList,
      openWindow: async (url: string) => void calls.push(`open ${url}`),
    },
  };
  const context = vm.createContext({ self, caches: {}, Request, Response, fetch, Promise, URL });
  vm.runInContext(code, context);
  const dispatch = async (type: string, extra: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = [];
    for (const listener of listeners[type] ?? []) listener({ waitUntil: (p: Promise<unknown>) => pending.push(p), ...extra });
    await Promise.all(pending);
  };
  return { shown, calls, posted, dispatch, context: context as unknown as SwGlobals };
}

/** The worker's D87 pure functions (top-level declarations of the script). */
interface SwGlobals {
  pushDecision<C extends { url: string; visibilityState: string }>(windows: readonly C[], origin: string, data: { kind?: unknown }, mustShow: boolean): { action: 'show' } | { action: 'post'; clients: C[] };
  webKitPush(userAgent: string): boolean;
}

const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const ORIGIN = 'https://devbox.example-tailnet.ts.net:8443';

describe('D87 service worker: no system notification while Switchboard is visible', () => {
  it('pushDecision: show unless a window of this origin is visible; the test notification and WebKit always show', async () => {
    const { context } = await loadWorker([]);
    const visible = { url: `${ORIGIN}/sessions/s1`, visibilityState: 'visible' };
    const hidden = { url: `${ORIGIN}/inbox`, visibilityState: 'hidden' };
    const foreign = { url: 'https://other.example/', visibilityState: 'visible' };
    const broken = { url: 'not a url', visibilityState: 'visible' };
    expect(context.pushDecision([], ORIGIN, { kind: 'turnFinished' }, false)).toEqual({ action: 'show' });
    expect(context.pushDecision([hidden, foreign, broken], ORIGIN, { kind: 'turnFinished' }, false)).toEqual({ action: 'show' });
    expect(context.pushDecision([hidden, visible, foreign], ORIGIN, { kind: 'permission' }, false)).toEqual({ action: 'post', clients: [visible] });
    const second = { url: `${ORIGIN}/`, visibilityState: 'visible' };
    expect(context.pushDecision([visible, second], ORIGIN, {}, false)).toEqual({ action: 'post', clients: [visible, second] });
    expect(context.pushDecision([visible], ORIGIN, { kind: 'test' }, false)).toEqual({ action: 'show' });
    expect(context.pushDecision([visible], ORIGIN, { kind: 'review' }, true)).toEqual({ action: 'show' });
  });

  it('webKitPush: Safari and every iOS browser; not Chromium, Android or Firefox', async () => {
    const { context } = await loadWorker([]);
    for (const ua of [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    ]) {
      expect(context.webKitPush(ua), ua).toBe(true);
    }
    for (const ua of [
      ANDROID_CHROME,
      'Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0',
    ]) {
      expect(context.webKitPush(ua), ua).toBe(false);
    }
  });

  it('a push while a Switchboard window is visible is posted to it (no notification); hidden or on WebKit it is shown', async () => {
    const payload = { title: 'web finished', body: 'The turn is done; the session is waiting for you.', url: '/sessions/s1', tag: 'session-s1', kind: 'turnFinished', id: 'session-s1:abc:1' };
    const open = await loadWorker([{ url: `${ORIGIN}/sessions/s2`, visibilityState: 'visible' }, { url: `${ORIGIN}/inbox` }]);
    await open.dispatch('push', { data: { json: () => payload } });
    expect(open.shown).toEqual([]);
    expect(open.posted).toEqual([{ url: `${ORIGIN}/sessions/s2`, message: { type: 'switchboard-notice', notice: payload } }]);
    // The test notification still shows.
    await open.dispatch('push', { data: { json: () => ({ kind: 'test', title: 'Switchboard', body: 'Notifications work on this device.', url: '/settings/devices', tag: 'test' }) } });
    expect(open.shown.map((n) => n.title)).toEqual(['Switchboard']);
    const background = await loadWorker([{ url: `${ORIGIN}/inbox`, visibilityState: 'hidden' }]);
    await background.dispatch('push', { data: { json: () => payload } });
    expect(background.shown.map((n) => n.title)).toEqual(['web finished']);
    expect(background.posted).toEqual([]);
    const iphone = await loadWorker([{ url: `${ORIGIN}/`, visibilityState: 'visible' }], 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
    await iphone.dispatch('push', { data: { json: () => payload } });
    expect(iphone.shown.map((n) => n.title)).toEqual(['web finished']);
    expect(iphone.posted).toEqual([]);
  });
});

describe('D73 service worker push', () => {
  it('shows the payload as a notification; a bad link becomes /', async () => {
    const worker = await loadWorker([]);
    await worker.dispatch('push', { data: { json: () => ({ title: 'web needs you', body: 'Which database?', url: '/sessions/s1', tag: 'inbox-b1' }) } });
    expect(worker.shown).toEqual([{ title: 'web needs you', options: { body: 'Which database?', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: '/sessions/s1' }, tag: 'inbox-b1' } }]);
    await worker.dispatch('push', { data: { json: () => ({ title: 'x', url: 'https://evil.example/' }) } });
    expect(worker.shown[1]?.options['data']).toEqual({ url: '/' });
    await worker.dispatch('push', { data: { json: () => { throw new Error('not json'); } } });
    expect(worker.shown[2]?.title).toBe('Switchboard');
  });

  it('a click focuses Switchboard and opens the link there, or opens a window', async () => {
    const open = await loadWorker([{ url: 'https://devbox.example-tailnet.ts.net:8443/inbox' }]);
    let closed = false;
    await open.dispatch('notificationclick', { notification: { data: { url: '/sessions/s1' }, close: () => void (closed = true) } });
    expect(closed).toBe(true);
    expect(open.calls).toEqual(['focus https://devbox.example-tailnet.ts.net:8443/inbox', 'navigate https://devbox.example-tailnet.ts.net:8443/sessions/s1']);
    const none = await loadWorker([{ url: 'https://other.example/' }]);
    await none.dispatch('notificationclick', { notification: { data: { url: '//evil.example/x' }, close: () => undefined } });
    expect(none.calls).toEqual(['open https://devbox.example-tailnet.ts.net:8443/']);
  });
});
