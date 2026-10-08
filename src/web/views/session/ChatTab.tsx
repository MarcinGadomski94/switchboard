import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AnswerBatch, BackgroundTask, SessionActivity, SessionContext, SessionDetail, SessionEvent } from '../../../core/api.ts';
import { displayTitle } from '../../../core/session-title.ts';
import { ChatActivityLine } from '../../activity/ActivityViews.tsx';
import { useLiveActivity } from '../../activity/useActivity.ts';
import { ApiError, api } from '../../api/client.ts';
import { AttachButton, type AttachmentDraft, AttachmentChips, pasteFiles, useAttachmentDraft, useFileDrop } from '../../components/Attachments.tsx';
import { attachmentsBlocker, messageToSend } from '../../components/attachments.ts';
import { refusalText } from '../inbox.ts';
import { type Answering, ChatItemView } from './ChatItems.tsx';
import { useFullText } from './FullText.tsx';
import { COMPOSER_MAX_LINES, QUICK_REPLIES, QUICK_REPLIES_LABEL, chatItems, composerKeyAction, composerPlaceholder, hookedQueuedNote } from './chat.ts';
import { contextBarView } from './context-bar.ts';
import { ChatSkeleton } from './SessionSkeletons.tsx';
import type { LoadState } from './session-loading.ts';
import { SubagentChatView, isEditing } from './SubagentChat.tsx';
import { OVERLAY_SELECTOR, mainChatPlace, rememberMainChat } from './subagent-chat.ts';
import { type SessionMachine, offlineReason } from '../../../core/peers.ts';
import { useLiveMachine } from '../../api/useMachines.ts';
import { MachineStatusNote } from '../../components/MachineStatusNote.tsx';
import { STOP_LABEL, STOP_TIMEOUT_NOTE, STOP_TIMEOUT_PAUSE, STOP_TOOLTIP, STOPPING_LABEL, withdrawnDraft } from '../../../core/stop-turn.ts';
import { canStop, escStops, stoppableBackground } from './stop.ts';
import { StopBackground } from './StopBackground.tsx';
import { TodoStrip, useSessionTodos } from './TodoStrip.tsx';
import { turnRevertFor, useCheckpoints } from './checkpoints.ts';

/** How close to the bottom (px) still counts as "at the bottom", so new items keep it scrolled down. */
const STICK_PX = 32;

function refusal(error: unknown): string {
  return error instanceof ApiError ? refusalText(error.status, error.body) : refusalText(0, null);
}

/** Props of {@link ChatTab}. */
export interface ChatTabProps {
  readonly sessionId: string;
  /** `GET /api/sessions/{id}` (the main agent, the questions, the name); `null` while it loads. */
  readonly session: SessionDetail | null;
  /** D45: the session's events (`GET /api/sessions/{id}/events` + the `/hub` stream; SessionView's `useSessionData`). */
  readonly events: readonly SessionEvent[];
  /** D45: `ready` once the complete event list is there (fetched, or cached from an earlier visit). */
  readonly eventsState: LoadState;
  /** D45: the chat's data is late: bubble placeholders stand in for the conversation. */
  readonly placeholder?: boolean;
  /** Reloads the session detail (after an answer; the view also reloads on its `/hub` events). */
  readonly onChanged: () => void;
  /** D36: a subagent's id (`/sessions/{id}/agents/{agentId}`): its own chat instead of the main conversation. */
  readonly agentId?: string | null;
}

/**
 * Chat tab (SPEC → Session → Chat, M4.2; `docs/chat.md`): the main conversation
 * from `GET /api/sessions/{id}/events` + the `/hub` `event` stream (user bubbles
 * right, agent text left with its mono step lines), the question batches from the
 * session detail (the shared `QuestionCard` inline while a batch waits, answered
 * through `POST /api/questions/batch/{batchId}/answers`; the answers bubble once
 * answered), then the composer: quick-reply pills fill the draft, Enter or Send
 * posts it to `POST /api/sessions/{id}/messages`. It stays scrolled to the newest
 * item unless the developer scrolled up. D19: while a turn runs, the live activity
 * line sits above the composer (`ChatActivityLine`). D36: with `agentId`, the same
 * events show that subagent's own chat (`SubagentChatView`); an Agent / Task step
 * line opens it, and the main chat comes back at the place it was left. D45: the
 * events come from the session view (held per session, cached per tab); while
 * they or the detail are late, bubble placeholders stand in (`ChatSkeleton`).
 */
