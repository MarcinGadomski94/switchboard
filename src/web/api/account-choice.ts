import { useCallback, useEffect, useState } from 'react';
import type { AccountsOverview } from '../../core/api.ts';
import { type CliAccountChoice, accountChoiceRows } from './account-choice-rows.ts';
import { accountsApi } from './client.ts';
import { useHubEvent } from './useHub.ts';
import { useThrottled } from './useThrottled.ts';

export { type CliAccountChoice, accountChoiceRows } from './account-choice-rows.ts';

/** D138: this computer's accounts for the picker, live (`accountChoiceChanged`, and the `system` readings, throttled). */
export function useAccountChoices(active = true): { readonly overview: AccountsOverview | null; readonly rows: CliAccountChoice[]; readonly reload: () => void } {
  const [overview, setOverview] = useState<AccountsOverview | null>(null);
  const load = useCallback(() => {
    if (!active) return;
    accountsApi(null)
      .overview(false)
      .then(setOverview)
      .catch(() => undefined);
  }, [active]);
  useEffect(() => load(), [load]);
  const throttled = useThrottled(load, 1_000);
  useHubEvent('accountChoiceChanged', () => load());
  useHubEvent('system', () => throttled());
  return { overview, rows: accountChoiceRows(overview), reload: load };
}
