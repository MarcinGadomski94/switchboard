import type { Session } from '../../../core/api.ts';
import { HandoffCard } from './HandoffCard.tsx';

/**
 * Right panel (SPEC → Session → Right panel): agent cards, terminal tail, handoff
 * card with copy. M4.1 adds the column and the handoff card (the "Continue in
 * terminal" command); M4.3 adds the agent cards and the terminal tail above it.
 */
export function RightPanel({ sessionId, session }: { readonly sessionId: string; readonly session: Session | null }) {
  return (
    <aside className="sb-sv-panel" data-testid="session-right-panel" data-session-id={sessionId}>
      {session ? <HandoffCard attached={session.attached} command={session.resumeCommand} /> : null}
    </aside>
  );
}
