import type { SessionDetail } from '../../../core/api.ts';
import { statusColor } from '../../shell/format.ts';
import { HandoffCard } from './HandoffCard.tsx';
import { type AgentCard, agentCards, agentSummary, terminalLines } from './right-panel.ts';
import { TerminalTail } from './TerminalTail.tsx';

/**
 * Right panel (M4.3, SPEC → Session → Right panel; prototype right column): the
 * "Agents & solutions" header with its summary, one card per agent (dot, name,
 * description, status; path + ⎇ branch), the terminal tail, and the terminal
 * handoff card (M4.1) with `claude --resume <id>` + copy. Everything comes from
 * `GET /api/sessions/{id}` (agents, recent events, status), which SessionView
 * reloads on the session's `/hub` events. Rules: `right-panel.ts`,
 * `docs/session-panel.md`.
 */
export function RightPanel({ sessionId, session }: { readonly sessionId: string; readonly session: SessionDetail | null }) {
  return (
    <aside className="sb-sv-panel" data-testid="session-right-panel" data-session-id={sessionId}>
      {session ? (
        <>
          <div className="sb-sv-panel-head">
            <span className="sb-sv-panel-label">Agents &amp; solutions</span>
            <span className="sb-sv-panel-summary" data-testid="agents-summary">
              {agentSummary(session.agents)}
            </span>
          </div>
          <div className="sb-agents" data-testid="agent-cards">
            {agentCards(session.agents, session).map((card) => (
              <AgentCardView key={card.id} card={card} />
            ))}
          </div>
          <div className="sb-sv-panel-label sb-term-label">Terminal</div>
          <TerminalTail lines={terminalLines(session.events, session.agents, session.status)} className="sb-sv-term" />
          <HandoffCard attached={session.attached} command={session.resumeCommand} cwd={session.cwd} />
        </>
      ) : null}
    </aside>
  );
}

function AgentCardView({ card }: { readonly card: AgentCard }) {
  const color = statusColor(card.status);
  return (
    <div className="sb-agent" data-testid="agent-card" data-agent-id={card.id} data-status={card.status}>
      <div className="sb-agent-top">
        <span className="sb-agent-dot" style={{ background: color }} />
        <span className="sb-agent-name" data-testid="agent-name">
          {card.name}
        </span>
        <span className="sb-agent-desc" data-testid="agent-desc">
          {card.description}
        </span>
        <span className="sb-agent-status" data-testid="agent-status" style={{ color }}>
          {card.statusText}
        </span>
      </div>
      <div className="sb-agent-where">
        <span className="sb-agent-path" data-testid="agent-path">
          {card.path}
        </span>
        {card.branch ? (
          <span className="sb-agent-branch" data-testid="agent-branch">
            ⎇ {card.branch}
          </span>
        ) : null}
      </div>
    </div>
  );
}
