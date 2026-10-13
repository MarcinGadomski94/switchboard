import { useEffect, useState } from 'react';
import type { InboxItem } from '../../core/api.ts';
import type { Plan, PlanItem } from '../../core/plans.ts';
import type { Review } from '../../core/reviews.ts';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useHubEvent } from '../api/useHub.ts';
import { Link } from '../router.tsx';
import { useLayout } from '../shell/useLayout.ts';
import { useToasts } from '../toast/ToastHost.tsx';
import { plansApi, refusalCode, refusalText } from './api.ts';
import { AddItemsDialog, LimitsDialog, MergeModeDialog } from './dialogs.tsx';
import { PlanDetail } from './PlanDetail.tsx';
import { GraphLegend, PlanGraph } from './PlanGraph.tsx';
import { PlansOff } from './PlansPage.tsx';
import { PlanTimeline } from './PlanTimeline.tsx';
import {
  STATE_LOOK,
  canEditDependencies,
  editHint,
  inlineAction,
  limitsChip,
  mergeModeChip,
  planStateText,
  progressText,
  refuseEdge,
  repoLine,
  statusLine,
  targetChip,
  timeLeftText,
} from './model.ts';
import { putPlan, reloadPlans, usePlans } from './store.ts';
import './plans.css';

/** The plan page's views. */
type PlanTab = 'graph' | 'timeline' | 'list';

const TABS: readonly { readonly id: PlanTab; readonly label: string }[] = [
  { id: 'graph', label: 'Graph' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'list', label: 'List' },
];

/** The dialog open on the page. */
type Open = 'start' | 'mode' | 'limits' | 'add' | null;

