import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/web/api/client.ts';
import { apiErrorText, peerTooOld } from '../../src/web/v2/agent/useAgentFiles.ts';
import { AGENT_WORDS } from '../../src/web/v2/glossary.ts';

/**
 * D180 follow-up 2026-11-20: a paired computer from before the agent-file routes were on the
 * peer API refuses them (403 peer-forbidden "… is not part of the peer API"): the panel asks to
 * update that computer instead of showing the raw refusal.
 */
describe('a paired computer too old for agent files', () => {
  const old = new ApiError(403, 'refused', { error: 'peer-forbidden', message: 'GET /api/sessions/x/files/roots is not part of the peer API' });

  it('is recognised only by its refusal', () => {
    expect(peerTooOld(old)).toBe(true);
    expect(peerTooOld(new ApiError(403, 'x', { error: 'peer-forbidden', message: 'a peer cannot reach further machines' }))).toBe(false);
    expect(peerTooOld(new ApiError(409, 'x', { error: 'secret', message: 'looks secret' }))).toBe(false);
    expect(peerTooOld(new Error('x'))).toBe(false);
  });

  it('reads as an update hint, with the computer named when known', () => {
    expect(apiErrorText(old)).toBe(AGENT_WORDS.updateToSeeFiles(null));
    expect(AGENT_WORDS.updateToSeeFiles('Acme Mac')).toContain('Acme Mac');
    expect(AGENT_WORDS.updateToSeeFiles(null)).toContain('that computer');
  });
});
