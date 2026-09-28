/*
 * Switchboard frame helper (D28, docs/frame-helper.md): runs at document_start in
 * the top frame of loopback pages (http://127.0.0.1:* / http://localhost:*, i.e.
 * Switchboard).
 * - Tells the page that the helper is installed, by setting
 *   `data-sb-frame-helper="<version>"` on its <html> element (the page reads it,
 *   src/web/tools/frame-helper.ts).
 * - D28 ruling (narrowed scope): tells the service worker (background.js) that a
 *   new document starts in this tab (`frame-helper:reset`: its rules go), and
 *   relays the page's host list, `window.postMessage({ source: 'switchboard',
 *   type: 'frame-helper:sites', id, hosts })`, to it; the answer goes back to the
 *   page as `{ source: 'switchboard-frame-helper', type:
 *   'frame-helper:sites-applied', id, ok, hosts, error }`.
 * Plain script, no build step.
 */
(function () {
  'use strict';
  var api = typeof browser !== 'undefined' && browser.runtime ? browser : typeof chrome !== 'undefined' ? chrome : null;
  var version = api && api.runtime && typeof api.runtime.getManifest === 'function' ? String(api.runtime.getManifest().version) : 'unknown';

  function mark() {
    var root = document.documentElement;
    if (!root) return false;
    root.setAttribute('data-sb-frame-helper', version);
    return true;
  }

  if (!mark()) {
    // Some engines run document_start scripts before <html> exists: set it as soon as it does.
    var observer = new MutationObserver(function () {
      if (mark()) observer.disconnect();
    });
    observer.observe(document, { childList: true });
    document.addEventListener(
      'readystatechange',
      function () {
        if (mark()) observer.disconnect();
      },
      { once: true },
    );
  }

  // Only the top frame of a loopback page talks to the service worker.
  if (window.top !== window || location.protocol !== 'http:' || (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost')) return;
  if (!api || !api.runtime || typeof api.runtime.sendMessage !== 'function') return;

  /** Sends `message` to the service worker; resolves its answer (a failure rejects). */
  function send(message) {
    try {
      return Promise.resolve(api.runtime.sendMessage(message));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  send({ type: 'frame-helper:reset' }).catch(function () {
    /* The worker clears the tab on its own when it leaves loopback or closes. */
  });

  window.addEventListener('message', function (event) {
    // The page itself only: not a framed tool (another window), not another origin.
    if (event.source !== window || event.origin !== location.origin) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || data.source !== 'switchboard' || data.type !== 'frame-helper:sites') return;
    var id = typeof data.id === 'number' ? data.id : 0;
    var answer = function (ok, hosts, error) {
      window.postMessage({ source: 'switchboard-frame-helper', type: 'frame-helper:sites-applied', id: id, ok: ok, hosts: hosts, error: error }, location.origin);
    };
    send({ type: 'frame-helper:sites', hosts: data.hosts }).then(
      function (reply) {
        if (reply && reply.ok === true && Array.isArray(reply.hosts)) answer(true, reply.hosts, null);
        else answer(false, [], reply && typeof reply.error === 'string' ? reply.error : 'refused');
      },
      function (error) {
        answer(false, [], String((error && error.message) || error));
      },
    );
  });
})();
