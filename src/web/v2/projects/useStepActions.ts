import { useCallback } from 'react';
import type { Plan, PlanItem } from '../../../core/plans.ts';
import { plansApi, refusalText } from '../../plans/api.ts';
import { useToast } from '../components/index.ts';
import { useOpenAgent } from '../shared/open-agent.ts';
import { type StepActionId, stepName, stepOpens } from './project-model.ts';

/**
 * D131 · lane P · what a step's buttons and ⋯ menu do: the plan routes (`plansApi`), a toast
 * with the outcome (Undo where it can be undone: a hold), the refusal's words otherwise.
 */
export interface StepActions {
  /** Opens the step's agent (its run session: the peek sheet, its page on a phone); `false` when it has none (the caller shows its details). */
  readonly open: (item: PlanItem) => boolean;
  readonly run: (item: PlanItem, action: StepActionId) => Promise<void>;
  readonly combine: (item: PlanItem) => Promise<void>;
  readonly sendBack: (item: PlanItem, comment: string) => Promise<boolean>;
  readonly edit: (item: PlanItem, title: string, estimateMinutes: number | null) => Promise<string | null>;
}

/** The step actions of `plan`; `put` takes the plan an action answered. */
export function useStepActions(plan: Plan, put: (plan: Plan) => void, onEdit: (item: PlanItem) => void): StepActions {
  const toast = useToast();
  const openAgent = useOpenAgent();

  const open = useCallback(
    (item: PlanItem): boolean => {
      const target = stepOpens(item);
      if ('agent' in target) {
        openAgent(target.agent);
        return true;
      }
      return false;
    },
    [openAgent],
  );

  const attempt = useCallback(
    async (work: () => Promise<Plan>, text: string, undo?: () => Promise<unknown>): Promise<boolean> => {
      try {
        put(await work());
        toast({ text, ...(undo ? { undo } : {}) });
        return true;
      } catch (error) {
        toast({ text: refusalText(error), tone: 'error' });
        return false;
      }
    },
    [put, toast],
  );

  const run = useCallback(
    async (item: PlanItem, action: StepActionId): Promise<void> => {
      const name = stepName(item);
      switch (action) {
        case 'hold':
          await attempt(() => plansApi.updateItem(plan.id, item.id, { hold: true }), `${name} is on hold: it waits for your approval.`, async () => put(await plansApi.updateItem(plan.id, item.id, { hold: false })));
          return;
        case 'release':
          await attempt(() => plansApi.updateItem(plan.id, item.id, { hold: false }), `${name} released.`, async () => put(await plansApi.updateItem(plan.id, item.id, { hold: true })));
          return;
        case 'reopen':
          await attempt(() => plansApi.reopenItem(plan.id, item.id), `${name} reopened. Its agent works on it again.`);
          return;
        case 'retry':
          await attempt(() => plansApi.retryItem(plan.id, item.id), `${name} will try again.`);
          return;
        case 'done':
          await attempt(() => plansApi.markItemDone(plan.id, item.id), `${name} marked done.`);
          return;
        case 'change': {
          if (item.prUrl) {
            window.open(item.prUrl, '_blank', 'noopener');
            return;
          }
          try {
            const next = await plansApi.openItemPr(plan.id, item.id);
            put(next);
            const url = next.items.find((entry) => entry.id === item.id)?.prUrl;
            if (url) window.open(url, '_blank', 'noopener');
            toast({ text: `Opened a change request for ${name}.` });
          } catch (error) {
            toast({ text: refusalText(error), tone: 'error' });
          }
          return;
        }
        case 'edit':
          onEdit(item);
          return;
        case 'remove':
          await attempt(() => plansApi.removeItem(plan.id, item.id), `${name} removed from the project. Its task stays in its agent’s list.`);
          return;
      }
    },
    [attempt, onEdit, plan.id, put, toast],
  );

  const combine = useCallback(
    async (item: PlanItem): Promise<void> => {
      const name = stepName(item);
      if (item.state === 'to-confirm') await attempt(() => plansApi.markItemDone(plan.id, item.id), `${name} confirmed done.`);
      else await attempt(() => plansApi.mergeItem(plan.id, item.id), `${name} combined into ${plan.targetBranch ?? 'the target'}.`);
    },
    [attempt, plan.id, plan.targetBranch],
  );

  const sendBack = useCallback((item: PlanItem, comment: string) => attempt(() => plansApi.sendBackItem(plan.id, item.id, comment), `${stepName(item)} sent back with your note.`), [attempt, plan.id]);

  const edit = useCallback(
    async (item: PlanItem, title: string, estimateMinutes: number | null): Promise<string | null> => {
      try {
        put(await plansApi.updateItem(plan.id, item.id, estimateMinutes === null ? { title } : { title, estimateMinutes }));
        toast({ text: `Saved ${title}.` });
        return null;
      } catch (error) {
        return refusalText(error);
      }
    },
    [plan.id, put, toast],
  );

  return { open, run, combine, sendBack, edit };
}