export function ChatTab({ sessionId, session, events, eventsState, placeholder = false, onChanged, agentId = null }: ChatTabProps) {
  const activity = useLiveActivity(sessionId, session);
  if (agentId !== null) {
    return <SubagentChatView sessionId={sessionId} session={session} events={events} activity={activity} agentId={agentId} placeholder={placeholder} />;
  }
  return (
    <MainChat
      sessionId={sessionId}
      session={session}
      events={events}
      eventsState={eventsState}
      placeholder={placeholder}
      activity={activity}
      onChanged={onChanged}
    />
  );
}

/** `true` while the conversation is at (or within {@link STICK_PX} of) its bottom. */
function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
}

/** Props of {@link MainChat}. */
interface MainChatProps {
  readonly sessionId: string;
  readonly session: SessionDetail | null;
  readonly events: readonly SessionEvent[];
  /** D45: the events arrived (`ready`: the remembered place can be restored), are on their way, or failed. */
  readonly eventsState: LoadState;
  /** D45: the placeholders show instead of the conversation. */
  readonly placeholder: boolean;
  readonly activity: SessionActivity | null;
  readonly onChanged: () => void;
}

/**
 * The main conversation (M4.2), its activity line and the composer. D36: its
 * place (scroll and whether it follows new items) is remembered per session, so
 * coming back from a subagent's chat shows it where it was left; a subagent's
 * question card can ask to bring its batch into view instead.
 */
