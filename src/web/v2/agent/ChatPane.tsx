import { type MutableRefObject, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionCheckpoints } from '../../../core/checkpoints.ts';
import { CommandCopy } from '../../components/CommandCopy.tsx';
import type { Question } from '../../../core/api.ts';
import { closedBatchText } from '../../../core/session-close.ts';
import { NOT_SENT_NOTE } from '../../../core/hooked-continue.ts';
import { loopChipText } from '../../../core/owned-loops.ts';
import { ApiError, api } from '../../api/client.ts';
import { ChatMarkdown, copyText } from '../../views/session/ChatMarkdown.tsx';
import { CutNote, type FullTextControl } from '../../views/session/FullText.tsx';
import { useStableCallback } from '../../views/session/keep-identity.ts';
import { revealEvent } from '../../views/session/reveal-event.ts';
import { refreshCheckpoints } from '../../views/session/checkpoints.ts';
import { actionErrorText } from '../../views/session/session-header.ts';
import { captureTodo } from '../../capture/capture.ts';
import { Button, EmptyState, Icon, IconButton, Menu, type MenuItem, Skeleton, useToast } from '../components/index.ts';
import { AGENT_WORDS, WORDS } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { AnswerSlot } from '../shared/AnswerCard.tsx';
import { answeredDetailFromServer, answeredFromServer } from '../shared/answer-model.ts';
import type { NeedsItem } from '../shared/needs-you-model.ts';
import { useNeedsItemsOf, useNeedsYou } from '../shared/needs-you.ts';
import { SentAttachments } from './Attachments.tsx';
import type { ActivityMark, ChatRow, HelperRef, ResultRef } from './chat-model.ts';
import { foldsYou, youWaitNote } from './composer-model.ts';
import { turnBusy } from '../../views/session/needs-you.ts';
import { type ReplyMenuItem, replyMenu } from './reply-menu.ts';
import type { AgentData } from './useAgent.ts';
import { openRevert } from './dialogs.tsx';

/** How close to the bottom (px) still counts as "at the bottom" (new rows keep it there). */
const STICK_PX = 32;
/** Within this many px of the top, the page before loads (D95). */
const OLDER_PX = 600;

function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
}

/**
 * Typing lag fix (2026-10-29): what a chat row reads of the agent, kept as one
 * object while those fields stay the same ({@link useRowData}), so the memoized
 * rows skip the renders that change nothing of theirs (every `/hub` event and the
 * shell's ticks used to render every row of the window again: a new `AgentData`
 * and new callbacks on each render defeated the rows' memo).
 */
export interface RowData {
  readonly sessionId: string;
  /** A turn runs (`turnBusy`): your messages show what they wait for. */
  readonly working: boolean;
  /**
   * The save points (D80), read only where they show: an open reply menu (Undo
   * from here) and a revert divider's Redo. They change every turn; read through
   * this source they render those, not every reply of the window.
   */
  readonly checkpoints: CheckpointsSource;
  readonly blocked: string | null;
  readonly closed: boolean;
  readonly conversation: boolean;
}

/** The agent's newest save points for the chat's rows ({@link RowData}), with change notices. */
export interface CheckpointsSource {
  get(): SessionCheckpoints | null;
  subscribe(listener: () => void): () => void;
}

