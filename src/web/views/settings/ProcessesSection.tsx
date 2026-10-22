import { useState } from 'react';
import { IDLE_STOP_MAX_MINUTES, IDLE_STOP_MIN_MINUTES } from '../../../core/processes.ts';
import type { KnownSettings } from '../../../core/settings.ts';
import { ProcessesOverviewList } from '../../processes/ProcessList.tsx';
import { Row, SectionTitle, Value } from './rows.tsx';
import type { SaveSettings } from './sections.tsx';

/** The idle delays offered (minutes; 0 = off); a stored value outside them is kept as an option. */
const CHOICES = [0, 5, 10, 15, 30, 60, 120, 240];

function options(value: number): number[] {
  const list = CHOICES.filter((n) => n >= IDLE_STOP_MIN_MINUTES && n <= IDLE_STOP_MAX_MINUTES);
  return list.includes(value) ? list : [...list, value].sort((a, b) => a - b);
}

/**
 * D127 · Settings → **Processes** (`docs/processes.md`, `docs/settings.md`): the idle stop's
 * delay, then every session's processes (this machine's and each paired machine's) with their
 * totals, Stop and Keep.
 */
export function ProcessesSection({ settings, save }: { readonly settings: KnownSettings; readonly save: SaveSettings }) {
  const [busy, setBusy] = useState(false);
  const value = settings['processes.idleStopMinutes'];
  return (
    <>
      <SectionTitle>Processes</SectionTitle>
      <Row
        id="processes-idle-stop"
        label="Stop leftovers when idle"
        description="What a session's agent left running (.NET build servers, test hosts, dev servers) is stopped once the session has been idle this long (its turn over, no subagents, nothing it waits on), and at once when it is closed. Processes marked Keep stay"
      >
        <select
          className="sb-set-select"
          data-testid="setting-processes.idleStopMinutes"
          aria-label="Stop leftovers when idle"
          value={value}
          disabled={busy}
          onChange={(event) => {
            setBusy(true);
            void save({ 'processes.idleStopMinutes': Number(event.target.value) }).finally(() => setBusy(false));
          }}
        >
          {options(value).map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'never (only when closed)' : `after ${n} min idle`}
            </option>
          ))}
        </select>
      </Row>
      <Row
        id="processes-build-defaults"
        label=".NET build servers"
        description="The CLIs Switchboard starts get MSBUILDDISABLENODEREUSE=1, DOTNET_CLI_USE_MSBUILD_SERVER=0 and UseSharedCompilation=false, so no MSBuild node or VBCSCompiler outlives an agent's build. Those builds are a little slower; your own terminals and IDE are not affected"
      >
        <Value>on for agent sessions</Value>
      </Row>
      <ProcessesOverviewList />
    </>
  );
}
