# Install Switchboard as an app (D34)

Switchboard can be installed from the browser as a local app (a PWA): its own window, its own Dock / taskbar / Start-menu icon, no tabs or address bar. It is the **same page at the same address** (`http://127.0.0.1:<port>`, 4870 by default), so it needs the service running like a tab does: `npm start` in the repo, or **Settings → Claude Code → Start at login** (`docs/service.md`). Nothing about the service changes.

## Install
**Chrome (and Edge), macOS / Windows / Linux**
1. Open Switchboard in Chrome at the address you use (`http://127.0.0.1:4870`).
2. **Settings → Claude Code → Install as app → Install.** The row appears only while Chrome offers installation (its `beforeinstallprompt` event), and the button opens Chrome's own install dialog. Chrome's install icon in the address bar, or the install item of its ⋮ menu (under *Cast, save and share*), does the same.
3. Start it from the Dock / Launchpad / Applications (macOS: *Chrome Apps*), the Start menu (Windows) or the app launcher (Linux). Pin it like any app.

The app window shares the Chrome profile: the same `sb_token` cookie, notification permission and extensions (the frame helper, `docs/frame-helper.md`).

**Safari (macOS Sonoma or later)**
1. Open Switchboard in Safari.
2. **File → Add to Dock…** Settings → Claude Code shows this as a one-line hint, "Install: File → Add to Dock…" (Safari has no install event, so there is no button). The name and icon come from the page (`apple-mobile-web-app-title`, the 180 px `apple-touch-icon`) and the manifest.

A Safari Dock app keeps its own website data, apart from Safari: it gets the token cookie from its own page load, like any tab, and its notification permission is its own. Safari extensions such as the frame helper may not run in it; open Switchboard in Safari itself for embedded sites that need the helper.

**Which address.** An installed app belongs to one origin. Switchboard sends every page load on `localhost:<port>` to `127.0.0.1:<port>` (developer ruling 2026-09-28), so there is one app and one cookie whichever address you type. Another port (`SWITCHBOARD_PORT`) is another origin: install again if you move the port.

Neither the button nor the hint shows inside the installed app itself (`display-mode: standalone`), nor in a browser that offers no installation (for example Chrome once the app is installed, or Firefox).

## When the service is not running
The app registers a small service worker (`/sw.js`, scope `/`). When a page load fails because nothing answers at the address (Switchboard stopped, or not started yet after a reboot), it shows Switchboard's own page instead of the browser's error:

> **Switchboard isn't running on 127.0.0.1:4870**
> Start it with `npm start` in the repo, or turn on Settings → Start at login.
> [Retry]

**Retry** reloads: once the service is back, the app opens where it was. The page works in a browser tab too. It needs one earlier load with the service running (that is when the worker installs and caches the page), and only a failed connection shows it: any answer from the service, an error included, is shown as it is.

