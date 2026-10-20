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

/** A running or paused plan is cancelled first (the existing Cancel); `null` for any other. */
export function planDeleteNote(plan: Pick<Plan, 'state'>): string | null {
  if (plan.state !== 'running' && plan.state !== 'paused') return null;
  return `It is ${plan.state}: it is cancelled first, as Cancel does (no item starts again; sessions already working are not stopped), then deleted.`;
}

/** Why a paired machine's plan cannot be deleted now (that machine is unreachable), else `null`. */
export function planDeleteBlocked(plan: Pick<Plan, 'machine'>): string | null {
  return offlineReason(plan.machine as SessionMachine | null);
}

/**
 * D117 follow-up · deletes a plan: a running or paused one is cancelled first through
 * `POST /api/plans/{id}/cancel` (the server refuses to delete a running plan), then
 * `DELETE /api/plans/{id}`. A paired machine's plan id is forwarded to its machine.
 */
export async function deletePlan(plan: Pick<Plan, 'id' | 'state'>): Promise<void> {
  if (plan.state === 'running' || plan.state === 'paused') await plansApi.cancel(plan.id);
  await plansApi.remove(plan.id);
  dropPlan(plan.id);
}

function Note({ plan }: { readonly plan: Pick<Plan, 'state'> }) {
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
