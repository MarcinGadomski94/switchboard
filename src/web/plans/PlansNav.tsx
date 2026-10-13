import { Link, useRouter } from '../router.tsx';
import { runningCount } from './model.ts';
import { usePlans } from './store.ts';
import './plans.css';

/**
 * D99 · the entry points to Plans outside its pages, rendered only while Plans is on
 * (nothing at all while it is off, so those pages' DOM is as it was): the nav's **Plans**
 * item (after the others, with the number of running plans) and the session's **Plan** tab
 * in its right panel (the session that created a plan links to it).
 */

/** The nav's Plans item (only while Plans is on). */
export function PlansNavItem() {
  const { on, plans } = usePlans();
  const { route } = useRouter();
  if (!on) return null;
  const running = runningCount(plans);
  return (
    <Link to={{ view: 'plans' }} className="sb-nav-item" data-testid="nav-plans" data-tour="plans" aria-current={route.view === 'plans' || route.view === 'plan' ? 'page' : undefined}>
      <span>Plans</span>
      <span className="sb-badge" data-kind={running ? 'run' : undefined} data-testid="nav-plans-count" title={running ? `${running} running` : undefined}>
        {running ? String(running) : ''}
      </span>
    </Link>
  );
}

/** The session's Plan tab at the top of its right panel: one link per plan the session created (only while Plans is on). */
export function SessionPlanTab({ sessionId }: { readonly sessionId: string }) {
  const { on, plans } = usePlans();
  if (!on) return null;
  const mine = plans.filter((plan) => plan.sourceSessionId === sessionId && plan.machine === null);
  if (mine.length === 0) return null;
  return (
    <div className="sb-plan-tab" data-testid="session-plan-tab" data-tour="session-plan-tab">
      <span className="sb-plan-tab__label">Plan</span>
      {mine.map((plan) => (
        <Link key={plan.id} to={{ view: 'plan', id: plan.id }} className="sb-plan-tab__link" data-testid="session-plan-link" data-plan-id={plan.id}>
          <span className="sb-plan-tab__title">{plan.title}</span>
          <span className="sb-plan-tab__meta">
            {plan.progress.done}/{plan.progress.total} · {plan.state}
          </span>
        </Link>
      ))}
    </div>
  );
}
