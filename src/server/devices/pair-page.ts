import { randomBytes } from 'node:crypto';

/**
 * D73: the one page an unpaired device gets (`GET /pair` on the device
 * listener): a small self-contained form (no app bundle, no API) that sends the
 * one-time code to `POST /device/v1/pair` and, once paired, opens Switchboard.
 * The code comes from the QR link's fragment (`#code=…`, never sent to the
 * server in the page request) or is typed in. Served with a strict CSP (a nonce
 * for its one script and style).
 */

/** Escapes text for HTML. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

/** The page and its `Content-Security-Policy`. */
export function pairPage(options: { readonly machineName: string; readonly suggestedName: string }): { readonly html: string; readonly csp: string } {
  const nonce = randomBytes(16).toString('base64');
  const machine = escapeHtml(options.machineName);
  const suggested = escapeHtml(options.suggestedName);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#111214">
<meta name="robots" content="noindex">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" sizes="180x180">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Switchboard">
<title>Pair with Switchboard</title>
<style nonce="${nonce}">
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b0c0d; color: #e8e7e3; font: 15px/1.45 system-ui, -apple-system, sans-serif; }
  main { max-width: 420px; margin: 0 auto; padding: max(28px, env(safe-area-inset-top)) 20px 28px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 6px; }
  p { color: #a3a29d; margin: 0 0 18px; }
  label { display: block; font-size: 13px; color: #c9c8c3; margin: 14px 0 6px; }
  input { box-sizing: border-box; width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #2a2b30; background: #141518; color: #e8e7e3; font-size: 17px; }
  input#code { font-family: ui-monospace, Menlo, monospace; letter-spacing: 2px; text-transform: uppercase; }
  button { width: 100%; margin-top: 20px; padding: 13px; border: 0; border-radius: 8px; background: #e8e7e3; color: #0b0c0d; font-size: 16px; font-weight: 600; }
  button:disabled { opacity: .5; }
  .error { color: #ef8a80; margin-top: 14px; min-height: 1.4em; }
  .hint { font-size: 13px; color: #8a8984; margin-top: 22px; }
</style>
</head>
<body>
<main>
  <h1>Pair this device</h1>
  <p>with Switchboard on <strong data-testid="pair-machine">${machine}</strong>. Enter the code it shows under Settings → Devices → Pair a device.</p>
  <form id="pair" data-testid="pair-form">
    <label for="code">One-time code</label>
    <input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" inputmode="text" maxlength="12" required data-testid="pair-code">
    <label for="name">Name of this device</label>
    <input id="name" name="name" maxlength="40" value="${suggested}" data-testid="pair-name">
    <button type="submit" id="go" data-testid="pair-submit">Pair</button>
    <div class="error" id="error" role="alert" data-testid="pair-error"></div>
  </form>
  <p class="hint">iPhone / iPad: for notifications, add Switchboard to the Home Screen (Share → Add to Home Screen) and pair from the Home Screen app; it keeps its own sign-in.</p>
</main>
<script nonce="${nonce}">
(function () {
  var form = document.getElementById('pair');
  var code = document.getElementById('code');
  var name = document.getElementById('name');
  var go = document.getElementById('go');
  var error = document.getElementById('error');
  var match = /(?:^|[#&])code=([^&]+)/.exec(location.hash);
  if (match) {
    code.value = decodeURIComponent(match[1]);
    history.replaceState(null, '', location.pathname);
  }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    go.disabled = true;
    error.textContent = '';
    fetch('/device/v1/pair', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code: code.value, name: name.value })
    }).then(function (response) {
      if (response.status === 201) { location.replace('/'); return; }
      return response.json().catch(function () { return {}; }).then(function (body) {
        error.textContent = (body && body.message) || 'Pairing failed (HTTP ' + response.status + ').';
        go.disabled = false;
      });
    }, function () {
      error.textContent = 'Switchboard could not be reached.';
      go.disabled = false;
    });
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
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return { html, csp };
}
