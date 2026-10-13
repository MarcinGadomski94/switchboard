import { useCallback, useEffect, useState } from 'react';
import { JIRA_SYNC_MODES, type JiraSyncMode, type PlanJiraState } from '../../../core/plans-jira.ts';
import { onHubEvent } from '../../api/useHub.ts';
import { JiraApiError, jiraApi } from './api.ts';
import './jira.css';

/** Props of {@link PlanJiraPanel}. */
export interface PlanJiraPanelProps {
  /** A plan imported from Jira (`plan.external?.system === 'jira'`). */
  readonly planId: string;
}

/**
 * D99-Jira · a plan's Jira section: the sync setting (changeable on the plan), the transition
 * names, **Refresh now**, each ticket's status with its drift note and its last soft failure,
 * and the Jira activity (every write). Live through `planChanged`. Renders nothing for a plan
 * that was not imported from Jira (404 `not-jira`) or while Plans is off.
 */
export function PlanJiraPanel({ planId }: PlanJiraPanelProps) {
  const [state, setState] = useState<PlanJiraState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await jiraApi.state(planId));
    } catch (caught) {
      if (caught instanceof JiraApiError && (caught.code === 'not-jira' || caught.code === 'plans-off' || caught.status === 404)) setHidden(true);
      else setError(caught instanceof Error ? caught.message : 'failed');
    }
  }, [planId]);

  useEffect(() => {
    void load();
    return onHubEvent('planChanged', (payload) => {
      if (payload.planId === planId) void load();
    });
  }, [load, planId]);

  if (hidden || state === null) return null;

  const act = async (work: () => Promise<PlanJiraState>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await work());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sb-jira-panel" data-testid="plan-jira">
      <div className="sb-jira-row">
        <a href={state.epicUrl} target="_blank" rel="noreferrer noopener" className="sb-jira-key">
          {state.epicKey}
        </a>
        <label className="sb-jira-inline">
          Jira sync
          <select data-testid="plan-jira-sync" value={state.sync} disabled={busy} onChange={(event) => void act(() => jiraApi.update(planId, { sync: event.target.value as JiraSyncMode }))}>
            {JIRA_SYNC_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>
        {state.sync !== 'off' ? (
          <button type="button" className="sb-jira-btn" data-testid="plan-jira-refresh" disabled={busy} onClick={() => void act(() => jiraApi.refresh(planId))}>
            Refresh now
          </button>
        ) : null}
        <span className="sb-jira-muted">{state.lastRefreshAt ? `read ${new Date(state.lastRefreshAt).toLocaleTimeString()}` : 'not read since the import'}</span>
      </div>
      {state.sync === 'write' ? (
        <div className="sb-jira-muted">
          Transitions: "{state.transitions.inProgress}" when a run starts, "{state.transitions.inReview}" when its PR opens; Done is left to your team.
        </div>
      ) : null}
      <ul className="sb-jira-lines" data-testid="plan-jira-items">
        {state.items
          .filter((item) => item.drift !== null || item.syncNote !== null)
          .map((item) => (
            <li key={item.itemId} data-testid={`plan-jira-item-${item.key}`}>
              <span className="sb-jira-key">{item.key}</span> {item.status ?? ''}
              {item.drift ? <span className="sb-jira-warn"> · {item.drift}</span> : null}
              {item.syncNote ? <span className="sb-jira-muted"> · {item.syncNote}</span> : null}
            </li>
          ))}
      </ul>
      <details>
        <summary>Jira activity ({state.activity.length})</summary>
        <ul className="sb-jira-lines" data-testid="plan-jira-activity">
          {state.activity.map((entry) => (
            <li key={entry.id} data-kind={entry.kind}>
              <span className="sb-jira-muted">{new Date(entry.at).toLocaleString()}</span> {entry.text}
            </li>
          ))}
        </ul>
      </details>
      {error ? <div className="sb-jira-error">{error}</div> : null}
    </section>
  );
}
