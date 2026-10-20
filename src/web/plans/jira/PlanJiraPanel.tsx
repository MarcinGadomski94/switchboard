import { type KeyboardEvent, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { JIRA_SYNC_MODES, type JiraRelinkDiff, type JiraSyncMode, type PlanJiraState } from '../../../core/plans-jira.ts';
import '../../components/close-session.css';
import { onHubEvent } from '../../api/useHub.ts';
import { JiraApiError, jiraApi } from './api.ts';
import './jira.css';

/** Props of {@link PlanJiraPanel}. */
export interface PlanJiraPanelProps {
  /** A plan imported from Jira (`plan.external?.system === 'jira'`). */
  readonly planId: string;
  /** D117: the plan is a draft (**Re-read dependencies from Jira** is offered). */
  readonly draft?: boolean;
}

/**
 * D99-Jira · a plan's Jira section: the sync setting (changeable on the plan), the transition
 * names, (D116) **Move to Done when merged into the feature branch** with its transition name, **Refresh now**, each ticket's status with its drift note and its last soft failure,
 * and the Jira activity (every write); D117: on a draft, **Re-read dependencies from Jira** (the
 * change listed in a confirmation first). Live through `planChanged`. Renders nothing for a plan
 * that was not imported from Jira (404 `not-jira`) or while Plans is off.
 */
export function PlanJiraPanel({ planId, draft = false }: PlanJiraPanelProps) {
  const [state, setState] = useState<PlanJiraState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** D116: the Done transition's name as typed (saved on blur or Enter); `null` = the saved one. */
  const [doneName, setDoneName] = useState<string | null>(null);
  /** D117: the re-read's change, shown for confirmation. */
  const [relink, setRelink] = useState<JiraRelinkDiff | null>(null);
  const [relinkError, setRelinkError] = useState<string | null>(null);

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

  const saveDoneName = () => {
    if (doneName === null) return;
    const name = doneName.trim();
    setDoneName(null);
    if (name === state.transitions.done) return;
    void act(() => jiraApi.update(planId, { transitions: { done: name } }));
  };

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

  const reread = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setRelinkError(null);
    try {
      setRelink(await jiraApi.rereadDependencies(planId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'failed');
    } finally {
      setBusy(false);
    }
  };
  const applyRelink = async (diff: JiraRelinkDiff): Promise<void> => {
    setBusy(true);
    setRelinkError(null);
    try {
      await jiraApi.rereadDependencies(planId, { apply: true, fingerprint: diff.fingerprint });
      setRelink(null);
      await load();
    } catch (caught) {
      if (caught instanceof JiraApiError && caught.code === 'changed') {
        // Jira or the plan changed meanwhile: show the new change instead.
        setRelink(await jiraApi.rereadDependencies(planId).catch(() => null));
      }
      setRelinkError(caught instanceof Error ? caught.message : 'failed');
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
        {draft ? (
          <button type="button" className="sb-jira-btn" data-testid="plan-jira-reread" disabled={busy} onClick={() => void reread()}>
            Re-read dependencies from Jira
          </button>
        ) : null}
        <span className="sb-jira-muted">{state.lastRefreshAt ? `read ${new Date(state.lastRefreshAt).toLocaleTimeString()}` : 'not read since the import'}</span>
      </div>
      {state.sync === 'write' ? (
        <>
          <div className="sb-jira-muted">
            Transitions: "{state.transitions.inProgress}" when a run starts, "{state.transitions.inReview}" when its PR opens
            {state.doneOnMerge ? `, "${state.transitions.done}" when merged into the feature branch` : '; Done is left to your team'}.
          </div>
          <div className="sb-jira-row sb-jira-done">
            <label className="sb-jira-check">
              <input
                type="checkbox"
                data-testid="plan-jira-done-on-merge"
                checked={state.doneOnMerge}
                disabled={busy}
                onChange={(event) => {
                  const on = event.target.checked;
                  void act(() => jiraApi.update(planId, { doneOnMerge: on }));
                }}
              />
              Move to Done when merged into the feature branch
            </label>
            {state.doneOnMerge ? (
              <label className="sb-jira-field sb-jira-grow">
                <span>"Done" transition</span>
                <input
                  data-testid="plan-jira-transition-done"
                  value={doneName ?? state.transitions.done}
                  disabled={busy}
                  onChange={(event) => setDoneName(event.target.value)}
                  onBlur={saveDoneName}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') saveDoneName();
                  }}
                />
              </label>
            ) : null}
          </div>
        </>
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
      {relink ? <RelinkConfirm diff={relink} busy={busy} error={relinkError} onApply={() => void applyRelink(relink)} onCancel={() => setRelink(null)} /> : null}
    </section>
  );
}

/** D117 · the re-read's confirmation: what goes, what comes, what stays; Apply only when something changes. */
function RelinkConfirm({ diff, busy, error, onApply, onCancel }: { readonly diff: JiraRelinkDiff; readonly busy: boolean; readonly error: string | null; readonly onApply: () => void; readonly onCancel: () => void }) {
  const nothing = diff.removed.length === 0 && diff.added.length === 0;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!busy) onCancel();
    }
  };
  const list = (title: string, testId: string, edges: JiraRelinkDiff['removed']) =>
    edges.length > 0 ? (
      <div>
        <div className="sb-jira-muted">{title}</div>
        <ul className="sb-jira-lines" data-testid={testId}>
          {edges.map((edge) => (
            <li key={`${edge.from}>${edge.to}`}>{edge.text}</li>
          ))}
        </ul>
      </div>
    ) : null;
  return createPortal(
    <div className="sb-close-overlay" onClick={busy ? undefined : onCancel} onKeyDown={onKeyDown}>
      <div className="sb-close-dialog" role="alertdialog" aria-modal="true" aria-labelledby="sb-jira-relink-text" data-testid="plan-jira-relink" onClick={(event) => event.stopPropagation()}>
        <div className="sb-close-text" id="sb-jira-relink-text">
          {nothing ? 'The plan already has Jira’s dependencies: nothing to change.' : 'Re-read dependencies from Jira: replace the dependencies that came from Jira links?'}
        </div>
        {list('Removed (backwards to Jira):', 'plan-jira-relink-removed', diff.removed)}
        {list('Added (from Jira):', 'plan-jira-relink-added', diff.added)}
        {list('Kept (yours or accepted proposals):', 'plan-jira-relink-kept', diff.kept)}
        {list('Left out (would make a cycle):', 'plan-jira-relink-cycles', diff.cycles)}
        {error ? (
          <div className="sb-close-error" role="alert" data-testid="plan-jira-relink-error">
            {error}
          </div>
        ) : null}
        <div className="sb-close-actions">
          {!nothing ? (
            <button type="button" className="sb-button sb-close-primary" data-testid="plan-jira-relink-apply" disabled={busy} aria-busy={busy || undefined} onClick={onApply}>
              Apply
            </button>
          ) : null}
          <button type="button" className="sb-button sb-close-outlined" data-testid="plan-jira-relink-cancel" disabled={busy} autoFocus onClick={onCancel}>
            {nothing ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
