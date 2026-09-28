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

/**
 * D28 ruling (narrowed scope): the most hosts the frame helper keeps for one tab.
 * The helper refuses a longer list (`tools/frame-helper/background.js`).
 */
export const MAX_FRAME_HELPER_HOSTS = 50;

/**
 * `true` for a host name the frame helper accepts for its tab-scoped rules: a plain,
 * lower-case DNS name of two or more labels (letters, digits, `-`; punycode for
 * international names), a dotted IPv4 address, or `localhost`. No wildcards,
 * ports, paths, brackets, trailing dot or single-label names (a bare `com` would
 * match every `.com` site, since a rule's `requestDomains` also matches
 * subdomains). The helper checks the same form (`tools/frame-helper/background.js`,
 * kept in step by `tests/tools/frame-helper.test.ts`).
 */
export function isFrameHelperHost(host: string): boolean {
  return host.length <= 253 && FRAME_HELPER_HOST.test(host);
}

const FRAME_HELPER_HOST = /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;

/**
 * D28 ruling: the hosts Switchboard's page gives the frame helper for its own tab.
 * First `pageHostname` (Switchboard's own host, so the capability check page
 * {@link FRAME_CHECK_PATH} can show), then the host of every saved **site** tool
 * ({@link isSiteToolUrl}) in list order. Duplicates and hosts the helper would
 * refuse ({@link isFrameHelperHost}, e.g. an IPv6 address) are left out, and the
 * list stops at {@link MAX_FRAME_HELPER_HOSTS}.
 */
export function frameHelperHosts(toolUrls: readonly (string | null | undefined)[], pageHostname: string): string[] {
  const hosts: string[] = [];
  const add = (host: string): void => {
    if (hosts.length < MAX_FRAME_HELPER_HOSTS && isFrameHelperHost(host) && !hosts.includes(host)) hosts.push(host);
  };
  add(pageHostname.toLowerCase());
  for (const url of toolUrls) {
    const host = siteToolHostname(url);
    if (host !== null) add(host);
  }
  return hosts;
}

/**
 * The hostname of a site tool's URL (lower case, no port: what
 * {@link frameHelperHosts} lists), or `null` for anything that is not a site
 * ({@link isSiteToolUrl}).
 */
export function siteToolHostname(url: string | null | undefined): string | null {
  if (!url || !isSiteToolUrl(url)) return null;
  return new URL(url).hostname;
}
