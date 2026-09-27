# Service security (M1.1)

Switchboard is a local service with the power to start `claude` processes and run git in the developer's repos, so any web page the developer visits must be unable to use it. The rules come from `docs/handoff/ARCHITECTURE.md` → *Security* and `docs/decisions.md` gap #20. Code: `src/server/security.ts`, `src/server/listen.ts`, `src/server/web.ts`, `src/server/token.ts`.

## Bind address
- The service listens on **127.0.0.1 only**. There is no host setting. `listenLoopback` refuses any other address (`0.0.0.0`, `::`, a LAN address, `localhost` (which can also bind `::1`), `::1`, other `127.x`) before a socket is opened, then checks the address the socket actually bound and closes the server if it is not 127.0.0.1.
- Port: `SWITCHBOARD_PORT`, default 4870. Tests use 127.0.0.1:4871–4879 only.

## Request guard (every request, the UI page included)
Installed as the first `onRequest` hook, so it also covers 404s and every route added later.

1. **Host** must be `127.0.0.1:<port>` or `localhost:<port>` (host name case-insensitive, port exact). Otherwise **403** `{"error":"forbidden-host"}`. This stops DNS rebinding: a hostile domain that resolves to 127.0.0.1 still sends its own name as Host.
2. **Origin**, when the browser sends one, must be exactly `http://127.0.0.1:<port>` or `http://localhost:<port>`. Otherwise **403** `{"error":"forbidden-origin"}`. `null` origins count as foreign. **Other loopback ports are foreign too.** SameSite does not look at ports, so a page from another local app (for example `http://127.0.0.1:13000`) is "same-site" and its browser requests would carry the cookie. Only the Origin check stops those.
3. **Cookie.** Every route needs a matching `sb_token` cookie, **401** `{"error":"unauthorized"}` otherwise. This is default-deny: unknown paths get 401 before 404. The only exceptions are routes marked `config: { public: true }`, which are just the UI page and its static files in `web.ts`, and even a route marked public is protected when its path is `/api`, `/api/…`, `/hub` or `/hub/…`. API route modules registered through `src/server/routes.ts` must never set `public`.
   - Tokens are compared in constant time. Any `sb_token` value in the Cookie header may match, so a stray cookie with the same name planted by another loopback app (cookies are not isolated by port) cannot lock the UI out.

## The token and the cookie
- **Token:** 32 random bytes, base64url, created on first start at `<dataDir>/sb_token` (file 0600, folder 0700). It stays the same across restarts. An empty or corrupt file is replaced. `dataDir` = `SWITCHBOARD_DATA_DIR` or the per-user app-data folder (gap #18).
- **Issuing (gap #20):** a GET of the UI page (`/`, `/index.html` or any client-side route: a path under neither `/api` nor `/hub` whose last segment has no file extension) returns `index.html` with
  `Set-Cookie: sb_token=<token>; Path=/; HttpOnly; SameSite=Strict`
  only when the request passed the Host/Origin guard **and** has `Sec-Fetch-Site: none` (typed URL, bookmark, reload) or `same-origin`. `cross-site`, `same-site`, a missing header or any other value gets the page without the cookie. So a browser that sends no Fetch Metadata cannot use the UI (every current browser sends it).
- It is a session cookie with no `Max-Age`, `Expires`, `Domain` or `Secure` (plain http on loopback). Each qualifying page load sets it again.
- The page response is `Cache-Control: no-store`. Static files (`/assets/*`) never set the cookie. `@fastify/static` serves them from `dist/web` and refuses paths outside it.
- When `dist/web/index.html` does not exist (`npm run build` not run yet), the same route serves a short placeholder page, with the same cookie rules.

## Why a framed or cross-site Switchboard page cannot act
A cross-site iframe or link that loads the UI gets `Sec-Fetch-Site: cross-site`, so no cookie is set. A cookie that already exists is `SameSite=Strict`, so the browser does not send it on cross-site requests. A same-site page on another loopback port fails the Origin check.

## Tests
`tests/server/security.test.ts` (inject), `tests/server/listen.test.ts` (real socket on a test port; also checks the port is closed on the machine's LAN address), `tests/server/main.test.ts` (the real `npm start` entry point), `tests/e2e/security.spec.ts` (real Chromium: cookie attributes, HttpOnly invisible to `document.cookie`, the page's own fetch passes, no cookie → 401).
