import { useEffect, useRef, useState } from 'react';
import type { OwnedLoop } from '../../core/api.ts';
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
import { MemberFormFields } from './MemberFormFields.tsx';
import { STATUS_META, type MemberForm, formBody, formFromMember, gatesLine, rhythmLine } from './model.ts';

/** The member panel's tabs: Chat (default), Access (T2's slot), Settings. */
export type PanelTab = 'chat' | 'access' | 'settings';

/** A section of Settings the member menu points at (Edit charter…, Model & effort…, Budget…). */
export type SettingsFocus = 'charter' | 'model' | 'budget' | null;

/** `sessionUpdated` / `event` come in bursts; the chat's data reloads at most this often (like the session view). */
const RELOAD_MS = 500;

/**
 * D100 · the selected member's panel (right column; full screen with "‹ Team" on a
 * phone): its name, ⏸ Pause / ▶ Resume, Open session and ⋯; a subline (from session,
 * model, machine, rhythm, needs-you-for); the tabs **Chat** (the real session chat
 * with its composer: the developer talks to the member here, and its draft is the
 * session's own D88 draft), **Access** (T2's `AccessTab`) and **Settings** (the member form,
 * and where it runs with "Move to <PC>…").
 */
export function MemberPanel({
  member,
  status,
  modelText,
  tab,
  onTab,
  focus,
  accessFocus,
  composerFocus,
  phone,
  moveTargets,
  onBack,
  onMenu,
  onMove,
  onChanged,
}: {
  readonly member: TeamMember;
  readonly status: TeamMemberStatus;
  /** The model line ("Sonnet 5.5 · high"; `modelLine` in model.ts). */
  readonly modelText: string;
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
        {tab === 'settings' ? <MemberSettings key={member.id} member={member} focus={focus} moveTargets={moveTargets} onMove={onMove} onChanged={onChanged} /> : null}
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
  focus,
  moveTargets,
  onMove,
  onChanged,
}: {
  readonly member: TeamMember;
  readonly focus: SettingsFocus;
  readonly moveTargets: readonly { readonly id: string; readonly name: string; readonly online: boolean }[];
  readonly onMove: (targetMachineId: string) => void;
  readonly onChanged: () => void;
}) {
  const [form, setForm] = useState<MemberForm>(() => formFromMember(member));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
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
    const section = root.current?.querySelector<HTMLElement>(`[data-section="${focus}"]`);
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
      await teamApi.updateMember(member.id, checked.body);
      setNote('Saved. A changed charter reaches the agent with its next message.');
      onChanged();
    } catch (caught) {
      setNote(refusalText(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div ref={root} className="sb-team-settings" data-testid="team-settings">
      <MemberFormFields form={form} onChange={setForm} errors={errors} parts={{ sessionLoops: loops }} disabled={busy} />
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
        <button type="button" className="sb-button sb-team-btn" onClick={() => setForm(formFromMember(member))} disabled={busy}>
          Reset
        </button>
        <button type="button" className="sb-button sb-team-btn sb-team-btn--primary" data-testid="team-settings-save" disabled={busy} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}
