/**
 * D28 (`docs/frame-helper.md`): which embedded tools are signed-in **sites**. A
 * site (e.g. Jira at `https://acme.atlassian.net/…`) needs the developer's
 * own login cookies, which the D15 framing proxy (a loopback origin) can never
 * carry, so it is framed directly and only with the Switchboard frame helper
 * installed. Every other tool (a local web app) keeps the D15 proxy. Pure; shared
 * by the service (no proxy for sites) and the Tool view.
 */

/**
 * `true` for host names that reach this machine itself: `localhost` and its
 * subdomains, `127.0.0.0/8`, `0.0.0.0`, `::1` and IPv4-mapped loopback
 * (`::ffff:127.x.x.x`). `hostname` is as `URL.hostname` gives it (IPv6 in brackets).
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const ipv6 = /^\[(.*)\]$/.exec(host)?.[1];
  if (ipv6 === undefined) return false;
  if (ipv6 === '::1' || ipv6 === '0:0:0:0:0:0:0:1') return true;
  // IPv4-mapped loopback: URL writes ::ffff:127.0.0.1 as ::ffff:7f00:1.
  return /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(ipv6) || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipv6);
}

/**
 * `true` when a tool URL is a signed-in **site** (D28): an absolute `https:` URL
 * whose host is not loopback. `http:` URLs, loopback hosts, blank or unparsable
 * values are local tools (`false`).
 */
export function isSiteToolUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.hostname !== '' && !isLoopbackHostname(parsed.hostname);
}

/**
 * The attribute the frame helper's content script sets on a loopback page's
 * `<html>` element, with the extension's version as its value
 * (`tools/frame-helper/marker.js`).
 */
export const FRAME_HELPER_ATTRIBUTE = 'data-sb-frame-helper';

/**
 * D28 capability check: a Switchboard page that refuses every frame
 * (`X-Frame-Options: DENY`, `frame-ancestors 'none'`). The Tool view loads it in a
 * hidden same-origin frame: it only shows (and its `<html>` carries
 * {@link FRAME_CHECK_ATTRIBUTE}) when the installed helper really removes those
 * headers in this browser, which Safari's extensions cannot do today.
 */
export const FRAME_CHECK_PATH = '/api/frame-helper/check';

/** The attribute (value `ok`) on the `<html>` element of {@link FRAME_CHECK_PATH}'s page. */
export const FRAME_CHECK_ATTRIBUTE = 'data-sb-frame-check';
