# Switchboard frame helper (D28)

A small browser extension in this repo (`tools/frame-helper/`) that lets Switchboard show a **signed-in site** such as Jira in its tool frame. Local tools don't need it: they keep the D15 framing proxy (`docs/tools.md`).

## Why

Checked on 2026-09-28:

- The Jira board `https://acme.atlassian.net/jira/software/c/projects/PROJ/boards/1` answers 200 with `content-security-policy: frame-ancestors 'self' *.atlassian.net *.jira.com *.atl-paas.net *.atlassian.com trello.com bitbucket.org *.jiraalign.com loom.com www.loom.com chrome-extension://…`. A plain frame inside Switchboard (`http://127.0.0.1:<port>`) is refused.
- Through the D15 proxy the page runs as `http://127.0.0.1:<proxy port>`, so the developer's Atlassian login cookies never reach it. It bounces to `https://id.atlassian.com/login`, which answers `X-Frame-Options: DENY`.

So a site like Jira has to be framed **directly** (its own origin, so its cookies apply), and something must lift its frame refusal for Switchboard only. The browser extension does that.

## What it does

| Part | File | What it does |
|---|---|---|
| Rule | `rules.json` | Removes the response headers `X-Frame-Options` and `Content-Security-Policy` **only** for requests of type `sub_frame` whose **initiator** is `127.0.0.1` or `localhost` (`declarativeNetRequest`, static, one rule). |
| Marker | `marker.js` | On `http://127.0.0.1:*` and `http://localhost:*` top pages, at `document_start`, sets `<html data-sb-frame-helper="<version>">` so Switchboard's page knows the helper is there (it waits for `<html>` if the engine runs the script earlier). |
| Safari login step | `storage-access.js` | In an `https:` page that is framed **directly** by a loopback top page (checked with `location.ancestorOrigins`, else `document.referrer`), and only if `document.hasStorageAccess()` resolves `false`: a small fixed banner "Allow ‹host› to use your login here" with **Allow** (and ×). Allow calls `document.requestStorageAccess()` and reloads the frame; if the browser refuses it says "Safari refused; see docs/frame-helper.md (Prevent cross-site tracking)". The banner lives in a closed shadow root with inline styles, so it cannot clash with the page. In Chrome `hasStorageAccess()` resolves `true` while third-party cookies are allowed, so nothing shows. |
| Manifest | `manifest.json` | Manifest V3; permission `declarativeNetRequestWithHostAccess` only; `host_permissions`: `https://*/*`, `http://127.0.0.1/*`, `http://localhost/*` (see *Security scope*); `minimum_chrome_version: 101` (`initiatorDomains`). |

Plain JS and JSON, no build step, no dependencies. `build-safari.ts` in the same folder is the Safari packaging script; it is not part of the extension.

## How Switchboard uses it

- A tool whose URL is a non-loopback `https:` URL is a **site** (`isSiteToolUrl`, `src/core/site-tools.ts`). Loopback means `localhost` and its subdomains, `127.0.0.0/8`, `0.0.0.0`, `::1` and IPv4-mapped loopback. Every other tool is a local tool and keeps the D15 proxy.
- The service starts **no framing proxy** for a site (its `frameUrl` is `null`): the proxy's loopback origin can never carry the site's cookies. The probe is unchanged; its `framing: "refused"` is ignored for sites.
- The Tool view of a site (`src/web/views/ToolView.tsx`, `src/web/tools/frame-helper.ts` + `useFrameHelper.ts`):
  1. **checking**: it waits up to 1.5 s for the marker (it may land just after the page loads) and keeps watching afterwards. The frame area stays empty meanwhile.
  2. With the marker, it runs one **capability check**: a hidden, same-origin frame of `GET /api/frame-helper/check`, a page that answers `X-Frame-Options: DENY` and `frame-ancestors 'none'`. The page only shows when the helper really removed those headers in this browser.
  3. **ready**: the iframe loads the site's own URL (no proxy), sandboxed as every tool (`allow-scripts allow-same-origin allow-forms allow-popups allow-downloads`, no top navigation) plus `allow-storage-access-by-user-activation`, which the Allow button needs.
  4. **absent** (no marker): "‹host› needs the Switchboard frame helper to open here" · "Install it once (Chrome and Safari): docs/frame-helper.md" · **Open in new tab**.
  5. **blocked** (marker, but the check frame was refused): "‹host› can't open in a frame in this browser" · the helper is installed but could not remove the frame headers (Safari today; a Chrome helper without site access) · **Open in new tab**.
  A site that is `down` still shows "is not reachable" first. Both overlays are the D15 fallback's card (same classes and tokens).
- Local tools are unchanged. With the helper installed their proxied frames lose their (proxy-rewritten) CSP too, since the proxy is also a loopback frame; they still load.

## Security scope

