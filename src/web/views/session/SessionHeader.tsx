import { useEffect, useRef, useState } from 'react';
import type { AttachWarning, AttachWarningReason, Session } from '../../../core/api.ts';
import { REMOTE_COPY_NOTE, remoteSessionUrl } from '../../../core/remote-session.ts';
import { CLOSE_LABEL, REOPEN_LABEL, isClosed } from '../../../core/session-close.ts';
import { ApiError, api } from '../../api/client.ts';
import { useCloseSession } from '../../components/CloseSession.tsx';
import { InlineTitle } from '../../components/InlineTitle.tsx';
import { PhoneGlyph } from '../../components/PhoneGlyph.tsx';
import { MachineTag } from '../../components/MachineTag.tsx';
import { offlineReason } from '../../../core/peers.ts';
import { useLiveMachine } from '../../api/useMachines.ts';
import { MachineStatusNote } from '../../components/MachineStatusNote.tsx';
import { Link, type SessionTab, useRouter } from '../../router.tsx';
import { TakeoverAction } from '../../takeover/TakeoverAction.tsx';
import { openContinueHooked } from '../../hooked-continue/store.ts';
import { CONTINUE_HOOKED_LABEL, offersHookedContinue } from '../../../core/hooked-continue.ts';
import { usePairedMachines } from '../../takeover/usePairedMachines.ts';
import { moveLinkId, movedToLabel, takenOverLabel } from '../../../core/takeover.ts';
import { statusColor } from '../../shell/format.ts';
import {
  ATTACH_ANYWAY,
  ATTACH_HERE,
  CANCEL,
  HOOKED_NOTE,
  CONTINUE_IN_TERMINAL,
  REMOTE_LABEL,
  REMOTE_LINK_LABEL,
  actionErrorText,
  attachWarningText,
  hookedDeliveryNote,
  hooksOutdatedNote,
  pauseButton,
  remoteToggle,
  rootLine,
  tabLabels,
} from './session-header.ts';
import { ModelPicker } from './ModelPicker.tsx';
import { useProviderSwitcher } from './ProviderSwitcher.tsx';
import { useAccountSwitcher } from './AccountSwitcher.tsx';
import { offersSwitcher } from './provider-switch.ts';
import { RemotePopover } from './RemotePopover.tsx';
import { ChipSkeletons, RootSkeleton, TitleSkeleton } from './SessionSkeletons.tsx';
import { usePanes } from '../../shell/Panes.tsx';
import { DrawerButton, useInboxCount } from '../../shell/AppBar.tsx';
import { useHeaderMenu } from '../../shell/useLayout.ts';

/** D74: the sidebar's menu button at the start of a compact session header, with the Inbox count (the view has no app bar). */
function SessionDrawerButton() {
  return <DrawerButton pane="sidebar" badge={useInboxCount()} className="sb-sv-drawer" />;
}

function MoreGlyph() {
  return (
    <svg width="15" height="4" viewBox="0 0 15 4" aria-hidden="true" focusable="false">
      <circle cx="2" cy="2" r="1.6" fill="currentColor" />
      <circle cx="7.5" cy="2" r="1.6" fill="currentColor" />
      <circle cx="13" cy="2" r="1.6" fill="currentColor" />
    </svg>
  );
}

/**
 * D74 · below 1024 px the header's actions (the CLI, account and model pickers,
 * Close, Remote, take-over, Pause, Continue in terminal) sit in a ⋯ menu: the
 * same elements, shown as a menu under the top row while it is open
 * (`docs/responsive.md`). It closes on a tap outside, on Escape and after an
 * action that does not open its own popover.
 */
