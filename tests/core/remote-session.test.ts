import { describe, expect, it } from 'vitest';
import { sessionModeLine } from '../../src/core/history.ts';
import {
  REMOTE_MODE_LINE,
  REMOTE_RULE,
  parseRemoteSession,
  remoteSessionBaseName,
  remoteSessionTitle,
  remoteSessionUrl,
  remoteShortId,
  toSessionForm,
} from '../../src/core/remote-session.ts';
import { shortNameFromTitle } from '../../src/core/session-title.ts';

/**
 * D25 oracle (core): what "From a remote session" accepts (docs/spike-remote.md →
 * R.8: `session_<X>` = `cse_<X>`, the URL `https://claude.ai/code/session_<X>`),
 * the one form Switchboard stores and passes to `--teleport`, and the names a
 * teleported session gets without a typed title.
 */
describe('parseRemoteSession (D25)', () => {
  it('takes a claude.ai/code URL (query, fragment and trailing slash ignored), a session_ id or a cse_ id, as session_<X>', () => {
    const id = 'session_011CUabcDEF_789';
    for (const value of [
      id,
      'cse_011CUabcDEF_789',
      `https://claude.ai/code/${id}`,
      `https://claude.ai/code/${id}?from=cli&m=0`,
      `https://claude.ai/code/${id}/`,
      `https://claude.ai/code/${id}#top`,
      `https://claude.ai/code/cse_011CUabcDEF_789`,
      `  ${id}\n`,
      `\thttps://claude.ai/code/${id}?x=1  `,
      `https://Claude.ai/code/${id}`,
    ]) {
      expect(parseRemoteSession(value), JSON.stringify(value)).toEqual({ ok: true, id });
    }
  });

  it('refuses anything else with the one rule', () => {
    for (const value of [
      '',
      '   ',
      'session_',
      'cse_',
      'session-011CU',
      'sess_011CU',
      '011CUabc',
      'session_011CU abc',
      'session_011CU-abc',
      'session_011CU/../x',
      'http://claude.ai/code/session_011CU',
      'https://claude.ai.evil.example/code/session_011CU',
      'https://evil.example/code/session_011CU',
      'https://claude.ai:8443/code/session_011CU',
      'https://user@claude.ai/code/session_011CU',
      'https://claude.ai/session_011CU',
      'https://claude.ai/code/session_011CU/extra',
      'https://claude.ai/code/',
      'https://claude.ai/code/not-an-id',
      'https://',
      42,
      null,
      undefined,
      { id: 'session_011CU' },
    ]) {
      expect(parseRemoteSession(value), JSON.stringify(value) ?? String(value)).toEqual({ ok: false, message: REMOTE_RULE });
    }
  });

  it('the prefix swap and the URL', () => {
    expect(toSessionForm('cse_AbC_1')).toBe('session_AbC_1');
    expect(toSessionForm('session_AbC_1')).toBe('session_AbC_1');
    expect(remoteSessionUrl('cse_AbC_1')).toBe('https://claude.ai/code/session_AbC_1');
  });
});

describe('names of a teleported session (D25, D22)', () => {
  it('without a typed title: title "Remote <first 8 of X>", short name "remote-<the same, lower-cased>", -2 when taken', () => {
    const id = 'session_011CUabcDEFghi';
    expect(remoteShortId(id)).toBe('011CUabc');
    expect(remoteSessionTitle(id)).toBe('Remote 011CUabc');
    expect(remoteSessionBaseName(id)).toBe('remote-011cuabc');
    expect(shortNameFromTitle(remoteSessionBaseName(id), [])).toBe('remote-011cuabc');
    expect(shortNameFromTitle(remoteSessionBaseName(id), ['remote-011cuabc'])).toBe('remote-011cuabc-2');
    // A short X keeps what it has; an underscore in the first 8 becomes a dash in the name.
    expect(remoteSessionBaseName('session_ab_CD')).toBe('remote-ab_cd');
    expect(shortNameFromTitle(remoteSessionBaseName('session_ab_CD'), [])).toBe('remote-ab-cd');
    expect(remoteSessionTitle('session_ab_CD')).toBe('Remote ab_CD');
  });

  it('the mode line of a local copy reads "remote · local copy" (like D16\'s "terminal · moved")', () => {
    expect(REMOTE_MODE_LINE).toBe('remote · local copy');
    expect(sessionModeLine({ mode: null, workType: null, phase: null, remoteSource: 'session_x' })).toBe('remote · local copy');
    expect(sessionModeLine({ mode: null, workType: null, phase: null, remoteSource: null })).toBe('');
  });
});
