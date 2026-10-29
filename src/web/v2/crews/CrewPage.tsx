import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import type { TeamMember, TeamSummary, TeamView } from '../../../core/team.ts';
import { useMachines } from '../../api/useMachines.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { refusalText, teamApi } from '../../team/api.ts';
import { setLastTeam } from '../../team/local.ts';
import { modelLine, visibleMembers } from '../../team/model.ts';
import { reloadTeam, showTeam, useTeamData } from '../../team/useTeamData.ts';
import { useLayout } from '../../shell/useLayout.ts';
import { Avatar, Button, ComputerTag, EmptyState, Icon, IconButton, MenuButton, type MenuItem, Sheet, Skeleton, StatusBadge, Tabs, useToast } from '../components/index.ts';
import { CREW_WORDS, STATUS, type V2Status } from '../glossary.ts';
import { V2Link, useV2Router } from '../nav.tsx';
import { AnswerCard } from '../shared/AnswerCard.tsx';
import { useCrewPins } from '../shared/crew-pins.ts';
import { useNeedsYou } from '../shared/needs-you.ts';
import { useOpenAgent } from '../shared/open-agent.ts';
import type { NeedsItem } from '../shared/needs-you-model.ts';
import { clock } from '../shared/time.ts';
import { AccessPanel } from './AccessPanel.tsx';
import { ScrollText } from './ScrollText.tsx';
import { ArchivedLine, CrewAvatar, crewMenuItems, useCrewOrder } from './CrewsPage.tsx';
import { type TeammateTab, activityRows, budgetMeter, crewHref, crewLine, crewQuery, crewStats, handoffRows, moveComputerReason, openChatReason, rhythmText, teammateStatus, undoOrder, v2ModelText } from './crew-model.ts';
import { BudgetDialog, CharterEditDialog, DeleteCrewDialog, ModelDialog, MoveToComputerDialog, MoveToCrewDialog, NewTeammateDialog, RenameCrewDialog } from './dialogs.tsx';
import './crews.css';

type Overlay =
  | { readonly kind: 'crew'; readonly member: TeamMember }
  | { readonly kind: 'computer'; readonly member: TeamMember }
  | { readonly kind: 'budget'; readonly member: TeamMember }
  | { readonly kind: 'model'; readonly member: TeamMember }
  | { readonly kind: 'charter'; readonly member: TeamMember; readonly requestId: string }
  | { readonly kind: 'new-teammate' }
  | { readonly kind: 'rename'; readonly crew: TeamSummary }
  | { readonly kind: 'delete'; readonly crew: TeamSummary };

/** The teammate's job description in one paragraph: what it owns and produces. */
function jobText(member: Pick<TeamMember, 'charter'>): string {
  const parts = [member.charter.owns, member.charter.produces].map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'A new teammate. Give it a job description.';
}

/** What a teammate is doing, in one line. */
function workLine(member: TeamMember): string {
  if (member.status === 'offline') return `${member.machineName} is offline. ${member.name} is paused; nothing is lost.`;
  if (member.status === 'paused') return member.pausedBy === 'budget' ? 'Paused: over its daily budget' : 'Paused by you';
  if (member.status === 'working') return (member.subagents ?? 0) > 0 ? `Waiting on ${member.subagents} helper${member.subagents === 1 ? '' : 's'}` : 'Working…';
  if (member.status === 'needs-you') return 'Waiting for you';
  return 'Idle: waiting for a hand-off or its next routine';
}

