import { describe, expect, it } from 'vitest';
import { PairingCodes } from '../../../src/server/peers/pairing.ts';
import { assertPeerBind } from '../../../src/server/peers/listener.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { SseParser } from '../../../src/server/peers/sse.ts';
import { bearerToken, hashPeerToken, hashesMatch, newPeerToken } from '../../../src/server/peers/tokens.ts';

describe('D48 per-pair tokens', () => {
  it('are 32 random bytes (base64url), stored as a sha256 hash, compared in constant time', () => {
    const token = newPeerToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newPeerToken()).not.toBe(token);
    const hash = hashPeerToken(token);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).not.toContain(token);
    expect(hashesMatch(hash, hashPeerToken(token))).toBe(true);
    expect(hashesMatch(hash, hashPeerToken(newPeerToken()))).toBe(false);
    expect(hashesMatch(hash, 'short')).toBe(false);
  });

  it('reads only a well-formed bearer header', () => {
    const token = newPeerToken();
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(bearerToken(`bearer ${token}`)).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('D48 pairing codes (PairingCodes)', () => {
  it('a code is single use', () => {
    const codes = new PairingCodes();
    const { code } = codes.create();
    expect(codes.consume(code)).toBeNull();
    expect(codes.consume(code)).toBe('no-code');
  });

  it('expires', () => {
    let now = 1_000;
    const codes = new PairingCodes({ now: () => now, ttlMs: 60_000 });
    const { code, expiresAt } = codes.create();
    expect(expiresAt.getTime()).toBe(61_000);
    now = 61_000;
    expect(codes.consume(code)).toBe('expired');
    expect(codes.consume(code)).toBe('no-code');
  });

  it('is burned after too many wrong tries', () => {
    const codes = new PairingCodes({ maxFailures: 3 });
    const code = codes.create().code;
    const wrong = code === 'AAAA-AAAA' ? 'BBBB-BBBB' : 'AAAA-AAAA';
    expect(codes.consume(wrong)).toBe('wrong-code');
    expect(codes.consume('not a code')).toBe('wrong-code');
    expect(codes.consume(wrong)).toBe('too-many-tries');
    expect(codes.consume(code)).toBe('no-code');
  });

  it('a new code replaces the old one', () => {
    const codes = new PairingCodes();
    const first = codes.create().code;
    const second = codes.create().code;
    if (first !== second) expect(codes.consume(first)).toBe('wrong-code');
    expect(codes.consume(second)).toBeNull();
  });
});

describe('D48 peer listener bind rule', () => {
  it('binds only a Tailscale IPv4; 127.0.0.1 only with the test switch', () => {
    expect(() => assertPeerBind('100.100.1.2', false)).not.toThrow();
    for (const host of ['0.0.0.0', '192.168.1.5', '127.0.0.1', '::', 'localhost', '100.128.0.1']) {
      expect(() => assertPeerBind(host, false)).toThrow(/Refusing/);
    }
    expect(() => assertPeerBind('127.0.0.1', true)).not.toThrow();
    expect(() => assertPeerBind('0.0.0.0', true)).toThrow(/Refusing/);
  });
});

describe('D48 peer API allow-list', () => {
  it('serves the session, Inbox, new-session and hook routes only', () => {
    expect(peerApiAllowed('GET', '/api/sessions')).toBe(true);
    expect(peerApiAllowed('GET', '/api/sessions/abc?x=1')).toBe(true);
    expect(peerApiAllowed('POST', '/api/sessions/abc/messages')).toBe(true);
    expect(peerApiAllowed('PUT', '/api/sessions/abc/model')).toBe(true);
    // D63: a machine's account profiles, their sign-in (with the paste-back) and a session's account / pin.
    expect(peerApiAllowed('GET', '/api/accounts?refresh=1')).toBe(true);
    expect(peerApiAllowed('POST', '/api/accounts/profiles')).toBe(true);
    expect(peerApiAllowed('POST', '/api/accounts/profiles/p1/signin')).toBe(true);
    expect(peerApiAllowed('POST', '/api/accounts/signin/s1/paste')).toBe(true);
    expect(peerApiAllowed('DELETE', '/api/accounts/profiles/p1')).toBe(true);
    expect(peerApiAllowed('PUT', '/api/accounts/order')).toBe(true);
    expect(peerApiAllowed('POST', '/api/sessions/abc/account')).toBe(true);
    expect(peerApiAllowed('PUT', '/api/sessions/abc/profile-pin')).toBe(true);
    expect(peerApiAllowed('GET', '/api/accounts/profiles/p1')).toBe(false);
    expect(peerApiAllowed('POST', '/api/accounts/profiles/p1/other')).toBe(false);
    expect(peerApiAllowed('POST', '/api/questions/batch/b/answers')).toBe(true);
    expect(peerApiAllowed('POST', '/api/inbox/i/actions/allow-once')).toBe(true);
    expect(peerApiAllowed('POST', '/api/branching/preflight')).toBe(true);
    expect(peerApiAllowed('POST', '/api/hooks/install')).toBe(true);
    // D52: the schedules and the terminal loops.
    expect(peerApiAllowed('GET', '/api/schedules')).toBe(true);
    expect(peerApiAllowed('POST', '/api/schedules')).toBe(true);
    expect(peerApiAllowed('POST', '/api/schedules/s1/run')).toBe(true);
    expect(peerApiAllowed('POST', '/api/schedules/s1/pause')).toBe(true);
    expect(peerApiAllowed('POST', '/api/schedules/s1/resume')).toBe(true);
    expect(peerApiAllowed('DELETE', '/api/schedules/s1')).toBe(true);
    expect(peerApiAllowed('GET', '/api/terminal-loops')).toBe(true);
    expect(peerApiAllowed('DELETE', `/api/schedules/${encodeURIComponent('r~abcdefghijkl~s1')}`)).toBe(false);
    for (const [method, url] of [
      ['GET', '/api/settings'],
      ['PUT', '/api/settings'],
      ['POST', '/api/folders'],
      ['DELETE', '/api/folders/x'],
      ['GET', '/api/tools'],
      // D52: a schedule's own routes only (no bulk delete, no PUT).
      ['DELETE', '/api/schedules'],
      ['PUT', '/api/schedules/x'],
      ['POST', '/api/schedules/x/delete'],
      ['POST', '/api/sessions/abc/attach'],
      ['POST', '/api/sessions/abc/detach'],
      ['POST', '/api/sessions/teleport'],
      ['GET', '/api/history'],
      ['GET', '/api/machines'],
      ['GET', '/api/machines/x/api/sessions'],
      ['DELETE', '/api/sessions'],
      ['GET', '/hub'],
    ] as const) {
      expect(peerApiAllowed(method, url), `${method} ${url}`).toBe(false);
    }
  });

  it('never reaches a remote id (no chains of peers)', () => {
    expect(peerApiAllowed('GET', '/api/sessions/r~abcdefghijkl~s1')).toBe(false);
    expect(peerApiAllowed('GET', `/api/sessions/${encodeURIComponent('r~abcdefghijkl~s1')}`)).toBe(false);
  });
});

describe('D48 SSE reader', () => {
  it('splits frames across chunks and skips comments', () => {
    const parser = new SseParser();
    expect(parser.push(': keepalive\n\nevent: sessionUpdated\nda')).toEqual([]);
    expect(parser.push('ta: {"id":"s"}\n\nevent: inboxChanged\r\ndata: {"count":1}\r\n\r\n')).toEqual([
      { event: 'sessionUpdated', data: '{"id":"s"}' },
      { event: 'inboxChanged', data: '{"count":1}' },
    ]);
  });
});