## Updates: nothing is cached
The worker caches **only the offline page**. Every page load, script, stylesheet, API call and the `/hub` stream goes to the network as before; requests other than page loads never even reach the worker (Chromium's static routing sends them straight to the network, and elsewhere the worker leaves them alone). So an installed app never shows a stale UI: after `npm run build` and a service restart, **reload the app** (⌘R / Ctrl+R) or reopen it, and it runs the new build.

- The page itself is `Cache-Control: no-store`; the manifest, `sw.js` and `offline.html` are `no-cache`, the icons `max-age=0`.
- The browser checks `sw.js` for changes as pages load (`updateViaCache: 'none'` keeps its HTTP cache out of that check); a changed worker installs and takes over at once (`skipWaiting` + `clients.claim`).
- A changed offline page reaches installed apps only with a new worker: **bump `CACHE_VERSION` in `src/web/public/sw.js`** whenever `offline.html` changes. The old cache is deleted when the new worker activates. `tests/web/service-worker.test.ts` pins the page's hash to the version, so it fails until both are updated.
- A new name, icon or color in the manifest reaches an installed app on the browser's own schedule: Chrome re-reads the manifest now and then (and may ask before changing the name or icon); Safari keeps what it was added with until you add it to the Dock again.

## Uninstall
- **Chrome:** in the app window, the ⋮ menu → **Uninstall Switchboard…** (on macOS this also removes it from *Applications → Chrome Apps*).
- **Safari:** remove it from the Dock and delete **Switchboard** from your user's **Applications** folder (`~/Applications`).

Uninstalling removes only the window and icon. The service, its data folder and the token are untouched. To also remove the service worker from a browser, use DevTools → Application → Service workers → **Unregister** (then the browser shows its own error page again when the service is down).

## How it is built
| Piece | Where | Notes |
|---|---|---|
| Manifest | `src/web/public/manifest.webmanifest` | `id` / `start_url` / `scope` `/`, `display: standalone`, name and short name "Switchboard", `background_color` = `--bg-app` (#0b0c0d), `theme_color` = `--bg-sidebar` (#111214, the shell's own background, so the title bar joins the sidebar); icons: 192 and 512 PNG (`any`), a 512 PNG (`maskable`), the SVG (`any`) |
| Page head | `src/web/index.html` | manifest link, `theme-color`, the SVG favicon + a 32 px PNG, the 180 px `apple-touch-icon`, `apple-mobile-web-app-capable` (+ `mobile-web-app-capable`), `-title`, `-status-bar-style` |
| Icons | `src/web/public/icons/` | `icon.svg`: the sidebar's brand mark (the light rounded square with Geist SemiBold's S, as an outline, so no font is needed) at 320/512 on `--bg-app`; `icon-maskable.svg`: the mark at 256/512, inside the 80 % safe zone; `favicon.svg`: the bare 22 px mark. The PNGs are made from them by **`npm run icons`** (`tools/icons/render.ts`, Playwright's bundled Chromium) and committed with them. |
| Service worker | `src/web/public/sw.js` | plain JavaScript (Vite copies `public/` as-is), type-checked through JSDoc by `tsconfig.sw.json`; registered by `src/web/pwa/service-worker.ts` from the web entry **only in built UIs** (`import.meta.env.PROD`: `npm run build`, and the E2E build), never under `npm run dev` |
| Offline page | `src/web/public/offline.html` | inline styles on SPEC colors, no request to the (stopped) service; the host comes from `location.host` |
| Install row | `src/web/views/settings/InstallApp.tsx`, `install-app.ts`; `src/web/pwa/install-prompt.ts`, `app-install.ts`, `display-mode.ts` | the `beforeinstallprompt` event is kept from the moment the entry module loads (before React mounts); one dialog per event; `appinstalled` drops it |

**Security.** The manifest, `sw.js`, `offline.html` and `/icons/*` are served **without the token cookie** (browsers fetch a manifest without credentials), never set it, and stay behind the Host/Origin guard. The worker answers page loads through navigation preload, so the service still sees the browser's own `Sec-Fetch-Site` and the cookie rule of gap #20 holds (a link from another site gets the page without the cookie). Details: `docs/security.md` → *Installable-app files (D34)*.

**`npm run dev`** builds in development mode and registers no worker. A worker that a production build registered earlier on the same address stays and keeps showing the offline page when the service is down; it passes every page load through, so it does not get in the way (unregister it in DevTools if you want it gone).

## Tests
- `tests/tools/icons.test.ts`: every PNG of `npm run icons` is committed at its size (read from the PNG's IHDR); the SVGs load in a browser (no `--` in an XML comment, no external references or text) and use the SPEC colors.
- `tests/web/app-manifest.test.ts`: the manifest's fields, colors = tokens, its icons on disk at their sizes; the page head (manifest link, theme color, favicons, apple-touch-icon 180 px, Apple metas); the offline page's copy, Retry, SPEC-only colors and no external loads.
- `tests/web/service-worker.test.ts`: `sw.js` in a fake worker scope: install caches only the offline page (and adds the static route; a refused route never fails the install), activate deletes older offline caches, enables navigation preload and claims; fetch ignores everything but GET navigations, answers them with the preload / network, passes HTTP errors through, shows the offline page on a network failure; the offline page's hash pinned to `CACHE_VERSION`.
- `tests/web/install-app.test.ts`: the row's form (button / Safari hint / nothing: offered, standalone, Safari vs Chrome, HeadlessChrome, Edge, Opera, Firefox, iOS Chrome) and the install-offer store (kept and prevented, one dialog, failing dialog, `appinstalled`).
- `tests/server/app-files.test.ts`: the files without the cookie, their content types and `no-cache`, never a cookie, 404 when the UI is not built, 403 on a foreign Host or Origin, the API still behind the cookie; the served manifest's icons at their sizes.
- `tests/e2e/install-app.spec.ts` (Chromium): the manifest link and **no installability errors** (CDP `Page.getInstallabilityErrors`), the worker registered at `/` controlling the page with only the offline page cached, API and `/hub` unaffected, a reload served by the service; the cookie rule through the worker (typed URL: cookie; link from another page: none, API 401); the service stopped → the offline page with Retry, still down → again, back on the same port → the app; the Install row with a synthetic `beforeinstallprompt` (one dialog, `appinstalled`), the Safari hint (Safari user agent), neither in standalone (a `display-mode: standalone` stand-in).
- `tests/e2e/visual/install-row.spec.ts`: the row is an addition (not in the prototype), checked on its own against the prototype's row template (Notifications → "In-app toast + sound": row frame, label, description, the "Send test" action) and its neighbours; the Safari hint row likewise (`docs/visual/install-row.md`). The Settings visual spec and the full pass never see the row.
