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
