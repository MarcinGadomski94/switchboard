import { type CSSProperties, type ReactNode, type SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon, Portal, StatusBadge, useEscape } from '../components/index.ts';
import { isChat } from '../../../core/chats.ts';
import { PROJECT_WORDS, RAIL_LABELS, STATUS, TERMS, WORDS, railTasksLabel, railTerminalsLabel } from '../glossary.ts';
import { agentStatusOf } from '../shared/agent-line.ts';
import { RowComputerTag, useAnyPaired } from '../shared/agent-row.tsx';
import { V2Link } from '../nav.tsx';
import { RAIL_AREAS, type RailArea, type V2Route, railAreaOf, v2Path } from '../routes.ts';
import { useOpenTerminalCount } from '../terminals/useOpenTerminalCount.ts';
import { type PinnedProject as PinnedProjectData, needsByAgent, pinnedProjectLabel } from '../shared/pinned-model.ts';
import { RecentList, useRecentAgents } from '../shared/RecentList.tsx';
import { useNeedsYou } from '../shared/needs-you.ts';
import { useRecentCount } from '../shared/recent.ts';
import { agentDisplayName, useTeamMembers } from '../shared/teammates.ts';
import type { StatusPill } from './status-model.ts';
import { PinnedCrew } from './PinnedCrew.tsx';
import { ProfileSwitcher } from '../profiles/Profiles.tsx';
import { pinnedNeeds, railTip } from './rail-model.ts';
import { type RailCounts, usePhones, usePinned, useProjectsWorking, useUnfinishedTaskCount } from './useShellData.ts';

/**
 * D161 · a pinned project in the Pinned list: its status badge (working pulses),
 * its title, its short line (done/total, Paused, Draft) and the steps that need you (amber);
 * it opens the project page.
 */
function PinnedProject({ project, route }: { readonly project: PinnedProjectData; readonly route: V2Route }) {
  return (
    <V2Link
      to={{ area: 'project', id: project.planId }}
      className="v2-pin-item v2-pin-project"
      aria-label={pinnedProjectLabel(project)}
      title={`${project.title} · ${project.label}`}
      aria-current={route.area === 'project' && route.id === project.planId ? 'page' : undefined}
      data-testid="v2-pin-project"
      data-plan={project.planId}
      data-status={project.status}
      data-tour="v2-pin-project"
    >
      <StatusBadge status={project.status} compact />
      <span className="v2-pin-name">{project.title}</span>
      {project.line ? (
        <span className="v2-pin-project-line" aria-hidden="true" data-testid="v2-pin-project-line">
          {project.line}
        </span>
      ) : null}
      {project.needs > 0 ? (
        <span className="v2-nav-badge v2-pin-project-needs" aria-hidden="true" data-testid="v2-pin-project-needs">
          {project.needs}
        </span>
      ) : null}
    </V2Link>
  );
}

const ICONS: Readonly<Record<RailArea, string>> = { home: 'home', agents: 'agents', projects: 'projects', crews: 'crew', results: 'results', tasks: 'task', terminals: 'cmd', settings: 'settings' };
const TARGETS: Readonly<Record<RailArea, V2Route>> = {
  home: { area: 'home' },
  agents: { area: 'agents' },
  projects: { area: 'projects' },
  crews: { area: 'crews' },
  results: { area: 'results' },
  tasks: { area: 'tasks' },
  terminals: { area: 'terminals' },
  settings: { area: 'settings', section: null, sub: null },
};

/**
 * D181 · the rail's tooltips: the name (and what the badge counts) of the item under the pointer
 * or with the keyboard focus, beside it. One floating label for the whole rail (in a portal, so
 * the rail's own scrolling never clips it); it is `aria-hidden`: every item already carries its
 * name as its accessible label.
 */
