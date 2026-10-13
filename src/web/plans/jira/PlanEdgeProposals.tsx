import { useCallback, useEffect, useState } from 'react';
import type { PlanEdgeProposal } from '../../../core/plans-jira.ts';
import { onHubEvent } from '../../api/useHub.ts';
import { JiraApiError, jiraApi } from './api.ts';
import './jira.css';

/** Props of {@link PlanEdgeProposals}. */
export interface PlanEdgeProposalsProps {
  readonly planId: string;
}

/**
 * D99-Jira-q1 · the dependencies the plan's source session proposed
 * (`plan_propose_dependencies`): one row per pending proposal, "PROJ-12 should wait on
 * PROJ-11 — <reason>", with ✓ (accept: the dependency is added through the plan, a cycle is
 * refused and shown on the row) and ✕ (reject), and **Accept all**. Live through
 * `planChanged`. Renders nothing when there is no pending proposal (or Plans is off).
 */
export function PlanEdgeProposals({ planId }: PlanEdgeProposalsProps) {
  const [proposals, setProposals] = useState<PlanEdgeProposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProposals(await jiraApi.proposals(planId));
    } catch (caught) {
      if (caught instanceof JiraApiError && caught.status === 404) setProposals([]);
      else setError(caught instanceof Error ? caught.message : 'failed');
    }
  }, [planId]);

  useEffect(() => {
    void load();
    return onHubEvent('planChanged', (payload) => {
      if (payload.planId === planId) void load();
    });
  }, [load, planId]);

  const pending = proposals.filter((entry) => entry.state === 'pending');
  if (pending.length === 0) return null;

  const decide = async (id: string | 'all', action: 'accept' | 'reject') => {
    setBusy(true);
    setError(null);
    try {
      const answer = await jiraApi.decide(planId, id, action);
      setProposals(answer.proposals);
      if (answer.refused.length > 0) setError(answer.refused.map((entry) => `${entry.text}: ${entry.reason}`).join('; '));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'failed');
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sb-jira-panel" data-testid="plan-proposals" aria-label="Proposed order">
      <div className="sb-jira-row">
        <h3 className="sb-jira-proposals-title">Proposed order ({pending.length})</h3>
        <span className="sb-jira-muted">From the plan's session. Nothing changes until you accept.</span>
        <button type="button" className="sb-jira-btn" data-testid="plan-proposals-accept-all" disabled={busy} onClick={() => void decide('all', 'accept')}>
          Accept all
        </button>
      </div>
      <ul className="sb-jira-lines">
        {pending.map((entry) => (
          <li key={entry.id} className="sb-jira-proposal" data-testid={`plan-proposal-${entry.id}`}>
            <span className="sb-jira-grow">
              {entry.text} — <span className="sb-jira-muted">{entry.reason}</span>
              {entry.note ? <span className="sb-jira-warn"> · {entry.note}</span> : null}
            </span>
            <button type="button" className="sb-jira-btn" aria-label={`Accept: ${entry.text}`} data-testid={`plan-proposal-accept-${entry.id}`} disabled={busy} onClick={() => void decide(entry.id, 'accept')}>
              ✓
            </button>
            <button type="button" className="sb-jira-btn" aria-label={`Reject: ${entry.text}`} data-testid={`plan-proposal-reject-${entry.id}`} disabled={busy} onClick={() => void decide(entry.id, 'reject')}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <div className="sb-jira-error" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}
