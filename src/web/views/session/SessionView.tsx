import type { SessionTab } from '../../router.tsx';
import { ArtifactsTab } from './ArtifactsTab.tsx';
import { ChatTab } from './ChatTab.tsx';
import { DiffTab } from './DiffTab.tsx';
import { RightPanel } from './RightPanel.tsx';
import { SessionHeader } from './SessionHeader.tsx';
import { TimelineTab } from './TimelineTab.tsx';

/**
 * Session view (SPEC → Session): grid `1fr | 380px` with the header and the tabs
 * on the left and the right panel. Composition from M1.4; M4.1 owns the layout
 * and the header, M4.2–M4.6 the tabs and the panel (docs/lanes.md).
 */
export function SessionView({ sessionId, tab }: { readonly sessionId: string; readonly tab: SessionTab }) {
  return (
    <section className="sb-view" data-view="session" data-testid="view-session" data-session-id={sessionId} data-tab={tab}>
      <SessionHeader sessionId={sessionId} />
      {tab === 'chat' ? <ChatTab sessionId={sessionId} /> : null}
      {tab === 'timeline' ? <TimelineTab sessionId={sessionId} /> : null}
      {tab === 'diff' ? <DiffTab sessionId={sessionId} /> : null}
      {tab === 'artifacts' ? <ArtifactsTab sessionId={sessionId} /> : null}
      <RightPanel sessionId={sessionId} />
    </section>
  );
}
