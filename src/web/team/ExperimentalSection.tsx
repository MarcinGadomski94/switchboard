import { useState } from 'react';
import type { KnownSettings } from '../../core/settings.ts';
import { Row, SectionTitle, ToggleValue } from '../views/settings/rows.tsx';
import type { SaveSettings } from '../views/settings/sections.tsx';

/**
 * D100 · Settings → Experimental (`docs/team.md` → *The switch*): features that can be
 * switched off and removed again. **Team** is off by default; while off Switchboard
 * behaves exactly as without it. Switching it off returns every member's session to
 * the sessions list in its place; switching it on again re-hides them.
 */
export function ExperimentalSection({ settings, save }: { readonly settings: KnownSettings; readonly save: SaveSettings }) {
  const [busy, setBusy] = useState(false);
  const on = settings['experimental.team'];
  return (
    <>
      <SectionTitle>Experimental</SectionTitle>
      <Row
        id="experimental-team"
        label="Team"
        description="Run a set of role agents (members) from one page. Members' sessions leave the sessions list while this is on; switching it off puts them all back."
      >
        <ToggleValue
          label="Team"
          value={on}
          disabled={busy}
          onToggle={() => {
            setBusy(true);
            void save({ 'experimental.team': !on }).finally(() => setBusy(false));
          }}
        />
      </Row>
    </>
  );
}
