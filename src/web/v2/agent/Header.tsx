import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { AttachWarning, Session } from '../../../core/api.ts';
import type { SidebarLayout } from '../../../core/sidebar-layout.ts';
import { TEAM_NAME_MAX, type TeamSummary } from '../../../core/team.ts';
import { ApiError, api } from '../../api/client.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { memoryApi } from '../../memory/api.ts';
// Project memory (D107) hook (docs/memory-removal.md): the imports above.
import { teamApi } from '../../team/api.ts';
import { offersHookedContinue } from '../../../core/hooked-continue.ts';
import { openContinueHooked } from '../../hooked-continue/store.ts';
import { openTakeover } from '../../takeover/store.ts';
import { offersTakeover } from '../../takeover/takeover.ts';
import { usePairedMachines } from '../../takeover/usePairedMachines.ts';
import { needsYouOf } from '../../views/session/needs-you.ts';
import { actionErrorText, attachWarningText, pauseButton, remoteToggle, rootLine } from '../../views/session/session-header.ts';
import { stoppableBackground } from '../../views/session/stop.ts';
import { Button, Chip, Dialog, Icon, IconButton, Menu, type MenuItem, Popover, Select, StatusBadge, Tabs, TextArea, useToast } from '../components/index.ts';
import { AGENT_TAB_LABELS, AGENT_WORDS, AGENTS_WORDS, WORDS } from '../glossary.ts';
import { V2Link, useV2Router } from '../nav.tsx';
import type { AgentTab } from '../routes.ts';
import { AgentComputerTag, CrewTag } from '../shared/agent-row.tsx';
import { agentName, agentStatusOf } from '../shared/agent-line.ts';
import { type TeamMemberRef, agentDisplayName, reloadTeammates, sessionOwnName, teammateOf, useCrewsList, useTeamMembers } from '../shared/teammates.ts';
import { continueAsAgent } from './agent-bits.ts';
import { ConfirmDialog, RemoteDialog, RenameDialog, TerminalDialog } from './dialogs.tsx';
import { type AgentMenuId, type AgentMenuSpec, agentMenu, ciView, folderTrail } from './header-model.ts';
import { howSummary } from './how-model.ts';
import type { AgentData } from './useAgent.ts';
import { useAgentCi } from './useAgent.ts';
import type { ChatViewSettings } from './view-settings.ts';

function errorText(caught: unknown): string {
  return caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null);
}

