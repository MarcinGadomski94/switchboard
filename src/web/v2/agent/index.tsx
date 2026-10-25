import { AgentView, type AgentRoute } from './AgentView.tsx';

export type { AgentRoute } from './AgentView.tsx';
export { PeekHost, PeekSheet, closePeek, openPeek } from './Peek.tsx';

/**
 * D131 · one agent (`/agents/:id…`), lane S: the chat with in-chat answer cards,
 * the composer, the side panel (⌘.), tabs Chat / Changes / Results / Timeline /
 * Helpers, a helper's own chat, a result, a message (`README.md`). The peek sheet
 * (`openPeek(sessionId)`, `<PeekSheet>`) is exported for Home and Agents.
 */
export function AgentPage({ route }: { readonly route: AgentRoute }) {
  return <AgentView route={route} />;
}
