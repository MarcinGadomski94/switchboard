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
import { AGENT_WORDS, STATUS, TASKS_WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { markRecent } from '../shared/recent.ts';
import { useAgentTaskCards } from '../shared/session-tasks.ts';
import { TodoCard } from '../shared/TodoCard.tsx';
import { readStripOpen, stripOrder, writeStripOpen } from '../shared/todo-card-model.ts';
import { clock } from '../shared/time.ts';
import { type DockMessage, type DockStatus, composerKey, composerMaxHeight, composerPlaceholder, dockStatus, joinWithdrawn, liveLine, resetTimeOf } from './composer-model.ts';
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
  /** `peek` / `phone`: a slimmer dock (no kbd hints; the task strip's cards fill the width on a phone). */
  readonly variant?: 'full' | 'peek' | 'phone';
  /** The short placeholder ("Send a follow-up") whatever the variant (the peek on a phone). */
  readonly short?: boolean;
}

/**
 * D131 · lane S · the composer dock (the prototype's `.dock`): the status row (live
 * line, tasks, working memory, queue), the task strip (fix after 2.0: classic's todo
 * cards, collapsed by default), the queued and paused messages, then the box
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
    markRecent(sessionId);
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

  // Fix after 2.0: the box starts at one line and grows with its text only up to about a fifth of the
  // visible height (never under 4 lines), then scrolls inside: a long message never pushes the chat away.
  // The visible height follows a phone's keyboard (visualViewport).
  const viewHeight = useViewHeight();
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = 'auto';
    const max = composerMaxHeight(viewHeight, parseFloat(getComputedStyle(field).lineHeight || '22'), variant === 'phone' ? 0.17 : 0.22);
    field.style.height = `${Math.min(field.scrollHeight, max)}px`;
    field.style.overflowY = field.scrollHeight > max ? 'auto' : 'hidden';
  }, [draft, viewHeight, variant]);
  const todos = useSessionTodos(sessionId);
  const memory = useMemoryState(data);
  const [queueOpen, setQueueOpen] = useState(false);
  // Fix after 2.0: the task cards above the box, collapsed by default (the chat keeps its room), the choice kept per browser.
  const [stripOpen, setStripOpen] = useState(() => readStripOpen(browserStorage()));
  const toggleStrip = (): void => {
    setStripOpen((open) => {
      writeStripOpen(browserStorage(), !open);
      return !open;
    });
  };

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
      <StatusRow
        status={dockStatus({
          live,
          tasks: !conversation ? todoSummary(todos.list?.todos ?? []) : null,
          memory: variant !== 'peek' && memory.shown ? memory : null,
          queued: queued.length,
          paused: paused.length,
        })}
        live={live}
        stopping={stopping}
        kbd={full}
        onStop={() => void stopToBox()}
        onResume={() => void resume()}
        onStopBackground={() => void stopBackground()}
        stripOpen={stripOpen}
        onTasks={toggleStrip}
        sessionId={sessionId}
        memory={memory}
        draftSaved={draft.trim() !== '' && full}
        queueOpen={queueOpen}
        onQueue={() => setQueueOpen((v) => !v)}
      />
      {stripOpen && !conversation && (todos.list?.todos.length ?? 0) > 0 ? <TaskStrip sessionId={sessionId} todos={todos} blocked={blocked} working={working} /> : null}
      {stopTimedOut ? (
        <div className="v2-ag-dock-note" role="alert" data-testid="v2-agent-stop-timeout">
          {AGENT_WORDS.stopTimeout}{' '}
          <Button size="sm" onClick={() => void pause()}>
            {AGENT_WORDS.pauseInstead}
          </Button>
        </div>
      ) : null}
      {queueOpen && queued.length + paused.length > 0 ? (
        <div className="v2-ag-queue" id={`v2-ag-queue-${sessionId}`} data-testid="v2-agent-queue">
          {queued.map((row) => (
            <div className="v2-ag-queued" key={row.key} data-testid="v2-agent-queued" data-event-id={row.id}>
              <Icon name="clock" size="s" />
              <span className="v2-grow v2-ag-queued-text">
                <b>{AGENT_WORDS.queued}</b> <span className="v2-muted">· {AGENT_WORDS.queuedNote}</span> · {row.text}
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
                <b className="v2-ag-paused-word">{AGENT_WORDS.paused(resetTimeOf(row.heldNote))}</b> · {row.text}
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
        </div>
      ) : null}
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

/** The live line's icon (a pulse while it works). */
function liveIcon(kind: ReturnType<typeof liveLine>['kind']): string | null {
  switch (kind) {
    case 'working':
    case 'background':
      return null;
    case 'offline':
      return 'offline';
    case 'reconnecting':
      return 'refresh';
    case 'needs':
      return 'hand';
    case 'held':
      return 'wallet';
    case 'stopped':
      return 'stop';
    case 'paused':
      return 'pause';
    case 'done':
      return 'check';
    case 'failed':
      return 'octagon';
    default:
      return 'moon';
  }
}

