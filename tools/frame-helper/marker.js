/*
 * Switchboard frame helper (D28, docs/frame-helper.md): tells a loopback page
 * (http://127.0.0.1:* / http://localhost:*, i.e. Switchboard) that the helper is
 * installed, by setting `data-sb-frame-helper="<version>"` on its <html> element.
 * Runs at document_start in the top frame only; the page reads the attribute
 * (src/web/tools/frame-helper.ts). Plain script, no build step.
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

  if (mark()) return;
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
})();
