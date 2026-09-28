/*
 * Switchboard frame helper (D28, docs/frame-helper.md): the Safari login step.
 * Safari keeps a site's cookies out of a cross-site frame (ITP). When this https
 * page is framed directly by a loopback page (Switchboard on http://127.0.0.1:* /
 * http://localhost:*) and has no storage access yet, a small banner offers
 * "Allow", which calls document.requestStorageAccess() (a user gesture inside the
 * frame, as the Storage Access API needs) and reloads the frame on success. In
 * Chrome hasStorageAccess() resolves true while third-party cookies are allowed,
 * so nothing shows. Every other page (not framed, framed by another site, nested
 * deeper) is left alone. Plain script, no build step.
 */
(function () {
  'use strict';
  var BANNER_ID = 'sb-frame-helper-storage';
  var REFUSED = 'Safari refused; see docs/frame-helper.md (Prevent cross-site tracking)';

  /** `true` for Switchboard's origins: http on 127.0.0.1 or localhost, any port. */
  function isLoopbackOrigin(origin) {
    var url;
    try {
      url = new URL(origin);
    } catch (error) {
      return false;
    }
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  }

  /** The origin of the top page when this document is its direct child frame, else null. */
  function framingTopOrigin() {
    if (window.top === window || window.parent !== window.top) return null;
    var ancestors = location.ancestorOrigins;
    if (ancestors && ancestors.length > 0) return ancestors[ancestors.length - 1];
    if (document.referrer) {
      try {
        return new URL(document.referrer).origin;
      } catch (error) {
        return null;
      }
    }
    return null;
  }

  function style(element, css) {
    element.setAttribute('style', css);
    return element;
  }

  function showBanner() {
    if (document.getElementById(BANNER_ID) || !document.documentElement) return;
    var FONT = '-apple-system, BlinkMacSystemFont, system-ui, sans-serif';
    var host = style(document.createElement('div'), 'all: initial; position: fixed; z-index: 2147483647; right: 12px; bottom: 12px;');
    host.id = BANNER_ID;
    // A closed shadow root: the page's CSS cannot reach the banner, and the banner's cannot leak out.
    var root = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host;
    var box = style(
      document.createElement('div'),
      'all: initial; display: flex; align-items: center; gap: 10px; max-width: 440px; padding: 8px 10px; border-radius: 8px; ' +
        'background: #1c1d20; color: #e8e7e3; border: 1px solid #3a3b40; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35); ' +
        'font: 400 12.5px/1.4 ' + FONT + ';',
    );
    var text = style(document.createElement('span'), 'all: initial; color: inherit; font: inherit;');
    text.textContent = 'Allow ' + location.host + ' to use your login here';
    var allow = style(
      document.createElement('button'),
      'all: initial; cursor: pointer; padding: 4px 10px; border-radius: 6px; background: #e8e7e3; color: #111214; font: 600 12px ' + FONT + ';',
    );
    allow.type = 'button';
    allow.textContent = 'Allow';
    var close = style(document.createElement('button'), 'all: initial; cursor: pointer; padding: 0 2px; color: #8d8c87; font: 400 14px ' + FONT + ';');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    allow.addEventListener('click', function () {
      allow.disabled = true;
      document.requestStorageAccess().then(
        function () {
          location.reload();
        },
        function () {
          text.textContent = REFUSED;
          allow.remove();
        },
      );
    });
    close.addEventListener('click', function () {
      host.remove();
    });
    box.appendChild(text);
    box.appendChild(allow);
    box.appendChild(close);
    root.appendChild(box);
    document.documentElement.appendChild(host);
  }

  var origin = framingTopOrigin();
  if (!origin || !isLoopbackOrigin(origin)) return;
  if (typeof document.hasStorageAccess !== 'function' || typeof document.requestStorageAccess !== 'function') return;
  document.hasStorageAccess().then(
    function (has) {
      if (!has) showBanner();
    },
    function () {
      /* No answer: show nothing. */
    },
  );
})();
