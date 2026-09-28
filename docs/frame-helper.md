# Switchboard frame helper (D28)

A small browser extension in this repo (`tools/frame-helper/`) that lets Switchboard show a **signed-in site** such as Jira in its tool frame. Local tools don't need it: they keep the D15 framing proxy (`docs/tools.md`).

## Why

Checked on 2026-09-28:

- The Jira board `https://acme.atlassian.net/jira/software/c/projects/PROJ/boards/1` answers 200 with `content-security-policy: frame-ancestors 'self' *.atlassian.net *.jira.com *.atl-paas.net *.atlassian.com trello.com bitbucket.org *.jiraalign.com loom.com www.loom.com chrome-extension://…`. A plain frame inside Switchboard (`http://127.0.0.1:<port>`) is refused.
- Through the D15 proxy the page runs as `http://127.0.0.1:<proxy port>`, so the developer's Atlassian login cookies never reach it. It bounces to `https://id.atlassian.com/login`, which answers `X-Frame-Options: DENY`.

So a site like Jira has to be framed **directly** (its own origin, so its cookies apply), and something must lift its frame refusal for Switchboard only. The browser extension does that.

**Scope (developer ruling 2026-09-28, after the build):** the helper removes the frame headers only for the hosts of the developer's saved **site tools**, and only in the browser tab that runs Switchboard. Switchboard's page gives the extension those hosts; the extension keeps them as tab-scoped session rules. The first build's static rule for any loopback page is gone (helper version 2.0.0).

## What it does

