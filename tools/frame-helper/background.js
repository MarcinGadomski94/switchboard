/*
 * Switchboard frame helper (D28, docs/frame-helper.md): the service worker that
 * keeps the frame rules, one per browser tab, as declarativeNetRequest session
 * rules. Developer ruling 2026-09-28 (narrowed scope): the helper removes
 * X-Frame-Options and Content-Security-Policy only from sub_frame responses of the
 * hosts Switchboard's page lists (its saved site tools, plus its own host for the
 * capability check), and only in the tab that runs Switchboard.
 *
 * - marker.js (on top-level http://127.0.0.1:* / http://localhost:* pages) relays
 *   the page's `frame-helper:sites` message here; this worker replaces that tab's
 *   rule (`tabIds: [tab]`, `resourceTypes: ['sub_frame']`, `requestDomains: hosts`)
 *   and answers `{ ok, hosts, error }`.
 * - marker.js also sends `frame-helper:reset` at document_start: a new loopback
 *   document in the tab starts without rules until it asks.
 * - A tab's rule goes when the tab closes or leaves loopback pages.
 * Only messages from this extension's own content script in the top frame of a
 * loopback page count; the hosts must be plain host names, at most 50.
 * Plain script, no build step.
 */
'use strict';

var api = typeof browser !== 'undefined' && browser.declarativeNetRequest ? browser : chrome;

/** Most hosts per tab (Switchboard sends its own host plus its site tools' hosts). */
var MAX_HOSTS = 50;

/*
 * A plain host name: lower-case DNS labels (two or more; punycode for
 * international names), a dotted IPv4 address, or localhost. No wildcards, ports,
 * paths or single labels: requestDomains also matches subdomains, so a bare "com"
 * would cover every .com site. Kept in step with isFrameHelperHost
 * (src/core/site-tools.ts) by tests/tools/frame-helper.test.ts.
 */
var HOST = /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;

/** `true` for Switchboard's pages: http on 127.0.0.1 or localhost, any port. */
function isLoopbackPage(value) {
  if (typeof value !== 'string') return false;
  var url;
  try {
    url = new URL(value);
  } catch (error) {
    return false;
  }
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

/** The hosts, deduplicated in order, or a reason why they are refused. */
function readHosts(hosts) {
  if (!Array.isArray(hosts)) return { error: 'hosts must be a list of host names' };
  var unique = [];
  for (var i = 0; i < hosts.length; i += 1) {
    var host = hosts[i];
    if (typeof host !== 'string' || host.length > 253 || !HOST.test(host)) return { error: 'not a plain host name: ' + String(host).slice(0, 80) };
    if (unique.indexOf(host) === -1) unique.push(host);
  }
  if (unique.length > MAX_HOSTS) return { error: 'at most ' + MAX_HOSTS + ' hosts' };
  return { hosts: unique };
}

/** The tab's one rule; its id is the tab's id. */
function tabRule(tabId, hosts) {
  return {
    id: tabId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' },
      ],
    },
    condition: { tabIds: [tabId], resourceTypes: ['sub_frame'], requestDomains: hosts },
  };
}

// One rule update at a time, in the order they were asked for.
var queue = Promise.resolve();

/** Replaces the tab's rule with one for `hosts` (none for an empty list). */
function setTabHosts(tabId, hosts) {
  var run = function () {
    return api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId], addRules: hosts.length > 0 ? [tabRule(tabId, hosts)] : [] });
  };
  var next = queue.then(run, run);
  queue = next.catch(function () {
    /* Reported to the caller; the queue goes on. */
  });
  return next;
}

function clearTab(tabId) {
  return setTabHosts(tabId, []).catch(function () {
    /* Nothing to clear, or the tab is gone. */
  });
}

/** The sender's tab id when it is this extension's content script in a loopback page's top frame, else null. */
function loopbackTab(sender) {
  if (!sender || sender.id !== api.runtime.id || sender.frameId !== 0 || !isLoopbackPage(sender.url)) return null;
  var tab = sender.tab;
  return tab && typeof tab.id === 'number' && tab.id > 0 ? tab.id : null;
}

api.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message !== 'object') return false;
  var type = message.type;
  if (type !== 'frame-helper:sites' && type !== 'frame-helper:reset') return false;
  var tabId = loopbackTab(sender);
  if (tabId === null) {
    if (type === 'frame-helper:sites') sendResponse({ ok: false, hosts: [], error: 'only the top frame of a loopback page may ask' });
    return false;
  }
  if (type === 'frame-helper:reset') {
    clearTab(tabId);
    return false;
  }
  var read = readHosts(message.hosts);
  if (read.error) {
    // A refused list leaves the tab without rules, not with the previous ones.
    clearTab(tabId).then(function () {
      sendResponse({ ok: false, hosts: [], error: read.error });
    });
    return true;
  }
  setTabHosts(tabId, read.hosts).then(
    function () {
      sendResponse({ ok: true, hosts: read.hosts, error: null });
    },
    function (error) {
      clearTab(tabId).then(function () {
        sendResponse({ ok: false, hosts: [], error: String((error && error.message) || error) });
      });
    },
  );
  return true;
});

api.tabs.onRemoved.addListener(function (tabId) {
  clearTab(tabId);
});

api.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.url === undefined && changeInfo.status !== 'loading') return;
  // Without host access to the new page its URL is hidden: not a loopback page either.
  if (!isLoopbackPage(changeInfo.url !== undefined ? changeInfo.url : tab && tab.url)) clearTab(tabId);
});