function useRailTip(): { readonly tip: ReactNode; readonly show: (event: SyntheticEvent) => void; readonly hide: () => void } {
  const [state, setState] = useState<{ readonly text: string; readonly top: number; readonly left: number } | null>(null);
  const show = (event: SyntheticEvent): void => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-tip], [aria-label]');
    if (!target || !event.currentTarget.contains(target)) return;
    const text = target.dataset['tip'] ?? target.getAttribute('aria-label');
    if (!text) return;
    const box = target.getBoundingClientRect();
    setState({ text, top: box.top + box.height / 2, left: box.right + 8 });
  };
  const hide = (): void => setState(null);
  const tip = state ? (
    <Portal>
      <div className="v2-rail-tip" role="tooltip" aria-hidden="true" data-testid="v2-rail-tip" style={{ top: state.top, left: state.left }}>
        {state.text}
      </div>
    </Portal>
  ) : null;
  return { tip, show, hide };
}

/**
 * D181 · a panel the rail opens beside one of its buttons (Pinned, Recent): it sits to the
 * right of the button, as high as it fits; Esc closes it and gives the focus back to the button,
 * a click outside closes it, and so does a pick (the page changes).
 */
function RailFlyout({ open, anchor, onClose, label, testId, children }: { readonly open: boolean; readonly anchor: HTMLElement | null; readonly onClose: () => void; readonly label: string; readonly testId: string; readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;
  const [pos, setPos] = useState<{ readonly top: number; readonly left: number } | null>(null);
  useEffect(() => {
    if (!open || !anchor) return;
    const place = (): void => {
      const box = anchor.getBoundingClientRect();
      const height = ref.current?.offsetHeight ?? 0;
      const top = Math.max(8, Math.min(box.top, window.innerHeight - height - 8));
      setPos({ top, left: box.right + 8 });
    };
    place();
    const frame = window.requestAnimationFrame(place);
    window.addEventListener('resize', place);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', place);
    };
  }, [open, anchor]);
  useEscape(open, () => {
    onClose();
    anchor?.focus({ preventScroll: true });
  });
  // A click outside closes it; a menu it opened (Recent's ⋯, in its own portal) is not outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (!target || ref.current?.contains(target) || anchorRef.current?.contains(target) || target.closest('[role="menu"]')) return;
      onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, onClose]);
  if (!open) return null;
  const style: CSSProperties = pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 };
  return (
    <Portal>
      <div ref={ref} className="v2-pop v2-rail-flyout" role="dialog" aria-label={label} data-testid={testId} style={style} tabIndex={-1}>
        {children}
      </div>
    </Portal>
  );
}

/**
 * D131 · the left rail; D181: icons only, at every width the rail shows (desktop and tablet).
 * The brand's mark, the profile switcher (its colour dot), the eight destinations (Home ·
 * Agents · Projects · Crews · Artifacts · Tasks · Terminals · Settings) each with its "needs
 * you" count (Tasks: its tasks not done yet; Terminals, 2.5.2: this computer's open terminals)
 * and a tooltip, then **Pinned** and **Recent**, each a button that opens its list beside the
 * rail (the shared sidebar layout's pins, D71: agents, crews with their teammates, projects;
 * the agents last used), and at the foot this computer, the paired ones and the phones as icons.
 */
