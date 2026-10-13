import { useState } from 'react';
import type { KnownSettings } from '../../core/settings.ts';
import { Row, ToggleValue } from '../views/settings/rows.tsx';
import type { SaveSettings } from '../views/settings/sections.tsx';

/**
 * D99 · Settings → Experimental → **Plans** (`docs/plans.md` → *The switch*). Off by default;
 * while off Switchboard behaves exactly as without it (no `plans.db`, no scheduler, no plan
 * tools for agents). Switching it off pauses every running plan ("Plans was switched off");
 * switched on again they show paused until the developer resumes them.
 * Rendered by the shared Experimental section (`views/settings/ExperimentalSection.tsx`).
 */
export function PlansSwitchRow({ settings, save }: { readonly settings: KnownSettings; readonly save: SaveSettings }) {
  const [busy, setBusy] = useState(false);
  const on = settings['experimental.plans'];
  return (
    <Row
      id="experimental-plans"
      label="Plans"
      description="Run a group of todos in dependency order, several at once, each merged into an epic branch. Off: no background work and no plan tools for agents; running plans are paused."
    >
      <ToggleValue
        label="Plans"
        value={on}
        disabled={busy}
        onToggle={() => {
          setBusy(true);
          void save({ 'experimental.plans': !on }).finally(() => setBusy(false));
        }}
      />
    </Row>
  );
}