| Part | File | What it does |
|---|---|---|
| Rules | `background.js` | The service worker. It keeps **one `declarativeNetRequest` session rule per tab**: `condition: { tabIds: [that tab], resourceTypes: ['sub_frame'], requestDomains: <the page's hosts> }`, `action: modifyHeaders` removing the response headers `X-Frame-Options` and `Content-Security-Policy`. The rule's id is the tab's id; each list the page sends **replaces** it (an empty list removes it). It accepts a list only from its own content script in the **top frame of a loopback page** (`sender.frameId === 0`, `sender.url` on `http://127.0.0.1` / `http://localhost`, any port) and only **plain host names**, at most **50** (below). A refused list leaves the tab with no rule. A tab's rule goes when the tab **closes** (`tabs.onRemoved`), **navigates to a page that is not loopback** (`tabs.onUpdated`; a page whose URL the extension may not see counts as not loopback), or **loads a new loopback document** (`frame-helper:reset` from `marker.js`: the new page has to ask again). Rule updates run one at a time, in order. |
| Marker + relay | `marker.js` | On `http://127.0.0.1:*` and `http://localhost:*` top pages, at `document_start`, sets `<html data-sb-frame-helper="<version>">` so Switchboard's page knows the helper is there (it waits for `<html>` if the engine runs the script earlier). Then, only when `window.top === window` and the page is `http:` on `127.0.0.1` / `localhost`: sends `frame-helper:reset` to the worker, and relays the page's `window.postMessage({ source: 'switchboard', type: 'frame-helper:sites', id, hosts })` (only from the page's own window and origin, never from a frame) to the worker. The worker's answer goes back to the page as `{ source: 'switchboard-frame-helper', type: 'frame-helper:sites-applied', id, ok, hosts, error }`. |
| Safari login step | `storage-access.js` | In an `https:` page that is framed **directly** by a loopback top page (checked with `location.ancestorOrigins`, else `document.referrer`), and only if `document.hasStorageAccess()` resolves `false`: a small fixed banner "Allow ‹host› to use your login here" with **Allow** (and ×). Allow calls `document.requestStorageAccess()` and reloads the frame; if the browser refuses it says "Safari refused; see docs/frame-helper.md (Prevent cross-site tracking)". The banner lives in a closed shadow root with inline styles, so it cannot clash with the page. In Chrome `hasStorageAccess()` resolves `true` while third-party cookies are allowed, so nothing shows. |
| Manifest | `manifest.json` | Manifest V3, version 2.0.0; permission `declarativeNetRequestWithHostAccess` only; `host_permissions`: `https://*/*`, `http://127.0.0.1/*`, `http://localhost/*`; `background.service_worker: background.js`; no static rules; `minimum_chrome_version: 101` (`requestDomains`). Why each one: *Permissions* below. |

**Plain host names.** Lower-case DNS names of two or more labels (letters, digits, `-`; punycode for international names), dotted IPv4 addresses, or `localhost`. No `*`, ports, paths, schemes, brackets (IPv6), trailing dots or single labels. `requestDomains` also matches **subdomains** of each entry (that is what the key means in Chrome), so `acme.atlassian.net` also covers `x.acme.atlassian.net`; a single label such as `net` would cover every `.net` site, which is why it is refused. The page applies the same check before it sends (`isFrameHelperHost` in `src/core/site-tools.ts`; a unit test keeps the two in step).

Plain JS and JSON, no build step, no dependencies. `build-safari.ts` in the same folder is the Safari packaging script; it is not part of the extension.

## How Switchboard uses it

- A tool whose URL is a non-loopback `https:` URL is a **site** (`isSiteToolUrl`, `src/core/site-tools.ts`). Loopback means `localhost` and its subdomains, `127.0.0.0/8`, `0.0.0.0`, `::1` and IPv4-mapped loopback. Every other tool is a local tool and keeps the D15 proxy.
- The service starts **no framing proxy** for a site (its `frameUrl` is `null`): the proxy's loopback origin can never carry the site's cookies. The probe is unchanged; its `framing: "refused"` is ignored for sites.
- **The host list** (`useFrameHelperSites`, `src/web/tools/useFrameHelper.ts`; logic in `frame-helper.ts` → `createSitesSync`): whenever the tools list loads or changes (the sidebar's `GET /api/tools`, reloaded on `useToolsChanged`, and the Tool view's own fetch, which may be fresher when another tab added a tool), the page posts `frameHelperHosts(tools, location.hostname)` to its own window: **Switchboard's own host first** (for the capability check, below), then the hostname of every saved site tool, deduplicated, without hosts the helper would refuse, at most 50. An unchanged list is not sent again. It is sent in a layout effect, before the view paints. Each list gets a new `id`; only the answer to the latest one counts, and the page stops waiting for it after 2 s (`SITES_TIMEOUT_MS`). After a back/forward-cache restore the page sends its list again.
- The Tool view of a site (`src/web/views/ToolView.tsx`, `src/web/tools/frame-helper.ts` + `useFrameHelper.ts`):
  1. **checking**: it waits up to 1.5 s for the marker (it may land just after the page loads) and keeps watching afterwards. The frame area stays empty meanwhile.
  2. With the marker, it waits until the helper answered the page's host list (sending it again if an earlier one went unanswered), then runs one **capability check**: a hidden, same-origin frame of `GET /api/frame-helper/check`, a page that answers `X-Frame-Options: DENY` and `frame-ancestors 'none'`. The page only shows when the helper really removed those headers in this browser. It is on Switchboard's own host, which is why that host is in the list.
  3. **ready**: once the helper also confirmed **this site's host** for the tab (`siteFrameStatus`; `checking` while the latest list waits for its answer), the iframe loads the site's own URL (no proxy), sandboxed as every tool (`allow-scripts allow-same-origin allow-forms allow-popups allow-downloads`, no top navigation) plus `allow-storage-access-by-user-activation`, which the Allow button needs.
  4. **absent** (no marker): "‹host› needs the Switchboard frame helper to open here" · "Install it once in Chrome: docs/frame-helper.md (Safari can’t frame signed-in sites: open it in a new tab)" · **Open in new tab**.
  5. **blocked** (marker, but the check frame was refused, or the helper answered the list without this site's host): "‹host› can't open in a frame in this browser" · the helper is installed but could not remove the frame headers (Safari today; a Chrome helper without site access; a host the helper refused) · **Open in new tab**.
  A helper that never answers a host list (the first build, 1.0.0, with its static rule) is trusted on the capability check alone.
  A site that is `down` still shows "is not reachable" first. Both overlays are the D15 fallback's card (same classes and tokens).
- Local tools are unchanged. When Switchboard runs on `127.0.0.1` (the default), its own host is in the list, so in Switchboard's tab their proxied frames (`http://127.0.0.1:<proxy port>`) lose their (proxy-rewritten) CSP too; they load either way, since the proxy allows Switchboard's two origins as ancestors.

## Security scope

**What is opened up.** Only `sub_frame` responses (a document loading into an `<iframe>`) whose host is in the list Switchboard's page gave the helper, and only **in the tab that runs Switchboard** (`tabIds`). The list is Switchboard's own host (`127.0.0.1` or `localhost`) plus the hosts of the saved site tools; `requestDomains` also matches their subdomains. Nothing else changes: frames in any other tab (whichever page frames the host there), other hosts framed in Switchboard's tab, top-level pages, scripts, images, XHR and fetch all keep their headers. The E2E checks that, while Switchboard's tab has its rule, a non-saved https host framed in Switchboard's own tab, the saved host framed by another loopback page in another tab, and the saved host framed by a page on another site in another tab are all still refused, and that the host is refused again once the tool is removed in Settings.

What "removing CSP for the framed document" means: the framed page (e.g. a Jira page inside Switchboard) loses **its whole Content-Security-Policy**, not just `frame-ancestors`, because `declarativeNetRequest` can remove or set a header but cannot edit one directive. For that one document, while it is in Switchboard's tab:
- its clickjacking protection is off (`X-Frame-Options`, `frame-ancestors`), which is the point;
- its other CSP defenses (`script-src`, `connect-src`, `object-src`, …) are off too, so an XSS bug in that site would be easier to exploit while it is framed there.

Why that is acceptable here:
- Only the developer's saved site tools (and Switchboard's own pages) are affected, and only in Switchboard's tab. Switchboard frames only URLs the developer saved as tools, in a sandbox without top navigation.
- The same document loaded any other way (another tab, a top-level page, another site's frame) keeps all its headers.

**Who may set a tab's hosts.** Only the helper's own content script, from the **top frame** of an `http://127.0.0.1:*` / `http://localhost:*` page (checked by the content script and again by the worker), relaying a message that page posted to its own window. A framed tool cannot post it (its messages come from another window), and no web site can make the browser treat it as `127.0.0.1` / `localhost`. Hosts must be plain host names, at most 50.

**When a tab's hosts go.** The tab closes; it navigates to a page that is not loopback; or a new loopback document loads in it (every new page starts without rules and must ask). A Switchboard reload therefore asks again, and the site's frame waits for the answer.

What remains, and is the developer's call:
- **Any loopback page** (another local dev server, or a page a local tool serves), loaded as the top page of a tab, can post the same message and so name hosts for **its own tab**. Declarative rules cannot name a port, and nothing in the browser proves that a loopback page is Switchboard. It still cannot touch Switchboard's tab or any other tab, and the rules go as soon as the tab leaves it.
- Switchboard's own host is in the list for the capability check (ASSUMED D28-check-host), so in Switchboard's tab every frame from that host, the D15 proxies of local tools included, loses its headers too. Those are Switchboard's own or the developer's local tools, framed only by Switchboard.
- Navigations a site starts inside its own frame now keep working while they stay on saved hosts (the rule has no initiator condition); a navigation to a host that is not saved (e.g. Jira → `id.atlassian.com`) is refused.
- Between a tab starting to leave Switchboard and the worker removing its rule there is a moment (the time of one `updateSessionRules` call) in which the new page could frame a saved host.
- The marker tells every loopback page that the helper is installed.

### Permissions

The smallest set Chrome needs for this:
- `declarativeNetRequestWithHostAccess`: the session-rule API without the "block content on any page" install warning. `modifyHeaders` needs host access to the framed URL and to its initiator either way.
- `host_permissions`: `https://*/*` because a saved site tool can be any `https:` site and its host is only known at run time (a fixed list would need a new extension build per site); `http://127.0.0.1/*` and `http://localhost/*` (any port) for the initiator, Switchboard's own check page, and to see a loopback tab's URL in `tabs.onUpdated`. Chrome still shows it as "all websites". Not `<all_urls>`.
- No `tabs`, `webNavigation`, `storage` or `scripting`: the `tabs` events work without the `tabs` permission (a tab's URL is visible where the extension has host access, which covers the loopback check), the rules live in the browser, and the scripts are declared.
- `background.service_worker` runs `background.js`; `minimum_chrome_version: 101` because `requestDomains` needs Chrome 101 (an older Chrome would drop the condition and widen the rule to every host in the tab).

## Install · Chrome (and other Chromium browsers)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. **Load unpacked** → choose `tools/frame-helper` in this repo (the folder holding `manifest.json`).
3. Keep **Site access: On all sites** (the default for an unpacked extension). With a narrower setting the rules may not apply, and Switchboard shows "can't open in a frame in this browser".
4. **Reload the Switchboard tab.** Content scripts only run in pages loaded after the install.

After pulling changes to `tools/frame-helper/`, press the reload arrow on the extension's card, then reload the Switchboard tab (a reload of the extension drops its session rules; the page gives them again when it loads). Chrome may write generated files into `tools/frame-helper/_metadata/` when it loads the folder (the first build's static rules did); that folder is gitignored.

**Manual check in Chrome (after reloading the extension, version 2.0.0 on its card):**
1. Reload the Switchboard tab and open the Jira tool: it shows signed in, in the frame. In the console, `document.documentElement.dataset.sbFrameHelper` is `2.0.0`.
2. On the extension's card, **Inspect views: service worker** → Console → `await chrome.declarativeNetRequest.getSessionRules()`: one rule, `tabIds` = [Switchboard's tab], `requestDomains` = `["127.0.0.1", "acme.atlassian.net"]` (your site tools' hosts), removing `x-frame-options` and `content-security-policy`.
3. In another tab, open a different local page (e.g. another dev server on `http://127.0.0.1:<port>`) that frames the Jira URL: it is refused (the console says `frame-ancestors`), and the rules are unchanged.
4. In Switchboard, Settings → Embedded tools → remove the Jira tool: the rule's `requestDomains` shrinks to `["127.0.0.1"]`. Add it back: the host returns and the tool opens in the frame again.
5. Close the Switchboard tab: `getSessionRules()` is `[]`.

## Install · Safari

Safari needs the same sources wrapped in a macOS app. The repo builds it locally, with no Apple account:

1. **Once per Mac:** Xcode's first-launch components must be installed. On 2026-09-28 they were missing on the developer's Mac (`xcodebuild -checkFirstLaunchStatus` exits 69, and the converter stops with "A required plugin failed to load … try running 'xcodebuild -runFirstLaunch'"). Open Xcode once and accept the component install, or run `sudo xcodebuild -runFirstLaunch` (it needs an admin password, so the script never does it).
2. `npm run frame-helper:safari`. It stages the extension in `.frame-helper-safari/extension/` (Safari's rule form, below), runs `xcrun safari-web-extension-converter … --macos-only --no-open --no-prompt --copy-resources` into `.frame-helper-safari/project/`, and builds the app with `xcodebuild` (Debug, `CODE_SIGN_IDENTITY=-`, i.e. signed to run locally) into `.frame-helper-safari/DerivedData/Build/Products/Debug/Switchboard Frame Helper.app`. The whole folder is gitignored and rebuilt from scratch each run. Nothing is installed and no Safari setting is changed.
3. Open the built app once (`open ".frame-helper-safari/DerivedData/Build/Products/Debug/Switchboard Frame Helper.app"`), so Safari sees the extension.
4. The app is not signed with a developer certificate, so Safari lists its extension only when unsigned extensions are allowed: Safari → Settings → Advanced → **Show features for web developers**, then Settings → Developer → **Allow unsigned extensions** (older Safari: Develop → Allow Unsigned Extensions). Safari turns this off at every restart, so repeat it after each launch.
5. Safari → Settings → Extensions → turn on **Switchboard frame helper** and allow it on every website (at least `127.0.0.1`, `localhost` and your sites).
6. Reload the Switchboard tab.

**Safari's form.** The build stages `manifest.json` without `minimum_chrome_version` and copies `background.js`, `marker.js` and `storage-access.js` unchanged. There are no static rules any more: the service worker sets session rules with `tabIds` + `requestDomains` at run time (the first build's static rule needed `domains` in Safari, because WebKit turns `initiatorDomains` into a frame-URL pattern that never matches a page with a port). Whether Safari takes `tabIds` / `requestDomains` in session rules is unverified; it does not matter today, because it does not apply response-header rules at all (below). If the worker's update fails, the page gets `ok: false` and shows "can't open in a frame in this browser"; the capability check decides either way.

**Known limit (2026-09-28): Safari does not apply response-header rules.** MDN's compatibility data lists `declarativeNetRequest` `RuleAction.responseHeaders` as unsupported in Safari. WebKit's content-rule engine parses `modifyHeaders` response headers but applies `modify-headers` actions to requests only (`applyResultsToRequest` → `ModifyHeadersAction::applyToRequest` in `Source/WebCore/contentextensions`, main branch on that date). So in Safari the marker appears but the capability check frame stays refused, and Switchboard shows "‹host› can't open in a frame in this browser" with **Open in new tab**, not a blank frame. When WebKit starts applying response headers, the same build should work with no change here, because the check decides at run time. Only the developer's live test in Safari can confirm either way; no automated test runs Safari.

## Safari login step

Safari keeps a site's cookies out of a cross-site frame (Intelligent Tracking Prevention). Once the frame shows the site (only possible once Safari applies the rule, see above), the site may look signed out. Then:

1. In the frame, click **Allow** on the "Allow ‹host› to use your login here" banner. Safari grants storage access only if you have used that site in a normal Safari tab (first party) within the last 30 days, and it may ask you to confirm. On success the frame reloads, signed in.
2. If Safari refuses ("Safari refused; …"): sign in to the site in a normal Safari tab, then try again. The global fallback is Safari → Settings → Privacy → turn off **Prevent cross-site tracking**. That affects every site, so it is the developer's call.

A site that sends its signed-out frame to its login page by script before you click can't be helped this way. The login page (another site, e.g. `id.atlassian.com`) refuses the frame, because the page itself started that navigation (see *Troubleshooting*).

## Troubleshooting

- **"needs the Switchboard frame helper" although it is installed:** reload the Switchboard tab (content scripts are injected on page load). Check that the extension is enabled. In Safari, check that unsigned extensions are still allowed (they reset at every Safari launch) and that the extension may run on `127.0.0.1` / `localhost`.
- **"can't open in a frame in this browser":** Safari today (above). In Chrome, set the extension's site access to **On all sites**, and check that the extension on its card is 2.0.0 or later and was reloaded after the last pull. A site whose host is not a plain host name (e.g. an IPv6 address) or beyond the 50th site tool is left out of the list and shows this too.
- **A newly added site tool stays empty or says "can't open":** the page sends the new list when the tools list changes in this tab; a tool added in another tab reaches this tab's sidebar on its next load (its Tool view sends a fresh list itself). Reload the Switchboard tab.
- **The frame shows the site's login page, or goes blank after a moment:** you are signed out in this browser profile. Sign in to the site in a normal tab, then ↻ Reload. In Chrome with third-party cookies blocked (Settings → Privacy and security → Third-party cookies), allow them for the site (e.g. `[*.]atlassian.net`), or use the Allow banner.
- **Blank frame after clicking something inside the site:** a full-page navigation that the site starts inside the frame keeps working while it stays on a saved host (the rule is tab-scoped, whoever starts the navigation). One that goes to a host that is not saved (e.g. switching to another Atlassian product on another host, or a login at `id.atlassian.com`) is refused by that page's own `frame-ancestors`. ↻ Reload returns to the tool's URL; **↗ New tab** opens it in a tab. Saving that host as a tool as well would open it up in Switchboard's tab (the developer's call).
- **Part of the page is blank (an embedded widget):** frames the site nests inside itself are touched only when their host is a saved one. One from another host that only allows the site's own origins as ancestors is refused, because the top page is Switchboard.
- **Which version is installed?** In Switchboard's tab, `document.documentElement.dataset.sbFrameHelper` in the console.
- **Which hosts does it open up?** The extension card → **Inspect views: service worker** → `await chrome.declarativeNetRequest.getSessionRules()` (one rule per Switchboard tab).

## Tests

- `tests/tools/frame-helper.test.ts`: the manifest stays in scope (the one permission, the hosts, the service worker, no static rules, every file it names exists and the Safari build copies exactly those); the Safari manifest form and the converter / `xcodebuild` arguments; `background.js` against a fake `chrome` (the tab's rule shape, replace-not-merge, empty list, refused hosts and senders, more than 50, `frame-helper:reset`, closing and leaving loopback, a browser refusal, and the same host check as `isFrameHelperHost`); `marker.js` (marker, reset, relay and answer to the page only, refusals, ignored messages, only in a loopback top frame) and `storage-access.js` against small fake pages (banner only when framed directly by loopback without storage access, Allow → reload, refusal text, dismiss).
- `tests/core/site-tools.test.ts`: the site classification and the host list (`frameHelperHosts`, `isFrameHelperHost`, `siteToolHostname`). `tests/web/frame-helper.test.ts`: the marker, the checking / absent / ready / blocked states, the check waiting for the host list's answer, the page's side of the host list (`createSitesSync`: ids, latest answer wins, refusal, timeout, `settled`) and `siteFrameStatus`.
- `tests/server/tools/proxy.test.ts`, `tests/server/api/tool-frames.test.ts`: no proxy for a site; the check page's headers; the cookie guard.
- `tests/e2e/frame-helper.spec.ts` (oracle): the real unpacked extension in Playwright's Chromium (`launchPersistentContext` + `--load-extension`, new headless via `channel: 'chromium'`) and an https stub named `site.test` (the saved site tool) and `other.test` (not saved) that refuse every frame (`X-Frame-Options: DENY` + `frame-ancestors 'none'`). The stub's self-signed certificate is made with `node:crypto` (`tests/helpers/self-signed.ts`); Chromium maps the names with `--host-resolver-rules`, every other name fails to resolve, and certificate errors are ignored in that browser only. The helper's rules are read back from its service worker (`getSessionRules()`). Covered: a saved site tool shows in a direct frame of its own URL (no proxy, no banner), and the only rule is Switchboard's tab with `127.0.0.1` + `site.test`; a local tool still goes through its proxy; in Switchboard's own tab a frame of `other.test` is refused while one of `site.test` shows; a loopback page that is not Switchboard, in another tab, framing `site.test` is refused; a page on another site (`outside.test`, another tab) framing it is refused; after removing the tool in Settings its host leaves the rule and a frame of it is refused; leaving Switchboard for another site, and closing its tab, drop the tab's rule; without the helper the "needs the frame helper" state and Open in new tab; with a marker but no working helper (Safari today) the "can't open in a frame" state.
