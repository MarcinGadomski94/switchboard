import { useEffect, useRef, useState } from 'react';
import type { OwnedLoop, SessionModel } from '../../core/api.ts';
import type { CliProviderId } from '../../core/cli-providers.ts';
import type { TeamMember, TeamMemberStatus } from '../../core/team.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useThrottled } from '../api/useThrottled.ts';
import { BackButton } from '../components/ListDetail.tsx';
import { useRouter } from '../router.tsx';
import { ChatTab } from '../views/session/ChatTab.tsx';
import { usePlaceholderDelay, useSessionData } from '../views/session/useSessionData.ts';
import { NOTHING_LOADING, anyLoading, loadingParts } from '../views/session/session-loading.ts';
import '../views/session/session.css';
import { AccessTab } from './access/index.ts';
import { refusalText, teamApi } from './api.ts';
import { CharterProposal } from './CharterProposal.tsx';
import { MemberFormFields } from './MemberFormFields.tsx';
import { useFitMemberModel, useMemberModels } from './MemberModel.tsx';
import { STATUS_META, type MemberForm, fitMemberModel, formBody, formCharter, formFromMember, gatesLine, rhythmLine, withCharter } from './model.ts';

/** The member panel's tabs: Chat (default), Access (T2's slot), Settings. */
export type PanelTab = 'chat' | 'access' | 'settings';

/** A section of Settings the member menu points at (Edit charter…, Model & effort…, Budget…); D105 `proposal`: Edit… of a charter proposal (the form filled with it). */
export type SettingsFocus = 'charter' | 'model' | 'budget' | 'proposal' | null;

/** `sessionUpdated` / `event` come in bursts; the chat's data reloads at most this often (like the session view). */
const RELOAD_MS = 500;

/**
 * D100 · the selected member's panel (right column; full screen with "‹ Team" on a
 * phone): its name, ⏸ Pause / ▶ Resume, Open session and ⋯; a subline (from session,
 * model, machine, rhythm, needs-you-for); the tabs **Chat** (the real session chat
 * with its composer: the developer talks to the member here, and its draft is the
 * session's own D88 draft), **Access** (T2's `AccessTab`) and **Settings** (the member form,
 * its **Team** (D100 follow-up 2026-10-14: a pick moves it) and where it runs with "Move to <PC>…").
 */
