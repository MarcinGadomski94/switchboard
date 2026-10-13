import type { KnownSettings } from '../../../core/settings.ts';
// Team (D100) hook (docs/team-removal.md).
import { TeamSwitchRow } from '../../team/TeamSwitchRow.tsx';
// Plans (D99) hook (docs/plans-removal.md).
import { PlansSwitchRow } from '../../plans/PlansSwitchRow.tsx';
import { SectionTitle } from './rows.tsx';
import type { SaveSettings } from './sections.tsx';

/**
 * Settings → Experimental: features that can be switched off and removed again, each off by
 * default and owned by its feature (D100 Team, `docs/team.md`; D99 Plans, `docs/plans.md`).
 * When the last of them is removed, this section goes too (`docs/team-removal.md`,
 * `docs/plans-removal.md`).
 */
export function ExperimentalSection({ settings, save }: { readonly settings: KnownSettings; readonly save: SaveSettings }) {
  return (
    <>
      <SectionTitle>Experimental</SectionTitle>
      {/* Team (D100) hook. */}
      <TeamSwitchRow settings={settings} save={save} />
      {/* Plans (D99) hook. */}
      <PlansSwitchRow settings={settings} save={save} />
    </>
  );
}
