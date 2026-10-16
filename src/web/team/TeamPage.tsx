import { isChat } from '../../core/chats.ts';
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
import { bannerLaterIds, clearRequestedMember, highlightReturnedRow, lastTeam, leftColumnCollapsed, onMemberRequested, requestedMemberId, setBannerLater, setLastTeam, setLeftColumnCollapsed, setLeftColumnSeenAt, setSectionCollapsed } from './local.ts';
import { LeftColumn, type LeftFocus } from './LeftColumn.tsx';
import { newestAt } from './activity.ts';
import { isTextEntry } from '../shell/panes.ts';
import { MemberCard } from './MemberCard.tsx';
import { MemberPanel, type PanelTab, type SettingsFocus } from './MemberPanel.tsx';
import { type MenuItem, adoptedToast, canDropOnTeam, movedToast, restoredOrder, isLeftColumnShortcut, charterAskedToast, charterOfferText, modelLine, teamTitle, bannerText, bannerVisible, cardStatus, formFromSuggestion, formFromTemplate, headerCounts, inOrder, memberMenu, moveInOrder, needsYouCounts, placeLabel, returnedToast, syncedPeers } from './model.ts';
import { ReorderStrip } from './ReorderStrip.tsx';
import { DeleteTeamDialog, NewTeamDialog, TeamTabs, teamTabAt } from './TeamTabs.tsx';
import { ActivityFeed, NeedsYouList } from './NeedsYou.tsx';
import { reloadTeam, showTeam, useTeamData } from './useTeamData.ts';
// Project memory (D107) hook: "Draft memory from this session" (⋯) and "Draft memory for all members" (the header) (docs/memory-removal.md).
import { DRAFT_ALL_LABEL, DRAFT_MEMORY_LABEL, draftAllText, draftAnswerText, draftMemory, draftMemoryForMembers } from '../memory/draft.ts';
import { useMemory } from '../memory/store.ts';
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
  const teamId = view?.team.id ?? (routeTeam !== null && routeTeam !== ALL_TEAMS ? routeTeam : (teams[0]?.id ?? DEFAULT_TEAM_ID));
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
  /** D105: the one-time offer was just answered here (hidden before the next read). */
  const [offerAnswered, setOfferAnswered] = useState(false);
  const [drafting, setDrafting] = useState(false);
  /** D100 follow-up 2026-10-14: the member card being dragged (the other teams' tabs are drop targets meanwhile). */
  const [lifted, setLifted] = useState<string | null>(null);
  /** The team tabs' feed of a held finger's point (`TeamTabs`). */
  const tabsTouch = useRef<((point: { readonly x: number; readonly y: number } | null) => void) | null>(null);

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
  // D106: chats are never members nor suggested.
  const openList = openSessions(sessions.data ?? []).filter((session) => !memberRefs.has(session.id) && !isChat(session));
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
  // D100 follow-up 2026-10-16: a member row of the sidebar opens that member here, selected, on its chat.
  const [requested, setRequested] = useState<string | null>(() => requestedMemberId());
  useEffect(() => onMemberRequested(() => setRequested(requestedMemberId())), []);
  useEffect(() => {
    if (requested === null) return;
    const member = members.find((m) => m.id === requested);
    if (!member) return;
    clearRequestedMember(requested);
    setRequested(null);
    setSelectedId(member.id);
    setPanelShown(true);
    setTab('chat');
    setFocus(null);
    setAccessFocus(null);
  }, [requested, members]);
  // D100 follow-up 2026-10-16: the whole left column folds to a slim strip (remembered in this browser; "[" toggles it).
  const [leftCollapsed, setLeftCollapsed] = useState(() => leftColumnCollapsed());
  const [leftSliding, setLeftSliding] = useState(false);
  const leftFocus = useRef<LeftFocus>(null);
  const activityRef = useRef(view?.activity ?? []);
  activityRef.current = view?.activity ?? [];
  const foldLeft = useCallback((collapsed: boolean, focusTo: LeftFocus): void => {
    if (collapsed) setLeftColumnSeenAt(newestAt(activityRef.current) ?? new Date(0).toISOString());
    // The badge shows Needs you itself: its own fold opens too.
    if (focusTo === 'needs') setSectionCollapsed('needs', false);
    setLeftColumnCollapsed(collapsed);
    leftFocus.current = focusTo;
    setLeftSliding(true);
    setLeftCollapsed(collapsed);
  }, []);
  useEffect(() => {
    if (!leftSliding) return undefined;
    const timer = setTimeout(() => setLeftSliding(false), 400);
    return () => clearTimeout(timer);
  }, [leftSliding, leftCollapsed]);
  const leftCollapsedRef = useRef(leftCollapsed);
  leftCollapsedRef.current = leftCollapsed;
  useEffect(() => {
    if (!on || phone) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      // Only while the split (cards above, the left column | the member panel) is on screen.
      if (!document.querySelector('[data-testid="team-split"]')) return;
      const focused = event.target instanceof Element ? event.target : document.activeElement;
      const typing = isTextEntry(
        focused ? { tagName: focused.tagName, type: focused instanceof HTMLInputElement ? focused.type : null, isContentEditable: focused instanceof HTMLElement && focused.isContentEditable } : null,
      );
      if (!isLeftColumnShortcut(event, { typing, modalOpen: document.querySelector('[aria-modal="true"]') !== null })) return;
      event.preventDefault();
      // The focus moves only when it sat in the column (which is replaced).
      const inColumn = focused instanceof Element && focused.closest('[data-testid="team-left"], [data-testid="team-left-strip"]') !== null;
      const folding = !leftCollapsedRef.current;
      foldLeft(folding, inColumn ? (folding ? 'strip' : 'collapse') : null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [on, phone, foldLeft]);
  const toast = (text: string): void => show({ id: `team-${Date.now()}`, title: 'Team', sub: 'now', branch: '', text, sessionId: null });
  // Project memory (D107) hook: the members' own agents propose memory (nothing is applied; the Memory page reviews it).
  const memoryOn = useMemory().on;
  const [draftingMemory, setDraftingMemory] = useState(false);
  const draftAllMemory = (scope: string): void => {
    setActionError(null);
    setDraftingMemory(true);
    draftMemoryForMembers(scope)
      .then(
        (answer) => toast(draftAllText(answer)),
        (caught: unknown) => setActionError(refusalText(caught)),
      )
      .finally(() => setDraftingMemory(false));
  };

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
  /**
   * D100 follow-up 2026-10-14 · moves a member to another team (a card dropped on a
   * team tab, Settings → Team, ⋯ Move to team ▸): "Moved <member> to <team>" with
   * Undo, which moves it back to its old team and place.
   */
  const moveToTeam = (member: TeamMember, toId: string): void => {
    const fromId = member.teamId || teamId;
    const to = teams.find((team) => team.id === toId);
    // One team per session: its own team (or All teams, or a team gone meanwhile) is no move.
    if (!to || !canDropOnTeam(teams, fromId, to.id)) return;
    const before = members.map((m) => m.id);
    setActionError(null);
    teamApi.moveToTeam(member.id, to.id).then(
      () => {
        if (selectedId === member.id) setSelectedId(null);
        show({
          id: `team-move-${member.id}`,
          title: 'Team',
          sub: 'now',
          branch: '',
          text: movedToast(member.name, to.name),
          sessionId: null,
          action: { label: 'Undo', run: () => void undoMove(member, fromId, before) },
        });
        refresh();
      },
      (caught: unknown) => setActionError(refusalText(caught)),
    );
  };
  /** Undo of a move: back to its old team, then that team's order as it was. */
  const undoMove = async (member: TeamMember, fromId: string, before: readonly string[]): Promise<void> => {
    setActionError(null);
    try {
      await teamApi.moveToTeam(member.id, fromId);
      const back = await teamApi.view(fromId);
      const order = restoredOrder(
        before,
        back.members.map((m) => m.id),
      );
      if (order) await teamApi.reorder(order, fromId);
      setSelectedId(member.id);
      refresh();
    } catch (caught) {
      setActionError(refusalText(caught));
    }
  };
  /** A held card released by a finger away from the strip: on a team tab, a move. */
  const touchDropOutside = (memberId: string, point: { readonly x: number; readonly y: number }): void => {
    tabsTouch.current?.(null);
    const target = teamTabAt(point.x, point.y);
    const member = members.find((m) => m.id === memberId);
    if (target && member) moveToTeam(member, target);
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
      case 'redraft':
        setActionError(null);
        void teamApi.askCharter(member.id).then(
          () => {
            toast(`Asked ${member.name} to draft a specific charter from its own session. Its proposal shows in Needs you.`);
            refresh();
          },
          (caught: unknown) => setActionError(refusalText(caught)),
        );
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
      case 'team':
        if (item.teamId) moveToTeam(member, item.teamId);
        return;
      // Project memory (D107) hook.
      case 'draft-memory':
        setActionError(null);
        void draftMemory({ memberId: member.id }).then(
          (answer) => toast(draftAnswerText(answer, member.name)),
          (caught: unknown) => setActionError(refusalText(caught)),
        );
        return;
    }
  };
  const openTeam = (id: string): void => navigate({ view: 'team', teamId: id });
  /** D105 · Draft better charters: asks the members of this team (`all`: every team) for specific charters; `templateOnly` from the one-time offer. */
  const draftCharters = (scope: string, templateOnly = false): void => {
    setActionError(null);
    setDrafting(true);
    setOfferAnswered(true);
    teamApi
      .askCharters(scope, templateOnly)
      .then(
        (answer) => {
          toast(charterAskedToast(answer));
          refresh();
        },
        (caught: unknown) => setActionError(refusalText(caught)),
      )
      .finally(() => setDrafting(false));
  };
  const offer = offerAnswered ? 0 : (view?.charterOffer ?? 0);
  /** All teams tab: Reply… / Set up… open the member in its team. */
  const inItsTeam = (memberId: string): void => {
    const item = allItems.find((i) => i.memberId === memberId);
    if (item?.teamId) openTeam(item.teamId);
  };
  /** The listed session (its model, effort, reported models and CLI: the model dropdown). */
  const sessionOf = (ref: string) => sessions.data?.find((session) => session.id === ref);
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
  const liftedMember = lifted ? openMember(lifted) : undefined;

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
      tour="team-cards"
      onLift={setLifted}
      onTouchDrag={(_id, point) => tabsTouch.current?.(point)}
      onTouchDropOutside={touchDropOutside}
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
      memberDrag={liftedMember ? { memberId: liftedMember.id, teamId: liftedMember.teamId || teamId } : null}
      onMemberDrop={(target) => {
        if (liftedMember) moveToTeam(liftedMember, target);
      }}
      touchRef={tabsTouch}
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
            // The first remaining team (the first team itself may be the one deleted, D100 follow-up 2026-10-14).
            navigate({ view: 'team', teamId: teams.find((team) => team.id !== view.team.id)?.id ?? DEFAULT_TEAM_ID }, { replace: true });
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
          <div className="sb-team-header__actions">
            {/* D105: every team's members. */}
            <button type="button" className="sb-button sb-team-btn" data-testid="team-draft-charters" data-tour="team-draft-charters" disabled={drafting} onClick={() => draftCharters(ALL_TEAMS)}>
              Draft better charters
            </button>
            {/* Project memory (D107) hook: every team's members propose memory from their own sessions. */}
            {memoryOn ? (
              <button type="button" className="sb-button sb-team-btn" data-testid="team-draft-memory" disabled={draftingMemory} onClick={() => draftAllMemory(ALL_TEAMS)}>
                {DRAFT_ALL_LABEL}
              </button>
            ) : null}
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
            onEditCharter={(memberId) => {
              inItsTeam(memberId);
              editCharter(memberId);
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
            {/* Any team while another one remains (the first team too). */}
            {teams.length > 1 && view ? (
              <button type="button" className="sb-button sb-team-btn sb-team-btn--ghost" data-testid="team-delete" onClick={() => setOpen({ kind: 'delete-team' })}>
                Delete team…
              </button>
            ) : null}
            {/* D105: this team's members' own agents propose specific charters (Needs you). */}
            {members.length > 0 ? (
              <button type="button" className="sb-button sb-team-btn" data-testid="team-draft-charters" data-tour="team-draft-charters" disabled={drafting} onClick={() => draftCharters(teamId)}>
                Draft better charters
              </button>
            ) : null}
            {/* Project memory (D107) hook: this team's members propose memory from their own sessions. */}
            {memoryOn && members.length > 0 ? (
              <button type="button" className="sb-button sb-team-btn" data-testid="team-draft-memory" data-tour="team-draft-memory" disabled={draftingMemory} onClick={() => draftAllMemory(teamId)}>
                {DRAFT_ALL_LABEL}
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
      {!detail && offer > 0 ? (
        <div className="sb-team-banner" data-testid="team-charter-offer" role="status">
          <span>{charterOfferText(offer)}</span>
          <button type="button" className="sb-button sb-team-btn sb-team-btn--primary" data-testid="team-charter-offer-draft" disabled={drafting} onClick={() => draftCharters(ALL_TEAMS, true)}>
            Draft better charters
          </button>
          <button
            type="button"
            className="sb-button sb-team-btn sb-team-btn--ghost"
            data-testid="team-charter-offer-later"
            onClick={() => {
              setOfferAnswered(true);
              teamApi.dismissCharterOffer().then(refresh, (caught: unknown) => setActionError(refusalText(caught)));
            }}
          >
            Not now
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
          sessionModel={sessionOf(selected.sessionRef)?.model}
          tab={tab}
          onTab={setTab}
          focus={focus}
          accessFocus={accessFocus}
          composerFocus={composerFocus}
          phone
          moveTargets={moveTargetsOf(selected)}
          teams={teams}
          onMoveTeam={(target) => moveToTeam(selected, target)}
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
              <NeedsYouList items={items} onReply={(memberId) => replyTo(memberId)} onSetUp={setUpAccess} onEditCharter={editCharter} onChanged={refresh} />
              {cards}
              <ActivityFeed activity={view?.activity ?? []} members={members} />
            </>
          ) : (
            <>
              <div className="sb-team-top">{cards}</div>
              <div className="sb-team-split" data-testid="team-split" data-left={leftCollapsed ? 'collapsed' : undefined} data-left-sliding={leftSliding ? 'true' : undefined}>
                <LeftColumn collapsed={leftCollapsed} items={items} activity={view?.activity ?? []} focus={leftFocus} onFold={foldLeft}>
                  <NeedsYouList items={items} onReply={(memberId) => replyTo(memberId)} onSetUp={setUpAccess} onEditCharter={editCharter} onChanged={refresh} />
                  <ActivityFeed activity={view?.activity ?? []} members={members} />
                </LeftColumn>
                {selected ? (
                  <MemberPanel
                    member={selected}
                    status={cardStatus(selected, counts)}
                    modelText={modelOf(selected)}
                    sessionModel={sessionOf(selected.sessionRef)?.model}
                    tab={tab}
                    onTab={setTab}
                    focus={focus}
                    accessFocus={accessFocus}
                    composerFocus={composerFocus}
                    phone={false}
                    moveTargets={moveTargetsOf(selected)}
                    teams={teams}
                    onMoveTeam={(target) => moveToTeam(selected, target)}
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
        <MemberMenu
          items={withMemoryDraft(memberMenu(menuMember, peerMachines, selfId, placeOf(menuMember), { index: ordered.indexOf(menuMember), count: ordered.length, vertical: phone }, teams), memoryOn, menuMember.status === 'offline')}
          at={menu.at} onPick={(item) => pickMenu(menuMember, item)} onClose={() => setMenu(null)} />
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
          sessionModel={open.target.kind === 'adopt' ? sessionOf(open.target.sessionId)?.model : null}
          provider={open.target.kind === 'adopt' ? (sessionOf(open.target.sessionId)?.provider ?? null) : null}
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

  /** D105 Edit… of a charter proposal: the member's Settings with the proposal filled in. */
  function editCharter(memberId: string): void {
    setSelectedId(memberId);
    setPanelShown(true);
    setTab('settings');
    setFocus('proposal');
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
      await teamApi.rename(next, teamId);
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

/** Project memory (D107) hook: "Draft memory from this session" after Redraft charter in a member's ⋯ (only while Project memory is on). */
function withMemoryDraft(items: MenuItem[], on: boolean, offline: boolean): MenuItem[] {
  if (!on) return items;
  const at = items.findIndex((item) => item.id === 'redraft');
  const out = [...items];
  out.splice(at >= 0 ? at + 1 : out.length, 0, { id: 'draft-memory', label: DRAFT_MEMORY_LABEL, disabled: offline });
  return out;
}
