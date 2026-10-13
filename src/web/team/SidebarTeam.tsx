import { Link, useRouter } from '../router.tsx';
import { useTeamSwitch } from './hidden.ts';
import { DEFAULT_TEAM_ID, DEFAULT_TEAM_NAME } from '../../core/team.ts';
import { sidebarTeamText } from './model.ts';
import { useTeamData } from './useTeamData.ts';
import './team.css';

/**
 * D100 · the sidebar's Team entries, rendered only while Team is on (nothing at
 * all while it is off, so the sidebar's DOM is the prototype's): the nav's **Team**
 * item (after the others) and, above the SESSIONS list, one **⚑ <team name> · N
 * members** per team in the role colour with its needs-you count.
 */

function useNeedsYouCount(): number {
  const { teams } = useTeamData();
  return teams.reduce((sum, team) => sum + team.needsYou, 0);
}

/** The nav's Team item (only while Team is on): opens the last-used team (`/team`); its badge counts every team's members that need you. */
export function TeamNavItem() {
  const { on } = useTeamSwitch();
  const { route } = useRouter();
  const count = useNeedsYouCount();
  if (!on) return null;
  return (
    <Link to={{ view: 'team' }} className="sb-nav-item" data-testid="nav-team" data-tour="team" aria-current={route.view === 'team' ? 'page' : undefined}>
      <span>Team</span>
      <span className="sb-badge" data-kind={count ? 'need' : undefined}>
        {count ? String(count) : ''}
      </span>
    </Link>
  );
}

/**
 * "⚑ <team name> · N members" above SESSIONS, one per team in the teams' order
 * (D100 follow-up 2026-10-14: multiple teams), each with its needs-you count; only
 * while Team is on. Each opens its team (`/team/{id}`).
 */
export function TeamSidebarEntry() {
  const { on } = useTeamSwitch();
  const { route } = useRouter();
  const { teams, loaded } = useTeamData();
  if (!on) return null;
  // Before the first read: the first team as it was (no jump when the list lands).
  const shown = loaded || teams.length > 0 ? teams : [{ id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME, order: 0, members: 0, needsYou: 0 }];
  const currentId = route.view === 'team' ? route.teamId : undefined;
  return (
    <div className="sb-team-entries" data-testid="sidebar-teams">
      {shown.map((team) => (
        <Link
          key={team.id}
          to={{ view: 'team', teamId: team.id }}
          className="sb-team-entry"
          data-testid="sidebar-team"
          data-team-id={team.id}
          data-tour={team.id === DEFAULT_TEAM_ID ? 'sidebar-team' : undefined}
          aria-current={currentId === team.id ? 'page' : undefined}
        >
          <span className="sb-team-entry__flag" aria-hidden="true">
            ⚑
          </span>
          <span className="sb-team-entry__text">{sidebarTeamText(team.name, team.members)}</span>
          {team.needsYou ? (
            <span className="sb-team-entry__need" data-testid="sidebar-team-need" title={`${team.needsYou} need${team.needsYou === 1 ? 's' : ''} you`}>
              {team.needsYou}
            </span>
          ) : null}
        </Link>
      ))}
    </div>
  );
}