export function MemberPanel({
  member,
  status,
  modelText,
  sessionModel = null,
  tab,
  onTab,
  focus,
  accessFocus,
  composerFocus,
  phone,
  moveTargets,
  teams = [],
  onMoveTeam,
  onBack,
  onMenu,
  onMove,
  onChanged,
}: {
  readonly member: TeamMember;
  readonly status: TeamMemberStatus;
  /** The model line ("Sonnet 5.5 · high"; `modelLine` in model.ts). */
  readonly modelText: string;
  /** D100 follow-up 2026-10-14: the session's model, effort and the models its CLI reported (Settings' model dropdown). */
  readonly sessionModel?: SessionModel | null;
  readonly tab: PanelTab;
  readonly onTab: (tab: PanelTab) => void;
  readonly focus: SettingsFocus;
  /** The access the Access tab opens at (T2's `focusAccessId`; Set up… in Needs you). */
  readonly accessFocus: string | null;
  /** Bumped by Reply…: the chat's composer takes the focus. */
  readonly composerFocus: number;
  readonly phone: boolean;
  /** The machines it can move to (Settings → Runs on). */
  readonly moveTargets: readonly { readonly id: string; readonly name: string; readonly online: boolean }[];
  /** D100 follow-up 2026-10-14: the teams (Settings → Team, shown with two or more). */
  readonly teams?: readonly { readonly id: string; readonly name: string }[];
  /** Settings → Team changed: move the member to that team (the page's toast with Undo). */
  readonly onMoveTeam?: (teamId: string) => void;
  readonly onBack: () => void;
  readonly onMenu: (anchor: { readonly x: number; readonly y: number }) => void;
  readonly onMove: (targetMachineId: string) => void;
  readonly onChanged: () => void;
}) {
  const { navigate } = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pauseResume = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (member.paused) await teamApi.resume(member.id);
      else await teamApi.pause(member.id);
      onChanged();
    } catch (caught) {
      setError(refusalText(caught));
    } finally {
      setBusy(false);
    }
  };
  const offline = status === 'offline';
  const meta = STATUS_META[status];
  const sub = [`from “${member.sessionTitle ?? member.sessionId}”`, modelText, `runs on ${member.machineName}`, rhythmLine(member), gatesLine(member.gates)];
  return (
    <section className="sb-team-panel" data-testid="team-panel" data-member-id={member.id} data-status={status} aria-label={member.name}>
      {phone ? <BackButton label="Team" testId="team-back" onBack={onBack} /> : null}
      <div className="sb-team-panel__head">
        <span className="sb-team-card__icon" data-status={status} title={meta.label}>
          {meta.icon}
        </span>
        <span className="sb-team-panel__name" data-testid="team-panel-name">
          {member.name}
        </span>
        <span className="sb-team-panel__actions">
          <button type="button" className="sb-button sb-team-btn" data-testid="team-panel-pause" disabled={busy || offline} onClick={() => void pauseResume()}>
            {member.paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button type="button" className="sb-button sb-team-btn" data-testid="team-panel-open" onClick={() => navigate({ view: 'session', id: member.sessionRef, tab: 'chat' })}>
            Open session
          </button>
          <button
            type="button"
            className="sb-button sb-team-btn"
            data-testid="team-panel-menu"
            data-tour="team-member-menu"
            aria-label={`${member.name}: more`}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onMenu({ x: rect.right, y: rect.bottom });
            }}
          >
            ⋯
          </button>
        </span>
      </div>
      <div className="sb-team-panel__sub" data-testid="team-panel-sub">
        {sub.join(' · ')}
      </div>
      {error ? (
        <div className="sb-team-error" role="alert" data-testid="team-panel-error">
          {error}
        </div>
      ) : null}
      <div className="sb-team-tabs" role="tablist">
        {(['chat', 'access', 'settings'] as const).map((name) => (
          <button key={name} type="button" role="tab" aria-selected={tab === name} className="sb-button sb-team-tab" data-testid={`team-tab-${name}`} onClick={() => onTab(name)}>
            {name === 'chat' ? 'Chat' : name === 'access' ? 'Access' : 'Settings'}
          </button>
        ))}
      </div>
      <div className="sb-team-panel__body" data-tab={tab}>
        {tab === 'chat' ? <MemberChat key={member.sessionRef} sessionId={member.sessionRef} composerFocus={composerFocus} /> : null}
        {/* T2's Access tab (D100 access requests); Set up… in Needs you opens it at that access. */}
        {tab === 'access' ? (
          <div className="sb-team-access" data-testid="team-access">
            <AccessTab key={`${member.id}:${accessFocus ?? ''}`} memberId={member.id} focusAccessId={accessFocus} loopLabels={member.rhythm.loops.map((loop) => loop.label ?? loop.prompt)} onChanged={onChanged} />
          </div>
        ) : null}
        {/* D105: Edit… of a proposal mounts the form anew, filled with it; so does a charter that changed (an accepted proposal, a synced edit), so a later Save never puts the old one back. */}
        {tab === 'settings' ? <MemberSettings key={`${member.id}:${focus === 'proposal' ? (member.charterRequest?.requestId ?? '') : ''}:${JSON.stringify(member.charter)}`} member={member} sessionModel={sessionModel} focus={focus} moveTargets={moveTargets} teams={teams} onMoveTeam={onMoveTeam} onMove={onMove} onChanged={onChanged} /> : null}
      </div>
    </section>
  );
}

/** The member's chat: the session view's chat tab over the same data (`useSessionData`), reloaded on the same `/hub` events. */
function MemberChat({ sessionId, composerFocus }: { readonly sessionId: string; readonly composerFocus: number }) {
  const data = useSessionData(sessionId, true, null);
  const reload = useThrottled(data.reload, RELOAD_MS);
  useHubEvent('sessionUpdated', (session) => {
    if (session.id === sessionId) reload();
  });
  useHubEvent('event', (payload) => {
    if (payload.sessionId === sessionId) reload();
  });
  useHubEvent('questionBatch', (payload) => {
    if (payload.sessionId === sessionId) reload();
  });
  const loading = loadingParts(data.detailState, data.eventsState, true);
  const busy = anyLoading(loading);
  const placeholders = usePlaceholderDelay(sessionId, busy) ? loading : NOTHING_LOADING;
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (composerFocus === 0) return;
    root.current?.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')?.focus();
  }, [composerFocus]);
  return (
    <div ref={root} className="sb-sv-main sb-team-chat" data-testid="team-chat" data-session-id={sessionId}>
      <ChatTab sessionId={sessionId} session={data.detail} events={data.events} eventsState={data.eventsState} placeholder={placeholders.chat} onChanged={data.reload} older={data.older} newer={data.newer} />
    </div>
  );
}

