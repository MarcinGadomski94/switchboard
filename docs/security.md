# Service security (M1.1)

Switchboard is a local service with the power to start `claude` processes and run git in the developer's repos, so any web page the developer visits must be unable to use it. The rules come from `docs/handoff/ARCHITECTURE.md` → *Security* and `docs/decisions.md` gap #20. Code: `src/server/security.ts`, `src/server/listen.ts`, `src/server/web.ts`, `src/server/token.ts`.

## Bind address
- The service listens on **127.0.0.1 only**. There is no host setting. `listenLoopback` refuses any other address (`0.0.0.0`, `::`, a LAN address, `localhost` (which can also bind `::1`), `::1`, other `127.x`) before a socket is opened, then checks the address the socket actually bound and closes the server if it is not 127.0.0.1.
- Port: `SWITCHBOARD_PORT`, default 4870. Tests use 127.0.0.1:4871–4879 only.

## Request guard (every request, the UI page included)
Installed as the first `onRequest` hook, so it also covers 404s and every route added later.

1. **Host** must be `127.0.0.1:<port>` or `localhost:<port>` (host name case-insensitive, port exact). Otherwise **403** `{"error":"forbidden-host"}`. This stops DNS rebinding: a hostile domain that resolves to 127.0.0.1 still sends its own name as Host.
2. **Origin**, when the browser sends one, must be exactly `http://127.0.0.1:<port>` or `http://localhost:<port>`. Otherwise **403** `{"error":"forbidden-origin"}`. `null` origins count as foreign. **Other loopback ports are foreign too.** SameSite does not look at ports, so a page from another local app (for example `http://127.0.0.1:13000`) is "same-site" and its browser requests would carry the cookie. Only the Origin check stops those.
3. **Cookie.** Every route needs a matching `sb_token` cookie, **401** `{"error":"unauthorized"}` otherwise. This is default-deny: unknown paths get 401 before 404. The only exceptions are routes marked `config: { public: true }`, which are just the UI page, its static files and D34's installable-app files in `web.ts` (below), and even a route marked public is protected when its path is `/api`, `/api/…`, `/hub` or `/hub/…`. API route modules registered through `src/server/routes.ts` must never set `public`.
   - Tokens are compared in constant time. Any `sb_token` value in the Cookie header may match, so a stray cookie with the same name planted by another loopback app (cookies are not isolated by port) cannot lock the UI out.

