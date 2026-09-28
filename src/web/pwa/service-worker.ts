/** Path (and scope `/`) of Switchboard's service worker (`src/web/public/sw.js`). */
export const SERVICE_WORKER_URL = '/sw.js';

/**
 * Registers the service worker (D34, `docs/install-app.md`) once the page has
 * loaded. It only shows Switchboard's offline page when a navigation finds the
 * service down; it caches no UI. The web entry calls this in built UIs only
 * (`vite build`, which the E2E run uses too), never under `npm run dev`'s
 * development build. `updateViaCache: 'none'`: the browser checks the script
 * itself on every navigation, so a new worker is picked up at once. A failure is
 * logged; the app works the same without the worker.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  const register = (): void => {
    navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/', updateViaCache: 'none' }).catch((error: unknown) => {
      console.warn('Switchboard: the service worker was not registered', error);
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
