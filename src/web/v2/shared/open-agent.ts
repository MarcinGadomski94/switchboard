import { useCallback } from 'react';
import { useLayout } from '../../shell/useLayout.ts';
import { openPeek } from '../agent/index.tsx';
import { useV2Router } from '../nav.tsx';
import { agentOpening } from './board-model.ts';

/**
 * D131 · lane X · opens an agent the way the prototype does from a card or a
 * row that "peeks" (Home's Working now and Done today, the boards, a project's
 * steps, a teammate's Open chat, an agent hit in Search): the peek sheet
 * (`openPeek`, lane S) on a desktop or a tablet, the agent's page on a phone.
 * Places where the prototype navigates (the Agents List and Chats rows, a
 * card's explicit Open) keep navigating.
 */
export function useOpenAgent(): (sessionId: string) => void {
  const layout = useLayout();
  const { navigate } = useV2Router();
  return useCallback(
    (sessionId: string): void => {
      if (agentOpening(layout) === 'peek') openPeek(sessionId);
      else navigate(`/agents/${encodeURIComponent(sessionId)}`);
    },
    [layout, navigate],
  );
}
