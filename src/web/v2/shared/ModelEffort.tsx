import { Select } from '../components/index.ts';
import { WORDS } from '../glossary.ts';
import './shared.css';
import type { ModelEffortField } from './model-effort.ts';

/**
 * Fixes after 2.0 · the v2 **Model** and **Effort** selects (+ New, the agent's
 * How it works): the CLI's models by their labels and the chosen model's effort
 * levels by their CLI names. Effort is replaced by a short line saying why when
 * the model has none. Test ids: `<testId>-model`, `<testId>-effort`,
 * `<testId>-effort-none`. The pure part is `model-effort.ts`.
 */
export function ModelEffortSelects({
  field,
  testId,
  disabled = false,
  onModel,
  onEffort,
}: {
  readonly field: ModelEffortField;
  readonly testId: string;
  readonly disabled?: boolean;
  readonly onModel: (value: string) => void;
  readonly onEffort: (value: string) => void;
}) {
  const off = disabled || field.disabled;
  return (
    <div className="v2-model-effort" data-testid={`${testId}-model-effort`}>
      <Select
        label={WORDS.model}
        value={field.model}
        disabled={off}
        title={field.reason ?? undefined}
        hint={field.reason ?? undefined}
        options={field.models}
        onChange={(event) => onModel(event.currentTarget.value)}
        data-testid={`${testId}-model`}
      />
      {field.efforts ? (
        <Select label={WORDS.effort} value={field.effort} disabled={off} options={field.efforts} onChange={(event) => onEffort(event.currentTarget.value)} data-testid={`${testId}-effort`} />
      ) : field.effortReason && !field.disabled ? (
        <p className="v2-field-hint v2-model-effort-none" data-testid={`${testId}-effort-none`}>
          {WORDS.effort}: {field.effortReason}
        </p>
      ) : null}
    </div>
  );
}
