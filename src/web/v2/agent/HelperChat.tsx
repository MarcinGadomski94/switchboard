import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { WorkflowAgentChat } from '../../../core/api.ts';
import { subagentActivityLine } from '../../activity/activity.ts';
import { useTick } from '../../activity/useActivity.ts';
import { api } from '../../api/client.ts';
import { ChatMarkdown } from '../../views/session/ChatMarkdown.tsx';
import { hasSubagentChat, subagentChat } from '../../views/session/chat.ts';
import { useFullText } from '../../views/session/FullText.tsx';
import { revealEvent } from '../../views/session/reveal-event.ts';
import { useAgentEvents } from '../../views/session/useSessionData.ts';
import { agentActivity } from '../../views/session/workflow-agents.ts';
import { Avatar, Button, EmptyState, Icon, StatusBadge } from '../components/index.ts';
import { AGENT_WORDS, sessionStatusToV2 } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { agentDisplayName, useTeamMembers } from '../shared/teammates.ts';
import { chatRows } from './chat-model.ts';
import { ChatRowsView } from './ChatPane.tsx';
import type { AgentData } from './useAgent.ts';

/** A Workflow agent's chat comes from its transcript (D51), read again as it grows. */
function useWorkflowChat(sessionId: string, agentId: string | null, version: number, status: string | null): WorkflowAgentChat | null {
  const [data, setData] = useState<{ readonly key: string; readonly chat: WorkflowAgentChat } | null>(null);
  useEffect(() => {
    if (agentId === null) return undefined;
    let live = true;
    api.workflowAgentChat(sessionId, agentId).then(
      (chat) => live && setData({ key: agentId, chat }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [sessionId, agentId, version, status]);
  return data && data.key === agentId ? data.chat : null;
}

/**
 * D131 · lane S · a helper's own chat (`/agents/:id/helpers/:helperId`, D36 / D51):
 * the brief from the agent, its replies and tool activity in the v2 chat's style,
 * its result last; no composer (helpers take no messages), the live line instead.
 * Back (and Esc) return to the main chat.
 */
export function HelperChat({ data, helperId, focusEventId }: { readonly data: AgentData; readonly helperId: string; readonly focusEventId: number | null }) {
  const { navigate } = useV2Router();
  const { session, sessionId, activity } = data;
  const members = useTeamMembers();
  const agent = session?.agents.find((candidate) => candidate.id === helperId) ?? null;
  const workflow = agent?.kind === 'workflow';
  const ownEvents = useAgentEvents(sessionId, helperId, agent?.toolUseId ?? null, data.events);
  const fullText = useFullText(sessionId, ownEvents);
  const workflowChat = useWorkflowChat(sessionId, workflow ? helperId : null, agent?.workflow?.version ?? 0, agent?.status ?? null);
  const now = useTick(1000);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const revealed = useRef<number | null>(null);
  const back = (): void => navigate(`/agents/${encodeURIComponent(sessionId)}`);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches('input, textarea, select')) return;
      back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const chat = useMemo(() => {
    if (!session || !agent) return null;
    return workflow ? subagentChat(workflowChat?.events ?? [], [], agent, session.agents, { restorable: false }) : subagentChat(fullText.events, session.questions, agent, session.agents);
  }, [session, agent, workflow, workflowChat, fullText.events]);
  const times = useMemo(() => new Map((workflow ? (workflowChat?.events ?? []) : fullText.events).map((e) => [e.id, { ts: e.ts, endTs: e.endTs }])), [workflow, workflowChat, fullText.events]);
  const rows = useMemo(() => (chat && session ? chatRows({ items: chat.items, times, agents: session.agents, now: Date.now() }) : []), [chat, times, session]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (focusEventId !== null && revealed.current !== focusEventId && revealEvent(el, focusEventId)) {
      revealed.current = focusEventId;
      stick.current = false;
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  });
  if (!session) return <div className="v2-ag-scroll" aria-busy="true" />;
  if (!agent || !hasSubagentChat(agent)) {
    return (
      <div className="v2-ag-scroll" data-testid="v2-agent-helper-chat" data-state="missing">
        <div className="v2-ag-col">
          <EmptyState icon="crew" tone="grey" title={AGENT_WORDS.helperMissing} action={<Button onClick={back}>{AGENT_WORDS.mainChat}</Button>} />
        </div>
      </div>
    );
  }
  const result = workflow ? (workflowChat?.result ?? null) : (chat?.result ?? null);
  const entry = agentActivity(activity, agent);
  const line = entry ? subagentActivityLine(entry, now) : null;
  const name = agent.description || agent.name;
  return (
    <div className="v2-ag-helper" data-testid="v2-agent-helper-chat" data-helper-id={helperId}>
      <div className="v2-ag-helper-head">
        <Button size="sm" variant="ghost" icon="back" onClick={back} data-testid="v2-agent-helper-back">
          {AGENT_WORDS.mainChat}
        </Button>
        <Avatar name={name} size="m" status={sessionStatusToV2(agent.status)} />
        <div className="v2-grow" style={{ minWidth: 0 }}>
          <b className="v2-ag-helper-name">{name}</b>
          <div className="v2-row" style={{ gap: 6 }}>
            <StatusBadge status={sessionStatusToV2(agent.status)} size="s" />
            <span className="v2-muted v2-ag-small">{AGENT_WORDS.helperOf(agentDisplayName(session, members))}</span>
          </div>
        </div>
      </div>
      <div
        className="v2-ag-scroll"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 32;
        }}
      >
        <div className="v2-ag-col">
          {chat?.brief ? (
            <div className="v2-ag-msg v2-ag-you" data-testid="v2-agent-helper-brief">
              <div className="v2-ag-who">{AGENT_WORDS.helperBrief}</div>
              <div className="v2-ag-pill">
                <ChatMarkdown text={chat.brief} testId="v2-agent-helper-brief-text" />
              </div>
            </div>
          ) : null}
          <ChatRowsView rows={rows} data={data} fullText={fullText.control} focusEventId={focusEventId} variant="full" readOnly />
          {result ? (
            <div className="v2-ag-msg v2-ag-reply" data-testid="v2-agent-helper-result" data-error={result.isError ? 'true' : undefined}>
              <div className="v2-ag-who">
                <Icon name={result.isError ? 'x' : 'check-circle'} size="s" />
                {AGENT_WORDS.helperResult}
              </div>
              <div className="v2-ag-step">
                <ChatMarkdown text={result.text} testId="v2-agent-helper-result-text" />
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="v2-ag-dock" data-variant="helper">
        <div className="v2-ag-live" data-kind={line ? 'working' : 'done'} role="status">
          {line ? <span className="v2-pulse" aria-hidden="true" /> : <Icon name="check" size="s" />}
          <span className="v2-ag-live-text">{line ? line.text : AGENT_WORDS.helperFinished}</span>
          {line ? <span className="v2-ag-live-time">{line.time}</span> : null}
        </div>
        <p className="v2-muted v2-ag-small" style={{ margin: 0 }}>
          {AGENT_WORDS.helperNoMessages}
        </p>
      </div>
    </div>
  );
}