## The token and the cookie
- **Token:** 32 random bytes, base64url, created on first start at `<dataDir>/sb_token` (file 0600, folder 0700). It stays the same across restarts. An empty or corrupt file is replaced. `dataDir` = `SWITCHBOARD_DATA_DIR` or the per-user app-data folder (gap #18).
- **Issuing (gap #20):** a GET of the UI page (`/`, `/index.html` or any client-side route: a path under neither `/api` nor `/hub` whose last segment has no file extension) returns `index.html` with
  `Set-Cookie: sb_token=<token>; Path=/; HttpOnly; SameSite=Strict`
  only when the request passed the Host/Origin guard **and** has `Sec-Fetch-Site: none` (typed URL, bookmark, reload) or `same-origin`. `cross-site`, `same-site`, a missing header or any other value gets the page without the cookie. So a browser that sends no Fetch Metadata cannot use the UI (every current browser sends it).
- It is a session cookie with no `Max-Age`, `Expires`, `Domain` or `Secure` (plain http on loopback). Each qualifying page load sets it again.
- The page response is `Cache-Control: no-store`. Static files (`/assets/*`) never set the cookie. `@fastify/static` serves them from `dist/web` and refuses paths outside it.
- **One origin (D34 ruling, 2026-09-28):** a page load whose Host is `localhost:<port>` (accepted by the guard) is answered `302` to `http://127.0.0.1:<port><same path and query>` with no cookie, so the installed app and the cookie live on one origin. API and `/hub` requests are never redirected.
- When `dist/web/index.html` does not exist (`npm run build` not run yet), the same route serves a short placeholder page, with the same cookie rules.

## Installable-app files (D34)
Switchboard can be installed from the browser as an app (`docs/install-app.md`). The files that make that work are public, like the page shell, and have routes of their own in `web.ts` (`APP_FILES`, `APP_ICONS_PREFIX`):

| Path | Type | Why public |
|---|---|---|
| `/manifest.webmanifest` | `application/manifest+json` | browsers fetch a manifest without credentials (`crossorigin` absent = no cookies) |
| `/sw.js` | `text/javascript` | the service worker script; registration and update checks must not depend on the cookie |
| `/offline.html` | `text/html` | the worker caches it at install; it is shown only when the service is down |
| `/icons/*` | `image/png`, `image/svg+xml` | the app icons, the `apple-touch-icon` and the favicons, fetched by the browser and the OS |

- They hold nothing sensitive (static files from the build: no token, no data, no paths), never set the cookie, and are sent with `Cache-Control: no-cache` (the icons: `public, max-age=0`), so a new build reaches an installed app on its next load.
- The **Host/Origin guard still applies** to them (403 `forbidden-host` / `forbidden-origin`), exactly as for the page. A manifest fetch is a CORS request, so it carries Switchboard's own `Origin`, which passes.
- Everything else is unchanged: `/api` and `/hub` still need the cookie; the installed app is the same origin (`http://127.0.0.1:<port>`), so it gets the cookie from its page load like a tab does.
- **The service worker and the cookie rule (gap #20):** the worker answers only navigations and fetches them through **navigation preload**, so the page request the service sees is the browser's own, with its original `Sec-Fetch-Site` (`none` for a typed URL or the app launch, `cross-site` for a link from another site). A cross-site navigation therefore still gets the page without a cookie. It never answers `/api`, `/hub` or asset requests (they go straight to the network) and caches nothing but the offline page. Checked in `tests/e2e/install-app.spec.ts`.

## Why a framed or cross-site Switchboard page cannot act
A cross-site iframe or link that loads the UI gets `Sec-Fetch-Site: cross-site`, so no cookie is set. A cookie that already exists is `SameSite=Strict`, so the browser does not send it on cross-site requests. A same-site page on another loopback port fails the Origin check.

## Tool framing proxies (D15)
Embedded tools are framed through one reverse proxy per tool (`src/server/tools/proxy.ts`, details in `docs/tools.md` → *Framing proxy*). Each is a second listening socket, so it follows the same rules as the service, adapted to what it is:
- **Loopback only**, 127.0.0.1 with an OS-assigned port; the bound address is checked after `listen` like `listenLoopback` does.
- **Host guard:** the same `isAllowedHost` rule with the proxy's port (`127.0.0.1:<port>` / `localhost:<port>`), else 403 before anything is forwarded (HTTP and WebSocket upgrades). A rebinding domain cannot reach the tool through it.
- **One upstream:** it connects only to the saved tool URL's host and port (the same saved URLs the probe may fetch). Only a path is accepted as request target (no absolute-form proxy requests, no `CONNECT`), and redirects are passed to the browser, never followed.
- **The token never leaves:** browsers send cookies to every port of a host, so the frame's requests carry `sb_token`. The proxy removes every `sb_token` pair from `Cookie` before forwarding; the tool's own cookies pass.
- **A different origin, on purpose:** the tool runs at `http://127.0.0.1:<proxy port>`, not at Switchboard's origin, so it cannot use Switchboard's API: its API calls carry its own `Origin` and fail the Origin check (403). Its no-cors GETs are same-site and may carry the cookie, as for any other local app today, but their answers are opaque and every state-changing route needs an allowed `Origin`. The proxy itself has no cookie check: it grants nothing the tool's own port does not already offer on this machine.
- **Clickjacking:** `X-Frame-Options` is dropped and `frame-ancestors` is set to Switchboard's two origins in every CSP, **added** when the tool sends none, so only a Switchboard page can frame the tool through the proxy. The iframe keeps its sandbox (no `allow-top-navigation`).
- The proxies start with the service and stop with it; demo mode runs none.

## Frame helper extension (D28)
The optional browser extension `tools/frame-helper/` removes `X-Frame-Options` and `Content-Security-Policy` from `sub_frame` responses so Switchboard can frame signed-in sites (Jira) directly. Developer ruling 2026-09-28 (narrowed scope): only for the hosts Switchboard's page gives it (its own host, for the capability check, plus the saved site tools' hosts; plain host names, at most 50) and only in that page's tab, as tab-scoped `declarativeNetRequest` session rules kept by the extension's service worker. Only the extension's content script in the top frame of a `127.0.0.1` / `localhost` page may set a tab's hosts; a tab's rule goes when it closes, leaves loopback pages or loads a new loopback document. It is outside the service: the service only stops proxying such sites and serves `GET /api/frame-helper/check` (a page that refuses every frame, behind the cookie guard). What remains open (another loopback page can name hosts for its own tab; the framed document loses its whole CSP; in Switchboard's tab frames from Switchboard's own host, the local tools' proxies included, lose their headers too) and why that is accepted: `docs/frame-helper.md` → *Security scope*.

## Frame-helper setup openers (D35)
The guided frame-helper setup (`docs/frame-helper.md` → *Guided setup (D35)*) lets a page ask the service to run two OS commands: `POST /api/frame-helper/reveal` (the OS file manager on `tools/frame-helper`: `open -R`, `explorer /select,`, `xdg-open`) and `POST /api/frame-helper/open-extensions` (Chrome on `chrome://extensions`: `open -a "Google Chrome"`, `chrome.exe` from the usual install paths or `cmd /c start`, `google-chrome` / `chromium`). `GET /api/frame-helper` answers the folder's path and the manifest version.
- **Behind the guard:** all three are ordinary `/api` routes: loopback Host, the service's own Origin (a POST from another site or another loopback port is 403), and the `sb_token` cookie (401 without it). The cookie is `SameSite=Strict`, so a cross-site page cannot make the browser send them.
- **Fixed arguments only:** every argv is built by the service from its own checkout path and the constant `chrome://extensions`. Nothing in the request (body, query, headers) reaches a command, and the page cannot name a URL, a file or a program. Spawned with `shell: false`, detached, stdin and stdout ignored; at worst a page with the token opens Finder on that folder or Chrome's extensions page again.
- **What leaves the service:** the folder's absolute path (which reveals the user name and where the checkout lives) goes to the page that holds the token, the same page that already sees the saved folders' paths.
- **Tests never open a real app:** without an opener provider (a test app built bare) both POSTs answer 501; every test server runs them through `tools/fake-opener` (`SWITCHBOARD_OPEN_COMMAND`, a default of `testServerDefaults()`).

## Tests
`tests/server/security.test.ts` (inject), `tests/server/listen.test.ts` (real socket on a test port; also checks the port is closed on the machine's LAN address), `tests/server/main.test.ts` (the real `npm start` entry point), `tests/e2e/security.spec.ts` (real Chromium: cookie attributes, HttpOnly invisible to `document.cookie`, the page's own fetch passes, no cookie → 401). D34: `tests/server/app-files.test.ts` (the installable-app files without the cookie, their types, the Host/Origin guard, never a cookie) and `tests/e2e/install-app.spec.ts` (the worker keeps the cookie rule: a typed URL gets the cookie, a cross-site link does not). D15's proxy guard: `tests/server/tools/proxy.test.ts` (foreign Hosts, absolute-form targets, `sb_token` stripping, HTTP and upgrades).
