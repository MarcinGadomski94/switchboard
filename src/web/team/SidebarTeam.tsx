import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, useRouter } from '../router.tsx';
import { usePanes } from '../shell/Panes.tsx';
import { teamBadge } from '../shell/nav-grid.ts';
import { NavCell } from '../shell/NavCell.tsx';
import { useTeamSwitch } from './hidden.ts';
import { DEFAULT_TEAM_ID, DEFAULT_TEAM_NAME, type TeamSummary } from '../../core/team.ts';
import { teamApi } from './api.ts';
import { requestMember } from './local.ts';
import { collapsedSummary, rosterGlyph, hasDuration, rosterLine, rosterTitle, untouchedTeams } from './sidebar-roster.ts';
import { sidebarTeamText } from './model.ts';
import { reloadTeam, useTeamData } from './useTeamData.ts';
import './team.css';

/**
 * D100 · the sidebar's Team entries, rendered only while Team is on (nothing at
 * all while it is off, so the sidebar's DOM is the prototype's): the nav grid's **Team**
 * cell (after the others, D101) and, above the SESSIONS list, one **⚑ <team name> · N
 * members** per team in the role colour with its needs-you count.
 */

function useNeedsYouCount(): number {
  const { teams } = useTeamData();
  return teams.reduce((sum, team) => sum + team.needsYou, 0);
}

/** The nav grid's Team cell (D101: a ⚑ icon; only while Team is on): opens the last-used team (`/team`); its badge counts every team's members that need you. */
export function TeamNavItem() {
  const { on } = useTeamSwitch();
  const { route } = useRouter();
  const count = useNeedsYouCount();
  if (!on) return null;
  return <NavCell to={{ view: 'team' }} label="Team" icon="team" badge={teamBadge(count)} active={route.view === 'team'} testId="nav-team" tour="team" />;
}

/** Optimistic folds (the team id → folded, with the change's number) until the read after its save carries them. */
const folds = new Map<string, { readonly folded: boolean; readonly change: number }>();
const foldListeners = new Set<() => void>();
let foldVersion = 0;

function subscribeFolds(listener: () => void): () => void {
  foldListeners.add(listener);
  return () => foldListeners.delete(listener);
}

function foldsChanged(): void {
  foldVersion += 1;
  for (const listener of [...foldListeners]) listener();
}

/** Folds or unfolds a team in the sidebar and saves it (per install); a failed save keeps the page as it is. */
function setFolded(teamId: string, folded: boolean): void {
  const change = foldVersion + 1;
  folds.set(teamId, { folded, change });
  foldsChanged();
  void teamApi
    .sidebar(teamId, folded)
    .then(() => reloadTeam())
    .then(
      () => {
        // The read after the save carries it (unless the developer changed it again meanwhile).
        if (folds.get(teamId)?.change === change) {
          folds.delete(teamId);
          foldsChanged();
        }
      },
      () => undefined,
    );
}

