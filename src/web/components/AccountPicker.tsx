import type { CliProviderId } from '../../core/cli-providers.ts';
import { machineApi } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { exhaustedText } from '../views/settings/accounts.ts';

/**
 * D63: the account a new session starts on (`docs/accounts.md`), next to the CLI
 * choice. Shown only when the CLI has more than one enabled account; "automatic"
 * (the default) lets Settings → Accounts decide (the first account with allowance).
 * A spent account stays listed, marked, so it can still be picked on purpose.
 */
export function AccountPicker({
  machine,
  provider,
  value,
  onPick,
  testId,
  disabled = false,
}: {
  readonly machine: string | null;
  readonly provider: CliProviderId;
  readonly value: string | null;
  readonly onPick: (profileId: string | null) => void;
  readonly testId: string;
  readonly disabled?: boolean;
}) {
  const overview = useApi(() => machineApi(machine).accounts().catch(() => null), [machine]);
  const profiles = (overview.data?.profiles ?? []).filter((p) => p.cli === provider && p.enabled);
  if (profiles.length < 2) return null;
  const shown = profiles.some((p) => p.id === value) ? value : null;
  // D139: an account that needs the developer can still be picked on purpose, with a warning.
  const picked = profiles.find((p) => p.id === shown);
  const select = (
    <select className="sb-cli-picker" data-testid={testId} aria-label="Account" value={shown ?? ''} disabled={disabled} onChange={(event) => onPick(event.target.value === '' ? null : event.target.value)}>
      <option value="">Account: automatic</option>
      {profiles.map((profile) => (
        <option key={profile.id} value={profile.id} title={exhaustedText(profile) ?? undefined}>
          {profile.name}
          {profile.needsYou ? ' (needs you)' : profile.exhausted ? ' (out of usage)' : ''}
        </option>
      ))}
    </select>
  );
  if (!picked?.needsYou) return select;
  return (
    <>
      {select}
      <span className="sb-account-picker-warning" role="note" data-testid={`${testId}-needs-you`}>
        {picked.name} needs you: {picked.needsYou.text} The agent may stop at once until that is done.
      </span>
    </>
  );
}