The rule touches **only** responses that load a document into an `<iframe>` (`sub_frame`) whose initiator (the page that started that load) is on `127.0.0.1` or `localhost`, any port. Nothing else changes: top-level pages, frames inside every other site, scripts, images, XHR and fetch all keep their headers. The E2E checks that a page on another site framing the same refusing stub is still refused with the helper loaded.

What "removing CSP for the framed document" means: the framed page (e.g. a Jira page inside Switchboard) loses **its whole Content-Security-Policy**, not just `frame-ancestors`, because `declarativeNetRequest` can remove or set a header but cannot edit one directive. For that one document, while it is in the loopback page's frame:
- its clickjacking protection is off (`X-Frame-Options`, `frame-ancestors`), which is the point;
- its other CSP defenses (`script-src`, `connect-src`, `object-src`, …) are off too, so an XSS bug in that site would be easier to exploit while it is framed there.

Why that is acceptable here:
- Only pages served from the developer's own machine can start such a frame: Switchboard binds to loopback, and no web site can make the browser treat it as `127.0.0.1` / `localhost`.
- Switchboard frames only URLs the developer saved as tools, in a sandbox without top navigation.
- The same document loaded any other way (a tab, another site's frame) keeps all its headers.

What remains, and is the developer's call:
- **Any** page on a loopback origin, not only Switchboard (e.g. another local dev server, or a page a local tool serves), can frame any `https:` site with its frame protection removed. Declarative rules cannot name a port, so the scope cannot be narrowed to Switchboard's port. Narrowing it to the sites the developer uses (`requestDomains`, e.g. `*.atlassian.net`) would need a list to maintain (dynamic rules fed by Switchboard). Not done.
- A local tool's D15 proxy limits `frame-ancestors` to Switchboard's two origins. With the helper, that header is removed too whenever a loopback page frames the proxy, so any loopback page can frame a local tool as well.
- The marker tells every loopback page that the helper is installed.
- `host_permissions` is `https://*/*` rather than `<all_urls>`: Chrome needs host access to both the framed URL and the initiator for `modifyHeaders`, the framed tool can be any `https:` site, and the initiators are the two loopback names. Chrome still shows it as "all websites".
- `storage-access.js` is injected into every `https:` frame but returns at once unless the frame's direct parent is a loopback top page.

## Install · Chrome (and other Chromium browsers)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. **Load unpacked** → choose `tools/frame-helper` in this repo (the folder holding `manifest.json`).
3. Keep **Site access: On all sites** (the default for an unpacked extension). With a narrower setting the rule may not apply, and Switchboard shows "can't open in a frame in this browser".
4. **Reload the Switchboard tab.** Content scripts only run in pages loaded after the install.

After pulling changes to `tools/frame-helper/`, press the reload arrow on the extension's card.

## Install · Safari

Safari needs the same sources wrapped in a macOS app. The repo builds it locally, with no Apple account:

1. **Once per Mac:** Xcode's first-launch components must be installed. On 2026-09-28 they were missing on the developer's Mac (`xcodebuild -checkFirstLaunchStatus` exits 69, and the converter stops with "A required plugin failed to load … try running 'xcodebuild -runFirstLaunch'"). Open Xcode once and accept the component install, or run `sudo xcodebuild -runFirstLaunch` (it needs an admin password, so the script never does it).
2. `npm run frame-helper:safari`. It stages the extension in `.frame-helper-safari/extension/` (Safari's rule form, below), runs `xcrun safari-web-extension-converter … --macos-only --no-open --no-prompt --copy-resources` into `.frame-helper-safari/project/`, and builds the app with `xcodebuild` (Debug, `CODE_SIGN_IDENTITY=-`, i.e. signed to run locally) into `.frame-helper-safari/DerivedData/Build/Products/Debug/Switchboard Frame Helper.app`. The whole folder is gitignored and rebuilt from scratch each run. Nothing is installed and no Safari setting is changed.
3. Open the built app once (`open ".frame-helper-safari/DerivedData/Build/Products/Debug/Switchboard Frame Helper.app"`), so Safari sees the extension.
4. The app is not signed with a developer certificate, so Safari lists its extension only when unsigned extensions are allowed: Safari → Settings → Advanced → **Show features for web developers**, then Settings → Developer → **Allow unsigned extensions** (older Safari: Develop → Allow Unsigned Extensions). Safari turns this off at every restart, so repeat it after each launch.
5. Safari → Settings → Extensions → turn on **Switchboard frame helper** and allow it on every website (at least `127.0.0.1`, `localhost` and your sites).
6. Reload the Switchboard tab.

**Safari's rule form.** WebKit turns `initiatorDomains` into a frame-URL pattern that expects a `/` right after the host name, so `127.0.0.1` never matches `http://127.0.0.1:4870/`. The Safari build therefore ships the same rule with `domains` instead, which WebKit matches against the top page's host on any port (supported since Safari 15). Chrome keeps `initiatorDomains`. Chrome rejects a rule that has both keys, and its `domains` is only a deprecated alias.

**Known limit (2026-09-28): Safari does not apply response-header rules.** MDN's compatibility data lists `declarativeNetRequest` `RuleAction.responseHeaders` as unsupported in Safari. WebKit's content-rule engine parses `modifyHeaders` response headers but applies `modify-headers` actions to requests only (`applyResultsToRequest` → `ModifyHeadersAction::applyToRequest` in `Source/WebCore/contentextensions`, main branch on that date). So in Safari the marker appears but the capability check frame stays refused, and Switchboard shows "‹host› can't open in a frame in this browser" with **Open in new tab**, not a blank frame. When WebKit starts applying response headers, the same build should work with no change here, because the check decides at run time. Only the developer's live test in Safari can confirm either way; no automated test runs Safari.

## Safari login step

Safari keeps a site's cookies out of a cross-site frame (Intelligent Tracking Prevention). Once the frame shows the site (only possible once Safari applies the rule, see above), the site may look signed out. Then:

1. In the frame, click **Allow** on the "Allow ‹host› to use your login here" banner. Safari grants storage access only if you have used that site in a normal Safari tab (first party) within the last 30 days, and it may ask you to confirm. On success the frame reloads, signed in.
2. If Safari refuses ("Safari refused; …"): sign in to the site in a normal Safari tab, then try again. The global fallback is Safari → Settings → Privacy → turn off **Prevent cross-site tracking**. That affects every site, so it is the developer's call.

A site that sends its signed-out frame to its login page by script before you click can't be helped this way. The login page (another site, e.g. `id.atlassian.com`) refuses the frame, because the page itself started that navigation (see *Troubleshooting*).

## Troubleshooting

- **"needs the Switchboard frame helper" although it is installed:** reload the Switchboard tab (content scripts are injected on page load). Check that the extension is enabled. In Safari, check that unsigned extensions are still allowed (they reset at every Safari launch) and that the extension may run on `127.0.0.1` / `localhost`.
- **"can't open in a frame in this browser":** Safari today (above). In Chrome, set the extension's site access to **On all sites**.
- **The frame shows the site's login page, or goes blank after a moment:** you are signed out in this browser profile. Sign in to the site in a normal tab, then ↻ Reload. In Chrome with third-party cookies blocked (Settings → Privacy and security → Third-party cookies), allow them for the site (e.g. `[*.]atlassian.net`), or use the Allow banner.
- **Blank frame after clicking something inside the site:** a full-page navigation that the *site* starts inside the frame has the site, not Switchboard, as its initiator. The rule then does not apply and the next page's own `frame-ancestors` refuses the frame. Single-page apps (Jira's board, issues, filters) rarely do that; switching to another Atlassian product does. ↻ Reload returns to the tool's URL; **↗ New tab** opens it in a tab.
- **Part of the page is blank (an embedded widget):** frames the site nests inside itself are not touched (their initiator is the site). One that only allows the site's own origins as ancestors is refused, because the top page is Switchboard.
- **Which version is installed?** In Switchboard's tab, `document.documentElement.dataset.sbFrameHelper` in the console.

## Tests

- `tests/tools/frame-helper.test.ts`: the manifest and rule stay in scope (exactly the two headers, only `sub_frame` + loopback initiators, the permissions); the Safari forms (`domains`, no `minimum_chrome_version`) and the converter / `xcodebuild` arguments; `marker.js` and `storage-access.js` run against small fake pages (banner only when framed directly by loopback without storage access, Allow → reload, refusal text, dismiss).
- `tests/core/site-tools.test.ts`: the site classification. `tests/web/frame-helper.test.ts`: the marker and the checking / absent / ready / blocked states.
- `tests/server/tools/proxy.test.ts`, `tests/server/api/tool-frames.test.ts`: no proxy for a site; the check page's headers; the cookie guard.
- `tests/e2e/frame-helper.spec.ts` (oracle): the real unpacked extension in Playwright's Chromium (`launchPersistentContext` + `--load-extension`, new headless via `channel: 'chromium'`) and an https stub named `site.test` that refuses every frame (`X-Frame-Options: DENY` + `frame-ancestors 'none'`). The stub's self-signed certificate is made with `node:crypto` (`tests/helpers/self-signed.ts`); Chromium maps the name with `--host-resolver-rules`, every other name fails to resolve, and certificate errors are ignored in that browser only. Covered: with the helper the site shows in a direct frame of its own URL (no proxy, no banner) and a local tool still goes through its proxy; a page on another site (`outside.test`) framing the stub is still refused; without the helper the "needs the frame helper" state and Open in new tab; with a marker but no working helper (Safari today) the "can't open in a frame" state.
