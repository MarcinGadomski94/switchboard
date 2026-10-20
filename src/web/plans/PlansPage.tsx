import { useState } from 'react';
import type { Plan } from '../../core/plans.ts';
import { Link, useRouter } from '../router.tsx';
import { JiraSourceDialog, NewPlanDialog } from './dialogs.tsx';
import { ImportJiraDialog } from './jira/index.ts';
import { mergeModeChip, planStateText, progressText, targetChip, timeLeftText } from './model.ts';
import { putPlan, usePlans } from './store.ts';
import './plans.css';

/** Points to Settings → Experimental while Plans is off (the page itself is not linked then). */
export function PlansOff() {
  return (
    <div className="sb-plan-off" data-testid="plans-off">
      <div className="sb-plan-off__title">Plans is off</div>
      <div className="sb-plan-muted">Plans is an experimental feature. Switch it on in Settings → Experimental.</div>
      <Link to={{ view: 'settings', section: 'experimental' }} className="sb-button sb-plan-btn" data-testid="plans-off-settings">
        Open Settings → Experimental
      </Link>
    </div>
  );
}

/**
 * D99 · the Plans list (`/plans`, `docs/plans-ui.md` → *The Plans page*): a card per plan with
 * its state, progress and merge mode, newest first; **＋ New plan** (a session, title, target
 * branch, base, items from its todos) and **Import from Jira…** (the Jira lane's
 * `ImportJiraDialog`: D112, a new session in a folder owns the plan; **Use an existing session
 * instead** picks a session first, as before; the new draft opens).
 */
export function PlansPage() {
  const { on, plans, loaded } = usePlans();
  const { navigate } = useRouter();
  const [open, setOpen] = useState<'new' | 'import' | null>(null);
  const [jiraSource, setJiraSource] = useState<string | null>(null);
  // D112: Import from Jira starts in a folder (a new session owns the plan); an existing session on request.
  const [jiraWith, setJiraWith] = useState<'folder' | 'session'>('folder');
  if (!on) return loaded ? <PlansOff /> : <div className="sb-plan-page" />;
  const closeImport = (): void => {
    setOpen(null);
    setJiraSource(null);
    setJiraWith('folder');
  };
  const opened = (plan: Plan): void => {
    closeImport();
    putPlan(plan);
    navigate({ view: 'plan', id: plan.id });
  };
  const sorted = [...plans].sort((a, b) => (a.machine === null ? 0 : 1) - (b.machine === null ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="sb-plan-page" data-testid="plans-page">
      <header className="sb-plan-header">
        <div className="sb-plan-header__main">
          <h1 className="sb-plan-title">Plans</h1>
          <span className="sb-plan-muted">Todos in a dependency graph, run by themselves into an epic branch.</span>
        </div>
        <div className="sb-plan-header__actions">
          <button
            type="button"
            className="sb-button sb-plan-btn"
            data-testid="plans-import-jira"
            data-tour="plans-import"
            onClick={() => setOpen('import')}
          >
            Import from Jira…
          </button>
          <button type="button" className="sb-button sb-plan-btn sb-plan-btn--primary" data-testid="plans-new" data-tour="plans-new" onClick={() => setOpen('new')}>
            ＋ New plan
          </button>
        </div>
      </header>
      <div className="sb-plan-list" data-testid="plans-list">
        {sorted.length === 0 ? (
          <div className="sb-plan-empty" data-testid="plans-empty">
            <div className="sb-plan-off__title">No plans yet</div>
            <div className="sb-plan-muted">A plan runs a session's todos in order and in parallel, each in its own worktree, and merges them into one epic branch.</div>
          </div>
        ) : null}
        {sorted.map((plan) => (
          <Link key={plan.id} to={{ view: 'plan', id: plan.id }} className="sb-plan-summary" data-testid="plan-summary" data-plan-id={plan.id} data-state={plan.state}>
            <span className="sb-plan-summary__head">
              <span className="sb-plan-summary__title">{plan.title}</span>
              {plan.external ? <span className="sb-plan-chip">{plan.external.key}</span> : null}
              <span className="sb-plan-summary__state" data-state={plan.state} data-testid="plan-summary-state">
                {planStateText(plan)}
              </span>
              {plan.machine ? <span className="sb-plan-chip">{plan.machine.name}</span> : null}
            </span>
            <span className="sb-plan-summary__line">
              <span className="sb-plan-branch">{targetChip(plan)}</span>
              <span>{mergeModeChip(plan)}</span>
            </span>
            <span className="sb-plan-progress" aria-label={progressText(plan)}>
              <span className="sb-plan-progress__text">{progressText(plan)}</span>
              <span className="sb-plan-progress__bar">
                <span className="sb-plan-progress__fill" style={{ width: `${plan.progress.percent}%` }} />
              </span>
              <span className="sb-plan-progress__left">{timeLeftText(plan) ?? ''}</span>
            </span>
          </Link>
        ))}
      </div>
      {open === 'new' ? <NewPlanDialog initialSessionId={null} onCreated={opened} onClose={() => setOpen(null)} /> : null}
      {open === 'import' && jiraWith === 'folder' ? <ImportJiraDialog onImported={opened} onClose={closeImport} onUseSession={() => setJiraWith('session')} /> : null}
      {open === 'import' && jiraWith === 'session' && jiraSource === null ? <JiraSourceDialog onPick={setJiraSource} onClose={closeImport} onUseFolder={() => setJiraWith('folder')} /> : null}
      {open === 'import' && jiraWith === 'session' && jiraSource !== null ? <ImportJiraDialog sourceSessionId={jiraSource} onImported={opened} onClose={closeImport} /> : null}
    </div>
  );
}