/** Re-renders once a minute while `active` (the rows' durations; never faster). */
function useMinute(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * "⚑ <team name> · N members" above SESSIONS, one per team in the teams' order
 * (D100 follow-up 2026-10-14: multiple teams), each with its needs-you count; only
 * while Team is in use (D132: not for the untouched first team alone, {@link untouchedTeams}). Each opens its team (`/team/{id}`). D100 follow-up 2026-10-16: a
 * ▾ / ▸ chevron folds the team (remembered per install; expanded by default); expanded,
 * its members are listed under it in the team's order, each with its status glyph, its
 * role and a short status line (`sidebar-roster.ts`); a member row opens the member on
 * the Team page, selected, on its chat. Folded, the row adds "2 working · 1 idle".
 */
export function TeamSidebarEntry() {
  const { on } = useTeamSwitch();
  const { route } = useRouter();
  const { teams, loaded } = useTeamData();
  const panes = usePanes();
  useSyncExternalStore(subscribeFolds, () => foldVersion, () => 0);
  // Before the first read: the first team as it was (no jump when the list lands).
  const shown: readonly TeamSummary[] = loaded || teams.length > 0 ? teams : [{ id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME, order: 0, members: 0, needsYou: 0 }];
  const foldedOf = (team: TeamSummary): boolean => folds.get(team.id)?.folded ?? team.collapsed ?? false;
  const listed = shown.flatMap((team) => (foldedOf(team) ? [] : (team.roster ?? [])));
  const now = useMinute(on && hasDuration(listed));
  // D132 (Team graduated, no switch): an install that never used Team (only the first team, as made, without members) shows nothing above SESSIONS, as before.
  if (!on || untouchedTeams(teams)) return null;
  const currentId = route.view === 'team' ? route.teamId : undefined;
  const openMember = (memberId: string): void => {
    requestMember(memberId);
    // D74: the drawer closes (a link to the page already shown changes no path).
    if (panes.compact) panes.setHidden('sidebar', true);
  };
  return (
    <div className="sb-team-entries" data-testid="sidebar-teams">
      {shown.map((team, index) => {
        const folded = foldedOf(team);
        const roster = team.roster ?? [];
        const listId = `sb-team-members-${team.id}`;
        const summary = folded ? collapsedSummary(roster) : '';
        return (
          <div key={team.id} className="sb-team-group" data-testid="sidebar-team-group" data-team-id={team.id} data-collapsed={folded ? 'true' : undefined}>
            <div className="sb-team-entry-row">
              <button
                type="button"
                className="sb-team-entry-toggle"
                data-testid="sidebar-team-toggle"
                aria-expanded={!folded}
                aria-controls={listId}
                aria-label={`${folded ? 'Show' : 'Hide'} the members of ${team.name}`}
                onClick={() => setFolded(team.id, !folded)}
              >
                <span aria-hidden="true">{folded ? '▸' : '▾'}</span>
              </button>
              <Link
                to={{ view: 'team', teamId: team.id }}
                className="sb-team-entry"
                data-testid="sidebar-team"
                data-team-id={team.id}
                // The first entry (the first team may have been deleted, D100 follow-up 2026-10-14).
                data-tour={index === 0 ? 'sidebar-team' : undefined}
                aria-current={currentId === team.id ? 'page' : undefined}
              >
                <span className="sb-team-entry__flag" aria-hidden="true">
                  ⚑
                </span>
                <span className="sb-team-entry__text">{sidebarTeamText(team.name, team.members)}</span>
                {summary ? (
                  <span className="sb-team-entry__summary" data-testid="sidebar-team-summary">
                    {summary}
                  </span>
                ) : null}
                {team.needsYou ? (
                  <span className="sb-team-entry__need" data-testid="sidebar-team-need" title={`${team.needsYou} need${team.needsYou === 1 ? 's' : ''} you`}>
                    {team.needsYou}
                  </span>
                ) : null}
              </Link>
            </div>
            <div className="sb-team-members" id={listId} data-testid="sidebar-team-members" hidden={folded}>
              {folded
                ? null
                : roster.map((member) => (
                    <Link
                      key={member.id}
                      to={{ view: 'team', teamId: team.id }}
                      className="sb-team-member-row"
                      data-testid="sidebar-team-member"
                      data-member-id={member.id}
                      data-status={member.status}
                      data-subagents={member.subagents ? String(member.subagents) : undefined}
                      data-waiting-on={member.waitingOn ?? undefined}
                      title={rosterTitle(member)}
                      onClick={() => openMember(member.id)}
                    >
                      <span className="sb-team-member-row__glyph" data-testid="sidebar-team-member-glyph" aria-hidden="true">
                        {rosterGlyph(member)}
                      </span>
                      <span className="sb-team-member-row__name">{member.name}</span>
                      <span className="sb-team-member-row__line" data-testid="sidebar-team-member-line">
                        {rosterLine(member, now)}
                      </span>
                    </Link>
                  ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