/**
 * Fix after 2.0 · the agent's tasks as classic's cards (`shared/TodoCard.tsx`), side by side
 * above the box and scrolling sideways: in progress first, open by priority, done last. The
 * status row's "Tasks n/m" opens and closes it.
 */
function TaskStrip({ sessionId, todos, blocked, working }: { readonly sessionId: string; readonly todos: ReturnType<typeof useSessionTodos>; readonly blocked: string | null; readonly working: boolean }) {
  const cards = useAgentTaskCards(sessionId, todos, blocked, working);
  return (
    <section className="v2-ag-taskstrip" id={`v2-ag-taskstrip-${sessionId}`} aria-label={TASKS_WORDS.stripLabel} data-testid="v2-agent-taskstrip">
      <div className="v2-ag-taskstrip-cards">
        {stripOrder(cards.visible).map((todo) => (
          <TodoCard key={todo.id} layout="strip" {...cards.cardProps(todo)} />
        ))}
      </div>
      {cards.error ? (
        <div className="v2-ag-taskstrip-error" role="alert" data-testid="v2-agent-tasks-error">
          {cards.error}
        </div>
      ) : null}
    </section>
  );
}

/** The tasks of the status row, as {@link dockStatus} reads them. */
function todoSummary(list: readonly SessionTodo[]): { total: number; done: number; current: string | null } {
  const current = list.find((t) => t.state === 'in_progress') ?? list.find((t) => t.state === 'open') ?? null;
  return { total: list.length, done: list.filter((t) => t.state === 'done').length, current: current?.title ?? null };
}

/** The visible height (a phone's keyboard shrinks it), live. */
function useViewHeight(): number {
  const read = (): number => (typeof window === 'undefined' ? 900 : (window.visualViewport?.height ?? window.innerHeight));
  const [height, setHeight] = useState(read);
  useEffect(() => {
    const update = (): void => setHeight(read());
    const view = window.visualViewport;
    window.addEventListener('resize', update);
    view?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      view?.removeEventListener('resize', update);
    };
  }, []);
  return height;
}

/**
 * Fix after 2.0 · ONE compact status row above the box (the old live line, tasks
 * strip, working-memory strip and queued / paused cards merged): "● Running tests
 * 0:42 · Tasks 1/3 · Memory 64% · 2 queued ▸", Stop / Resume on its right. Tasks
 * open their list in a popover; the queue line unfolds the queued and paused
 * messages; the clean-slate offer shows in the row only past its threshold.
 */
