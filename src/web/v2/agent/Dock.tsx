import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, SessionDetail, SessionTodo } from '../../../core/api.ts';
import type { QueuedReason } from '../../../core/event-payload.ts';
import { type ComposerDraft, draftField } from '../../../core/drafts.ts';
import { withdrawnDraft } from '../../../core/stop-turn.ts';
import { readKnownSettings } from '../../../core/settings.ts';
import { chatActivityLine } from '../../activity/activity.ts';
import { useTick } from '../../activity/useActivity.ts';
import { ApiError, api } from '../../api/client.ts';
import { pasteFiles, useAttachmentDraft, useFileDrop } from '../../components/Attachments.tsx';
import { attachmentsBlocker, messageToSend } from '../../components/attachments.ts';
import { initialDraft, useDraft } from '../../drafts/useDraft.ts';
import { rememberDraft } from '../../drafts/session-drafts.ts';
import { useReleaseFocus } from '../../components/release-focus.ts';
import { refusalText } from '../../views/inbox.ts';
import { COMPOSER_INSERT_EVENT, composers, deliver, refusedNotes, sendsSettled } from '../../views/session/ChatTab.tsx';
import { addOutgoing } from '../../views/session/outgoing.ts';
import { turnBusy } from '../../views/session/needs-you.ts';
import { canStop, escStops, stoppableBackground } from '../../views/session/stop.ts';
import { OVERLAY_SELECTOR } from '../../views/session/subagent-chat.ts';
import { isEditing } from '../../views/session/SubagentChat.tsx';
import { freshBusy, freshEligible, loadSnooze, saveSnooze } from '../../views/session/fresh-offer.ts';
import { freshStepText } from '../../../core/fresh-session.ts';
import { useSessionTodos } from '../../views/session/TodoStrip.tsx';
import { Button, Icon, IconButton, useToast } from '../components/index.ts';
import { AGENT_WORDS, STATUS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { clock } from '../shared/time.ts';
import { type DockMessage, composerKey, composerPlaceholder, joinWithdrawn, liveLine, resetTimeOf } from './composer-model.ts';
import type { AgentData } from './useAgent.ts';
import { DraftChips } from './Attachments.tsx';
import { computerOf, continueAsAgent } from './agent-bits.ts';
import { browserStorage } from './useAgent.ts';

function refusal(error: unknown): string {
  return error instanceof ApiError ? refusalText(error.status, error.body) : refusalText(0, null);
}

/** The clock a message sent now shows until the service records it (the classic composer's rule). */
function sendQueued(session: SessionDetail | null): QueuedReason | null {
  if (!session) return null;
  if (turnBusy(session)) return 'turn';
  return session.live ? null : 'resume';
}

/** Props of {@link Dock}. */
export interface DockProps {
  readonly data: AgentData;
  readonly queued: readonly DockMessage[];
  readonly paused: readonly DockMessage[];
  /** The newest event id the chat has (a sent message's own event comes after it). */
  readonly lastEventId: () => number;
  /** A message went out: the chat follows to its end. */
  readonly onSent: () => void;
  /** `peek` / `phone`: a slimmer dock (no kbd hints, no todo strip on the peek). */
  readonly variant?: 'full' | 'peek' | 'phone';
  /** The short placeholder ("Send a follow-up") whatever the variant (the peek on a phone). */
  readonly short?: boolean;
}

/**
 * D131 · lane S · the composer dock (the prototype's `.dock`): the live line, the
 * queued and paused messages, the tasks and working-memory strips, then the box
 * with 📎 (paste, drop, chips) and Send (⌘↩); Esc stops the running reply. The
 * sending and stopping are the classic composer's (`ChatTab.tsx`: D114 instant
 * queue, D50 Stop, D88 drafts, D57 attachments, D103 held messages).
 */
export function Dock({ data, queued, paused, lastEventId, onSent, variant = 'full', short = false }: DockProps) {
  const { sessionId, session, activity, blocked, conversation } = data;
  const toast = useToast();
  const attachments = useAttachmentDraft(blocked === null ? (body) => api.uploadAttachment(sessionId, body) : undefined);
  const clearAttachments = attachments.clear;
  useEffect(() => {
    clearAttachments();
  }, [sessionId, clearAttachments]);
  const [draft, setDraft] = useState(() => initialDraft<ComposerDraft>(sessionId, draftField.composer)?.text ?? '');
  const input = useRef<HTMLTextAreaElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  useReleaseFocus(input);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopTimedOut, setStopTimedOut] = useState(false);
  const [stoppedAt, setStoppedAt] = useState<string | null>(null);
  const stoppingRef = useRef(false);

  const readOnly = conversation && session?.continuedTo != null;
  const turnRuns = session !== null && blocked === null && canStop({ live: session.live, status: session.status, activity, hooked: session.hooked === true, turnWait: session.turnWait ?? null });
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    if (!turnRuns) setStopped(false);
  }, [turnRuns]);
  const stoppable = turnRuns && !stopped;
  const stoppableRef = useRef(stoppable);
  stoppableRef.current = stoppable;
  const background = session && blocked === null ? stoppableBackground({ live: session.live, status: session.status, activity, hooked: session.hooked === true }) : [];

  // D88: the draft lives on the server per agent (it follows to a phone, another computer, a reload).
  const draftValue = useMemo<ComposerDraft>(
    () => ({ text: draft, attachments: attachments.items.flatMap((item) => (item.id !== null && item.state === 'ready' ? [{ id: item.id, name: item.name, size: item.size, kind: item.kind, mediaType: '' }] : [])) }),
    [draft, attachments.items],
  );
  const restoreAttachments = attachments.restore;
  const kept = useDraft<ComposerDraft>({
    sessionId,
    field: blocked === null && !readOnly ? draftField.composer : null,
    value: draftValue,
    root: box,
    initial: draft === '' ? null : { text: draft, attachments: [] },
    apply: (value) => {
      setDraft(value?.text ?? '');
      clearAttachments();
      if (value && value.attachments.length > 0) restoreAttachments(value.attachments, sessionId);
    },
  });

  // D103 Edit (and a queued message's Edit): the text comes back into the box, before what is typed.
  useEffect(() => {
    const insert = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId: string; text: string }>).detail;
      if (detail.sessionId !== sessionId) return;
      setDraft((current) => withdrawnDraft([detail.text], current));
      input.current?.focus();
    };
    window.addEventListener(COMPOSER_INSERT_EVENT, insert);
    return () => window.removeEventListener(COMPOSER_INSERT_EVENT, insert);
  }, [sessionId]);

  // A refused send puts its text back here (the classic composer's registry, so a refusal finds whichever composer is open).
  const restoreRef = useRef(attachments.restore);
  restoreRef.current = attachments.restore;
  useEffect(() => {
    const restore = (text: string, items: readonly Attachment[], message: string): void => {
      setDraft((current) => withdrawnDraft([text], current));
      if (items.length > 0) restoreRef.current(items, sessionId);
      setError(message);
      input.current?.focus();
    };
    composers.set(sessionId, restore);
    const missed = refusedNotes.get(sessionId);
    if (missed !== undefined) {
      refusedNotes.delete(sessionId);
      setError(missed);
    }
    return () => {
      if (composers.get(sessionId) === restore) composers.delete(sessionId);
    };
  }, [sessionId]);

  const send = (): void => {
    const message = messageToSend(draft, attachments.items);
    if (message === null || blocked !== null || readOnly) return;
    const sentItems = attachments.items.filter((item) => item.id !== null);
    const sentAttachments: Attachment[] = sentItems.flatMap((item) => (item.id !== null ? [{ id: item.id, name: item.name, size: item.size, kind: item.kind, mediaType: '' }] : []));
    setStopped(false);
    setStoppedAt(null);
    setError(null);
    kept.clear();
    rememberDraft(sessionId, draftField.composer, null);
    setDraft('');
    for (const item of sentItems) attachments.remove(item.key);
    const key = addOutgoing(sessionId, { text: message.text, attachments: sentAttachments, queued: sendQueued(session), afterId: lastEventId() });
    onSent();
    deliver(sessionId, key, message.text, message.attachments, sentAttachments);
  };

  const stop = async (): Promise<readonly string[]> => {
    if (stoppingRef.current) return [];
    stoppingRef.current = true;
    setStopping(true);
    setStopTimedOut(false);
    setError(null);
    try {
      await sendsSettled(sessionId);
      const result = await api.interruptSession(sessionId);
      if (result.outcome !== 'timeout' && result.session.status !== 'run' && result.session.status !== 'need') {
        setStopped(true);
        setStoppedAt(clock(new Date().toISOString()));
      }
      data.reload();
      if ((result.withdrawnAttachments ?? []).length > 0) attachments.restore(result.withdrawnAttachments ?? [], sessionId);
      if (result.outcome === 'timeout') setStopTimedOut(true);
      return result.withdrawn;
    } catch (caught) {
      setError(refusal(caught));
      return [];
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  };
  /** Stop: the messages it took back come into the box (D50). */
  const stopToBox = async (): Promise<void> => {
    const withdrawn = await stop();
    if (withdrawn.length > 0) {
      setDraft((current) => withdrawnDraft(withdrawn, current));
      input.current?.focus();
    }
  };
  const stopRef = useRef(stopToBox);
  stopRef.current = stopToBox;

  // D50: Esc stops the running reply when nothing else owns the key (the window's capture phase, as classic).
  useEffect(() => {
    if (variant === 'peek') return undefined;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      const active = document.activeElement;
      const context = {
        stoppable: stoppableRef.current,
        stopping: stoppingRef.current,
        overlayOpen: document.querySelector(OVERLAY_SELECTOR) !== null || (active instanceof Element && active.closest('[role="menu"]') !== null),
        editingElsewhere: isEditing(active) && active !== input.current,
      };
      if (!escStops(event, context)) return;
      event.preventDefault();
      void stopRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [variant]);

  const pause = async (): Promise<void> => {
    setStopTimedOut(false);
    try {
      await sendsSettled(sessionId);
      await api.pauseSession(sessionId);
      data.reload();
    } catch (caught) {
      setError(refusal(caught));
    }
  };
  const resume = async (): Promise<void> => {
    try {
      await api.resumeSession(sessionId);
      data.reload();
    } catch (caught) {
      setError(refusal(caught));
    }
  };
  const stopBackground = async (): Promise<void> => {
    try {
      await api.stopBackground(sessionId, {});
      toast({ text: 'Stopped the background tasks.' });
      data.reload();
    } catch (caught) {
      setError(refusal(caught));
    }
  };

  // Queued messages: Send now = stop the reply, then send what it took back at once; Edit = take them back into the box.
  const sendNow = async (): Promise<void> => {
    const withdrawn = await stop();
    const text = joinWithdrawn(withdrawn);
    if (text === '') return;
    const ids = attachments.items.flatMap((item) => (item.id !== null ? [item.id] : []));
    const sent: Attachment[] = attachments.items.flatMap((item) => (item.id !== null ? [{ id: item.id, name: item.name, size: item.size, kind: item.kind, mediaType: '' }] : []));
    for (const item of attachments.items) if (item.id !== null) attachments.remove(item.key);
    const key = addOutgoing(sessionId, { text, attachments: sent, queued: null, afterId: lastEventId() });
    onSent();
    deliver(sessionId, key, text, ids, sent);
  };
  const editQueued = (): void => void stopToBox();

  const onHeld = async (row: DockMessage, action: 'edit' | 'remove'): Promise<void> => {
    try {
      const taken = await api.withdrawHeld(sessionId, row.id);
      if (action !== 'edit') return;
      if (taken.attachments.length > 0) attachments.restore(taken.attachments, sessionId);
      setDraft((current) => withdrawnDraft([taken.text], current));
      input.current?.focus();
    } catch (caught) {
      setError(refusal(caught));
    }
  };

  // The box grows with its text (up to 8 lines), as classic D26.
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = 'auto';
    const max = parseFloat(getComputedStyle(field).lineHeight || '22') * 8 + 18;
    field.style.height = `${Math.min(field.scrollHeight, max)}px`;
    field.style.overflowY = field.scrollHeight > max ? 'auto' : 'hidden';
  }, [draft]);

  const drop = useFileDrop(attachments.add, blocked === null && !readOnly);
  const attaching = attachmentsBlocker(attachments.items);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (composerKey({ key: event.key, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, isComposing: event.nativeEvent.isComposing }) !== 'send') return;
    event.preventDefault();
    send();
  };

  const now = useTick(1000);
  const line = activity ? chatActivityLine(activity, now) : null;
  const computer = computerOf(data.machine);
  const live = liveLine({
    machine: computer,
    status: session?.status ?? null,
    activity: line ? { state: line.state, text: `${line.text}${line.more ? ` ${line.more}` : ''}`, time: line.time } : null,
    stoppable,
    backgroundStoppable: background.length > 0,
    stoppedByYou: stoppedAt,
    held: paused.length > 0,
    live: session?.live ?? false,
    conversation,
  });
  const working = session !== null && turnBusy(session);
  const placeholder = composerPlaceholder({ conversation, working: working && !stopped, blocked, short: short || variant === 'phone' });
  const full = variant === 'full';

  return (
    <div className="v2-ag-dock" data-variant={variant} data-dragging={drop.dragging ? 'true' : undefined} data-testid="v2-agent-dock" {...drop.handlers}>
      <LiveRow live={live} stopping={stopping} kbd={full} onStop={() => void stopToBox()} onResume={() => void resume()} onStopBackground={() => void stopBackground()} />
      {stopTimedOut ? (
        <div className="v2-ag-dock-note" role="alert" data-testid="v2-agent-stop-timeout">
          {AGENT_WORDS.stopTimeout}{' '}
          <Button size="sm" onClick={() => void pause()}>
            {AGENT_WORDS.pauseInstead}
          </Button>
        </div>
      ) : null}
      {queued.map((row) => (
        <div className="v2-ag-queued" key={row.key} data-testid="v2-agent-queued" data-event-id={row.id}>
          <Icon name="clock" size="s" />
          <span className="v2-grow v2-ag-queued-text">
            <b>{AGENT_WORDS.queued}</b> <span className="v2-muted">· {AGENT_WORDS.queuedNote}</span>
            <br />
            {row.text}
            {row.attachments.length > 0 ? <span className="v2-muted"> · {row.attachments.length} attachment{row.attachments.length === 1 ? '' : 's'}</span> : null}
          </span>
          <span className="v2-ag-queued-btns">
            <Button size="sm" data-testid="v2-agent-queued-now" disabled={blocked !== null || stopping || !stoppable} title={stoppable ? undefined : 'It sends by itself in a moment.'} onClick={() => void sendNow()}>
              {AGENT_WORDS.sendNow}
            </Button>
            <Button size="sm" variant="ghost" data-testid="v2-agent-queued-edit" disabled={blocked !== null || stopping || !stoppable} title={AGENT_WORDS.takeBackHint} onClick={editQueued}>
              {AGENT_WORDS.edit}
            </Button>
            <Button size="sm" variant="ghost" data-testid="v2-agent-queued-remove" disabled title={AGENT_WORDS.removeQueuedHint}>
              {AGENT_WORDS.remove}
            </Button>
          </span>
        </div>
      ))}
      {paused.map((row) => (
        <div className="v2-ag-queued v2-ag-paused" key={row.key} data-testid="v2-agent-paused" data-event-id={row.id}>
          <Icon name="pause" size="s" />
          <span className="v2-grow v2-ag-queued-text">
            <b className="v2-ag-paused-word">{AGENT_WORDS.paused(resetTimeOf(row.heldNote))}</b>
            <br />
            {row.text}
            {row.attachments.length > 0 ? ` · ${row.attachments.length} attachment${row.attachments.length === 1 ? '' : 's'}` : ''}
          </span>
          <span className="v2-ag-queued-btns">
            <Button size="sm" icon="edit" data-testid="v2-agent-paused-edit" disabled={blocked !== null} onClick={() => void onHeld(row, 'edit')}>
              {AGENT_WORDS.edit}
            </Button>
            <Button size="sm" variant="ghost" data-testid="v2-agent-paused-remove" disabled={blocked !== null} onClick={() => void onHeld(row, 'remove')}>
              {AGENT_WORDS.remove}
            </Button>
            <PaidExtraButton />
          </span>
        </div>
      ))}
      {full && !conversation ? <TasksStrip sessionId={sessionId} blocked={blocked} /> : null}
      {variant !== 'peek' ? <MemoryStrip data={data} /> : null}
      {readOnly ? (
        <div className="v2-ag-dock-note" data-testid="v2-agent-readonly">
          {AGENT_WORDS.readOnly}
        </div>
      ) : (
        <>
          <DraftChips items={attachments.items} notice={attachments.notice} onRemove={attachments.remove} />
          <div className="v2-ag-composer" ref={box}>
            <IconButton icon="clip" label={AGENT_WORDS.attach} title={AGENT_WORDS.attachHint} disabled={blocked !== null} data-testid="v2-agent-attach" onClick={() => pickFiles(attachments.add)} />
            <label className="v2-sr" htmlFor={`v2-cmp-${variant}-${sessionId}`}>
              Message
            </label>
            <textarea
              id={`v2-cmp-${variant}-${sessionId}`}
              ref={input}
              rows={1}
              data-testid="v2-agent-input"
              value={draft}
              placeholder={placeholder}
              disabled={blocked !== null}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={pasteFiles(attachments.add, blocked === null)}
            />
            {conversation && full && session?.continuedTo == null ? <ContinueAsAgent session={session} /> : null}
            <Button
              variant="primary"
              icon="send"
              data-testid="v2-agent-send"
              aria-label={AGENT_WORDS.send}
              disabled={blocked !== null || attaching !== null || (draft.trim() === '' && attachments.items.length === 0)}
              title={blocked ?? attaching ?? undefined}
              kbd={full ? '⌘↩' : undefined}
              onClick={send}
            >
              {variant === 'phone' ? null : AGENT_WORDS.send}
            </Button>
          </div>
        </>
      )}
      {draft.trim() !== '' && full ? (
        <div className="v2-ag-draft-note" data-testid="v2-agent-draft-note">
          <Icon name="edit" size="s" />
          {AGENT_WORDS.draftSaved}
        </div>
      ) : null}
      {error ? (
        <div className="v2-ag-dock-error" role="alert" data-testid="v2-agent-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** The 📎 picker (a file input made on click). */
function pickFiles(onFiles: (files: File[]) => void): void {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.addEventListener('change', () => {
    const files = Array.from(picker.files ?? []);
    if (files.length > 0) onFiles(files);
  });
  picker.click();
}

/** The live line (the prototype's `.liveline`): icon + words + time, and its button. */
function LiveRow({ live, stopping, kbd, onStop, onResume, onStopBackground }: { readonly live: ReturnType<typeof liveLine>; readonly stopping: boolean; readonly kbd: boolean; readonly onStop: () => void; readonly onResume: () => void; readonly onStopBackground: () => void }) {
  const icon =
    live.kind === 'working' || live.kind === 'background'
      ? null
      : live.kind === 'offline'
        ? 'offline'
        : live.kind === 'reconnecting'
          ? 'refresh'
          : live.kind === 'needs'
            ? 'hand'
            : live.kind === 'held'
              ? 'wallet'
              : live.kind === 'stopped'
                ? 'stop'
                : live.kind === 'paused'
                  ? 'pause'
                  : live.kind === 'done'
                    ? 'check'
                    : live.kind === 'failed'
                      ? 'octagon'
                      : 'moon';
  return (
    <div className="v2-ag-live" data-kind={live.kind} data-testid="v2-agent-live" role="status">
      {icon ? <Icon name={icon} size="s" /> : <span className="v2-pulse" aria-hidden="true" />}
      <span className="v2-ag-live-text">{live.text}</span>
      {live.time ? (
        <span className="v2-ag-live-time" data-testid="v2-agent-live-time">
          {live.kind === 'stopped' ? `at ${live.time}` : live.time}
        </span>
      ) : null}
      <span className="v2-grow" />
      {live.action === 'stop' ? (
        <Button size="sm" icon="stop" data-testid="v2-agent-stop" disabled={stopping} aria-busy={stopping || undefined} kbd={kbd ? 'Esc' : undefined} onClick={onStop}>
          {stopping ? AGENT_WORDS.stopping : AGENT_WORDS.stop}
        </Button>
      ) : null}
      {live.action === 'resume' ? (
        <Button size="sm" icon="play" data-testid="v2-agent-resume" onClick={onResume}>
          {AGENT_WORDS.resume}
        </Button>
      ) : null}
      {live.action === 'stop-background' ? (
        <Button size="sm" icon="stop" data-testid="v2-agent-stop-background" onClick={onStopBackground}>
          {AGENT_WORDS.stopBackground}
        </Button>
      ) : null}
      <span className="v2-sr">{STATUS.working.label}</span>
    </div>
  );
}

/** D103 · "Send with paid extra": not a per-message choice today; it says where the setting is (logged in the decisions). */
function PaidExtraButton() {
  const { navigate } = useV2Router();
  return (
    <Button size="sm" variant="primary" icon="wallet" data-testid="v2-agent-paused-paid" title={AGENT_WORDS.sendWithPaidHint} onClick={() => navigate('/settings/usage')}>
      {AGENT_WORDS.sendWithPaid}
    </Button>
  );
}

/** D106 · a conversation's "Continue as agent" (the + New sheet with the conversation's prefill). */
function ContinueAsAgent({ session }: { readonly session: SessionDetail | null }) {
  const start = (): void => {
    if (!session) return;
    void continueAsAgent(session);
  };
  return (
    <Button data-testid="v2-agent-continue-as-agent" onClick={start}>
      {AGENT_WORDS.continueAsAgent}
    </Button>
  );
}

/** D68 · this agent's tasks above the box (v2 style): the one in progress, and the list folded under it. */
function TasksStrip({ sessionId, blocked }: { readonly sessionId: string; readonly blocked: string | null }) {
  const todos = useSessionTodos(sessionId);
  const [open, setOpen] = useState(false);
  const list = todos.list?.todos ?? [];
  if (list.length === 0) return null;
  const done = list.filter((t) => t.state === 'done').length;
  const current = list.find((t) => t.state === 'in_progress') ?? list.find((t) => t.state === 'open') ?? null;
  const toggle = (todo: SessionTodo): void => {
    void todos.run(() => api.updateTodo(sessionId, todo.id, { state: todo.state === 'done' ? 'open' : 'done' }));
  };
  return (
    <div className="v2-ag-tasks" data-testid="v2-agent-tasks" data-open={open ? 'true' : undefined}>
      <button type="button" className="v2-ag-strip-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="task" size="s" />
        <b>{AGENT_WORDS.tasksStrip(list.length - done, done)}</b>
        {current && !open ? <span className="v2-ag-strip-sub">· {current.title}</span> : null}
        <span className="v2-grow" />
        <Icon name="chev" size="s" className="v2-ag-chev" />
      </button>
      {open ? (
        <ul className="v2-ag-tasks-list">
          {list.map((todo) => (
            <li key={todo.id} data-state={todo.state} data-testid="v2-agent-task">
              <button type="button" className="v2-ag-task-check" role="checkbox" aria-checked={todo.state === 'done'} disabled={blocked !== null} aria-label={todo.title} onClick={() => toggle(todo)}>
                <Icon name={todo.state === 'done' ? 'check-circle' : todo.state === 'in_progress' ? 'dot' : 'circle'} size="s" />
              </button>
              <span className="v2-grow">{todo.title}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {todos.error ? (
        <div className="v2-ag-dock-error" role="alert">
          {todos.error}
        </div>
      ) : null}
    </div>
  );
}

/** The Settings → Sessions offer (D83): on, and at what percentage. */
function useFreshSettings(): { readonly enabled: boolean; readonly pct: number } | null {
  const [value, setValue] = useState<{ enabled: boolean; pct: number } | null>(null);
  useEffect(() => {
    let alive = true;
    api.settings().then(
      (body) => {
        if (!alive) return;
        const known = readKnownSettings(body);
        setValue({ enabled: known['sessions.freshOffer'], pct: known['sessions.freshOfferPct'] });
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  return value;
}

/**
 * D49 / D83 · "Working memory" above the box: a thin meter while it fills; past the
 * offer's threshold (between replies) the amber note with **Continue with a clean
 * slate** and Not now; while a continuation runs, which step.
 */
export function MemoryStrip({ data }: { readonly data: AgentData }) {
  const { session, sessionId, activity, blocked } = data;
  const settings = useFreshSettings();
  const { navigate } = useV2Router();
  const [snoozedAt, setSnoozedAt] = useState<number | null>(() => loadSnooze(browserStorage(), sessionId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(false);
  const target = session?.continuedTo?.sessionId ?? null;
  useEffect(() => {
    if (target && asked.current) {
      asked.current = false;
      navigate(`/agents/${encodeURIComponent(target)}`);
    }
  }, [target, navigate]);
  const context = session?.context ?? null;
  if (!session || !context || data.conversation) return null;
  const pct = context.percent === null ? null : Math.round(context.percent);
  if (session.freshContinue) {
    return (
      <div className="v2-ag-memory" data-state="running" role="status" data-testid="v2-agent-memory">
        <Icon name="refresh" size="s" />
        {freshStepText(session.freshContinue.step)}
      </div>
    );
  }
  const offer =
    settings !== null &&
    settings.enabled &&
    blocked === null &&
    pct !== null &&
    pct >= settings.pct &&
    freshEligible(session) &&
    !freshBusy(session, activity) &&
    (snoozedAt === null || pct >= snoozedAt + 10);
  const clean = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      asked.current = true;
      await api.freshSession(sessionId);
    } catch (caught) {
      asked.current = false;
      setError(refusal(caught));
    } finally {
      setBusy(false);
    }
  };
  if (!offer) {
    // A slim meter only once it is worth a look (from 50 %).
    if (pct === null || pct < 50) return null;
    return (
      <div className="v2-ag-memory" data-band={context.band} data-testid="v2-agent-memory" title={`${AGENT_WORDS.workingMemory} · ${AGENT_WORDS.memoryUsed(pct)}`}>
        <Icon name="cpu" size="s" />
        <span>{AGENT_WORDS.workingMemory}</span>
        <span className="v2-ag-meter" role="meter" aria-label={AGENT_WORDS.workingMemory} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <b style={{ width: `${pct}%` }} />
        </span>
        <span className="v2-muted">{AGENT_WORDS.memoryUsed(pct)}</span>
      </div>
    );
  }
  return (
    <div className="v2-ag-memory" data-state="offer" data-testid="v2-agent-memory" role="region" aria-label={AGENT_WORDS.workingMemory}>
      <Icon name="alert" size="s" />
      <span className="v2-grow">{AGENT_WORDS.memoryFullBanner(pct ?? 0)}</span>
      <Button size="sm" variant="primary" icon="refresh" data-testid="v2-agent-clean-slate" disabled={busy} onClick={() => void clean()}>
        {AGENT_WORDS.cleanSlate}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setSnoozedAt(pct);
          saveSnooze(browserStorage(), sessionId, pct);
        }}
      >
        Not now
      </Button>
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}
