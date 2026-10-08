// @ts-check
/**
 * Switchboard's service worker (D34, docs/install-app.md), scope `/`. It exists
 * for one thing: when the service is down, a navigation shows Switchboard's own
 * offline page ("Switchboard isn't running on <host>" + Retry) instead of the
 * browser's error page.
 *
 * - It caches nothing but that page (`offline.html`), so an installed app never
 *   shows a stale UI: every page load, script, API call and the `/hub` stream go
 *   to the network.
 * - Only navigations are handled (network first, through navigation preload so
 *   the page request keeps the browser's own `Sec-Fetch-Site` for the token
 *   cookie, docs/security.md). Every other request is not intercepted at all:
 *   Chromium's static routing sends it straight to the network, and elsewhere
 *   the fetch listener returns without answering.
 *
 * Plain JavaScript, served as-is from Vite's public folder; type-checked through
 * JSDoc (`tsconfig.sw.json`). Bump CACHE_VERSION whenever offline.html changes.
 *
 * D81: it answers the share target's POST itself (the phone's share sheet, below).
 *
 * D73: it also shows web push notifications on paired devices (`push`,
 * `notificationclick`, `pushsubscriptionchange` at the end of this file).
 */

/** Bump when offline.html changes: a new version re-caches it and drops the old cache. */
const CACHE_VERSION = 1;

/** Prefix of every cache this worker made (old versions are deleted on activate). */
const CACHE_PREFIX = 'switchboard-offline-';

/** This version's cache. */
const CACHE = `${CACHE_PREFIX}v${CACHE_VERSION}`;

/** The offline page, served by the service like the manifest and the icons (public). */
const OFFLINE_URL = '/offline.html';

const worker = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

/**
 * Chromium's Static Routing API (`InstallEvent.addRoutes`, not in every browser
 * and not in TypeScript's lib yet).
 * @typedef {{ addRoutes?: (rules: unknown) => Promise<void> }} RoutableInstallEvent
 */

/**
 * Sends every request that is not a navigation straight to the network, where the
 * browser supports static routing. Never fails the install: without the rule the
 * fetch listener below still leaves those requests alone.
 * @param {ExtendableEvent} event the install event (the rule can only be added during it)
 * @returns {Promise<void>}
 */
function routeAroundWorker(event) {
  const routable = /** @type {RoutableInstallEvent} */ (/** @type {unknown} */ (event));
  if (typeof routable.addRoutes !== 'function') return Promise.resolve();
  try {
    return routable.addRoutes({ condition: { not: { requestMode: 'navigate' } }, source: 'network' }).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

worker.addEventListener('install', (event) => {
  const routed = routeAroundWorker(event);
  const cached = caches.open(CACHE).then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })));
  // A new version takes over at once: nothing it serves can mix with an older one.
  event.waitUntil(Promise.all([routed, cached]).then(() => worker.skipWaiting()));
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE).map((name) => caches.delete(name)));
      if (worker.registration.navigationPreload) await worker.registration.navigationPreload.enable();
      await worker.clients.claim();
    })(),
  );
});

worker.addEventListener('fetch', (event) => {
  const { request } = event;
  // D81: the phone's share sheet (the device origin's manifest makes the app a share target).
  if (request.method === 'POST' && new URL(request.url).pathname === SHARE_TARGET_ACTION) {
    event.respondWith(shareTarget(request));
    return;
  }
  if (request.mode !== 'navigate' || request.method !== 'GET') return;
  event.respondWith(navigate(event));
});

/**
 * Network first: the preloaded response (or a fetch when there is none); the
 * cached offline page only when the network fails. Any HTTP answer, errors
 * included, is passed through untouched.
 * @param {FetchEvent} event
 * @returns {Promise<Response>}
 */
async function navigate(event) {
  try {
    const preloaded = /** @type {Response | undefined} */ (await event.preloadResponse);
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch {
    const offline = await caches.match(OFFLINE_URL, { cacheName: CACHE });
    return offline ?? Response.error();
  }
}

// ── D81 share target (docs/devices.md → Share to Switchboard) ───────────────
// A share is a POST of title / text / url (urlencoded) to /share-target. The
// worker answers it itself, without the network: a 303 to /share?… with the
// shared fields, the page that asks which session the item goes to (it saves
// through the API like any page, with the device's credential). Without the
// worker the server answers the same (src/server/api/todo-capture.ts).

/** Where the operating system POSTs a share (src/server/devices/share-target.ts). */
const SHARE_TARGET_ACTION = '/share-target';

/** Each shared field is cut to this many characters (as the server does). */
const SHARED_FIELD_MAX = 4000;

/**
 * @param {Request} request the share's POST
 * @returns {Promise<Response>}
 */
async function shareTarget(request) {
  const query = new URLSearchParams();
  try {
    const form = await request.formData();
    for (const key of ['title', 'text', 'url']) {
      const value = form.get(key);
      if (typeof value === 'string' && value.trim() !== '') query.set(key, value.slice(0, SHARED_FIELD_MAX));
    }
  } catch {
    // An unreadable body: the page opens empty (a title can still be typed).
  }
  const text = query.toString();
  return Response.redirect(new URL(text ? `/share?${text}` : '/share', worker.location.origin).href, 303);
}

// ── D73 web push (docs/devices.md → Notifications) ──────────────────────────
// A paired phone or tablet that enabled notifications gets pushes from its
// Switchboard: a small JSON payload `{ title, body, url, tag, kind }`
// (decrypted by the browser). A click opens the deep link in Switchboard's
// window (focused, or a new one).

/**
 * A same-origin path to open: the payload's `url` when it is a plain path, else `/`.
 * @param {unknown} url
 * @returns {string}
 */
function safePath(url) {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.includes('\\') ? url : '/';
}

worker.addEventListener('push', (event) => {
  /** @type {{ title?: unknown, body?: unknown, url?: unknown, tag?: unknown }} */
  let data = {};
  try {
    data = event.data ? /** @type {typeof data} */ (event.data.json()) : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Switchboard';
  /** @type {NotificationOptions} */
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: safePath(data.url) },
  };
  if (typeof data.tag === 'string' && data.tag) options.tag = data.tag;
  event.waitUntil(worker.registration.showNotification(title, options));
});

worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = /** @type {{ url?: unknown } | null} */ (event.notification.data);
  const target = new URL(safePath(data?.url), worker.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const own = windows.find((client) => new URL(client.url).origin === worker.location.origin);
      if (own) {
        const focused = await own.focus();
        await focused.navigate(target).catch(() => null);
        return;
      }
      await worker.clients.openWindow(target);
    })(),
  );
});

/**
 * The browser replaced the subscription (keys rotated or expired): subscribe again
 * with the same key and tell Switchboard (the device's cookie goes along).
 * `pushsubscriptionchange` is not in TypeScript's lib yet.
 * @typedef {ExtendableEvent & { oldSubscription?: PushSubscription | null, newSubscription?: PushSubscription | null }} SubscriptionChangeEvent
 */
worker.addEventListener('pushsubscriptionchange', (raw) => {
  const event = /** @type {SubscriptionChangeEvent} */ (/** @type {unknown} */ (raw));
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription?.options.applicationServerKey ?? null;
      const next = event.newSubscription ?? (key ? await worker.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
      if (!next) return;
      const json = next.toJSON();
      await fetch('/api/device/push', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ subscription: { endpoint: json.endpoint, keys: json.keys } }),
      }).catch(() => null);
    })(),
  );
});
