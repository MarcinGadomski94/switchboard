import { useState } from 'react';
import { offlineReason, type SessionMachine } from '../../core/peers.ts';
import type { Plan } from '../../core/plans.ts';
import { DeleteConfirm, RowDeleteMenu } from '../views/session/ArtifactDelete.tsx';
import { plansApi, refusalText } from './api.ts';
import { dropPlan } from './store.ts';

/** The confirmation's question. */
export function planDeleteQuestion(plan: Pick<Plan, 'title'>): string {
  return `Delete “${plan.title}”? Its items' todos and their sessions stay; only the plan goes.`;
}

/** How many of a plan's items have a session at work now (their turns are stopped by Delete). */
export function runningSessions(plan: Pick<Plan, 'items'>): number {
  return plan.items.filter((item) => item.state === 'running' && item.runSessionId !== null).length;
}

/** A running or paused plan is cancelled first and its working sessions stopped; `null` for any other. */
export function planDeleteNote(plan: Pick<Plan, 'state' | 'items'>): string | null {
  if (plan.state !== 'running' && plan.state !== 'paused') return null;
  const count = runningSessions(plan);
  const stop = count === 0 ? '' : ` and its ${count === 1 ? 'running session is' : `${count} running sessions are`} stopped (they stay in the sidebar)`;
  return `It is ${plan.state}: it is cancelled first${stop}; then the plan is deleted.`;
}

/** Why a paired machine's plan cannot be deleted now (that machine is unreachable), else `null`. */
export function planDeleteBlocked(plan: Pick<Plan, 'machine'>): string | null {
  return offlineReason(plan.machine as SessionMachine | null);
}

/**
 * D117 follow-up · deletes a plan: `DELETE /api/plans/{id}?stop=1` cancels a running or paused
 * one and stops its item sessions' running turns on the server (the session's own Stop), then
 * deletes it. A paired machine's plan id is forwarded to its machine, which stops its own sessions.
 */
export async function deletePlan(plan: Pick<Plan, 'id'>): Promise<void> {
  await plansApi.removeStopping(plan.id);
  dropPlan(plan.id);
}

function Note({ plan }: { readonly plan: Pick<Plan, 'state' | 'items'> }) {
  const note = planDeleteNote(plan);
  return note ? (
    <div className="sb-plan-muted" data-testid="plan-delete-note">
      {note}
    </div>
  ) : null;
}

/** A Plans list row's ⋯ with **Delete…** (outside the row's link, like the artifact lists'). */
export function PlanRowMenu({ plan }: { readonly plan: Plan }) {
  return <RowDeleteMenu title={plan.title} blocked={planDeleteBlocked(plan)} remove={() => deletePlan(plan)} question={planDeleteQuestion(plan)} details={<Note plan={plan} />} testIdPrefix="plan" />;
}

/** The plan page's **Delete plan…**: asks first, then deletes and calls `onDeleted` (the page goes to the list). */
export function PlanDeleteButton({ plan, onDeleted }: { readonly plan: Plan; readonly onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = planDeleteBlocked(plan);
  const confirm = (): void => {
    setBusy(true);
    setError(null);
    deletePlan(plan).then(
      () => {
        setBusy(false);
        setConfirming(false);
        onDeleted();
      },
      (caught: unknown) => {
        setBusy(false);
        setError(refusalText(caught));
      },
    );
  };
  return (
    <>
      <button
        type="button"
        className="sb-button sb-plan-btn sb-plan-btn--danger"
        data-testid="plan-delete"
        disabled={blocked !== null}
        title={blocked ?? undefined}
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
      >
        Delete plan…
      </button>
      {confirming ? (
        <DeleteConfirm question={planDeleteQuestion(plan)} testIdPrefix="plan" busy={busy} error={error} onConfirm={confirm} onCancel={() => setConfirming(false)}>
          <Note plan={plan} />
        </DeleteConfirm>
      ) : null}
    </>
  );
}