/** A {@link CheckpointsSource} that holds `value` and tells its listeners when {@link set} changes it. */
function checkpointsSource(): CheckpointsSource & { set(value: SessionCheckpoints | null): void } {
  let value: SessionCheckpoints | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** {@link RowData} of `data`, the same object while its fields are. */
export function useRowData(data: AgentData): RowData {
  const { sessionId, session, checkpoints, blocked, closed, conversation } = data;
  const working = session !== null && turnBusy(session);
  const [source] = useState(checkpointsSource);
  // Set during the render, so the rows rendered with it read the same value; listeners hear of it after the commit.
  const latest = useRef(checkpoints);
  latest.current = checkpoints;
  useLayoutEffect(() => source.set(latest.current), [source, checkpoints]);
  const readable = useMemo<CheckpointsSource>(() => ({ get: () => latest.current, subscribe: source.subscribe }), [source]);
  return useMemo(() => ({ sessionId, working, checkpoints: readable, blocked, closed, conversation }), [sessionId, working, readable, blocked, closed, conversation]);
}

/** The save points as a row reads them: `pick` of the newest ones, rendering again only when `pick`'s answer changes. */
function useCheckpointsPick<T>(source: CheckpointsSource, pick: (checkpoints: SessionCheckpoints | null) => T): T {
  return useSyncExternalStore(source.subscribe, () => pick(source.get()));
}

/** Props of {@link ChatPane}. */
export interface ChatPaneProps {
  readonly data: AgentData;
  readonly rows: readonly ChatRow[];
  readonly fullText: FullTextControl | undefined;
  /** D97: the message the chat opens at (a search hit), scrolled to and highlighted. */
  readonly focusEventId: number | null;
  /** Shared with the dock: a sent message makes the chat follow to its end. */
  readonly stick: MutableRefObject<boolean>;
  readonly variant: 'full' | 'peek' | 'phone';
  /** Save as result (the per-reply menu, a code block's button). */
  readonly onSave: (text: string, kind: 'markdown' | 'code', language: string | null) => void;
  /** Opens a result (the Results tab with it open). */
  readonly onOpenResult: (id: string) => void;
  /** The helper chat's address (`/agents/:id/helpers/:helperId`). */
  readonly helperHref: (agentId: string) => string;
}

/**
 * D131 · lane S · the chat ("E. Chat text space"): document-style replies, the
 * developer's pills, collapsed activity rows and helper threads, in-chat answer
 * cards (`AnswerSlot`, compact once answered and kept in history), results as file
 * attachments and thin dividers. It stays at its end unless scrolled up; scrolled
 * to the top it loads the page before (D95); opened at a search hit it loads the
 * window around it, scrolls there and highlights it (D97), like the classic chat.
 */
export function ChatPane({ data, rows, fullText, focusEventId, stick, variant, onSave: onSaveProp, onOpenResult: onOpenResultProp, helperHref }: ChatPaneProps) {
  const { sessionId, older, newer, eventsState, session } = data;
  const rowData = useRowData(data);
  const onSave = useStableCallback(onSaveProp);
  const onOpenResult = useStableCallback(onOpenResultProp);
  const scroller = useRef<HTMLDivElement | null>(null);
  const loaded = eventsState === 'ready';
  const revealed = useRef<number | null>(null);
  const olderRef = useRef(older);
  olderRef.current = older;
  const newerRef = useRef(newer);
  newerRef.current = newer;
  const anchor = useRef<{ readonly node: Element; readonly top: number } | null>(null);

  // The agent's other waiting items (permissions, asks, stopped…) show as cards at the chat's end; once answered here
  // they turn into the compact line for a few seconds (fix after 2.0: they are not history, the reply is), then leave.
  const needs = useNeedsItemsOf(sessionId);
  const { answered, settled } = useNeedsYou();
  const batchKeys = useMemo(() => new Set(rows.flatMap((row) => (row.kind === 'questions' ? [`inbox:${row.batchId}`] : []))), [rows]);
  const [extraKeys, setExtraKeys] = useState<readonly string[]>([]);
  useEffect(() => {
    const fresh = needs.filter((item) => !batchKeys.has(item.key)).map((item) => item.key);
    setExtraKeys((current) => {
      const next = [...current.filter((key) => fresh.includes(key) || (answered.has(key) && !settled.has(key))), ...fresh.filter((key) => !current.includes(key))];
      return next.length === current.length && next.every((key, i) => key === current[i]) ? current : next;
    });
  }, [needs, batchKeys, answered, settled]);
  useEffect(() => setExtraKeys([]), [sessionId]);
  const needsByKey = useMemo(() => new Map(needs.map((item) => [item.key, item])), [needs]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const kept = anchor.current;
    anchor.current = null;
    if (kept && !stick.current && kept.node.isConnected) {
      const moved = kept.node.getBoundingClientRect().top - el.getBoundingClientRect().top - kept.top;
      if (moved !== 0) el.scrollTop += moved;
    }
    if (!stick.current) anchor.current = anchorRow(el);
    if (rows.length > 0 && older.available && !older.loading && !older.failed && el.scrollHeight <= el.clientHeight) older.load();
    if (rows.length > 0 && newer.available && !newer.loading && !newer.failed && el.scrollHeight <= el.clientHeight) newer.load();
    if (newer.available) stick.current = false;
    if (focusEventId !== null && revealed.current !== focusEventId && loaded && session && revealEvent(el, focusEventId)) {
      revealed.current = focusEventId;
      stick.current = atBottom(el) && !newer.available;
      anchor.current = stick.current ? null : anchorRow(el);
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = (): void => {
    const el = scroller.current;
    if (!el) return;
    stick.current = atBottom(el) && !newerRef.current.available;
    anchor.current = stick.current ? null : anchorRow(el);
    const more = olderRef.current;
    if (el.scrollTop < OLDER_PX && more.available && !more.loading && !more.failed) more.load();
    const later = newerRef.current;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < OLDER_PX && later.available && !later.loading && !later.failed) later.load();
  };

  const placeholder = !loaded || session === null;
  const empty = !placeholder && rows.length === 0 && extraKeys.length === 0;
  return (
    <div className="v2-ag-scroll" ref={scroller} onScroll={onScroll} data-testid="v2-agent-chat" data-session-id={sessionId} aria-busy={placeholder || undefined}>
      <div className="v2-ag-col">
        {placeholder && eventsState !== 'failed' ? <ChatSkeleton /> : null}
        {loaded && older.available ? (
          <div className="v2-ag-paging" data-testid="v2-agent-older">
            {older.loading ? (
              <span role="status">{AGENT_WORDS.earlierLoading}</span>
            ) : (
              <Button size="sm" variant="ghost" onClick={older.load}>
                {older.failed ? AGENT_WORDS.earlierFailed : AGENT_WORDS.earlier}
              </Button>
            )}
          </div>
        ) : null}
        {empty ? <EmptyState icon="chat" tone="grey" title={AGENT_WORDS.emptyChat} text={data.conversation ? AGENT_WORDS.placeholderConversation : AGENT_WORDS.emptyChatText} /> : null}
        {placeholder
          ? null
          : rows.map((row) => <Row key={row.key} row={row} data={rowData} variant={variant} fullText={fullText} focusEventId={focusEventId} need={row.kind === 'questions' ? (needsByKey.get(`inbox:${row.batchId}`) ?? null) : null} onSave={onSave} onOpenResult={onOpenResult} helperHref={helperHref} />)}
        {placeholder
          ? null
          : extraKeys.map((key) => (
              <div className="v2-ag-card" key={key} data-testid="v2-agent-card">
                <AnswerSlot itemKey={key} item={needsByKey.get(key) ?? null} variant={variant === 'phone' ? 'phone' : 'chat'} where="chat" transient />
              </div>
            ))}
        {loaded && newer.available ? (
          <div className="v2-ag-paging" data-testid="v2-agent-newer">
            {newer.loading ? (
              <span role="status">{AGENT_WORDS.laterLoading}</span>
            ) : (
              <Button size="sm" variant="ghost" onClick={newer.load}>
                {newer.failed ? AGENT_WORDS.laterFailed : AGENT_WORDS.later}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                stick.current = true;
                newer.latest();
              }}
            >
              {AGENT_WORDS.jumpLatest}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The row the view stays anchored to while older rows load: the topmost in view (never the first). */
function anchorRow(el: HTMLElement): { readonly node: Element; readonly top: number } | null {
  const col = el.firstElementChild;
  if (!col) return null;
  const edge = el.getBoundingClientRect().top;
  let index = 0;
  for (const child of col.children) {
    if (child.matches('.v2-ag-paging, .v2-ag-skel')) continue;
    index += 1;
    if (index === 1) continue;
    const box = child.getBoundingClientRect();
    if (box.bottom > edge) return { node: child, top: box.top - edge };
  }
  return null;
}

function ChatSkeleton() {
  return (
    <div className="v2-ag-skel" data-testid="v2-agent-chat-skeleton" aria-hidden="true">
      <Skeleton width="40%" height={14} />
      <Skeleton lines={3} height={12} />
      <div style={{ alignSelf: 'flex-end', width: '45%' }}>
        <Skeleton height={28} />
      </div>
      <Skeleton width="30%" height={14} />
      <Skeleton lines={4} height={12} />
    </div>
  );
}

/** Props of a chat row. */
export interface RowProps {
  readonly row: ChatRow;
  readonly data: RowData;
  readonly variant: 'full' | 'peek' | 'phone';
  readonly fullText: FullTextControl | undefined;
  readonly focusEventId: number | null;
  /** A question row's waiting item (its in-chat answer card); `null` for every other row. */
  readonly need: NeedsItem | null;
  readonly onSave: ChatPaneProps['onSave'];
  readonly onOpenResult: (id: string) => void;
  readonly helperHref: (agentId: string) => string;
  /** A helper's chat: no reply menu, question cards shown read-only. */
  readonly readOnly?: boolean;
}

const NO_SAVE = (): void => undefined;
const NO_OPEN = (): void => undefined;

/** D36 · rows of a helper's chat (read-only: helpers take no messages; their questions are answered in the main chat). */
export function ChatRowsView({ rows, data, fullText, focusEventId, variant }: { readonly rows: readonly ChatRow[]; readonly data: AgentData; readonly fullText: FullTextControl | undefined; readonly focusEventId: number | null; readonly variant: 'full' | 'peek' | 'phone'; readonly readOnly: true }) {
  const rowData = useRowData(data);
  const helperHref = useCallback((agentId: string): string => `/agents/${encodeURIComponent(rowData.sessionId)}/helpers/${encodeURIComponent(agentId)}`, [rowData.sessionId]);
  return (
    <>
      {rows.map((row) => (
        <Row key={row.key} row={row} data={rowData} variant={variant} fullText={fullText} focusEventId={focusEventId} need={null} onSave={NO_SAVE} onOpenResult={NO_OPEN} helperHref={helperHref} readOnly />
      ))}
    </>
  );
}

/**
 * Typing lag fix (2026-10-29): a row renders again only when something it shows
 * changed: its row object (kept while equal, `keepIdentity`), a prop, or the
 * fields of {@link RowData} its kind reads (a turn starting renders your messages,
 * not the replies).
 */
export function sameRowProps(prev: RowProps, next: RowProps): boolean {
  if (prev.row !== next.row || prev.variant !== next.variant || prev.fullText !== next.fullText || prev.focusEventId !== next.focusEventId || prev.need !== next.need) return false;
  if (prev.onSave !== next.onSave || prev.onOpenResult !== next.onOpenResult || prev.helperHref !== next.helperHref || prev.readOnly !== next.readOnly) return false;
  const a = prev.data;
  const b = next.data;
  if (a === b) return true;
  switch (next.row.kind) {
    case 'you':
      return a.sessionId === b.sessionId && a.working === b.working;
    case 'reply':
      return a.sessionId === b.sessionId && a.checkpoints === b.checkpoints && a.blocked === b.blocked && a.closed === b.closed && a.conversation === b.conversation;
    case 'divider':
      return a.sessionId === b.sessionId && a.checkpoints === b.checkpoints && a.blocked === b.blocked;
    default:
      return true;
  }
}

/** One chat row. */
const Row = memo(function Row({ row, data, variant, fullText, focusEventId, need, onSave, onOpenResult, helperHref, readOnly = false }: RowProps) {
  switch (row.kind) {
    case 'you':
      return <YouPill row={row} sessionId={data.sessionId} fullText={fullText} working={data.working} />;
    case 'reply':
      return <Reply row={row} data={data} variant={readOnly ? 'phone' : variant} fullText={fullText} onSave={onSave} />;
    case 'activity':
      return <ActivityRow row={row} focusEventId={focusEventId} />;
    case 'helpers':
      return <HelpersThread row={row} helperHref={helperHref} />;
    case 'questions':
      return <QuestionRow batchId={row.batchId} questions={row.questions} waiting={row.waiting} item={readOnly ? null : need} variant={variant} />;
    case 'results':
      return <ResultsRow results={row.results} onOpen={onOpenResult} />;
    case 'gap':
      return (
        <div className="v2-ag-divider" data-kind="gap" data-testid="v2-agent-gap">
          <span>{row.text}</span>
        </div>
      );
    case 'divider':
      return <Divider row={row} data={data} />;
    case 'routine':
      return (
        <div className="v2-ag-rtrow" data-testid="v2-agent-routine-row" data-event-id={row.id} data-mark={row.mark} title={row.text}>
          <Icon name={row.icon} size="s" />
          <span className="v2-ag-rtrow-text">{row.text}</span>
          {row.mark === '✕' ? <span className="v2-ag-rtrow-bad">failed</span> : null}
          {row.time ? <span className="v2-ag-rtrow-time">{row.time}</span> : null}
        </div>
      );
  }
}, sameRowProps);

function YouPill({ row, sessionId, fullText, working }: { readonly row: Extract<ChatRow, { kind: 'you' }>; readonly sessionId: string; readonly fullText: FullTextControl | undefined; readonly working: boolean }) {
  // Fix after 2.0: a message the agent has not taken up shows in the chat at once, with what it waits for.
  const wait = youWaitNote(row, working);
  // Fix after 2.0: a long message of yours folds after about 12 lines (Show more).
  const folds = foldsYou(row.text);
  const [open, setOpen] = useState(false);
  const pillId = `v2-ag-you-${row.key}`;
  return (
    <div className="v2-ag-msg v2-ag-you" data-cont={row.cont ? 'true' : undefined} data-event-id={row.id > 0 ? row.id : undefined} data-testid="v2-agent-you" data-delivered={row.delivered ? 'true' : 'false'}>
      {row.loop ? (
        <div className="v2-ag-loopchip" title="Sent by a routine">
          <Icon name="routine" size="s" />
          {loopChipText(row.loop)}
        </div>
      ) : null}
      {row.cont ? null : (
        <div className="v2-ag-who">
          {AGENT_WORDS.you}
          {row.time ? ` · ${row.time}` : ''}
          {row.origin !== 'user' && row.origin !== 'agent-prompt' && row.origin !== 'task' ? ` · ${originWords(row.origin)}` : ''}
        </div>
      )}
      {row.text !== '' || row.attachments.length === 0 ? (
        <div className="v2-ag-pill" id={pillId} data-folded={folds && !open ? 'true' : undefined}>
          <ChatMarkdown text={row.text} testId="v2-agent-you-text" />
        </div>
      ) : null}
      {folds ? (
        <button type="button" className="v2-ag-you-more" aria-expanded={open} aria-controls={pillId} data-testid="v2-agent-you-more" onClick={() => setOpen((v) => !v)}>
          {open ? AGENT_WORDS.showLess : AGENT_WORDS.showMore}
        </button>
      ) : null}
      {row.cut ? <CutNote cut={row.cut} control={fullText} /> : null}
      <SentAttachments sessionId={sessionId} attachments={row.attachments} />
      {wait ? (
        <div className="v2-ag-you-wait" data-testid="v2-agent-you-queued" data-reason={row.queued ?? 'sending'}>
          <Icon name={row.queued === 'credits' ? 'pause' : 'clock'} size="s" />
          {wait}
        </div>
      ) : null}
      {row.notSent ? <NotSent sessionId={sessionId} eventId={row.id} /> : null}
    </div>
  );
}

/** Where a message came from, in words (`task` → the first task…). */
function originWords(origin: string): string {
  switch (origin) {
    case 'task':
      return 'the task';
    case 'resume':
      return 'resumed';
    case 'service':
      return 'from Switchboard';
    case 'terminal':
      return 'from the terminal';
    default:
      return origin;
  }
}

/** D72 · "Not sent" with Resend. */
function NotSent({ sessionId, eventId }: { readonly sessionId: string; readonly eventId: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resend = (): void => {
    setBusy(true);
    setError(null);
    api.resendMessage(sessionId, eventId).then(
      () => setBusy(false),
      (caught: unknown) => {
        setBusy(false);
        setError(caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null));
      },
    );
  };
  return (
    <div className="v2-ag-notsent" data-testid="v2-agent-not-sent" title={NOT_SENT_NOTE}>
      <Icon name="alert" size="s" />
      {AGENT_WORDS.notSent}
      <Button size="sm" variant="ghost" data-testid="v2-agent-resend" disabled={busy} onClick={resend}>
        {AGENT_WORDS.resend}
      </Button>
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}

/** The text selected inside `node`, `null` when none (or it is elsewhere). */
function selectionIn(node: Element | null): string | null {
  const selection = window.getSelection();
  if (!node || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!node.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString().trim();
  return text === '' ? null : text;
}

function Reply({ row, data, variant, fullText, onSave }: { readonly row: Extract<ChatRow, { kind: 'reply' }>; readonly data: RowData; readonly variant: 'full' | 'peek' | 'phone'; readonly fullText: FullTextControl | undefined; readonly onSave: ChatPaneProps['onSave'] }) {
  const toast = useToast();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  // Only an open menu follows the save points (a closed one renders nothing of them).
  const checkpoints = useCheckpointsPick(data.checkpoints, (value) => (open ? value : null));
  const items = useMemo(
    () => (open ? replyMenu({ text: row.text, selection, turnEventId: row.turnEventId, checkpoints, blocked: data.blocked ?? (data.closed ? 'Archived agents do not change.' : null), conversation: data.conversation }) : []),
    [open, row.text, selection, row.turnEventId, checkpoints, data.blocked, data.closed, data.conversation],
  );
  const run = (item: ReplyMenuItem): void => {
    const action = item.action;
    if (!action) return;
    switch (action.type) {
      case 'copy':
      case 'copy-code':
        void copyText(action.text).then((ok) => toast({ text: ok ? AGENT_WORDS.copied : 'Could not copy.' }));
        return;
      case 'save':
        onSave(action.text, 'markdown', null);
        return;
      case 'task':
        captureTodo(data.sessionId, { title: action.title, note: null, from: 'selection' }).then(
          () => toast({ text: AGENT_WORDS.addedToTasks(action.title) }),
          (caught: unknown) => toast({ text: caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : 'Could not add it.', tone: 'error' }),
        );
        return;
      case 'undo':
        openRevert({ sessionId: data.sessionId, turn: action.turn });
        return;
    }
  };
  const menu: MenuItem[] = items.flatMap((item) => {
    const entry: MenuItem = { id: item.id, label: item.label, icon: item.icon, ...(item.disabledReason ? { disabledReason: item.disabledReason } : {}), onSelect: () => run(item) };
    return item.separated ? [{ separator: true as const, id: `sep-${item.id}` }, entry] : [entry];
  });
  const label = data.conversation ? AGENT_WORDS.conversation : AGENT_WORDS.agent;
  return (
    <div className="v2-ag-msg v2-ag-reply" data-cont={row.cont ? 'true' : undefined} data-event-id={row.id} data-testid="v2-agent-reply" data-n={row.n} data-note={row.note ? 'true' : undefined}>
      {row.cont ? null : (
        <div className="v2-ag-who">
          <Icon name="agents" size="s" />
          {label} · {AGENT_WORDS.reply(row.n)}
          {row.time ? ` · ${row.time}` : ''}
        </div>
      )}
      <div className="v2-ag-step" ref={body}>
        {variant === 'phone' ? null : (
          <IconButton
            ref={setAnchor}
            icon="more"
            label={AGENT_WORDS.replyActions(row.n)}
            className="v2-ag-mmore"
            data-testid="v2-agent-reply-menu"
            aria-haspopup="menu"
            aria-expanded={open}
            onMouseDown={() => setSelection(selectionIn(body.current))}
            onClick={() => setOpen((v) => !v)}
          />
        )}
        <ChatMarkdown text={row.text} testId="v2-agent-reply-text" onSaveCode={data.blocked === null ? (code, language) => onSave(code, 'code', language) : null} />
        {row.cut ? <CutNote cut={row.cut} control={fullText} /> : null}
      </div>
      <Menu items={menu} anchor={anchor} open={open} onClose={() => setOpen(false)} label={AGENT_WORDS.replyActions(row.n)} testId="v2-agent-reply-menu-list" />
    </div>
  );
}

const MARK_ICON: Readonly<Record<ActivityMark, string | null>> = { ok: 'check', bad: 'x', running: null, waiting: 'hand', stopped: 'stop', warn: 'alert' };

function ActivityRow({ row, focusEventId }: { readonly row: Extract<ChatRow, { kind: 'activity' }>; readonly focusEventId: number | null }) {
  const holds = focusEventId !== null && row.lines.some((line) => line.id === focusEventId);
  const [open, setOpen] = useState(holds);
  useEffect(() => {
    if (holds) setOpen(true);
  }, [holds]);
  const icon = MARK_ICON[row.mark];
  return (
    <div className="v2-ag-act" data-mark={row.mark} data-open={open ? 'true' : undefined} data-testid="v2-agent-activity">
      <button type="button" className="v2-ag-actrow" aria-expanded={open} data-testid="v2-agent-activity-toggle" onClick={() => setOpen((v) => !v)}>
        {icon ? <Icon name={icon} size="s" /> : <span className="v2-pulse" aria-hidden="true" />}
        <span className="v2-ag-act-sum">{row.summary}</span>
        {row.duration ? <span className="v2-ag-act-time">· {row.duration}</span> : null}
        {row.mark === 'ok' ? <span className="v2-ag-act-ok" aria-label="finished">✓</span> : null}
        <span className="v2-grow" />
        <Icon name="chev" size="s" className="v2-ag-chev" />
      </button>
      {open ? (
        <div className="v2-ag-actlines" data-testid="v2-agent-activity-lines">
          {row.lines.map((line) => (
            <div key={line.id} data-event-id={line.id} data-mark={line.mark}>
              {line.mark} {line.label}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HelpersThread({ row, helperHref }: { readonly row: Extract<ChatRow, { kind: 'helpers' }>; readonly helperHref: (agentId: string) => string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="v2-ag-thread" data-open={open ? 'true' : undefined} data-testid="v2-agent-helpers" data-event-id={row.id}>
      <button type="button" className="v2-ag-thread-tog" aria-expanded={open} data-testid="v2-agent-helpers-toggle" onClick={() => setOpen((v) => !v)}>
        <Icon name="thread" size="s" />
        {row.summary}
        <Icon name="chev" size="s" className="v2-ag-chev" />
      </button>
      {open ? (
        <div className="v2-ag-thread-list">
          {row.helpers.map((helper) => (
            <HelperReply key={helper.id} helper={helper} href={helper.agentId ? helperHref(helper.agentId) : null} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HelperReply({ helper, href }: { readonly helper: HelperRef; readonly href: string | null }) {
  return (
    <div className="v2-ag-treply" data-testid="v2-agent-helper" data-state={helper.state}>
      <span className="v2-ag-tav" aria-hidden="true">
        {helper.name.charAt(0).toUpperCase()}
      </span>
      <div className="v2-ag-tb">
        <div className="v2-ag-who">
          <b>{helper.name}</b>
          {helper.state === 'working' ? (
            <>
              <span className="v2-pulse" aria-hidden="true" /> working
            </>
          ) : helper.state === 'failed' ? (
            <>
              <Icon name="x" size="s" /> stopped
            </>
          ) : (
            <>
              <Icon name="check-circle" size="s" /> done
            </>
          )}
          <span className="v2-grow" />
          {href ? (
            <V2Link to={href} className="v2-btn" data-variant="ghost" data-size="sm" data-testid="v2-agent-helper-open">
              {AGENT_WORDS.openHelperChat}
              <Icon name="chev" size="s" />
            </V2Link>
          ) : null}
        </div>
        {helper.detail && helper.detail !== helper.name ? <div className="v2-muted">{helper.detail}</div> : null}
      </div>
    </div>
  );
}

function QuestionRow({ batchId, questions, waiting, item, variant }: { readonly batchId: string; readonly questions: readonly Question[]; readonly waiting: boolean; readonly item: NeedsItem | null; readonly variant: 'full' | 'peek' | 'phone' }) {
  const key = `inbox:${batchId}`;
  const { answered } = useNeedsYou();
  if (waiting || answered.has(key)) {
    if (!item && !answered.has(key)) {
      // The store has not read it yet (or it waits elsewhere): a quiet line until it does.
      return (
        <div className="v2-ag-card" data-testid="v2-agent-question-pending" data-batch-id={batchId}>
          <div className="v2-answered">
            <Icon name="question" size="s" />
            <b className="v2-grow">{questions[0]?.text ?? AGENT_WORDS.needsYou}</b>
            <span className="v2-muted">{WORDS.waitingForYou}</span>
          </div>
        </div>
      );
    }
    return (
      <div className="v2-ag-card" data-testid="v2-agent-card" data-batch-id={batchId}>
        <AnswerSlot itemKey={key} item={item} variant={variant === 'phone' ? 'phone' : 'chat'} where="chat" />
      </div>
    );
  }
  const closed = questions.find((q) => q.closedReason)?.closedReason ?? null;
  const summary = closed ? closedBatchText(closed) : (answeredFromServer(questions) ?? AGENT_WORDS.answered);
  const time = questions.find((q) => q.answeredAt)?.answeredAt ?? null;
  return (
    <div className="v2-ag-card" data-testid="v2-agent-answered" data-batch-id={batchId}>
      <div className="v2-answered" role="status">
        <span className="v2-answered-ok">
          <Icon name={closed ? 'x' : 'check'} size="s" />
        </span>
        {/* Fix after 2.4.12: the chosen answers' descriptions stay a tooltip, as on the card's options. */}
        <b className="v2-grow" title={closed ? undefined : answeredDetailFromServer(questions)}>
          {summary}
        </b>
        {time ? <span className="v2-muted">{new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
        <span className="v2-answered-q">{questions.map((q) => q.text).join(' · ')}</span>
      </div>
    </div>
  );
}

function ResultsRow({ results, onOpen }: { readonly results: readonly ResultRef[]; readonly onOpen: (id: string) => void }) {
  return (
    <div className="v2-ag-results" aria-label="Attached results" data-testid="v2-agent-results-row">
      {results.map((result) => (
        <button key={result.id} type="button" className="v2-ag-att" data-testid="v2-agent-result-attachment" onClick={() => onOpen(result.id)}>
          <span className="v2-ag-fi" data-kind={result.kind}>
            {result.kind === 'markdown' ? 'MD' : result.kind.slice(0, 3).toUpperCase()}
          </span>
          <span className="v2-ag-att-t">
            <b>{result.title}</b>
            <small>{result.meta}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

function Divider({ row, data }: { readonly row: Extract<ChatRow, { kind: 'divider' }>; readonly data: RowData }) {
  const redoHere = useCheckpointsPick(data.checkpoints, (value) => value?.redo?.eventId === row.id);
  const redo = row.revert === 'reverted' && data.blocked === null && redoHere;
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const doRedo = (): void => {
    setBusy(true);
    api.redoRevert(data.sessionId).then(
      () => {
        setBusy(false);
        refreshCheckpoints(data.sessionId);
      },
      (caught: unknown) => {
        setBusy(false);
        refreshCheckpoints(data.sessionId);
        toast({ text: caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : 'Could not redo it.', tone: 'error' });
      },
    );
  };
  return (
    <div className="v2-ag-divider" data-testid="v2-agent-divider" data-event-id={row.id} role="separator">
      {row.linkedSessionId ? (
        <V2Link to={`/agents/${encodeURIComponent(row.linkedSessionId)}`}>{row.text}</V2Link>
      ) : (
        <span>
          {row.text}
          {redo ? (
            <Button size="sm" variant="ghost" icon="refresh" data-testid="v2-agent-redo" disabled={busy} onClick={doRedo}>
              {AGENT_WORDS.redo}
            </Button>
          ) : null}
          {/* D139: the account needs the developer: the CLI's words and the command that fixes it. */}
          {row.needsYou ? (
            <span data-testid="v2-agent-divider-needs-you" style={{ display: 'block' }}>
              {row.needsYou.text ? <span style={{ display: 'block', marginTop: 4 }}>{row.needsYou.text}</span> : null}
              {row.needsYou.command ? <CommandCopy command={row.needsYou.command} testId="v2-agent-divider-command" /> : null}
            </span>
          ) : null}
        </span>
      )}
    </div>
  );
}