function StatusRow({
  status,
  live,
  stopping,
  kbd,
  onStop,
  onResume,
  onStopBackground,
  stripOpen,
  onTasks,
  sessionId,
  memory,
  draftSaved,
  queueOpen,
  onQueue,
}: {
  readonly status: DockStatus;
  readonly live: ReturnType<typeof liveLine>;
  readonly stopping: boolean;
  readonly kbd: boolean;
  readonly onStop: () => void;
  readonly onResume: () => void;
  readonly onStopBackground: () => void;
  readonly stripOpen: boolean;
  readonly onTasks: () => void;
  readonly sessionId: string;
  readonly memory: MemoryState;
  readonly draftSaved: boolean;
  readonly queueOpen: boolean;
  readonly onQueue: () => void;
}) {
  const icon = liveIcon(live.kind);
  const tasks = status.parts.find((part) => part.id === 'tasks') ?? null;
  const mem = status.parts.find((part) => part.id === 'memory') ?? null;
  const queue = status.parts.find((part) => part.id === 'queue') ?? null;
  return (
    <div className="v2-ag-status" data-testid="v2-agent-status" aria-label={status.text}>
      <span className="v2-ag-live" data-kind={live.kind} data-testid="v2-agent-live" role="status" title={live.text}>
        {icon ? <Icon name={icon} size="s" /> : <span className="v2-pulse" aria-hidden="true" />}
        <span className="v2-ag-live-text">{live.text}</span>
        {live.time ? (
          <span className="v2-ag-live-time" data-testid="v2-agent-live-time">
            {live.kind === 'stopped' ? `at ${live.time}` : live.time}
          </span>
        ) : null}
        <span className="v2-sr">{STATUS.working.label}</span>
      </span>
      {tasks ? (
        <>
          <span className="v2-ag-sep" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            className="v2-ag-spart"
            data-testid="v2-agent-tasks"
            title={`${tasks.title} · ${TASKS_WORDS.stripToggle(stripOpen)}`}
            aria-expanded={stripOpen}
            aria-controls={`v2-ag-taskstrip-${sessionId}`}
            onClick={onTasks}
          >
            <Icon name="task" size="s" />
            {tasks.text}
            <Icon name="chev" size="s" className="v2-ag-chev" />
          </button>
        </>
      ) : null}
      {mem ? (
        <>
          <span className="v2-ag-sep" aria-hidden="true">
            ·
          </span>
          <span className="v2-ag-spart" data-tone={mem.tone} data-testid="v2-agent-memory" title={mem.title} tabIndex={0}>
            <Icon name={memory.running ? 'refresh' : 'cpu'} size="s" />
            {mem.text}
          </span>
        </>
      ) : null}
      {status.offer ? (
        <span className="v2-ag-offer" data-testid="v2-agent-memory-offer">
          <Button size="sm" variant="primary" icon="refresh" data-testid="v2-agent-clean-slate" title={mem?.title} disabled={memory.busy} onClick={() => void memory.clean()}>
            {AGENT_WORDS.cleanSlateShort}
          </Button>
          <Button size="sm" variant="ghost" onClick={memory.snooze}>
            Not now
          </Button>
        </span>
      ) : null}
      {memory.error ? (
        <span className="v2-ag-dock-error" role="alert">
          {memory.error}
        </span>
      ) : null}
      {queue ? (
        <>
          <span className="v2-ag-sep" aria-hidden="true">
            ·
          </span>
          <button type="button" className="v2-ag-spart" data-tone={queue.tone} data-testid="v2-agent-queue-line" aria-expanded={queueOpen} aria-controls={`v2-ag-queue-${sessionId}`} title={queue.title} onClick={onQueue}>
            <Icon name={queue.tone === 'amber' ? 'pause' : 'clock'} size="s" />
            {queue.text}
            <Icon name="chev" size="s" className="v2-ag-chev" />
          </button>
        </>
      ) : null}
      {draftSaved ? (
        <span className="v2-ag-spart v2-ag-draft-note" data-testid="v2-agent-draft-note" title={AGENT_WORDS.draftSaved} tabIndex={0}>
          <Icon name="edit" size="s" />
          <span className="v2-ag-draft-word">{AGENT_WORDS.draftSavedShort}</span>
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

/** Working memory as the status row shows it, and what its offer does. */
export interface MemoryState {
  /** Something to show (from 50 %, the offer, or a continuation running). */
  readonly shown: boolean;
  readonly pct: number | null;
  readonly offer: boolean;
  readonly running: string | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly clean: () => Promise<void>;
  readonly snooze: () => void;
}

/**
 * D49 / D83 · working memory for the status row: its percentage from 50 %; past
 * the offer's threshold (between replies) the clean-slate offer with Not now;
 * while a continuation runs, which step.
 */
export function useMemoryState(data: AgentData): MemoryState {
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
  const pct = context?.percent == null ? null : Math.round(context.percent);
  const running = session?.freshContinue ? freshStepText(session.freshContinue.step) : null;
  const offer =
    session !== null &&
    !running &&
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
  const snooze = (): void => {
    setSnoozedAt(pct);
    saveSnooze(browserStorage(), sessionId, pct ?? 0);
  };
  const shown = session !== null && context !== null && !data.conversation && (running !== null || offer || (pct !== null && pct >= 50));
  return { shown, pct, offer, running, busy, error, clean, snooze };
}