/** The sidebar layout (the agent's folder trail), live. */
function useSidebarLayout(): SidebarLayout | null {
  const [layout, setLayout] = useState<SidebarLayout | null>(null);
  useEffect(() => {
    let live = true;
    api.sidebarLayout().then(
      (value) => live && setLayout(value),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  useHubEvent('sidebarLayoutChanged', () => {
    api.sidebarLayout().then(setLayout, () => undefined);
  });
  return layout;
}

/** The crews (and this agent's teammate, if it is one), live: the shared crews store (fix after 2.0). */
function useCrews(sessionId: string): { readonly crews: readonly TeamSummary[]; readonly memberId: string | null; readonly mate: TeamMemberRef | null } {
  const crews = useCrewsList();
  const members = useTeamMembers();
  const mate = teammateOf(sessionId, members);
  return { crews, memberId: mate?.memberId ?? null, mate };
}

/** Props of {@link AgentHeader}. */
export interface AgentHeaderProps {
  readonly data: AgentData;
  readonly tab: AgentTab;
  readonly onTab: (tab: AgentTab) => void;
  readonly view: ChatViewSettings;
  readonly onView: (view: ChatViewSettings) => void;
  /** The side panel is shown (desktop) or open (tablet drawer / phone sheet). */
  readonly sideShown: boolean;
  readonly onToggleSide: () => void;
  readonly counts: { readonly changes: number | null; readonly results: number; readonly helpers: number };
  readonly phone: boolean;
}

/**
 * D131 · lane S · the agent header; fix after 2.0: ONE compact row (~52 px) so
 * the chat keeps the room. Back, the title (click to rename; a teammate shows its
 * teammate's name and crew, renamed through the crew), its status (icon + word),
 * the automatic-tests chip and the Needs-you ask inline and compact, the tabs,
 * then ⓘ (computer, folder, Smart / Fast, separate copy, the moved / continued /
 * terminal notes), View, Details (⌘.) and ⋯. On a phone: back, title, status and
 * ⋯ (the tabs, Details and ⓘ are in ⋯; the tab strip shows only off the chat).
 */
export function AgentHeader({ data, tab, onTab, view, onView, sideShown, onToggleSide, counts, phone }: AgentHeaderProps) {
  const { session, sessionId, blocked } = data;
  const toast = useToast();
  const layout = useSidebarLayout();
  const trail = folderTrail(layout, sessionId);
  const ci = ciView(useAgentCi(sessionId)?.prs ?? []);
  const [viewAnchor, setViewAnchor] = useState<HTMLButtonElement | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [infoButton, setInfoButton] = useState<HTMLButtonElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);
  const [infoAnchor, setInfoAnchor] = useState<HTMLElement | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const needs = needsYouOf(session);
  const { mate } = useCrews(sessionId);
  const members = useTeamMembers();
  const name = session ? agentDisplayName(session, members) : '';
  useTabTitle(name);
  const viewItems: MenuItem[] = [
    { id: 'comfortable', label: AGENT_WORDS.comfortable, icon: view.density === 'comfortable' ? 'check' : 'circle', onSelect: () => onView({ ...view, density: 'comfortable' }) },
    { id: 'compact', label: AGENT_WORDS.compact, icon: view.density === 'compact' ? 'check' : 'circle', onSelect: () => onView({ ...view, density: 'compact' }) },
    { separator: true, id: 'sep' },
    { id: 'full', label: AGENT_WORDS.fullWidth, icon: view.fullWidth ? 'check' : 'circle', onSelect: () => onView({ ...view, fullWidth: !view.fullWidth }) },
    { id: 'side', label: sideShown ? AGENT_WORDS.hideDetailsLong : AGENT_WORDS.showDetails, icon: 'sheet', kbd: '⌘.', onSelect: onToggleSide },
  ];
  const notWaiting = (): void => {
    if (!needs) return;
    setBusy(true);
    api.notWaiting(sessionId, needs.at).then(
      () => {
        setBusy(false);
        data.reload();
      },
      (caught: unknown) => {
        setBusy(false);
        toast({ text: errorText(caught), tone: 'error' });
      },
    );
  };
  const tabs: Array<{ id: AgentTab; label: string; icon: string; count?: number }> = data.conversation
    ? [
        { id: 'chat', label: AGENT_TAB_LABELS.chat, icon: 'chat' },
        { id: 'results', label: AGENT_TAB_LABELS.results, icon: 'results', ...(counts.results ? { count: counts.results } : {}) },
      ]
    : [
        { id: 'chat', label: AGENT_TAB_LABELS.chat, icon: 'chat' },
        { id: 'changes', label: AGENT_TAB_LABELS.changes, icon: 'copy', ...(counts.changes ? { count: counts.changes } : {}) },
        { id: 'results', label: AGENT_TAB_LABELS.results, icon: 'results', ...(counts.results ? { count: counts.results } : {}) },
        { id: 'timeline', label: AGENT_TAB_LABELS.timeline, icon: 'clock' },
        { id: 'helpers', label: AGENT_TAB_LABELS.helpers, icon: 'crew', ...(counts.helpers ? { count: counts.helpers } : {}) },
      ];
  const status = session ? agentStatusOf(session) : null;
  const head = useRef<HTMLDivElement | null>(null);
  // A narrow tab row scrolls sideways: keep the open tab in sight (a phone opening /timeline or /helpers).
  useEffect(() => {
    const strip = head.current?.querySelector<HTMLElement>('.v2-tabs');
    const on = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !on || strip.scrollWidth <= strip.clientWidth) return;
    const left = on.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
    if (left < strip.scrollLeft || left + on.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = Math.max(0, left - 12);
  }, [tab, phone, tabs.length, counts.changes, counts.results, counts.helpers]);
  const backTo = mate ? `/crews/${encodeURIComponent(mate.crewId)}` : '/agents';
  const backLabel = mate ? AGENT_WORDS.backToCrew(mate.crewName) : AGENT_WORDS.back;
  const trailText = trail.length > 0 ? trail.map((f) => f.name).join(' › ') : AGENT_WORDS.notInFolder;
  const hasNotes = session !== null && (session.movedTo != null || session.continuedTo != null || session.hooked === true);
  const tabStrip = <Tabs<AgentTab> tabs={tabs.map((t) => ({ ...t, title: t.label, label: <span className="v2-tab-l">{t.label}</span> }))} value={tab} onChange={onTab} label="Agent" panelId="v2-agent-panel" testId="v2-agent-tabs" />;
  const phoneExtra: MenuItem[] = phone
    ? [
        ...tabs.map((t): MenuItem => ({ id: `tab-${t.id}`, label: `${t.label}${t.count ? ` · ${t.count}` : ''}`, icon: t.id === tab ? 'check' : t.icon, onSelect: () => onTab(t.id) })),
        { id: 'details', label: AGENT_WORDS.details, icon: 'sheet', onSelect: onToggleSide },
        { id: 'info', label: AGENT_WORDS.aboutAgent, icon: 'info', onSelect: () => {
          setInfoAnchor(titleRef.current);
          setInfoOpen(true);
        } },
        { separator: true, id: 'sep-phone' },
      ]
    : [];
  return (
    <div className="v2-ag-head" data-testid="v2-agent-header" data-phone={phone ? 'true' : undefined} ref={head}>
      <div className="v2-ag-bar">
        <V2Link to={backTo} className="v2-icon-btn v2-ag-back" data-size={phone ? 'l' : undefined} aria-label={backLabel} title={backLabel} data-testid="v2-agent-back">
          <Icon name="back" />
        </V2Link>
        <div className="v2-ag-titlebox" ref={titleRef}>
          {session ? <InlineTitle sessionId={sessionId} name={name} mate={mate} disabled={blocked !== null} onRenamed={data.reload} /> : <span className="v2-skel" style={{ width: 200, height: 22 }} />}
          {mate ? <CrewTag crew={mate.crewName} /> : null}
        </div>
        {status ? <StatusBadge status={status} size={phone ? 's' : undefined} /> : null}
        {data.conversation && !phone ? (
          <Chip tone="outline" icon="chat" size="s">
            {AGENT_WORDS.conversation}
          </Chip>
        ) : null}
        {ci ? (
          <span className="v2-ag-ci" data-testid="v2-agent-ci" data-state={ci.state}>
            <Chip tone={ci.tone} icon={ci.icon === 'pulse' ? undefined : ci.icon} title={ci.title} size="s">
              {ci.icon === 'pulse' ? <span className="v2-pulse" aria-hidden="true" /> : null}
              <span className="v2-ag-ci-word">{ci.label}</span>
            </Chip>
            {ci.pr.url && !phone ? (
              <a className="v2-icon-btn" data-size="s" href={ci.pr.url} target="_blank" rel="noopener noreferrer" aria-label={AGENT_WORDS.openChangeRequest(ci.pr.number)} title={AGENT_WORDS.openChangeRequest(ci.pr.number)} data-testid="v2-agent-ci-open">
                <Icon name="external" size="s" />
              </a>
            ) : null}
          </span>
        ) : null}
        {needs ? (
          <span className="v2-ag-needs" role="status" data-testid="v2-agent-needs-you" data-source={needs.source} title={`${needs.status === 'blocked' ? AGENT_WORDS.blocked : AGENT_WORDS.needsYou}: ${needs.ask}`}>
            <Icon name="hand" size="s" />
            <b className="v2-ag-needs-word">{needs.status === 'blocked' ? AGENT_WORDS.blocked : AGENT_WORDS.needsYou}</b>
            <span className="v2-ag-needs-ask" data-testid="v2-agent-needs-ask">
              {needs.ask}
            </span>
            {needs.source === 'detected' ? (
              <span className="v2-sr" title={AGENT_WORDS.detectedHint}>
                {AGENT_WORDS.detected}
              </span>
            ) : null}
            <Button size="sm" variant="ghost" disabled={busy || blocked !== null} title={AGENT_WORDS.notWaitingHint} data-testid="v2-agent-not-waiting" onClick={notWaiting}>
              {WORDS.notWaiting}
            </Button>
          </span>
        ) : null}
        <span className="v2-grow" />
        {phone ? null : tabStrip}
        {phone ? null : (
          <>
            <IconButton
              ref={setInfoButton}
              icon="info"
              label={AGENT_WORDS.aboutAgent}
              title={AGENT_WORDS.aboutAgent}
              aria-haspopup="dialog"
              aria-expanded={infoOpen}
              data-testid="v2-agent-info"
              data-dot={hasNotes ? 'true' : undefined}
              onClick={() => {
                setInfoAnchor(infoButton);
                setInfoOpen((v) => !v);
              }}
            />
            <IconButton ref={setViewAnchor} icon="sliders" label={AGENT_WORDS.view} title="Text density and width" aria-haspopup="menu" aria-expanded={viewOpen} data-testid="v2-agent-view-button" onClick={() => setViewOpen((v) => !v)} />
            <Menu items={viewItems} anchor={viewAnchor} open={viewOpen} onClose={() => setViewOpen(false)} label={AGENT_WORDS.view} testId="v2-agent-view-menu" />
            <IconButton icon="sheet" label={`${sideShown ? AGENT_WORDS.hideDetailsLong : AGENT_WORDS.showDetails} (⌘.)`} title={`${sideShown ? AGENT_WORDS.hideDetailsLong : AGENT_WORDS.showDetails} (⌘.)`} aria-pressed={sideShown} data-testid="v2-agent-details" data-tour="v2-agent-details" onClick={onToggleSide} />
          </>
        )}
        <AgentMenuButton data={data} extra={phoneExtra} />
      </div>
      {phone && tab !== 'chat' ? tabStrip : null}
      <Popover open={infoOpen} onClose={() => setInfoOpen(false)} anchor={infoAnchor} label={AGENT_WORDS.aboutAgent} width={360} testId="v2-agent-info-pop">
        {session ? (
          <div className="v2-ag-info">
            <div className="v2-ag-info-row" data-testid="v2-agent-folder" title={trailText}>
              <Icon name="folder" size="s" />
              <span>{trailText}</span>
            </div>
            <div className="v2-ag-info-row">
              <AgentComputerTag machine={session.machine} />
            </div>
            {session.folderPath ? (
              <div className="v2-ag-info-row" title={rootLine(session)} data-testid="v2-agent-path">
                <Icon name="folder" size="s" />
                <span>{rootLine(session)}</span>
              </div>
            ) : null}
            <div className="v2-ag-info-row" title={session.model?.current ?? undefined}>
              <Icon name="sparkle" size="s" />
              <span>{howSummary(session.model)}</span>
            </div>
            {session.worktrees ? (
              <div className="v2-ag-info-row" title={AGENT_WORDS.separateCopyHint}>
                <Icon name="copy" size="s" />
                <span>{AGENT_WORDS.separateCopy}</span>
              </div>
            ) : null}
            {mate ? (
              <div className="v2-ag-info-row">
                <Icon name="crew" size="s" />
                <span>{AGENT_WORDS.teammateIn(mate.crewName, sessionOwnName(session))}</span>
              </div>
            ) : null}
            {phone && ci?.pr.url ? (
              <a className="v2-btn" data-variant="ghost" data-size="sm" href={ci.pr.url} target="_blank" rel="noopener noreferrer" data-testid="v2-agent-ci-open">
                <Icon name="external" size="s" />
                {AGENT_WORDS.openChangeRequest(ci.pr.number)}
              </a>
            ) : null}
            <Notes session={session} sessionId={data.sessionId} onAct={() => setInfoOpen(false)} />
          </div>
        ) : null}
      </Popover>
    </div>
  );
}

/** The browser tab says which agent is open (`<name> · Switchboard`), and goes back when it closes. */
function useTabTitle(name: string): void {
  useEffect(() => {
    if (!name) return undefined;
    const before = document.title;
    document.title = `${name} · Switchboard`;
    return () => {
      document.title = before;
    };
  }, [name]);
}

/** Lines under the title: moved to another computer, continued in a fresh agent, started in a terminal. */
function Notes({ session, sessionId, onAct }: { readonly session: Session; readonly sessionId: string; readonly onAct?: () => void }) {
  return (
    <>
      {session.movedTo ? (
        <div className="v2-ag-note" data-testid="v2-agent-moved">
          <Icon name="desktop" size="s" />
          Moved to {session.movedTo.machineName}. It continues there.
        </div>
      ) : null}
      {session.continuedTo ? (
        <div className="v2-ag-note" data-testid="v2-agent-continued">
          <Icon name="refresh" size="s" />
          {session.continuedTo.title ? (
            <>
              Continued in <V2Link to={`/agents/${encodeURIComponent(session.continuedTo.sessionId)}`}>{session.continuedTo.title}</V2Link>
            </>
          ) : (
            'Continued in an agent that no longer exists.'
          )}
        </div>
      ) : null}
      {session.hooked ? (
        <div className="v2-ag-note" data-testid="v2-agent-hooked">
          <Icon name="cmd" size="s" />
          <span className="v2-grow">Started in a terminal: Switchboard follows along. Pause, Stop and model changes stay in that terminal.</span>
          {offersHookedContinue(session) ? (
            <Button
              size="sm"
              icon="play"
              data-testid="v2-agent-continue-hooked"
              title={AGENT_WORDS.continueHookedHint}
              onClick={() => {
                onAct?.();
                openContinueHooked({ sessionId, title: agentName(session), machineName: session.machine?.name ?? null });
              }}
            >
              {AGENT_WORDS.continueHooked}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * The title; a click turns it into its field (Enter saves, Esc cancels). A
 * teammate's title is its teammate's name: it is renamed through the crew
 * (`PUT /api/team/members/{id}` `{ name }`, 1–40 characters), not the session.
 */
function InlineTitle({ sessionId, name, mate, disabled, onRenamed }: { readonly sessionId: string; readonly name: string; readonly mate: TeamMemberRef | null; readonly disabled: boolean; readonly onRenamed: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const toast = useToast();
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);
  const max = mate ? TEAM_NAME_MAX : 80;
  const save = (): void => {
    const title = value.trim();
    setEditing(false);
    if (title === name) return;
    if (mate) {
      if (title === '') return;
      const before = name;
      teamApi.updateMember(mate.memberId, { name: title.slice(0, TEAM_NAME_MAX) }).then(
        () => {
          void reloadTeammates();
          toast({ text: `Renamed to “${title.slice(0, TEAM_NAME_MAX)}”.`, undo: () => teamApi.updateMember(mate.memberId, { name: before }).then(() => reloadTeammates()) });
        },
        (caught: unknown) => toast({ text: errorText(caught), tone: 'error' }),
      );
      return;
    }
    api.renameSession(sessionId, title === '' ? null : title.slice(0, 80)).then(
      () => {
        onRenamed();
        toast({
          text: `Renamed to “${title || 'its name'}”.`,
          undo: () => api.renameSession(sessionId, name).then(onRenamed),
        });
      },
      (caught: unknown) => toast({ text: errorText(caught), tone: 'error' }),
    );
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') save();
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setEditing(false);
      setValue(name);
    }
  };
  if (editing) {
    return <input ref={field} className="v2-ag-title-field" aria-label={mate ? 'Teammate name' : 'Agent name'} value={value} maxLength={max} onChange={(event) => setValue(event.target.value)} onKeyDown={onKey} onBlur={save} data-testid="v2-agent-title-field" />;
  }
  return (
    <h1 className="v2-ag-title">
      <button
        type="button"
        className="v2-ag-title-btn"
        disabled={disabled}
        title={mate ? AGENT_WORDS.renameTeammate(mate.crewName) : 'Rename'}
        data-testid="v2-agent-title"
        onClick={() => {
          setValue(name);
          setEditing(true);
        }}
      >
        {name}
      </button>
    </h1>
  );
}

/** The routine dialog's choices (an owned loop, D94). */
const EVERY: ReadonlyArray<{ readonly value: string; readonly label: string; readonly body: { readonly everyMinutes?: number; readonly cron?: string } }> = [
  { value: '30', label: 'Every 30 minutes', body: { everyMinutes: 30 } },
  { value: '60', label: 'Every hour', body: { everyMinutes: 60 } },
  { value: '180', label: 'Every 3 hours', body: { everyMinutes: 180 } },
  { value: 'morning', label: 'Every morning at 9:00', body: { cron: '0 9 * * *' } },
  { value: 'weekday', label: 'Every weekday at 9:00', body: { cron: '0 9 * * 1-5' } },
];

/** The agent ⋯ button and its menu with every action (disabled with the reason where it cannot run). */
export function AgentMenuButton({ data, extra = [] }: { readonly data: AgentData; readonly extra?: readonly MenuItem[] }) {
  const { session, sessionId, blocked } = data;
  const { navigate } = useV2Router();
  const toast = useToast();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'rename' | 'remote' | 'routine' | 'teammate' | 'close' | 'delete' | 'attach' | null>(null);
  const [terminal, setTerminal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachWarning, setAttachWarning] = useState<AttachWarning | null>(null);
  const { machines } = usePairedMachines(open);
  const { crews, memberId } = useCrews(sessionId);
  const online = machines.filter((machine) => machine.state === 'online');
  const remote = session ? remoteToggle(session) : null;
  const background = session && blocked === null ? stoppableBackground({ live: session.live, status: session.status, activity: data.activity, hooked: session.hooked === true }).length : 0;
  const specs: AgentMenuSpec[] = useMemo(
    () =>
      session
        ? agentMenu({
            conversation: data.conversation,
            closed: data.closed,
            running: pauseButton(session).action === 'pause',
            attached: session.attached,
            hooked: session.hooked === true,
            machineName: session.machine?.name ?? null,
            offline: blocked,
            remote,
            background,
            movable: offersTakeover(session),
            hookedContinue: offersHookedContinue(session),
            computers: online.length,
            teammate: memberId !== null,
            crews: crews.length,
          })
        : [],
    [session, data.conversation, data.closed, blocked, remote, background, online.length, memberId, crews.length],
  );
  const members = useTeamMembers();
  const name = session ? agentDisplayName(session, members) : '';
  const act = (work: () => Promise<unknown>, done?: { readonly text: string; readonly undo?: () => Promise<unknown> }): void => {
    setBusy(true);
    setError(null);
    work().then(
      () => {
        setBusy(false);
        setDialog(null);
        if (done) toast({ text: done.text, ...(done.undo ? { undo: done.undo } : {}) });
        data.reload();
      },
      (caught: unknown) => {
        setBusy(false);
        setError(errorText(caught));
        if (!dialog) toast({ text: errorText(caught), tone: 'error' });
        data.reload();
      },
    );
  };
  const select = (id: AgentMenuId): void => {
    setError(null);
    switch (id) {
      case 'rename':
        setDialog('rename');
        return;
      case 'pause':
        act(() => api.pauseSession(sessionId), { text: `${name} paused. Nothing new starts until you resume.`, undo: () => api.resumeSession(sessionId) });
        return;
      case 'resume':
        act(() => api.resumeSession(sessionId), { text: `${name} resumed.` });
        return;
      case 'stop-background':
        act(() => api.stopBackground(sessionId, {}), { text: 'Stopped the background tasks.' });
        return;
      case 'move':
        // Lane X: the v2 move dialog (MoveDialog.tsx); a local agent's target is picked in it (the first online computer to start).
        if (!session) return;
        if (session.machine) openTakeover({ sessionId, targetMachine: null, machineName: session.machine.name, title: name });
        else if (online[0]) openTakeover({ sessionId, targetMachine: online[0].id, machineName: online[0].name, title: name });
        return;
      case 'continue-hooked':
        if (session) openContinueHooked({ sessionId, title: name, machineName: session.machine?.name ?? null });
        return;
      case 'terminal':
        act(async () => {
          const answer = await api.detachSession(sessionId);
          setTerminal(answer.resumeCommand);
        });
        return;
      case 'attach':
        setBusy(true);
        api.attachSession(sessionId).then(
          () => {
            setBusy(false);
            toast({ text: `${name} is back in Switchboard.` });
            data.reload();
          },
          (caught: unknown) => {
            setBusy(false);
            const body = caught instanceof ApiError && caught.status === 409 ? (caught.body as Partial<AttachWarning> | null) : null;
            if (body?.error === 'attach-warning' && Array.isArray(body.reasons)) {
              setAttachWarning(body as AttachWarning);
              setDialog('attach');
            } else toast({ text: errorText(caught), tone: 'error' });
          },
        );
        return;
      case 'remote':
        setDialog('remote');
        return;
      case 'claude-app':
        if (remote?.url) {
          window.open(remote.url, '_blank', 'noopener');
          return;
        }
        act(async () => {
          const updated = await api.setRemote(sessionId, true);
          const url = updated.remote?.url ?? null;
          if (url) window.open(url, '_blank', 'noopener');
        }, { text: 'Remote control is on: it opens in the Claude app.' });
        return;
      case 'routine':
        setDialog('routine');
        return;
      case 'notes':
        act(() => memoryApi(session?.machine?.id ?? null).draft({ sessionId }), { text: `Drafting notes from “${name}”. They wait in Needs you.` });
        return;
      case 'teammate':
        setDialog('teammate');
        return;
      case 'return':
        if (memberId && session) {
          const own = sessionOwnName(session);
          act(
            async () => {
              await teamApi.returnMember(memberId);
              await reloadTeammates();
            },
            { text: `“${own}” is back in Agents, not in a crew.` },
          );
        }
        return;
      case 'continue-agent':
        if (session) void continueAsAgent(session);
        return;
      case 'close':
        if (session && (session.live || session.status === 'run' || session.status === 'need')) setDialog('close');
        else act(() => api.closeSession(sessionId), { text: AGENTS_WORDS.closedToast(name), undo: () => api.reopenSession(sessionId) });
        return;
      case 'reopen':
        act(() => api.reopenSession(sessionId), { text: AGENTS_WORDS.reopened(name) });
        return;
      case 'delete':
        setDialog('delete');
        return;
    }
  };
  const items: MenuItem[] = [
    ...extra,
    ...specs.map((spec): MenuItem => ('sep' in spec ? { separator: true, id: `sep-${spec.sep}` } : { id: spec.id, label: spec.label, icon: spec.icon, ...(spec.disabledReason ? { disabledReason: spec.disabledReason } : {}), ...(spec.danger ? { danger: true } : {}), onSelect: () => select(spec.id) })),
  ];
  return (
    <>
      <IconButton ref={setAnchor} icon="more" label={AGENT_WORDS.more} aria-haspopup="menu" aria-expanded={open} data-testid="v2-agent-menu" disabled={!session} onClick={() => setOpen((v) => !v)} />
      <Menu items={items} anchor={anchor} open={open} onClose={() => setOpen(false)} label={AGENT_WORDS.more} testId="v2-agent-menu-list" />
      {session ? (
        <>
          <RenameDialog
            open={dialog === 'rename'}
            sessionId={sessionId}
            current={name}
            onClose={() => setDialog(null)}
            onDone={(title, before) => {
              data.reload();
              toast({ text: `Renamed to “${title || 'its name'}”.`, undo: () => api.renameSession(sessionId, before).then(data.reload) });
            }}
          />
          <TerminalDialog command={terminal} cwd={session.cwd} onClose={() => setTerminal(null)} />
          <RemoteDialog
            open={dialog === 'remote'}
            on={remote?.on ?? false}
            url={remote?.url ?? null}
            disabledReason={remote?.reason ?? null}
            busy={busy}
            error={error}
            onToggle={(on) => {
              setBusy(true);
              setError(null);
              api.setRemote(sessionId, on).then(
                () => {
                  setBusy(false);
                  data.reload();
                },
                (caught: unknown) => {
                  setBusy(false);
                  setError(errorText(caught));
                },
              );
            }}
            onClose={() => setDialog(null)}
          />
          {dialog === 'routine' ? <RoutineDialog sessionId={sessionId} name={name} onClose={() => setDialog(null)} /> : null}
          {dialog === 'teammate' ? <TeammateDialog sessionId={sessionId} name={name} crews={crews} onClose={() => setDialog(null)} onDone={data.reload} /> : null}
          <ConfirmDialog
            open={dialog === 'attach'}
            title={AGENT_WORDS.attachHere}
            text={attachWarning ? attachWarningText(attachWarning.reasons) : ''}
            yes="Bring it back anyway"
            busy={busy}
            error={error}
            onYes={() => act(() => api.attachSession(sessionId, true), { text: `${name} is back in Switchboard.` })}
            onClose={() => setDialog(null)}
          />
          <ConfirmDialog
            open={dialog === 'close'}
            title={`Archive “${name}”?`}
            text="It is working or waiting for you. Archiving stops it; nothing is undone, and you can restore it from Archived until it is deleted."
            yes={AGENT_WORDS.close}
            busy={busy}
            error={error}
            testId="v2-agent-close-confirm"
            onYes={() => act(() => api.closeSession(sessionId, true), { text: AGENTS_WORDS.closedToast(name), undo: () => api.reopenSession(sessionId) })}
            onClose={() => setDialog(null)}
          />
          <ConfirmDialog
            open={dialog === 'delete'}
            title={`Delete “${name}”?`}
            text="Its conversation, attachments and scratch folder are removed. This cannot be undone."
            yes="Delete"
            danger
            busy={busy}
            error={error}
            testId="v2-agent-delete-confirm"
            onYes={() =>
              act(async () => {
                await api.deleteChat(sessionId, true);
                navigate('/agents');
              })
            }
            onClose={() => setDialog(null)}
          />
        </>
      ) : null}
    </>
  );
}

function RoutineDialog({ sessionId, name, onClose }: { readonly sessionId: string; readonly name: string; readonly onClose: () => void }) {
  const toast = useToast();
  const [prompt, setPrompt] = useState(`Check on “${name}” and tell me what changed.`);
  const [every, setEvery] = useState('morning');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    const choice = EVERY.find((e) => e.value === every) ?? EVERY[0];
    if (!choice || prompt.trim() === '') return;
    setBusy(true);
    api.createLoop(sessionId, { prompt: prompt.trim(), ...choice.body, label: prompt.trim().slice(0, 40) }).then(
      () => {
        setBusy(false);
        onClose();
        toast({ text: `Added a routine: ${choice.label.toLowerCase()}.` });
      },
      (caught: unknown) => {
        setBusy(false);
        setError(errorText(caught));
      },
    );
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={AGENT_WORDS.addRoutine.replace('…', '')}
      icon="routine"
      testId="v2-agent-routine"
      footer={
        <>
          <Button onClick={onClose}>{AGENT_WORDS.cancel}</Button>
          <Button variant="primary" disabled={busy} onClick={save}>
            Add routine
          </Button>
        </>
      }
    >
      <TextArea label="What should it do each time?" rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      <Select label="How often" value={every} options={EVERY.map((e) => ({ value: e.value, label: e.label }))} onChange={(event) => setEvery(event.target.value)} />
      {error ? (
        <p role="alert" className="v2-ag-dock-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

function TeammateDialog({ sessionId, name, crews, onClose, onDone }: { readonly sessionId: string; readonly name: string; readonly crews: readonly TeamSummary[]; readonly onClose: () => void; readonly onDone: () => void }) {
  const toast = useToast();
  const [crew, setCrew] = useState(crews[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    setBusy(true);
    teamApi.addMember({ sessionId, teamId: crew, name: name.slice(0, TEAM_NAME_MAX), charter: { owns: '', produces: '', neverDoes: '' }, askCharter: true }).then(
      () => {
        setBusy(false);
        onClose();
        onDone();
        void reloadTeammates();
        toast({ text: `“${name}” is now a teammate in ${crews.find((c) => c.id === crew)?.name ?? 'the crew'}. It drafts its own job description.` });
      },
      (caught: unknown) => {
        setBusy(false);
        setError(errorText(caught));
      },
    );
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Make “${name}” a teammate`}
      icon="crew"
      testId="v2-agent-teammate"
      footer={
        <>
          <Button onClick={onClose}>{AGENT_WORDS.cancel}</Button>
          <Button variant="primary" disabled={busy || crew === ''} onClick={save}>
            Make teammate
          </Button>
        </>
      }
    >
      <p className="v2-muted" style={{ marginTop: 0 }}>
        It keeps its chat and history and gets a job description you can edit.
      </p>
      <Select label="Crew" value={crew} options={crews.map((c) => ({ value: c.id, label: c.name }))} onChange={(event) => setCrew(event.target.value)} />
      {error ? (
        <p role="alert" className="v2-ag-dock-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