function MainChat({ sessionId, session, events, eventsState, placeholder, activity, onChanged }: MainChatProps) {
  const [answering, setAnswering] = useState<Answering | null>(null);
  // D57: the composer's attachments upload to this session as soon as they are added (paste, drop, 📎).
  // Fix · peer reconnects: the machine's live state; `reconnecting` blocks nothing (actions are held until it is back).
  const machine = useLiveMachine(session?.machine);
  const blockedEarly = offlineReason(machine);
  const attachments = useAttachmentDraft(blockedEarly === null ? (body) => api.uploadAttachment(sessionId, body) : undefined);
  const drop = useFileDrop(attachments.add, blockedEarly === null);
  const clearAttachments = attachments.clear;
  useEffect(() => {
    // Another session's uploads never go with this one's message.
    clearAttachments();
  }, [sessionId, clearAttachments]);
  // D68: the session's todo list (the strip above the composer; the composer's + Todo while it is empty).
  const todos = useSessionTodos(sessionId);
  const [addingTodo, setAddingTodo] = useState(false);
  useEffect(() => setAddingTodo(false), [sessionId]);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const restored = useRef(false);
  const loaded = eventsState === 'ready';

  const mainAgentId = session?.agents.find((agent) => agent.kind === 'main')?.id ?? null;
  // Fix · long messages: messages stored cut, restored from the transcript ("Show full message").
  const fullText = useFullText(sessionId, events);
  // D45: nothing half-loaded shows while the events are on their way (a failed load shows what there is, as before).
  const items = session && eventsState !== 'loading' ? chatItems(fullText.events, session.questions, mainAgentId, session.agents) : [];
  // D80: the session's checkpoints (the turn actions, Redo), read again when an event arrives or the status changes.
  const checkpoints = useCheckpoints(sessionId, `${events.length}:${events.at(-1)?.id ?? 0}:${session?.status ?? ''}`);

  // Keep the newest item in view while the developer is at the bottom; D36: first, go back to the remembered place.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (!restored.current && loaded && session) {
      restored.current = true;
      const place = mainChatPlace(sessionId);
      const card = place?.reveal ? [...el.querySelectorAll<HTMLElement>('[data-batch-id]')].find((node) => node.dataset['batchId'] === place.reveal) : undefined;
      if (card) {
        card.scrollIntoView({ block: 'nearest' });
        stick.current = atBottom(el);
        rememberMainChat(sessionId, { top: el.scrollTop, stick: stick.current });
        return;
      }
      if (place && !place.stick) {
        stick.current = false;
        el.scrollTop = place.top;
        return;
      }
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = (): void => {
    const el = scroller.current;
    if (!el) return;
    stick.current = atBottom(el);
    rememberMainChat(sessionId, { top: el.scrollTop, stick: stick.current });
  };

  // D48 ruling D48-cache-persist: an unreachable machine's session is readable (its last known state), nothing more.
  const blocked = offlineReason(machine);
  const answer = async (batchId: string, body: AnswerBatch): Promise<void> => {
    setAnswering({ batchId, busy: true, error: null });
    stick.current = true;
    try {
      await api.answerBatch(batchId, body);
      // Stays busy until the reloaded detail shows the batch answered (the card turns into the answers bubble).
    } catch (error) {
      setAnswering({ batchId, busy: false, error: refusal(error) });
    }
    onChanged();
  };

  return (
    <>
      <div
        className="sb-chat"
        data-testid="session-chat"
        data-session-id={sessionId}
        data-dragging={drop.dragging ? 'true' : undefined}
        ref={scroller}
        onScroll={onScroll}
        {...drop.handlers}
      >
        {placeholder ? <ChatSkeleton /> : null}
        {items.map((item) => (
          <ChatItemView
            key={item.key}
            sessionId={sessionId}
            item={item}
            answering={answering}
            onAnswer={answer}
            // D48 ruling D48-cache-persist: an unreachable machine's waiting questions are shown, not answerable.
            {...(blocked ? { readOnlyNote: () => blocked } : {})}
            // D53: a hooked session's queued message says what it waits on.
            queuedNote={blocked ? null : hookedQueuedNote(session)}
            fullText={fullText.control}
            // D80: revert to before a turn (none while the machine is offline); Redo on the newest revert's divider.
            revert={item.kind === 'user' && blocked === null ? turnRevertFor(checkpoints, item.id) : null}
            redo={item.kind === 'divider' && blocked === null && checkpoints?.redo?.eventId === item.id}
          />
        ))}
      </div>
      {/* D53: an offline machine's session has no live line (the offline note says why). */}
      <ChatActivityLine activity={blocked ? null : activity} />
      <TodoStrip sessionId={sessionId} todos={todos} blocked={blocked} adding={addingTodo} onAddingChange={setAddingTodo} working={session?.status === 'run'} />
      <Composer
        sessionId={sessionId}
        blocked={blocked}
        machine={machine ?? null}
        attachments={attachments}
        // D50: while a turn runs, Send becomes ■ Stop (and Esc stops it).
        stoppable={session !== null && blocked === null && canStop({ live: session.live, status: session.status, activity, hooked: session.hooked === true })}
        // D50 ruling: no turn, but background tasks: "Stop background tasks" beside Send (button + confirmation only).
        // D48 ruling D48-cache-persist: none for an offline peer's session (nothing can reach it).
        background={session && blocked === null ? stoppableBackground({ live: session.live, status: session.status, activity, hooked: session.hooked === true }) : []}
        // D49: the context bar above the quick replies (none for a session without meter data: the demo seed).
        context={session?.context ?? null}
        // D22: the session's display title (its title, else its name).
        placeholder={composerPlaceholder(session ? displayTitle(session) : '')}
        // D68: the compact "+ Todo" while the list is empty (the strip takes over once it has items).
        onAddTodo={todos.list && todos.list.todos.length === 0 && !addingTodo && blocked === null ? () => setAddingTodo(true) : null}
        onSent={() => {
          stick.current = true;
        }}
        // D50: the reply's session is newer than the view's (its `/hub` refresh is throttled): reload it now.
        onStopped={onChanged}
      />
    </>
  );
}

