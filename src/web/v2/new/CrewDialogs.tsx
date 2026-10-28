import type { TeamSummary } from '../../../core/team.ts';
import { useApi } from '../../api/useApi.ts';
import { teamApi } from '../../team/api.ts';
import { reloadTeam } from '../../team/useTeamData.ts';
import { useToast } from '../components/index.ts';
import { NewCrewDialog, NewTeammateDialog } from '../crews/index.tsx';
import { NEW_WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import type { CrewKindId } from './new-model.ts';

/**
 * D131 · lane X · + New › Teammate and + New › Crew are the Crews dialogs (lane P's
 * `NewTeammateDialog` / `NewCrewDialog`: role templates, suggestions, adopting an existing agent,
 * budget, hand-offs), so there is one New teammate and one New crew. `openNew({ kind: 'teammate' |
 * 'crew' })` lands here; a made one opens its crew, with the + New sheet's toast.
 */
export function NewCrewDialogs({ kind, onClose }: { readonly kind: CrewKindId; readonly onClose: () => void }) {
  const toast = useToast();
  const { navigate } = useV2Router();
  const teams = useApi((): Promise<TeamSummary[]> => (kind === 'teammate' ? teamApi.teams().catch(() => []) : Promise.resolve([])), [kind]);
  const done = (text: string, crewId: string): void => {
    onClose();
    void reloadTeam();
    navigate(`/crews/${encodeURIComponent(crewId)}`);
    toast({ text });
  };
  if (kind === 'crew') return <NewCrewDialog onClose={onClose} onCreated={(crew) => done(NEW_WORDS.crewMade(crew.name), crew.id)} />;
  // The teammate dialog picks its crew from the list: wait for it (the dialog's crew starts on the first).
  if (teams.data === null) return null;
  return <NewTeammateDialog crews={teams.data} crewId={null} onClose={onClose} onCreated={(member) => done(NEW_WORDS.teammateMade(member.name), member.teamId)} />;
}
