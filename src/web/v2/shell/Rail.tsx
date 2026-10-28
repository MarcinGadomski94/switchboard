import { useMemo } from 'react';
import { Icon, StatusBadge } from '../components/index.ts';
import { RAIL_LABELS, STATUS, WORDS, railTasksLabel, sessionStatusToV2 } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { RAIL_AREAS, type RailArea, type V2Route, railAreaOf } from '../routes.ts';
import { RecentList } from '../shared/RecentList.tsx';
import { agentDisplayName, useTeamMembers } from '../shared/teammates.ts';
import type { StatusPill } from './status-model.ts';
import { PinnedCrew } from './PinnedCrew.tsx';
import { type RailCounts, usePhones, usePinned, useUnfinishedTaskCount } from './useShellData.ts';

const ICONS: Readonly<Record<RailArea, string>> = { home: 'home', agents: 'agents', projects: 'projects', crews: 'crew', results: 'results', tasks: 'task', settings: 'settings' };
const TARGETS: Readonly<Record<RailArea, V2Route>> = {
  home: { area: 'home' },
  agents: { area: 'agents' },
  projects: { area: 'projects' },
  crews: { area: 'crews' },
  results: { area: 'results' },
  tasks: { area: 'tasks' },
  settings: { area: 'settings', section: null, sub: null },
};

/**
 * D131 · the left rail (the prototype's `.rail`): the brand, seven labelled items
 * (Home · Agents · Projects · Crews · Results · Tasks · Settings), each with its "needs
 * you" count (Tasks: its tasks not done yet; fix after 2.0), the Pinned list (the shared sidebar layout's pins, D71:
 * agents and, 2.4.4, crews with their teammates) and the
 * computers and phones at its foot. ≤ 1279 px it narrows to icons with their
 * labels under them and the pins and foot hide (the prototype's tablet rail).
 */
export function Rail({ route, counts, pill }: { readonly route: V2Route; readonly counts: RailCounts; readonly pill: StatusPill }) {
  const current = railAreaOf(route);
  const pins = usePinned();
  const members = useTeamMembers();
  const pinnedIds = useMemo(() => pins.filter((entry) => entry.kind === 'agent').map((entry) => entry.id), [pins]);
  const phones = usePhones();
  const unfinished = useUnfinishedTaskCount();
  const badge = (area: RailArea): number => (area === 'home' || area === 'agents' || area === 'projects' || area === 'crews' ? counts[area] : area === 'tasks' ? unfinished : 0);
  const label = (area: RailArea, count: number): string => {
    if (count <= 0) return RAIL_LABELS[area];
    return area === 'tasks' ? railTasksLabel(count) : `${RAIL_LABELS[area]}, ${count} need${count === 1 ? 's' : ''} you`;
  };
  return (
    <nav className="v2-rail" aria-label="Main" data-testid="v2-rail">
      <div className="v2-brand">
        <div className="v2-brand-mark" aria-hidden="true">
          <Icon name="sparkle" size="s" />
        </div>
        <span>Switchboard</span>
      </div>
      {RAIL_AREAS.map((area) => {
        const count = badge(area);
        return (
          <V2Link key={area} to={TARGETS[area]} className="v2-nav-item" aria-current={current === area ? 'page' : undefined} data-testid={`v2-nav-${area}`} data-tour={`v2-nav-${area}`} aria-label={label(area, count)}>
            <Icon name={ICONS[area]} />
            <span className="v2-nav-label">{RAIL_LABELS[area]}</span>
            {count > 0 ? (
              <span className="v2-nav-badge" aria-hidden="true" data-testid={`v2-nav-badge-${area}`}>
                {count}
              </span>
            ) : null}
          </V2Link>
        );
      })}
      <div className="v2-rail-pins" aria-label={WORDS.pinned} role="group" data-testid="v2-rail-pins">
        <h5>
          <Icon name="pin" size="s" />
          {WORDS.pinned}
        </h5>
        {pins.map((entry) => {
          if (entry.kind === 'crew') return <PinnedCrew key={entry.id} crew={entry.crew} route={route} />;
          const session = entry.session;
          const status = sessionStatusToV2(session.status);
          const name = agentDisplayName(session, members);
          return (
            <V2Link key={session.id} to={{ area: 'agent', id: session.id, tab: 'chat' }} className="v2-pin-item" title={`${name} · ${STATUS[status].label}`} aria-current={route.area === 'agent' && route.id === session.id ? 'page' : undefined}>
              <StatusBadge status={status} compact />
              <span className="v2-pin-name">{name}</span>
            </V2Link>
          );
        })}
        {pins.length === 0 ? <p className="v2-rail-note">{WORDS.pinnedHint}</p> : null}
      </div>
      <RecentList pinned={pinnedIds} currentId={route.area === 'agent' ? route.id : null} />
      <div className="v2-rail-foot" data-testid="v2-rail-foot">
        {pill.computerRows.map((row) => (
          <div key={row.id ?? 'self'} className="v2-row" data-state={row.state}>
            <Icon name={row.state === 'offline' ? 'offline' : row.state === 'reconnecting' ? 'refresh' : row.self ? 'laptop' : 'desktop'} size="s" />
            <span className="v2-pin-name">
              {row.name}
              {row.self ? '' : ` · ${STATUS[row.state].label.toLowerCase()}`}
            </span>
          </div>
        ))}
        {phones.map((phone) => (
          <div key={phone.id} className="v2-row">
            <Icon name="phone" size="s" />
            <span className="v2-pin-name">{phone.name} · paired</span>
          </div>
        ))}
      </div>
    </nav>
  );
}
