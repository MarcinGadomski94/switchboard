import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SidebarLayout } from '../../core/sidebar-layout.ts';
import { ALL_TEAMS, DEFAULT_TEAM_ID, DEFAULT_TEAM_NAME, TEAM_NAME_MAX, type TeamMember, type TeamSuggestion } from '../../core/team.ts';
import type { TeamTemplate } from '../../core/team-templates.ts';
import { displayTitle } from '../../core/session-title.ts';
import { openSessions } from '../../core/session-close.ts';
import { useLiveActivities } from '../activity/useActivity.ts';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useSessionListOf } from '../api/session-list.ts';
import { useSavedFolders } from '../folders/useFolders.ts';
import { useModals } from '../modals/ModalHost.tsx';
import { Link, useRouter } from '../router.tsx';
import { useLayout } from '../shell/useLayout.ts';
import { useToasts } from '../toast/ToastHost.tsx';
import { refusalText, teamApi } from './api.ts';
import {
  AddMemberDialog,
  type FormTarget,
  GiveTaskDialog,
  MemberFormDialog,
  MemberMenu,
  MoveDialog,
  ReviewDialog,
  type ReviewPick,
  SessionPicker,
  TemplatePicker,
  createTarget,
  sessionsForReview,
} from './dialogs.tsx';
import { useTeamSwitch } from './hidden.ts';
import { bannerLaterIds, highlightReturnedRow, lastTeam, setBannerLater, setLastTeam } from './local.ts';
import { MemberCard } from './MemberCard.tsx';
import { MemberPanel, type PanelTab, type SettingsFocus } from './MemberPanel.tsx';
import { type MenuItem, adoptedToast, modelLine, teamTitle, bannerText, bannerVisible, cardStatus, formFromSuggestion, formFromTemplate, headerCounts, inOrder, memberMenu, moveInOrder, needsYouCounts, placeLabel, returnedToast, syncedPeers } from './model.ts';
import { ReorderStrip } from './ReorderStrip.tsx';
import { DeleteTeamDialog, NewTeamDialog, TeamTabs } from './TeamTabs.tsx';
import { ActivityFeed, NeedsYouList } from './NeedsYou.tsx';
import { reloadTeam, showTeam, useTeamData } from './useTeamData.ts';
import './team.css';

/** The dialog open on the page (one at a time). */
type Open =
  | { readonly kind: 'add' }
  | { readonly kind: 'review' }
  | { readonly kind: 'templates' }
  | { readonly kind: 'sessions' }
  | { readonly kind: 'form'; readonly target: FormTarget }
  | { readonly kind: 'task'; readonly memberId: string }
  | { readonly kind: 'move'; readonly memberId: string; readonly target: { readonly id: string; readonly name: string } }
  | { readonly kind: 'new-team' }
  | { readonly kind: 'delete-team' }
  | null;

/**
 * D100 · the Team page (`/team`, `docs/team.md` → *The Team page*): the header (name,
 * "⇄ synced with <PC>", the counts, ＋ Member), the suggestions banner, the member
 * cards across the full width, then Needs you and Activity (left) | the selected
 * member's panel (right); the same on a tablet with a narrower left; a phone shows a
 * list with Needs you first and the panel full screen with "‹ Team". Shown only while Team is on; otherwise it points to the switch.
 */
