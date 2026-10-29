import { memo } from 'react';
import { AgentView, type AgentRoute } from './AgentView.tsx';

export type { AgentRoute } from './AgentView.tsx';
export { PeekHost, PeekSheet, closePeek, openPeek } from './Peek.tsx';

/**
 * D131 · one agent (`/agents/:id…`), lane S: the chat with in-chat answer cards,
 * the composer, the side panel (⌘.), tabs Chat / Changes / Results / Timeline /
 * Helpers, a helper's own chat, a result, a message (`README.md`). The peek sheet
 * (`openPeek(sessionId)`, `<PeekSheet>`) is exported for Home and Agents.
 * Memoized (typing lag fix, 2026-10-29): the shell renders again on its own data
 * (the status pill's `system` tick every 5 s, the rail's counts); the agent view,
 * with its whole chat, renders on its own data only (`route` keeps its identity
 * while the address does).
 */
export const AgentPage = memo(function AgentPage({ route }: { readonly route: AgentRoute }) {
  return <AgentView route={route} />;
});
