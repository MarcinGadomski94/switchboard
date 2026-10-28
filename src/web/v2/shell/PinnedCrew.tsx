import { type KeyboardEvent, useSyncExternalStore } from 'react';
import { Icon, StatusBadge } from '../components/index.ts';
import { CREW_WORDS, STATUS } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { crewInitials } from '../crews/crew-model.ts';
import { type PinnedCrew as PinnedCrewData, OPEN_CREWS_KEY, pinnedCrewLabel, pinnedCrewLine, readOpenCrews, setCrewOpen } from '../shared/pinned-model.ts';
import type { V2Route } from '../routes.ts';

/**
 * Fix after 2.0 (2.4.4) · which pinned crews this browser shows expanded
 * (`localStorage['switchboard.v2.rail.openCrews']`; collapsed by default).
 */
let openCrews: readonly string[] | null = null;
const listeners = new Set<() => void>();

function readStored(): readonly string[] {
  if (openCrews === null) {
    try {
      openCrews = readOpenCrews(window.localStorage.getItem(OPEN_CREWS_KEY));
    } catch {
      openCrews = [];
    }
  }
  return openCrews;
}

function setOpen(teamId: string, value: boolean): void {
  openCrews = setCrewOpen(readStored(), teamId, value);
  try {
    window.localStorage.setItem(OPEN_CREWS_KEY, JSON.stringify(openCrews));
  } catch {
    // No storage: it stays open for this page only.
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const NONE: readonly string[] = [];

/**
 * A pinned crew in the rail's Pinned list: its row (initials, name, how many work, its
 * Needs-you count) opens the crew page; the chevron (a disclosure button) shows its
 * teammates, each a row that opens its agent. Archived teammates are left out, with
 * "1 archived" (D137 follow-up, option B).
 */
export function PinnedCrew({ crew, route }: { readonly crew: PinnedCrewData; readonly route: V2Route }) {
  const open = useSyncExternalStore(subscribe, readStored, () => NONE).includes(crew.teamId);
  const listId = `v2-pin-crew-${crew.teamId}`;
  const line = pinnedCrewLine(crew);
  const onKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowRight' && !open) {
      event.preventDefault();
      setOpen(crew.teamId, true);
    } else if (event.key === 'ArrowLeft' && open) {
      event.preventDefault();
      setOpen(crew.teamId, false);
    }
  };
  return (
    <div className="v2-pin-crew" data-testid="v2-pin-crew" data-crew={crew.teamId} data-open={open || undefined}>
      <div className="v2-pin-crew-row">
        <V2Link to={{ area: 'crew', id: crew.teamId }} className="v2-pin-item v2-pin-crew-link" aria-label={pinnedCrewLabel(crew)} title={crew.name} aria-current={route.area === 'crew' && route.id === crew.teamId ? 'page' : undefined} data-testid="v2-pin-crew-link">
          <span className="v2-pin-crew-av" aria-hidden="true">
            {crewInitials(crew.name)}
          </span>
          <span className="v2-pin-name">{crew.name}</span>
          {line ? (
            <span className="v2-pin-crew-line" aria-hidden="true">
              {line}
            </span>
          ) : null}
          {crew.needs > 0 ? (
            <span className="v2-nav-badge" aria-hidden="true" data-testid="v2-pin-crew-needs">
              {crew.needs}
            </span>
          ) : null}
        </V2Link>
        <button type="button" className="v2-pin-chev" aria-expanded={open} aria-controls={listId} aria-label={open ? CREW_WORDS.hideTeammates(crew.name) : CREW_WORDS.showTeammates(crew.name)} onClick={() => setOpen(crew.teamId, !open)} onKeyDown={onKey} data-testid="v2-pin-crew-toggle">
          <Icon name="chev" size="s" />
        </button>
      </div>
      {open ? (
        <div id={listId} className="v2-pin-mates" role="group" aria-label={`${crew.name} teammates`} data-testid="v2-pin-crew-mates">
          {crew.mates.map((mate) => (
            <V2Link key={mate.id} to={{ area: 'agent', id: mate.sessionRef, tab: 'chat' }} className="v2-pin-item v2-pin-mate" title={`${mate.name} · ${STATUS[mate.status].label}`} aria-current={route.area === 'agent' && route.id === mate.sessionRef ? 'page' : undefined} data-testid="v2-pin-mate" data-session={mate.sessionRef}>
              <StatusBadge status={mate.status} compact />
              <span className="v2-pin-name">{mate.name}</span>
              {mate.needs > 0 ? (
                <span className="v2-nav-badge" aria-label={`${mate.needs} need${mate.needs === 1 ? 's' : ''} you`}>
                  {mate.needs}
                </span>
              ) : null}
            </V2Link>
          ))}
          {crew.mates.length === 0 && crew.archived === 0 ? <p className="v2-rail-note v2-pin-mates-note">{CREW_WORDS.noShownTeammates}</p> : null}
          {crew.archived > 0 ? (
            <p className="v2-rail-note v2-pin-mates-note" data-testid="v2-pin-crew-archived">
              {CREW_WORDS.archivedShort(crew.archived)}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
