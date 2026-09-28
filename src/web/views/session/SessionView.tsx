import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { useThrottled } from '../../api/useThrottled.ts';
import type { SessionTab } from '../../router.tsx';
import { ArtifactsTab } from './ArtifactsTab.tsx';
import { ChatTab } from './ChatTab.tsx';
import { DiffTab } from './DiffTab.tsx';
import { RightPanel } from './RightPanel.tsx';
import { SessionHeader } from './SessionHeader.tsx';
import { TimelineTab } from './TimelineTab.tsx';
import './session.css';

/** `sessionUpdated` / `event` come in bursts; the session detail reloads at most this often. */
const RELOAD_MS = 500;

/**
 * Session view (SPEC → Session): grid `1fr | 380px`, the header and the current
 * tab on the left, the right panel. M4.1 owns the layout and the header: the
 * session comes from `GET /api/sessions/{id}` and reloads on its `/hub`
 * `sessionUpdated` and `event` (status, attachment, tab counts) and, since M4.2,
 * `questionBatch` (the chat's inline card). M4.2–M4.6 fill the tabs and the panel
 * (docs/lanes.md); since M4.3 the panel reads the same detail (agents, recent
 * events, status: `docs/session-panel.md`). D36: `agentId` (the address
 * `/sessions/{id}/agents/{agentId}`) turns the chat tab into that subagent's own chat.
 */
export function SessionView({ sessionId, tab, agentId = null }: { readonly sessionId: string; readonly tab: SessionTab; readonly agentId?: string | null }) {
  const detail = useApi(() => api.getSession(sessionId), [sessionId]);
  const reload = useThrottled(detail.reload, RELOAD_MS);
  useHubEvent('sessionUpdated', (session) => {
    if (session.id === sessionId) reload();
  });
  useHubEvent('event', (payload) => {
    if (payload.sessionId === sessionId) reload();
  });
  // M4.2: a new batch reaches the chat's inline card (the detail carries the questions).
  useHubEvent('questionBatch', (payload) => {
    if (payload.sessionId === sessionId) reload();
  });

  const session = detail.data && detail.data.id === sessionId ? detail.data : null;
  return (
    <section
      className="sb-view sb-sv"
      data-view="session"
      data-testid="view-session"
      data-session-id={sessionId}
      data-tab={tab}
      data-agent-id={agentId ?? undefined}
    >
      <div className="sb-sv-main">
        <SessionHeader
          sessionId={sessionId}
          session={session}
          missing={detail.error?.status === 404}
          tab={tab}
          files={session?.files.length ?? 0}
          artifacts={session?.artifacts.length ?? 0}
          onChanged={detail.reload}
        />
        {tab === 'chat' ? <ChatTab sessionId={sessionId} session={session} onChanged={detail.reload} agentId={agentId} /> : null}
        {tab === 'timeline' ? <TimelineTab sessionId={sessionId} /> : null}
        {tab === 'diff' ? <DiffTab sessionId={sessionId} /> : null}
        {tab === 'artifacts' ? <ArtifactsTab sessionId={sessionId} /> : null}
      </div>
      <RightPanel sessionId={sessionId} session={session} />
    </section>
  );
}
