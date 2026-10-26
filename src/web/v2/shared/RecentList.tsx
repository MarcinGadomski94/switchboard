import { useMemo, useState } from 'react';
import type { SessionListItem } from '../../../core/api.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { Icon, IconButton, Menu, StatusBadge } from '../components/index.ts';
import { STATUS, WORDS } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { AgentComputerTag, CrewTag } from './agent-row.tsx';
import { agentStatusOf } from './agent-line.ts';
import { useNeedsYou } from './needs-you.ts';
import { RECENT_OPEN_KEY, clearRecent, recentAgents, useRecentMarks } from './recent.ts';
import { agentDisplayName, teammateOf, useTeamMembers } from './teammates.ts';

/** The Recent agents (open, not pinned, newest first), live. */
export function useRecentAgents(pinned: readonly string[]): readonly SessionListItem[] {
  const marks = useRecentMarks();
  const sessions = useSessionListOf();
  return useMemo(() => recentAgents(marks, sessions.data ?? [], pinned), [marks, sessions.data, pinned]);
}

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(RECENT_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * Fix after 2.0 · the rail's **Recent** (under Pinned) and the phone More tab's:
 * the last 5 agents or conversations the developer interacted with, each with its
 * status (icon; the word in the tooltip), its name (a teammate's name with its
 * crew), a paired computer's tag and a Needs-you count; a click opens it. The
 * header folds the list (remembered) and its ⋯ clears it.
 */
export function RecentList({ pinned, currentId, variant = 'rail' }: { readonly pinned: readonly string[]; readonly currentId: string | null; readonly variant?: 'rail' | 'phone' }) {
  const agents = useRecentAgents(pinned);
  const members = useTeamMembers();
  const { items } = useNeedsYou();
  const [open, setOpen] = useState(readOpen);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState(false);
  const needsOf = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const id = item.agent?.sessionId;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [items]);
  const toggle = (): void => {
    setOpen((v) => {
      try {
        window.localStorage.setItem(RECENT_OPEN_KEY, v ? '0' : '1');
      } catch {
        // No storage: the choice lasts until the page closes.
      }
      return !v;
    });
  };
  if (agents.length === 0) return null;
  return (
    <div className={variant === 'rail' ? 'v2-rail-pins v2-rail-recent' : 'v2-recent-phone'} role="group" aria-label={WORDS.recent} data-testid="v2-recent">
      <h5 className="v2-recent-head">
        <button type="button" className="v2-recent-toggle" aria-expanded={open} onClick={toggle} data-testid="v2-recent-toggle">
          <Icon name="clock" size="s" />
          {WORDS.recent}
          <Icon name="chev" size="s" className="v2-recent-chev" />
        </button>
        <IconButton ref={setAnchor} icon="more" label={WORDS.recentActions} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} data-testid="v2-recent-menu" />
        <Menu items={[{ id: 'clear', label: WORDS.clearRecent, icon: 'x', onSelect: clearRecent }]} anchor={anchor} open={menu} onClose={() => setMenu(false)} label={WORDS.recentActions} testId="v2-recent-menu-list" />
      </h5>
      {open
        ? agents.map((session) => {
            const status = agentStatusOf(session);
            const name = agentDisplayName(session, members);
            const mate = teammateOf(session.id, members);
            const needs = needsOf.get(session.id) ?? 0;
            return (
              <V2Link key={session.id} to={{ area: 'agent', id: session.id, tab: 'chat' }} className="v2-pin-item v2-recent-item" title={`${name}${mate ? ` · ${mate.crewName}` : ''} · ${STATUS[status].label}`} aria-current={currentId === session.id ? 'page' : undefined} data-testid="v2-recent-item" data-session={session.id}>
                <StatusBadge status={status} compact />
                <span className="v2-pin-name">
                  {name}
                  {mate ? <CrewTag crew={mate.crewName} /> : null}
                </span>
                {session.machine ? <AgentComputerTag machine={session.machine} short /> : null}
                {needs > 0 ? (
                  <span className="v2-nav-badge" title={WORDS.needsYou} data-testid="v2-recent-needs">
                    {needs}
                  </span>
                ) : null}
              </V2Link>
            );
          })
        : null}
    </div>
  );
}
