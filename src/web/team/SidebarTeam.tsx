import { Link, useRouter } from '../router.tsx';
import { useTeamSwitch } from './hidden.ts';
import { needsYouCounts, needsYou, sidebarTeamText } from './model.ts';
import { useTeamData } from './useTeamData.ts';
import './team.css';

/**
 * D100 · the sidebar's two Team entries, rendered only while Team is on (nothing at
 * all while it is off, so the sidebar's DOM is the prototype's): the nav's **Team**
 * item (after the others) and, above the SESSIONS list, **⚑ Team · <name> · N
 * members** in the role colour with the needs-you count.
 */

function useNeedsYouCount(): number {
  const { view, needsYou: items } = useTeamData();
  if (!view) return 0;
  const counts = needsYouCounts(items);
  return view.members.filter((member) => needsYou(member, counts)).length;
}

/** The nav's Team item (only while Team is on). */
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

/** "⚑ Team · N members" (with the name once renamed: "⚑ Team · <name> · N members") above SESSIONS, only while Team is on. */
export function TeamSidebarEntry() {
  const { on } = useTeamSwitch();
  const { route } = useRouter();
  const { view } = useTeamData();
  const count = useNeedsYouCount();
  if (!on) return null;
  const name = view?.team.name ?? 'Team';
  const members = view?.members.length ?? 0;
  return (
    <Link to={{ view: 'team' }} className="sb-team-entry" data-testid="sidebar-team" data-tour="sidebar-team" aria-current={route.view === 'team' ? 'page' : undefined}>
      <span className="sb-team-entry__flag" aria-hidden="true">
        ⚑
      </span>
      <span className="sb-team-entry__text">
        {sidebarTeamText(name, members)}
      </span>
      {count ? (
        <span className="sb-team-entry__need" data-testid="sidebar-team-need" title={`${count} need${count === 1 ? 's' : ''} you`}>
          {count}
        </span>
      ) : null}
    </Link>
  );
}
