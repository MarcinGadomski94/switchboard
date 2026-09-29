import { useHubEvent } from '../../api/useHub.ts';
import { useThrottled } from '../../api/useThrottled.ts';
import type { SessionTab } from '../../router.tsx';
import { ArtifactsTab } from './ArtifactsTab.tsx';
import { ChatTab } from './ChatTab.tsx';
import { DiffTab } from './DiffTab.tsx';
import { RightPanel } from './RightPanel.tsx';
import { SessionHeader } from './SessionHeader.tsx';
import { LoadingNote } from './SessionSkeletons.tsx';
import { TimelineTab } from './TimelineTab.tsx';
import { actionErrorText } from './session-header.ts';
import { NOTHING_LOADING, anyLoading, loadingParts } from './session-loading.ts';
import { usePlaceholderDelay, useSessionData } from './useSessionData.ts';
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
 *
 * D45 (`docs/session-panel.md` → *Loading a session*): the detail and the chat's
 * events come from `useSessionData`, held per session id (another session's data
 * never shows) and seeded from the in-memory cache of the sessions opened in this
 * tab (a revisit renders at once and refreshes in the background). While a part's
 * data is missing the view is `aria-busy`; once that lasted `PLACEHOLDER_DELAY_MS`,
 * the header, the chat and the right panel show skeleton placeholders and a
 * visually hidden "Loading session…". A failed load shows the missing state
 * (404) or the header's error line, never a placeholder.
 */
export function SessionView({ sessionId, tab, agentId = null }: { readonly sessionId: string; readonly tab: SessionTab; readonly agentId?: string | null }) {
  const data = useSessionData(sessionId, tab === 'chat');
  const reload = useThrottled(data.reload, RELOAD_MS);
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

  const session = data.detail;
  const failed = session ? null : data.detailError;
  const loading = loadingParts(data.detailState, data.eventsState, tab === 'chat');
  const busy = anyLoading(loading);
  const placeholders = usePlaceholderDelay(sessionId, busy) ? loading : NOTHING_LOADING;
  return (
    <section
      className="sb-view sb-sv"
      data-view="session"
      data-testid="view-session"
      data-session-id={sessionId}
      data-tab={tab}
      data-agent-id={agentId ?? undefined}
      aria-busy={busy || undefined}
    >
      <div className="sb-sv-main">
        <SessionHeader
          sessionId={sessionId}
          session={session}
          missing={failed?.status === 404}
          loadError={failed && failed.status !== 404 ? actionErrorText(failed.status, failed.body) : null}
          placeholder={placeholders.header}
          tab={tab}
          files={session?.files.length ?? 0}
          artifacts={session?.artifacts.length ?? 0}
          onChanged={data.reload}
        />
        {tab === 'chat' ? (
          <ChatTab
            sessionId={sessionId}
            session={session}
            events={data.events}
            eventsState={data.eventsState}
            placeholder={placeholders.chat}
            onChanged={data.reload}
            agentId={agentId}
          />
        ) : null}
        {tab === 'timeline' ? <TimelineTab sessionId={sessionId} /> : null}
        {tab === 'diff' ? <DiffTab sessionId={sessionId} /> : null}
        {tab === 'artifacts' ? <ArtifactsTab sessionId={sessionId} /> : null}
      </div>
      <RightPanel sessionId={sessionId} session={session} placeholder={placeholders.panel} />
      {anyLoading(placeholders) ? <LoadingNote /> : null}
    </section>
  );
}
