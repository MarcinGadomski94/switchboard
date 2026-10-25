import { useEffect, useMemo, useRef, useState } from 'react';
import { turnBusy } from '../../views/session/needs-you.ts';
import { Avatar, Button, Sheet, StatusBadge, Tabs, useToast } from '../components/index.ts';
import { AGENT_TAB_LABELS, AGENT_WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { AgentComputerTag } from '../shared/agent-row.tsx';
import { agentName, agentStatusOf } from '../shared/agent-line.ts';
import { openStore } from '../shared/open-store.ts';
import { ChatPane } from './ChatPane.tsx';
import { splitDock } from './composer-model.ts';
import { RevertHost, SaveResultHost, openSaveResult } from './dialogs.tsx';
import { Dock } from './Dock.tsx';
import { MoveDialogsHost } from './MoveDialog.tsx';
import { ChangesTab, HelpersTab, ResultsTab } from './tabs.tsx';
import { useAgent } from './useAgent.ts';
import { useChatRows } from './useChatRows.ts';
import './agent.css';

/** The peek's tabs (the prototype's sheet: no Timeline). */
type PeekTab = 'chat' | 'changes' | 'results' | 'helpers';

const peek = openStore<string>();

/**
 * D131 · lane S · opens the peek sheet on an agent (Home, Agents, the Board):
 * its chat with the composer, Changes, Results and Helpers, and **Open full
 * view**. One sheet for the whole page (`PeekHost`, mounted by the shell).
 */
export function openPeek(sessionId: string): void {
  peek.open(sessionId);
}

// For the E2E specs (and a console): `window.__sbV2Peek(id)` opens the peek like Home / Agents do.
if (typeof window !== 'undefined') (window as unknown as { __sbV2Peek?: (id: string) => void }).__sbV2Peek = openPeek;

/** Closes the peek sheet. */
export function closePeek(): void {
  peek.close();
}

/** The peek sheet wherever it is open (render once: the shell does). */
export function PeekHost() {
  const sessionId = peek.use();
  const { navigate } = useV2Router();
  const toast = useToast();
  return (
    <>
      {sessionId ? <PeekSheet key={sessionId} sessionId={sessionId} onClose={peek.close} /> : null}
      {/* The agent view's dialogs, once for the page (the full view and the peek share them). */}
      <RevertHost />
      {/* Lane X: Move to computer (D65) and Continue in Switchboard (D72) in v2's look. */}
      <MoveDialogsHost />
      <SaveResultHost
        onSaved={(result) =>
          toast({
            text: `Saved “${result.artifact.title}” to the agent’s results.`,
            ...(result.artifact.sessionId
              ? { actionLabel: 'Open', undo: () => navigate(`/agents/${encodeURIComponent(result.artifact.sessionId ?? '')}/results/${encodeURIComponent(result.artifact.id)}`) }
              : {}),
          })
        }
      />
    </>
  );
}

/**
 * D131 · lane S · the peek sheet itself (a side sheet over the page; a full-height
 * sheet on a phone): the agent's chat with the composer, Changes, Results and
 * Helpers, and Open full view. Escape or the scrim closes it.
 */
export function PeekSheet({ sessionId, onClose }: { readonly sessionId: string; readonly onClose: () => void }) {
  const { navigate } = useV2Router();
  const [tab, setTab] = useState<PeekTab>('chat');
  const data = useAgent(sessionId, true, null);
  const { rows, lastEventId, fullText } = useChatRows(data);
  const working = data.session !== null && turnBusy(data.session);
  const split = useMemo(() => splitDock(rows, working), [rows, working]);
  const stick = useRef(true);
  const [resultId, setResultId] = useState<string | null>(null);
  useEffect(() => setResultId(null), [tab]);
  const base = `/agents/${encodeURIComponent(sessionId)}`;
  const helperHref = (agentId: string): string => `${base}/helpers/${encodeURIComponent(agentId)}`;
  const full = (): void => {
    onClose();
    navigate(tab === 'chat' ? base : `${base}/${tab}`);
  };
  const session = data.session;
  const name = session ? agentName(session) : '';
  const tabs = [
    { id: 'chat' as const, label: AGENT_TAB_LABELS.chat, icon: 'chat' },
    ...(data.conversation ? [] : [{ id: 'changes' as const, label: AGENT_TAB_LABELS.changes, icon: 'copy' }]),
    { id: 'results' as const, label: AGENT_TAB_LABELS.results, icon: 'results', ...(session?.artifacts.length ? { count: session.artifacts.length } : {}) },
    ...(data.conversation ? [] : [{ id: 'helpers' as const, label: AGENT_TAB_LABELS.helpers, icon: 'crew' }]),
  ];
  return (
    <Sheet
      open
      onClose={onClose}
      testId="v2-agent-peek"
      width="min(780px, 100vw)"
      title={
        <span className="v2-row" style={{ gap: 10, minWidth: 0 }}>
          <Avatar name={name || 'Agent'} size="m" {...(session ? { status: agentStatusOf(session) } : {})} />
          <span style={{ minWidth: 0 }}>
            <span className="v2-ag-peek-name">{name}</span>
            <span className="v2-row" style={{ gap: 6, marginTop: 2 }}>
              {session ? <StatusBadge status={agentStatusOf(session)} size="s" /> : null}
              {session ? <AgentComputerTag machine={session.machine} short /> : null}
            </span>
          </span>
        </span>
      }
      header={
        <Button size="sm" variant="primary" icon="arrow-r" data-testid="v2-agent-peek-full" onClick={full}>
          {AGENT_WORDS.openFull}
        </Button>
      }
    >
      <div className="v2-ag v2-ag-peek" data-layout="peek" data-tab={tab}>
        <Tabs<PeekTab> tabs={tabs} value={tab} onChange={setTab} label="Peek" panelId="v2-agent-peek-panel" testId="v2-agent-peek-tabs" />
        <div className="v2-ag-body" id="v2-agent-peek-panel" role="tabpanel">
          {tab === 'chat' ? (
            <>
              <ChatPane
                data={data}
                rows={split.chat}
                fullText={fullText}
                focusEventId={null}
                stick={stick}
                variant="peek"
                onSave={(text, kind, language) => openSaveResult({ sessionId, text, kind, language })}
                onOpenResult={(id) => {
                  setTab('results');
                  setTimeout(() => setResultId(id), 0);
                }}
                helperHref={helperHref}
              />
              <Dock data={data} queued={split.queued} paused={split.paused} lastEventId={lastEventId} onSent={() => (stick.current = true)} variant="peek" />
            </>
          ) : (
            <div className="v2-ag-scroll">
              <div className="v2-ag-col v2-ag-col-wide">
                {tab === 'changes' ? <ChangesTab sessionId={sessionId} /> : null}
                {tab === 'results' ? <ResultsTab data={data} resultId={resultId} onOpen={setResultId} /> : null}
                {tab === 'helpers' ? <HelpersTab data={data} helperHref={helperHref} /> : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