export function Rail({ route, counts, pill }: { readonly route: V2Route; readonly counts: RailCounts; readonly pill: StatusPill }) {
  const current = railAreaOf(route);
  const pins = usePinned();
  const members = useTeamMembers();
  const pinnedIds = useMemo(() => pins.filter((entry) => entry.kind === 'agent').map((entry) => entry.id), [pins]);
  const phones = usePhones();
  const unfinished = useUnfinishedTaskCount();
  const anyPaired = useAnyPaired();
  const { items } = useNeedsYou();
  const needsOf = useMemo(() => needsByAgent(items), [items]);
  // D181: the Pinned button's count (what the pins need from you) and Recent's (its agents that need you).
  const pinNeeds = pinnedNeeds(pins, needsOf);
  const recentCount = useRecentCount();
  const recent = useRecentAgents(pinnedIds, recentCount);
  const recentNeeds = recent.reduce((sum, session) => sum + (needsOf.get(session.id) ?? 0), 0);
  // D161: the Projects item pulses while a project is working.
  const projectsWorking = useProjectsWorking();
  // 2.5.2 (D170): this computer's open terminals, read again on each route change (leaving or closing one).
  const path = v2Path(route);
  const terminals = useOpenTerminalCount(path);
  const [pinsAnchor, setPinsAnchor] = useState<HTMLButtonElement | null>(null);
  const [recentAnchor, setRecentAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState<'pins' | 'recent' | null>(null);
  const close = useCallback((): void => setOpen(null), []);
  // A pick in a list opens its page: the list closes.
  useEffect(() => setOpen(null), [path]);
  const { tip, show, hide } = useRailTip();
  const badge = (area: RailArea): number => (area === 'home' || area === 'agents' || area === 'projects' || area === 'crews' ? counts[area] : area === 'tasks' ? unfinished : area === 'terminals' ? terminals : 0);
  const label = (area: RailArea, count: number): string => {
    const working = area === 'projects' && projectsWorking ? `, ${PROJECT_WORDS.someWorking}` : '';
    if (count <= 0) return `${RAIL_LABELS[area]}${working}`;
    if (area === 'terminals') return railTerminalsLabel(count);
    return area === 'tasks' ? railTasksLabel(count) : `${RAIL_LABELS[area]}, ${count} need${count === 1 ? 's' : ''} you${working}`;
  };
  const needsWords = (count: number): string | null => (count > 0 ? `${count} need${count === 1 ? 's' : ''} you` : null);
  return (
    <nav className="v2-rail" aria-label="Main" data-testid="v2-rail" onPointerOver={show} onPointerLeave={hide} onFocus={show} onBlur={hide}>
      <div className="v2-brand" data-tip="Switchboard">
        <div className="v2-brand-mark" aria-hidden="true">
          <Icon name="sparkle" size="s" />
        </div>
        <span className="v2-sr">Switchboard</span>
      </div>
      {/* D165: the profile this browser works in (many profiles: a menu); D181: its colour dot. */}
      <ProfileSwitcher />
      {RAIL_AREAS.map((area) => {
        const count = badge(area);
        return (
          <V2Link key={area} to={TARGETS[area]} className="v2-nav-item" aria-current={current === area ? 'page' : undefined} data-testid={`v2-nav-${area}`} data-tour={`v2-nav-${area}`} aria-label={label(area, count)}>
            <Icon name={ICONS[area]} />
            <span className="v2-nav-label v2-sr">{RAIL_LABELS[area]}</span>
            {area === 'projects' && projectsWorking ? <span className="v2-pulse v2-nav-pulse" aria-hidden="true" data-testid="v2-nav-pulse-projects" /> : null}
            {count > 0 ? (
              <span className="v2-nav-badge" aria-hidden="true" data-testid={`v2-nav-badge-${area}`}>
                {count}
              </span>
            ) : null}
          </V2Link>
        );
      })}
      <div className="v2-rail-sep" aria-hidden="true" />
      <button
        ref={setPinsAnchor}
        type="button"
        className="v2-nav-item v2-rail-list-btn"
        aria-haspopup="dialog"
        aria-expanded={open === 'pins'}
        aria-label={pinNeeds > 0 ? `${WORDS.pinned}, ${needsWords(pinNeeds)}` : WORDS.pinned}
        data-tip={railTip(WORDS.pinned, needsWords(pinNeeds))}
        onClick={() => setOpen((value) => (value === 'pins' ? null : 'pins'))}
        data-testid="v2-rail-pins-button"
        data-tour="v2-rail-pins"
      >
        <Icon name="pin" />
        {pinNeeds > 0 ? (
          <span className="v2-nav-badge" aria-hidden="true" data-testid="v2-rail-pins-needs">
            {pinNeeds}
          </span>
        ) : null}
      </button>
      {recentCount > 0 ? (
        <button
          ref={setRecentAnchor}
          type="button"
          className="v2-nav-item v2-rail-list-btn"
          aria-haspopup="dialog"
          aria-expanded={open === 'recent'}
          aria-label={recentNeeds > 0 ? `${WORDS.recent}, ${needsWords(recentNeeds)}` : WORDS.recent}
          data-tip={railTip(WORDS.recent, needsWords(recentNeeds))}
          onClick={() => setOpen((value) => (value === 'recent' ? null : 'recent'))}
          data-testid="v2-rail-recent-button"
          data-tour="v2-recent"
        >
          <Icon name="clock" />
          {recentNeeds > 0 ? (
            <span className="v2-nav-badge" aria-hidden="true" data-testid="v2-rail-recent-needs">
              {recentNeeds}
            </span>
          ) : null}
        </button>
      ) : null}
      <RailFlyout open={open === 'pins'} anchor={pinsAnchor} onClose={close} label={WORDS.pinned} testId="v2-rail-pins-flyout">
        <div className="v2-rail-pins" aria-label={WORDS.pinned} role="group" data-testid="v2-rail-pins">
          <h5>
            <Icon name="pin" size="s" />
            {WORDS.pinned}
          </h5>
          {pins.map((entry) => {
            if (entry.kind === 'crew') return <PinnedCrew key={entry.id} crew={entry.crew} route={route} />;
            if (entry.kind === 'project') return <PinnedProject key={entry.id} project={entry.project} route={route} />;
            const session = entry.session;
            const status = agentStatusOf(session);
            const name = agentDisplayName(session, members);
            // D175: a pinned conversation (D106 chat) reads as one: a chat mark after its name.
            const conversation = isChat(session);
            const needs = needsOf.get(session.id) ?? 0;
            return (
              <V2Link
                key={session.id}
                to={{ area: 'agent', id: session.id, tab: 'chat' }}
                className="v2-pin-item"
                title={`${name}${conversation ? ` · ${TERMS.conversation.one}` : ''} · ${STATUS[status].label}`}
                aria-current={route.area === 'agent' && route.id === session.id ? 'page' : undefined}
                data-testid="v2-pin-agent"
                data-kind={conversation ? 'conversation' : 'agent'}
                data-tour={conversation ? 'v2-pin-conversation' : undefined}
              >
                <StatusBadge status={status} compact />
                <span className="v2-pin-name">{name}</span>
                {conversation ? <Icon name="chat" size="s" className="v2-pin-kind" label={TERMS.conversation.one} /> : null}
                {/* D181: the computer it runs on (once a computer is paired). */}
                <RowComputerTag machine={session.machine} anyPaired={anyPaired} />
                {needs > 0 ? (
                  <span className="v2-nav-badge" title={WORDS.needsYou} data-testid="v2-pin-agent-needs">
                    {needs}
                  </span>
                ) : null}
              </V2Link>
            );
          })}
          {pins.length === 0 ? <p className="v2-rail-note">{WORDS.pinnedHint}</p> : null}
        </div>
      </RailFlyout>
      <RailFlyout open={open === 'recent'} anchor={recentAnchor} onClose={close} label={WORDS.recent} testId="v2-rail-recent-flyout">
        <RecentList pinned={pinnedIds} currentId={route.area === 'agent' ? route.id : null} variant="flyout" />
        {recent.length === 0 ? <p className="v2-rail-note v2-rail-recent-empty">{WORDS.recentEmpty}</p> : null}
      </RailFlyout>
      <div className="v2-rail-foot" data-testid="v2-rail-foot">
        {pill.computerRows.map((row) => {
          const text = `${row.name}${row.self ? '' : ` · ${STATUS[row.state].label.toLowerCase()}`}`;
          return (
            <div key={row.id ?? 'self'} className="v2-row v2-rail-foot-item" data-state={row.state} data-tip={text} role="img" aria-label={text} tabIndex={0}>
              <Icon name={row.state === 'offline' ? 'offline' : row.state === 'reconnecting' ? 'refresh' : row.self ? 'laptop' : 'desktop'} size="s" />
            </div>
          );
        })}
        {phones.map((phone) => {
          const text = `${phone.name} · paired`;
          return (
            <div key={phone.id} className="v2-row v2-rail-foot-item" data-tip={text} role="img" aria-label={text} tabIndex={0}>
              <Icon name="phone" size="s" />
            </div>
          );
        })}
      </div>
      {tip}
    </nav>
  );
}
