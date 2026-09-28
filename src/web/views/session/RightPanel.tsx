import { type ReactNode, useState } from 'react';
import type { AgentActivity, BackgroundTask, SessionDetail } from '../../../core/api.ts';
import { AgentActivityText } from '../../activity/ActivityViews.tsx';
import { useLiveActivity } from '../../activity/useActivity.ts';
import { Link } from '../../router.tsx';
import { statusColor } from '../../shell/format.ts';
import { AgentOverview } from './AgentOverview.tsx';
import { hasSubagentChat } from './chat.ts';
import { HandoffCard } from './HandoffCard.tsx';
import { type AgentCard, agentCards, agentSummary, finishedLine, panelAgents, terminalLines } from './right-panel.ts';
import { OPEN_SUBAGENT_CHAT } from './subagent-chat.ts';
import { TerminalTail } from './TerminalTail.tsx';

/** D37: whether a session's finished subagents are expanded, kept in memory per session for this page's life. */
const finishedExpanded = new Map<string, boolean>();

/**
 * Right panel (M4.3, SPEC → Session → Right panel; prototype right column): the
 * "Agents & solutions" header with its summary, one card per agent (dot, name,
 * description, status; path + ⎇ branch), the terminal tail, and the terminal
 * handoff card (M4.1) with `claude --resume <id>` + copy. Everything comes from
 * `GET /api/sessions/{id}` (agents, recent events, status), which SessionView
 * reloads on the session's `/hub` events. Rules: `right-panel.ts`,
 * `docs/session-panel.md`. D19: an active agent's card shows its current action
 * and time in the status slot (the live activity, `activity` events; D30: the main
 * agent's background wait too, in the running color). D21: the
 * agent overview (`AgentOverview`) is the panel's first section, above the
 * header; the prototype's parts follow it unchanged. D36: a subagent's card opens
 * its chat. D37: finished subagents leave the cards (and the overview) for a
 * "✓ N finished" line under the cards, which expands them in place; the summary
 * still counts every agent.
 */
export function RightPanel({ sessionId, session }: { readonly sessionId: string; readonly session: SessionDetail | null }) {
  const activity = useLiveActivity(sessionId, session);
  const [expanded, setExpanded] = useState(() => finishedExpanded.get(sessionId) ?? false);
  const toggle = (): void => {
    finishedExpanded.set(sessionId, !expanded);
    setExpanded(!expanded);
  };
  const panel = session ? panelAgents(session.agents, expanded) : null;
  return (
    <aside className="sb-sv-panel" data-testid="session-right-panel" data-session-id={sessionId}>
      {session && panel ? (
        <>
          <AgentOverview session={session} activity={activity} />
          <div className="sb-sv-panel-head">
            <span className="sb-sv-panel-label">Agents &amp; solutions</span>
            <span className="sb-sv-panel-summary" data-testid="agents-summary">
              {agentSummary(session.agents)}
            </span>
          </div>
          <div className="sb-agents" data-testid="agent-cards">
            {agentCards(panel.shown, session).map((card, index) => {
              const agent = panel.shown[index];
              return (
                <AgentCardView
                  key={card.id}
                  sessionId={sessionId}
                  card={card}
                  opensChat={agent ? hasSubagentChat(agent) : false}
                  activity={activity?.agents[card.id] ?? null}
                  turnStartedAt={activity && agent?.kind === 'main' ? activity.turnStartedAt : null}
                  background={activity?.background ?? []}
                />
              );
            })}
            {panel.finished > 0 ? (
              <button
                type="button"
                className="sb-button sb-agents-finished"
                data-testid="agents-finished"
                aria-expanded={expanded}
                onClick={toggle}
              >
                {finishedLine(panel.finished)}
              </button>
            ) : null}
          </div>
          <div className="sb-sv-panel-label sb-term-label">Terminal</div>
          <TerminalTail lines={terminalLines(session.events, session.agents, session.status)} className="sb-sv-term" />
          <HandoffCard attached={session.attached} command={session.resumeCommand} cwd={session.cwd} />
        </>
      ) : null}
    </aside>
  );
}

/** A card's box: a link to the subagent's chat (D36) when it has one, else the prototype's plain card. */
function CardBox({
  sessionId,
  card,
  opensChat,
  children,
}: {
  readonly sessionId: string;
  readonly card: AgentCard;
  readonly opensChat: boolean;
  readonly children: ReactNode;
}) {
  if (opensChat) {
    return (
      <Link
        to={{ view: 'session', id: sessionId, tab: 'chat', agentId: card.id }}
        className="sb-agent sb-agent--link"
        data-testid="agent-card"
        data-agent-id={card.id}
        data-status={card.status}
        title={OPEN_SUBAGENT_CHAT}
      >
        {children}
      </Link>
    );
  }
  return (
    <div className="sb-agent" data-testid="agent-card" data-agent-id={card.id} data-status={card.status}>
      {children}
    </div>
  );
}

function AgentCardView({
  sessionId,
  card,
  opensChat,
  activity,
  turnStartedAt,
  background,
}: {
  readonly sessionId: string;
  readonly card: AgentCard;
  /** D36: a subagent with a chat to open (the card links to it). */
  readonly opensChat: boolean;
  readonly activity: AgentActivity | null;
  readonly turnStartedAt: string | null;
  /** D30: the session's pending background tasks (the main agent's background wait). */
  readonly background: readonly BackgroundTask[];
}) {
  // D30: an agent waiting on background work reads as working (the running color).
  const color = statusColor(activity?.state === 'background' ? 'run' : card.status);
  return (
    <CardBox sessionId={sessionId} card={card} opensChat={opensChat}>
      <div className="sb-agent-top">
        <span className="sb-agent-dot" style={{ background: color }} />
        <span className="sb-agent-name" data-testid="agent-name" title={card.name}>
          {card.name}
        </span>
        <span className="sb-agent-desc" data-testid="agent-desc" title={card.description || undefined}>
          {card.description}
        </span>
        <span className="sb-agent-status" data-testid="agent-status" style={{ color }}>
          {activity ? <AgentActivityText entry={activity} turnStartedAt={turnStartedAt} background={background} /> : card.statusText}
        </span>
      </div>
      <div className="sb-agent-where">
        <span className="sb-agent-path" data-testid="agent-path" title={card.path}>
          {card.path}
        </span>
        {card.branch ? (
          <span className="sb-agent-branch" data-testid="agent-branch" title={card.branch}>
            ⎇ {card.branch}
          </span>
        ) : null}
      </div>
    </CardBox>
  );
}
