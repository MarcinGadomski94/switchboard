import type { CliOverview } from '../../core/api.ts';
import type { CliProviderId } from '../../core/cli-providers.ts';
import { cliChoices } from './cli.ts';
import './cli-picker.css';

/**
 * D62: a CLI choice (Claude Code / Codex CLI / OpenCode). A CLI that cannot be
 * chosen is listed disabled with its state ("not installed") and its reason as
 * the tooltip, never left out.
 */
export function CliPicker({
  value,
  overview,
  onPick,
  testId,
  disabled = false,
  label = 'CLI',
}: {
  readonly value: CliProviderId;
  readonly overview: CliOverview | null;
  readonly onPick: (provider: CliProviderId) => void;
  readonly testId: string;
  readonly disabled?: boolean;
  readonly label?: string;
}) {
  const choices = cliChoices(overview);
  const current = choices.find((choice) => choice.provider === value);
  return (
    <select
      className="sb-cli-picker"
      data-testid={testId}
      aria-label={label}
      value={value}
      disabled={disabled}
      title={current?.reason ?? undefined}
      onChange={(event) => onPick(event.target.value as CliProviderId)}
    >
      {choices.map((choice) => (
        <option key={choice.provider} value={choice.provider} disabled={choice.disabled && choice.provider !== value} title={choice.reason ?? undefined} data-testid={`${testId}-option`}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}