/**
 * D49 · the context bar (`docs/chat.md` → *Context bar*): a thin bar with
 * `Context 62% · 124k / 200k`, green / yellow / red at 60 % and 80 %, and
 * `compacted 14:05` after a compaction until the next turn; a tick where the CLI
 * will auto-compact (ruling D49-autocompact-mark); the tooltip names the window,
 * the auto-compact point and the last compaction. `Context —` with an empty bar before a reading.
 */
export function ContextBar({ context }: { readonly context: SessionContext }) {
  const view = contextBarView(context);
  return (
    <div className="sb-chat-context" data-testid="chat-context" data-band={view.band} title={view.tooltip}>
      <div
        className="sb-chat-context-track"
        role="meter"
        aria-label="Context window used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={view.fill}
        aria-valuetext={view.text}
      >
        <div className="sb-chat-context-fill" data-testid="chat-context-fill" style={{ width: `${view.fill}%` }} />
        {view.tick !== null ? <div className="sb-chat-context-tick" data-testid="chat-context-tick" style={{ left: `${view.tick}%` }} /> : null}
      </div>
      <span className="sb-chat-context-text" data-testid="chat-context-text">
        {view.text}
      </span>
      {view.compacted ? (
        <span className="sb-chat-context-compacted" data-testid="chat-context-compacted">
          {view.compacted}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The composer (prototype): D49 the context bar, quick replies, then the message
 * field and Send. D50: while a turn runs (`stoppable`) Send is the ■ Stop button,
 * and Esc stops the turn too when nothing else owns the key (`escStops`); the
 * messages the Stop took back come back into the field, before what is there.
 */
function Composer({
  sessionId,
  blocked,
  machine,
  attachments,
  stoppable: turnRuns,
  background,
  context,
  placeholder,
  onAddTodo,
  onSent,
  onStopped,
}: {
  readonly sessionId: string;
  readonly stoppable: boolean;
  /** D48 ruling D48-cache-persist: why nothing can be sent now (the machine is offline); `null` = send as usual. */
  readonly blocked: string | null;
  /** Fix · peer reconnects: a peer's session's machine (live state): its note (with Reconnect now) under the composer. */
  readonly machine: SessionMachine | null;
  /** D57: the draft's attachments (chips above the field; paste, drop and 📎 add to them). */
  readonly attachments: AttachmentDraft;
  readonly background: readonly BackgroundTask[];
  readonly context: SessionContext | null;
  readonly placeholder: string;
  /** D68: opens the todo strip with its add field (shown as "+ Todo" while the list is empty); `null` = not shown. */
  readonly onAddTodo: (() => void) | null;
  readonly onSent: () => void;
  readonly onStopped: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // D57: files dropped on the composer join the draft too (the chat above has its own drop zone).
  const drop = useFileDrop(attachments.add, blocked === null);
  const attaching = attachmentsBlocker(attachments.items);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  // D50: a Stop waits for the CLI; the note (with Pause) when it did not stop in time.
  const [stopping, setStopping] = useState(false);
  const [stopTimedOut, setStopTimedOut] = useState(false);
  // The turn is stopped, but the view's session may still say `run` for a moment: Send is back at once,
  // until the view catches up (the turn no longer runs) or a new message goes out.
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    if (!turnRuns) setStopped(false);
  }, [turnRuns]);
  const stoppable = turnRuns && !stopped;
  const stoppingRef = useRef(false);
  const stoppableRef = useRef(stoppable);
  stoppableRef.current = stoppable;

  const stop = async (): Promise<void> => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    setStopTimedOut(false);
    setError(null);
    try {
      const result = await api.interruptSession(sessionId);
      if (result.outcome !== 'timeout' && result.session.status !== 'run' && result.session.status !== 'need') setStopped(true);
      onStopped();
      if (result.withdrawn.length > 0) {
        setDraft((current) => withdrawnDraft(result.withdrawn, current));
        input.current?.focus();
      }
      // D57: their attachments come back as chips (still uploaded: the next message carries them again).
      if ((result.withdrawnAttachments ?? []).length > 0) {
        attachments.restore(result.withdrawnAttachments ?? [], sessionId);
        input.current?.focus();
      }
      if (result.outcome === 'timeout') setStopTimedOut(true);
    } catch (caught) {
      setError(refusal(caught));
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  };
  const stopRef = useRef(stop);
  stopRef.current = stop;

  const pause = async (): Promise<void> => {
    setStopTimedOut(false);
    try {
      await api.pauseSession(sessionId);
    } catch (caught) {
      setError(refusal(caught));
    }
  };

  // D50: Esc stops the running turn, read in the window's capture phase (before a popover's own handler closes it).
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      const active = document.activeElement;
      const context = {
        stoppable: stoppableRef.current,
        stopping: stoppingRef.current,
        // D75: Esc in an open menu (a todo card's ⋯) closes the menu, never stops the turn ▶ Start began.
        overlayOpen: document.querySelector(OVERLAY_SELECTOR) !== null || (active instanceof Element && active.closest('[role="menu"]') !== null),
        editingElsewhere: isEditing(active) && active !== input.current,
      };
      if (!escStops(event, context)) return;
      event.preventDefault();
      void stopRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // D26: the one-line height (the prototype's input) and whether the text needs more lines.
  const oneLine = useRef<{ readonly height: number; readonly line: number } | null>(null);
  const [multiline, setMultiline] = useState(false);
  // Web fonts that finished loading change the line height (`line-height: normal`), so the one-line height is measured again.
  const [fontLoads, setFontLoads] = useState(0);
  useEffect(() => {
    const fonts = document.fonts;
    let live = true;
    const loaded = (): void => {
      if (live) setFontLoads((count) => count + 1);
    };
    fonts.addEventListener('loadingdone', loaded);
    // Fonts that finished between the first measure and this subscription.
    void fonts.ready.then(loaded);
    return () => {
      live = false;
      fonts.removeEventListener('loadingdone', loaded);
    };
  }, []);

  // D26: the field grows with its text (up to COMPOSER_MAX_LINES, then scrolls) and shrinks after a send.
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = '';
    const style = getComputedStyle(field);
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const border = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
    // Measured whenever the field is empty (its natural one-row height), so a font that loads after the first render counts.
    if (field.value === '') {
      oneLine.current = { height: field.offsetHeight, line: field.clientHeight - padding };
    }
    const base = oneLine.current;
    if (!base) return;
    const needed = field.scrollHeight + border;
    const max = base.height + (COMPOSER_MAX_LINES - 1) * base.line;
    const height = Math.max(base.height, Math.min(needed, max));
    field.style.height = `${style.boxSizing === 'border-box' ? height : height - padding - border}px`;
    field.style.overflowY = needed > max ? 'auto' : 'hidden';
    setMultiline(height > base.height + 1);
  }, [draft, fontLoads]);

  const send = async (): Promise<void> => {
    // D57: the text and the uploaded attachments; nothing goes while one is still uploading (or failed).
    const message = messageToSend(draft, attachments.items);
    if (message === null || sending || blocked !== null) return;
    const text = message.text;
    const sent = draft;
    const sentKeys = attachments.items.filter((item) => item.id !== null).map((item) => item.key);
    setStopped(false);
    setSending(true);
    setError(null);
    try {
      await api.sendMessage(sessionId, text, message.attachments);
      // The message shows once the service records it (`/hub` event); the draft clears unless it was edited meanwhile.
      setDraft((current) => (current === sent ? '' : current));
      for (const key of sentKeys) attachments.remove(key);
      onSent();
    } catch (caught) {
      setError(refusal(caught));
    } finally {
      setSending(false);
    }
  };

  // D26: Enter sends, Shift+Enter keeps the field's own line break, Enter while composing (IME) confirms the composition.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (composerKeyAction({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing }) !== 'send') return;
    event.preventDefault();
    void send();
  };

  return (
    <div className="sb-chat-composer" data-testid="chat-composer" data-dragging={drop.dragging ? 'true' : undefined} {...drop.handlers}>
      {context ? <ContextBar context={context} /> : null}
      <div className="sb-chat-quick">
        <span className="sb-chat-quick-label">{QUICK_REPLIES_LABEL}</span>
        {QUICK_REPLIES.map((reply) => (
          <button
            key={reply.label}
            type="button"
            className="sb-button sb-chat-quick-reply"
            data-testid="chat-quick-reply"
            disabled={blocked !== null}
            onClick={() => {
              setDraft(reply.text);
              setError(null);
              input.current?.focus();
            }}
          >
            {reply.label}
          </button>
        ))}
        {/* D57: 📎 at the row's right end (the pills, the field and Send keep their places). */}
        <AttachButton className="sb-attach-button--composer" onFiles={attachments.add} disabled={blocked !== null} />
      </div>
      <AttachmentChips items={attachments.items} notice={attachments.notice} onRemove={attachments.remove} />
      <div className="sb-chat-compose" data-multiline={multiline ? 'true' : undefined}>
        <textarea
          ref={input}
          className="sb-chat-input"
          data-testid="chat-input"
          aria-label="Message"
          rows={1}
          value={draft}
          placeholder={blocked ?? placeholder}
          disabled={blocked !== null}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={pasteFiles(attachments.add, blocked === null)}
        />
        {!stoppable && !stopping && background.length > 0 ? <StopBackground sessionId={sessionId} tasks={background} /> : null}
        {stoppable || stopping ? (
          <button
            type="button"
            className="sb-button sb-chat-send sb-chat-stop"
            data-testid="chat-stop"
            disabled={stopping}
            aria-busy={stopping}
            title={STOP_TOOLTIP}
            style={multiline && oneLine.current ? { height: oneLine.current.height, boxSizing: 'border-box' } : undefined}
            onClick={() => void stop()}
          >
            {stopping ? STOPPING_LABEL : `■ ${STOP_LABEL}`}
          </button>
        ) : (
          <button
            type="button"
            className="sb-button sb-chat-send"
            data-testid="chat-send"
            disabled={sending || blocked !== null || attaching !== null}
            title={blocked ?? attaching ?? undefined}
            aria-busy={sending}
            style={multiline && oneLine.current ? { height: oneLine.current.height, boxSizing: 'border-box' } : undefined}
            onClick={() => void send()}
          >
            Send
          </button>
        )}
      </div>
      {/* Fix · peer reconnects: offline → the blocked note with the countdown and Reconnect now; reconnecting → a note only. */}
      {machine && machine.state !== 'online' ? (
        <MachineStatusNote machine={machine} testId={blocked ? 'chat-blocked' : 'chat-reconnecting'} className={blocked ? 'sb-chat-error' : 'sb-chat-reconnecting'} />
      ) : null}
      {stopTimedOut ? (
        <div className="sb-chat-error" data-testid="chat-stop-timeout" role="alert">
          {STOP_TIMEOUT_NOTE}{' '}
          <button type="button" className="sb-button sb-chat-stop-pause" data-testid="chat-stop-pause" onClick={() => void pause()}>
            {STOP_TIMEOUT_PAUSE}
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="sb-chat-error" data-testid="chat-error" role="alert">
          {error}
        </div>
      ) : null}
      {/* D68: + Todo while the session's todo list is empty: a small tab on the composer's top edge, last so no part moves. */}
      {onAddTodo ? (
        <button type="button" className="sb-button sb-chat-todo-add" data-testid="chat-todo-add" title="Add an item to this session's todo list" onClick={onAddTodo}>
          + Todo
        </button>
      ) : null}
    </div>
  );
}
