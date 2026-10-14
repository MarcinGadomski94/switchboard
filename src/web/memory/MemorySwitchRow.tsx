import { useState } from 'react';
import type { KnownSettings } from '../../core/settings.ts';
import { Row, ToggleValue } from '../views/settings/rows.tsx';
import type { SaveSettings } from '../views/settings/sections.tsx';
import { reloadMemory } from './store.ts';

/**
 * D107 · Settings → Experimental → **Project memory** (`docs/memory.md` → *The switch*). Off by
 * default; while off Switchboard behaves exactly as without it (no `memory.db`, no memory tools
 * for agents, no memory block in any session). Rendered by the shared Experimental section.
 */
export function MemorySwitchRow({ settings, save }: { readonly settings: KnownSettings; readonly save: SaveSettings }) {
  const [busy, setBusy] = useState(false);
  const on = settings['experimental.memory'];
  return (
    <Row
      id="experimental-memory"
      label="Project memory"
      tour="experimental-memory"
      description="Agents propose durable facts about a project; you approve them, and approved ones reach every session in that folder. Off: no memory tools for agents and no memory in any session."
    >
      <ToggleValue
        label="Project memory"
        value={on}
        disabled={busy}
        onToggle={() => {
          setBusy(true);
          void save({ 'experimental.memory': !on })
            .then(() => reloadMemory())
            .finally(() => setBusy(false));
        }}
      />
    </Row>
  );
}
