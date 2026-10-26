import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLayout } from '../../shell/useLayout.ts';
import { turnBusy } from '../../views/session/needs-you.ts';
import { useDiffCount } from '../../views/session/useDiffScope.ts';
import { BottomSheet, Drawer, EmptyState, useToast } from '../components/index.ts';
import { AGENT_WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import type { AgentTab, V2Route } from '../routes.ts';
import { markRecent } from '../shared/recent.ts';
import { useShortcut } from '../shell/shortcuts.ts';
import { ChatPane } from './ChatPane.tsx';
import { splitDock } from './composer-model.ts';
import { openSaveResult } from './dialogs.tsx';
import { Dock } from './Dock.tsx';
import { AgentHeader } from './Header.tsx';
import { HelperChat } from './HelperChat.tsx';
import { SidePanel } from './SidePanel.tsx';
import { ChangesTab, HelpersTab, ResultsTab, TimelineTab } from './tabs.tsx';
import { useAgent } from './useAgent.ts';
import { browserStorage } from './useAgent.ts';
import { useChatRows } from './useChatRows.ts';
import { type ChatViewSettings, columnWidth, loadView, saveView, textMetrics } from './view-settings.ts';
import './agent.css';

/** The agent view's route. */
export type AgentRoute = Extract<V2Route, { readonly area: 'agent' }>;

/** This browser's chat view settings, remembered. */
function useViewSettings(): readonly [ChatViewSettings, (next: ChatViewSettings) => void] {
  const [view, setView] = useState<ChatViewSettings>(() => loadView(browserStorage()));
  const update = useCallback((next: ChatViewSettings) => {
    setView(next);
    saveView(browserStorage(), next);
  }, []);
  return [view, update];
}

/**
 * D131 · lane S · one agent's full view (`/agents/:id…`; the prototype's agent
 * full view and phone chat): the header with its tabs, the chat (or Changes,
 * Results, Timeline, Helpers, or a helper's own chat), the composer dock, and the
 * side panel (Details: ⌘. hides it on a desktop, remembered; a drawer on a tablet;
 * a bottom sheet on a phone).
 */
export function AgentView({ route }: { readonly route: AgentRoute }) {
  const { navigate } = useV2Router();
  const layout = useLayout();
  const toast = useToast();
  const sessionId = route.id;
  const helperId = route.helperId ?? null;
  const tab: AgentTab = helperId ? 'chat' : route.tab;
  const data = useAgent(sessionId, tab === 'chat' && helperId === null, helperId === null ? (route.eventId ?? null) : null);
  const [view, setView] = useViewSettings();
  const [drawer, setDrawer] = useState(false);
  const desktop = layout === 'desktop';
  const phone = layout === 'phone';
  const sideShown = desktop ? !view.sideHidden : drawer;
  const toggleSide = useCallback(() => {
    if (desktop) {
      const hidden = !view.sideHidden;
      setView({ ...view, sideHidden: hidden });
      toast({ text: hidden ? AGENT_WORDS.detailsHidden : AGENT_WORDS.detailsShown });
    } else setDrawer((open) => !open);
  }, [desktop, view, setView, toast]);
  useShortcut('side-panel', toggleSide);
  useEffect(() => setDrawer(false), [sessionId, layout]);
  // Fix after 2.0: opening an agent puts it first in the rail's Recent.
  useEffect(() => markRecent(sessionId), [sessionId]);

  const { rows, lastEventId, fullText } = useChatRows(data);
  const working = data.session !== null && turnBusy(data.session);
  const split = useMemo(() => splitDock(rows, working), [rows, working]);
  const stick = useRef(true);
  useEffect(() => {
    stick.current = true;
  }, [sessionId]);
  const changes = useDiffCount(sessionId, data.session ? data.session.files.length : null);
  const counts = { changes, results: data.session?.artifacts.length ?? 0, helpers: (data.session?.agents ?? []).filter((a) => a.kind !== 'main').length };
  const base = `/agents/${encodeURIComponent(sessionId)}`;
  const helperHref = useCallback((agentId: string) => `${base}/helpers/${encodeURIComponent(agentId)}`, [base]);
  const onTab = (next: AgentTab): void => navigate(next === 'chat' ? base : `${base}/${next}`);
  const metrics = textMetrics(view.density);
  const style = { '--v2-ag-col': columnWidth(view, sideShown && desktop), '--v2-ag-fs': `${metrics.size}px`, '--v2-ag-lh': String(metrics.lineHeight), '--v2-ag-gap': `${metrics.gap}px` } as CSSProperties;
  const missing = data.detailError?.status === 404;
  const onSave = (text: string, kind: 'markdown' | 'code', language: string | null): void => openSaveResult({ sessionId, text, kind, language });

  const panel = <SidePanel data={data} helperHref={helperHref} {...(desktop ? { onHide: toggleSide } : {})} />;
  return (
    <section className="v2-ag" data-testid="v2-agent-view" data-session-id={sessionId} data-layout={layout} data-density={view.density} data-side={sideShown ? 'shown' : 'hidden'} data-fullwidth={view.fullWidth ? 'true' : undefined} data-tab={tab} style={style}>
      <div className="v2-ag-main">
        {missing ? (
          <EmptyState icon="agents" tone="grey" title="No such agent" text="It was deleted, or it lives on a computer that is not paired any more." />
        ) : (
          <>
            {helperId ? null : <AgentHeader data={data} tab={tab} onTab={onTab} view={view} onView={setView} sideShown={sideShown} onToggleSide={toggleSide} counts={counts} phone={phone} />}
            <div className="v2-ag-body" id="v2-agent-panel" role="tabpanel">
              {helperId ? (
                <HelperChat data={data} helperId={helperId} focusEventId={route.eventId ?? null} />
              ) : tab === 'chat' ? (
                <>
                  <ChatPane
                    data={data}
                    rows={split.chat}
                    fullText={fullText}
                    focusEventId={route.eventId ?? null}
                    stick={stick}
                    variant={phone ? 'phone' : 'full'}
                    onSave={onSave}
                    onOpenResult={(id) => navigate(`${base}/results/${encodeURIComponent(id)}`)}
                    helperHref={helperHref}
                  />
                  <Dock
                    data={data}
                    queued={split.queued}
                    paused={split.paused}
                    lastEventId={lastEventId}
                    onSent={() => {
                      stick.current = true;
                    }}
                    variant={phone ? 'phone' : 'full'}
                  />
                </>
              ) : (
                <div className="v2-ag-scroll">
                  <div className="v2-ag-col v2-ag-col-wide">
                    {tab === 'changes' ? <ChangesTab sessionId={sessionId} /> : null}
                    {tab === 'results' ? <ResultsTab data={data} resultId={route.resultId ?? null} /> : null}
                    {tab === 'timeline' ? <TimelineTab data={data} /> : null}
                    {tab === 'helpers' ? <HelpersTab data={data} helperHref={helperHref} /> : null}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {desktop && sideShown ? (
        <aside className="v2-ag-side" aria-label={AGENT_WORDS.details} data-testid="v2-agent-side">
          {panel}
        </aside>
      ) : null}
      {layout === 'tablet' ? (
        <Drawer open={drawer} onClose={() => setDrawer(false)} title={AGENT_WORDS.details} testId="v2-agent-side-drawer">
          {panel}
        </Drawer>
      ) : null}
      {phone ? (
        <BottomSheet open={drawer} onClose={() => setDrawer(false)} title={AGENT_WORDS.details} testId="v2-agent-side-sheet">
          {panel}
        </BottomSheet>
      ) : null}
    </section>
  );
}
