import { useState } from 'react';
import type { Plan } from '../../../core/plans.ts';
import type { PlanEdgeProposal, PlanJiraState } from '../../../core/plans-jira.ts';
import { jiraApi } from '../../plans/jira/api.ts';
import { Button, Icon, IconButton, useToast } from '../components/index.ts';
import { PROJECT_WORDS } from '../glossary.ts';
import { timeAgo } from '../shared/time.ts';

/**
 * D131 · lane P · a Jira project's "From Jira" section (collapsible): the epic, the sync, each
 * ticket's status and drift (D116), the full Jira context read now (D118, `GET
 * /api/plans/{id}/jira/context`, lane P's additive route), and the Jira activity list.
 */
export function JiraSection({ plan, state, onRefreshed }: { readonly plan: Plan; readonly state: PlanJiraState; readonly onRefreshed: (state: PlanJiraState) => void }) {
  const [context, setContext] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const toast = useToast();
  const readContext = async (): Promise<void> => {
    setReading(true);
    setProblem(null);
    try {
      const response = await fetch(`/api/plans/${encodeURIComponent(plan.id)}/jira/context?part=epic`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      const body = (await response.json().catch(() => null)) as { text?: string; message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`);
      setContext(body?.text ?? '');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  };
  const syncText = state.sync === 'off' ? 'Sync off' : state.sync === 'read-only' ? 'Reads tickets' : `Updates tickets${state.doneOnMerge ? ' · moves them to Done when combined' : ''}`;
  return (
    <details className="v2-card v2-p-fromjira-sec" data-testid="v2-from-jira">
      <summary>
        <Icon name="jira" size="s" />
        <b>{PROJECT_WORDS.fromJira}</b>
        <span className="v2-muted">
          {state.epicKey} · {syncText}
          {state.lastRefreshAt ? ` · read ${timeAgo(state.lastRefreshAt)}` : ''}
        </span>
        <Icon name="chev" size="s" className="v2-p-chev" />
      </summary>
      <div className="v2-p-fromjira-body">
        <div className="v2-row v2-p-wrap">
          <a href={state.epicUrl} target="_blank" rel="noreferrer">
            Open {state.epicKey} in Jira
          </a>
          <span className="v2-grow" />
          {state.sync !== 'off' ? (
            <Button
              size="sm"
              icon="refresh"
              onClick={async () => {
                try {
                  onRefreshed(await jiraApi.refresh(plan.id));
                  toast({ text: 'Read the tickets again.' });
                } catch (e) {
                  toast({ text: e instanceof Error ? e.message : String(e), tone: 'error' });
                }
              }}
            >
              Read now
            </Button>
          ) : null}
          <Button size="sm" icon="book" disabled={reading} onClick={() => void readContext()} data-testid="v2-from-jira-read">
            {reading ? 'Reading…' : 'Read the epic from Jira'}
          </Button>
        </div>
        {state.items.length > 0 ? (
          <ul className="v2-p-jira-tickets" aria-label="Tickets">
            {state.items.map((ticket) => (
              <li key={ticket.itemId}>
                <a href={ticket.url} target="_blank" rel="noreferrer" className="v2-mono">
                  {ticket.key}
                </a>
                <span className="v2-grow">{ticket.summary ?? ''}</span>
                <span className="v2-muted">{ticket.status ?? '—'}</span>
                {ticket.drift ? (
                  <span className="v2-p-step-warn">
                    <Icon name="alert" size="s" />
                    {ticket.drift}
                  </span>
                ) : null}
                {ticket.syncNote ? <span className="v2-muted">{ticket.syncNote}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {problem ? (
          <p className="v2-field-error" role="alert">
            {problem}
          </p>
        ) : null}
        {context !== null ? (
          <pre className="v2-p-pre" data-testid="v2-from-jira-context">
            {context}
          </pre>
        ) : null}
        <h4 className="v2-p-subhead">{PROJECT_WORDS.jiraActivity}</h4>
        {state.activity.length === 0 ? (
          <p className="v2-muted">Nothing yet.</p>
        ) : (
          <ul className="v2-p-jira-activity" data-testid="v2-jira-activity">
            {state.activity.slice(0, 30).map((entry) => (
              <li key={entry.id}>
                <span className="v2-muted v2-mono">{timeAgo(entry.at)}</span>
                <span>{entry.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

/** The dependency proposals of the project's agent (Propose order): accept or reject each, or all. */
export function ProposalsBlock({ plan, proposals, onChanged }: { readonly plan: Plan; readonly proposals: readonly PlanEdgeProposal[]; readonly onChanged: () => void }) {
  const toast = useToast();
  const pending = proposals.filter((proposal) => proposal.state === 'pending');
  if (pending.length === 0) return null;
  const decide = async (id: string | 'all', action: 'accept' | 'reject'): Promise<void> => {
    try {
      const answer = await jiraApi.decide(plan.id, id, action);
      if (answer.refused.length > 0) toast({ text: `Refused: ${answer.refused.map((entry) => `${entry.text} (${entry.reason})`).join('; ')}`, tone: 'error' });
      onChanged();
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : String(e), tone: 'error' });
    }
  };
  return (
    <section className="v2-card v2-p-proposals" data-testid="v2-proposals" aria-label="Proposed order">
      <div className="v2-row">
        <Icon name="diagram" size="s" />
        <b className="v2-grow">The project’s agent proposes an order</b>
        {pending.length > 1 ? (
          <Button size="sm" onClick={() => void decide('all', 'accept')}>
            Accept all
          </Button>
        ) : null}
      </div>
      <ul>
        {pending.map((proposal) => (
          <li key={proposal.id} data-testid="v2-proposal">
            <span className="v2-grow">
              <b>{proposal.text}</b>
              {proposal.reason ? <span className="v2-muted"> — {proposal.reason}</span> : null}
              {proposal.note ? <span className="v2-field-error"> {proposal.note}</span> : null}
            </span>
            <IconButton icon="check" label={`Accept: ${proposal.text}`} onClick={() => void decide(proposal.id, 'accept')} data-testid="v2-proposal-accept" />
            <IconButton icon="x" label={`Reject: ${proposal.text}`} onClick={() => void decide(proposal.id, 'reject')} data-testid="v2-proposal-reject" />
          </li>
        ))}
      </ul>
    </section>
  );
}
