import type { Session, SessionListItem } from './api.ts';

/**
 * D95 follow-up 2 (`docs/performance.md` → *Session list in memory*): a session as
 * `GET /api/sessions` lists it for the UI: without its agents (and without a delta
 * stream's markers). The detail (`GET /api/sessions/{id}`) keeps them.
 */
export function withoutAgents(session: Session | SessionListItem): SessionListItem {
  const { agents: _agents, agentsDelta: _delta, unchanged: _unchanged, ...item } = session as Session;
  return item;
}
