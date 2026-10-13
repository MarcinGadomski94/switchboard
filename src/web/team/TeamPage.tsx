import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SidebarLayout } from '../../core/sidebar-layout.ts';
import type { TeamMember, TeamSuggestion } from '../../core/team.ts';
import type { TeamTemplate } from '../../core/team-templates.ts';
import { displayTitle } from '../../core/session-title.ts';
import { openSessions } from '../../core/session-close.ts';
import { useLiveActivities } from '../activity/useActivity.ts';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useSessionListOf } from '../api/session-list.ts';
import { useSavedFolders } from '../folders/useFolders.ts';
import { useModals } from '../modals/ModalHost.tsx';
import { Link } from '../router.tsx';
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
import { bannerLaterIds, highlightReturnedRow, setBannerLater } from './local.ts';
import { MemberCard } from './MemberCard.tsx';
import { MemberPanel, type PanelTab, type SettingsFocus } from './MemberPanel.tsx';
import { type MenuItem, adoptedToast, bannerText, bannerVisible, cardStatus, formFromSuggestion, formFromTemplate, headerCounts, memberMenu, needsYouCounts, phoneOrder, placeLabel, returnedToast, syncedPeers } from './model.ts';
import { ActivityFeed, NeedsYouList } from './NeedsYou.tsx';
import { reloadTeam, useTeamData } from './useTeamData.ts';
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
  | null;

/**
 * D100 · the Team page (`/team`, `docs/team.md` → *The Team page*): the header (name,
 * "⇄ synced with <PC>", the counts, ＋ Member), the suggestions banner, the member
 * cards, Needs you and Activity on the left, the selected member's panel on the
 * right (tablet: two columns; phone: a list with Needs you first and the panel full
 * screen with "‹ Team"). Shown only while Team is on; otherwise it points to the switch.
 */
export function TeamPage() {
  const { on } = useTeamSwitch();
  const layout = useLayout();
  const phone = layout === 'phone';
  const { view, needsYou: items, error, loaded } = useTeamData();
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
  const [open, setOpen] = useState<Open>(null);
  const [menu, setMenu] = useState<{ readonly memberId: string; readonly at: { readonly x: number; readonly y: number } } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [layoutSidebar, setLayoutSidebar] = useState<SidebarLayout | null>(null);
  const [now, setNow] = useState(() => Date.now());

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

  const members = view?.members ?? [];
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
  const pickMenu = (member: TeamMember, item: MenuItem): void => {
    setMenu(null);
    switch (item.id) {
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
    }
  };
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

  const ordered = phone ? phoneOrder(members, counts) : members;
  const firstNeedOf = (memberId: string) => items.find((item) => item.memberId === memberId) ?? null;
  const empty = loaded && members.length === 0;
  const detail = phone && panelShown && selected !== null;
  const menuMember = menu ? members.find((member) => member.id === menu.memberId) : undefined;
  const openMember = (id: string): TeamMember | undefined => members.find((member) => member.id === id);

  const cards = (
    <div className="sb-team-cards" data-testid="team-cards">
      {ordered.map((member) => (
        <MemberCard
          key={member.id}
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
      ))}
    </div>
  );

  return (
    <section className="sb-view sb-team" data-view="team" data-testid="view-team" data-layout={layout} data-pane={phone ? (detail ? 'detail' : 'list') : undefined} data-state={empty ? 'empty' : 'populated'}>
      {detail ? null : (
        <header className="sb-team-header" data-testid="team-header">
          <div className="sb-team-header__main">
            <h1 className="sb-team-title" data-testid="team-title">
              Team · {view?.team.name ?? 'Team'}
            </h1>
            {peers.length > 0 ? (
              <span className="sb-team-synced" data-testid="team-synced">
                ⇄ synced with {peers.join(', ')}
              </span>
            ) : null}
            <span className="sb-team-counts" data-testid="team-counts">
              {headerCounts(members, items)}
            </span>
          </div>
          <button type="button" className="sb-button sb-team-btn sb-team-btn--primary" data-testid="team-add" data-tour="team-add" onClick={() => setOpen({ kind: 'add' })}>
            ＋ Member
          </button>
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
          tab={tab}
          onTab={setTab}
          focus={focus}
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
              <NeedsYouList items={items} onReply={(memberId) => replyTo(memberId)} onChanged={refresh} />
              {cards}
              <ActivityFeed activity={view?.activity ?? []} members={members} />
            </>
          ) : (
            <>
              <div className="sb-team-left">
                {layout === 'tablet' ? cards : null}
                <NeedsYouList items={items} onReply={(memberId) => replyTo(memberId)} onChanged={refresh} />
                <ActivityFeed activity={view?.activity ?? []} members={members} />
              </div>
              {layout === 'desktop' ? <div className="sb-team-middle">{cards}</div> : null}
              {selected ? (
                <MemberPanel
                  member={selected}
                  status={cardStatus(selected, counts)}
                  tab={tab}
                  onTab={setTab}
                  focus={focus}
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
            </>
          )}
        </div>
      ) : null}

      {menu && menuMember ? (
        <MemberMenu items={memberMenu(menuMember, peerMachines, selfId, placeOf(menuMember))} at={menu.at} onPick={(item) => pickMenu(menuMember, item)} onClose={() => setMenu(null)} />
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
          onClose={() => setOpen(null)}
          onDone={(member) => {
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
    </section>
  );

  function replyTo(memberId: string): void {
    setSelectedId(memberId);
    setPanelShown(true);
    setTab('chat');
    setComposerFocus((n) => n + 1);
  }
}
