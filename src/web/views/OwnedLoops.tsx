import { type MouseEvent, useEffect, useId, useMemo, useState } from 'react';
import type { OwnedLoop, Session, SessionListItem } from '../../core/api.ts';
import { LOOP_SYMBOL } from '../../core/owned-loops.ts';
import { displayTitle } from '../../core/session-title.ts';
import { ApiError, api } from '../api/client.ts';
import { MachineTag } from '../components/MachineTag.tsx';
import { useModals } from '../modals/ModalHost.tsx';
import { useRouter } from '../router.tsx';
import { EMPTY_LOOP_DRAFT, type LoopDraft, type LoopDraftKind, type OwnedLoopCardModel, draftFromLoop, draftInput, loopRefusal, ownedLoopCard } from './owned-loops.ts';
import './owned-loops.css';

type Action = 'pause' | 'resume' | 'run' | 'cancel';

function refusal(error: unknown): string {
  const failed = error instanceof ApiError ? error : new ApiError(0, String(error));
  return loopRefusal(failed.unreachable ? 0 : failed.status, failed.body);
}

/**
 * D94: a Switchboard loop's actions: Pause / Resume, Run now, Edit, Cancel (with a
 * confirmation). The change comes back through `sessionUpdated`.
 */
export function OwnedLoopActions({ loop, closed, compact = false }: { readonly loop: OwnedLoop; readonly closed: boolean; readonly compact?: boolean }) {
  const { open } = useModals();
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: Action): Promise<void> => {
    setBusy(action);
    setError(null);
    try {
      if (action === 'cancel') await api.cancelLoop(loop.sessionId, loop.id);
      else await api.loopAction(loop.sessionId, loop.id, action);
      setConfirming(false);
    } catch (caught) {
      setError(refusal(caught));
    } finally {
      setBusy(null);
    }
  };
  const ended = loop.state === 'ended';
  return (
    <div className="sb-oloop__actions" data-compact={compact ? 'true' : undefined}>
      {confirming ? (
        <span className="sb-oloop__confirm" data-testid="owned-loop-confirm">
          <span>Cancel this loop?</span>
          <button type="button" className="sb-button sb-oloop__btn sb-oloop__btn--danger" data-testid="owned-loop-cancel-yes" disabled={busy !== null} onClick={() => void run('cancel')}>
            Yes, cancel it
          </button>
          <button type="button" className="sb-button sb-oloop__btn" data-testid="owned-loop-cancel-no" onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </span>
      ) : (
        <>
          {!ended && !closed ? (
            loop.state === 'paused' ? (
              <button type="button" className="sb-button sb-oloop__btn" data-testid="owned-loop-resume" disabled={busy !== null} onClick={() => void run('resume')}>
                Resume
              </button>
            ) : (
              <button type="button" className="sb-button sb-oloop__btn" data-testid="owned-loop-pause" disabled={busy !== null} onClick={() => void run('pause')}>
                Pause
              </button>
            )
          ) : null}
          {!ended && !closed ? (
            <button type="button" className="sb-button sb-oloop__btn" data-testid="owned-loop-run" disabled={busy !== null} title="Send the prompt now (counts as a run)" onClick={() => void run('run')}>
              Run now
            </button>
          ) : null}
          {!ended && !closed ? (
            <button type="button" className="sb-button sb-oloop__btn" data-testid="owned-loop-edit" disabled={busy !== null} onClick={() => open('loop', { loop: { sessionId: loop.sessionId, edit: loop } })}>
              Edit
            </button>
          ) : null}
          <button type="button" className="sb-button sb-oloop__btn" data-testid="owned-loop-cancel" disabled={busy !== null} onClick={() => setConfirming(true)}>
            {ended ? 'Remove' : 'Cancel'}
          </button>
        </>
      )}
      {error ? (
        <span className="sb-oloop__error" role="alert" data-testid="owned-loop-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** D94: a Switchboard loop's card on Schedules & loops (first-class: actions, exact next firing, expiry). */
export function OwnedLoopCard({ card }: { readonly card: OwnedLoopCardModel }) {
  const { navigate } = useRouter();
  return (
    <div className="sb-loop sb-oloop" style={{ borderColor: card.border }} data-testid="owned-loop-card" data-loop-id={card.id} data-session-id={card.sessionId} data-state={card.state} data-machine={card.machine?.id}>
      <div className="sb-loop__head">
        <span className="sb-loop__dot" style={{ background: card.dot }} />
        <span className="sb-loop__name" data-testid="owned-loop-session">
          {card.sessionName}
        </span>
        <MachineTag machine={card.machine} testId="owned-loop-machine" />
        <span className="sb-loop__kind sb-oloop__title" data-testid="owned-loop-title">
          {LOOP_SYMBOL} {card.title}
        </span>
        <button type="button" className="sb-button sb-loop__open" data-testid="owned-loop-open" onClick={() => navigate({ view: 'session', id: card.sessionId, tab: 'chat' })}>
          Open session
        </button>
      </div>
      <div className="sb-oloop__prompt" data-testid="owned-loop-prompt" title={card.loop.prompt}>
        {card.promptLine}
      </div>
      <div className="sb-loop__facts sb-oloop__facts">
        {card.facts.map((fact) => (
          <div key={fact.k} className="sb-loop__fact" data-testid="owned-loop-fact" data-k={fact.k}>
            <span className="sb-loop__fact-k">{fact.k}</span>
            <span className="sb-loop__fact-v" title={fact.title}>
              {fact.v}
            </span>
          </div>
        ))}
      </div>
      <div className="sb-oloop__foot">
        <span className="sb-oloop__state" data-testid="owned-loop-state" data-state={card.state}>
          Run by Switchboard · {card.stateText}
          {card.lastError && card.state !== 'ended' ? ` · last skipped: ${card.lastError}` : ''}
        </span>
        <OwnedLoopActions loop={card.loop} closed={card.closed} />
      </div>
    </div>
  );
}

/**
 * D94: the session's Switchboard loops above the composer (one compact row each:
 * title, schedule, next, runs, actions); hidden when it has none. A paired
 * machine's session's loops act through the proxy; an offline one's are read-only.
 */
export function SessionLoopStrip({ session, blocked }: { readonly session: Session | null; readonly blocked: string | null }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const cards = useMemo(() => (session ? (session.ownedLoops ?? []).filter((loop) => loop.state !== 'ended').map((loop) => ownedLoopCard(session, loop, now)) : []), [session, now]);
  if (cards.length === 0) return null;
  return (
    <div className="sb-oloop-strip" data-testid="session-loop-strip" data-count={cards.length}>
      {cards.map((card) => (
        <div key={card.id} className="sb-oloop-row" data-testid="session-loop" data-loop-id={card.id} data-state={card.state}>
          <span className="sb-oloop-row__title" title={card.loop.prompt}>
            {LOOP_SYMBOL} {card.title}
          </span>
          <span className="sb-oloop-row__facts" data-testid="session-loop-facts">
            {card.facts.map((fact) => `${fact.k.toLowerCase()} ${fact.v}`).join(' · ')}
          </span>
          {blocked ? null : <OwnedLoopActions loop={card.loop} closed={card.closed} compact />}
        </div>
      ))}
    </div>
  );
}

/** D94: the line above the loop cards with **+ New loop** (a loop Switchboard fires into an open session). */
export function LoopsBar() {
  const { open } = useModals();
  return (
    <div className="sb-oloop-bar">
      <span className="sb-oloop-bar__title">Loops</span>
      <span className="sb-oloop-bar__sub">run by Switchboard, or by a session&apos;s CLI</span>
      <button type="button" className="sb-button sb-sch-new" data-testid="loop-new" data-tour="loop-new" onClick={() => open('loop', { loop: {} })}>
        + New loop
      </button>
    </div>
  );
}

/** What the loop dialog opens with: the session (New loop… from a session), or a loop to edit. */
export interface LoopDialogTarget {
  readonly sessionId?: string | null;
  readonly edit?: OwnedLoop | null;
}

const KIND_LABELS: Readonly<Record<LoopDraftKind, string>> = { every: 'Every', cron: 'Cron', at: 'Once at' };

/**
 * D94 · New loop… / Edit: the prompt, the schedule (every n minutes, a cron
 * expression in local time, or once at a time), the expiry (empty = no expiry),
 * max runs and a label. From Schedules & loops it also asks for the session.
 */
export function LoopDialog({ target, onClose }: { readonly target: LoopDialogTarget; readonly onClose: () => void }) {
  const editing = target.edit ?? null;
  const [draft, setDraft] = useState<LoopDraft>(() => (editing ? draftFromLoop(editing) : EMPTY_LOOP_DRAFT));
  const [sessionId, setSessionId] = useState<string>(editing?.sessionId ?? target.sessionId ?? '');
  const [sessions, setSessions] = useState<readonly SessionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const pickSession = !editing && !target.sessionId;
  useEffect(() => {
    if (!pickSession) return;
    let live = true;
    api
      .listSessions()
      .then((list) => {
        if (!live) return;
        const open = list.filter((session) => session.closedAt == null);
        setSessions(open);
        setSessionId((current) => current || (open[0]?.id ?? ''));
      })
      .catch(() => live && setSessions([]));
    return () => {
      live = false;
    };
  }, [pickSession]);
  const set = <K extends keyof LoopDraft>(key: K, value: LoopDraft[K]): void => setDraft((current) => ({ ...current, [key]: value }));
  const save = async (): Promise<void> => {
    const checked = draftInput(draft, new Date());
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    if (sessionId === '') {
      setError('Pick the session the prompt goes to.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing) await api.updateLoop(editing.sessionId, editing.id, checked.input);
      else await api.createLoop(sessionId, checked.input);
      onClose();
    } catch (caught) {
      setError(refusal(caught));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="sb-overlay" data-modal="loop" onClick={onClose}>
      <div className="sb-modal-loop" role="dialog" aria-modal="true" aria-label={editing ? 'Edit loop' : 'New loop'} data-testid="loop-dialog" onClick={(event: MouseEvent) => event.stopPropagation()}>
        <div className="sb-oloop-form__title">{editing ? 'Edit loop' : 'New loop'}</div>
        <div className="sb-oloop-form__sub">Switchboard sends the prompt into the session at each firing: it waits while the agent is busy, resumes a paused session and survives restarts.</div>
        {pickSession ? (
          <label className="sb-oloop-form__field">
            <span className="sb-oloop-form__label">Session</span>
            <select className="sb-oloop-form__input" data-testid="loop-dialog-session" value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
              {sessions === null ? <option value="">Loading…</option> : null}
              {sessions?.length === 0 ? <option value="">No open sessions</option> : null}
              {(sessions ?? []).map((session) => (
                <option key={session.id} value={session.id}>
                  {displayTitle(session)}
                  {session.machine ? ` · ${session.machine.name}` : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="sb-oloop-form__field">
          <span className="sb-oloop-form__label">Prompt</span>
          <textarea className="sb-oloop-form__input sb-oloop-form__prompt" data-testid="loop-dialog-prompt" rows={4} value={draft.prompt} placeholder="Check the CI run and report what failed." onChange={(event) => set('prompt', event.target.value)} />
        </label>
        <div className="sb-oloop-form__field">
          <span className="sb-oloop-form__label" id={`${id}-kind`}>
            Schedule
          </span>
          <div className="sb-oloop-form__kinds" role="radiogroup" aria-labelledby={`${id}-kind`}>
            {(['every', 'cron', 'at'] as const).map((kind) => (
              <button key={kind} type="button" role="radio" aria-checked={draft.kind === kind} className="sb-button sb-oloop-form__kind" data-testid={`loop-dialog-kind-${kind}`} data-on={draft.kind === kind ? 'true' : undefined} onClick={() => set('kind', kind)}>
                {KIND_LABELS[kind]}
              </button>
            ))}
          </div>
          {draft.kind === 'every' ? (
            <span className="sb-oloop-form__inline">
              every
              <input className="sb-oloop-form__input sb-oloop-form__num" data-testid="loop-dialog-every" inputMode="numeric" value={draft.every} onChange={(event) => set('every', event.target.value)} />
              minutes
            </span>
          ) : draft.kind === 'cron' ? (
            <input className="sb-oloop-form__input" data-testid="loop-dialog-cron" placeholder="*/30 * * * * (this machine's local time)" value={draft.cron} onChange={(event) => set('cron', event.target.value)} />
          ) : (
            <input className="sb-oloop-form__input" data-testid="loop-dialog-at" type="datetime-local" value={draft.at} onChange={(event) => set('at', event.target.value)} />
          )}
        </div>
        <div className="sb-oloop-form__row">
          <label className="sb-oloop-form__field">
            <span className="sb-oloop-form__label">Expires (empty = no expiry)</span>
            <input className="sb-oloop-form__input" data-testid="loop-dialog-expires" type="datetime-local" value={draft.expires} onChange={(event) => set('expires', event.target.value)} />
          </label>
          <label className="sb-oloop-form__field">
            <span className="sb-oloop-form__label">Max runs (empty = no limit)</span>
            <input className="sb-oloop-form__input" data-testid="loop-dialog-max-runs" inputMode="numeric" value={draft.maxRuns} onChange={(event) => set('maxRuns', event.target.value)} />
          </label>
        </div>
        <label className="sb-oloop-form__field">
          <span className="sb-oloop-form__label">Label (optional)</span>
          <input className="sb-oloop-form__input" data-testid="loop-dialog-label" placeholder="CI watch" value={draft.label} onChange={(event) => set('label', event.target.value)} />
        </label>
        {error ? (
          <div className="sb-oloop__error" role="alert" data-testid="loop-dialog-error">
            {error}
          </div>
        ) : null}
        <div className="sb-oloop-form__actions">
          <button type="button" className="sb-button sb-oloop__btn" data-testid="loop-dialog-close" onClick={onClose}>
            Close
          </button>
          <button type="button" className="sb-button sb-oloop__btn sb-oloop__btn--primary" data-testid="loop-dialog-save" disabled={saving} onClick={() => void save()}>
            {editing ? 'Save' : 'Create loop'}
          </button>
        </div>
      </div>
    </div>
  );
}
