import type { V2Route } from '../routes.ts';
import { Placeholder } from '../shared/Placeholder.tsx';

/** The agent view's route (`/agents/:id[/:tab]`, a helper, a result, a message). */
export type AgentRoute = Extract<V2Route, { readonly area: 'agent' }>;

/**
 * D131 · one agent (`/agents/:id…`), lane S: the chat with in-chat answer cards
 * (`shared/AnswerCard.tsx`, `useNeedsItemsOf`), the composer, the side panel (⌘.
 * via `useShortcut('side-panel', …)`), tabs Chat / Changes / Results / Timeline /
 * Helpers. Placeholder until lane S lands; see `README.md`.
 */
export function AgentPage({ route }: { readonly route: AgentRoute }) {
  return <Placeholder area="agent" title="Agent" sub={`Agent ${route.id} · ${route.tab}${route.helperId ? ` · helper ${route.helperId}` : ''}`} lane="S" />;
}