/** The List view (also the phone's layout): compact rows with an inline Answer / Merge. */
function PlanList({ plan, selectedId, reviews, onSelect, onMerged }: { readonly plan: Plan; readonly selectedId: string | null; readonly reviews: readonly Review[]; readonly onSelect: (itemId: string) => void; readonly onMerged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="sb-plan-rows" data-testid="plan-list">
      {error ? <div className="sb-plan-error">{error}</div> : null}
      {plan.items.map((item) => {
        const look = STATE_LOOK[item.state];
        const action = inlineAction(item);
        const review = action === 'merge' && item.runSessionId ? reviews.find((entry) => entry.sessionId === item.runSessionId && entry.state === 'pending') : undefined;
        return (
          <div key={item.id} className="sb-plan-row" data-testid="plan-row" data-item-id={item.id} data-state={item.state} aria-selected={selectedId === item.id}>
            <button type="button" className="sb-button sb-plan-row__main" onClick={() => onSelect(item.id)}>
              <span className="sb-plan-row__icon" style={{ color: look.color }} aria-hidden="true">
                {look.icon}
              </span>
              <span className="sb-plan-row__key">{item.key ?? ''}</span>
              <span className="sb-plan-row__title">{item.title}</span>
              <span className="sb-plan-row__status" style={{ color: item.state === 'waiting' || item.state === 'ready' ? undefined : look.color }}>
                {statusLine(item, plan.items)}
              </span>
              <span className="sb-plan-row__repo">{repoLine(item, plan)}</span>
            </button>
            {action === 'answer' ? (
              <button type="button" className="sb-button sb-plan-btn" data-testid="plan-row-answer" onClick={() => onSelect(item.id)}>
                Answer
              </button>
            ) : null}
            {action === 'merge' ? (
              <button
                type="button"
                className="sb-button sb-plan-btn sb-plan-btn--primary"
                data-testid="plan-row-merge"
                disabled={busy !== null || !review || !review.actions.includes('merge')}
                onClick={() => {
                  if (!review) return;
                  setBusy(item.id);
                  setError(null);
                  api
                    .reviewAction(review.id, 'merge')
                    .then(onMerged, (caught: unknown) => setError(refusalText(caught)))
                    .finally(() => setBusy(null));
                }}
              >
                Merge
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * D99 · a plan's page (`/plans/{id}`, `docs/plans.md` → *The plan page*): the header (title,
 * the external key, ⎇ target → base; progress "4/7 done", its bar, "~3h left"; the merge-mode,
 * limits and critical-path chips; ✎ Edit dependencies, ⏸ Pause / ▶ Resume, ▶ Start plan), the
 * Graph / Timeline / List tabs, the dependency editor and the selected item's detail under
 * them. Phone: the List with the detail full screen ("‹ <plan>"); tablet: the Graph scrolls
 * sideways. Live on `planChanged` (the shared store), the Inbox and the review cards.
 */
export function PlanPage({ planId }: { readonly planId: string }) {
  const { on, plans, loaded } = usePlans();
  const layout = useLayout();
  const phone = layout === 'phone';
  const { show } = useToasts();
  const [tab, setTab] = useState<PlanTab>('graph');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [critical, setCritical] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editFirst, setEditFirst] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inbox = useApi(api.inbox);
  const reviews = useApi(api.reviews);
  useHubEvent('inboxChanged', () => inbox.reload());
  useHubEvent('reviewsChanged', () => reviews.reload());
  useHubEvent('planChanged', (payload) => {
    if (payload.planId === planId) {
      inbox.reload();
      reviews.reload();
    }
  });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    void reloadPlans();
  }, [planId]);

  const plan = plans.find((candidate) => candidate.id === planId) ?? null;
  if (!on) return loaded ? <PlansOff /> : <div className="sb-plan-page" />;
  if (!plan) {
    return (
      <div className="sb-plan-off" data-testid="plan-missing">
        <div className="sb-plan-off__title">{loaded ? 'No such plan' : 'Reading the plan…'}</div>
        <Link to={{ view: 'plans' }} className="sb-button sb-plan-btn">
          ‹ Plans
        </Link>
      </div>
    );
  }
  const remote = plan.machine !== null;
  const selected: PlanItem | null = plan.items.find((item) => item.id === selectedId) ?? null;
  const toast = (text: string): void => show({ id: `plan-${Date.now()}`, title: 'Plans', sub: 'now', branch: '', text, sessionId: null });
  const changed = (answer?: Plan): void => {
    if (answer) putPlan(answer);
    else void reloadPlans();
    inbox.reload();
    reviews.reload();
  };
  const act = async (action: () => Promise<Plan>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      changed(await action());
    } catch (caught) {
      setError(refusalText(caught));
    } finally {
      setBusy(false);
    }
  };

  const pickCard = (item: PlanItem): void => {
    if (!editing) {
      setSelectedId(item.id);
      return;
    }
    if (editFirst === null) {
      setEditFirst(item.id);
      return;
    }
    if (editFirst === item.id) {
      setEditFirst(null);
      return;
    }
    const refusal = refuseEdge(plan, editFirst, item.id);
    const from = editFirst;
    setEditFirst(null);
    if (refusal) {
      toast(refusal);
      return;
    }
    void plansApi.addEdge(plan.id, from, item.id).then(changed, (caught: unknown) => toast(refusalCode(caught) === 'cycle' ? (refuseEdge(plan, from, item.id) ?? `Refused: ${refusalText(caught)}`) : `Refused: ${refusalText(caught)}`));
  };
  const removeEdge = (from: string, to: string): void => {
    void plansApi.removeEdge(plan.id, from, to).then(changed, (caught: unknown) => toast(refusalText(caught)));
  };
  const first = editFirst ? (plan.items.find((item) => item.id === editFirst) ?? null) : null;
  const finished = plan.state === 'done' || plan.state === 'cancelled';
  const showDetail = selected !== null;
  const detail = selected ? <PlanDetail plan={plan} item={selected} inbox={inbox.data ?? ([] as InboxItem[])} reviews={reviews.data ?? []} onChanged={changed} onBack={phone ? () => setSelectedId(null) : null} /> : null;

  if (phone && showDetail) {
    return (
      <div className="sb-plan-page sb-plan-page--detail" data-testid="plan-page" data-plan-id={plan.id}>
        {detail}
      </div>
    );
  }
  const view: PlanTab = phone ? 'list' : tab;

  return (
    <div className="sb-plan-page" data-testid="plan-page" data-plan-id={plan.id} data-state={plan.state}>
      <header className="sb-plan-header sb-plan-header--plan">
        <div className="sb-plan-header__main">
          {!phone ? (
            <Link to={{ view: 'plans' }} className="sb-plan-crumb" data-testid="plan-back">
              Plans ›
            </Link>
          ) : null}
          <h1 className="sb-plan-title" data-testid="plan-title">
            {plan.title}
          </h1>
          {plan.external ? (
            <span className="sb-plan-chip" data-testid="plan-external">
              {plan.external.key}
            </span>
          ) : null}
          <span className="sb-plan-chip sb-plan-branch" data-testid="plan-target">
            {targetChip(plan)}
          </span>
          <span className="sb-plan-state" data-state={plan.state} data-testid="plan-state">
            {planStateText(plan)}
          </span>
        </div>
        <div className="sb-plan-progress sb-plan-progress--header" data-testid="plan-progress">
          <span className="sb-plan-progress__text">{progressText(plan)}</span>
          <span className="sb-plan-progress__bar">
            <span className="sb-plan-progress__fill" style={{ width: `${plan.progress.percent}%` }} />
          </span>
          <span className="sb-plan-progress__left" data-testid="plan-left">
            {timeLeftText(plan) ?? ''}
          </span>
        </div>
        <div className="sb-plan-chips">
          <button type="button" className="sb-button sb-plan-chip sb-plan-chip--button" data-testid="plan-mode-chip" data-mode={plan.mergeMode ?? 'none'} disabled={finished || remote} onClick={() => setOpen(plan.state === 'draft' ? 'start' : 'mode')}>
            {mergeModeChip(plan)}
          </button>
          <button type="button" className="sb-button sb-plan-chip sb-plan-chip--button" data-testid="plan-limits-chip" disabled={finished || remote} onClick={() => setOpen('limits')}>
            {limitsChip(plan)}
          </button>
          <button type="button" className="sb-button sb-plan-chip sb-plan-chip--button" data-testid="plan-critical-chip" aria-pressed={critical} data-on={critical || undefined} onClick={() => setCritical(!critical)}>
            Critical path {critical ? 'on' : 'off'}
          </button>
          <span className="sb-plan-chips__spacer" />
          {canEditDependencies(plan) && !phone ? (
            <button
              type="button"
              className="sb-button sb-plan-btn"
              data-testid="plan-edit"
              aria-pressed={editing}
              onClick={() => {
                setEditing(!editing);
                setEditFirst(null);
                if (!editing) setTab('graph');
              }}
            >
              {editing ? '✓ Done editing' : '✎ Edit dependencies'}
            </button>
          ) : null}
          {plan.state === 'running' && !remote ? (
            <button type="button" className="sb-button sb-plan-btn" data-testid="plan-pause" disabled={busy} onClick={() => void act(() => plansApi.pause(plan.id))}>
              ⏸ Pause
            </button>
          ) : null}
          {plan.state === 'paused' && !remote ? (
            <button type="button" className="sb-button sb-plan-btn" data-testid="plan-resume" disabled={busy} onClick={() => void act(() => plansApi.resume(plan.id))}>
              ▶ Resume
            </button>
          ) : null}
          {plan.state === 'draft' && !remote ? (
            <button type="button" className="sb-button sb-plan-btn sb-plan-btn--primary" data-testid="plan-start" disabled={busy || plan.items.length === 0} onClick={() => setOpen('start')}>
              ▶ Start plan
            </button>
          ) : null}
        </div>
        {plan.held && plan.state === 'running' ? (
          <div className="sb-plan-held" data-testid="plan-held">
            New starts held: {plan.held}
          </div>
        ) : null}
      </header>
      {error ? (
        <div className="sb-plan-error sb-plan-error--page" data-testid="plan-error">
          {error}
        </div>
      ) : null}

      {!phone ? (
        <div className="sb-plan-tabs" role="tablist">
          {TABS.map((entry) => (
            <button key={entry.id} type="button" role="tab" className="sb-button sb-plan-tab-button" data-testid={`plan-tab-${entry.id}`} aria-selected={view === entry.id} onClick={() => setTab(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}

      {editing ? (
        <div className="sb-plan-hint" data-testid="plan-edit-hint">
          <span>{editHint(first, plan.items)}</span>
          <button type="button" className="sb-button sb-plan-btn" data-testid="plan-add-items" onClick={() => setOpen('add')}>
            ＋ Add items from todos
          </button>
        </div>
      ) : null}

      <div className="sb-plan-body">
        {view === 'graph' ? (
          <>
            <PlanGraph plan={plan} selectedId={selectedId} critical={critical} editing={editing} editFirst={editFirst} onCard={pickCard} onEdge={removeEdge} />
            <GraphLegend critical={critical} />
          </>
        ) : null}
        {view === 'timeline' ? <PlanTimeline plan={plan} now={now} selectedId={selectedId} onSelect={setSelectedId} /> : null}
        {view === 'list' ? <PlanList plan={plan} selectedId={selectedId} reviews={reviews.data ?? []} onSelect={setSelectedId} onMerged={() => changed()} /> : null}
        {detail ??
          (phone ? null : (
            <div className="sb-plan-detail sb-plan-detail--empty" data-testid="plan-detail-empty">
              Click a ticket to see it here.
            </div>
          ))}
      </div>

      {open === 'start' || open === 'mode' ? (
        <MergeModeDialog
          plan={plan}
          purpose={open === 'start' ? 'start' : 'change'}
          onClose={() => setOpen(null)}
          onDone={(answer) => {
            setOpen(null);
            changed(answer);
          }}
        />
      ) : null}
      {open === 'limits' ? (
        <LimitsDialog
          plan={plan}
          onClose={() => setOpen(null)}
          onDone={(answer) => {
            setOpen(null);
            changed(answer);
          }}
        />
      ) : null}
      {open === 'add' ? (
        <AddItemsDialog
          plan={plan}
          onClose={() => setOpen(null)}
          onDone={(answer) => {
            setOpen(null);
            changed(answer);
          }}
        />
      ) : null}
    </div>
  );
}
