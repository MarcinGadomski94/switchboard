import { describe, expect, it } from 'vitest';
import { type FramingHeaders, refusesFraming, switchboardOrigins, withFrameAncestors } from '../../../src/server/tools/framing.ts';

/** D15: the CSP rewrite of the framing proxy and the probe's "refuses framing" check. */

const ORIGINS = switchboardOrigins(4870);
const FA = 'frame-ancestors http://127.0.0.1:4870 http://localhost:4870';
const PAGE = 'http://127.0.0.1:4870';
const TOOL = 'http://localhost:13000/';

function headers(csp: readonly string[], xFrameOptions: string | null = null): FramingHeaders {
  return { csp, xFrameOptions };
}

describe('withFrameAncestors', () => {
  it("replaces frame-ancestors in place and keeps every other directive verbatim (the Codebase Memory UI's policy)", () => {
    expect(ORIGINS).toEqual(['http://127.0.0.1:4870', 'http://localhost:4870']);
    expect(withFrameAncestors("default-src 'self'; script-src 'self' 'unsafe-inline';  frame-ancestors 'none' ; img-src data:", ORIGINS)).toBe(
      `default-src 'self'; script-src 'self' 'unsafe-inline';  ${FA} ; img-src data:`,
    );
    expect(withFrameAncestors("FRAME-ANCESTORS 'self'", ORIGINS)).toBe(FA);
  });

  it('adds it when missing, drops later duplicates, handles policy lists and blanks', () => {
    expect(withFrameAncestors("default-src 'self';", ORIGINS)).toBe(`default-src 'self'; ${FA}`);
    expect(withFrameAncestors("frame-ancestors 'none'; frame-ancestors *", ORIGINS)).toBe(FA);
    expect(withFrameAncestors("default-src 'self', img-src *", ORIGINS)).toBe(`default-src 'self'; ${FA}, img-src *; ${FA}`);
    expect(withFrameAncestors("default-src 'self',", ORIGINS)).toBe(`default-src 'self'; ${FA},`);
    expect(withFrameAncestors('  ', ORIGINS)).toBe(FA);
  });
});

describe('refusesFraming', () => {
  it("frame-ancestors decides: 'none' and 'self' refuse; *, http:, the page's origin and port wildcards allow", () => {
    expect(refusesFraming(headers(["default-src 'self'; frame-ancestors 'none'"]), PAGE, TOOL)).toBe(true);
    expect(refusesFraming(headers(["frame-ancestors 'self'"]), PAGE, TOOL)).toBe(true);
    expect(refusesFraming(headers(['frame-ancestors *']), PAGE, TOOL)).toBe(false);
    expect(refusesFraming(headers(['frame-ancestors http:']), PAGE, TOOL)).toBe(false);
    expect(refusesFraming(headers(['frame-ancestors https:']), PAGE, TOOL)).toBe(true);
    expect(refusesFraming(headers(['frame-ancestors http://127.0.0.1:4870']), PAGE, TOOL)).toBe(false);
    expect(refusesFraming(headers(['frame-ancestors 127.0.0.1:*']), PAGE, TOOL)).toBe(false);
    expect(refusesFraming(headers(['frame-ancestors http://127.0.0.1:4870/']), PAGE, TOOL)).toBe(false);
    expect(refusesFraming(headers(['frame-ancestors http://127.0.0.1']), PAGE, TOOL)).toBe(true); // default port 80 only
    expect(refusesFraming(headers(['frame-ancestors http://localhost:4870']), PAGE, TOOL)).toBe(true); // the page is on 127.0.0.1
    expect(refusesFraming(headers(['frame-ancestors http://localhost:4870']), 'http://localhost:4870', TOOL)).toBe(false);
    expect(refusesFraming(headers(['frame-ancestors *.example.com']), PAGE, TOOL)).toBe(true);
    // 'self' matches only when the page is the tool's own origin.
    expect(refusesFraming(headers(["frame-ancestors 'self'"]), 'http://localhost:13000', TOOL)).toBe(false);
  });

  it('every enforced policy with frame-ancestors must allow the page; a CSP decision overrides X-Frame-Options', () => {
    expect(refusesFraming(headers(['frame-ancestors *', "frame-ancestors 'none'"]), PAGE, TOOL)).toBe(true);
    expect(refusesFraming(headers(["frame-ancestors *, frame-ancestors 'none'"]), PAGE, TOOL)).toBe(true);
    expect(refusesFraming(headers(['frame-ancestors *'], 'DENY'), PAGE, TOOL)).toBe(false);
    expect(refusesFraming(headers(["default-src 'self'"], 'DENY'), PAGE, TOOL)).toBe(true);
  });

  it("X-Frame-Options: DENY and SAMEORIGIN refuse, conflicting values refuse, anything else doesn't", () => {
    expect(refusesFraming(headers([], 'DENY'), PAGE, TOOL)).toBe(true);
    expect(refusesFraming(headers([], ' sameorigin '), PAGE, TOOL)).toBe(true);
    expect(refusesFraming(headers([], 'ALLOWALL'), PAGE, TOOL)).toBe(false);
    expect(refusesFraming(headers([], 'ALLOW-FROM http://127.0.0.1:4870'), PAGE, TOOL)).toBe(false);
    expect(refusesFraming(headers([], 'SAMEORIGIN, ALLOWALL'), PAGE, TOOL)).toBe(true);
    expect(refusesFraming(headers([], 'DENY, deny'), PAGE, TOOL)).toBe(true);
    expect(refusesFraming(headers([], 'foo, bar'), PAGE, TOOL)).toBe(false);
    expect(refusesFraming(headers([]), PAGE, TOOL)).toBe(false);
    expect(refusesFraming(null, PAGE, TOOL)).toBe(false);
  });
});