export function TeamPage() {
  const { on } = useTeamSwitch();
  const layout = useLayout();
  const phone = layout === 'phone';
  const { route, navigate } = useRouter();
  // D100 follow-up 2026-10-14 (multiple teams): `/team/{teamId}`; `/team` opens the last-used team; `/team/all` the All teams tab.
  const routeTeam = route.view === 'team' ? (route.teamId ?? null) : null;
  const data = useTeamData();
  const { teams, needsYou: allItems, error, loaded } = data;
  useEffect(() => {
    showTeam(routeTeam);
  }, [routeTeam]);
  /** A team just created here: shown before the next read lists it (no redirect meanwhile). */
  const created = useRef<string | null>(null);
  useEffect(() => {
    if (!on || !loaded || teams.length === 0 || routeTeam === ALL_TEAMS) return;
    if (routeTeam !== null && teams.some((team) => team.id === routeTeam)) {
      setLastTeam(routeTeam);
      if (created.current === routeTeam) created.current = null;
      return;
    }
    if (routeTeam !== null && created.current === routeTeam) return;
    const last = lastTeam();
    const id = last !== null && teams.some((team) => team.id === last) ? last : (teams[0]?.id ?? DEFAULT_TEAM_ID);
    navigate({ view: 'team', teamId: id }, { replace: true });
  }, [on, loaded, teams, routeTeam, navigate]);
  const allTab = routeTeam === ALL_TEAMS;
  // The view of the route's team (a moment after switching, the previous team's is still there: not shown).
  const view = data.view && (routeTeam === null || data.view.team.id === routeTeam) ? data.view : null;
  const teamId = view?.team.id ?? (routeTeam !== null && routeTeam !== ALL_TEAMS ? routeTeam : DEFAULT_TEAM_ID);
  const items = useMemo(() => allItems.filter((item) => (item.teamId ?? DEFAULT_TEAM_ID) === teamId), [allItems, teamId]);
  const sessions = useSessionListOf();
  const activityOf = useLiveActivities(sessions.data);
  const machines = useApi(api.machines);
  const folders = useSavedFolders();
  const modals = useModals();
  const { show } = useToasts();
  const [templates, setTemplates] = useState<readonly TeamTemplate[]>([]);
  const [suggestions, setSuggestions] = useState<readonly TeamSuggestion[] | null>(null);
  const [laterIds, setLaterIds] = useState<readonly string[] | null>(() => bannerLaterIds());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelShown, setPanelShown] = useState(false);
  const [tab, setTab] = useState<PanelTab>('chat');
  const [focus, setFocus] = useState<SettingsFocus>(null);
  const [composerFocus, setComposerFocus] = useState(0);
  const [accessFocus, setAccessFocus] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [menu, setMenu] = useState<{ readonly memberId: string; readonly at: { readonly x: number; readonly y: number } } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [layoutSidebar, setLayoutSidebar] = useState<SidebarLayout | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** D100 follow-up 2026-10-14: the order just chosen, shown until the server's answer is read back. */
  const [pendingOrder, setPendingOrder] = useState<readonly string[] | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const loadSuggestions = useCallback(() => {
    teamApi
      .suggestions()
      .then(setSuggestions)
      .catch(() => setSuggestions([]));
  }, []);
  useEffect(() => {
    if (!on) return;
    teamApi.templates().then(setTemplates, () => setTemplates([]));
    loadSuggestions();
    api.sidebarLayout().then(setLayoutSidebar, () => setLayoutSidebar(null));
  }, [on, loadSuggestions]);

  const members = inOrder(view?.members ?? [], pendingOrder as string[] | null);
  const counts = useMemo(() => needsYouCounts(items), [items]);
  const selected = members.find((member) => member.id === selectedId) ?? (phone ? null : (members[0] ?? null));
  const selfId = view?.self.id ?? machines.data?.self.id ?? '';
  const peerMachines = machines.data?.machines ?? [];
  const peers = syncedPeers(peerMachines);
  const templateOf = (id: string | null): TeamTemplate | null => templates.find((template) => template.id === id) ?? null;
  const placeOf = (member: TeamMember): string => placeLabel(member.originalPlace, layoutSidebar);
  const memberRefs = new Set(members.map((member) => member.sessionRef));
  const openList = openSessions(sessions.data ?? []).filter((session) => !memberRefs.has(session.id));
  const suggestionIds = (suggestions ?? []).filter((s) => !memberRefs.has(s.sessionId)).map((s) => s.sessionId);
  const banner = bannerVisible(suggestionIds, laterIds);

  const refresh = (): void => {
    void reloadTeam();
    loadSuggestions();
  };
  const select = (member: TeamMember): void => {
    setSelectedId(member.id);
    setPanelShown(true);
    setFocus(null);
    setAccessFocus(null);
  };
  const toast = (text: string): void => show({ id: `team-${Date.now()}`, title: 'Team', sub: 'now', branch: '', text, sessionId: null });

  const onAdopted = (member: TeamMember, title: string): void => {
    setOpen(null);
    toast(adoptedToast(title, member.name));
    setSelectedId(member.id);
    setTab('chat');
    refresh();
  };
  const pickFromReview = (pick: ReviewPick): void => {
    if (pick.kind === 'create') {
      setOpen({ kind: 'form', target: createTarget(pick.template) });
      return;
    }
    const sessionId = pick.kind === 'adopt' ? pick.suggestion.sessionId : pick.sessionId;
    const title = pick.kind === 'adopt' ? pick.suggestion.title : pick.title;
    const form = pick.kind === 'adopt' ? pick.form : formFromTemplate(null);
    setOpen({ kind: 'form', target: { kind: 'adopt', sessionId, title, place: sessionPlace(sessionId), form } });
  };
  /** Where a session sits in the sidebar now (the adopt note names it). */
  const sessionPlace = (sessionId: string): string => {
    if (!layoutSidebar) return 'Sessions';
    if (layoutSidebar.pinned.includes(sessionId)) return 'Pinned';
    const folder = layoutSidebar.folders.find((f) => f.sessionIds.includes(sessionId));
    return folder ? folder.name : 'Sessions';
  };

  const doReturn = async (member: TeamMember): Promise<void> => {
    setActionError(null);
    try {
      const place = placeOf(member);
      const title = member.sessionTitle ?? member.sessionId;
      const { sessionId } = await teamApi.returnMember(member.id);
      toast(returnedToast(title, place));
      highlightReturnedRow(sessionId);
      if (selectedId === member.id) setSelectedId(null);
      setPanelShown(false);
      refresh();
    } catch (caught) {
      setActionError(refusalText(caught));
    }
  };
  /** Saves a new order at once (shown before the answer; `teamChanged` shows it on the other machines). */
  const reorder = (ids: readonly string[]): void => {
    setPendingOrder(ids);
    setActionError(null);
    teamApi
      .reorder(ids, teamId)
      .then(() => reloadTeam())
      .catch((caught: unknown) => setActionError(refusalText(caught)))
      .finally(() => setPendingOrder((current) => (current === ids ? null : current)));
  };
  const pickMenu = (member: TeamMember, item: MenuItem): void => {
    setMenu(null);
    switch (item.id) {
      case 'order-back':
      case 'order-forward': {
        const next = moveInOrder(
          members.map((m) => m.id),
          member.id,
          item.id === 'order-back' ? -1 : 1,
        );
        if (next) reorder(next);
        return;
      }
      case 'task':
        setOpen({ kind: 'task', memberId: member.id });
        return;
      case 'charter':
      case 'model':
      case 'budget':
        select(member);
        setTab('settings');
        setFocus(item.id);
        return;
      case 'schedule':
        modals.open('loop', { loop: { sessionId: member.sessionRef } });
        return;
      case 'pause':
      case 'resume':
        void (item.id === 'pause' ? teamApi.pause(member.id) : teamApi.resume(member.id)).then(refresh, (caught: unknown) => setActionError(refusalText(caught)));
        return;
      case 'move': {
        const target = item.machineId === selfId ? { id: selfId, name: view?.self.name ?? 'this machine' } : peerMachines.find((machine) => machine.id === item.machineId);
        if (target) setOpen({ kind: 'move', memberId: member.id, target: { id: target.id, name: target.name } });
        return;
      }
      case 'return':
        void doReturn(member);
        return;
      case 'team': {
        const to = teams.find((team) => team.id === item.teamId);
        if (!to) return;
        setActionError(null);
        void teamApi.moveToTeam(member.id, to.id).then(
          () => {
            toast(`${member.name} moved to team ${to.name}`);
            if (selectedId === member.id) setSelectedId(null);
            refresh();
          },
          (caught: unknown) => setActionError(refusalText(caught)),
        );
        return;
      }
    }
  };
  const openTeam = (id: string): void => navigate({ view: 'team', teamId: id });
  /** All teams tab: Reply… / Set up… open the member in its team. */
  const inItsTeam = (memberId: string): void => {
    const item = allItems.find((i) => i.memberId === memberId);
    if (item?.teamId) openTeam(item.teamId);
  };
  const modelOf = (member: TeamMember): string => modelLine(sessions.data?.find((session) => session.id === member.sessionRef)?.model, member);
  const moveTargetsOf = (member: TeamMember): { id: string; name: string; online: boolean }[] =>
    [{ id: selfId, name: view?.self.name ?? 'this machine', online: true }, ...peerMachines.map((machine) => ({ id: machine.id, name: machine.name, online: machine.state === 'online' }))].filter((target) => target.id !== member.machineId);

  if (!on) {
    return (
      <section className="sb-view sb-team" data-view="team" data-testid="view-team" data-state="off">
        <div className="sb-team-empty">
          <div className="sb-team-empty__title">Team is off</div>
          <div className="sb-team-muted">Switch it on in Settings → Experimental → Team.</div>
          <Link to={{ view: 'settings', section: 'experimental' }} className="sb-button sb-team-btn sb-team-btn--primary" data-testid="team-open-switch">
            Open Settings
          </Link>
        </div>
      </section>
    );
  }

  // D100 follow-up 2026-10-14: the phone's list follows the team's order too (it is reorderable there); Needs you sits above it.
  const ordered = members;
  const firstNeedOf = (memberId: string) => items.find((item) => item.memberId === memberId) ?? null;
  const empty = loaded && view !== null && members.length === 0;
  const detail = phone && panelShown && selected !== null;
  const menuMember = menu ? members.find((member) => member.id === menu.memberId) : undefined;
  const openMember = (id: string): TeamMember | undefined => members.find((member) => member.id === id);

  const cards = (
    <ReorderStrip
      items={ordered}
      idOf={(member) => member.id}
      labelOf={(member) => member.name}
      axis={phone ? 'y' : 'x'}
      revealId={selected?.id ?? null}
      onReorder={(ids) => reorder(ids)}
      className="sb-team-cards"
      testId="team-cards"
    >
      {(member) => (
        <MemberCard
          member={member}
          status={cardStatus(member, counts)}
          needs={counts.get(member.id) ?? 0}
          firstNeed={firstNeedOf(member.id)}
          activity={activityOf(member.sessionRef)}
          selected={selected?.id === member.id}
          showMachine
          now={now}
          onSelect={() => select(member)}
          onMenu={(at) => setMenu({ memberId: member.id, at })}
        />
      )}
    </ReorderStrip>
  );

  const tabs = detail ? null : (
    <TeamTabs
      teams={teams}
      current={allTab ? ALL_TEAMS : teamId}
      onPick={openTeam}
      onReorder={(ids) => {
        setActionError(null);
        teamApi.reorderTeams(ids).then(() => reloadTeam(), (caught: unknown) => setActionError(refusalText(caught)));
      }}
      onNew={() => setOpen({ kind: 'new-team' })}
    />
  );
  const teamDialogs = (
    <>
      {open?.kind === 'new-team' ? (
        <NewTeamDialog
          onClose={() => setOpen(null)}
          onDone={(team) => {
            setOpen(null);
            toast(`Team ${team.name} created`);
            created.current = team.id;
            openTeam(team.id);
            refresh();
          }}
        />
      ) : null}
      {open?.kind === 'delete-team' && view ? (
        <DeleteTeamDialog
          team={view.team}
          members={members.length}
          onClose={() => setOpen(null)}
          onDone={(returned) => {
            setOpen(null);
            toast(returned === 0 ? `Team ${view.team.name} deleted` : `Team ${view.team.name} deleted: ${returned === 1 ? 'its member is' : `${returned} members are`} back in your session list`);
            navigate({ view: 'team', teamId: DEFAULT_TEAM_ID }, { replace: true });
            refresh();
          }}
        />
      ) : null}
    </>
  );

  if (allTab) {
    return (
      <section className="sb-view sb-team" data-view="team" data-testid="view-team" data-layout={layout} data-team-id={ALL_TEAMS} data-state="all">
        {tabs}
        <header className="sb-team-header" data-testid="team-header">
          <div className="sb-team-header__main">
            <h1 className="sb-team-title">All teams</h1>
            <span className="sb-team-counts" data-testid="team-counts">
              {teams.length} team{teams.length === 1 ? '' : 's'} · {allItems.length} waiting for you
            </span>
          </div>
        </header>
        {error ? (
          <div className="sb-team-error" role="alert" data-testid="team-load-error">
            {error}
          </div>
        ) : null}
        <div className="sb-team-all" data-testid="team-all">
          <NeedsYouList
            items={allItems}
            showTeam
            onReply={(memberId) => {
              inItsTeam(memberId);
              replyTo(memberId);
            }}
            onSetUp={(memberId, accessId) => {
              inItsTeam(memberId);
              setUpAccess(memberId, accessId);
            }}
            onChanged={refresh}
          />
        </div>
        {teamDialogs}
      </section>
    );
  }

  return (
    <section className="sb-view sb-team" data-view="team" data-testid="view-team" data-layout={layout} data-team-id={teamId} data-pane={phone ? (detail ? 'detail' : 'list') : undefined} data-state={empty ? 'empty' : 'populated'}>
      {tabs}
      {detail ? null : (
        <header className="sb-team-header" data-testid="team-header">
          <div className="sb-team-header__main">
            <TeamTitle key={teamId} teamId={teamId} name={view?.team.name ?? teams.find((team) => team.id === teamId)?.name ?? DEFAULT_TEAM_NAME} onRenamed={refresh} />
            {peers.length > 0 ? (
              <span className="sb-team-synced" data-testid="team-synced">
                ⇄ synced with {peers.join(', ')}
              </span>
            ) : null}
            <span className="sb-team-counts" data-testid="team-counts">
              {headerCounts(members, items)}
            </span>
          </div>
          <div className="sb-team-header__actions">
            {teamId !== DEFAULT_TEAM_ID && view ? (
              <button type="button" className="sb-button sb-team-btn sb-team-btn--ghost" data-testid="team-delete" onClick={() => setOpen({ kind: 'delete-team' })}>
                Delete team…
              </button>
            ) : null}
            <button type="button" className="sb-button sb-team-btn sb-team-btn--primary" data-testid="team-add" data-tour="team-add" onClick={() => setOpen({ kind: 'add' })}>
              ＋ Member
            </button>
          </div>
        </header>
      )}
      {!detail && banner ? (
        <div className="sb-team-banner" data-testid="team-banner" role="status">
          <span>{bannerText(suggestionIds.length)}</span>
          <button type="button" className="sb-button sb-team-btn sb-team-btn--primary" data-testid="team-banner-review" onClick={() => setOpen({ kind: 'review' })}>
            Review
          </button>
          <button
            type="button"
            className="sb-button sb-team-btn sb-team-btn--ghost"
            data-testid="team-banner-later"
            onClick={() => {
              setBannerLater(suggestionIds);
              setLaterIds(suggestionIds);
            }}
          >
            Later
          </button>
        </div>
      ) : null}
      {error && !detail ? (
        <div className="sb-team-error" role="alert" data-testid="team-load-error">
          {error}
        </div>
      ) : null}
      {actionError ? (
        <div className="sb-team-error" role="alert" data-testid="team-action-error">
          {actionError}
        </div>
      ) : null}
      {empty ? (
        <div className="sb-team-empty" data-testid="team-empty">
          <div className="sb-team-empty__title">No team members yet</div>
          <div className="sb-team-muted">Adopt one of your sessions, or start a new member from a template.</div>
          <div className="sb-team-need__actions">
            <button type="button" className="sb-button sb-team-btn" data-testid="team-empty-review" onClick={() => setOpen({ kind: 'review' })}>
              Review suggestions
            </button>
            <button type="button" className="sb-button sb-team-btn sb-team-btn--primary" data-testid="team-empty-add" onClick={() => setOpen({ kind: 'add' })}>
              ＋ Member
            </button>
          </div>
        </div>
      ) : null}
      {!empty && detail && selected ? (
        <MemberPanel
          member={selected}
          status={cardStatus(selected, counts)}
          modelText={modelOf(selected)}
          tab={tab}
          onTab={setTab}
          focus={focus}
          accessFocus={accessFocus}
          composerFocus={composerFocus}
          phone
          moveTargets={moveTargetsOf(selected)}
          onBack={() => setPanelShown(false)}
          onMenu={(at) => setMenu({ memberId: selected.id, at })}
          onMove={(id) => {
            const target = moveTargetsOf(selected).find((t) => t.id === id);
            if (target) setOpen({ kind: 'move', memberId: selected.id, target });
          }}
          onChanged={refresh}
        />
      ) : null}
      {!empty && !detail && members.length > 0 ? (
        <div className="sb-team-body" data-testid="team-body">
          {phone ? (
            <>
              <NeedsYouList items={items} onReply={(memberId) => replyTo(memberId)} onSetUp={setUpAccess} onChanged={refresh} />
              {cards}
              <ActivityFeed activity={view?.activity ?? []} members={members} />
            </>
          ) : (
            <>
              <div className="sb-team-top">{cards}</div>
              <div className="sb-team-split" data-testid="team-split">
                <div className="sb-team-left">
                  <NeedsYouList items={items} onReply={(memberId) => replyTo(memberId)} onSetUp={setUpAccess} onChanged={refresh} />
                  <ActivityFeed activity={view?.activity ?? []} members={members} />
                </div>
                {selected ? (
                  <MemberPanel
                    member={selected}
                    status={cardStatus(selected, counts)}
                    modelText={modelOf(selected)}
                    tab={tab}
                    onTab={setTab}
                    focus={focus}
                    accessFocus={accessFocus}
                    composerFocus={composerFocus}
                    phone={false}
                    moveTargets={moveTargetsOf(selected)}
                    onBack={() => setPanelShown(false)}
                    onMenu={(at) => setMenu({ memberId: selected.id, at })}
                    onMove={(id) => {
                      const target = moveTargetsOf(selected).find((t) => t.id === id);
                      if (target) setOpen({ kind: 'move', memberId: selected.id, target });
                    }}
                    onChanged={refresh}
                  />
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}

      {menu && menuMember ? (
        <MemberMenu items={memberMenu(menuMember, peerMachines, selfId, placeOf(menuMember), { index: ordered.indexOf(menuMember), count: ordered.length, vertical: phone }, teams)} at={menu.at} onPick={(item) => pickMenu(menuMember, item)} onClose={() => setMenu(null)} />
      ) : null}
      {open?.kind === 'add' ? (
        <AddMemberDialog
          onClose={() => setOpen(null)}
          onPick={(how) => {
            if (how === 'template') setOpen({ kind: 'templates' });
            else if (how === 'scratch') setOpen({ kind: 'form', target: createTarget(null) });
            else setOpen(suggestionIds.length > 0 ? { kind: 'review' } : { kind: 'sessions' });
          }}
        />
      ) : null}
      {open?.kind === 'templates' ? <TemplatePicker templates={templates} onClose={() => setOpen(null)} onPick={(template) => setOpen({ kind: 'form', target: createTarget(template) })} /> : null}
      {open?.kind === 'sessions' ? (
        <SessionPicker
          sessions={openList}
          onClose={() => setOpen(null)}
          onPick={(session) => {
            const suggestion = suggestions?.find((s) => s.sessionId === session.id);
            const template = suggestion ? templateOf(suggestion.templateId) : null;
            const form = suggestion ? formFromSuggestion(suggestion, template, null, []) : formFromTemplate(null);
            setOpen({ kind: 'form', target: { kind: 'adopt', sessionId: session.id, title: displayTitle(session), place: sessionPlace(session.id), form } });
          }}
        />
      ) : null}
      {open?.kind === 'review' ? <ReviewDialog suggestions={suggestions} templates={templates} sessions={sessionsForReview(openList)} members={members} onPick={pickFromReview} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'form' ? (
        <MemberFormDialog
          target={open.target}
          folders={folders.data}
          teams={teams}
          teamId={teamId}
          onClose={() => setOpen(null)}
          onDone={(member) => {
            // It may have joined another team (the form's Team picker): show that team.
            if (member.teamId !== teamId) openTeam(member.teamId);
            if (open.target.kind === 'adopt') onAdopted(member, open.target.title);
            else {
              setOpen(null);
              toast(`${member.name} joined the team in a new session`);
              setSelectedId(member.id);
              setTab('chat');
              refresh();
            }
          }}
        />
      ) : null}
      {open?.kind === 'task' && openMember(open.memberId) ? (
        <GiveTaskDialog
          member={openMember(open.memberId) as TeamMember}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            toast(`Task given to ${openMember(open.memberId)?.name ?? 'the member'}`);
            refresh();
          }}
        />
      ) : null}
      {open?.kind === 'move' && openMember(open.memberId) ? (
        <MoveDialog
          member={openMember(open.memberId) as TeamMember}
          target={open.target}
          onClose={() => {
            setOpen(null);
            refresh();
          }}
          onDone={refresh}
        />
      ) : null}
      {teamDialogs}
    </section>
  );

  function setUpAccess(memberId: string, accessId: string): void {
    setSelectedId(memberId);
    setPanelShown(true);
    setAccessFocus(accessId);
    setTab('access');
  }

  function replyTo(memberId: string): void {
    setSelectedId(memberId);
    setPanelShown(true);
    setTab('chat');
    setComposerFocus((n) => n + 1);
  }
}

/**
 * The page title: "Team", or "Team · <name>" once renamed. A click edits the name in
 * place (`PUT /api/team`); Enter or leaving the field saves, Escape cancels, an empty
 * name goes back to the default.
 */
function TeamTitle({ teamId, name, onRenamed }: { readonly teamId: string; readonly name: string; readonly onRenamed: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async (value: string): Promise<void> => {
    // An empty name: the first team goes back to "Team"; another team keeps its name.
    const next = value.replace(/\s+/g, ' ').trim() || (teamId === DEFAULT_TEAM_ID ? DEFAULT_TEAM_NAME : name);
    setEditing(null);
    if (next === name) return;
    try {
      // D100 follow-up 2026-10-14: the shown team.
      await teamApi.rename(next, teamId === DEFAULT_TEAM_ID ? undefined : teamId);
      setError(null);
      onRenamed();
    } catch (caught) {
      setError(refusalText(caught));
    }
  };
  if (editing !== null) {
    return (
      <span className="sb-team-title-edit">
        <span className="sb-team-title">Team ·</span>
        <input
          className="sb-team-input sb-team-title-input"
          data-testid="team-title-input"
          aria-label="Team name"
          autoFocus
          maxLength={TEAM_NAME_MAX}
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          onBlur={() => void save(editing)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save(editing);
            if (event.key === 'Escape') setEditing(null);
          }}
        />
      </span>
    );
  }
  return (
    <>
      <h1 className="sb-team-title">
        <button type="button" className="sb-button sb-team-title-button" data-testid="team-title" title="Rename the team" onClick={() => setEditing(name === DEFAULT_TEAM_NAME ? '' : name)}>
          {teamTitle(name)}
        </button>
      </h1>
      {error ? (
        <span className="sb-team-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