/** The actions every teammate view shares. */
function useTeammateActions(view: TeamView | null, crews: readonly TeamSummary[], setOverlay: (overlay: Overlay | null) => void) {
  const toast = useToast();
  // Open chat peeks at the teammate's agent (its page on a phone).
  const openAgent = useOpenAgent();
  const machines = useMachines();
  const moveTo = async (member: TeamMember, crewId: string): Promise<void> => {
    const before = (view?.members ?? []).map((entry) => entry.id);
    const from = member.teamId;
    const target = crews.find((crew) => crew.id === crewId)?.name ?? 'the crew';
    try {
      await teamApi.moveToTeam(member.id, crewId);
      setOverlay(null);
      await reloadTeam();
      toast({
        text: CREW_WORDS.movedTo(member.name, target),
        undo: async () => {
          try {
            await teamApi.moveToTeam(member.id, from);
            const now = await teamApi.view(from);
            const order = undoOrder(
              before,
              now.members.map((entry) => entry.id),
            );
            if (order) await teamApi.reorder(order, from);
            await reloadTeam();
            toast({ text: `${member.name} is back in its crew.` });
          } catch (e) {
            toast({ text: refusalText(e), tone: 'error' });
          }
        },
      });
    } catch (e) {
      toast({ text: refusalText(e), tone: 'error' });
    }
  };
  const run = async (work: () => Promise<unknown>, text: string): Promise<void> => {
    try {
      await work();
      await reloadTeam();
      toast({ text });
    } catch (e) {
      toast({ text: refusalText(e), tone: 'error' });
    }
  };
  // Fix after 2.0 (2.4.5): the card itself, its Open chat button and ⋯ › Open chat all go here.
  const openChat = (member: TeamMember): void => {
    if (openChatReason(member) === null) openAgent(member.sessionRef);
  };
  const menu = (member: TeamMember, openAccess: () => void): MenuItem[] => {
    const charterOpen = member.charterRequest ?? null;
    const computerWhy = moveComputerReason(member, machines);
    const chatWhy = openChatReason(member);
    return [
      { id: 'open', label: CREW_WORDS.openChat, icon: 'chat', ...(chatWhy ? { disabledReason: chatWhy } : {}), onSelect: () => openChat(member) },
      { id: 'crew', label: CREW_WORDS.moveToCrew, icon: 'crew', kbd: 'M', ...(crews.length < 2 ? { disabledReason: 'Make another crew first.' } : {}), onSelect: () => setOverlay({ kind: 'crew', member }) },
      { id: 'computer', label: CREW_WORDS.moveToComputer, icon: 'desktop', ...(computerWhy ? { disabledReason: computerWhy } : {}), onSelect: () => setOverlay({ kind: 'computer', member }) },
      { separator: true, id: 'sep1' },
      member.paused
        ? { id: 'resume', label: CREW_WORDS.resume, icon: 'play', onSelect: () => void run(() => teamApi.resume(member.id), `${member.name} resumed.`) }
        : { id: 'pause', label: CREW_WORDS.pause, icon: 'pause', ...(member.status === 'offline' ? { disabledReason: `${member.machineName} is offline.` } : {}), onSelect: () => void run(() => teamApi.pause(member.id), `${member.name} paused. Nothing new starts until you resume.`) },
      {
        id: 'jd',
        label: member.templateId === null && member.charter.owns === '' ? CREW_WORDS.draftJd : CREW_WORDS.redraftJd,
        icon: 'sparkle',
        ...(charterOpen ? { disabledReason: charterOpen.state === 'asked' ? 'Asked already — waiting for its agent.' : 'A proposal waits for you.' } : member.paused ? { disabledReason: 'Resume it first.' } : member.status === 'offline' ? { disabledReason: `${member.machineName} is offline.` } : {}),
        onSelect: () => void run(() => teamApi.askCharter(member.id), `Asked ${member.name} to draft its job description. It shows here for you to accept.`),
      },
      { id: 'model', label: CREW_WORDS.model, icon: 'sparkle', onSelect: () => setOverlay({ kind: 'model', member }) },
      { id: 'budget', label: CREW_WORDS.budgetEdit, icon: 'wallet', onSelect: () => setOverlay({ kind: 'budget', member }) },
      { id: 'access', label: CREW_WORDS.access, icon: 'shield', onSelect: openAccess },
      { separator: true, id: 'sep2' },
      { id: 'return', label: CREW_WORDS.returnToAgents, icon: 'agents', onSelect: () => void run(() => teamApi.returnMember(member.id), `“${member.name}” is back in Agents, not in a crew.`) },
    ];
  };
  return { moveTo, menu, run, openChat };
}

