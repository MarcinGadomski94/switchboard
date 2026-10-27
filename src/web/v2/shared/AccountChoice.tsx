import { type ReactNode, useState } from 'react';
import type { AccountChoicePreview } from '../../../core/api.ts';
import type { CliProviderId } from '../../../core/cli-providers.ts';
import type { Plan } from '../../../core/plans.ts';
import { ApiError, api } from '../../api/client.ts';
import type { CliAccountChoice } from '../../api/account-choice.ts';
import { plansApi } from '../../plans/api.ts';
import { Button, Dialog, Select, useToast } from '../components/index.ts';
import { ACCOUNT_CHOICE_WORDS as W } from '../glossary.ts';
import { choiceOptions } from './account-choice-model.ts';

export { accountLine, accountLineTitle, choiceOptions } from './account-choice-model.ts';

function errorText(caught: unknown): string {
  if (caught instanceof ApiError && typeof caught.body === 'object' && caught.body !== null) {
    const body = caught.body as { errors?: Array<{ message?: string }>; message?: string };
    const message = body.errors?.[0]?.message ?? body.message;
    if (message) return message;
  }
  return caught instanceof Error ? caught.message : String(caught);
}

/** D138: one select per CLI with more than one account (the pill, Settings › Usage & accounts). */
export function AccountChoiceRows({ rows, onChoose, disabled, testId = 'v2-account-choice' }: { readonly rows: readonly CliAccountChoice[]; readonly onChoose: (row: CliAccountChoice, profileId: string | null) => void; readonly disabled?: boolean; readonly testId?: string }) {
  return (
    <div className="v2-acct-choice" data-testid={testId}>
      {rows.map((row) => (
        <Select
          key={row.cli}
          label={rows.length > 1 ? W.picker(row.label) : W.title}
          value={row.chosen ?? ''}
          disabled={disabled}
          options={choiceOptions(row)}
          onChange={(event) => {
            const next = event.target.value === '' ? null : event.target.value;
            if (next !== row.chosen) onChoose(row, next);
          }}
          data-testid={`${testId}-select`}
          data-cli={row.cli}
        />
      ))}
    </div>
  );
}

interface Pending {
  readonly preview: AccountChoicePreview;
  readonly apply: () => Promise<void>;
}

/**
 * D138: choosing an account with the confirm: the counts first ("Move 5 agents to B? 1 running
 * turn will be interrupted."), nothing asked when nothing moves. `choose` is the overall choice;
 * `chooseForProject` a Project's account. `dialog` must be rendered (outside any popover).
 */
export function useChooseAccount(onDone?: () => void): {
  readonly choose: (cli: CliProviderId, profileId: string | null) => Promise<void>;
  readonly chooseForProject: (plan: Plan, cli: CliProviderId, profileId: string | null, onPlan: (plan: Plan) => void) => Promise<void>;
  readonly busy: boolean;
  readonly dialog: ReactNode;
} {
  const toast = useToast();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (preview: AccountChoicePreview, apply: () => Promise<void>): Promise<void> => {
    if (preview.move === 0) {
      await apply();
      return;
    }
    setPending({ preview, apply });
  };
  const choose = async (cli: CliProviderId, profileId: string | null): Promise<void> => {
    setBusy(true);
    try {
      const preview = await api.accountChoicePreview({ cli, profileId });
      await run(preview, async () => {
        const result = await api.setAccountChoice(cli, profileId);
        toast({ text: result.moving > 0 && preview.profileName ? W.moving(result.moving, preview.profileName) : preview.profileName ? W.saved(preview.profileName) : W.savedAuto });
        onDone?.();
      });
    } catch (caught) {
      toast({ text: errorText(caught), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const chooseForProject = async (plan: Plan, cli: CliProviderId, profileId: string | null, onPlan: (plan: Plan) => void): Promise<void> => {
    setBusy(true);
    try {
      const apply = async (): Promise<void> => {
        const next = await plansApi.update(plan.id, { accounts: { [cli]: profileId } });
        onPlan(next);
        toast({ text: W.projectSaved(plan.title) });
        onDone?.();
      };
      // A draft has no live sessions of its own steps yet; its own agent moves on Start.
      const preview = plan.state === 'draft' ? null : await api.accountChoicePreview({ cli, profileId, planId: plan.id });
      if (preview) await run(preview, apply);
      else await apply();
    } catch (caught) {
      toast({ text: errorText(caught), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const close = (): void => setPending(null);
  const dialog = pending ? (
    <Dialog
      open
      onClose={close}
      title={W.confirmTitle}
      icon="refresh"
      testId="v2-account-choice-confirm"
      footer={
        <>
          <Button onClick={close}>{W.cancel}</Button>
          <Button
            variant="primary"
            disabled={busy}
            data-testid="v2-account-choice-move"
            onClick={() => {
              const apply = pending.apply;
              setBusy(true);
              void apply()
                .catch((caught: unknown) => toast({ text: errorText(caught), tone: 'error' }))
                .finally(() => {
                  setBusy(false);
                  setPending(null);
                });
            }}
          >
            {W.move}
          </Button>
        </>
      }
    >
      <p data-testid="v2-account-choice-text">{pending.preview.confirm}</p>
      <p className="v2-muted" style={{ fontSize: 13 }}>
        {W.sub}
      </p>
    </Dialog>
  ) : null;
  return { choose, chooseForProject, busy, dialog };
}
