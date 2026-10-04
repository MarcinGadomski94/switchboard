import { createHmac } from 'node:crypto';
import { tokenMatches } from '../security.ts';

/**
 * D68 (`docs/security.md` → *Agent todo tools*): the token a session's agent
 * presents to `/agent/v1/*`: HMAC-SHA256 of the session id under the install's
 * secret (`sb_token`), base64url. It is not guessable without that secret, it
 * names exactly one session (another session's id gives another token), and it
 * needs no storage: a resume or a restart derives the same one.
 */
export function agentTokenFor(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(`switchboard-agent-todos:${sessionId}`).digest('base64url');
}

/** `true` when `candidate` is `sessionId`'s agent token (constant-time comparison). */
export function agentTokenMatches(secret: string, sessionId: string, candidate: string): boolean {
  return sessionId !== '' && tokenMatches(candidate, agentTokenFor(secret, sessionId));
}
