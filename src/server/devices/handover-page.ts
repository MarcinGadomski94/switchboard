import { randomBytes } from 'node:crypto';

/**
 * D189: the page a phone lands on when it switches to this computer from a paired one (`GET
 * /handover` on the device listener, served without a credential like `/pair`). The one-time token
 * is in the URL's fragment (`#t=…`: never sent in a request line, so never in a log); the page reads
 * it, removes it from the address at once, and redeems it with `POST /device/v1/handover` (same
 * origin, so the device guard's Origin check holds). On success this computer has given the phone
 * its own credential cookie and the page opens Switchboard. Strict CSP: a nonce for its one script
 * and style.
 */

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

/** The page and its `Content-Security-Policy`. */
export function handoverPage(options: { readonly machineName: string }): { readonly html: string; readonly csp: string } {
  const nonce = randomBytes(16).toString('base64');
  const machine = escapeHtml(options.machineName);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#111214">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="/manifest.webmanifest">
<title>Switching to ${machine}</title>
<style nonce="${nonce}">
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b0c0d; color: #e8e7e3; font: 15px/1.45 system-ui, -apple-system, sans-serif; }
  main { max-width: 420px; margin: 0 auto; padding: max(28px, env(safe-area-inset-top)) 20px 28px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  p { color: #a3a29d; margin: 0 0 16px; }
  .error { color: #ef8a80; min-height: 1.4em; }
  a { color: #e8e7e3; }
</style>
</head>
<body>
<main>
  <h1>Switching to <span data-testid="handover-machine">${machine}</span>…</h1>
  <p id="status" data-testid="handover-status">Signing this phone in.</p>
  <p class="error" id="error" role="alert" data-testid="handover-error"></p>
</main>
<script nonce="${nonce}">
(function () {
  var status = document.getElementById('status');
  var error = document.getElementById('error');
  var match = /(?:^|[#&])t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
  // The token never stays in the address (history, a shared screenshot).
  history.replaceState(null, '', location.pathname);
  if (!match) { status.textContent = ''; error.textContent = 'This link has no sign-in in it. Switch computers again from Switchboard.'; return; }
  fetch('/device/v1/handover', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ token: match[1] })
  }).then(function (response) {
    if (response.status === 200) { location.replace('/'); return; }
    return response.json().catch(function () { return {}; }).then(function (body) {
      status.textContent = '';
      error.textContent = (body && body.message) || 'Switching failed (HTTP ' + response.status + ').';
    });
  }, function () {
    status.textContent = '';
    error.textContent = 'This computer could not be reached.';
  });
})();
</script>
</body>
</html>
`;
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self'",
    "manifest-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return { html, csp };
}
