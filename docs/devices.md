# Devices: phones and tablets over Tailscale (D73)

Use Switchboard from a phone or a tablet: see the sessions, answer questions and permission requests, send messages, get a notification when a session needs you or finishes. Developer request and rulings 2026-10-08 (`docs/decisions.md` → D73): **access through Tailscale with per-device pairing** (QR code + one-time code, each device its own revocable credential, nothing on the LAN or the internet, loopback unchanged), and **web push** for permission requests, questions, finished turns and the other Inbox items.

Code: `src/server/devices/` (service, guard, pairing, `tailscale serve`, push), `src/server/api/devices.ts`, `src/core/devices.ts`, `src/web/views/settings/DevicesSection.tsx`, `src/web/pwa/push*.ts`, `src/web/public/sw.js` (push handlers). Storage: migration 0030 (`docs/database.md`). Security model: `docs/security.md` → *Device listener (D73)*.

## Transport
A phone needs a **secure context** (HTTPS) to install Switchboard as an app and to receive web push, and Switchboard must stay off the LAN. Two shapes were weighed:

| | (a) `tailscale serve` → a second loopback listener | (b) a listener on the Tailscale IP, plain HTTP |
|---|---|---|
| HTTPS | yes: a real `*.ts.net` certificate (Let's Encrypt via Tailscale) | no: `http://100.x.y.z` is not a secure context |
| Install as app / web push on iOS | yes (Home Screen app) | no |
| Who terminates TLS | `tailscaled` | nobody (WireGuard only) |
| What Switchboard binds | 127.0.0.1 only | a 100.64.0.0/10 address |

**Chosen: (a).** When device access is on, Switchboard starts a **device listener on 127.0.0.1:<port>** (default **13003**, a second socket next to the UI's 13001) and runs

```
tailscale serve --bg --https=<httpsPort> http://127.0.0.1:<port>
```

(default HTTPS port **8443**; `tailscale serve` allows 443, 8443 and 10000; 8443 keeps a 443 you may already serve untouched, ASSUMED D73-https-port). Devices then open `https://<machine>.<tailnet>.ts.net:8443`. Off by default; switching it off runs `tailscale serve --https=<httpsPort> off`, for the port Switchboard set up itself only (it remembers what it configured, `devices.serve`), and stops the listener. Before turning serve on, `tailscale serve status --json` is read: an HTTPS port already served by something else is reported (*port busy*), never overwritten. `tailscale serve --bg` persists in `tailscaled`; Switchboard re-applies it at every start while device access is on. While Switchboard is stopped, the address answers 502 from Tailscale.

Because every request on the device listener arrives from 127.0.0.1 (from `tailscaled`), **nothing on it trusts loopback**: it has its own guard and authenticates each device by its own credential (below). The UI listener keeps its loopback trust and behaviour exactly as before.

### What the tailnet must have
`tailscale status --json` decides what Settings → Devices shows:
- Tailscale running and signed in (`BackendState: Running`) — else *Tailscale is not connected*;
- **MagicDNS** on (the machine has a `*.ts.net` name) — else *Turn on MagicDNS*;
- **HTTPS certificates** on (Tailscale admin console → DNS → HTTPS Certificates; `CertDomains` lists the machine) — else *Turn on HTTPS certificates*;
- **Serve** allowed on the tailnet: the first `tailscale serve` on a tailnet may print a consent link ("Serve is not enabled on your tailnet. To enable, visit: …"). The call is time-limited; Settings shows the message and an **Open Tailscale** link to that page. Switch device access off and on afterwards.
- Linux: `tailscale serve` needs the user to be the Tailscale operator (`sudo tailscale set --operator=$USER`).

Tailscale ≥ 1.52 (the `serve --bg --https=` form).

## Pairing
- On the computer, **Settings → Devices → Pair a device** (device access on and HTTPS working): a QR code of `https://<machine>.<tailnet>.ts.net:8443/pair#code=XXXX-XXXX` and the code itself. The code is in the URL's fragment, which the browser never sends to the server.
- **One-time code:** 8 characters (40 bits, the D48 alphabet), **10 minutes**, **single use**, burned after **5 wrong tries**, one at a time (a new one replaces the old), stored as a sha256 hash (`device_pairing_codes`).
- **Rate limit:** at most **10 pairing attempts per 10 minutes** on the device listener, from anyone (every request comes from 127.0.0.1 through `tailscaled`, so there is no per-client address to count by): the 11th is 429 `rate-limited`, even with the right code.
- The phone opens the link (or `…/pair` and types the code). An unpaired device gets **only the pairing page** (`GET /pair`), its exchange (`POST /device/v1/pair`) and the installable-app files (manifest, icons, service worker, offline page); any other page load is redirected to `/pair`, anything else is 401.
- The page asks for a name (prefilled from the user agent: *iPhone · Safari*, *Android phone · Chrome*, …) and **Pair**. Switchboard answers 201 with a **device credential**: the cookie `__Host-sb_device=<device id>.<secret>`, `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=400 days`, host-only on the device origin (the `__Host-` prefix forbids a `Domain`). Only sha256 of the secret is stored; it is compared in constant time. Every page load refreshes the Max-Age, so a device in use never expires.
- If `tailscale serve` sent `Tailscale-User-Login` with the pairing request, it is recorded; later requests of that device must carry the same login (an extra check, not the credential).

## Devices list
Settings → Devices on the computer lists each device: name (Rename), paired / last seen (written at most once a minute), notifications on / off, **Revoke**. Revoke deletes the device (and its push subscription) at once and **closes its open connections**, so its `/hub` stream ends immediately; its next page load clears the cookie and lands on the pairing page (the UI also goes there on any 401 on a device origin).

## What a device may do (allow-list)
Developer ruling 2026-10-08: device requests to `/api/…` are refused (403 `local-only`) **unless the route is on `DEVICE_ALLOWED`** (`src/server/devices/local-only.ts`). Pages, static files and `/hub` are not `/api`.
- **Allowed** (what a phone needs for normal use): sessions (list, detail, events, diff, attachments, workflow-agent chats, full messages, start, messages, stop / background stop, pause / resume, close / reopen, resend, title, model, Remote Control, CLI and account switch, profile pin, Continue in Switchboard), todos, the Inbox and its answers / actions, what starting a session needs (folders read, models, solutions and branches, branching preflight, staged attachments), artifacts, the sidebar layout, History and its Continue, schedules and loops (list, save, run now, pause / resume, delete, terminal sessions and Hook into…), the reads the UI needs (system / usage, settings, CLIs, accounts, machines, tools and their probes, MCP and hooks status, setup state, updates, frame helper state), the UI preferences (`PUT /api/settings`), Reconnect of a paired machine, and the device's own `/api/device*` (name, notifications).
- **Refused** (listed explicitly in `DEVICE_REFUSED`): pairing / revoking devices and the access switch; machines administration (pair, add, remove, rename, listener, shared layout); hooks install / remove; MCP edits, toggles, reconnects, checks and sign-ins; updates (check, dismiss, install); Start at login; CLI command overrides, default CLI and checks; account profiles and their sign-ins; embedded tools' URLs and the frame helper's openers; saved folders' writes and the setup wizard (Browse… lists the file system); take-over (D65, stays desktop-only); terminal attach / detach and teleport; solution isolation; codebase-memory reindex; the test hooks.
- **Every route is classified:** `buildApp` records its routes (`registeredRoutes`); `tests/server/devices/units.test.ts` fails when an `/api` route is on neither list, or on both, so a new route must be classified.
- A call to a paired machine's API through `/api/machines/{id}/api/<rest>` is judged as `/api/<rest>`; a proxy inside the proxy is refused. Paths are percent-decoded and doubled slashes collapsed before matching; an undecodable path is refused. Embedded tools' frames point at `127.0.0.1` proxies and do not work on a device.

## Notifications
- **VAPID** keys (P-256) are made once and kept in `<dataDir>/vapid.json` (0600); the private scalar is always stored as 32 bytes (Node's `getPrivateKey()` drops leading zero bytes, about 1 key in 256). `GET /api/device` hands a paired device the public key.
- **Opt-in per device**, in the device's own Settings → Devices → **Enable notifications** (permission asked on the click, then `pushManager.subscribe` through the service worker, the subscription stored with `PUT /api/device/push`). **iPhone / iPad**: web push works only from the Home Screen app (iOS / iPadOS 16.4+): in a Safari tab the page says to add Switchboard to the Home Screen first. A Home Screen app keeps its own cookies, so it is paired on its own (it shows the pairing page; make a new code on the computer). Blocked permission and browsers without push are explained too.
- **Per-device toggles:** Permission requests, Questions, Turn finished, Session errors, Other Inbox items (all on when enabled). **Send test** sends one test notification.
- **What triggers a push** (`src/server/devices/push/notifier.ts`): a new Inbox item after `inboxChanged` (a permission request, a question batch, a system item such as a failed scheduled run or an update); a session whose status goes from `run` to `idle` / `done` (turn finished); a session whose status becomes `fail`. Nothing is sent while device access is off.
- **Paired machines too** (developer ruling 2026-10-08): a paired machine's (D48) question batches, permission requests and its sessions' finished turns / errors notify this machine's devices. They come through the existing peer event stream, which carries only what happened on that machine (never an echo of ours); the peer's Inbox cache is refreshed before its `inboxChanged` goes on, so the merged Inbox (`listInbox` + `PeerService.remoteInbox()`) holds the new item. The title names the machine (`api · pc-office needs you`), the link is the remote session (`/sessions/r~<machine>~<id>`). Per-device toggles apply.
- **Once per event:** each Inbox item id is announced once (remembered 24 h), so a machine that drops and reconnects does not announce its items again, and only while it is fresh: created after the notifier started (a minute of clock slack) and within the last 10 minutes; older items a reconnecting machine lists are not news. The items present at start are known, never announced.
- **Payload** (`{ title, body, url, tag, kind }`): the session's name, a short text (≤ 140 characters: the first question, the permission item's title, …) and the deep link (`/sessions/<id>`, `/inbox`); `tag` replaces an older notification of the same item. Encrypted per **RFC 8291** (`aes128gcm`, RFC 8188) to the subscription's keys and signed with a **VAPID** JWT (RFC 8292, ES256, `aud` = the push service's origin, 12 h, `sub` = the project page). `TTL: 3600`; `Urgency: high` for permission requests and questions.
- **Implemented with Node's crypto, no dependency** (`push/crypto.ts`): ECDH P-256, HKDF-SHA-256, AES-128-GCM and ECDSA P-256 are all built in, and the construction is small. The test suite checks it against the RFC 8291 appendix A example byte for byte and decrypts every test push with an independent receiver.
- **Endpoints** are accepted only on the browser vendors' push services (`*.push.apple.com`, `fcm.googleapis.com`, `android.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`, https, default port): a device cannot make Switchboard POST to an arbitrary host. 404 / 410 from the push service removes the subscription; other failures are kept as the device's last error.
- The service worker (`sw.js`) shows the notification and, on a click, focuses Switchboard's window and opens the link (or opens a window); a `pushsubscriptionchange` re-subscribes and tells Switchboard.
- `PRIVACY.md` → *Notifications on your devices*: what goes to Apple / Google / Mozilla / Microsoft.

## Install as an app
The device origin serves the same manifest (`display: standalone`, theme color, icons) and `apple-touch-icon` as the UI. Android Chrome offers *Install app*; iOS Safari: Share → **Add to Home Screen**. The manifest and icons are public on the device listener (browsers fetch them without credentials) and hold nothing sensitive.

## API
`docs/handoff/contracts/local-api.md` → *Devices (D73)*.

## Tests
- `tests/server/devices/listener.test.ts`: unpaired requests (only the pairing page, its exchange and the app files; 401 / redirect otherwise), loopback trust never applied (the install token, loopback Hosts refused), Host / Origin / `X-Forwarded-Host`, the UI listener unchanged, pairing (cookie attributes, hash only, single use, wrong codes burned after 5, expiry, rate limit, the Tailscale login), local-only refusals (encoded paths, through a paired machine), revoke (access and the `/hub` stream end).
- `tests/server/devices/access.test.ts`: off by default; on / off with the exact `tailscale` calls (`tools/fake-tailscale` logs them); no HTTPS certificates, Tailscale stopped or missing, the Serve consent link, a busy HTTPS port.
- `tests/server/devices/peers.test.ts`: two real processes: a session on the paired machine B finishes its turn and asks a question → one push each on A's device, linking `r~<B>~<id>`.
- `tests/server/devices/push.test.ts`: the notifier's once-per-item and freshness rules (a peer's item, a reconnect), the RFC 8291 example vector, VAPID JWT, the key file (0600, stable), the endpoint allow-list, delivery per event and per toggle verified and decrypted by the fake push service (`tests/helpers/fake-push.ts`), 404 / 410 cleanup, nothing while access is off.
- `tests/server/devices/units.test.ts`: every registered `/api` route classified, the allow-list, names from user agents, toggles, `tailscale status` / `serve status` parsing, migration 0030.
- `tests/web/devices.test.ts`: the device's push states (iOS in a tab, denied, unsupported), the section's copy, the service worker's `push` / `notificationclick`.
- `tests/e2e/devices.spec.ts`: desktop + a 390×844 phone context (real taps on D74's phone layout: the sessions in the ☰ drawer, Settings list → Devices detail): QR pairing end to end, the phone sees the sessions, notifications enabled and a test push decrypted by the fake push service, an iPhone told to add the app first, revoke, a wrong code.
- Test-only variables: `SWITCHBOARD_DEVICE_TEST_ORIGIN` (`http://localhost:<port>`, the devices' origin instead of the `*.ts.net` one) and `SWITCHBOARD_PUSH_TEST_ENDPOINTS` (the fake push service's origin).

## Manual checklist (real Tailscale, real phones)
Not automated (no real Tailscale, Apple or Google in tests). On the computer:
1. Tailscale admin console → DNS: MagicDNS on, HTTPS Certificates on.
2. Settings → Devices → Device access **on**. If it shows a Serve consent link, open it, enable Serve, switch access off and on. Expect `On: https://<machine>.<tailnet>.ts.net:8443 → 127.0.0.1:13003`. `tailscale serve status` shows the proxy.
3. Check from another tailnet machine: `curl -I https://<machine>.<tailnet>.ts.net:8443/api/sessions` → 401; `…/pair` → 200. From the LAN IP / the internet: nothing listens.
4. Android (Chrome): Pair a device → scan the QR → Pair → the sessions show. Install app from the menu; open it (it shares Chrome's cookies). Settings → Devices → Enable notifications → Send test → a notification. Start a session that asks a question → a notification; tap it → the session opens.
5. iPhone (iOS 16.4+): scan the QR in Safari → pairing works in the tab. Share → Add to Home Screen; open the Home Screen app → it shows the pairing page: make a new code on the computer and pair. Settings → Devices → Enable notifications (allow) → Send test. Lock the phone; trigger a permission request → notification; tap → session.
6. Revoke the iPhone on the computer: the open app loses its live updates at once and returns to the pairing page.
7. Switch device access off: `tailscale serve status` no longer lists 8443; the phone cannot connect.
8. Toggles: turn *Turn finished* off on a device; finish a turn → no notification; a question still notifies.
