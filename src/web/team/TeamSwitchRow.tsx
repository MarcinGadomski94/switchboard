import { useState } from 'react';
import type { KnownSettings } from '../../core/settings.ts';
import { Row, ToggleValue } from '../views/settings/rows.tsx';
import type { SaveSettings } from '../views/settings/sections.tsx';
import { reloadTeamSwitch } from './hidden.ts';

/**
 * D100 · Settings → Experimental → **Team** (`docs/team.md` → *The switch*). Off by default;
 * while off Switchboard behaves exactly as without it. Switching it off returns every
 * member's session to the sessions list in its place; switching it on again re-hides them.
 * Rendered by the shared Experimental section (`views/settings/ExperimentalSection.tsx`).
 */
export function TeamSwitchRow({ settings, save }: { readonly settings: KnownSettings; readonly save: SaveSettings }) {
  const [busy, setBusy] = useState(false);
  const on = settings['experimental.team'];
  return (
    <Row
      id="experimental-team"
      label="Team"
      tour="experimental-team"
      description="Run a set of role agents (members) from one page. Off: no Team page, no background work, and every team member goes back to the session list."
    >
      <ToggleValue
        label="Team"
        value={on}
        disabled={busy}
        onToggle={() => {
          setBusy(true);
          void save({ 'experimental.team': !on })
            .then(() => reloadTeamSwitch())
            .finally(() => setBusy(false));
        }}
      />
    </Row>
  );
}