function useActionsMenu(enabled: boolean) {
  const [open, setOpen] = useState(false);
  const actions = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  useEffect(() => {
    if (!open) return undefined;
    const down = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (actions.current?.contains(target) || toggle.current?.contains(target)) return;
      // A popover of an action (the model picker…) or a dialog it opened keeps the menu.
      if (target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return;
      setOpen(false);
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  /** An action was clicked: the menu closes unless the action opens a popover of its own (or is the Remote switch, whose popover follows). */
  const onActionClick = (event: React.MouseEvent<HTMLElement>): void => {
    if (!enabled) return;
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button || button.hasAttribute('aria-haspopup') || button.getAttribute('role') === 'switch' || button.closest('[role="dialog"], [role="menu"]')) return;
    setOpen(false);
  };
  return { open, setOpen, actions, toggle, onActionClick };
}

/** Props of {@link SessionHeader}. */
export interface SessionHeaderProps {
  readonly sessionId: string;
  /** `null` while loading or when there is no such session. */
  readonly session: Session | null;
  /** `true` when the service answered 404 for the id. */
  readonly missing: boolean;
  /** D45: why the session could not be loaded (any failure but a 404), shown in the error line; `null` otherwise. */
  readonly loadError?: string | null;
  /** D45: the session's data is late: the title bar and root line placeholders show. */
  readonly placeholder?: boolean;
  readonly tab: SessionTab;
  /** Changed files (`SessionDetail.files`) and session artifacts, for the tab counts; D45: `null` while the detail loads (no count). */
  readonly files: number | null;
  readonly artifacts: number | null;
  /** A header action changed the session: reload it. */
  readonly onChanged: () => void;
}

function isAttachWarning(error: unknown): AttachWarning | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as Partial<AttachWarning> | null;
  return body && body.error === 'attach-warning' && Array.isArray(body.reasons) ? (body as AttachWarning) : null;
}

/**
 * Session header (SPEC → Session; prototype `vSession` header): status dot, name
 * (D22: its display title; a click renames it in place, `InlineTitle`),
 * root path, Pause / Resume (D7), "⇄ Continue in terminal" / "⇄ Attach here"
 * (M0.4), the chips (k v, mono; loop / workflow chips blue) and the tabs
 * Chat · Timeline · Diff · n · Artifacts · n.
 *
 * "⇄ Continue in terminal" = `POST /detach` (the D7 stop; the handoff card then
 * shows the command). "⇄ Attach here" = `POST /attach`; when a terminal may still
 * hold the session (gap #5) the service answers 409 `attach-warning`, the warning
 * shows here, and "Attach anyway" repeats it with `{ confirm: true }`.
 *
 * D24: a **Remote** toggle before Pause (`PUT /api/sessions/{id}/remote`), off by
 * default, disabled with the reason as its tooltip unless the process is live and
 * Remote Control is available; while it is on, "Link & QR" opens the popover (the
 * claude.ai link, its QR code, the transcript note), which also opens by itself
 * once Remote is turned on. A refusal shows the server's text (the CLI's, verbatim).
 * Sessions without Remote state (`remote: null`, the demo's) show no toggle.
 * D25: a local copy of a remote session gets a note under the top row (new work
 * stays local) with a link to the remote session on claude.ai.
 * D31: the model and effort picker (`Opus 5.5 · high ▾`, {@link ModelPicker}) is
 * the first header action; sessions without model information (the demo's) show none.
 * D33: **Close** first among the actions (so Pause and "Continue in terminal" keep
 * the prototype's places): it closes the session, asking first while it runs or
 * waits (`useCloseSession`), then the Inbox opens. A closed session (reached by
 * its address) shows **Reopen** there instead.
 */
export function SessionHeader({ sessionId, session, missing, loadError = null, placeholder = false, tab, files, artifacts, onChanged }: SessionHeaderProps) {
  const { navigate } = useRouter();
  const [busy, setBusy] = useState<'pause' | 'resume' | 'detach' | 'attach' | 'remote' | 'reopen' | null>(null);
  // D33: closed from the session view: the Inbox opens (the sidebar follows `sessionUpdated`).
  const closer = useCloseSession(() => navigate({ view: 'inbox' }));
  const closed = session ? isClosed(session) : false;
  const [warning, setWarning] = useState<readonly AttachWarningReason[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [popover, setPopover] = useState(false);
  // D74: the compact layouts (`docs/responsive.md`): the menu button, the panel button and, below 1024 px, the ⋯ menu.
  const { compact } = usePanes();
  const headerMenu = useHeaderMenu();
  const actionsMenu = useActionsMenu(headerMenu);
  const shownError = error ?? closer.error?.text ?? loadError;
  // D62 P5: the CLI switcher (its picker among the actions, its confirmation under the top row).
  const switcher = useProviderSwitcher(session, onChanged);
  // D63: the account the session runs on, Switch account and the pin (shown when its CLI has more than one account).
  const accounts = useAccountSwitcher(session, onChanged);
  // D65: this machine's id, to link a moved session's new home (`r~<machine>~<id>`, or a local id when it came here).
  const selfId = usePairedMachines(session?.movedTo != null).self?.id ?? null;

  const run = async (action: NonNullable<typeof busy>, call: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      await call();
      setWarning(null);
    } catch (caught) {
      const attachWarning = action === 'attach' ? isAttachWarning(caught) : null;
      if (attachWarning) setWarning(attachWarning.reasons);
      else setError(caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null));
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  // D48 P4: a hooked terminal session: what hooks cannot do is not offered (the note says where it stays).
  const hooked = session?.hooked === true;
  // D48 ruling D48-cache-persist: an unreachable machine's session shows its last known state; every action waits for the reconnection.
  // Fix · peer reconnects: the machine's live state (a block lifts the moment it is back); `reconnecting` blocks nothing.
  const machine = useLiveMachine(session?.machine);
  const blocked = offlineReason(machine);
  const pause = session && !hooked ? pauseButton(session) : null;
  const attached = session?.attached ?? true;
  const remote = session && !hooked ? remoteToggle(session) : null;

  // D24: on → off (or on and back) never leaves the popover of an old link open.
  const remoteUrl = remote?.url ?? null;
  useEffect(() => {
    if (remoteUrl === null) setPopover(false);
  }, [remoteUrl]);
  // …nor the popover of another session when the view switches sessions.
  useEffect(() => setPopover(false), [sessionId]);

  const toggleRemote = async (): Promise<void> => {
    if (!remote || remote.disabled || busy) return;
    const enabled = !remote.on;
    setBusy('remote');
    setError(null);
    try {
      const updated = await api.setRemote(sessionId, enabled);
      // Turned on: show the link and the QR code at once.
      setPopover(enabled && (updated.remote?.url ?? null) !== null);
    } catch (caught) {
      setError(caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null));
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  return (
    <div className="sb-sv-header" data-testid="session-header" data-session-id={sessionId}>
      <div className="sb-sv-top">
        {compact ? <SessionDrawerButton /> : null}
        <span className="sb-sv-dot" data-testid="session-dot" style={{ background: statusColor(session?.status ?? 'idle') }} />
        {session ? (
          <InlineTitle session={session} gesture="click" as="div" className="sb-sv-name" testId="session-name" onRenamed={onChanged} />
        ) : (
          // D45: nothing while the session loads (its placeholder once it is late); the id when it could not be loaded.
          <div className="sb-sv-name" data-testid="session-name">
            {placeholder ? <TitleSkeleton /> : missing || loadError ? sessionId : null}
          </div>
        )}
        {/* D48: a peer's session names its machine. */}
        {session?.machine ? <MachineTag machine={session.machine} testId="session-machine" /> : null}
        <div className="sb-sv-root" data-testid="session-root" title={session && !missing ? rootLine(session) : undefined}>
          {placeholder ? <RootSkeleton /> : <span className="sb-sv-root-text">{missing ? 'no such session' : session ? rootLine(session) : ''}</span>}
        </div>
        <div
          className="sb-sv-actions"
          ref={actionsMenu.actions}
          id={headerMenu ? `sb-sv-actions-${sessionId}` : undefined}
          data-menu={headerMenu ? (actionsMenu.open ? 'open' : 'closed') : undefined}
          data-testid={headerMenu ? 'session-actions-menu' : undefined}
          onClick={headerMenu ? actionsMenu.onActionClick : undefined}
        >
          {/* D62 P5: the CLI the session runs on, and switching it (sessions Switchboard runs; not the demo's, not hooked). */}
          {session && !blocked && offersSwitcher(session) ? switcher.picker : null}
          {session && !blocked && offersSwitcher(session) ? accounts.picker : null}
          {session && !hooked && !blocked ? <ModelPicker sessionId={sessionId} session={session} onChanged={onChanged} /> : null}
          <button
            type="button"
            className="sb-button sb-sv-action"
            data-testid="session-close"
            data-action={closed ? 'reopen' : 'close'}
            disabled={!session || blocked !== null || busy !== null || closer.busyId !== null || (closed && session?.movedTo != null)}
            title={blocked ?? (closed && session?.movedTo ? `Taken over to ${session.movedTo.machineName}: continue it there` : undefined)}
            aria-busy={busy === 'reopen' || closer.busyId === sessionId || undefined}
            onClick={() => {
              if (!session) return;
              if (closed) void run('reopen', () => api.reopenSession(sessionId));
              else closer.request(session);
            }}
          >
            {closed ? REOPEN_LABEL : CLOSE_LABEL}
          </button>
          {remote ? (
            <div className="sb-sv-remote" data-testid="session-remote">
              <button
                type="button"
                role="switch"
                aria-checked={remote.on}
                className="sb-button sb-sv-action sb-sv-remote-toggle"
                data-testid="session-remote-toggle"
                data-state={remote.on ? 'on' : 'off'}
                data-reason={remote.reason ?? undefined}
                disabled={remote.disabled || blocked !== null || busy !== null}
                aria-busy={busy === 'remote' || undefined}
                title={remote.title}
                onClick={() => void toggleRemote()}
              >
                <PhoneGlyph className="sb-sv-remote-glyph" />
                {REMOTE_LABEL}
              </button>
              {remote.url ? (
                <button
                  type="button"
                  className="sb-button sb-sv-action"
                  data-testid="session-remote-link"
                  aria-expanded={popover}
                  aria-haspopup="dialog"
                  onClick={() => setPopover((open) => !open)}
                >
                  {REMOTE_LINK_LABEL}
                </button>
              ) : null}
              {popover && remote.url ? <RemotePopover url={remote.url} onClose={() => setPopover(false)} /> : null}
            </div>
          ) : null}
          {/* D65: take a session over to / from a paired machine. */}
          {!blocked ? <TakeoverAction session={session} sessionId={sessionId} /> : null}
          {hooked ? null : (
          <button
            type="button"
            className="sb-button sb-sv-action"
            data-testid="session-pause"
            data-action={pause?.action}
            disabled={!session || pause?.disabled || blocked !== null || busy !== null}
            aria-busy={busy === 'pause' || busy === 'resume' || undefined}
            title={blocked ?? (pause?.disabled ? 'Attach here first: a terminal owns the session' : undefined)}
            onClick={() =>
              pause && void run(pause.action, () => (pause.action === 'pause' ? api.pauseSession(sessionId) : api.resumeSession(sessionId)))
            }
          >
            {pause?.label ?? 'Pause'}
          </button>
          )}
          {/* D48: the terminal handoff is on the machine the session runs on; not offered for a peer's session. */}
          {session?.machine || hooked ? null : (
          <button
            type="button"
            className="sb-button sb-sv-action"
            data-testid="session-handoff"
            data-action={attached ? 'detach' : 'attach'}
            disabled={!session || busy !== null}
            aria-busy={busy === 'detach' || busy === 'attach' || undefined}
            onClick={() => void run(attached ? 'detach' : 'attach', () => (attached ? api.detachSession(sessionId) : api.attachSession(sessionId)))}
          >
            {attached ? CONTINUE_IN_TERMINAL : ATTACH_HERE}
          </button>
          )}
        </div>
        {/* D74: after the row's own parts (their child paths are the prototype's); compact layouts only. */}
        {compact ? <DrawerButton pane="rightPanel" className="sb-sv-panel-open" /> : null}
        {headerMenu ? (
          <button
            type="button"
            ref={actionsMenu.toggle}
            className="sb-button sb-sv-more"
            data-testid="session-more"
            aria-label="Session actions"
            aria-haspopup="true"
            aria-expanded={actionsMenu.open}
            aria-controls={`sb-sv-actions-${sessionId}`}
            onClick={() => actionsMenu.setOpen((open) => !open)}
          >
            <MoreGlyph />
          </button>
        ) : null}
      </div>
      {/* Fix · peer reconnects: "Reconnecting to …" (nothing blocked) or "… is unreachable · retrying in 8 s" with Reconnect now. */}
      <MachineStatusNote machine={machine} testId="session-offline-note" className="sb-sv-remote-copy" />
      {hooked ? (
        <div className="sb-sv-remote-copy" data-testid="session-hooked-note">
          {HOOKED_NOTE}
          {/* D72: make it a Switchboard-run session (its terminal's claude is stopped first, with a confirmation). */}
          {session && offersHookedContinue(session) && !blocked ? (
            <>
              {' '}
              <button
                type="button"
                className="sb-sv-remote-copy-link sb-sv-hooked-continue"
                data-testid="session-continue-hooked"
                onClick={() => openContinueHooked({ sessionId, title: session.displayTitle ?? session.title ?? session.name, machineName: session.machine?.name ?? null })}
              >
                {CONTINUE_HOOKED_LABEL}
              </button>
            </>
          ) : null}
          {/* D53: no hook listening yet (or the session ended): messages wait, and why. */}
          {hookedDeliveryNote(session) ? (
            <>
              {' '}
              <strong className="sb-sv-hooked-delivery" data-testid="session-hooked-delivery">
                {hookedDeliveryNote(session)}
              </strong>
            </>
          ) : null}
          {hooksOutdatedNote(session) ? (
            <>
              {' '}
              <strong className="sb-sv-hooked-delivery" data-testid="session-hooks-outdated">
                {hooksOutdatedNote(session)}
              </strong>
            </>
          ) : null}
        </div>
      ) : null}
      {session?.movedTo ? (
        <div className="sb-sv-remote-copy sb-sv-moved" data-testid="session-moved-note">
          <span>{movedToLabel(session.movedTo.machineName)}</span>
          <Link to={{ view: 'session', id: moveLinkId(session.movedTo, selfId), tab: 'chat' }} className="sb-sv-remote-copy-link" data-testid="session-moved-link">
            Open the new session
          </Link>
        </div>
      ) : null}
      {session?.movedFrom && !session.movedTo ? (
        <div className="sb-sv-remote-copy sb-sv-moved" data-testid="session-taken-over-note">
          <span>{takenOverLabel(session.movedFrom.machineName)}</span>
        </div>
      ) : null}
      {session?.remoteSource ? (
        <div className="sb-sv-remote-copy" data-testid="session-remote-copy-note">
          <span>{REMOTE_COPY_NOTE}</span>
          <a
            className="sb-sv-remote-copy-link"
            data-testid="session-remote-copy-link"
            href={remoteSessionUrl(session.remoteSource)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {session.remoteSource}
          </a>
        </div>
      ) : null}
      {session && offersSwitcher(session) ? switcher.panel : null}
      {session && offersSwitcher(session) ? accounts.panel : null}
      {warning ? (
        <div className="sb-sv-warning" role="alertdialog" aria-label="Attach here" data-testid="attach-warning">
          <div className="sb-sv-warning-text" data-testid="attach-warning-text">
            {attachWarningText(warning)}
          </div>
          <div className="sb-sv-warning-actions">
            <button
              type="button"
              className="sb-button sb-sv-primary"
              data-testid="attach-confirm"
              disabled={busy !== null}
              onClick={() => void run('attach', () => api.attachSession(sessionId, true))}
            >
              {ATTACH_ANYWAY}
            </button>
            <button type="button" className="sb-button sb-sv-outlined" data-testid="attach-cancel" disabled={busy !== null} onClick={() => setWarning(null)}>
              {CANCEL}
            </button>
          </div>
        </div>
      ) : null}
      {shownError ? (
        <div className="sb-sv-error" role="alert" data-testid="session-error">
          {shownError}
        </div>
      ) : null}
      {closer.dialog}
      <div className="sb-sv-chips" data-testid="session-chips">
        {/* D45 (developer ruling): chip-shaped blocks hold the row while the session loads, so the tabs do not jump. */}
        {placeholder ? <ChipSkeletons /> : null}
        {(session?.chips ?? []).map((chip) => (
          <span key={`${chip.k} ${chip.v}`} className="sb-sv-chip" data-testid="session-chip" data-loop={chip.loop ? 'true' : 'false'}>
            <span className="sb-sv-chip-k">{chip.k} </span>
            {chip.v}
          </span>
        ))}
      </div>
      <div className="sb-sv-tabs" role="tablist">
        {tabLabels(files, artifacts).map((entry) => (
          <Link
            key={entry.tab}
            to={{ view: 'session', id: sessionId, tab: entry.tab }}
            className="sb-sv-tab"
            role="tab"
            data-testid={`session-tab-${entry.tab}`}
            aria-selected={entry.tab === tab}
          >
            {entry.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