/** Settings: the member form (saved with PUT), and where it runs with Move to <PC>…. */
function MemberSettings({
  member,
  sessionModel,
  focus,
  moveTargets,
  teams,
  onMoveTeam,
  onMove,
  onChanged,
}: {
  readonly member: TeamMember;
  readonly sessionModel: SessionModel | null;
  readonly focus: SettingsFocus;
  readonly moveTargets: readonly { readonly id: string; readonly name: string; readonly online: boolean }[];
  readonly teams: readonly { readonly id: string; readonly name: string }[];
  readonly onMoveTeam: ((teamId: string) => void) | undefined;
  readonly onMove: (targetMachineId: string) => void;
  readonly onChanged: () => void;
}) {
  // D105: the open charter ask / proposal; `editing` = the proposal being edited (Save accepts it with the edits).
  const request = member.charterRequest ?? null;
  const [editing, setEditing] = useState<string | null>(() => (focus === 'proposal' && request?.state === 'proposed' ? request.requestId : null));
  const [form, setForm] = useState<MemberForm>(() => (focus === 'proposal' && request?.proposal ? withCharter(formFromMember(member), request.proposal) : formFromMember(member)));
  const [asking, setAsking] = useState(false);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // D100 follow-up 2026-10-14: the model dropdown starts on what the session runs with.
  const models = useMemberModels(sessionModel, (member.provider as CliProviderId | null) ?? null);
  useFitMemberModel(models, setForm, true);
  const fresh = (): MemberForm => {
    const base = formFromMember(member);
    return models.options && models.current ? fitMemberModel({ ...base, model: '', effort: '' }, models.options, models.current) : base;
  };
  const [loops, setLoops] = useState<readonly OwnedLoop[] | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/sessions/${encodeURIComponent(member.sessionRef)}/loops`, { credentials: 'same-origin' })
      .then(async (response) => (response.ok ? ((await response.json()) as OwnedLoop[]) : []))
      .then((list) => live && setLoops(list.filter((loop) => loop.state !== 'ended')))
      .catch(() => live && setLoops([]));
    return () => {
      live = false;
    };
  }, [member.sessionRef]);
  useEffect(() => {
    if (!focus) return;
    const section = root.current?.querySelector<HTMLElement>(`[data-section="${focus === 'proposal' ? 'charter' : focus}"]`);
    section?.scrollIntoView({ block: 'start' });
    section?.querySelector<HTMLElement>('input, textarea, select')?.focus();
  }, [focus]);
  const save = async (): Promise<void> => {
    const checked = formBody(form);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setNote(null);
    try {
      if (editing && request?.requestId === editing) {
        // D105: Save of an edited proposal accepts it with the edits; the other fields are saved when they changed.
        await teamApi.decide(editing, 'approve', { charter: formCharter(form) });
        const base = formBody(formFromMember(member));
        const { charter: _charter, ...rest } = checked.body;
        const restBefore = base.ok ? (({ charter: _c, ...others }) => others)(base.body) : null;
        if (JSON.stringify(rest) !== JSON.stringify(restBefore)) await teamApi.updateMember(member.id, rest);
        setEditing(null);
        setNote('Accepted with your edits. The new charter reaches the agent with its next message.');
      } else {
        await teamApi.updateMember(member.id, checked.body);
        setNote('Saved. A changed charter or model reaches the agent with its next message.');
      }
      onChanged();
    } catch (caught) {
      setNote(refusalText(caught));
    } finally {
      setBusy(false);
    }
  };
  const redraft = async (): Promise<void> => {
    setAsking(true);
    setNote(null);
    try {
      await teamApi.askCharter(member.id);
      setNote(`Asked ${member.name} to propose a specific charter from its own session.`);
      onChanged();
    } catch (caught) {
      setNote(refusalText(caught));
    } finally {
      setAsking(false);
    }
  };
  const cancelAsk = async (requestId: string): Promise<void> => {
    setAsking(true);
    try {
      await teamApi.decide(requestId, 'dismiss');
      onChanged();
    } catch (caught) {
      setNote(refusalText(caught));
    } finally {
      setAsking(false);
    }
  };
  return (
    <div ref={root} className="sb-team-settings" data-testid="team-settings">
      {/* D105: the charter's own agent drafts a better one; its proposal waits here (and in Needs you). */}
      <div className="sb-team-proposal" data-testid="team-settings-charter-state" data-state={request ? (editing ? 'editing' : request.state) : 'none'} data-tour="team-redraft">
        {request?.state === 'proposed' && request.proposal && !editing ? (
          <>
            <div className="sb-team-field__label">{member.name} proposes a new charter</div>
            <CharterProposal
              requestId={request.requestId}
              before={member.charter}
              after={request.proposal}
              notes={request.notes}
              onEdit={() => {
                setForm((current) => withCharter(current, request.proposal ?? member.charter));
                setEditing(request.requestId);
                root.current?.querySelector<HTMLElement>('[data-section="charter"]')?.scrollIntoView({ block: 'start' });
              }}
              onDecided={onChanged}
            />
          </>
        ) : null}
        {request?.state === 'proposed' && editing ? (
          <div className="sb-team-note" data-testid="team-settings-editing-proposal">
            Editing {member.name}’s proposal: Save accepts it with your edits.{' '}
            <button
              type="button"
              className="sb-button sb-team-btn sb-team-btn--ghost"
              data-testid="team-settings-discard-edit"
              onClick={() => {
                setForm((current) => withCharter(current, member.charter));
                setEditing(null);
              }}
            >
              Discard edits
            </button>
          </div>
        ) : null}
        {request?.state === 'asked' ? (
          <div className="sb-team-note" data-testid="team-settings-asked">
            {member.name} was asked to propose a specific charter from its own session; it shows here and in Needs you when it does.{' '}
            <button type="button" className="sb-button sb-team-btn sb-team-btn--ghost" data-testid="team-settings-cancel-ask" disabled={asking} onClick={() => void cancelAsk(request.requestId)}>
              Cancel the ask
            </button>
          </div>
        ) : null}
        {request === null ? (
          <div className="sb-team-proposal__redraft">
            <button type="button" className="sb-button sb-team-btn" data-testid="team-settings-redraft" disabled={asking || busy || member.status === 'offline' || member.paused} onClick={() => void redraft()}>
              Redraft charter
            </button>
            <span className="sb-team-muted">Its agent proposes a specific charter from its own session; you accept, edit or dismiss it.</span>
          </div>
        ) : null}
      </div>
      <MemberFormFields form={form} onChange={setForm} errors={errors} parts={{ sessionLoops: loops, models: models.options }} disabled={busy} />
      {/* D100 follow-up 2026-10-14: the team it is in; another pick moves it there at once (toast with Undo). */}
      {teams.length > 1 && onMoveTeam ? (
        <label className="sb-team-field" data-section="team">
          <span className="sb-team-field__label">Team</span>
          <select className="sb-team-input" data-testid="team-settings-team" value={member.teamId} disabled={busy} onChange={(event) => onMoveTeam(event.target.value)}>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="sb-team-field" data-section="machine">
        <span className="sb-team-field__label">Runs on</span>
        <div className="sb-team-runs-on">
          <span className="sb-team-chip" data-testid="team-settings-machine">
            {member.machineName}
          </span>
          {moveTargets.map((target) => (
            <button key={target.id} type="button" className="sb-button sb-team-btn" data-testid="team-settings-move" disabled={!target.online || member.status === 'offline'} onClick={() => onMove(target.id)}>
              Move to {target.name}…
            </button>
          ))}
        </div>
      </div>
      {note ? (
        <div className="sb-team-muted" role="status" data-testid="team-settings-note">
          {note}
        </div>
      ) : null}
      <div className="sb-team-dialog__actions">
        <button type="button" className="sb-button sb-team-btn" onClick={() => setForm(fresh())} disabled={busy}>
          Reset
        </button>
        <button type="button" className="sb-button sb-team-btn sb-team-btn--primary" data-testid="team-settings-save" disabled={busy} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}
