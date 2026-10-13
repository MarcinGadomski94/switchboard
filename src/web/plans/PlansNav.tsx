import { useState } from 'react';
import { Link, useRouter } from '../router.tsx';
import { plansBadge } from '../shell/nav-grid.ts';
import { NavCell } from '../shell/NavCell.tsx';
import { ImportJiraDialog } from './jira/index.ts';
import { runningCount } from './model.ts';
import { putPlan, usePlans } from './store.ts';
import './plans.css';

/**
 * D99 · the entry points to Plans outside its pages, rendered only while Plans is on
 * (nothing at all while it is off, so those pages' DOM is as it was): the nav grid's **Plans**
 * cell (after the others, D101; with the number of running plans) and the session's **Plan** tab
 * in its right panel (the session that created a plan links to it).
 */

/** The nav grid's Plans cell (D101: a graph icon, the running plans as its badge; only while Plans is on). */
export function PlansNavItem() {
  const { on, plans } = usePlans();
  const { route } = useRouter();
  if (!on) return null;
  return (
    <NavCell
      to={{ view: 'plans' }}
      label="Plans"
      icon="plans"
      badge={plansBadge(runningCount(plans))}
      active={route.view === 'plans' || route.view === 'plan'}
      testId="nav-plans"
      tour="plans"
      badgeTestId="nav-plans-count"
    />
  );
}

/**
 * The session's Plan tab at the top of its right panel (only while Plans is on): one link per
 * plan the session created, and **Import from Jira…** with this session as the source (the new
 * draft opens). A paired machine's session gets it too (the import runs on its machine).
 */
export function SessionPlanTab({ sessionId }: { readonly sessionId: string }) {
  const { on, plans } = usePlans();
  const { navigate } = useRouter();
  const [importing, setImporting] = useState(false);
  if (!on) return null;
  const mine = plans.filter((plan) => plan.sourceSessionId === sessionId && plan.machine === null);
  return (
    <div className="sb-plan-tab" data-testid="session-plan-tab" data-tour="session-plan-tab">
      <span className="sb-plan-tab__head">
        <span className="sb-plan-tab__label">Plan</span>
        <button type="button" className="sb-button sb-plan-tab__import" data-testid="session-plan-import" onClick={() => setImporting(true)}>
          Import from Jira…
        </button>
      </span>
      {mine.map((plan) => (
        <Link key={plan.id} to={{ view: 'plan', id: plan.id }} className="sb-plan-tab__link" data-testid="session-plan-link" data-plan-id={plan.id}>
          <span className="sb-plan-tab__title">{plan.title}</span>
          <span className="sb-plan-tab__meta">
            {plan.progress.done}/{plan.progress.total} · {plan.state}
          </span>
        </Link>
      ))}
      {importing ? (
        <ImportJiraDialog
          sourceSessionId={sessionId}
          onImported={(plan) => {
            setImporting(false);
            putPlan(plan);
            navigate({ view: 'plan', id: plan.id });
          }}
          onClose={() => setImporting(false)}
        />
      ) : null}
    </div>
  );
}