/** A proposed (or asked-for) job description on a teammate: Accept / Edit / Dismiss (D105). */
function CharterProposalBlock({ member, onEdit }: { readonly member: TeamMember; readonly onEdit: (requestId: string) => void }) {
  const toast = useToast();
  const request = member.charterRequest;
  if (!request) return null;
  if (request.state === 'asked' || !request.proposal) {
    return (
      <p className="v2-c-jd-asked" data-testid="v2-charter-asked">
        <Icon name="hourglass" size="s" />
        {CREW_WORDS.jdAsked}
      </p>
    );
  }
  const proposal = request.proposal;
  const decide = async (action: 'approve' | 'dismiss'): Promise<void> => {
    try {
      await teamApi.decide(request.requestId, action);
      await reloadTeam();
      toast({ text: action === 'approve' ? `Accepted ${member.name}’s new job description.` : 'Proposal dismissed. Its job description stays.' });
    } catch (e) {
      toast({ text: refusalText(e), tone: 'error' });
    }
  };
  return (
    <div className="v2-c-proposal" data-testid="v2-charter-proposal">
      <b>{CREW_WORDS.jdProposed}</b>
      <dl>
        <dt>Owns</dt>
        <dd>{proposal.owns}</dd>
        <dt>Produces</dt>
        <dd>{proposal.produces}</dd>
        {proposal.howItWorks ? (
          <>
            <dt>How it works</dt>
            <dd>{proposal.howItWorks}</dd>
          </>
        ) : null}
        <dt>Never does</dt>
        <dd>{proposal.neverDoes}</dd>
      </dl>
      {request.notes ? <p className="v2-muted v2-c-small">{request.notes}</p> : null}
      <div className="v2-row v2-c-wrap">
        <Button size="sm" variant="primary" icon="check" onClick={() => void decide('approve')} data-testid="v2-charter-accept">
          Accept
        </Button>
        <Button size="sm" icon="edit" onClick={() => onEdit(request.requestId)} data-testid="v2-charter-edit">
          Edit
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void decide('dismiss')} data-testid="v2-charter-dismiss">
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/**
 * One teammate's card on its crew page (2.4.4: compact; the job description scrolls in a three-line box).
 * Fix after 2.0 (2.4.5): its main area (avatar, name, rhythm) is a button that opens the teammate's
 * chat, as ⋯ › Open chat does, and the foot has an Open chat button; the other controls are separate
 * hit areas, so they keep their own behaviour.
 */
function TeammateCard({ member, status, needs, menu, onOverlay, onDetails, onOpen }: { readonly member: TeamMember; readonly status: V2Status; readonly needs: readonly NeedsItem[]; readonly menu: MenuItem[]; readonly onOverlay: (overlay: Overlay) => void; readonly onDetails: (tab: TeammateTab) => void; readonly onOpen: () => void }) {
  const meter = budgetMeter(member);
  const offline = member.status === 'offline';
  const chatWhy = openChatReason(member);
  return (
    <article className="v2-card v2-c-mate" data-testid="v2-teammate" data-member={member.id} data-status={status} data-needs={needs.length > 0 || undefined} data-offline={offline || undefined} aria-label={`${member.name} · ${STATUS[status].label}`}>
      <div className="v2-row">
        {/* The name's button stretches over the avatar and the rhythm line (crews.css), so the whole area opens the chat. */}
        <div className="v2-row v2-grow v2-c-mate-main" data-disabled={chatWhy !== null || undefined}>
          <Avatar name={member.name} shape="square" status={status} />
          <div className="v2-grow">
            <h3 className="v2-c-mate-name">
              <button type="button" className="v2-c-mate-open" onClick={onOpen} disabled={chatWhy !== null} title={chatWhy ?? CREW_WORDS.openChatOf(member.name)} data-testid="v2-teammate-open">
                {member.name}
              </button>
            </h3>
            <span className="v2-muted v2-c-small v2-c-ellipsis v2-c-block">{rhythmText(member)}</span>
          </div>
        </div>
        <StatusBadge status={status} size="s" />
        <MenuButton items={menu} label={`Actions for ${member.name}`} testId="v2-teammate-menu" />
      </div>
      <ScrollText label={CREW_WORDS.jdRegion(member.name)} testId="v2-teammate-jd">
        <p className="v2-c-jd">{jobText(member)}</p>
      </ScrollText>
      {needs.length > 0 ? (
        <div className="v2-c-needs">
          {needs.map((item) => (
            <AnswerCard key={item.key} item={item} variant="queue" where="crew" />
          ))}
        </div>
      ) : (
        <div className={status === 'working' ? 'v2-c-activity' : 'v2-muted v2-c-line'} title={workLine(member)} data-testid="v2-teammate-work">
          {status === 'working' ? <span className="v2-pulse" aria-hidden="true" /> : null}
          <span className="v2-c-ellipsis">{workLine(member)}</span>
        </div>
      )}
      {needs.some((item) => item.kind === 'jd') ? null : <CharterProposalBlock member={member} onEdit={(requestId) => onOverlay({ kind: 'charter', member, requestId })} />}
      <div className="v2-c-meter-row">
        <span className="v2-muted v2-c-small">{CREW_WORDS.budget}</span>
        <div className="v2-c-meter" role="meter" aria-label={`Budget of ${member.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={meter?.fill ?? 0}>
          <b style={{ width: `${meter?.fill ?? 0}%` }} data-over={meter?.over || undefined} />
        </div>
        <span className="v2-c-small" data-testid="v2-teammate-budget">
          {meter?.text ?? 'No budget'}
        </span>
        <IconButton icon="edit" label={`Edit the budget of ${member.name}`} onClick={() => onOverlay({ kind: 'budget', member })} data-testid="v2-teammate-budget-edit" />
      </div>
      <div className="v2-row v2-c-mate-foot">
        <ComputerTag name={member.machineName} kind={member.local ? 'laptop' : 'desktop'} state={offline ? 'offline' : 'online'} short />
        <span className="v2-grow" />
        <Button size="sm" variant="ghost" icon="shield" onClick={() => onDetails('access')} data-testid="v2-teammate-access">
          {CREW_WORDS.access}
        </Button>
        <Button size="sm" variant="ghost" icon="eye" onClick={() => onDetails('overview')} data-testid="v2-teammate-details">
          Details
        </Button>
        <Button size="sm" variant="ghost" icon="chat" className="v2-c-mate-chat" onClick={onOpen} disabled={chatWhy !== null} title={chatWhy ?? CREW_WORDS.openChatOf(member.name)} aria-label={CREW_WORDS.openChatOf(member.name)} data-testid="v2-teammate-chat">
          <span className="v2-c-mate-chat-label">{CREW_WORDS.openChat}</span>
        </Button>
      </div>
    </article>
  );
}

/** A teammate's details: its job description, rhythm, model, gates (Overview) and its Access tab. */
function TeammateDetails({ member, tab, onTab, modelText, focusAccess = null }: { readonly member: TeamMember; readonly tab: TeammateTab; readonly onTab: (tab: TeammateTab) => void; readonly modelText: string; /** Needs you's Add key: this access's form opens. */ readonly focusAccess?: string | null }) {
  return (
    <div className="v2-c-details" data-testid="v2-teammate-panel" data-tab={tab}>
      <Tabs
        label={`${member.name}`}
        value={tab}
        onChange={onTab}
        panelId="v2-teammate-tabpanel"
        testId="v2-teammate-tabs"
        tabs={[
          { id: 'overview', label: CREW_WORDS.overview },
          { id: 'access', label: CREW_WORDS.access },
        ]}
      />
      <div id="v2-teammate-tabpanel" role="tabpanel" className="v2-c-tabpanel">
        {tab === 'access' ? (
          <AccessPanel memberId={member.id} focusAccess={focusAccess} onChanged={() => void reloadTeam()} />
        ) : (
          <dl className="v2-c-kv">
            <dt>Owns</dt>
            <dd>{member.charter.owns || '—'}</dd>
            <dt>Produces</dt>
            <dd>{member.charter.produces || '—'}</dd>
            {member.charter.howItWorks ? (
              <>
                <dt>How it works</dt>
                <dd>{member.charter.howItWorks}</dd>
              </>
            ) : null}
            <dt>Never does</dt>
            <dd>{member.charter.neverDoes || '—'}</dd>
            <dt>Rhythm</dt>
            <dd>{rhythmText(member)}</dd>
            <dt>Model</dt>
            <dd>{modelText}</dd>
            <dt>Computer</dt>
            <dd>{member.machineName}</dd>
            <dt>From</dt>
            <dd>{member.sessionTitle ?? '—'}</dd>
          </dl>
        )}
      </div>
    </div>
  );
}

/** D131 · one crew (`/crews/:id`, `?member=&tab=access` opens a teammate's Access tab), lane P. */
export function CrewPage({ id }: { readonly id: string }) {
  const data = useTeamData();
  const layout = useLayout();
  const phone = layout === 'phone';
  const { navigate, search } = useV2Router();
  const query = crewQuery(search);
  const needs = useNeedsYou();
  const sessions = useSessionListOf();
  const toast = useToast();
  const { ordered, ids, save } = useCrewOrder(data.teams);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const pins = useCrewPins();
  useEffect(() => {
    showTeam(id);
    setLastTeam(id);
  }, [id]);
  const view = data.view?.team.id === id ? data.view : null;
  const crew = ordered.find((entry) => entry.id === id) ?? null;
  const actions = useTeammateActions(view, ordered, setOverlay);
  // 2026-10-27 (D137 follow-up, the developer chose B): archived teammates stay in the crew but are not shown;
  // every member still names the activity and hand-off rows.
  const everyone = view?.members ?? [];
  const members = useMemo(() => visibleMembers(everyone).shown, [everyone]);
  const items = needs.items;
  const needsOf = useMemo(() => {
    const map = new Map<string, NeedsItem[]>();
    for (const item of items) {
      const memberId = item.crew?.memberId;
      if (!memberId) continue;
      map.set(memberId, [...(map.get(memberId) ?? []), item]);
    }
    return map;
  }, [items]);
  const statusOf = (member: TeamMember): V2Status => teammateStatus(member, (needsOf.get(member.id) ?? []).map(() => ({ memberId: member.id })));
  const selected = query.member ? (members.find((member) => member.id === query.member) ?? null) : null;
  const openDetails = (member: TeamMember, tab: TeammateTab): void => navigate(crewHref(id, member.id, tab));
  const closeDetails = (): void => navigate(crewHref(id), { replace: true });
  const modelText = (member: TeamMember): string => v2ModelText(modelLine(sessions.data?.find((session) => session.id === member.sessionRef)?.model, member));

  if (data.loaded && !crew && data.teams.length > 0) {
    return (
      <div className="v2-page" data-testid="v2-page-crew" data-area="crew">
        <V2Link to="/crews" className="v2-c-back">
          <Icon name="back" size="s" />
          {CREW_WORDS.allCrews}
        </V2Link>
        <EmptyState icon="crew" tone="grey" title="This crew is gone" text="It was deleted, or it hasn’t synced to this computer yet." testId="v2-crew-gone" />
      </div>
    );
  }
  if (!crew || !view) {
    return (
      <div className="v2-page" data-testid="v2-page-crew" data-area="crew" aria-busy="true">
        <Skeleton width={120} height={14} />
        <Skeleton width="40%" height={30} style={{ margin: '14px 0 22px' }} />
        <Skeleton lines={4} />
      </div>
    );
  }
  const stats = crewStats(crew);

  // Phone: Crews › crew › teammate, one screen at a time.
  if (phone && selected) {
    const status = statusOf(selected);
    return (
      <div className="v2-page" data-testid="v2-page-crew" data-area="crew" data-member={selected.id}>
        <nav className="v2-c-crumb" aria-label="Crew path" data-testid="v2-crew-crumb">
          <V2Link to="/crews">Crews</V2Link>
          <Icon name="chev" size="s" />
          <V2Link to={crewHref(id)}>{crew.name}</V2Link>
          <Icon name="chev" size="s" />
          <b>{selected.name}</b>
        </nav>
        <div className="v2-row v2-c-phone-head">
          <Avatar name={selected.name} shape="square" status={status} />
          <h1 className="v2-grow">{selected.name}</h1>
          <Button size="sm" icon="chat" onClick={() => actions.openChat(selected)} disabled={openChatReason(selected) !== null} title={openChatReason(selected) ?? CREW_WORDS.openChatOf(selected.name)} data-testid="v2-teammate-chat">
            {CREW_WORDS.openChat}
          </Button>
          <MenuButton items={actions.menu(selected, () => openDetails(selected, 'access'))} label={`Actions for ${selected.name}`} testId="v2-teammate-menu" />
        </div>
        <StatusBadge status={status} />
        <ScrollText label={CREW_WORDS.jdRegion(selected.name)} testId="v2-teammate-jd" className="v2-c-scroll-phone">
          <p className="v2-c-jd">{jobText(selected)}</p>
        </ScrollText>
        {(needsOf.get(selected.id) ?? []).map((item) => (
          <AnswerCard key={item.key} item={item} variant="phone" where="phone" />
        ))}
        {(needsOf.get(selected.id) ?? []).some((item) => item.kind === 'jd') ? null : <CharterProposalBlock member={selected} onEdit={(requestId) => setOverlay({ kind: 'charter', member: selected, requestId })} />}
        <TeammateDetails member={selected} tab={query.tab} onTab={(tab) => navigate(crewHref(id, selected.id, tab), { replace: true })} modelText={modelText(selected)} focusAccess={query.access} />
        <CrewOverlays overlay={overlay} setOverlay={setOverlay} crews={ordered} crewId={id} onMove={actions.moveTo} />
      </div>
    );
  }

  const switcherKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = ordered[(index + delta + ordered.length) % ordered.length];
    if (next) navigate({ area: 'crew', id: next.id });
  };

  return (
    <div className="v2-page" data-wide="" data-testid="v2-page-crew" data-area="crew" data-crew={id}>
      {phone ? (
        <nav className="v2-c-crumb" aria-label="Crew path" data-testid="v2-crew-crumb">
          <V2Link to="/crews">Crews</V2Link>
          <Icon name="chev" size="s" />
          <b>{crew.name}</b>
        </nav>
      ) : (
        <V2Link to="/crews" className="v2-c-back" data-testid="v2-crew-back">
          <Icon name="back" size="s" />
          {CREW_WORDS.allCrews}
        </V2Link>
      )}
      <div className="v2-row v2-c-wrap v2-c-crew-head">
        <h1 className="v2-c-crew-title">Crew · {crew.name}</h1>
        {stats.needs > 0 ? <StatusBadge status="needs" label={`${stats.needs} need${stats.needs === 1 ? 's' : ''} you`} size="s" /> : null}
        <span className="v2-grow" />
        <div className="v2-c-switch" role="tablist" aria-label="Switch crew" data-testid="v2-crew-switcher">
          {ordered.map((entry, index) => (
            <button key={entry.id} type="button" role="tab" aria-selected={entry.id === id} tabIndex={entry.id === id ? 0 : -1} onClick={() => navigate({ area: 'crew', id: entry.id })} onKeyDown={(event) => switcherKey(event, index)} data-crew={entry.id}>
              {entry.name}
              {entry.needsYou > 0 ? <span className="v2-c-nb">{entry.needsYou}</span> : null}
            </button>
          ))}
        </div>
        <Button icon="plus" onClick={() => setOverlay({ kind: 'new-teammate' })} data-testid="v2-crew-add">
          {CREW_WORDS.addTeammate}
        </Button>
        <MenuButton
          label="Crew actions"
          testId="v2-crew-menu"
          items={crewMenuItems(crew, ids, {
            open: () => undefined,
            pinned: pins.isPinned(crew.id),
            togglePin: () => void pins.toggle(crew),
            move: (delta) => {
              const index = ids.indexOf(id);
              const next = [...ids];
              const to = index + delta;
              if (to < 0 || to >= ids.length) return;
              next.splice(index, 1);
              next.splice(to, 0, id);
              void save(next, `Moved “${crew.name}” ${delta < 0 ? 'up' : 'down'}.`);
            },
            newTeammate: () => setOverlay({ kind: 'new-teammate' }),
            rename: () => setOverlay({ kind: 'rename', crew }),
            remove: () => setOverlay({ kind: 'delete', crew }),
          }).filter((item) => item.id !== 'open')}
        />
      </div>
      <p className="v2-page-sub v2-c-crew-sub">
        {crewLine(stats)}
        {stats.computers.map((computer) => (
          <ComputerTag key={computer.name} name={computer.name} kind={computer.local ? 'laptop' : 'desktop'} short />
        ))}
      </p>
      <ArchivedLine archived={stats.archived} />

      {members.length === 0 ? (
        <EmptyState icon="crew" tone="grey" title={stats.archived > 0 ? CREW_WORDS.allArchived : CREW_WORDS.noTeammates} testId="v2-crew-empty" />
      ) : phone ? (
        <div className="v2-c-plist" data-testid="v2-teammate-list">
          {members.map((member) => {
            const status = statusOf(member);
            return (
              <div key={member.id} className="v2-c-prow-wrap">
                <button type="button" className="v2-c-prow" onClick={() => openDetails(member, 'overview')} data-testid="v2-teammate-row" data-member={member.id}>
                  <Avatar name={member.name} shape="square" status={status} size="m" />
                  <span className="v2-grow">
                    <b>{member.name}</b>
                    <span className="v2-muted v2-c-small">{workLine(member)}</span>
                  </span>
                  <StatusBadge status={status} size="s" compact />
                  <Icon name="chev" size="s" />
                </button>
                <IconButton icon="chat" size="l" label={CREW_WORDS.openChatOf(member.name)} title={openChatReason(member) ?? CREW_WORDS.openChatOf(member.name)} disabled={openChatReason(member) !== null} onClick={() => actions.openChat(member)} data-testid="v2-teammate-row-chat" data-member={member.id} />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="v2-c-mates" data-testid="v2-teammate-list">
          {members.map((member) => (
            <TeammateCard key={member.id} member={member} status={statusOf(member)} needs={needsOf.get(member.id) ?? []} menu={actions.menu(member, () => openDetails(member, 'access'))} onOverlay={setOverlay} onDetails={(tab) => openDetails(member, tab)} onOpen={() => actions.openChat(member)} />
          ))}
        </div>
      )}

      {phone ? (
        (needsOf.size > 0 ? members.flatMap((member) => needsOf.get(member.id) ?? []) : []).map((item) => <AnswerCard key={item.key} item={item} variant="phone" where="phone" />)
      ) : null}

      <section className="v2-c-sec" aria-labelledby="v2-crew-activity-h">
        <div className="v2-c-sec-h">
          <Icon name="clock" />
          <h2 id="v2-crew-activity-h">{CREW_WORDS.crewActivity}</h2>
        </div>
        <div className="v2-card v2-c-list" data-testid="v2-crew-activity">
          {activityRows(view.activity, everyone).map((row) => (
            <div key={row.id} className="v2-c-lrow v2-c-act">
              <span className="v2-muted v2-mono v2-c-time">{clock(row.at)}</span>
              <b className="v2-c-who">{row.who}</b>
              <span className="v2-grow">{row.text}</span>
            </div>
          ))}
          {view.activity.length === 0 ? <div className="v2-c-lrow v2-muted">{CREW_WORDS.noActivity}</div> : null}
        </div>
      </section>
      <section className="v2-c-sec" aria-labelledby="v2-crew-handoffs-h">
        <div className="v2-c-sec-h">
          <Icon name="arrow-r" />
          <h2 id="v2-crew-handoffs-h">{CREW_WORDS.handoffs}</h2>
          <span className="v2-muted v2-c-small">{CREW_WORDS.handoffsSub}</span>
        </div>
        <div className="v2-card v2-c-list" data-testid="v2-crew-handoffs">
          {handoffRows(view.handoffs, everyone).map((row) => (
            <div key={row.id} className="v2-c-lrow" data-state={row.state}>
              <b>{row.from}</b>
              <Icon name="arrow-r" size="s" />
              <b>{row.to}</b>
              <span className="v2-grow v2-muted">{row.brief}</span>
              <span className="v2-c-small v2-muted">{row.state}</span>
            </div>
          ))}
          {view.handoffs.length === 0 ? <div className="v2-c-lrow v2-muted">{CREW_WORDS.noHandoffs}</div> : null}
        </div>
      </section>

      {selected && !phone ? (
        <Sheet open onClose={closeDetails} title={selected.name} testId="v2-teammate-sheet">
          <TeammateDetails member={selected} tab={query.tab} onTab={(tab) => navigate(crewHref(id, selected.id, tab), { replace: true })} modelText={modelText(selected)} focusAccess={query.access} />
        </Sheet>
      ) : null}
      <CrewOverlays overlay={overlay} setOverlay={setOverlay} crews={ordered} crewId={id} onMove={actions.moveTo} />
      {overlay?.kind === 'rename' ? (
        <RenameCrewDialog
          crew={overlay.crew}
          onClose={() => setOverlay(null)}
          onDone={() => {
            setOverlay(null);
            void reloadTeam();
          }}
        />
      ) : null}
      {overlay?.kind === 'delete' ? (
        <DeleteCrewDialog
          crew={overlay.crew}
          onClose={() => setOverlay(null)}
          onDone={() => {
            setOverlay(null);
            void reloadTeam();
            toast({ text: `Deleted “${overlay.crew.name}”. Its teammates are back in Agents.` });
            navigate('/crews');
          }}
        />
      ) : null}
    </div>
  );
}

/** The teammate dialogs shared by the crew page and the phone's teammate screen. */
function CrewOverlays({ overlay, setOverlay, crews, crewId, onMove }: { readonly overlay: Overlay | null; readonly setOverlay: (overlay: Overlay | null) => void; readonly crews: readonly TeamSummary[]; readonly crewId: string; readonly onMove: (member: TeamMember, crewId: string) => Promise<void> }) {
  const toast = useToast();
  const close = (): void => {
    setOverlay(null);
    void reloadTeam();
  };
  if (!overlay) return null;
  switch (overlay.kind) {
    case 'crew':
      return <MoveToCrewDialog member={overlay.member} crews={crews} onClose={() => setOverlay(null)} onMove={(target) => void onMove(overlay.member, target)} />;
    case 'computer':
      return <MoveToComputerDialog member={overlay.member} onClose={close} />;
    case 'budget':
      return <BudgetDialog member={overlay.member} onClose={close} />;
    case 'model':
      return <ModelDialog member={overlay.member} onClose={close} />;
    case 'charter':
      return <CharterEditDialog member={overlay.member} charter={overlay.member.charterRequest?.proposal ?? overlay.member.charter} requestId={overlay.requestId} onClose={close} />;
    case 'new-teammate':
      return (
        <NewTeammateDialog
          crews={crews}
          crewId={crewId}
          onClose={() => setOverlay(null)}
          onCreated={(member) => {
            close();
            toast({ text: `${member.name} joined ${crews.find((crew) => crew.id === member.teamId)?.name ?? 'the crew'}.` });
          }}
        />
      );
    default:
      return null;
  }
}
