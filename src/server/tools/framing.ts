/**
 * Framing rules of the embedded tools (D15, `docs/tools.md` → *Framing proxy*):
 * the origins that may frame a proxied tool, the CSP rewrite the proxy applies to
 * each answer, and the check that tells the probe whether a tool's own answer
 * keeps Switchboard from framing it. Pure functions; no I/O.
 */

/** The framing headers of one answer, as the probe saw them (`null` = the header was absent). */
export interface FramingHeaders {
  /** `X-Frame-Options`, several headers joined with `, ` (Node's `Headers.get`). */
  readonly xFrameOptions: string | null;
  /** Every enforced `Content-Security-Policy` header value, in order. */
  readonly csp: readonly string[];
}

/** Switchboard's own origins on `port`: the only ancestors a proxied tool accepts. */
export function switchboardOrigins(port: number): readonly string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

/** The directive name of one `;`-separated CSP token (lower case), or `''` for a blank token. */
function directiveName(token: string): string {
  return /^\s*(\S+)/.exec(token)?.[1]?.toLowerCase() ?? '';
}

/**
 * One `Content-Security-Policy` header value with every policy's `frame-ancestors`
 * set to `origins` (D15). A header can carry several policies separated by `,`
 * (CSP3 "serialized CSP list"); each keeps all its other directives verbatim, in
 * place. The first `frame-ancestors` of a policy is replaced where it stands,
 * later ones (which browsers ignore) are dropped, and a policy without one gets it
 * appended. A blank header becomes `frame-ancestors <origins>`.
 */
export function withFrameAncestors(header: string, origins: readonly string[]): string {
  const directive = `frame-ancestors ${origins.join(' ')}`;
  if (header.trim() === '') return directive;
  return header
    .split(',')
    .map((policy) => {
      if (policy.trim() === '') return policy; // an empty list member is no policy (CSP3 skips it)
      let replaced = false;
      const tokens: string[] = [];
      for (const token of policy.split(';')) {
        if (directiveName(token) !== 'frame-ancestors') {
          tokens.push(token);
        } else if (!replaced) {
          replaced = true;
          const leading = /^\s*/.exec(token)?.[0] ?? '';
          const trailing = /\s*$/.exec(token)?.[0] ?? '';
          tokens.push(`${leading}${directive}${trailing}`);
        }
      }
      if (replaced) return tokens.join(';');
      const body = policy.replace(/[\s;]+$/, '');
      const tail = /\s*$/.exec(policy)?.[0] ?? '';
      return `${body}; ${directive}${tail}`;
    })
    .join(',');
}

/** The default port of an `http:` / `https:` URL scheme. */
function defaultPort(scheme: string): string {
  return scheme === 'https:' ? '443' : '80';
}

/**
 * `true` when one `frame-ancestors` source expression lets `ancestor` (an
 * `http(s)://host:port` origin) frame a document of `self` (the tool's origin).
 * CSP3 matching, reduced to what an http loopback origin can meet: `*`, scheme
 * sources, `'self'`, and host sources with an optional scheme, a `*.` wildcard, a
 * port (`*` = any) and a path (only an empty or `/` path matches an origin).
 */
function sourceAllows(source: string, ancestor: URL, self: URL): boolean {
  const expression = source.toLowerCase();
  if (expression === '*') return ancestor.protocol === 'http:' || ancestor.protocol === 'https:';
  if (expression === "'self'") return ancestor.origin === self.origin;
  if (expression.startsWith("'")) return false; // 'none', nonces, hashes, keywords: never an ancestor
  const scheme = /^([a-z][a-z0-9+.-]*):$/.exec(expression);
  if (scheme) return ancestor.protocol === `${scheme[1]}:` || (scheme[1] === 'http' && ancestor.protocol === 'https:');
  const host = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[^/:]+)(?::(\*|\d+))?(\/.*)?$/.exec(expression);
  if (!host) return false;
  const [, sourceScheme, sourceHost = '', sourcePort, sourcePath] = host;
  if (sourceScheme) {
    if (ancestor.protocol !== `${sourceScheme}:` && !(sourceScheme === 'http' && ancestor.protocol === 'https:')) return false;
  } else if (ancestor.protocol !== self.protocol && !(self.protocol === 'http:' && ancestor.protocol === 'https:')) {
    return false;
  }
  const ancestorHost = ancestor.hostname.toLowerCase();
  if (sourceHost === '*') {
    // A lone `*` host (`http://*`) matches every host.
  } else if (sourceHost.startsWith('*.')) {
    if (!ancestorHost.endsWith(sourceHost.slice(1))) return false;
  } else if (sourceHost !== ancestorHost) {
    return false;
  }
  const ancestorPort = ancestor.port || defaultPort(ancestor.protocol);
  if (sourcePort !== '*') {
    // No port in the source: only the scheme's default port matches (CSP3 "port-part matches").
    if ((sourcePort ?? defaultPort(ancestor.protocol)) !== ancestorPort) return false;
  }
  return sourcePath === undefined || sourcePath === '/';
}

/**
 * `true` when a tool's answer keeps `ancestor` (the Switchboard page's origin) from
 * framing it, as a browser decides it (D15, the probe's `framing: "refused"`):
 * - an enforced CSP policy with a `frame-ancestors` directive decides alone (browsers
 *   then ignore `X-Frame-Options`): refused when any such policy's first
 *   `frame-ancestors` matches no source for `ancestor` (`'none'` matches none);
 * - otherwise `X-Frame-Options` (HTML's rules): `DENY` or `SAMEORIGIN` (the tool is
 *   never Switchboard's origin) refuse; several different values that include one
 *   of `DENY` / `SAMEORIGIN` / `ALLOWALL` refuse; anything else is ignored.
 * `toolUrl` is the tool's own URL (the `'self'` of its policies).
 */
export function refusesFraming(headers: FramingHeaders | null, ancestor: string, toolUrl: string): boolean {
  if (!headers) return false;
  let ancestorUrl: URL;
  let self: URL;
  try {
    ancestorUrl = new URL(ancestor);
    self = new URL(toolUrl);
  } catch {
    return false;
  }
  let decidedByCsp = false;
  for (const header of headers.csp) {
    for (const policy of header.split(',')) {
      const directive = policy.split(';').find((token) => directiveName(token) === 'frame-ancestors');
      if (directive === undefined) continue;
      decidedByCsp = true;
      const sources = directive.trim().split(/\s+/).slice(1);
      if (!sources.some((source) => sourceAllows(source, ancestorUrl, self))) return true;
    }
  }
  if (decidedByCsp || headers.xFrameOptions === null) return false;
  const values = new Set(
    headers.xFrameOptions
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value !== ''),
  );
  if (values.size > 1) return ['deny', 'sameorigin', 'allowall'].some((value) => values.has(value));
  return values.has('deny') || values.has('sameorigin');
}
